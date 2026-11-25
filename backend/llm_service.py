"""Stage 2 of the grounding pipeline: LLM picks *which lines* and *what quote*;
the backend turns those into coordinates. The LLM never sees or emits geometry.

Configuration (environment variables):
  OPENAI_API_KEY   API key (any non-empty string for Ollama / vLLM)
  OPENAI_BASE_URL  e.g. http://localhost:11434/v1 (Ollama) or http://localhost:8000/v1 (vLLM)
  LLM_MODEL        model name, default "gpt-4o-mini"
  LLM_MAX_CONTEXT_CHARS  prompt budget for document text, default 400000
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

from openai import OpenAI

from extractor import locate_quote
from models import (
    Citation,
    DirectAnswer,
    DocLayout,
    HighlightBox,
    LLMAnswer,
    Line,
    QueryResponse,
    TokenUsage,
)

SYSTEM_PROMPT = """You answer questions about a PDF using ONLY the text provided.

The document is given as lines, each prefixed with its id in square brackets, e.g.
[p2_l14] The quick brown fox...

Rules:
- Ground every claim in the document. If the document does not contain the answer,
  say so plainly and return an empty citations list.
- Cite with inline markers [1], [2], ... in the answer. Each marker must have exactly
  one entry in `citations` with the same `id`.
- For each citation return `line_ids` (ids copied verbatim from the document, only the
  lines that contain the quote) and `exact_quote`: a verbatim, contiguous span copied
  from those lines. Keep quotes short (one sentence or less). Never paraphrase inside
  `exact_quote`, never use ellipses, never include the [pX_lY] prefixes.
