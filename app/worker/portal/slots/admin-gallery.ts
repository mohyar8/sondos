import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin gallery management (11 §3.2 #27, Train B), filled by W9-03.
 * Templates are relative to `/api/admin/` (07 §3.E.1–3.E.7):
 * - POST, PATCH, DELETE ['bookings', ':bookingId', 'gallery']
 * - GET, POST           ['bookings', ':bookingId', 'gallery', 'photos']
 * - DELETE              ['bookings', ':bookingId', 'gallery', 'photos', ':photoId']
 * - GET                 ['bookings', ':bookingId', 'gallery', 'selection']
 * Auth AD+2F (the dispatcher applies the second factor to every
 * private-media route). Gate 'private-media' (G). Photo ids are checked
 * through (gallery_id, photo_id) of that booking's gallery.
 */
export const adminGalleryRoutes: readonly AdminPortalRoute[] = []
