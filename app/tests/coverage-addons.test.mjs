import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isBookingPackageSnapshot, validateBookingSelection } from '../shared/booking.ts'

const base = {
  coverageId: 'four-hours',
  albumEnabled: false,
  albumSizeId: 'small',
  photoCount: 30,
  albumPageCount: 10,
  albumBoxId: 'normal',
  printQuantities: { a6: 0, a5: 0, a4: 0 },
  magazineQuantity: 0,
  magazinePageCount: 1,
  woodenEnlargementQuantity: 0,
}

describe('coverage add-ons (owner, 2026-10-01)', () => {
  test('coverage prices are the owner\'s new prices', () => {
    const totals = ['two-hours', 'four-hours', 'six-hours', 'eight-hours'].map((coverageId) => {
      const result = validateBookingSelection({ ...base, coverageId })
      assert.ok(result.ok)
      return result.estimatedTotal
    })
    assert.deepEqual(totals, [1450, 3000, 4500, 6100])
  })

  test('both add-ons are priced by the server and listed as extras', () => {
    const result = validateBookingSelection({ ...base, mobileCoverage: true, secondCamera: true })
    assert.ok(result.ok)
    assert.equal(result.estimatedTotal, 3000 + 200 + 500)
    assert.equal(result.snapshot.calculation.coverageAddons, 700)
    assert.deepEqual(
      result.snapshot.extras.map((extra) => [extra.kind, extra.id, extra.subtotal]),
      [['coverage_addon', 'mobile-bts', 200], ['coverage_addon', 'second-camera', 500]],
    )
    assert.ok(isBookingPackageSnapshot(result.snapshot))
  })

  test('the add-on keys are optional and default to off', () => {
    const result = validateBookingSelection(base)
    assert.ok(result.ok)
    assert.equal(result.selection.mobileCoverage, false)
    assert.equal(result.selection.secondCamera, false)
    assert.equal(result.snapshot.calculation.coverageAddons, 0)
  })

  test('non-boolean add-on values and unknown keys are refused', () => {
    assert.equal(validateBookingSelection({ ...base, mobileCoverage: 'yes' }).ok, false)
    assert.equal(validateBookingSelection({ ...base, secondCamera: 1 }).ok, false)
    assert.equal(validateBookingSelection({ ...base, droneCoverage: true }).ok, false)
  })

  test('a snapshot stored before the add-ons existed is still valid', () => {
    const result = validateBookingSelection(base)
    assert.ok(result.ok)
    const legacy = structuredClone(result.snapshot)
    delete legacy.calculation.coverageAddons
    assert.ok(isBookingPackageSnapshot(legacy))
  })

  test('a tampered add-on price in a stored snapshot is rejected', () => {
    const result = validateBookingSelection({ ...base, secondCamera: true })
    assert.ok(result.ok)
    const tampered = structuredClone(result.snapshot)
    tampered.extras[0].unitPrice = 1
    assert.equal(isBookingPackageSnapshot(tampered), false)
  })
})
