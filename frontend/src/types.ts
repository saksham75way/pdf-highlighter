// Mirrors backend/models.py. All bboxes are [x0, y0, x1, y1] in 72-DPI PDF points,
// origin top-left of the displayed page.

export type BBox = [number, number, number, number]

export interface PageSize {
  page: number
  width: number
  height: number
}

export interface UploadResponse {
  doc_id: string
  filename: string
  num_pages: number
  num_lines: number
  pages: PageSize[]
}

export interface HighlightBox {
  page: number
  bbox: BBox
}

export interface Citation {
  id: number
  page: number
  pages: number[]
  line_ids: string[]
  quote: string
  matched_text: string
  match_quality: number
  precise: boolean
  boxes: HighlightBox[]
}

export interface QueryResponse {
  answer: string
  citations: Citation[]
}
