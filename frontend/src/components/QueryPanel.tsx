import {
  AlertCircle,
  ArrowUp,
  Coins,
  ExternalLink,
  FileText,
  Loader2,
  Quote,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { highlightedPdfUrl } from '../api'
import type { Citation, QueryResponse, TokenUsage, UploadMode, UploadResponse } from '../types'

interface Props {
  doc: UploadResponse | null
  uploading: boolean
  asking: boolean
  error: string | null
  result: QueryResponse | null
  lastQuery: string | null
  activeId: number | null
  mode: UploadMode
  onModeChange: (m: UploadMode) => void
  onUpload: (file: File) => void
  onAsk: (query: string) => void
  onSelect: (c: Citation) => void
  onDismissError: () => void
}

const MODES: { value: UploadMode; label: string; hint: string }[] = [
  { value: 'extract', label: 'Extract text', hint: 'Exact highlights on the quoted words.' },
  {
    value: 'direct',
    label: 'Send PDF to Gemini',
    hint: 'No extraction. Works on scans; highlight positions are AI-guessed.',
  },
]

const SUGGESTIONS = ['Summarize this document', 'What are the key points?', 'What is this document about?']

export default function QueryPanel(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const canAsk = !!p.doc && !p.asking && !p.uploading

  // Grow the question box with its content (max ~5 lines).
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [query])

  // Bring the question + answer into view when a request starts and when it finishes.
  useEffect(() => {
    if (p.asking || p.result) bubble.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [p.asking, p.result])

  const ask = (q: string) => {
    const text = q.trim()
    if (!text || !canAsk) return
    p.onAsk(text)
    setQuery('')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    ask(query)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line. Ignore Enter while an IME is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      ask(query)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) p.onUpload(f)
  }

  const modeHint = MODES.find((m) => m.value === p.mode)?.hint

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="border-b border-slate-200 px-5 py-2.5 md:py-4">
        <h1 className="text-base font-semibold text-slate-900 md:text-lg">PDF Citation Highlighter</h1>
        <p className="hidden text-sm text-slate-500 md:block">Ask a question, then see exactly where the answer is.</p>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* Upload: mode first (it applies to the next upload), then the drop zone */}
        <section className="space-y-2">
          <div
            role="radiogroup"
            aria-label="Upload mode"
            className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm"
          >
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={p.mode === m.value}
                onClick={() => p.onModeChange(m.value)}
                className={`rounded-md px-2 py-1.5 font-medium transition ${
                  p.mode === m.value
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="px-1 text-xs text-slate-500">
            {modeHint}
            {p.doc && p.doc.mode !== p.mode && (
              <span className="text-amber-700"> Applies to the next PDF you upload.</span>
            )}
          </p>

          <div
            role="button"
            tabIndex={0}
            aria-label={p.doc ? 'Replace the PDF' : 'Upload a PDF'}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInput.current?.click()
              }
            }}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 outline-none transition focus-visible:ring-2 focus-visible:ring-indigo-300 ${
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
                    {p.doc.mode === 'direct' ? 'sent as a file' : `${p.doc.num_lines} lines`} · click to
                    replace
                  </div>
                </>
              ) : (
                <>
                  <div className="font-medium text-slate-900">
                    {p.uploading ? 'Reading your PDF…' : 'Upload a PDF'}
                  </div>
                  <div className="text-slate-500">Drop a file here or click to browse</div>
                </>
              )}
            </div>
          </div>
        </section>

        {p.error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 shrink-0" size={16} />
            <span className="min-w-0 flex-1 break-words">{p.error}</span>
            <button
              onClick={p.onDismissError}
              aria-label="Dismiss error"
              className="shrink-0 rounded p-0.5 hover:bg-red-100"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Empty state: nudge towards a first question */}
        {p.doc && !p.result && !p.asking && (
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Sparkles size={13} /> Try asking
            </h2>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  disabled={!canAsk}
                  className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:border-indigo-400 hover:bg-indigo-50 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Conversation */}
        {(p.asking || p.result) && p.lastQuery && (
          <div ref={bubble} className="ml-auto w-fit max-w-[90%] scroll-mt-2 rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm text-white">
            {p.lastQuery}
          </div>
        )}

        {p.asking && <Thinking />}

        {!p.asking && p.result && (
          <section className="space-y-4">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">
              <AnswerText
                text={p.result.answer}
                citations={p.result.citations}
                activeId={p.activeId}
                onSelect={p.onSelect}
              />
            </p>

            {p.result.citations.length > 0 ? (
              <div>
                <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Sources · click to jump
                </h2>
                <ul className="space-y-2">
                  {p.result.citations.map((c) => (
                    <li
                      key={c.id}
                      className={`overflow-hidden rounded-lg border transition ${
                        p.activeId === c.id
                          ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-300'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <button
                        onClick={() => p.onSelect(c)}
                        aria-pressed={p.activeId === c.id}
                        className="w-full px-3 py-2.5 text-left hover:bg-slate-50/60"
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
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
                          className="flex items-center gap-1.5 border-t border-slate-200/70 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 hover:text-indigo-800"
                        >
                          <ExternalLink size={12} />
                          Open highlighted PDF in new tab
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-slate-400">No sources: the model found nothing to cite for this.</p>
            )}

            {p.result.usage && <UsageDetails usage={p.result.usage} />}
          </section>
        )}
      </div>

      {/* Composer: always visible at the bottom */}
      <form onSubmit={submit} className="border-t border-slate-200 bg-white px-5 py-3">
        <div
          className={`flex items-end gap-2 rounded-xl border px-3 py-2 transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-200 ${
            p.doc ? 'border-slate-300' : 'border-slate-200 bg-slate-50'
          }`}
        >
          <textarea
            ref={box}
            rows={1}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!p.doc}
            aria-label="Your question"
            placeholder={p.doc ? 'Ask something about this document…' : 'Upload a PDF to start'}
            className="max-h-32 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={!canAsk || !query.trim()}
            aria-label="Send question"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {p.asking ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={16} />}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-xs text-slate-400">Enter to send · Shift+Enter for a new line</p>
      </form>
    </div>
  )
}

