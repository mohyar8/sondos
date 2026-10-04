// Types of scripts/config-guard.mjs for vite.config.ts (tsconfig.node.json
// has no allowJs, so the JavaScript module needs a declaration to be imported
// without an implicit any). Keep in step with the exports of the .mjs;
// tests/config-guard.test.mjs checks every name declared here exists there.

export interface Finding {
  readonly code: string
  readonly message: string
}

export interface HeaderLine {
  readonly name: string
  readonly value: string
  readonly detach: boolean
}

export interface HeadersRule {
  readonly path: string
  readonly headers: HeaderLine[]
}

export interface CspPolicy {
  readonly reportOnly: boolean
  readonly directives: Map<string, string[]>
}

export type CspMode = 'report-only' | 'enforce'

export interface BuildConfigInput {
  readonly environmentName?: string
  readonly mode?: string
  readonly workerVars: Record<string, unknown> | null
  readonly clientEnv: Record<string, string | undefined>
  readonly headersText: string
  readonly indexHtml: string
  readonly cspMode?: CspMode
}

export interface BuildConfigOptions {
  readonly requireClientConfig?: boolean
}

export interface BuildConfigResult {
  readonly problems: Finding[]
  readonly warnings: Finding[]
}

export const SITE_HEADERS_PATH: string
export const CSP_REPORT_PATH: string
export const CSP_REPORT_GROUP: string
export const CSP_MODES: readonly string[]

export function isFirebaseProjectId(value: unknown): value is string
export function expectedAuthDomain(projectId: string): string
export function isFirebaseAuthDomain(value: unknown): value is string
export function isEnvironmentName(value: unknown): value is string
export function parseCspMode(raw: string | undefined): CspMode | null
export function parseWranglerConfig(text: string): unknown
export function workerVars(
  config: unknown,
  environmentName: string | undefined,
): Record<string, unknown> | null
export function parseHeadersFile(text: string): HeadersRule[]
export function parseCsp(policy: string): Map<string, string[]>
export function cspHeadersOf(rules: HeadersRule[]): {
  readonly main: CspPolicy | null
  readonly trustedTypes: CspPolicy | null
}
export function inlineScriptHashes(html: string): string[]
export function enforceCspHeaders(text: string): string
export function checkSecurityHeaders(
  rules: HeadersRule[],
  cspMode: CspMode,
): Finding[]
export function checkBuildConfig(
  input: BuildConfigInput,
  options?: BuildConfigOptions,
): BuildConfigResult
export function formatFindings(findings: readonly Finding[]): string
