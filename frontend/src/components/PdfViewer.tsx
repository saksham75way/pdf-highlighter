import { Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import type { HighlightBox, PageSize } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const PAGE_GAP = 16
const GUTTER = 32
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3

interface Props {
  fileUrl: string
  /** Page sizes in PDF points, from the backend (same space as the bboxes). */
  pages: PageSize[]
  highlights: HighlightBox[]
  /** Bump to (re)scroll to the first highlight, even if the highlight didn't change. */
  focusToken: number
}

export default function PdfViewer({ fileUrl, pages, highlights, focusToken }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const slotRefs = useRef(new Map<number, HTMLDivElement>())
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [loadError, setLoadError] = useState<string | null>(null)

  const setScrollerEl = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el
    setScroller(el)
  }, [])

  // Track available width so "100%" always means fit-to-width.
  useEffect(() => {
    if (!scroller) return
    const ro = new ResizeObserver(([e]) => setContainerWidth(e.contentRect.width))
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [scroller])

  const pageWidthPx = Math.max(200, (containerWidth - GUTTER * 2) * zoom)

  // Current-page indicator.
  const onScroll = useCallback(() => {
    const sc = scrollerRef.current
    if (!sc) return
    const probe = sc.getBoundingClientRect().top + sc.clientHeight / 2
    let best = 1
    for (const [n, el] of slotRefs.current) {
      if (el.getBoundingClientRect().top <= probe && n >= best) best = n
    }
    setCurrentPage(best)
  }, [])

  // Scroll to the first highlight whenever a citation is (re)selected.
  useEffect(() => {
    if (!focusToken || highlights.length === 0) return
    const sc = scrollerRef.current
    const first = highlights[0]
    const slot = slotRefs.current.get(first.page)
    const size = pages.find((p) => p.page === first.page)
    if (!sc || !slot || !size) return
    const scale = slot.getBoundingClientRect().width / size.width
    const slotTop = slot.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
    const target = slotTop + first.bbox[1] * scale - sc.clientHeight / 3
    sc.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    // Only react to explicit focus requests, not to highlight identity or zoom changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken])

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-200">
      <div className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-2 text-sm text-slate-700">
        <span>
          Page <b>{currentPage}</b> / {pages.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="rounded p-1.5 hover:bg-slate-100 disabled:opacity-40"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.25).toFixed(2)))}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
          >
            <ZoomOut size={18} />
          </button>
          <button
            className="w-14 rounded py-1 text-center tabular-nums hover:bg-slate-100"
            onClick={() => setZoom(1)}
            title="Reset to fit width"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="rounded p-1.5 hover:bg-slate-100 disabled:opacity-40"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.25).toFixed(2)))}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
          >
            <ZoomIn size={18} />
          </button>
        </div>
      </div>

      <div ref={setScrollerEl} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
        {loadError ? (
          <p className="p-6 text-sm text-red-600">Failed to load PDF: {loadError}</p>
        ) : (
          <Document
            file={fileUrl}
            loading={<Spinner />}
            onLoadError={(e) => setLoadError(e.message)}
            onLoadSuccess={() => setLoadError(null)}
            // w-max/min-w-full: when zoomed wider than the pane the content grows
            // instead of overflowing off-screen to the left (flex-centering clips that).
            className="w-max min-w-full"
          >
            <div style={{ padding: `${PAGE_GAP}px ${GUTTER}px` }} className="flex flex-col items-center">
              {pages.map((p) => (
                <PageSlot
                  key={p.page}
                  size={p}
                  widthPx={pageWidthPx}
                  root={scroller}
                  boxes={highlights.filter((h) => h.page === p.page)}
                  registerRef={(el) => {
                    if (el) slotRefs.current.set(p.page, el)
                    else slotRefs.current.delete(p.page)
                  }}
                />
              ))}
            </div>
          </Document>
        )}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-slate-500">
      <Loader2 className="animate-spin" size={18} /> Loading PDF…
    </div>
  )
}

interface SlotProps {
  size: PageSize
  widthPx: number
  root: HTMLDivElement | null
  boxes: HighlightBox[]
  registerRef: (el: HTMLDivElement | null) => void
}

/** One page. Its box is sized from backend metadata so scroll positions are exact
 *  even before the canvas renders; the canvas is only mounted near the viewport. */
function PageSlot({ size, widthPx, root, boxes, registerRef }: SlotProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(size.page <= 2)
  const heightPx = (widthPx * size.height) / size.width

  useEffect(() => {
    const el = elRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), {
      root,
      rootMargin: '1200px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  return (
    <div
      ref={(el) => {
        elRef.current = el
        registerRef(el)
      }}
      data-page={size.page}
      className="relative mb-4 bg-white shadow-md"
      style={{ width: widthPx, height: heightPx }}
    >
      {near && (
        <Page
          pageNumber={size.page}
          width={widthPx}
          renderAnnotationLayer={false}
          loading={<div style={{ width: widthPx, height: heightPx }} />}
        />
      )}
      {/* Overlay: percentage positioning against the page's PDF-point size means the
          boxes track any zoom/resize with no recomputation. */}
      <div className="pointer-events-none absolute inset-0">
        {boxes.map((b, i) => {
          const [x0, y0, x1, y1] = b.bbox
          return (
            <div
              key={i}
              className="hl-box absolute rounded-[2px] bg-amber-300/50 ring-1 ring-amber-500/70"
              style={{
                left: `${(x0 / size.width) * 100}%`,
                top: `${(y0 / size.height) * 100}%`,
                width: `${((x1 - x0) / size.width) * 100}%`,
                height: `${((y1 - y0) / size.height) * 100}%`,
                mixBlendMode: 'multiply',
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
