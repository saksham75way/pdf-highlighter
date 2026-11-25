import type { HighlightBox, QueryResponse, UploadMode, UploadResponse } from './types'

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

export async function uploadPdf(file: File, mode: UploadMode = 'extract'): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  form.append('mode', mode)
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

/** URL of the PDF with a citation's highlights baked in; opens at the first highlighted page.
 *  Readable form: ?page=6&x0=77.72&y0=81.58&x1=182.99&y1=94.25 (repeat the five names per extra box). */
export function highlightedPdfUrl(docId: string, boxes: HighlightBox[]): string {
  const q = new URLSearchParams()
  for (const { page, bbox } of boxes) {
    q.append('page', String(page))
    q.append('x0', String(bbox[0]))
    q.append('y0', String(bbox[1]))
    q.append('x1', String(bbox[2]))
    q.append('y1', String(bbox[3]))
  }
  return `${API_URL}/pdf/${docId}/highlighted?${q}#page=${boxes[0]?.page ?? 1}`
}
