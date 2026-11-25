"""FastAPI app: /upload, /query, /pdf/{doc_id}, /layout/{doc_id}."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import llm_service
from extractor import extract_layout
from models import DocLayout, PageSize, QueryRequest, QueryResponse, UploadResponse

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
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "PDF too large (50 MB max)")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "File is not a PDF")

    doc_id = uuid.uuid4().hex
    pdf = _pdf_path(doc_id)
    pdf.write_bytes(data)
    try:
        layout = extract_layout(str(pdf), doc_id, file.filename or "document.pdf")
    except Exception as exc:  # corrupt / encrypted PDFs
        pdf.unlink(missing_ok=True)
        raise HTTPException(422, f"Could not read PDF: {exc}") from exc

    n_lines = sum(len(p.lines) for p in layout.pages)
    if n_lines == 0:
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
    )


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    # Sync endpoint on purpose: the OpenAI client call blocks, FastAPI runs it in a threadpool.
    layout = _load_layout(req.doc_id)
    try:
        return llm_service.answer_query(layout, req.query)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"LLM request failed: {exc}") from exc


@app.get("/pdf/{doc_id}")
def get_pdf(doc_id: str) -> FileResponse:
    _load_layout(doc_id)
    return FileResponse(_pdf_path(doc_id), media_type="application/pdf")


@app.get("/layout/{doc_id}", response_model=DocLayout)
def get_layout(doc_id: str) -> DocLayout:
    """Debug/inspection: the indexed lines + boxes the LLM is grounded on."""
    return _load_layout(doc_id)
