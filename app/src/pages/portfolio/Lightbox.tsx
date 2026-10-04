import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import ResponsiveImage from '../../components/ResponsiveImage'
import type { SiteImage } from '../../data/site-images'
import './Lightbox.css'

interface LightboxProps {
  /** The photos the visitor can step through (the current filter's set). */
  images: readonly SiteImage[]
  /** Index into `images` of the photo on screen. */
  index: number
  onIndexChange: (nextIndex: number) => void
  onClose: () => void
}

interface SwipeStart {
  readonly pointerId: number
  readonly x: number
  readonly y: number
}

/** Class on <html> that stops the page behind the lightbox from scrolling. */
const SCROLL_LOCK_CLASS = 'has-open-lightbox'
/** Shortest horizontal finger travel that counts as a swipe. */
const SWIPE_MIN_DISTANCE_PX = 48
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/**
 * The `sizes` hint for the photo on screen. It mirrors how Lightbox.css fits
 * the figure: min(stage inline size, stage block size × ratio). The stage is
 * the viewport minus its side padding (0.5rem a side, or control height +
 * space-lg a side from 48rem) and minus the top bar and details, at least
 * 8.5rem tall together (toolbar 3.75rem + a one-line caption with counter
 * 4.85rem). Using that minimum never under-sizes the image, and a portrait
 * photo on a landscape screen no longer fetches the full-width variant.
 */
function getLightboxSizes(ratio: string): string {
  const heightLimitedWidth = `calc((100vh - 8.5rem) * ${ratio})`

  return [
    `(min-width: 48rem) min(100vw - 9.5rem, ${heightLimitedWidth})`,
    `min(100vw - 1rem, ${heightLimitedWidth})`,
  ].join(', ')
}

function isRightToLeft(element: Element): boolean {
  return window.getComputedStyle(element).direction === 'rtl'
}

interface ChevronIconProps {
  /** Which inline edge the chevron points to: `end` is left in RTL. */
  towards: 'start' | 'end'
}

function ChevronIcon({ towards }: ChevronIconProps) {
  // Drawn for RTL; Lightbox.css mirrors both chevrons in an LTR context.
  return (
    <svg
      className="lightbox__chevron"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={towards === 'end' ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5'}
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

/**
 * Full-screen photo viewer for the portfolio (design-system §4.10, D12).
 *
 * A native modal <dialog>: it sits in the top layer above the sticky header,
 * the rest of the page is inert while it is open, and Escape closes it.
 * Tab and Shift+Tab also wrap inside it. Navigation follows the physical
 * direction the visitor sees (§4.10's RTL note): in RTL the next photo is on
 * the left, so ArrowLeft, the left-hand chevron and a swipe to the right all
 * go forward. The page behind does not scroll while it is open.
 *
 * The parent mounts this only while a photo is open and returns focus to the
 * tile of the photo on screen once it unmounts.
 */
export default function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const swipeStartRef = useRef<SwipeStart | null>(null)
  const titleId = useId()
  const detailsId = useId()
  const image = images[index]
  const total = images.length

  useEffect(() => {
    const dialog = dialogRef.current

    if (dialog === null) {
      return undefined
    }

    const rootElement = document.documentElement
    rootElement.classList.add(SCROLL_LOCK_CLASS)

    if (!dialog.open) {
      dialog.showModal()
    }

    closeButtonRef.current?.focus()

    return () => {
      rootElement.classList.remove(SCROLL_LOCK_CLASS)

      if (dialog.open) {
        dialog.close()
      }
    }
  }, [])

  function showRelative(step: number) {
    if (total === 0) {
      return
    }

    // Wraps around, so the buttons never become disabled under the focus.
    onIndexChange((index + step + total) % total)
  }

  function handleDialogClose() {
    // A close event queued before the dialog was shown again (React's
    // development double-mount) must not close the reopened viewer.
    if (dialogRef.current?.open === true) {
      return
    }

    onClose()
  }

  function keepFocusInside(event: KeyboardEvent<HTMLDialogElement>) {
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (first === undefined || last === undefined) {
      return
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault()
        const isLeftKey = event.key === 'ArrowLeft'
        showRelative(isLeftKey === isRightToLeft(event.currentTarget) ? 1 : -1)
        break
      }
      case 'Home':
        event.preventDefault()
        onIndexChange(0)
        break
      case 'End':
        event.preventDefault()
        onIndexChange(Math.max(total - 1, 0))
        break
      case 'Tab':
        keepFocusInside(event)
        break
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' || !event.isPrimary) {
      return
    }

    swipeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipeStartRef.current
    swipeStartRef.current = null

    if (start === null || start.pointerId !== event.pointerId) {
      return
    }

    const distanceX = event.clientX - start.x
    const distanceY = event.clientY - start.y

    if (
      Math.abs(distanceX) < SWIPE_MIN_DISTANCE_PX ||
      Math.abs(distanceX) < Math.abs(distanceY) * 1.5
    ) {
      return
    }

    // Dragging the photo to the right brings in the one on its left, which
    // is the next photo in RTL.
    const draggedRight = distanceX > 0
    showRelative(draggedRight === isRightToLeft(event.currentTarget) ? 1 : -1)
  }

  function handlePointerCancel() {
    swipeStartRef.current = null
  }

  function handleStageClick(event: MouseEvent<HTMLDivElement>) {
    // A click on the empty area around the photo closes the viewer.
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  if (image === undefined) {
    return null
  }

  const ratio = (image.width / image.height).toFixed(4)

  return (
    <dialog
      ref={dialogRef}
      className="lightbox on-dark"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={detailsId}
      onClose={handleDialogClose}
      onKeyDown={handleKeyDown}
    >
      <h2 id={titleId} className="visually-hidden">
        عرض الصور بحجم أكبر
      </h2>

      <div className="lightbox__toolbar">
        <button
          ref={closeButtonRef}
          type="button"
          className="lightbox__button"
          onClick={onClose}
        >
          <CloseIcon />
          <span className="visually-hidden">إغلاق</span>
        </button>
      </div>

      <div
        className="lightbox__stage"
        onClick={handleStageClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {/* Keyed by photo so each one fades in on its own. */}
        <figure
          key={image.id}
          className="lightbox__figure"
          style={{
            aspectRatio: `${image.width} / ${image.height}`,
            inlineSize: `min(100cqi, calc(100cqb * ${ratio}))`,
            backgroundColor: image.placeholder,
          }}
        >
          <ResponsiveImage
            image={image}
            sizes={getLightboxSizes(ratio)}
            className="lightbox__image"
            loading="eager"
            fetchPriority="high"
          />
        </figure>

        {total > 1 && (
          <>
            <button
              type="button"
              className="lightbox__button lightbox__nav lightbox__nav--previous"
              onClick={() => showRelative(-1)}
            >
              <ChevronIcon towards="start" />
              <span className="visually-hidden">الصورة السابقة</span>
            </button>
            <button
              type="button"
              className="lightbox__button lightbox__nav lightbox__nav--next"
              onClick={() => showRelative(1)}
            >
              <ChevronIcon towards="end" />
              <span className="visually-hidden">الصورة التالية</span>
            </button>
          </>
        )}
      </div>

      {/* Announced politely whenever the photo changes. */}
      <div
        id={detailsId}
        className="lightbox__details"
        aria-live="polite"
        aria-atomic="true"
      >
        <p className="lightbox__counter">
          {index + 1} من {total}
        </p>
        <p className="lightbox__caption">{image.alt}</p>
      </div>
    </dialog>
  )
}
