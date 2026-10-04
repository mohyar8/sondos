/**
 * Modal dialogs can stack: the «confirm your password» prompt opens over an
 * admin confirmation dialog whose request asked for it. Each dialog traps
 * Tab and owns Escape through a document keydown listener, so only the
 * topmost one may act on a key; the others step aside.
 *
 * Every dialog renders through a portal appended to <body> when it opens, so
 * the last `[aria-modal="true"]` element in document order is the topmost.
 */

const MODAL_SELECTOR = '[aria-modal="true"]'

/** What Tab can reach inside a dialog. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** The most recently opened modal dialog, or null when none is open. */
export function getTopmostModal(): HTMLElement | null {
  const modals = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)

  return modals.length > 0 ? modals[modals.length - 1] : null
}

/**
 * Whether `dialog` should handle a key: it is the topmost modal (or none is
 * marked, e.g. between renders).
 */
export function isTopmostModal(dialog: HTMLElement): boolean {
  const topmostModal = getTopmostModal()

  return topmostModal === null || topmostModal === dialog
}

/**
 * The focus trap of a modal dialog: keeps Tab and Shift+Tab cycling through
 * the dialog's visible controls. Call it from the dialog's keydown listener
 * for the Tab key, once isTopmostModal(dialog) holds.
 */
export function containTabFocus(
  dialog: HTMLElement,
  event: KeyboardEvent,
): void {
  const focusableElements = Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0)

  if (focusableElements.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]
  const activeElement = document.activeElement

  // The panel itself counts as outside: it takes focus (tabindex -1) when
  // she clicks its text, and the browser's own Shift+Tab from there would
  // leave the dialog for the page underneath.
  if (!dialog.contains(activeElement) || activeElement === dialog) {
    event.preventDefault()
    const focusTarget = event.shiftKey ? lastElement : firstElement

    focusTarget.focus()
  } else if (event.shiftKey && activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}
