#!/usr/bin/env node
// W1-13 (M6, SB-7, SB-19, TM-10, TM-14, TM-17, TM-19): the one local quality
// gate. Every unit's Definition of Done (plan §5.1 rule 4) and the git hooks
// in .githooks run it; nothing merges, pushes or deploys unless it passes.
//
//   npm run verify                              every step, in this order:
//     gates   source and manifest gates (below), no build needed
//     lint    eslint . with 0 errors and 0 warnings
//     types   tsc -b (app, node and worker projects)
//     build   vite build cinematic, then classic (so dist/ is left with the
//             default design), each followed by the dist/client gate
//     test    npm test (node --test, built-ins only, no network)
//   node scripts/verify.mjs --only=gates,lint   some steps (recorded as partial)
//   node scripts/verify.mjs --release           every step, no baseline waiver
//                                               (the release gate, W3-19)
//   node scripts/verify.mjs --check-record [--release]
//                                               exit 0 only if the last record
//                                               is a full pass (a --release
//                                               one) of the tree as it is now
//   node scripts/verify.mjs --hook=pre-push     from .githooks/pre-push
//   node scripts/verify.mjs --hook=pre-merge-commit   from .githooks/pre-merge-commit
//   node scripts/verify.mjs --hook=pre-commit   from .githooks/pre-commit
//
// The hooks: every push is verified; a push of a release/* branch or a
// release-* tag without waivers. On a release/* branch every commit is
// verified without waivers: pre-merge-commit covers the merge commit git
// creates itself, pre-commit the one `git commit` creates (a merge stopped by
// a conflict, --no-commit, --squash or a failed pre-merge-commit, and any
// other commit). A fast-forward creates no commit and runs no hook, so the
// release gate runs `--release` (or `--check-record --release`) on the tag.
// Whatever the flags, a run (or --check-record) on a release checkout (a
// release/* branch, or HEAD at a release-* tag) is strict, so a plain
// `npm run verify` there applies no waiver either.
//
// Node older than 24.2 is refused (exit 2). A Node too old to have
// import.meta.main is refused even when a test only imports this file, so no
// Node can pass verify by running nothing.
//
// The first failing step stops the run. Every run, pass or fail, writes
// node_modules/.tmp/verify-record.json (commit, tree state, a fingerprint of
// the content, steps, waivers, hooks path; no environment values), which a
// review gate cites as proof that verify ran on the reviewed content: the
// fingerprint is a SHA-256 over HEAD, the binary diff of every tracked change
// and every untracked file, taken before and after the steps (a run whose
// tree changed meanwhile fails), and `--check-record` recomputes it.
//
// Gates (TypeScript's own parser, so comments and strings are never mistaken
// for code, over every script file under src/, worker/ and shared/):
//   console     SB-7/TM-17: console.* arguments are literals, or templates in
//               which every ${} directly follows `code=`, `count=` or `job=`
//               and whose value is not an error or rejection value (a caught
//               error, `error`, `err`, `reason`, ..., a destructured catch
//               binding, or a local declared or assigned from one; only its
//               .code, .name, .length or .size) and reads no name on the
//               denylist or with a token/email/phone/password/secret/iban/
//               message/stack part (snake_case read as camelCase).
//   media       TM-10: nothing outside worker/portal/gates.ts touches the
//               MEDIA binding (property, 'MEDIA' key or destructuring).
//   wa-me       TM-19: WhatsApp link hosts appear only in src/lib/whatsapp.ts.
//   storage     SB-12/UX-01 (src/ and shared/ only): localStorage and
//               sessionStorage only as getItem/setItem/removeItem (or [key])
//               with the key 'sy:intro:v1'; no IndexedDB, cookies, Cache
//               Storage or StorageManager (by name or by ['key']).
//   html-sink   SB-6: no innerHTML, outerHTML, insertAdjacentHTML,
//               dangerouslySetInnerHTML, srcdoc, createContextualFragment,
//               document.write, eval, Function constructor or string timers
//               (by name or by ['key']).
//   users-role  W1-12/SB-2: no SQL in API code writes users.role, except the
//               customer insert whose role value is the literal 'customer';
//               a table name assembled at run time counts as users.
//   data-image  TM-14 (after each build): no data:image URI in dist/client.
//   manifest    M6: `npm test` is the harness command below, engines.node is
//               the Node floor, no dependency outside the frozen list,
//               package-lock.json agrees.
//   hooks       M6/SB-19: the three hooks exist and, once tracked, are 100755.
// A few pre-existing violations in files this unit does not own are waived
// one by one (BASELINE_WAIVERS: gate, file, exact finding, count, the unit
// that removes it); a new or extra finding fails, a waiver that no longer
// matches is reported, and no waiver applies to a release (--release, a
// commit on release/*, a push of a release ref, any run on a release/*
// branch or with HEAD at a release-* tag).
//
// Every child process runs without a shell, from an argument array, with
// Node's own executable and the tool's entry file from node_modules.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { isatty } from 'node:tty'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const RECORD_PATH = path.join(APP_ROOT, 'node_modules', '.tmp', 'verify-record.json')

/**
 * The oldest Node verify runs on: the project's runtime is Node 24, and 24.2
 * is the first 24.x with import.meta.main. package.json engines.node says the
 * same (manifest gate).
 */
export const MIN_NODE_VERSION = '24.2.0'
export const ENGINES_NODE = `>=${MIN_NODE_VERSION}`
const NODE_VERSION = process.versions.node

/** `npm test`, as verify runs it (package.json must say the same). */
export const TEST_NODE_ARGS = Object.freeze([
  '--import',
  './tests/setup/no-network.mjs',
  '--import',
  './tests/setup/resolve-ts.mjs',
  '--test',
  'tests/**/*.test.mjs',
])
export const TEST_SCRIPT = `node ${TEST_NODE_ARGS.map((argument) =>
  argument.includes('*') ? `"${argument}"` : argument,
).join(' ')}`
export const VERIFY_SCRIPT = 'node scripts/verify.mjs'

/**
 * The dependency set of go-live (binding rule: no new dependency). Adding one
 * is an owner decision recorded by changing this list in the same commit.
 */
export const FROZEN_DEPENDENCIES = Object.freeze([
  '@cloudflare/vite-plugin',
  '@cloudflare/workers-types',
  '@eslint/js',
  '@fontsource/cairo',
  '@fontsource/el-messiri',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@vitejs/plugin-react',
  'eslint',
  'eslint-plugin-react-hooks',
  'eslint-plugin-react-refresh',
  'firebase',
  'globals',
  'jose',
  'react',
  'react-dom',
  'sharp',
  'typescript',
  'typescript-eslint',
  'vite',
  'wrangler',
])

const SOURCE_ROOTS = ['src', 'worker', 'shared']
const CLIENT_ROOTS = ['src/', 'shared/']
const MEDIA_GATE_FILE = 'worker/portal/gates.ts'
const WHATSAPP_LINK_FILE = 'src/lib/whatsapp.ts'
const INTRO_STORAGE_KEY = 'sy:intro:v1'
const DIST_CLIENT = 'dist/client'
/** Designs in build order: the default (classic) is built last and stays. */
const DESIGNS = ['cinematic', 'classic']
const STEPS = ['gates', 'lint', 'types', 'build', 'test']

const SCRIPT_KINDS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
])
/** Built files read as text by the data-image gate; binaries are skipped. */
const DIST_TEXT_EXTENSIONS = new Set([
  '',
  '.css',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml',
])

export const GATE_RULES = Object.freeze({
  console:
    'SB-7/TM-17: console.* arguments must be literals, or templates whose every ${} follows code=, count= or job=; never an error or rejection value (only its .code or .name), a message, stack, token or personal value.',
  media:
    'TM-10: only worker/portal/gates.ts may touch the MEDIA binding; everything else calls getMediaBucket(env).',
  'wa-me':
    'TM-19: WhatsApp links (wa.me, api.whatsapp.com, whatsapp://) are built only in src/lib/whatsapp.ts.',
  storage:
    "SB-12/UX-01: client storage is only localStorage/sessionStorage getItem, setItem or removeItem with the key 'sy:intro:v1'.",
  'html-sink':
    'SB-6: render text through React; no HTML or code sinks (innerHTML, dangerouslySetInnerHTML, eval, Function, ...).',
  'users-role':
    "W1-12/SB-2: API code never writes users.role; only the customer insert sets it, to the literal 'customer'. Admins are promoted by scripts/promote-admin.mjs.",
  'data-image':
    "TM-14: no data:image URI may ship in dist/client (the CSP allows img-src 'self' only; keep build.assetsInlineLimit at 0).",
  manifest:
    'M6: package.json scripts.test/verify are the harness commands, engines.node is the Node floor verify enforces, no dependency outside FROZEN_DEPENDENCIES, and package-lock.json agrees with package.json.',
  hooks:
    'M6/SB-19: .githooks/pre-push, pre-merge-commit and pre-commit exist and, once tracked, are executable (git ignores them otherwise on Linux and macOS).',
  tree: 'The scanned folders may not contain symbolic links (they would be bundled but not scanned).',
})

