# AI PDF Citation & Coordinate Highlighting Dashboard

Upload a PDF, ask a question, get an answer with clickable citations. Clicking a citation scrolls the
viewer to the page and highlights the exact quoted words.

## How grounding works (the LLM never sees or emits coordinates)

1. **Deterministic extraction** (`backend/extractor.py`, PyMuPDF): every page is split into lines
   with ids `p{page}_l{line}`. Each line and word keeps its bbox `[x0, y0, x1, y1]` in 72-DPI PDF
   points, top-left origin, with page rotation applied (so it matches what pdf.js renders).
2. **LLM grounding** (`backend/llm_service.py`): the indexed lines are sent to the model with a
   JSON-Schema structured output (`answer` + `citations[{id, line_ids, exact_quote}]`).
3. **Resolution** (`extractor.locate_quote`): `line_ids` are looked up in the stored layout and
   `exact_quote` is matched against the *words* of those lines (ignoring case, punctuation,
   hyphenation, ligatures) to get tight per-line rectangles. If the quote isn't found, it falls
   back to: neighbouring lines → the cited pages → whole-line boxes (flagged `precise: false`,
   shown as a "line-level" badge). Unknown line ids are dropped and their `[n]` markers removed.
4. **Rendering** (`frontend/src/components/PdfViewer.tsx`): boxes are positioned in percent of the
   page's point size, so they stay aligned at any zoom/window size.

## Run it

Backend (Python 3.11+):

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=sk-...        # see .env.example for Ollama / vLLM
uvicorn main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Set `VITE_API_URL` if the API isn't on `http://localhost:8000`. For another frontend origin, add it
to `allow_origins` in `backend/main.py`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/upload` | multipart `file` → `{doc_id, filename, num_pages, num_lines, pages[]}` |
| POST | `/query` | `{doc_id, query}` → `{answer, citations[{id, page, boxes[], quote, matched_text, precise, …}]}` |
| GET | `/pdf/{doc_id}` | the original PDF |
| GET | `/layout/{doc_id}` | indexed lines + boxes (debugging) |

## Limitations

- Scanned/image-only PDFs have no text layer and are rejected; run OCR (e.g. `ocrmypdf`) first.
- The whole document is sent to the model. Above `LLM_MAX_CONTEXT_CHARS` (default 400k) only the
  pages that best overlap the query lexically are sent; swap in embeddings for better retrieval.
- Uploads and layouts are stored in `backend/uploads/` (JSON files + in-memory cache); no auth.
- The model must support JSON-schema structured outputs (`response_format`). Small local models may
  produce looser quotes, which then show up as line-level highlights.
