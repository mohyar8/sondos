// W1-10 / M2 (N-59): Riyadh "today", the start of a Riyadh day and Riyadh
// wall-clock times as instants, plus the timing constants. Every case below
// fails if its control (the Asia/Riyadh date instead of the UTC date, the
// offset, the read-back check, a constant) is taken out of shared/timing.ts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { toAsciiDigits } from '../shared/text.ts'
import {
  ADMIN_SESSION_MAX_HOURS,
  BOOKING_HORIZON_DAYS,
  HOLD_GRACE_HOURS,
  RECENT_SIGN_IN_SECONDS,
  SETTINGS_DELAY_HOURS,
  addDaysToDateKey,
  isValidLocalTime,
  latestBookableDateKey,
  riyadhDateKey,
  riyadhHour,
  riyadhLocalToInstant,
  riyadhStartOfDay,
  riyadhTodayKey,
} from '../shared/timing.ts'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

describe('timing constants', () => {
  test('match the plan', () => {
    assert.equal(BOOKING_HORIZON_DAYS, 730)
    assert.equal(HOLD_GRACE_HOURS, 72)
    assert.equal(ADMIN_SESSION_MAX_HOURS, 12)
    assert.equal(RECENT_SIGN_IN_SECONDS, 600)
    assert.equal(SETTINGS_DELAY_HOURS, 24)
  })
})

describe('riyadhTodayKey (M2, N-59)', () => {
  test('21:00-23:59 Riyadh is still the same Riyadh (and UTC) date', () => {
    for (const instant of [
      '2026-09-29T18:00:00.000Z',
      '2026-09-29T19:30:00.000Z',
      '2026-09-29T20:59:59.999Z',
    ]) {
      assert.equal(riyadhTodayKey(new Date(instant)), '2026-09-29', instant)
    }
  })

  test('from 00:00 Riyadh (21:00 UTC) it is the next date while UTC is not', () => {
    for (const instant of [
      '2026-09-29T21:00:00.000Z',
      '2026-09-29T22:30:00.000Z',
      '2026-09-29T23:59:59.999Z',
    ]) {
      const now = new Date(instant)
      assert.equal(now.toISOString().slice(0, 10), '2026-09-29')
      assert.equal(riyadhTodayKey(now), '2026-09-30', instant)
    }

    assert.equal(riyadhTodayKey(new Date('2026-09-30T00:00:00.000Z')), '2026-09-30')
  })

  test('every quarter hour across the UTC evening follows Riyadh = UTC+3', () => {
    const start = Date.parse('2026-09-29T17:00:00.000Z')

    for (let minutes = 0; minutes <= 8 * 60; minutes += 15) {
      const now = new Date(start + minutes * MINUTE_MS)
      const expected = new Date(now.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10)
      assert.equal(riyadhTodayKey(now), expected, now.toISOString())
      assert.equal(riyadhDateKey(now), expected, now.toISOString())
      assert.equal(riyadhHour(now), (now.getUTCHours() + 3) % 24, now.toISOString())
    }
  })

  test('crosses month, year and leap-day boundaries at 21:00 UTC', () => {
    assert.equal(riyadhTodayKey(new Date('2026-09-30T21:00:00.000Z')), '2026-10-01')
    assert.equal(riyadhTodayKey(new Date('2026-12-31T20:59:59.999Z')), '2026-12-31')
    assert.equal(riyadhTodayKey(new Date('2026-12-31T21:00:00.000Z')), '2027-01-01')
    assert.equal(riyadhTodayKey(new Date('2028-02-28T21:00:00.000Z')), '2028-02-29')
  })

  test('the booking horizon counts from the Riyadh date', () => {
    assert.equal(latestBookableDateKey(new Date('2026-09-29T20:59:59.999Z')), '2028-09-28')
    assert.equal(latestBookableDateKey(new Date('2026-09-29T21:00:00.000Z')), '2028-09-29')
  })

  test('does not depend on the process time zone', () => {
    const previous = process.env.TZ

    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
        process.env.TZ = zone
        assert.equal(riyadhTodayKey(new Date('2026-09-29T21:00:00.000Z')), '2026-09-30', zone)
        assert.equal(riyadhStartOfDay('2026-09-30'), '2026-09-29T21:00:00.000Z', zone)
      }
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })
})

