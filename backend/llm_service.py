"""Stage 2 of the grounding pipeline: LLM picks *which lines* and *what quote*;
the backend turns those into coordinates. The LLM never sees or emits geometry.

Configuration (environment variables):
  OPENAI_API_KEY   API key (any non-empty string for Ollama / vLLM)
  OPENAI_BASE_URL  e.g. http://localhost:11434/v1 (Ollama) or http://localhost:8000/v1 (vLLM)
  LLM_MODEL        model name, default "gpt-4o-mini"
  LLM_MAX_CONTEXT_CHARS  prompt budget for document text, default 400000
"""

from __future__ import annotations

import os
import re

from openai import OpenAI

from extractor import locate_quote
from models import Citation, DocLayout, LLMAnswer, Line, QueryResponse

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

    return resolve_citations(layout, parsed)


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
