import type { MediaRoute } from '../portal-routes.js'

/**
 * Slot: signed-url media files (11 §3.2 #15, Train B), filled by W9-01.
 * Templates are relative to `/api/media/`:
 * - GET ['*key'] with `?e=&s=` (the dispatcher verifies the signature first)
 * Auth SU. Gate 'private-media' (the whole namespace is closed until
 * isPrivateMediaAllowed). The bucket is reached only through gates.ts
 * getMediaBucket (E3).
 */
export const signedMediaRoutes: readonly MediaRoute[] = []
