"""Pydantic schemas shared by the extractor, LLM service and HTTP API.

Coordinate convention everywhere: ``[x0, y0, x1, y1]`` in PDF points (72 DPI),
origin at the TOP-LEFT of the (rotation-applied) page, y growing downwards.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

BBox = list[float]  # [x0, y0, x1, y1]


# --------------------------------------------------------------------------- #
# Deterministic layout (produced by extractor.py, never by the LLM)
# --------------------------------------------------------------------------- #
class Word(BaseModel):
    text: str
    bbox: BBox


class Line(BaseModel):
    id: str = Field(description="Stable id of the form p{page}_l{line}, 1-based")
    page: int
    text: str
    bbox: BBox
    words: list[Word]


class PageLayout(BaseModel):
    page: int
    width: float
    height: float
    lines: list[Line]


class DocLayout(BaseModel):
    doc_id: str
    filename: str
    pages: list[PageLayout]


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #
class PageSize(BaseModel):
    page: int
    width: float
    height: float


class UploadResponse(BaseModel):
    doc_id: str
    filename: str
    num_pages: int
    num_lines: int
    pages: list[PageSize]


class QueryRequest(BaseModel):
    doc_id: str
    query: str = Field(min_length=1, max_length=2000)


class HighlightBox(BaseModel):
    page: int
    bbox: BBox


class Citation(BaseModel):
    id: int = Field(description="Matches the [n] marker used in the answer text")
    page: int = Field(description="Page of the first highlight (1-based)")
    pages: list[int]
    line_ids: list[str]
    quote: str = Field(description="The LLM's exact_quote (what it claims the source says)")
    matched_text: str = Field(description="Text actually found in the PDF under the boxes")
    match_quality: float = Field(ge=0, le=1, description="1.0 = verbatim word-level match")
    precise: bool = Field(description="True if boxes were refined to the quoted words, "
                                      "False if they fall back to whole lines")
    boxes: list[HighlightBox]


class QueryResponse(BaseModel):
    answer: str
    citations: list[Citation]


# --------------------------------------------------------------------------- #
# LLM structured output (JSON Schema is generated from these)
# --------------------------------------------------------------------------- #
class LLMCitation(BaseModel):
    id: int = Field(description="Citation number, used as [id] in the answer. Start at 1.")
    line_ids: list[str] = Field(
        description="Ids of the source lines (e.g. 'p3_l12') that contain the quote, "
                    "copied verbatim from the provided document. Never invent ids."
    )
    exact_quote: str = Field(
        description="Verbatim span copied from those lines that supports the claim. "
                    "Do not paraphrase, add ellipses, or fix typos."
    )


class LLMAnswer(BaseModel):
    answer: str = Field(
        description="Answer to the question, grounded only in the document. "
                    "Reference sources inline as [1], [2], ... matching citation ids."
    )
    citations: list[LLMCitation]