/** `removeBy` of a waiver whose file no plan unit owns yet. */
export const UNASSIGNED = 'UNASSIGNED'

/**
 * Pre-existing findings in files no wave-1 unit owns. Each one matches an
 * exact finding in one file, at most `count` times; anything else fails.
 * `removeBy` is the plan unit that owns the file and must remove the finding
 * (or UNASSIGNED until the orchestrator assigns one). None of them applies to
 * a release (strict runs), so every one must be gone before the release gate.
 */
export const BASELINE_WAIVERS = Object.freeze([
  {
    gate: 'storage',
    file: 'src/components/PackageConfigurator.tsx',
    detail: 'localStorage key "sundus-yar-booking-draft-v1"',
    count: 3,
    removeBy: 'W3-20',
    reason:
      'The pre-plan package draft (package selections and the chosen event date; no name, phone or token). SB-12 allows only sy:intro:v1 and no owner decision to keep it is recorded, so it blocks the release until it is removed or decided.',
  },
  {
    gate: 'wa-me',
    file: 'src/components/BookingActions.tsx',
    detail: 'wa.me',
    count: 1,
    removeBy: 'W2-02',
    reason:
      'Checks the host of a lib/whatsapp link before re-addressing it to the customer; W1-11 adds a builder for any number.',
  },
  {
    gate: 'console',
    file: 'worker/jobs/hold-expiry.ts',
    detail: 'template key "expired"',
    count: 1,
    removeBy: 'W2-03',
    reason: 'A count logged under its own key instead of count=.',
  },
  {
    gate: 'console',
    file: 'worker/jobs/hold-expiry.ts',
    detail: 'template key "without_email"',
    count: 1,
    removeBy: 'W2-03',
    reason: 'A count logged under its own key instead of count=.',
  },
  {
    gate: 'console',
    file: 'worker/jobs/hold-expiry.ts',
    detail: 'template value "expiredWithoutEmail"',
    count: 2,
    removeBy: 'W2-03',
    reason:
      'A count whose name has an "email" part (the gate cannot see types); the count= rewrite logs it through a name without one.',
  },
  {
    gate: 'console',
    file: 'worker/jobs/hold-reminders.ts',
    detail: 'template key "queued"',
    count: 1,
    removeBy: 'W2-03',
    reason: 'A count logged under its own key instead of count=.',
  },
  {
    gate: 'console',
    file: 'worker/jobs/hold-reminders.ts',
    detail: 'template key "superseded"',
    count: 1,
    removeBy: 'W2-03',
    reason: 'A count logged under its own key instead of count=.',
  },
  {
    gate: 'console',
    file: 'worker/notify/outbox.ts',
    detail: 'template key "released"',
    count: 1,
    removeBy: UNASSIGNED,
    reason:
      'A count logged under its own key instead of count=. No plan unit owns worker/notify/outbox.ts; it blocks the release until one removes it.',
  },
])

/** The waivers a run may apply: none for a release. */
export function waiversFor(strict) {
  return strict ? [] : BASELINE_WAIVERS
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Syntax helpers

function lineOf(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  )
}

function walk(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => walk(child, callback))
}

/**
 * False for an identifier that only names a member (`x.name`, `{ name: 1 }`,
 * a method, an enum member, a JSX attribute); true for every other use,
 * destructuring and shorthand properties included.
 */
function isReference(identifier) {
  const parent = identifier.parent

  if (ts.isPropertyAccessExpression(parent)) {
    return parent.name !== identifier
  }

  if (ts.isQualifiedName(parent)) {
    return parent.right !== identifier
  }

  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isJsxAttribute(parent)
  ) {
    return parent.name !== identifier
  }

  return true
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function isStringLike(node) {
  return isStringLiteralLike(node) || ts.isTemplateExpression(node)
}

function unwrap(node) {
  let current = node

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }

  return current
}

/** `a`, `a.b.c` or `window.a` ends in `name`. */
function isNamed(node, name) {
  return (
    (ts.isIdentifier(node) && node.text === name) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === name)
  )
}

// ---------------------------------------------------------------------------
// console (SB-7, TM-17)

const LOG_TEMPLATE_KEYS = new Set(['code', 'count', 'job'])
/** Final names a log value may never read (lower case). */
const LOG_VALUE_DENYLIST = new Set([
  'address',
  'authorization',
  'body',
  'cause',
  'cookie',
  'customername',
  'details',
  'displayname',
  'email',
  'firstname',
  'fullname',
  'headers',
  'href',
  'iban',
  'inspect',
  'json',
  'lastname',
  'message',
  'note',
  'notes',
  'password',
  'phone',
  'query',
  'search',
  'secret',
  'stack',
  'string',
  'stringify',
  'token',
  'tostring',
  'url',
])
/** Name parts a log value may never read, wherever they appear (lower case). */
const LOG_VALUE_FRAGMENTS = [
  'email',
  'iban',
  'message',
  'password',
  'phone',
  'secret',
  'stack',
  'token',
]
/**
 * Names of an error or rejection value. Interpolated as a whole, an Error is
 * `Name: message`, and messages echo input (V8's JSON.parse quotes the body).
 */
const LOG_ERROR_VALUE =
  /^(?:e|err|error|errors|ex|exc|exception|failure|reason|rejection)$/i
/** The only members of a caught error or rejection value a log may read. */
const LOG_ERROR_MEMBERS = new Set(['code', 'name', 'length', 'size'])

/**
 * A denylisted name, or one with a denylisted part. Underscores are dropped
 * first, so a D1 column (first_name, customer_email) reads as its camelCase
 * twin.
 */
function isDeniedLogName(name) {
  const lower = name.toLowerCase().replaceAll('_', '')
  return (
    LOG_VALUE_DENYLIST.has(lower) ||
    LOG_VALUE_FRAGMENTS.some((fragment) => lower.includes(fragment))
  )
}

/**
 * The names and member chains a template value interpolates as they are
 * (through `+`, `??`, `||`, `&&`, `,` and `?:`, not through a call, which
 * logs its own result).
 */
function directLogValues(expression) {
  const node = unwrap(expression)

  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return [node]
  }

  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.CommaToken,
    ].includes(node.operatorToken.kind)
  ) {
    return [...directLogValues(node.left), ...directLogValues(node.right)]
  }

  if (ts.isConditionalExpression(node)) {
    return [...directLogValues(node.whenTrue), ...directLogValues(node.whenFalse)]
  }

  return []
}

/** The identifier a member chain starts from, or null. */
function chainRoot(node) {
  let current = node

  while (ts.isPropertyAccessExpression(current)) {
    current = unwrap(current.expression)
  }

  return ts.isIdentifier(current) ? current : null
}

/** The first parameter of `.catch(fn)` or the second function of `.then(ok, fn)`. */
function isRejectionHandler(fn) {
  const call = fn.parent

  if (!ts.isCallExpression(call)) {
    return false
  }

  const callee = unwrap(call.expression)

  if (!ts.isPropertyAccessExpression(callee)) {
    return false
  }

  const position = call.arguments.indexOf(fn)
  return (
    (callee.name.text === 'catch' && position === 0) ||
    (callee.name.text === 'then' && position === 1)
  )
}

/**
 * Each name a binding declares, with the member of the bound value it holds
 * (`{ code }` and `{ code: c }` hold .code) or null (the whole value, a
 * nested or array element, a rest element).
 */
function bindingNames(name, topLevel = true) {
  if (ts.isIdentifier(name)) {
    return [{ name: name.text, member: null }]
  }

  if (ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap((element) => {
      const key = element.propertyName ?? element.name
      const member =
        topLevel &&
        element.dotDotDotToken === undefined &&
        (ts.isIdentifier(key) || ts.isStringLiteral(key))
          ? key.text
          : null

      return bindingNames(element.name, false).map((binding) =>
        ts.isIdentifier(element.name) ? { ...binding, member } : binding,
      )
    })
  }

  if (ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bindingNames(element.name, false) : [],
    )
  }

  return []
}

/** True when a binding declares `text` as more than .code, .name, .length or .size of its value. */
function bindsWholeValue(bindingName, text) {
  return bindingNames(bindingName).some(
    ({ name, member }) => name === text && !(member !== null && LOG_ERROR_MEMBERS.has(member)),
  )
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/** Calls `callback` for every node under `node`, not entering nested functions. */
function walkScope(node, callback) {
  ts.forEachChild(node, (child) => {
    callback(child)

    if (!isFunctionLike(child)) {
      walkScope(child, callback)
    }
  })
}

/**
 * The names and member chains an alias of a value holds as they are: what
 * directLogValues follows, plus template spans and, for a call, its receiver
 * (`caught.message.trim()`) and, when the callee only turns its input into
 * text (String, JSON.stringify, toString, inspect), its arguments. Other calls
 * (`classifyJobFailure(error)`) hold their own result.
 */
function aliasSourceValues(expression) {
  const node = unwrap(expression)

  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.flatMap((span) => aliasSourceValues(span.expression))
  }

  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    const values = []

    if (ts.isPropertyAccessExpression(callee)) {
      values.push(...aliasSourceValues(callee.expression))
    }

    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null

    if (calleeName !== null && isDeniedLogName(calleeName)) {
      values.push(...node.arguments.flatMap((argument) => aliasSourceValues(argument)))
    }

    return values
  }

  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.CommaToken,
    ].includes(node.operatorToken.kind)
  ) {
    return [...aliasSourceValues(node.left), ...aliasSourceValues(node.right)]
  }

  if (ts.isConditionalExpression(node)) {
    return [...aliasSourceValues(node.whenTrue), ...aliasSourceValues(node.whenFalse)]
  }

  return directLogValues(node)
}

