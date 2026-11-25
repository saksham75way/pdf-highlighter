import { AlertCircle, ExternalLink, FileText, Loader2, Quote, Search, Upload } from 'lucide-react'
import { Fragment, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { highlightedPdfUrl } from '../api'
import type { Citation, QueryResponse, UploadMode, UploadResponse } from '../types'

interface Props {
  doc: UploadResponse | null
  uploading: boolean
  asking: boolean
  error: string | null
  result: QueryResponse | null
  activeId: number | null
  mode: UploadMode
  onModeChange: (m: UploadMode) => void
  onUpload: (file: File) => void
  onAsk: (query: string) => void
  onSelect: (c: Citation) => void
}

export default function QueryPanel(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (query.trim() && p.doc && !p.asking) p.onAsk(query.trim())
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) p.onUpload(f)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="border-b border-slate-200 px-5 py-4">
        <h1 className="text-lg font-semibold text-slate-900">PDF Citation Highlighter</h1>
        <p className="text-sm text-slate-500">Ask a question, click a citation, see the source.</p>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* Mode: applies to the next upload */}
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Upload mode
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['extract', 'Extract text', 'Precise highlights'],
                ['direct', 'Send PDF to Gemini', 'No extraction, AI-guessed boxes'],
              ] as const
            ).map(([value, title, hint]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-lg border px-3 py-2 text-sm transition ${
                  p.mode === value
                    ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200'
                    : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                <input
                  type="radio"
                  name="upload-mode"
                  value={value}
                  checked={p.mode === value}
                  onChange={() => p.onModeChange(value)}
                  className="sr-only"
                />
                <div className="font-medium text-slate-900">{title}</div>
                <div className="text-xs text-slate-500">{hint}</div>
              </label>
            ))}
          </div>
          {p.doc && p.doc.mode !== p.mode && (
            <p className="text-xs text-slate-500">Applies to the next PDF you upload.</p>
          )}
        </fieldset>

        {/* Upload */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 transition ${
            dragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-slate-400'
          }`}
        >
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) p.onUpload(f)
              e.target.value = ''
            }}
          />
          {p.uploading ? (
            <Loader2 className="shrink-0 animate-spin text-indigo-600" size={22} />
          ) : p.doc ? (
            <FileText className="shrink-0 text-indigo-600" size={22} />
          ) : (
            <Upload className="shrink-0 text-slate-500" size={22} />
          )}
          <div className="min-w-0 text-sm">
            {p.doc ? (
              <>
                <div className="truncate font-medium text-slate-900">{p.doc.filename}</div>
                <div className="text-slate-500">
                  {p.doc.num_pages} pages ·{' '}
                  {p.doc.mode === 'direct' ? 'sent to Gemini as-is' : `${p.doc.num_lines} lines`} · click
                  to replace
                </div>
              </>
            ) : (
              <>
                <div className="font-medium text-slate-900">
                  {p.uploading ? 'Extracting text…' : 'Upload a PDF'}
                </div>
                <div className="text-slate-500">Drop a file here or click to browse</div>
              </>
            )}
          </div>
        </div>

        {/* Query */}
        <form onSubmit={submit} className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!p.doc}
            placeholder={p.doc ? 'Ask something about this document…' : 'Upload a PDF first'}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-50"
          />
          <button
            type="submit"
            disabled={!p.doc || !query.trim() || p.asking}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {p.asking ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
            Ask
          </button>
        </form>

        {p.error && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 shrink-0" size={16} />
            <span>{p.error}</span>
          </div>
        )}

        {/* Answer */}
        {p.result && (
          <section className="space-y-4">
            <div>
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Answer
              </h2>
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">
                <AnswerText
                  text={p.result.answer}
                  citations={p.result.citations}
                  activeId={p.activeId}
                  onSelect={p.onSelect}
                />
              </p>
            </div>

            {p.result.citations.length > 0 && (
              <div>
                <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Sources
                </h2>
                <ul className="space-y-2">
                  {p.result.citations.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => p.onSelect(c)}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                          p.activeId === c.id
                            ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-300'
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 font-semibold text-white">
                            {c.id}
                          </span>
                          <span>
                            Page {c.pages.length > 1 ? `${c.pages[0]}–${c.pages[c.pages.length - 1]}` : c.page}
                          </span>
                          {c.grounding === 'model_estimate' && (
                            <span
                              className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800"
                              title="The AI guessed where this text is on the page, so the highlight may be slightly off."
                            >
                              AI-estimated
                            </span>
                          )}
                          {c.grounding !== 'model_estimate' && !c.precise && (
                            <span
                              className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600"
                              title="The quote could not be located word-for-word, so whole lines are highlighted."
                            >
                              line-level
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1.5 text-sm text-slate-700">
                          <Quote className="mt-0.5 shrink-0 text-slate-400" size={14} />
                          <span className="italic">{c.matched_text || c.quote}</span>
                        </div>
                      </button>
                      {p.doc && (
                        <a
                          href={highlightedPdfUrl(p.doc.doc_id, c.boxes)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 px-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                        >
                          <ExternalLink size={12} />
                          Open highlighted PDF in new tab
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

/** Renders the answer, turning "[n]" markers into clickable chips. */
function AnswerText({
  text,
  citations,
  activeId,
  onSelect,
}: {
  text: string
  citations: Citation[]
  activeId: number | null
  onSelect: (c: Citation) => void
}) {
  const byId = new Map(citations.map((c) => [c.id, c]))
  return (
    <>
      {text.split(/(\[\d+\])/g).map((part, i) => {
        const m = /^\[(\d+)\]$/.exec(part)
        const c = m ? byId.get(Number(m[1])) : undefined
        if (!c) return <Fragment key={i}>{part}</Fragment>
        return (
          <button
            key={i}
            onClick={() => onSelect(c)}
            title={`Go to page ${c.page}`}
            className={`mx-0.5 inline-flex h-5 min-w-5 -translate-y-px items-center justify-center rounded-full px-1 align-baseline text-xs font-semibold transition ${
              activeId === c.id
                ? 'bg-amber-500 text-white'
                : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-600 hover:text-white'
            }`}
          >
            {c.id}
          </button>
        )
      })}
    </>
  )
}