describe('riyadhStartOfDay', () => {
  test('is 21:00 UTC the day before', () => {
    assert.equal(riyadhStartOfDay('2026-09-30'), '2026-09-29T21:00:00.000Z')
    assert.equal(riyadhStartOfDay('2027-01-01'), '2026-12-31T21:00:00.000Z')
    assert.equal(riyadhStartOfDay('2028-02-29'), '2028-02-28T21:00:00.000Z')
    assert.equal(riyadhStartOfDay('2026-03-01'), '2026-02-28T21:00:00.000Z')
  })

  test('opens the Riyadh date: one millisecond earlier is the day before', () => {
    let dateKey = '2026-01-01'

    for (let day = 0; day < 800; day += 1) {
      const start = riyadhStartOfDay(dateKey)
      assert.notEqual(start, null, dateKey)
      const startMs = Date.parse(start)
      assert.equal(riyadhTodayKey(new Date(startMs)), dateKey)
      assert.equal(riyadhTodayKey(new Date(startMs - 1)), addDaysToDateKey(dateKey, -1))
      dateKey = addDaysToDateKey(dateKey, 1)
    }
  })

  test('is null for an invalid date key', () => {
    for (const value of ['2026-02-30', '2027-02-29', '2026-9-30', '2026-13-01', '', '2026-09-30T00:00', '٢٠٢٦-٠٩-٣٠']) {
      assert.equal(riyadhStartOfDay(value), null, value)
    }
  })
})

describe('riyadhLocalToInstant', () => {
  test('converts Riyadh wall-clock times to UTC instants', () => {
    assert.equal(riyadhLocalToInstant('2026-10-01', '16:00'), '2026-10-01T13:00:00.000Z')
    assert.equal(riyadhLocalToInstant('2026-10-01', '00:00'), '2026-09-30T21:00:00.000Z')
    assert.equal(riyadhLocalToInstant('2026-10-01', '02:59'), '2026-09-30T23:59:00.000Z')
    assert.equal(riyadhLocalToInstant('2026-10-01', '03:00'), '2026-10-01T00:00:00.000Z')
    assert.equal(riyadhLocalToInstant('2026-10-01', '21:00'), '2026-10-01T18:00:00.000Z')
    assert.equal(riyadhLocalToInstant('2026-10-01', '23:59'), '2026-10-01T20:59:00.000Z')
  })

  test('round-trips through riyadhTodayKey for evening slots', () => {
    for (const time of ['21:00', '21:30', '22:15', '23:45', '23:59']) {
      const instant = riyadhLocalToInstant('2026-10-01', time)
      assert.equal(riyadhTodayKey(new Date(instant)), '2026-10-01', time)
    }
  })

  test('accepts Arabic-Indic times once toAsciiDigits has run (UX-07, N-55)', () => {
    assert.equal(riyadhLocalToInstant('2026-10-01', '١٦:٣٠'), null)
    assert.equal(
      riyadhLocalToInstant(toAsciiDigits('٢٠٢٦-١٠-٠١'), toAsciiDigits('١٦:٣٠')),
      '2026-10-01T13:30:00.000Z',
    )
    assert.equal(riyadhLocalToInstant('2026-10-01', toAsciiDigits('۰۹:۰۵')), '2026-10-01T06:05:00.000Z')
  })

  test('fails closed when the time-zone data contradicts itself', () => {
    // A zone whose offset moves from +3 to +4 at 14:30Z on 2026-10-01, as a
    // wrong or daylight-saving database would: 16:00 local cannot be placed
    // consistently, so no instant is returned instead of a slot an hour off.
    const switchAt = Date.parse('2026-10-01T14:30:00.000Z')
    const original = Intl.DateTimeFormat.prototype.formatToParts

    Intl.DateTimeFormat.prototype.formatToParts = function (date) {
      const ms = date instanceof Date ? date.getTime() : Number(date)
      const wall = new Date(ms + (ms < switchAt ? 3 : 4) * HOUR_MS).toISOString()
      return [
        { type: 'year', value: wall.slice(0, 4) },
        { type: 'literal', value: '-' },
        { type: 'month', value: wall.slice(5, 7) },
        { type: 'literal', value: '-' },
        { type: 'day', value: wall.slice(8, 10) },
        { type: 'literal', value: ', ' },
        { type: 'hour', value: wall.slice(11, 13) },
        { type: 'literal', value: ':' },
        { type: 'minute', value: wall.slice(14, 16) },
        { type: 'literal', value: ':' },
        { type: 'second', value: wall.slice(17, 19) },
      ]
    }

    try {
      assert.equal(riyadhLocalToInstant('2026-10-01', '16:00'), null)
      assert.equal(riyadhLocalToInstant('2026-10-01', '10:00'), '2026-10-01T07:00:00.000Z')
      assert.equal(riyadhLocalToInstant('2026-10-01', '20:00'), '2026-10-01T16:00:00.000Z')
    } finally {
      Intl.DateTimeFormat.prototype.formatToParts = original
    }

    assert.equal(riyadhLocalToInstant('2026-10-01', '16:00'), '2026-10-01T13:00:00.000Z')
  })

  test('is null for an invalid time or date', () => {
    for (const time of ['24:00', '7:30', '07:60', '07:30:00', ' 07:30', '07:30 ', '0730', '', '-1:00', '07:3O']) {
      assert.equal(isValidLocalTime(time), false, time)
      assert.equal(riyadhLocalToInstant('2026-10-01', time), null, time)
    }

    assert.equal(riyadhLocalToInstant('2026-02-30', '10:00'), null)
    assert.equal(isValidLocalTime('00:00'), true)
    assert.equal(isValidLocalTime('23:59'), true)
  })
})