/** Shown while waiting for the model (it can take 10+ seconds): says what is happening and for how long. */
function Thinking() {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div role="status" aria-live="polite" className="space-y-2.5 rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between text-sm text-slate-600">
        <span className="flex items-center gap-2">
          <Loader2 className="animate-spin text-indigo-600" size={14} />
          Reading the document and finding sources…
        </span>
        <span className="tabular-nums text-xs text-slate-400">{secs}s</span>
      </div>
      <div className="space-y-2" aria-hidden>
        <div className="h-3 w-11/12 animate-pulse rounded bg-slate-100" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
      </div>
      {secs >= 20 && (
        <p className="text-xs text-slate-400">Taking longer than usual; the model may be busy or rate-limited.</p>
      )}
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

/** Collapsible token usage for the last request (what the model reported). */
function UsageDetails({ usage }: { usage: TokenUsage }) {
  const fmt = (n: number) => n.toLocaleString()
  const rows: [string, string, string?][] = [
    ['Input (prompt)', fmt(usage.prompt_tokens), 'Instructions + document + your question'],
    ['Output (answer)', fmt(usage.completion_tokens), 'The answer and citations the model wrote'],
  ]
  if (usage.reasoning_tokens)
    rows.push(['Thinking', fmt(usage.reasoning_tokens), 'Hidden reasoning tokens, billed as output'])
  return (
    <details className="group rounded-lg border border-slate-200 text-sm">
      <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-slate-600 hover:bg-slate-50">
        <span className="flex items-center gap-1.5">
          <Coins size={14} className="text-slate-400" />
          Token usage
        </span>
        <span className="tabular-nums text-slate-500">{fmt(usage.total_tokens)} total</span>
      </summary>
      <dl className="space-y-1.5 border-t border-slate-200 px-3 py-2.5">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="flex items-baseline justify-between gap-3" title={hint}>
            <dt className="text-slate-500">{label}</dt>
            <dd className="tabular-nums font-medium text-slate-800">{value}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-slate-100 pt-1.5">
          <dt className="font-medium text-slate-600">Total</dt>
          <dd className="tabular-nums font-semibold text-slate-900">{fmt(usage.total_tokens)}</dd>
        </div>
        <p className="pt-1 text-xs text-slate-400">
          {usage.model} · {usage.mode === 'direct' ? 'PDF sent as a file' : 'text lines sent'}
          {usage.pages_sent != null && ` · ${usage.pages_sent} pages`}
        </p>
      </dl>
    </details>
  )
}