/** The last name of a name or member chain. */
function finalNameOf(node) {
  return ts.isIdentifier(node) ? node.text : node.name.text
}

/**
 * True when a name or member chain is a caught value, or a member of one
 * other than .code, .name, .length or .size.
 */
function readsCaughtMember(node, seen) {
  const root = chainRoot(node)

  return (
    root !== null &&
    (root === node || !LOG_ERROR_MEMBERS.has(finalNameOf(node))) &&
    isCaughtValue(root, seen)
  )
}

/** True when an alias's source holds an error or rejection value, or part of a caught one. */
function readsCaughtValue(expression, seen) {
  return aliasSourceValues(expression).some(
    (value) => LOG_ERROR_VALUE.test(finalNameOf(value)) || readsCaughtMember(value, seen),
  )
}

function isAssignment(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
}

/**
 * True when the name holds a caught error or rejection value: an enclosing
 * `catch (x)` or rejection handler binds it (a destructured one too, except
 * as its .code, .name, .length or .size), or a variable of an enclosing
 * function or the module is declared or assigned from an expression that
 * reads one (`const detail = caught.message`, `const copy = error`).
 * Shadowing is ignored, so a same-named variable elsewhere in scope counts
 * too; `seen` stops a cycle of aliases.
 */
function isCaughtValue(identifier, seen = new Set()) {
  const text = identifier.text
  const scopes = []

  for (let scope = identifier.parent; scope !== undefined; scope = scope.parent) {
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration !== undefined &&
      bindsWholeValue(scope.variableDeclaration.name, text)
    ) {
      return true
    }

    if (
      (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
      isRejectionHandler(scope) &&
      scope.parameters.length > 0 &&
      bindsWholeValue(scope.parameters[0].name, text)
    ) {
      return true
    }

    if (isFunctionLike(scope) || ts.isSourceFile(scope)) {
      scopes.push(scope)
    }
  }

  for (const scope of scopes) {
    let found = false

    walkScope(scope, (node) => {
      if (found || seen.has(node)) {
        return
      }

      let source = null

      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        bindsWholeValue(node.name, text)
      ) {
        source = node.initializer
      } else if (isAssignment(node) && ts.isIdentifier(unwrap(node.left)) && unwrap(node.left).text === text) {
        source = node.right
      }

      if (source !== null) {
        seen.add(node)
        found = readsCaughtValue(source, seen)
      }
    })

    if (found) {
      return true
    }
  }

  return false
}

/** Findings for one name or member chain a template interpolates as it is. */
function errorValueFindings(node) {
  const finalName = finalNameOf(node)

  if (LOG_ERROR_VALUE.test(finalName)) {
    return [`template value "${finalName}" is an error or rejection value`]
  }

  if (readsCaughtMember(node, new Set())) {
    return [`template value "${finalName}" reads a caught error`]
  }

  return []
}

/**
 * The names a log value reads (the last name of a member chain; for a call,
 * the callee, its receiver and every argument), or null for a shape that is
 * not allowed at all.
 */
function logValueNames(expression) {
  const node = unwrap(expression)

  if (ts.isIdentifier(node)) {
    return [node.text]
  }

  if (ts.isPropertyAccessExpression(node)) {
    return [node.name.text]
  }

  if (ts.isNumericLiteral(node) || isStringLiteralLike(node)) {
    return []
  }

  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    let names

    if (ts.isIdentifier(callee)) {
      names = [callee.text]
    } else if (ts.isPropertyAccessExpression(callee)) {
      // error.message.slice(0, 9) reads `message`.
      const receiver = logValueNames(callee.expression)

      if (receiver === null) {
        return null
      }

      names = [callee.name.text, ...receiver]
    } else {
      return null
    }

    for (const argument of node.arguments) {
      const argumentNames = logValueNames(argument)

      if (argumentNames === null) {
        return null
      }

      names.push(...argumentNames)
    }

    return names
  }

  if (ts.isBinaryExpression(node)) {
    const left = logValueNames(node.left)
    const right = logValueNames(node.right)

    return left === null || right === null ? null : [...left, ...right]
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrue = logValueNames(node.whenTrue)
    const whenFalse = logValueNames(node.whenFalse)

    return whenTrue === null || whenFalse === null
      ? null
      : [...whenTrue, ...whenFalse]
  }

  return null
}

function consoleArgumentFindings(argument) {
  if (ts.isNumericLiteral(argument) || isStringLiteralLike(argument)) {
    return []
  }

  if (!ts.isTemplateExpression(argument)) {
    return ['non-literal argument']
  }

  const findings = []
  let before = argument.head.text

  for (const span of argument.templateSpans) {
    const key = /([A-Za-z_][A-Za-z0-9_]*)=$/.exec(before)?.[1]

    if (key === undefined) {
      findings.push('template value without a key=')
    } else if (!LOG_TEMPLATE_KEYS.has(key)) {
      findings.push(`template key "${key}"`)
    }

    const names = logValueNames(span.expression)

    if (names === null) {
      findings.push('template value is not a plain name, member or call')
    } else {
      for (const name of names) {
        if (isDeniedLogName(name)) {
          findings.push(`template value "${name}"`)
        }
      }

      for (const value of directLogValues(span.expression)) {
        findings.push(...errorValueFindings(value))
      }
    }

    before = span.literal.text
  }

  return findings
}

