import { FileSearch } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { askQuestion, pdfUrl, uploadPdf } from './api'
import PdfViewer from './components/PdfViewer'
import QueryPanel from './components/QueryPanel'
import type { Citation, QueryResponse, UploadResponse } from './types'

export default function App() {
  const [doc, setDoc] = useState<UploadResponse | null>(null)
  const [result, setResult] = useState<QueryResponse | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onUpload = useCallback(async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const d = await uploadPdf(file)
      setDoc(d)
      setResult(null)
      setActiveId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [])

  const onAsk = useCallback(
    async (query: string) => {
      if (!doc) return
      setAsking(true)
      setError(null)
      setActiveId(null)
      try {
        setResult(await askQuestion(doc.doc_id, query))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Query failed')
      } finally {
        setAsking(false)
      }
    },
    [doc],
  )

  const onSelect = useCallback((c: Citation) => {
    setActiveId(c.id)
    setFocusToken((t) => t + 1) // re-scroll even when re-clicking the same citation
  }, [])

  const highlights = useMemo(
    () => result?.citations.find((c) => c.id === activeId)?.boxes ?? [],
    [result, activeId],
  )

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="h-1/2 w-full shrink-0 border-b border-slate-200 md:h-full md:w-[420px] md:border-r md:border-b-0">
        <QueryPanel
          doc={doc}
          uploading={uploading}
          asking={asking}
          error={error}
          result={result}
          activeId={activeId}
          onUpload={onUpload}
          onAsk={onAsk}
          onSelect={onSelect}
        />
      </aside>
      <main className="min-h-0 min-w-0 flex-1">
        {doc ? (
          <PdfViewer
            key={doc.doc_id}
            fileUrl={pdfUrl(doc.doc_id)}
            pages={doc.pages}
            highlights={highlights}
            focusToken={focusToken}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
            <FileSearch size={48} strokeWidth={1.25} />
            <p className="text-sm">Your PDF will appear here</p>
          </div>
        )}
      </main>
    </div>
  )
}