- Never output coordinates or page geometry."""

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(
            api_key=os.getenv("OPENAI_API_KEY") or "not-needed",
            base_url=os.getenv("OPENAI_BASE_URL") or None,
        )
    return _client


def _model() -> str:
    return os.getenv("LLM_MODEL", "gpt-4o-mini")


# --------------------------------------------------------------------------- #
# Prompt building
# --------------------------------------------------------------------------- #
def _render_page(lines: list[Line]) -> str:
    return "\n".join(f"[{ln.id}] {ln.text}" for ln in lines)


def build_document_context(layout: DocLayout, query: str) -> str:
    """Render the whole document as indexed lines. If it exceeds the budget, keep the
    pages that lexically overlap the query most (cheap retrieval; swap for embeddings
    if you need better recall)."""
    budget = int(os.getenv("LLM_MAX_CONTEXT_CHARS", "400000"))
    rendered = {p.page: _render_page(p.lines) for p in layout.pages if p.lines}
    if sum(len(t) for t in rendered.values()) <= budget:
        return "\n\n".join(f"--- Page {n} ---\n{t}" for n, t in rendered.items())

    terms = {t for t in re.findall(r"\w{3,}", query.lower())}

    def score(text: str) -> int:
        low = text.lower()
        return sum(low.count(t) for t in terms)

    chosen: list[int] = []
    used = 0
    for n in sorted(rendered, key=lambda n: score(rendered[n]), reverse=True):
        if used + len(rendered[n]) > budget:
            continue
        chosen.append(n)
        used += len(rendered[n])
    return "\n\n".join(f"--- Page {n} ---\n{rendered[n]}" for n in sorted(chosen))


# --------------------------------------------------------------------------- #
# Query
# --------------------------------------------------------------------------- #
def answer_query(layout: DocLayout, query: str) -> QueryResponse:
    context = build_document_context(layout, query)
    if not context.strip():
        return QueryResponse(answer="This PDF contains no extractable text.", citations=[])

    completion = _get_client().chat.completions.parse(
        model=_model(),
        temperature=0,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"DOCUMENT:\n{context}\n\nQUESTION: {query}"},
        ],
        response_format=LLMAnswer,  # -> JSON Schema structured output
    )
    msg = completion.choices[0].message
    parsed: LLMAnswer | None = msg.parsed
    if parsed is None:
        raise RuntimeError(f"Model returned no structured output (refusal: {msg.refusal!r})")

    result = resolve_citations(layout, parsed)
    u = completion.usage
    if u is not None:
        details = getattr(u, "completion_tokens_details", None)
        result.usage = TokenUsage(
            model=_model(),
            mode="extract",
            prompt_tokens=u.prompt_tokens,
            completion_tokens=u.completion_tokens,
            # Gemini's OpenAI-compatible API folds hidden thinking into total_tokens without
            # listing it; derive it so the breakdown adds up.
            reasoning_tokens=(getattr(details, "reasoning_tokens", None) if details else None)
            or (u.total_tokens - u.prompt_tokens - u.completion_tokens or None),
            total_tokens=u.total_tokens,
            pages_sent=len(re.findall(r"^--- Page \d+ ---$", context, flags=re.M)),
        )
    return result


def resolve_citations(layout: DocLayout, parsed: LLMAnswer) -> QueryResponse:
    """line_ids + exact_quote -> deterministic bounding boxes. Citations that cannot
    be grounded are dropped and their [n] markers are stripped from the answer so the
    UI never shows a citation that points nowhere."""
    citations: list[Citation] = []
    dropped: set[int] = set()
    seen_ids: set[int] = set()

    for c in parsed.citations:
        if c.id in seen_ids:
            continue
        seen_ids.add(c.id)
        match = locate_quote(layout, c.line_ids, c.exact_quote)
        if match is None or not match.boxes:
            dropped.add(c.id)
            continue
        pages = sorted({b.page for b in match.boxes})
        citations.append(
            Citation(
                id=c.id,
                page=match.boxes[0].page,
                pages=pages,
                line_ids=[lid for lid in dict.fromkeys(c.line_ids)],
                quote=c.exact_quote,
                matched_text=match.matched_text,
                match_quality=match.quality,
                precise=match.precise,
                boxes=match.boxes,
            )
        )

    answer = parsed.answer
    valid = {c.id for c in citations}
    # Strip markers whose citation was dropped or never defined.
    answer = re.sub(r"\s?\[(\d+)\]", lambda m: m.group(0) if int(m.group(1)) in valid else "", answer)
    return QueryResponse(answer=answer.strip(), citations=sorted(citations, key=lambda c: c.id))


# --------------------------------------------------------------------------- #
# Direct mode: send the PDF itself to Gemini and let it guess the boxes (no extraction)
# --------------------------------------------------------------------------- #
GEMINI_API = "https://generativelanguage.googleapis.com/v1beta"
MAX_DIRECT_PDF_BYTES = 15 * 1024 * 1024  # inline upload limit is ~20 MB per request incl. base64

DIRECT_SYSTEM_PROMPT = """You answer questions about the attached PDF using ONLY its content.

Rules:
- If the PDF does not contain the answer, say so plainly and return an empty citations list.
- Cite with inline markers [1], [2], ... in the answer. Each marker has exactly one entry in
  `citations` with the same `id`.
- For each citation give `page` (1-based page number in the PDF), `quote` (a short, verbatim,
  contiguous span copied from that page; never paraphrase, never use ellipses) and `boxes`.
