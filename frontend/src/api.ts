import type { HighlightBox, QueryResponse, UploadResponse } from './types'

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export async function uploadPdf(file: File): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  return parse(await fetch(`${API_URL}/upload`, { method: 'POST', body: form }))
}

export async function askQuestion(docId: string, query: string): Promise<QueryResponse> {
  return parse(
    await fetch(`${API_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId, query }),
    }),
  )
}

export const pdfUrl = (docId: string) => `${API_URL}/pdf/${docId}`

/** URL of the PDF with a citation's highlights baked in; opens at the first highlighted page. */
export function highlightedPdfUrl(docId: string, boxes: HighlightBox[]): string {
  const raw = boxes.map((b) => `${b.page}:${b.bbox.join(',')}`).join(';')
  const page = boxes[0]?.page ?? 1
  return `${API_URL}/pdf/${docId}/highlighted?boxes=${encodeURIComponent(raw)}#page=${page}`
}
