// W1-13 (M6): the one resolve hook `npm test` loads (`--import`) before any
// test file, so tests import the TypeScript sources as they are, with no
// build step and no dependency. Node strips the types itself; this hook only
// finds the file:
//
// - the Worker and shared/ import their siblings as `./x.js` (the TypeScript
//   convention) while only `./x.ts` exists;
// - the SPA imports its siblings without an extension (bundler resolution).
//
// A specifier is retried as its `.ts` sibling only when all of these hold:
// Node's own resolution failed with ERR_MODULE_NOT_FOUND, the specifier is
// relative (`./` or `../`) and ends in `.js` or has no extension, and the
// importing module is a local file outside node_modules (a test may import a
// copy of the sources from a temporary folder, to plant a violation in it).
// Anything else, including a sibling that does not exist either, fails
// exactly as Node would have failed, with the original error.
//
// Registered through node:module `register` on the main thread only: Node
// evaluates this same file again on its hooks thread to read `resolve`.

import { register } from 'node:module'
import { isMainThread } from 'node:worker_threads'

/** A local file that is not part of an installed package. */
function isOwnFile(parentURL) {
  return (
    typeof parentURL === 'string' &&
    parentURL.startsWith('file:') &&
    !parentURL.toLowerCase().includes('/node_modules/')
  )
}

/**
 * The `.ts` sibling to try for a specifier Node could not find, or null when
 * the hook must not touch it.
 */
export function tsSiblingOf(specifier, parentURL) {
  if (!/^\.{1,2}\//.test(specifier) || !isOwnFile(parentURL)) {
    return null
  }

  if (specifier.endsWith('.js')) {
    return `${specifier.slice(0, -3)}.ts`
  }

  const lastSegment = specifier.slice(specifier.lastIndexOf('/') + 1)

  // `..` and `.` name folders; a dot anywhere else is an extension that is
  // not ours to change (.css, .json, .tsx, ...).
  if (lastSegment === '' || lastSegment.includes('.')) {
    return null
  }

  return `${specifier}.ts`
}

function isModuleNotFound(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  )
}

/** node:module resolve hook (see the file comment). */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const sibling = isModuleNotFound(error)
      ? tsSiblingOf(specifier, context.parentURL)
      : null

    if (sibling === null) {
      throw error
    }

    try {
      return await nextResolve(sibling, context)
    } catch (siblingError) {
      // Report the specifier as it was written, not our guess.
      if (isModuleNotFound(siblingError)) {
        throw error
      }

      throw siblingError
    }
  }
}

if (isMainThread) {
  register(import.meta.url)
}