function consoleGate(sourceFile) {
  const findings = []

  walk(sourceFile, (node) => {
    let misuse = false

    if (ts.isIdentifier(node) && node.text === 'console' && isReference(node)) {
      const member = node.parent
      const call = member.parent

      if (
        ts.isPropertyAccessExpression(member) &&
        member.expression === node &&
        ts.isCallExpression(call) &&
        call.expression === member
      ) {
        for (const argument of call.arguments) {
          for (const detail of consoleArgumentFindings(argument)) {
            findings.push({ node: argument, detail })
          }
        }
      } else {
        misuse = true
      }
    } else if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'console') ||
      (ts.isElementAccessExpression(node) &&
        isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'console')
    ) {
      misuse = true
    }

    if (misuse) {
      findings.push({ node, detail: 'console used other than console.method(...)' })
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// media (TM-10)

function mediaGate(sourceFile) {
  const findings = []

  walk(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'MEDIA') {
      findings.push({ node, detail: '.MEDIA' })
    } else if (isStringLiteralLike(node) && node.text === 'MEDIA') {
      findings.push({ node, detail: "'MEDIA' key" })
    } else if (ts.isBindingElement(node)) {
      const source = node.propertyName ?? node.name

      if (
        (ts.isIdentifier(source) || ts.isStringLiteral(source)) &&
        source.text === 'MEDIA'
      ) {
        findings.push({ node, detail: 'MEDIA destructured' })
      }
    } else if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === 'MEDIA'
    ) {
      findings.push({ node, detail: 'MEDIA destructured' })
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// wa-me (TM-19)

const WHATSAPP_LINK_HOSTS = [
  { pattern: /wa\.me/i, detail: 'wa.me' },
  { pattern: /api\.whatsapp\.com/i, detail: 'api.whatsapp.com' },
  { pattern: /whatsapp:\/\//i, detail: 'whatsapp://' },
]

function literalText(node) {
  if (
    isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  ) {
    return node.text
  }

  // A regular expression spells `wa.me` as `wa\.me`.
  return ts.isRegularExpressionLiteral(node) ? node.text.replaceAll('\\', '') : null
}

function whatsAppGate(sourceFile) {
  const findings = []

  walk(sourceFile, (node) => {
    const text = literalText(node)

    if (text === null) {
      return
    }

    for (const { pattern, detail } of WHATSAPP_LINK_HOSTS) {
      if (pattern.test(text)) {
        findings.push({ node, detail })
      }
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// storage (SB-12, UX-01)

const KEYED_STORAGE = new Set(['localStorage', 'sessionStorage'])
const KEYED_STORAGE_METHODS = new Set(['getItem', 'setItem', 'removeItem'])
const FORBIDDEN_STORAGE = new Set(['indexedDB', 'cookieStore', 'caches', 'openDatabase'])

/** A string literal, or a `const` in this file initialised with one. */
function resolveStringConstant(sourceFile, expression) {
  const node = unwrap(expression)

  if (isStringLiteralLike(node)) {
    return node.text
  }

  if (!ts.isIdentifier(node)) {
    return null
  }

  const values = []

  walk(sourceFile, (candidate) => {
    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === node.text &&
      ts.isVariableDeclarationList(candidate.parent) &&
      (candidate.parent.flags & ts.NodeFlags.Const) !== 0 &&
      candidate.initializer !== undefined
    ) {
      const initializer = unwrap(candidate.initializer)
      values.push(isStringLiteralLike(initializer) ? initializer.text : null)
    }
  })

  return values.length === 1 ? values[0] : null
}

function keyedStorageFinding(sourceFile, api, storageNode) {
  const parent = storageNode.parent
  let keyExpression

  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === storageNode &&
    KEYED_STORAGE_METHODS.has(parent.name.text) &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    keyExpression = parent.parent.arguments[0]
  } else if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === storageNode
  ) {
    keyExpression = parent.argumentExpression
  } else {
    return `${api} used other than getItem/setItem/removeItem or [key]`
  }

  const key =
    keyExpression === undefined
      ? null
      : resolveStringConstant(sourceFile, keyExpression)

  if (key === INTRO_STORAGE_KEY) {
    return null
  }

  return key === null ? `${api} key not a constant` : `${api} key "${key}"`
}

function storageGate(sourceFile) {
  const findings = []

  walk(sourceFile, (node) => {
    let api = null
    let storageNode = null

    if (ts.isIdentifier(node) && isReference(node)) {
      api = node.text
      storageNode = node
    } else if (ts.isPropertyAccessExpression(node)) {
      api = node.name.text
      storageNode = node

      if (
        (api === 'cookie' && isNamed(unwrap(node.expression), 'document')) ||
        (api === 'storage' && isNamed(unwrap(node.expression), 'navigator'))
      ) {
        findings.push({ node, detail: api === 'cookie' ? 'document.cookie' : 'navigator.storage' })
        return
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      isStringLiteralLike(node.argumentExpression)
    ) {
      const key = node.argumentExpression.text
      const receiver = unwrap(node.expression)

      if (KEYED_STORAGE.has(key) || FORBIDDEN_STORAGE.has(key)) {
        findings.push({ node, detail: `${key} by computed access` })
      } else if (
        (key === 'cookie' && isNamed(receiver, 'document')) ||
        (key === 'storage' && isNamed(receiver, 'navigator'))
      ) {
        findings.push({
          node,
          detail: `${key === 'cookie' ? 'document.cookie' : 'navigator.storage'} by computed access`,
        })
      }

      return
    }

    if (api === null) {
      return
    }

    if (FORBIDDEN_STORAGE.has(api)) {
      findings.push({ node, detail: api })
    } else if (KEYED_STORAGE.has(api)) {
      const detail = keyedStorageFinding(sourceFile, api, storageNode)

      if (detail !== null) {
        findings.push({ node, detail })
      }
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// html-sink (SB-6)

const HTML_SINK_MEMBERS = new Set([
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'createContextualFragment',
  'srcdoc',
])
/** Sink names flagged as a string anywhere (`el['innerHTML']`, `window['eval']`). */
const SINK_KEYS = new Set([
  ...HTML_SINK_MEMBERS,
  'dangerouslySetInnerHTML',
  'eval',
  'Function',
])
const DOCUMENT_WRITERS = new Set(['write', 'writeln'])
const STRING_TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate'])

function htmlSinkGate(sourceFile) {
  const findings = []

  walk(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text

      if (HTML_SINK_MEMBERS.has(name) || name === 'eval') {
        findings.push({ node, detail: name })
      } else if (
        DOCUMENT_WRITERS.has(name) &&
        isNamed(unwrap(node.expression), 'document')
      ) {
        findings.push({ node, detail: `document.${name}` })
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      isStringLiteralLike(node.argumentExpression) &&
      DOCUMENT_WRITERS.has(node.argumentExpression.text) &&
      isNamed(unwrap(node.expression), 'document')
    ) {
      findings.push({ node, detail: `document.${node.argumentExpression.text}` })
    } else if (ts.isIdentifier(node)) {
      if (node.text === 'dangerouslySetInnerHTML') {
        findings.push({ node, detail: 'dangerouslySetInnerHTML' })
      } else if (
        (node.text === 'srcDoc' || node.text === 'srcdoc') &&
        ts.isJsxAttribute(node.parent)
      ) {
        findings.push({ node, detail: 'srcdoc' })
      } else if (node.text === 'eval' && isReference(node)) {
        findings.push({ node, detail: 'eval' })
      }
    } else if (isStringLiteralLike(node) && SINK_KEYS.has(node.text)) {
      findings.push({ node, detail: `'${node.text}' key` })
    } else if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)

      if (isNamed(callee, 'Function')) {
        findings.push({ node, detail: 'Function constructor' })
      } else if (
        ts.isCallExpression(node) &&
        (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) &&
        STRING_TIMERS.has(ts.isIdentifier(callee) ? callee.text : callee.name.text) &&
        node.arguments.length > 0 &&
        isStringLike(unwrap(node.arguments[0]))
      ) {
        findings.push({ node, detail: 'string timer' })
      }
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// users-role (W1-12 L2, SB-2)

/** Stands for a `${...}` or a non-literal operand inside assembled SQL. */
const SQL_HOLE = '\u0000'
const SQL_WORD = /[A-Za-z_][A-Za-z0-9_$]*/y

/** Tokens with their `start`/`end` offsets (to tell `users${x}` from `users ${x}`). */
function tokenizeSql(text) {
  const tokens = []
  let index = 0
  const push = (kind, value, start) => tokens.push({ kind, value, start, end: index })

  while (index < text.length) {
    const character = text[index]
    const start = index

    if (character === SQL_HOLE) {
      index += 1
      push('hole', '', start)
    } else if (/\s/.test(character)) {
      index += 1
    } else if (text.startsWith('--', index)) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
    } else if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character
      let value = ''
      let cursor = index + 1

      while (cursor < text.length) {
        if (text[cursor] === close) {
          if (close !== ']' && text[cursor + 1] === close) {
            value += close
            cursor += 2
            continue
          }

          break
        }

        value += text[cursor]
        cursor += 1
      }

      index = cursor + 1
      push(character === "'" ? 'string' : 'name', value, start)
    } else if (/[A-Za-z_]/.test(character)) {
      SQL_WORD.lastIndex = index
      const [word] = SQL_WORD.exec(text)
      index += word.length
      push('word', word, start)
    } else {
      index += 1
      push('punct', character, start)
    }
  }

  return tokens
}

function isKeyword(token, keyword) {
  return token?.kind === 'word' && token.value.toUpperCase() === keyword
}

function isPunct(token, value) {
  return token?.kind === 'punct' && token.value === value
}

function nameOf(token) {
  return token?.kind === 'word' || token?.kind === 'name'
    ? token.value.toLowerCase()
    : null
}

/** Label of a table whose name is assembled at run time (it may be users). */
const RUN_TIME_TABLE = '<table assembled at run time>'

/**
 * One part of a table name at tokens[start]: a name, or a hole (a name that
 * is or touches a `${}`, such as `${T}` or `users_${suffix}`); null otherwise.
 */
function namePartAt(tokens, start) {
  let index = start
  let hole = false
  let name = ''

  while (
    (tokens[index]?.kind === 'word' ||
      tokens[index]?.kind === 'name' ||
      tokens[index]?.kind === 'hole') &&
    (index === start || tokens[index].start === tokens[index - 1].end)
  ) {
    hole = hole || tokens[index].kind === 'hole'
    name += tokens[index].value
    index += 1
  }

  if (index === start) {
    return null
  }

  return { value: hole ? null : name.toLowerCase(), hole, end: index }
}

/**
 * The table named at tokens[start] (`[schema.]table`): `users`, the
 * RUN_TIME_TABLE label when its name is assembled at run time, or null for
 * another table; and the index after it.
 */
function tableAt(tokens, start) {
  let part = namePartAt(tokens, start)

  if (part !== null && isPunct(tokens[part.end], '.')) {
    part = namePartAt(tokens, part.end + 1)
  }

  if (part === null) {
    return { table: null, end: start }
  }

  const table = part.hole ? RUN_TIME_TABLE : part.value === 'users' ? 'users' : null
  return { table, end: part.end }
}

/**
 * Splits tokens[start..] at top-level commas until a top-level stop keyword,
 * a `;`, or (with `closeAtDepthZero`) the `)` that closes the list.
 */
function splitList(tokens, start, stopKeywords, closeAtDepthZero = false) {
  const items = [[]]
  let depth = 0
  let index = start

  for (; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (depth === 0) {
      if (isPunct(token, ';') || stopKeywords.some((word) => isKeyword(token, word))) {
        break
      }

      if (closeAtDepthZero && isPunct(token, ')')) {
        break
      }

      if (isPunct(token, ',')) {
        items.push([])
        continue
      }
    }

    if (isPunct(token, '(')) {
      depth += 1
    } else if (isPunct(token, ')')) {
      depth -= 1
    }

    items.at(-1).push(token)
  }

  return { items: items.filter((item) => item.length > 0), end: index }
}

/** Findings for a SET clause starting at `start`; returns them and the end. */
function setClauseFindings(tokens, start, stopKeywords, label) {
  const { items, end } = splitList(tokens, start, stopKeywords)
  const findings = []

  for (const item of items) {
    if (item.some((token) => token.kind === 'hole')) {
      findings.push(`${label} SET clause is assembled at run time`)
      continue
    }

    let targets

    if (isPunct(item[0], '(')) {
      const closing = item.findIndex((token) => isPunct(token, ')'))
      targets = item.slice(1, closing).map(nameOf).filter((name) => name !== null)
    } else {
      // `users.role` / `role`: the name right before the `=`.
      const equals = item.findIndex((token) => isPunct(token, '='))
      targets = [nameOf(item[equals - 1])]
    }

    if (targets.includes('role')) {
      findings.push(`${label} SET role`)
    }
  }

  return { findings, end }
}

function isCustomerLiteral(item) {
  const valueTokens = isKeyword(item[1], 'AS') ? item.slice(0, 1) : item
  return (
    valueTokens.length === 1 &&
    valueTokens[0].kind === 'string' &&
    valueTokens[0].value === 'customer'
  )
}

const SELECT_STOP = ['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'ON', 'RETURNING']

function insertFindings(tokens, verbIndex) {
  let index = verbIndex + 1
  let replaces = isKeyword(tokens[verbIndex], 'REPLACE')

  if (isKeyword(tokens[index], 'OR')) {
    replaces = replaces || isKeyword(tokens[index + 1], 'REPLACE')
    index += 2
  }

  if (!isKeyword(tokens[index], 'INTO')) {
    return []
  }

  const { table, end } = tableAt(tokens, index + 1)

  if (table === null) {
    return []
  }

  const label = `INSERT INTO ${table}`
  index = end

  if (replaces) {
    return [`REPLACE INTO ${table} (replaces the role too)`]
  }

  if (isKeyword(tokens[index], 'AS')) {
    index += 2
  }

  if (tokens[index]?.kind === 'hole') {
    return [`${label} is assembled at run time`]
  }

  if (!isPunct(tokens[index], '(')) {
    // Without a column list the role cannot be checked. Prose ("insert into
    // users ...") is not SQL, unless the verb is written as SQL is here.
    const writtenAsSql = tokens[verbIndex].value === tokens[verbIndex].value.toUpperCase()
    const sqlFollows = ['VALUES', 'SELECT', 'DEFAULT', 'WITH'].some((word) =>
      isKeyword(tokens[index], word),
    )
    return writtenAsSql || sqlFollows
      ? [`${label} without a column list`]
      : []
  }

  const columnList = splitList(tokens, index + 1, [], true)

  if (columnList.items.flat().some((token) => token.kind === 'hole')) {
    return [`${label} column list is assembled at run time`]
  }

  const columns = columnList.items.map((item) => nameOf(item[0]))
  const roleColumn = columns.indexOf('role')
  const findings = []
  index = columnList.end + 1

  if (roleColumn !== -1 && table === RUN_TIME_TABLE) {
    // Only the customer insert into users itself may name role.
    findings.push(`${label} names role`)
  } else if (roleColumn !== -1) {
    if (isKeyword(tokens[index], 'VALUES')) {
      index += 1

      while (isPunct(tokens[index], '(')) {
        const row = splitList(tokens, index + 1, [], true)

        if (!isCustomerLiteral(row.items[roleColumn] ?? [])) {
          findings.push("INSERT INTO users role value is not 'customer'")
        }

        index = row.end + 1

        if (!isPunct(tokens[index], ',')) {
          break
        }

        index += 1
      }
    } else if (isKeyword(tokens[index], 'SELECT')) {
      index += 1

      if (isKeyword(tokens[index], 'DISTINCT') || isKeyword(tokens[index], 'ALL')) {
        index += 1
      }

      const selectList = splitList(tokens, index, SELECT_STOP)

      if (!isCustomerLiteral(selectList.items[roleColumn] ?? [])) {
        findings.push("INSERT INTO users role value is not 'customer'")
      }

      index = selectList.end
    } else {
      findings.push("INSERT INTO users role value is not 'customer'")
    }
  }

  // Upsert branches of this statement: ON CONFLICT ... DO UPDATE SET ...
  let depth = 0

  for (; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (isPunct(token, '(')) {
      depth += 1
    } else if (isPunct(token, ')')) {
      depth -= 1
    } else if (depth === 0 && isPunct(token, ';')) {
      break
    } else if (
      depth === 0 &&
      isKeyword(token, 'DO') &&
      isKeyword(tokens[index + 1], 'UPDATE') &&
      isKeyword(tokens[index + 2], 'SET')
    ) {
      const clause = setClauseFindings(
        tokens,
        index + 3,
        ['WHERE', 'RETURNING', 'ON'],
        table === 'users' ? 'upsert' : `upsert into ${table}`,
      )
      findings.push(...clause.findings)
      index = clause.end - 1
    }
  }

  return findings
}

function updateFindings(tokens, verbIndex) {
  let index = verbIndex + 1

  if (isKeyword(tokens[index], 'OR')) {
    index += 2
  }

  const { table, end } = tableAt(tokens, index)

  if (table === null) {
    return []
  }

  const label = `UPDATE ${table}`
  index = end

  // SQLite's qualified-table-name: [AS] alias, then INDEXED BY x | NOT INDEXED.
  if (isKeyword(tokens[index], 'AS')) {
    index += 2
  } else if (
    tokens[index]?.kind === 'word' &&
    !['SET', 'INDEXED', 'NOT'].some((word) => isKeyword(tokens[index], word))
  ) {
    index += 1
  }

  if (isKeyword(tokens[index], 'INDEXED') && isKeyword(tokens[index + 1], 'BY')) {
    index += 3
  } else if (isKeyword(tokens[index], 'NOT') && isKeyword(tokens[index + 1], 'INDEXED')) {
    index += 2
  }

  if (tokens[index]?.kind === 'hole') {
    return [`${label} is assembled at run time`]
  }

  if (!isKeyword(tokens[index], 'SET')) {
    // Prose ("update users") is not SQL; upper-case UPDATE without its SET
    // in the same string is SQL split in pieces, which cannot be checked.
    const writtenAsSql = tokens[verbIndex].value === 'UPDATE'
    return writtenAsSql && tokens[index] === undefined
      ? [`${label} without its SET clause in the same string`]
      : []
  }

  return setClauseFindings(tokens, index + 1, ['WHERE', 'FROM', 'RETURNING', 'ORDER', 'LIMIT'], label)
    .findings
}

/** Role-write findings in one SQL text (exported for tests). */
export function analyzeSql(text) {
  const tokens = tokenizeSql(text)
  const findings = []

  tokens.forEach((token, index) => {
    // The REPLACE of `INSERT OR REPLACE` / `UPDATE OR REPLACE` is not a verb.
    const conflictClause = isKeyword(tokens[index - 1], 'OR')

    if (isKeyword(token, 'UPDATE')) {
      findings.push(...updateFindings(tokens, index))
    } else if (
      isKeyword(token, 'INSERT') ||
      (isKeyword(token, 'REPLACE') && !conflictClause)
    ) {
      findings.push(...insertFindings(tokens, index))
    }
  })

  return findings
}

function isConcatenation(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
}

/** The text of a string expression, with SQL_HOLE for every non-literal part. */
function assembledText(node) {
  const current = unwrap(node)

  if (isStringLiteralLike(current)) {
    return current.text
  }

  if (ts.isTemplateExpression(current)) {
    return (
      current.head.text +
      current.templateSpans.map((span) => SQL_HOLE + span.literal.text).join('')
    )
  }

  if (isConcatenation(current)) {
    return assembledText(current.left) + assembledText(current.right)
  }

  return SQL_HOLE
}

function usersRoleGate(sourceFile) {
  const findings = []

  walk(sourceFile, (node) => {
    if (!isStringLike(node) && !isConcatenation(node)) {
      return
    }

    // Analyse each whole `a + b + c` once, from its outermost node.
    let parent = node.parent

    while (ts.isParenthesizedExpression(parent)) {
      parent = parent.parent
    }

    if (isConcatenation(parent)) {
      return
    }

    for (const detail of analyzeSql(assembledText(node))) {
      findings.push({ node, detail })
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// Scanning

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

/** Every gate over one source file (path relative to the app, with `/`). */
export function scanSource(relativePath, text) {
  const extension = path.posix.extname(relativePath)
  const scriptKind = SCRIPT_KINDS.get(extension)

  if (scriptKind === undefined) {
    return []
  }

  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const gates = [
    ['console', consoleGate],
    ['html-sink', htmlSinkGate],
    ['users-role', usersRoleGate],
  ]

  if (relativePath !== MEDIA_GATE_FILE) {
    gates.push(['media', mediaGate])
  }

  if (relativePath !== WHATSAPP_LINK_FILE) {
    gates.push(['wa-me', whatsAppGate])
  }

  if (CLIENT_ROOTS.some((root) => relativePath.startsWith(root))) {
    gates.push(['storage', storageGate])
  }

  return gates.flatMap(([gate, run]) =>
    run(sourceFile).map(({ node, detail }) => ({
      gate,
      file: relativePath,
      line: lineOf(sourceFile, node),
      detail,
    })),
  )
}

/** The data-image gate over one built file's text. */
export function scanDistText(relativePath, text) {
  const count = text.match(/data:image/gi)?.length ?? 0

  return count === 0
    ? []
    : [{ gate: 'data-image', file: relativePath, line: 0, detail: `data:image x${count}` }]
}

/** Files under `root` (relative, with `/`), and every symlink as a finding. */
function listFiles(root) {
  const files = []
  const findings = []
  const pending = [root]

  while (pending.length > 0) {
    const directory = pending.pop()
    const absolute = path.join(APP_ROOT, directory)

    if (!existsSync(absolute)) {
      continue
    }

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`

      if (entry.isSymbolicLink()) {
        findings.push({ gate: 'tree', file: relative, line: 0, detail: 'symbolic link' })
      } else if (entry.isDirectory()) {
        pending.push(relative)
      } else if (entry.isFile()) {
        files.push(relative)
      }
    }
  }

  return { files: files.sort(), findings }
}

function scanSources() {
  const findings = []

  for (const root of SOURCE_ROOTS) {
    const listing = listFiles(root)
    findings.push(...listing.findings)

    for (const file of listing.files) {
      findings.push(...scanSource(file, readFileSync(path.join(APP_ROOT, file), 'utf8')))
    }
  }

  return findings
}

function scanDist() {
  if (!existsSync(path.join(APP_ROOT, DIST_CLIENT))) {
    return [{ gate: 'data-image', file: DIST_CLIENT, line: 0, detail: 'no build output to check' }]
  }

  const listing = listFiles(DIST_CLIENT)
  const findings = [...listing.findings]

  for (const file of listing.files) {
    if (DIST_TEXT_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) {
      findings.push(...scanDistText(file, readFileSync(path.join(APP_ROOT, file), 'latin1')))
    }
  }

  return findings
}

function sortedEntries(record) {
  return JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)))
}

/** The manifest gate over package.json and package-lock.json contents. */
export function checkManifest(manifest, lock) {
  const findings = []
  const finding = (file, detail) => findings.push({ gate: 'manifest', file, line: 0, detail })

  if (manifest?.scripts?.test !== TEST_SCRIPT) {
    finding('package.json', 'scripts.test is not the harness command')
  }

  if (manifest?.scripts?.verify !== VERIFY_SCRIPT) {
    finding('package.json', 'scripts.verify is not node scripts/verify.mjs')
  }

  if (manifest?.engines?.node !== ENGINES_NODE) {
    finding('package.json', `engines.node is not "${ENGINES_NODE}"`)
  }

  const frozen = new Set(FROZEN_DEPENDENCIES)
  const lockRoot = lock?.packages?.['']

  if (lockRoot === undefined) {
    finding('package-lock.json', 'no root package entry (lockfileVersion 2 or later expected)')
  }

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest?.[field] ?? {})) {
      if (!frozen.has(name)) {
        finding('package.json', `new dependency "${name}"`)
      }
    }

    if (lockRoot !== undefined && sortedEntries(manifest?.[field]) !== sortedEntries(lockRoot[field])) {
      finding('package-lock.json', `${field} differ from package.json`)
    }
  }

  return findings
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(APP_ROOT, relativePath), 'utf8'))
}

export const HOOK_FILES = Object.freeze([
  '.githooks/pre-push',
  '.githooks/pre-merge-commit',
  '.githooks/pre-commit',
])

/**
 * The hooks gate over each hook's state: `exists` on disk and its mode in
 * the git index (null while untracked). Git ignores a hook that is not
 * executable on Linux and macOS, so a tracked hook must be 100755.
 */
export function checkHooks(states) {
  const findings = []

  for (const file of HOOK_FILES) {
    const state = states[file]

    if (state?.exists !== true) {
      findings.push({ gate: 'hooks', file, line: 0, detail: 'missing' })
    } else if (state.indexMode !== null && state.indexMode !== '100755') {
      findings.push({
        gate: 'hooks',
        file,
        line: 0,
        detail: `tracked as ${state.indexMode}; run: git update-index --chmod=+x ${file}`,
      })
    }
  }

  return findings
}

function hookStates() {
  return Object.fromEntries(
    HOOK_FILES.map((file) => {
      const entry = git(['ls-files', '--stage', '--', file])
      const mode = entry.ok ? /^(\d{6}) /.exec(entry.stdout)?.[1] ?? null : null
      return [file, { exists: existsSync(path.join(APP_ROOT, file)), indexMode: mode }]
    }),
  )
}

/**
 * Splits findings into failures and waived ones. A waiver absorbs at most
 * `count` findings with its exact gate, file and detail.
 */
export function applyWaivers(findings, waivers = BASELINE_WAIVERS) {
  const remaining = waivers.map((waiver) => ({ waiver, left: waiver.count }))
  const failures = []
  const waived = []

  for (const finding of findings) {
    const slot = remaining.find(
      ({ waiver, left }) =>
        left > 0 &&
        waiver.gate === finding.gate &&
        waiver.file === finding.file &&
        waiver.detail === finding.detail,
    )

    if (slot === undefined) {
      failures.push(finding)
    } else {
      slot.left -= 1
      waived.push(finding)
    }
  }

  const stale = remaining
    .filter(({ left }) => left > 0)
    .map(({ waiver, left }) => ({ ...waiver, unused: left }))

  return { failures, waived, stale }
}

function printFailures(failures) {
  for (const gate of [...new Set(failures.map((finding) => finding.gate))]) {
    console.error(`\n[${gate}] ${GATE_RULES[gate]}`)

    for (const finding of failures.filter((candidate) => candidate.gate === gate)) {
      const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file
      console.error(`  ${where}  ${finding.detail}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Git (read-only: --no-optional-locks, so git does not even refresh the index)

/** The most a git command may print (a binary diff of a large change). */
const GIT_MAX_OUTPUT = 512 * 1024 * 1024

function spawnGit(args, encoding) {
  return spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: APP_ROOT,
    encoding,
    maxBuffer: GIT_MAX_OUTPUT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true,
  })
}

function git(args) {
  const result = spawnGit(args, 'utf8')

  return {
    ok: result.error === undefined && result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout.trim() : '',
  }
}

function gitValue(args) {
  const result = git(args)
  return result.ok && result.stdout !== '' ? result.stdout : null
}

/** A git command's output as bytes, or null if it failed. */
function gitBytes(args) {
  const result = spawnGit(args, 'buffer')
  return result.error === undefined && result.status === 0 ? result.stdout : null
}

function isErrorCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code
}

/**
 * The content fingerprint from its parts: the HEAD commit id, the binary
 * diff of HEAD against the working tree, and each untracked file's path and
 * bytes. Every field is length-prefixed, so no two trees share an input.
 */
export function fingerprintContent({ head, diff, untracked }) {
  const hash = createHash('sha256')
  const field = (label, bytes) => {
    hash.update(`${label} ${bytes.length}\n`)
    hash.update(bytes)
    hash.update('\n')
  }

  field('head', Buffer.from(head, 'utf8'))
  field('diff', diff)

  for (const file of untracked) {
    field('path', Buffer.from(file.path, 'utf8'))
    field('file', file.content)
  }

  return hash.digest('hex')
}

/** An untracked path's bytes, a link's target or its kind; null once deleted. */
function untrackedContent(absolutePath) {
  try {
    const stats = lstatSync(absolutePath)

    if (stats.isSymbolicLink()) {
      return Buffer.from(`symbolic link to ${readlinkSync(absolutePath)}`, 'utf8')
    }

    return stats.isFile()
      ? readFileSync(absolutePath)
      : Buffer.from(stats.isDirectory() ? 'directory' : 'other', 'utf8')
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }

    throw error
  }
}

/** The fingerprint of the tree as it is now, or null when git cannot tell. */
function contentFingerprint() {
  const head = gitValue(['rev-parse', '--verify', '--quiet', 'HEAD'])
  const top = gitValue(['rev-parse', '--show-toplevel'])
  // Fixed options, so user configuration (external diff, textconv, rename
  // detection, prefixes, context, algorithm) cannot change the bytes.
  const diff = gitBytes([
    'diff',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--unified=3',
    '--diff-algorithm=myers',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    'HEAD',
    '--',
  ])
  const listing = gitBytes(['ls-files', '-z', '--others', '--exclude-standard', '--full-name'])

  if (head === null || top === null || diff === null || listing === null) {
    return null
  }

  const untracked = []

  for (const file of listing.toString('utf8').split('\0').filter((entry) => entry !== '').sort()) {
    const content = untrackedContent(path.join(top, file))

    if (content === null) {
      return null
    }

    untracked.push({ path: file, content })
  }

  return fingerprintContent({ head, diff, untracked })
}

function gitState() {
  const status = git(['status', '--porcelain=v1'])
  const hooksPath = gitValue(['config', '--get', 'core.hooksPath'])

  return {
    head: gitValue(['rev-parse', '--verify', '--quiet', 'HEAD']),
    branch: gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    mergeHead: gitValue(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']),
    treeClean: status.ok ? status.stdout === '' : null,
    changedPaths: status.ok && status.stdout !== '' ? status.stdout.split('\n').length : 0,
    hooksPath,
    hooksActive:
      hooksPath !== null &&
      path.resolve(APP_ROOT, hooksPath) === path.join(APP_ROOT, '.githooks'),
  }
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The ref updates git passes to pre-push on stdin; throws on anything else. */
export function parsePrePushInput(text) {
  const updates = []

  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '')

    if (trimmed === '') {
      continue
    }

    const parts = trimmed.split(' ')

    if (parts.length !== 4 || !OBJECT_ID.test(parts[1]) || !OBJECT_ID.test(parts[3])) {
      throw new UsageError('pre-push: unexpected input from git.')
    }

    updates.push({
      localRef: parts[0],
      localSha: parts[1],
      remoteRef: parts[2],
      deletion: /^0+$/.test(parts[1]),
    })
  }

  return updates
}

/** A release/* branch or a release-* tag. */
export function isReleaseRef(ref) {
  return ref.startsWith('refs/heads/release/') || ref.startsWith('refs/tags/release-')
}

/**
 * `refusal`: null when the push may be verified, 'skip' when it only deletes
 * refs, or the reason it is refused. Verify tests the working tree, so the
 * tree must be clean and every pushed commit must be the checked-out one.
 * `strict`: a release ref is pushed, so no waiver applies.
 */
function prePushGate(stdinText) {
  const pushes = parsePrePushInput(stdinText).filter((update) => !update.deletion)

  if (pushes.length === 0) {
    return { refusal: 'skip', strict: false }
  }

  const strict = pushes.some(
    (update) => isReleaseRef(update.localRef) || isReleaseRef(update.remoteRef),
  )
  const head = gitValue(['rev-parse', '--verify', '--quiet', 'HEAD'])

  for (const update of pushes) {
    const commit = gitValue(['rev-parse', '--verify', '--quiet', `${update.localSha}^{commit}`])

    if (head === null || commit !== head) {
      return {
        refusal: `${update.localRef} is not the checked-out commit. Verify tests the working tree: check out what you push (or push HEAD) and push again.`,
        strict,
      }
    }
  }

  const status = git(['status', '--porcelain=v1'])

  if (!status.ok || status.stdout !== '') {
    return {
      refusal: 'the working tree has uncommitted or untracked changes. Verify must test exactly what is pushed: commit or stash them first.',
      strict,
    }
  }

  return { refusal: null, strict }
}

/**
 * Why the checkout is a release, or null: the release/* branch it is on, or
 * the release-* tags at HEAD. `tagsAtHead` is null when they could not be
 * read, which counts as a release (fails closed).
 */
export function releaseCheckoutReason(branch, tagsAtHead) {
  if (branch !== null && branch.startsWith('release/')) {
    return `branch ${branch} is checked out`
  }

  if (tagsAtHead === null) {
    return 'the tags at HEAD could not be read'
  }

  const tags = tagsAtHead.filter((tag) => tag.startsWith('release-'))
  return tags.length > 0 ? `HEAD is tagged ${tags.join(', ')}` : null
}

/** releaseCheckoutReason for the checked-out tree. */
function releaseCheckout() {
  const branch = gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD'])

  if (gitValue(['rev-parse', '--verify', '--quiet', 'HEAD']) === null) {
    return releaseCheckoutReason(branch, [])
  }

  const tags = git(['tag', '--points-at', 'HEAD', '--list', 'release-*'])
  const tagsAtHead = tags.ok
    ? tags.stdout.split('\n').map((tag) => tag.trim()).filter((tag) => tag !== '')
    : null

  return releaseCheckoutReason(branch, tagsAtHead)
}

/**
 * For a commit about to be created (pre-merge-commit, pre-commit): null to
 * verify, 'skip' outside release/*, or the reason it is refused.
 */
function releaseCommitGate(mode) {
  const branch = gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD'])

  if (branch === null || !branch.startsWith('release/')) {
    return 'skip'
  }

  // The commit is the index (git points GIT_INDEX_FILE at the one it
  // commits); anything unstaged or untracked would be verified but not
  // committed.
  const unstaged = git(['diff', '--quiet'])
  const untracked = git(['ls-files', '--others', '--exclude-standard'])

  if (unstaged.ok && untracked.ok && untracked.stdout === '') {
    return null
  }

  return mode === 'pre-merge-commit'
    ? 'the working tree has changes that are not part of the merge. Verify must test exactly the merge result: run `git merge --abort`, stash them and merge again.'
    : 'the working tree has changes that are not part of this commit. Verify must test exactly what is committed: stage or stash them and commit again.'
}

// ---------------------------------------------------------------------------
// Steps

/** The entry file of a tool in node_modules, run as `node <entry>`. */
function packageBin(packageName, binName) {
  const packageDirectory = path.join(APP_ROOT, 'node_modules', packageName)
  const manifestPath = path.join(packageDirectory, 'package.json')

  if (!existsSync(manifestPath)) {
    return null
  }

  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relativeEntry = typeof bin === 'string' ? bin : bin?.[binName]

  if (typeof relativeEntry !== 'string') {
    return null
  }

  const entry = path.resolve(packageDirectory, relativeEntry)
  return entry.startsWith(packageDirectory + path.sep) ? entry : null
}

function runNode(label, args, { env = process.env, timeoutMinutes = 20 } = {}) {
  console.log(`\n== verify: ${label}`)

  const result = spawnSync(process.execPath, args, {
    cwd: APP_ROOT,
    env,
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMinutes * 60_000,
    windowsHide: true,
  })

  if (result.error !== undefined) {
    const code = 'code' in result.error ? result.error.code : result.error.name
    console.error(`verify: ${label} did not complete (${code}).`)
    return false
  }

  if (result.status !== 0) {
    console.error(`verify: ${label} failed (exit ${result.status ?? result.signal}).`)
    return false
  }

  return true
}

function runTool(label, packageName, binName, args, options) {
  const entry = packageBin(packageName, binName)

  if (entry === null) {
    console.error(`verify: ${label}: node_modules/${packageName} is missing; run npm ci.`)
    return false
  }

  return runNode(label, [entry, ...args], options)
}

/** Prints a gate run; `waivers` are the ones that apply to these findings. */
function reportGates(label, findings, waivers, context) {
  const { failures, waived, stale } = applyWaivers(findings, waivers)
  context.waived.push(...waived)
  context.staleWaivers.push(...stale)

  for (const waiver of stale) {
    console.log(`verify: waiver no longer needed (${waiver.gate}, ${waiver.file}, ${waiver.detail}); remove it from BASELINE_WAIVERS.`)
  }

  if (failures.length > 0) {
    printFailures(failures)
    console.error(`\nverify: ${label}: ${failures.length} finding(s).`)
    return false
  }

  console.log(`verify: ${label}: clean (${waived.length} baseline finding(s) waived).`)
  return true
}

const STEP_RUNNERS = {
  gates(context) {
    console.log('\n== verify: gates (console, media, wa-me, storage, html-sink, users-role, manifest, hooks)')
    const findings = [
      ...checkManifest(readJson('package.json'), readJson('package-lock.json')),
      ...checkHooks(hookStates()),
      ...scanSources(),
    ]
    return reportGates('gates', findings, waiversFor(context.strict), context)
  },
  lint() {
    return runTool('lint (eslint, 0 warnings)', 'eslint', 'eslint', ['.', '--max-warnings=0'], {
      timeoutMinutes: 10,
    })
  },
  types() {
    return runTool('types (tsc -b)', 'typescript', 'tsc', ['-b'], { timeoutMinutes: 10 })
  },
  build(context) {
    for (const design of DESIGNS) {
      const built = runTool(`build (${design})`, 'vite', 'vite', ['build'], {
        env: { ...process.env, VITE_SITE_DESIGN: design },
      })

      if (!built || !reportGates(`data-image (${design})`, scanDist(), [], context)) {
        return false
      }
    }

    return true
  },
  test() {
    return runNode('test (npm test)', [...TEST_NODE_ARGS])
  },
}

// ---------------------------------------------------------------------------
// Verify record

function writeRecord(record) {
  mkdirSync(path.dirname(RECORD_PATH), { recursive: true })
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`)
}

function readRecord() {
  try {
    return JSON.parse(readFileSync(RECORD_PATH, 'utf8'))
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

/**
 * Why a record does not prove a full pass (a strict one with `release`) of
 * the current content (`current`: head and fingerprint), or null if it does.
 */
export function recordProblem(record, current, { release = false } = {}) {
  if (record === null || typeof record !== 'object' || record.tool !== 'scripts/verify.mjs') {
    return 'there is no verify record'
  }

  if (record.result !== 'pass') {
    return `the last run did not pass (${String(record.result)})`
  }

  if (record.partial !== false) {
    return 'the last run was partial (--only)'
  }

  if (release && record.strict !== true) {
    return 'the last run applied baseline waivers; run verify --release'
  }

  if (typeof record.fingerprint !== 'string' || current.fingerprint === null) {
    return 'the content fingerprint is missing'
  }

  if (record.git?.head !== current.head || record.fingerprint !== current.fingerprint) {
    return 'the tree is not the one the last run verified'
  }

  return null
}

function checkRecord(release) {
  const current = {
    head: gitValue(['rev-parse', '--verify', '--quiet', 'HEAD']),
    fingerprint: contentFingerprint(),
  }
  const problem = recordProblem(readRecord(), current, { release })

  if (problem !== null) {
    console.error(`verify: the record does not prove this tree: ${problem}.`)
    return 1
  }

  console.log(
    `verify: the record proves a full${release ? ' release' : ''} pass of this tree (head=${current.head?.slice(0, 12)} fingerprint=${current.fingerprint.slice(0, 16)}).`,
  )
  return 0
}

// ---------------------------------------------------------------------------
// Main

const HOOKS = ['pre-push', 'pre-merge-commit', 'pre-commit']
const USAGE = `Usage: node scripts/verify.mjs [--only=${STEPS.join(',')} | --release] | --check-record [--release] | --hook=${HOOKS.join('|')}`

/** What each hook tells the person whose push, merge or commit it stopped. */
const HOOK_ADVICE = {
  'pre-push': 'The push was stopped. Fix the failure, commit and push again.',
  'pre-merge-commit':
    'The merge commit was not created. Run `git merge --abort`, fix the failure on the branch you merge and merge again (committing the merge as it is runs verify again through the pre-commit hook).',
  'pre-commit':
    'The commit was not created. Fix the failure and commit again; while merging, run `git merge --abort`, fix it on the branch you merge and merge again.',
}

/** The command line as { mode, steps, release }; throws a UsageError. */
export function parseOptions(argv) {
  const seen = new Set()
  let hook = null
  let requested = null

  for (const argument of argv) {
    const valued = /^--(only|hook)=(.+)$/.exec(argument)
    const flag = /^--(release|check-record)$/.exec(argument)
    const name = valued?.[1] ?? flag?.[1]

    if (name === undefined || seen.has(name)) {
      throw new UsageError(`Unexpected argument: ${argument}`)
    }

    seen.add(name)

    if (name === 'hook') {
      if (!HOOKS.includes(valued[2])) {
        throw new UsageError(`Unknown hook: ${valued[2]}`)
      }

      hook = valued[2]
    } else if (name === 'only') {
      requested = valued[2].split(',')

      if (requested.some((step) => !STEPS.includes(step))) {
        throw new UsageError(`Unknown step in ${argument}`)
      }
    }
  }

  if (hook !== null && seen.size > 1) {
    throw new UsageError('A hook takes no other argument: it always runs every step.')
  }

  if (requested !== null && (seen.has('release') || seen.has('check-record'))) {
    throw new UsageError('--release and --check-record cover every step; --only cannot be added.')
  }

  return {
    mode: hook ?? (seen.has('check-record') ? 'check-record' : seen.has('release') ? 'release' : 'manual'),
    steps: requested === null ? STEPS : STEPS.filter((step) => requested.includes(step)),
    release: seen.has('release'),
  }
}

/**
 * { refusal: null | 'skip' | reason, strict, strictBecause } for this run.
 * A run on a release checkout (a release/* branch, or HEAD at a release-*
 * tag) is strict however it was started, so `npm run verify` there applies
 * no waiver either.
 */
function runGate(mode) {
  let gate

  if (mode === 'pre-push') {
    if (isatty(0)) {
      throw new UsageError('--hook=pre-push reads the refs git passes on stdin.')
    }

    gate = prePushGate(readFileSync(0, 'utf8'))
    gate = { ...gate, strictBecause: gate.strict ? 'a release ref is pushed' : null }
  } else if (mode === 'pre-merge-commit' || mode === 'pre-commit') {
    gate = { refusal: releaseCommitGate(mode), strict: true, strictBecause: 'a commit on release/*' }
  } else {
    gate = { refusal: null, strict: mode === 'release', strictBecause: mode === 'release' ? '--release' : null }
  }

  if (gate.refusal === 'skip' || gate.strict) {
    return gate
  }

  const because = releaseCheckout()
  return because === null ? gate : { ...gate, strict: true, strictBecause: because }
}

function main(argv) {
  const { mode, steps, release } = parseOptions(argv)

  if (mode === 'check-record') {
    const because = release ? '--release' : releaseCheckout()

    if (because !== null) {
      console.log(`verify: release check (${because}): the record must be of a run with no baseline waiver.`)
    }

    return checkRecord(because !== null)
  }

  const startedAt = new Date().toISOString()
  const { refusal, strict, strictBecause } = runGate(mode)

  if (refusal === 'skip') {
    console.log(
      mode === 'pre-push'
        ? 'verify: the push only deletes refs; nothing to verify.'
        : 'verify: not a commit on a release/* branch; verify is not required here.',
    )
    return 0
  }

  const context = { waived: [], staleWaivers: [], strict }
  const results = []
  let fingerprint = null
  let contentChanged = false

  if (refusal === null) {
    if (strict) {
      console.log(`verify: release run (${strictBecause}): no baseline waiver applies.`)
    }

    const fingerprintBefore = contentFingerprint()

    for (const step of steps) {
      if (results.some((result) => result.status === 'fail')) {
        results.push({ step, status: 'skipped', seconds: 0 })
        continue
      }

      const began = Date.now()
      const passed = STEP_RUNNERS[step](context)
      results.push({
        step,
        status: passed ? 'pass' : 'fail',
        seconds: Math.round((Date.now() - began) / 100) / 10,
      })
    }

    fingerprint = contentFingerprint()
    contentChanged = fingerprint !== fingerprintBefore
  }

  const passed =
    refusal === null &&
    !contentChanged &&
    results.every((result) => result.status === 'pass')
  const state = gitState()

  writeRecord({
    tool: 'scripts/verify.mjs',
    result: refusal !== null ? 'refused' : passed ? 'pass' : 'fail',
    mode,
    strict,
    strictBecause,
    partial: steps.length !== STEPS.length,
    steps: results,
    waived: context.waived.map(({ gate, file, detail }) => ({ gate, file, detail })),
    staleWaivers: context.staleWaivers.map(({ gate, file, detail, unused }) => ({ gate, file, detail, unused })),
    fingerprint,
    contentChanged,
    git: state,
    node: process.version,
    startedAt,
    finishedAt: new Date().toISOString(),
  })

  if (refusal !== null) {
    console.error(`verify (${mode}): refused: ${refusal}`)
    return 1
  }

  if (contentChanged) {
    console.error('\nverify: the working tree changed while verify ran, so this run proves nothing; run it again.')
  }

  const scope = steps.length === STEPS.length ? (strict ? 'full, release' : 'full') : `partial: ${steps.join(',')}`
  const tree = state.treeClean === null ? 'unknown' : state.treeClean ? 'clean' : `${state.changedPaths} changed path(s)`
  console.log(
    `\nverify: ${passed ? 'PASS' : 'FAIL'} (${scope}) head=${state.head?.slice(0, 12) ?? 'none'} tree=${tree} fingerprint=${fingerprint?.slice(0, 16) ?? 'none'} record=${toPosix(path.relative(APP_ROOT, RECORD_PATH))}`,
  )

  if (!passed && mode in HOOK_ADVICE) {
    console.error(`verify (${mode}): ${HOOK_ADVICE[mode]}`)
  }

  return passed ? 0 : 1
}

/** Whether a Node version (process.versions.node) is at least MIN_NODE_VERSION. */
export function isSupportedNode(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)

  if (parts === null) {
    return false
  }

  const actual = parts.slice(1).map(Number)
  const minimum = MIN_NODE_VERSION.split('.').map(Number)
  const differs = actual.findIndex((part, index) => part !== minimum[index])

  return differs === -1 || actual[differs] > minimum[differs]
}

/**
 * True when Node was started with this file, false when a test imports it.
 * Fails closed: a Node without import.meta.main (before 24.2) is too old, so
 * it counts as started with this file and is refused below, whether it runs
 * or imports verify; a newer one without it compares the path it was given.
 */
function isProgramEntry() {
  if (typeof import.meta.main === 'boolean') {
    return import.meta.main
  }

  if (!isSupportedNode(NODE_VERSION)) {
    return true
  }

  const program = process.argv[1]

  return (
    program !== undefined &&
    existsSync(program) &&
    pathToFileURL(realpathSync(program)).href === import.meta.url
  )
}

if (isProgramEntry()) {
  if (!isSupportedNode(NODE_VERSION)) {
    console.error(`verify: Node ${ENGINES_NODE} is required (this is ${NODE_VERSION}); nothing was verified.`)
    process.exitCode = 2
  } else {
    try {
      process.exitCode = main(process.argv.slice(2))
    } catch (error) {
      if (!(error instanceof UsageError)) {
        throw error
      }

      console.error(`verify: ${error.message}\n${USAGE}`)
      process.exitCode = 2
    }
  }
}
