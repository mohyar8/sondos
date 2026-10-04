// W1-08 / TM-07, SB-18: the idle timer behind useAuth().startIdleSignOut.
// Each case fails if its control is taken out of startIdleTimer
// (src/auth/auth-context.ts): the quiet-period limit, pointerdown/keydown as
// the only activity, the wall-clock check when the tab becomes visible again
// (a device that slept), the retry while she stays idle, the new quiet
// period a sign-in starts (restart), the clean stop, and the activity
// shared between the app's tabs (a fixed word, no data). decideIdleSignOut
// and the provider wiring below tie each sign-out to the session that
// stayed idle, so a later sign-in is never ended for it.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { decideIdleSignOut, startIdleTimer } from '../src/auth/auth-context.ts'

const MINUTE = 60_000
const IDLE_MS = 30 * MINUTE

/** A document stand-in that counts its listeners. */
class CountingTarget extends EventTarget {
  listeners = 0

  addEventListener(type, listener, options) {
    this.listeners += 1
    super.addEventListener(type, listener, options)
  }

  removeEventListener(type, listener, options) {
    this.listeners -= 1
    super.removeEventListener(type, listener, options)
  }
}

function useFakeClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
}

describe('startIdleTimer', () => {
  test('calls onIdle once the limit passes with no activity, not before', (t) => {
    useFakeClock(t)
    let idleCalls = 0
    const timer = startIdleTimer({
      target: new EventTarget(),
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    t.mock.timers.tick(IDLE_MS - 1)
    assert.equal(idleCalls, 0)
    t.mock.timers.tick(1)
    assert.equal(idleCalls, 1)
    timer.stop()
  })

  test('a press or a key stroke starts a new quiet period', (t) => {
    useFakeClock(t)
    const target = new EventTarget()
    let idleCalls = 0
    const timer = startIdleTimer({
      target,
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    t.mock.timers.tick(20 * MINUTE)
    target.dispatchEvent(new Event('pointerdown'))
    t.mock.timers.tick(20 * MINUTE)
    target.dispatchEvent(new Event('keydown'))
    t.mock.timers.tick(IDLE_MS - 1)
    assert.equal(idleCalls, 0)
    t.mock.timers.tick(1)
    assert.equal(idleCalls, 1)
    timer.stop()
  })

  test('only pointerdown and keydown count as activity', (t) => {
    useFakeClock(t)
    const target = new EventTarget()
    let idleCalls = 0
    const timer = startIdleTimer({
      target,
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    t.mock.timers.tick(20 * MINUTE)
    for (const type of ['mousemove', 'scroll', 'focus', 'message']) {
      target.dispatchEvent(new Event(type))
    }
    t.mock.timers.tick(10 * MINUTE)
    assert.equal(idleCalls, 1)
    timer.stop()
  })

  test('a device that slept past the limit is idle as soon as the tab shows again', (t) => {
    useFakeClock(t)
    const target = new EventTarget()
    let idleCalls = 0
    const timer = startIdleTimer({
      target,
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    // The wall clock moves on while no timer ran (a suspended device).
    t.mock.timers.setTime(Date.now() + IDLE_MS + 5 * MINUTE)
    assert.equal(idleCalls, 0)
    target.dispatchEvent(new Event('visibilitychange'))
    assert.equal(idleCalls, 1)
    timer.stop()
  })

  test('keeps calling onIdle every minute while she stays idle, until activity', (t) => {
    useFakeClock(t)
    const target = new EventTarget()
    let idleCalls = 0
    const timer = startIdleTimer({
      target,
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    t.mock.timers.tick(IDLE_MS)
    t.mock.timers.tick(MINUTE)
    t.mock.timers.tick(MINUTE)
    assert.equal(idleCalls, 3)

    target.dispatchEvent(new Event('pointerdown'))
    t.mock.timers.tick(IDLE_MS - 1)
    assert.equal(idleCalls, 3)
    t.mock.timers.tick(1)
    assert.equal(idleCalls, 4)
    timer.stop()
  })

  test('a sign-in after an idle sign-out starts a new quiet period (restart)', (t) => {
    useFakeClock(t)
    let idleCalls = 0
    const timer = startIdleTimer({
      target: new EventTarget(),
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    // Idle: the provider signs her out.
    t.mock.timers.tick(IDLE_MS)
    assert.equal(idleCalls, 1)

    // Five minutes later (one re-check a minute) she signs in from another
    // tab, with no press or key stroke in this one: the listener's report
    // restarts the timer.
    for (let minute = 0; minute < 5; minute += 1) {
      t.mock.timers.tick(MINUTE)
    }
    assert.equal(idleCalls, 6)
    timer.restart()

    // The new session is never ended for the quiet time before it.
    t.mock.timers.tick(IDLE_MS - 1)
    assert.equal(idleCalls, 6)
    t.mock.timers.tick(1)
    assert.equal(idleCalls, 7)
    timer.stop()
  })

  test('restart after stop arms nothing', (t) => {
    useFakeClock(t)
    const target = new CountingTarget()
    let idleCalls = 0
    const timer = startIdleTimer({
      target,
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    timer.stop()
    timer.restart()
    t.mock.timers.tick(10 * IDLE_MS)
    assert.equal(idleCalls, 0)
    assert.equal(target.listeners, 0)
  })

  test('stop removes every listener and the timer', (t) => {
    useFakeClock(t)
    const target = new CountingTarget()
    let idleCalls = 0
    const timer = startIdleTimer({
      target,
      idleMs: IDLE_MS,
      onIdle: () => (idleCalls += 1),
      shareAcrossTabs: false,
    })

    assert.ok(target.listeners > 0)
    timer.stop()
    timer.stop()
    assert.equal(target.listeners, 0)
    t.mock.timers.tick(10 * IDLE_MS)
    target.dispatchEvent(new Event('visibilitychange'))
    assert.equal(idleCalls, 0)
  })

  test('refuses a limit that is not positive or that setTimeout cannot wait for', () => {
    // 2^31 ms and more would fire at once and spin the re-check.
    for (const idleMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      assert.throws(
        () =>
          startIdleTimer({
            target: new EventTarget(),
            idleMs,
            onIdle: () => {},
            shareAcrossTabs: false,
          }),
        RangeError,
      )
    }
  })

  test('activity in one tab keeps the other tabs from signing out; the message carries no data', async (t) => {
    useFakeClock(t)
    const observer = new BroadcastChannel('sy:idle-activity')
    const messages = []
    let delivered = () => {}

    observer.addEventListener('message', (event) => {
      messages.push(event.data)
      delivered()
    })

    const activeTab = new EventTarget()
    let activeTabIdle = 0
    let quietTabIdle = 0
    const activeTimer = startIdleTimer({
      target: activeTab,
      idleMs: IDLE_MS,
      onIdle: () => (activeTabIdle += 1),
    })
    const quietTimer = startIdleTimer({
      target: new EventTarget(),
      idleMs: IDLE_MS,
      onIdle: () => (quietTabIdle += 1),
    })

    try {
      t.mock.timers.tick(20 * MINUTE)

      const arrived = new Promise((resolve) => {
        delivered = resolve
      })

      activeTab.dispatchEvent(new Event('pointerdown'))
      // A second press within 30 s sends nothing more (throttled).
      activeTab.dispatchEvent(new Event('keydown'))
      await arrived
      // Let every channel in this thread receive it.
      await nextTurn()
      await nextTurn()

      t.mock.timers.tick(IDLE_MS - 1)
      assert.equal(activeTabIdle, 0)
      assert.equal(quietTabIdle, 0)
      t.mock.timers.tick(1)
      assert.equal(activeTabIdle, 1)
      assert.equal(quietTabIdle, 1)
      assert.deepEqual(messages, ['activity'])
    } finally {
      activeTimer.stop()
      quietTimer.stop()
      observer.close()
    }
  })
})

const SIGNED_IN = { uid: 'admin-uid', signedInAt: 'Tue, 29 Sep 2026 06:00:00 GMT' }
const SIGNED_IN_AGAIN = {
  uid: 'admin-uid',
  signedInAt: 'Tue, 29 Sep 2026 07:10:00 GMT',
}

describe('decideIdleSignOut', () => {
  test('signs out only the session that stayed idle', () => {
    assert.equal(decideIdleSignOut(SIGNED_IN, { ...SIGNED_IN }), 'sign-out')
    // Unknown sign-in time on both sides: still the same session.
    assert.equal(
      decideIdleSignOut(
        { uid: 'admin-uid', signedInAt: null },
        { uid: 'admin-uid', signedInAt: null },
      ),
      'sign-out',
    )
  })

  test('nobody signed in, or a sign-in not reported yet: nothing to end', () => {
    assert.equal(decideIdleSignOut(null, SIGNED_IN), 'skip')
    assert.equal(decideIdleSignOut(null, null), 'skip')
    // Signed out after the idle limit; she signs in from another tab and
    // this tab's listener has not reported it yet.
    assert.equal(decideIdleSignOut(SIGNED_IN_AGAIN, null), 'skip')
    assert.equal(
      decideIdleSignOut({ uid: 'other-uid', signedInAt: null }, SIGNED_IN),
      'skip',
    )
  })

  test('the same account signed in again since: a new quiet period', () => {
    assert.equal(decideIdleSignOut(SIGNED_IN_AGAIN, SIGNED_IN), 'restart')
  })
})

/**
 * The provider's idle sign-out (AuthContext signOutAfterInactivity and its
 * auth-state listener) around one timer, with the Firebase session as plain
 * state: `current` is who is signed in, `reported` what the listener last
 * reported.
 */
function idleProvider(t) {
  const state = { current: SIGNED_IN, reported: SIGNED_IN, signOuts: 0 }
  const timer = startIdleTimer({
    target: new EventTarget(),
    idleMs: IDLE_MS,
    onIdle: () => {
      const decision = decideIdleSignOut(state.current, state.reported)

      if (decision === 'restart') {
        state.reported = state.current
        timer.restart()
      } else if (decision === 'sign-out') {
        state.current = null
        state.reported = null
        state.signOuts += 1
      }
    },
    shareAcrossTabs: false,
  })

  t.after(() => timer.stop())

  return {
    state,
    /** The auth-state listener reports a sign-in. */
    report(session) {
      state.reported = session
      timer.restart()
    },
  }
}

describe('idle sign-out and a later sign-in', () => {
  test('a sign-in after an idle sign-out, with no activity in this tab, is not signed out', (t) => {
    useFakeClock(t)
    const { state, report } = idleProvider(t)

    t.mock.timers.tick(IDLE_MS)
    assert.equal(state.signOuts, 1)

    // Three minutes later she signs in from another tab. Until this tab's
    // listener reports it, the minute re-checks leave it alone.
    t.mock.timers.tick(3 * MINUTE)
    state.current = SIGNED_IN_AGAIN
    t.mock.timers.tick(2 * MINUTE)
    assert.equal(state.current, SIGNED_IN_AGAIN)
    report(SIGNED_IN_AGAIN)

    for (let minute = 0; minute < 29; minute += 1) {
      t.mock.timers.tick(MINUTE)
    }
    assert.equal(state.current, SIGNED_IN_AGAIN)
    assert.equal(state.signOuts, 1)

    // Idle for her whole new limit: that session ends, not before.
    t.mock.timers.tick(MINUTE)
    assert.equal(state.current, null)
    assert.equal(state.signOuts, 2)
  })

  test('the same account signed in again without a listener report gets a full quiet period', (t) => {
    useFakeClock(t)
    const { state } = idleProvider(t)

    // A background tab, 25 minutes quiet, misses the sign-out and sign-in
    // she did in another tab: Firebase keeps the account and updates its
    // sign-in time, so the listener reports nothing.
    t.mock.timers.tick(25 * MINUTE)
    state.current = SIGNED_IN_AGAIN

    t.mock.timers.tick(5 * MINUTE)
    assert.equal(state.current, SIGNED_IN_AGAIN)
    assert.equal(state.reported, SIGNED_IN_AGAIN)

    t.mock.timers.tick(IDLE_MS - 1)
    assert.equal(state.signOuts, 0)
    t.mock.timers.tick(1)
    assert.equal(state.signOuts, 1)
  })

  test('the provider wires it: listener reports restart the timers; onIdle decides by session', async () => {
    const provider = await readFile(
      new URL('../src/auth/AuthContext.tsx', import.meta.url),
      'utf8',
    )

    // The listener records the reported session and restarts every timer.
    assert.match(
      provider,
      /idleSessionRef\.current = nextUser\s*\?\s*describeIdleSession\(nextUser\)\s*:\s*null/,
    )
    assert.match(
      provider,
      /if \(nextUser\) \{[^}]*restartIdleTimers\(idleTimersRef\.current\)/,
    )
    // The sign-out is decided against that session, never on currentUser
    // alone: a restart or a skip returns before it.
    assert.match(
      provider,
      /const signOutAfterInactivity = useCallback\(async[\s\S]*?decideIdleSignOut\(current, idleSessionRef\.current\)\s*if \(decision === 'restart'\) \{[^}]*restartIdleTimers\(idleTimersRef\.current\)\s*return\s*\}\s*if \(decision === 'skip'\) \{\s*return\s*\}\s*await resources\.sdk\.signOut\(resources\.auth\)/,
    )
  })
})
