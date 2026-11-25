"""FastAPI app: /upload, /query, /pdf/{doc_id}, /layout/{doc_id}."""

from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path

from dotenv import load_dotenv
import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

# Read backend/.env (OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL) before llm_service is used.
load_dotenv(Path(__file__).resolve().parent / ".env")

import llm_service
from extractor import extract_layout, page_sizes_only
from models import DocLayout, PageSize, QueryRequest, QueryResponse, UploadResponse

log = logging.getLogger("uvicorn.error")  # shows up in the uvicorn console

UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
DOC_ID_RE = re.compile(r"^[0-9a-f]{32}$")

app = FastAPI(title="PDF Citation Highlighter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_layouts: dict[str, DocLayout] = {}  # in-memory cache; JSON files are the source of truth


def _pdf_path(doc_id: str) -> Path:
    return UPLOAD_DIR / f"{doc_id}.pdf"


def _layout_path(doc_id: str) -> Path:
    return UPLOAD_DIR / f"{doc_id}.layout.json"


def _load_layout(doc_id: str) -> DocLayout:
    if not DOC_ID_RE.match(doc_id):  # also blocks path traversal
        raise HTTPException(404, "Unknown document")
    if doc_id in _layouts:
        return _layouts[doc_id]
    p = _layout_path(doc_id)
    if not p.exists():
        raise HTTPException(404, "Unknown document")
    layout = DocLayout.model_validate_json(p.read_text())
    _layouts[doc_id] = layout
    return layout


@app.post("/upload", response_model=UploadResponse)
async def upload(
    file: UploadFile = File(...),
    mode: str = Form("extract"),
) -> UploadResponse:
    """mode='extract' (default): extract text + word boxes, precise highlights.
    mode='direct': skip extraction, the PDF goes to Gemini as-is and the AI guesses the boxes."""
    if mode not in ("extract", "direct"):
        raise HTTPException(400, "mode must be 'extract' or 'direct'")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "PDF too large (50 MB max)")
    if mode == "direct" and len(data) > llm_service.MAX_DIRECT_PDF_BYTES:
        raise HTTPException(413, "Direct mode supports PDFs up to 15 MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "File is not a PDF")

    doc_id = uuid.uuid4().hex
    pdf = _pdf_path(doc_id)
    pdf.write_bytes(data)
    try:
        if mode == "direct":
            layout = page_sizes_only(str(pdf), doc_id, file.filename or "document.pdf")
        else:
            layout = extract_layout(str(pdf), doc_id, file.filename or "document.pdf")
    except Exception as exc:  # corrupt / encrypted PDFs
        pdf.unlink(missing_ok=True)
        raise HTTPException(422, f"Could not read PDF: {exc}") from exc

    n_lines = sum(len(p.lines) for p in layout.pages)
    if mode == "extract" and n_lines == 0:
        pdf.unlink(missing_ok=True)
        raise HTTPException(
            422, "No selectable text found. Scanned PDFs need OCR first (e.g. ocrmypdf)."
        )

    _layout_path(doc_id).write_text(layout.model_dump_json())
    _layouts[doc_id] = layout
    return UploadResponse(
        doc_id=doc_id,
        filename=layout.filename,
        num_pages=len(layout.pages),
        num_lines=n_lines,
        pages=[PageSize(page=p.page, width=p.width, height=p.height) for p in layout.pages],
        mode=layout.mode,
    )


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    # Sync endpoint on purpose: the OpenAI client call blocks, FastAPI runs it in a threadpool.
    layout = _load_layout(req.doc_id)
    try:
        if layout.mode == "direct":
            return llm_service.answer_query_direct(layout, _pdf_path(req.doc_id), req.query)
        return llm_service.answer_query(layout, req.query)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("LLM request failed (%s, mode=%s): %s", type(exc).__name__, layout.mode, exc)
        raise HTTPException(502, f"LLM request failed: {exc}") from exc


@app.get("/pdf/{doc_id}")
def get_pdf(doc_id: str) -> FileResponse:
    _load_layout(doc_id)
    return FileResponse(_pdf_path(doc_id), media_type="application/pdf")


MAX_HIGHLIGHT_BOXES = 200


@app.get("/pdf/{doc_id}/highlighted")
def get_highlighted_pdf(
    doc_id: str,
    page: list[int] = Query(..., description="1-based page of each box"),
    x0: list[float] = Query(..., description="left edge, PDF points"),
    y0: list[float] = Query(..., description="top edge, PDF points"),
    x1: list[float] = Query(..., description="right edge, PDF points"),
    y1: list[float] = Query(..., description="bottom edge, PDF points"),
) -> Response:
    """The original PDF with highlight annotations burned in, so it can be opened in a
    plain browser tab (add '#page=N' to the URL to jump to the page).

    One box = one page/x0/y0/x1/y1 set, e.g. ``?page=6&x0=77.7&y0=81.6&x1=183&y1=94.3``.
    For several boxes (a quote spanning lines) repeat all five names, in the same order.
    Coordinates are the citation boxes': points, top-left origin, rotation applied; they
    are mapped back to the page's unrotated space for the PDF."""
    _load_layout(doc_id)
    n = len(page)
    if not (len(x0) == len(y0) == len(x1) == len(y1) == n):
        raise HTTPException(400, "page, x0, y0, x1 and y1 must each be given once per box")
    if not 1 <= n <= MAX_HIGHLIGHT_BOXES:
        raise HTTPException(400, f"Provide 1-{MAX_HIGHLIGHT_BOXES} boxes")

    with pymupdf.open(_pdf_path(doc_id)) as doc:
        for pno, bx0, by0, bx1, by1 in zip(page, x0, y0, x1, y1):
            if not 1 <= pno <= doc.page_count:
                raise HTTPException(400, f"Page {pno} out of range")
            if not all(v == v and abs(v) < 1e6 for v in (bx0, by0, bx1, by1)):  # rejects nan/inf
                raise HTTPException(400, "Coordinates must be finite numbers")
            pdf_page = doc[pno - 1]
            rect = pymupdf.Rect(bx0, by0, bx1, by1) * pdf_page.derotation_matrix
            rect.normalize()
            annot = pdf_page.add_highlight_annot(rect)
            annot.set_colors(stroke=(1, 0.8, 0))
            annot.update()
        data = doc.tobytes(garbage=3, deflate=True)
    return Response(
        data,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="highlighted.pdf"'},
    )


@app.get("/layout/{doc_id}", response_model=DocLayout)
def get_layout(doc_id: str) -> DocLayout:
    """Debug/inspection: the indexed lines + boxes the LLM is grounded on."""
    return _load_layout(doc_id)
