import type { KeyboardEvent } from 'react'
import { getAdminPanelDomId, getAdminTabDomId } from './admin-location'

export interface AdminTabItem {
  id: string
  label: string
}

interface AdminTabListProps {
  tabs: readonly AdminTabItem[]
  activeTabId: string
  label: string
  onSelect: (tabId: string) => void
}

/**
 * WAI-ARIA tabs with automatic activation: one tab stop (roving tabindex),
 * the arrow keys move between tabs in reading order (in RTL, ArrowLeft goes
 * to the next tab), Home/End jump to the first/last. Every aria-controls
 * points at a panel the dashboard always renders (hidden when inactive).
 * The selected tab is marked by an underline and bold text, not colour alone.
 */
export default function AdminTabList({
  tabs,
  activeTabId,
  label,
  onSelect,
}: AdminTabListProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (tabs.length === 0) {
      return
    }

    const tabList = event.currentTarget
    const isRightToLeft = window.getComputedStyle(tabList).direction === 'rtl'
    const focusedIndex = tabs.findIndex(
      (tab) => getAdminTabDomId(tab.id) === document.activeElement?.id,
    )
    const currentIndex =
      focusedIndex >= 0
        ? focusedIndex
        : Math.max(
            0,
            tabs.findIndex((tab) => tab.id === activeTabId),
          )
    let nextIndex: number

    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = isRightToLeft ? currentIndex + 1 : currentIndex - 1
        break
      case 'ArrowRight':
        nextIndex = isRightToLeft ? currentIndex - 1 : currentIndex + 1
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = tabs.length - 1
        break
      default:
        return
    }

    event.preventDefault()

    const nextTab = tabs[(nextIndex + tabs.length) % tabs.length]

    if (!nextTab) {
      return
    }

    const nextTabElement = tabList.querySelector<HTMLElement>(
      `#${CSS.escape(getAdminTabDomId(nextTab.id))}`,
    )

    nextTabElement?.focus()
    onSelect(nextTab.id)
  }

  return (
    <div
      className="admin-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isSelected = tab.id === activeTabId

        return (
          <button
            aria-controls={getAdminPanelDomId(tab.id)}
            aria-selected={isSelected}
            className="admin-tabs__tab"
            id={getAdminTabDomId(tab.id)}
            key={tab.id}
            role="tab"
            tabIndex={isSelected ? 0 : -1}
            type="button"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
