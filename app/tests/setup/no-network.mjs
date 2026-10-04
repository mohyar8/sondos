// W1-13 (M6): tests never reach the network. `npm test` loads this file
// (`--import`) before any test file, in the runner and in every test process,
// and it adds itself to NODE_OPTIONS so a Node child process that a test
// starts with the inherited environment is guarded too.
//
// Node 24 has no network permission flag, so the guard sits at the few doors
// every outbound connection passes through:
// - TCP and TLS (net, tls, http, https, http2, fetch, WebSocket):
//   net.Socket#connect, before any DNS lookup. Loopback hosts and local
//   sockets/pipes stay allowed for a test that serves itself.
// - UDP: every dgram send, connect and bind.
// - DNS queries: node:dns and node:dns/promises lookups and resolvers, except
//   for loopback names and IP literals.
// A blocked call throws (or rejects with) an Error whose code is
// ERR_TEST_NETWORK_BLOCKED; a test that needs a server stubs fetch instead.

import dgram from 'node:dgram'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'

export const NETWORK_BLOCKED_CODE = 'ERR_TEST_NETWORK_BLOCKED'

/** Set on net.Socket.prototype once the guard is in place (tests read it). */
export const GUARD_MARKER = Symbol.for('sundus-yar.tests.no-network')

class NetworkBlockedError extends Error {
  constructor(what) {
    super(`${what} is blocked in tests (tests/setup/no-network.mjs).`)
    this.name = 'NetworkBlockedError'
    this.code = NETWORK_BLOCKED_CODE
  }
}

const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

/** 127.0.0.0/8, ::1 (any spelling, IPv4-mapped too) and "localhost". */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') {
    return false
  }

  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase()

  if (bare === 'localhost') {
    return true
  }

  const family = net.isIP(bare)

  return family !== 0 && LOOPBACK.check(bare, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * A pipe or Unix socket path. A Windows UNC path to another machine
 * (\\server\pipe\x) is remote, so only \\.\ and \\?\ pipes count.
 */
function isLocalSocketPath(path) {
  if (typeof path !== 'string' || path === '') {
    return false
  }

  return !path.startsWith('\\\\') || /^\\\\[.?]\\/.test(path)
}

/**
 * The host (or remote pipe path) a Socket#connect call targets, or null for
 * a local socket path. net.connect() hands connect() its already normalised
 * [options, callback] array; the public overloads are (options), (path) and
 * (port[, host]).
 */
function connectHost(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]

  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string' && first.path !== '') {
      return isLocalSocketPath(first.path) ? null : first.path
    }

    return typeof first.host === 'string' && first.host !== ''
      ? first.host
      : 'localhost'
  }

  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return isLocalSocketPath(first) ? null : first
  }

  return typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost'
}

function guardSockets() {
  const originalConnect = net.Socket.prototype.connect

  net.Socket.prototype.connect = function guardedConnect(...args) {
    const host = connectHost(args)

    if (host !== null && !isLoopbackHost(host)) {
      throw new NetworkBlockedError(`A connection to ${host}`)
    }

    return Reflect.apply(originalConnect, this, args)
  }

  for (const method of ['bind', 'connect', 'send']) {
    dgram.Socket.prototype[method] = function guardedDatagram() {
      throw new NetworkBlockedError(`UDP (dgram ${method})`)
    }
  }
}

const DNS_QUERIES = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
]

/** Only `lookup` of a loopback name or IP literal stays local. */
function isLocalQuery(name, args) {
  return name === 'lookup' && isLoopbackHost(args[0])
}

function guardDns() {
  const targets = [
    { owner: dns, rejects: false },
    { owner: dns.Resolver.prototype, rejects: false },
    { owner: dnsPromises, rejects: true },
    { owner: dnsPromises.Resolver.prototype, rejects: true },
  ]

  for (const { owner, rejects } of targets) {
    for (const name of DNS_QUERIES) {
      const original = owner[name]

      if (typeof original !== 'function') {
        continue
      }

      owner[name] = function guardedQuery(...args) {
        if (isLocalQuery(name, args)) {
          return Reflect.apply(original, this, args)
        }

        const error = new NetworkBlockedError(`A DNS query (${name})`)

        if (rejects) {
          return Promise.reject(error)
        }

        throw error
      }
    }
  }
}

/** Child Node processes that inherit process.env load this guard too. */
function propagateToChildren() {
  // A file URL has no spaces (they are percent-encoded), so it needs no
  // quoting inside NODE_OPTIONS.
  const option = `--import=${import.meta.url}`
  const current = process.env.NODE_OPTIONS ?? ''

  if (!current.split(/\s+/).includes(option)) {
    process.env.NODE_OPTIONS = current === '' ? option : `${current} ${option}`
  }
}

if (net.Socket.prototype[GUARD_MARKER] !== true) {
  guardSockets()
  guardDns()
  // `import { lookup } from 'node:dns'` in a test sees the guarded function.
  syncBuiltinESMExports()
  Object.defineProperty(net.Socket.prototype, GUARD_MARKER, { value: true })
  propagateToChildren()
}
