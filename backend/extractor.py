"""Deterministic PDF text + geometry extraction (PyMuPDF) and quote grounding.

Two responsibilities:
1. ``extract_layout``: PDF -> indexed lines (``p{page}_l{line}``) with word and
   line bounding boxes in 72-DPI PDF points, top-left origin.
2. ``locate_quote``: map an LLM-provided ``exact_quote`` + ``line_ids`` back to
   tight, word-level rectangles using pure string matching - no LLM maths.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

import pymupdf

from models import DocLayout, HighlightBox, Line, PageLayout, Word


# --------------------------------------------------------------------------- #
# 1. Extraction
# --------------------------------------------------------------------------- #
def _union(boxes: list[list[float]]) -> list[float]:
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def _r(v: float) -> float:
    return round(float(v), 2)


def extract_layout(pdf_path: str, doc_id: str, filename: str) -> DocLayout:
    pages: list[PageLayout] = []
    with pymupdf.open(pdf_path) as doc:
        if doc.needs_pass:
            raise ValueError("PDF is password protected")
        for pno, page in enumerate(doc, start=1):
            # page.rect is the page as displayed (rotation applied) - this is
            # exactly the size pdf.js renders at scale 1.
            rect = page.rect
            # get_text("words") returns coordinates in the *unrotated* page space.
            # rotation_matrix maps them into the displayed (top-left origin) space.
            rot = page.rotation_matrix
            words = page.get_text("words")
            # (x0, y0, x1, y1, word, block_no, line_no, word_no)

            grouped: dict[tuple[int, int], list[Word]] = {}
            for x0, y0, x1, y1, text, block_no, line_no, _w in words:
                if not text.strip():
                    continue
                r = pymupdf.Rect(x0, y0, x1, y1) * rot
                r.normalize()
                grouped.setdefault((block_no, line_no), []).append(
                    Word(text=text, bbox=[_r(r.x0), _r(r.y0), _r(r.x1), _r(r.y1)])
                )

            # Keep PyMuPDF's reading order (block, then line within block).
            lines: list[Line] = []
            for n, key in enumerate(sorted(grouped), start=1):
                ws = sorted(grouped[key], key=lambda w: (w.bbox[0], w.bbox[1]))
                lines.append(
                    Line(
                        id=f"p{pno}_l{n}",
                        page=pno,
                        text=" ".join(w.text for w in ws),
                        bbox=[_r(v) for v in _union([w.bbox for w in ws])],
                        words=ws,
                    )
                )
            pages.append(
                PageLayout(page=pno, width=_r(rect.width), height=_r(rect.height), lines=lines)
            )
    return DocLayout(doc_id=doc_id, filename=filename, pages=pages)


def page_sizes_only(pdf_path: str, doc_id: str, filename: str) -> DocLayout:
    """Direct mode: no text/word extraction, just each page's displayed size (points) so the
    viewer can place overlay boxes. ``lines`` stay empty."""
    pages: list[PageLayout] = []
    with pymupdf.open(pdf_path) as doc:
        if doc.needs_pass:
            raise ValueError("PDF is password protected")
        for pno, page in enumerate(doc, start=1):
            pages.append(
                PageLayout(page=pno, width=_r(page.rect.width), height=_r(page.rect.height), lines=[])
            )
    if not pages:
        raise ValueError("PDF has no pages")
    return DocLayout(doc_id=doc_id, filename=filename, pages=pages, mode="direct")


# --------------------------------------------------------------------------- #
# 2. Quote -> word-level boxes
# --------------------------------------------------------------------------- #
_LIGATURES = str.maketrans({"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl"})


def _norm(s: str) -> str:
    """Lowercase, fold unicode, keep only letters/digits (drops spaces, punctuation,
    hyphens, quotes) so '“self-attention”' == 'self attention' == 'selfattention'."""
    s = unicodedata.normalize("NFKC", s).translate(_LIGATURES).lower()
    return re.sub(r"[\W_]+", "", s)


@dataclass
class Match:
    boxes: list[HighlightBox]
    matched_text: str
    quality: float  # 0..1
    precise: bool


def _match_in_words(words: list[tuple[Line, Word]], quote: str) -> tuple[int, int, float] | None:
    """Find the span [first_word, last_word] (inclusive indices into ``words``) best
    matching ``quote``. Returns (start, end, quality) or None."""
    needle = _norm(quote)
    if not needle:
        return None

    # Concatenate normalised words, remembering which word owns each character.
    hay_parts: list[str] = []
    owner: list[int] = []
    for i, (_line, w) in enumerate(words):
        t = _norm(w.text)
        hay_parts.append(t)
        owner.extend([i] * len(t))
    hay = "".join(hay_parts)
    if not hay:
        return None

    pos = hay.find(needle)
    if pos != -1:
        return owner[pos], owner[pos + len(needle) - 1], 1.0

    # Fuzzy: stitch together the long common blocks (tolerates OCR noise, dropped
    # words, ellipses in the quote). Ignore tiny blocks, which are just chance hits.
    sm = SequenceMatcher(None, hay, needle, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size >= max(4, min(12, len(needle) // 6))]
    if not blocks:
        return None
    covered = sum(b.size for b in blocks) / len(needle)
    if covered < 0.55:
        return None
    start = blocks[0].a
    end = blocks[-1].a + blocks[-1].size - 1
    # Reject if matched blocks are scattered far wider than the quote itself.
    if (end - start + 1) > len(needle) * 1.8 + 20:
        return None
    return owner[start], owner[end], round(min(covered, 0.99), 3)


def _boxes_from_words(words: list[tuple[Line, Word]], start: int, end: int) -> list[HighlightBox]:
    """One merged rectangle per source line for words[start..end]."""
    boxes: list[HighlightBox] = []
    cur_line: str | None = None
    cur: list[list[float]] = []
    cur_page = 0
    for line, w in words[start : end + 1]:
        if line.id != cur_line and cur:
            boxes.append(HighlightBox(page=cur_page, bbox=[_r(v) for v in _union(cur)]))
            cur = []
        cur_line, cur_page = line.id, line.page
        cur.append(w.bbox)
    if cur:
        boxes.append(HighlightBox(page=cur_page, bbox=[_r(v) for v in _union(cur)]))
    return boxes


def _flatten(lines: list[Line]) -> list[tuple[Line, Word]]:
    return [(ln, w) for ln in lines for w in ln.words]


def locate_quote(layout: DocLayout, line_ids: list[str], quote: str) -> Match | None:
    """Resolve LLM output to boxes.

    Order of attempts:
      1. word-level match inside the cited lines (+/- one neighbouring line, since
         LLMs often cite a line too early/late),
      2. word-level match anywhere on the cited pages (the ids were slightly off),
      3. whole-line boxes for the cited lines (still deterministic, less tight).
    Returns None if the ids don't exist at all.
    """
    index: dict[str, tuple[int, int]] = {}  # line id -> (page_idx, line_idx)
    for pi, p in enumerate(layout.pages):
        for li, ln in enumerate(p.lines):
            index[ln.id] = (pi, li)

    cited = [lid for lid in dict.fromkeys(line_ids) if lid in index]
    if not cited:
        return None

    def lines_around(ids: list[str], pad: int) -> list[Line]:
        picked: dict[str, Line] = {}
        for lid in ids:
            pi, li = index[lid]
            page_lines = layout.pages[pi].lines
            for j in range(max(0, li - pad), min(len(page_lines), li + pad + 1)):
                picked[page_lines[j].id] = page_lines[j]
        # preserve document order
        return sorted(picked.values(), key=lambda l: index[l.id])

    def attempt(lines: list[Line], precise_label: bool = True) -> Match | None:
        words = _flatten(lines)
        res = _match_in_words(words, quote)
        if not res:
            return None
        s, e, q = res
        return Match(
            boxes=_boxes_from_words(words, s, e),
            matched_text=" ".join(w.text for _l, w in words[s : e + 1]),
            quality=q,
            precise=precise_label,
        )

    # Cited lines exactly, then with a one-line margin.
    for pad in (0, 1):
        m = attempt(lines_around(cited, pad))
        if m and m.quality >= 0.55:
            return m

    # Cited pages entirely.
    page_idxs = sorted({index[l][0] for l in cited})
    page_lines = [ln for pi in page_idxs for ln in layout.pages[pi].lines]
    m = attempt(page_lines)
    if m and m.quality >= 0.8:
        return m

    # Fallback: whole cited lines.
    fb = lines_around(cited, 0)
    return Match(
        boxes=[HighlightBox(page=ln.page, bbox=ln.bbox) for ln in fb],
        matched_text=" ".join(ln.text for ln in fb),
        quality=0.0,
        precise=False,
    )
