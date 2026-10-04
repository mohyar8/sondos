/**
 * CSV writing for admin exports (plan 11 §3.2 #38; threat model §7.6
 * TM-13; SB-6; N-09, N-42). Pure functions: no I/O, no logging, no state.
 *
 * A spreadsheet opens a cell as a formula, a DDE call or a link when the
 * text starts with the right character, so every cell is typed:
 *
 * - csvText: a string from the database or the Worker. Neutralised by
 *   neutralizeCsvText, then quoted with `"` doubled, always, even when it
 *   holds nothing.
 * - csvInteger: a safe integer (totals, amounts), written as bare digits
 *   with no quote and no prefix, so it stays a number in every
 *   spreadsheet. It never takes a string, so customer text can never reach
 *   a numeric column; anything but a safe integer is a programming error
 *   and throws.
 *
 * neutralizeCsvText, in this order:
 * 1. Strips every control character (Cc: C0, DEL, C1, which includes TAB,
 *    CR and LF), every format character (Cf: the bidi marks, embeddings,
 *    overrides and isolates such as U+202E, the zero-width space, joiners,
 *    U+2060, U+FEFF, the soft hyphen, tag characters) and the line and
 *    paragraph separators U+2028/U+2029, and any lone surrogate. None of
 *    them belongs in a spreadsheet cell, and each can hide or reorder what
 *    the admin reads.
 * 2. Prefixes a `'` when the value started with TAB or CR, or when its
 *    first non-space character, after step 1, is a formula starter:
 *    `= + - @ |`, or any character that NFKC folds to one of them (the
 *    full-width ＝ ＋ － ＠ ｜ U+FF1D, U+FF0B, U+FF0D, U+FF20, U+FF5C, and the
 *    small forms ﹦ ﹢ ﹣ ﹫), because some applications fold before they
 *    parse. Step 1 runs first so a zero-width or bidi character in front of
 *    `=` cannot hide it.
 *
 * buildCsvDocument writes the UTF-8 BOM (Excel and Numbers then read the
 * Arabic text as UTF-8), a header row and CRLF line ends, the line end
 * after the last row included.
 */

/** Written first, so spreadsheets detect UTF-8 (Arabic stays intact). */
export const CSV_BOM = '\uFEFF'

/** RFC 4180 line end. */
export const CSV_LINE_END = '\r\n'

/** The prefix that makes a spreadsheet read the cell as plain text. */
export const CSV_TEXT_PREFIX = "'"

/** Cc, Cf, lone surrogates (Cs), and the line and paragraph separators. */
const STRIPPED_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu

/** Leading whitespace, Unicode spaces included (JavaScript `\s`). */
const LEADING_SPACE = /^\s+/u

/** What the original value may start with to be prefixed even after step 1. */
const LEADING_TAB_OR_CR = /^[\t\r]/

/** ASCII formula starters; a leading character is compared after NFKC. */
const FORMULA_STARTERS: ReadonlySet<string> = new Set(['=', '+', '-', '@', '|'])

export interface CsvTextCell {
  readonly kind: 'text'
  readonly value: string
}

export interface CsvIntegerCell {
  readonly kind: 'integer'
  /** null writes an empty, unquoted cell. */
  readonly value: number | null
}

export type CsvCell = CsvTextCell | CsvIntegerCell

/** A text cell; null writes an empty quoted cell. */
export function csvText(value: string | null): CsvTextCell {
  return { kind: 'text', value: value ?? '' }
}

/** A numeric cell from a safe integer (or null for an empty cell). */
export function csvInteger(value: number | null): CsvIntegerCell {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new TypeError('CSV: a numeric cell takes a safe integer only.')
  }

  return { kind: 'integer', value }
}

/** True when the first non-space character starts a formula. */
function startsLikeFormula(cleaned: string): boolean {
  const [first] = cleaned.replace(LEADING_SPACE, '')

  return first !== undefined && FORMULA_STARTERS.has(first.normalize('NFKC'))
}

/**
 * The text a cell shows: control, format and separator characters removed
 * and, when it could start a formula, a leading `'`. Unquoted.
 */
export function neutralizeCsvText(value: string): string {
  const cleaned = value.replace(STRIPPED_CHARACTERS, '')

  return LEADING_TAB_OR_CR.test(value) || startsLikeFormula(cleaned)
    ? `${CSV_TEXT_PREFIX}${cleaned}`
    : cleaned
}

/** One cell as written to the file. */
export function formatCsvCell(cell: CsvCell): string {
  if (cell.kind === 'integer') {
    if (cell.value === null) {
      return ''
    }

    if (!Number.isSafeInteger(cell.value)) {
      throw new TypeError('CSV: a numeric cell takes a safe integer only.')
    }

    return String(cell.value)
  }

  return `"${neutralizeCsvText(cell.value).replaceAll('"', '""')}"`
}

/** One row, without its line end. */
export function formatCsvRow(cells: readonly CsvCell[]): string {
  return cells.map(formatCsvCell).join(',')
}

/**
 * The whole file: BOM, header, rows, CRLF after every line. Every row must
 * have exactly as many cells as the header (a programming error otherwise).
 */
export function buildCsvDocument(
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  if (header.length === 0) {
    throw new RangeError('CSV: the header needs at least one column.')
  }

  const lines = [formatCsvRow(header.map((name) => csvText(name)))]

  for (const row of rows) {
    if (row.length !== header.length) {
      throw new RangeError('CSV: every row needs one cell per header column.')
    }

    lines.push(formatCsvRow(row))
  }

  return `${CSV_BOM}${lines.join(CSV_LINE_END)}${CSV_LINE_END}`
}
