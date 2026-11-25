// Mirrors backend/models.py. All bboxes are [x0, y0, x1, y1] in 72-DPI PDF points,
// origin top-left of the displayed page.

export type BBox = [number, number, number, number]

/** 'extract': text + word boxes extracted (precise). 'direct': PDF sent to Gemini, boxes are AI guesses. */
export type UploadMode = 'extract' | 'direct'

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
  mode: UploadMode
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
  grounding: 'extracted' | 'model_estimate'
  boxes: HighlightBox[]
}

export interface TokenUsage {
  model: string
  mode: UploadMode
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number | null
  total_tokens: number
  /** Extract mode only: pages whose text was sent to the model. */
  pages_sent: number | null
}

export interface QueryResponse {
  answer: string
  citations: Citation[]
  usage: TokenUsage | null
}