- `boxes` locates the quote on the page: one box per line of text the quote covers, each as
  [ymin, xmin, ymax, xmax] with integers from 0 to 1000, relative to the full page image
  (0,0 is the top-left corner, 1000,1000 the bottom-right). Make each box as tight as possible
  around the quoted words only, not the whole line unless the quote is the whole line."""

_DIRECT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "answer": {"type": "STRING"},
        "citations": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "INTEGER"},
                    "page": {"type": "INTEGER"},
                    "quote": {"type": "STRING"},
                    "boxes": {
                        "type": "ARRAY",
                        "items": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    },
                },
                "required": ["id", "page", "quote", "boxes"],
            },
        },
    },
    "required": ["answer", "citations"],
}


def _strip_dead_markers(answer: str, valid: set[int]) -> str:
    return re.sub(
        r"\s?\[(\d+)\]", lambda m: m.group(0) if int(m.group(1)) in valid else "", answer
    ).strip()


def _gemini_native_model() -> str:
    return _model().removeprefix("models/")


def answer_query_direct(layout: DocLayout, pdf_path: Path, query: str) -> QueryResponse:
    """Send the whole PDF to Gemini (native API: it accepts PDFs) and ask for the answer plus
    estimated boxes. Nothing is extracted locally, so the boxes are the model's best guess."""
    key = os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("Direct mode needs a Gemini API key (GEMINI_API_KEY or OPENAI_API_KEY)")
    model = _gemini_native_model()
    if not model.startswith("gemini"):
        raise RuntimeError(f"Direct mode needs a Gemini model, but LLM_MODEL is '{model}'")

    pdf_b64 = base64.b64encode(pdf_path.read_bytes()).decode()
    body = {
        "systemInstruction": {"parts": [{"text": DIRECT_SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": "application/pdf", "data": pdf_b64}},
                    {"text": f"QUESTION: {query}"},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": _DIRECT_SCHEMA,
        },
    }
    req = urllib.request.Request(
        f"{GEMINI_API}/models/{model}:generateContent",
        data=json.dumps(body).encode(),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc)["error"]["message"]
        except Exception:
            detail = exc.reason
        raise RuntimeError(f"Gemini {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Gemini: {exc.reason}") from None

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        reason = (data.get("promptFeedback") or {}).get("blockReason") or "no candidates"
        raise RuntimeError(f"Gemini returned no answer ({reason})") from None
    parsed = DirectAnswer.model_validate_json(text)
    result = resolve_direct_citations(layout, parsed)
    um = data.get("usageMetadata")
    if um:
        result.usage = TokenUsage(
            model=model,
            mode="direct",
            prompt_tokens=um.get("promptTokenCount", 0),
            completion_tokens=um.get("candidatesTokenCount", 0),
            reasoning_tokens=um.get("thoughtsTokenCount"),
            total_tokens=um.get("totalTokenCount", 0),
        )
    return result


def resolve_direct_citations(layout: DocLayout, parsed: DirectAnswer) -> QueryResponse:
    """Model-estimated 0-1000 boxes (ymin, xmin, ymax, xmax) -> PDF points, top-left origin.
    Invalid pages/boxes are dropped, and their [n] markers are removed from the answer."""
    sizes = {p.page: (p.width, p.height) for p in layout.pages}
    citations: list[Citation] = []
    seen: set[int] = set()
    for c in parsed.citations:
        if c.id in seen or c.page not in sizes:
            continue
        seen.add(c.id)
        w, h = sizes[c.page]
        boxes: list[HighlightBox] = []
        for b in c.boxes:
            if len(b) != 4:
                continue
            ymin, xmin, ymax, xmax = (min(1000, max(0, v)) for v in b)
            if ymax <= ymin or xmax <= xmin:
                continue
            boxes.append(
                HighlightBox(
                    page=c.page,
                    bbox=[
                        round(xmin / 1000 * w, 2),
                        round(ymin / 1000 * h, 2),
                        round(xmax / 1000 * w, 2),
                        round(ymax / 1000 * h, 2),
                    ],
                )
            )
        if not boxes:
            seen.discard(c.id)
            continue
        citations.append(
            Citation(
                id=c.id,
                page=c.page,
                pages=[c.page],
                line_ids=[],
                quote=c.quote,
                matched_text=c.quote,
                match_quality=0.0,
                precise=False,
                grounding="model_estimate",
                boxes=boxes,
            )
        )
    answer = _strip_dead_markers(parsed.answer, {c.id for c in citations})
    return QueryResponse(answer=answer, citations=sorted(citations, key=lambda c: c.id))
