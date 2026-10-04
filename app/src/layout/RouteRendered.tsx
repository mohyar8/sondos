import { useEffect } from 'react'
import type { AppPath } from './navigation'

interface RouteRenderedProps {
  path: AppPath
  onRendered: (path: AppPath) => void
}

/**
 * Rendered as the last child inside a route's Suspense boundary. Its effect
 * only runs once the (possibly lazy) page has committed to the DOM, which is
 * when App can look up a #hash target and scroll to it.
 */
export default function RouteRendered({ path, onRendered }: RouteRenderedProps) {
  useEffect(() => {
    onRendered(path)
  }, [onRendered, path])

  return null
}
