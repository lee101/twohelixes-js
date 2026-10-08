import { afterEach, expect, test } from 'bun:test'
import { Twohelixes, type WireEvent } from '../src'

type Call = { url: string; init: RequestInit; body: { site_id: string; events: WireEvent[] } }

const fake = (status = 204) => {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(init.body as string) })
    return new Response(null, { status })
  })
  return { calls, fetch }
}

test('batches at flushAt with correct payload shape', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch, flushAt: 3, apiUrl: 'https://example.test/' })
  th.track('page_view', undefined, { clientId: 'c_1', url: 'https://a.test/x' })
  th.track('paywall_open', { surface: 'export_button' }, { clientId: 'c_1', timestamp: new Date(1759900000000) })
  expect(f.calls.length).toBe(0)
  th.track('custom_thing', { a: 1 }, { clientId: 'c_1', sessionId: 's1' })
  await th.flush()
  expect(f.calls.length).toBe(1)
  const { url, init, body } = f.calls[0]
  expect(url).toBe('https://example.test/v1/collect')
  expect(init.method).toBe('POST')
  expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain;charset=UTF-8')
  expect(body.site_id).toBe('thw_xxx')
  expect(body.events.map((e) => e.event)).toEqual(['page_view', 'paywall_open', 'custom_thing'])
  expect(body.events[0]).toMatchObject({ client_id: 'c_1', page_location: 'https://a.test/x' })
  expect(body.events[1]).toMatchObject({ ts: 1759900000000, props: { surface: 'export_button' } })
  expect(body.events[2]).toMatchObject({ session_id: 's1', props: { a: 1 } })
  expect(typeof body.events[0].ts).toBe('number')
  expect(body.events[0].ts).toBeGreaterThan(1e12)
})

test('chunks more than 2000 events per request', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch, flushAt: 100000, maxQueue: 100000, clientId: 'c_1' })
  for (let i = 0; i < 4500; i++) th.track('e', { i })
  await th.flush()
  expect(f.calls.map((c) => c.body.events.length)).toEqual([2000, 2000, 500])
  expect(f.calls[2].body.events[499].props).toEqual({ i: 4499 })
})

test('maxQueue drops oldest', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch, flushAt: 1000, maxQueue: 5, clientId: 'c' })
  for (let i = 0; i < 8; i++) th.track('e', { i })
  await th.shutdown()
  expect(f.calls[0].body.events.map((e) => e.props?.i)).toEqual([3, 4, 5, 6, 7])
})

test('identify, purchase event_id, server client id fallback, reset', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch })
  const u = { userId: 'user_42' }
  th.track('page_view')
  th.identify('user_42', { plan: 'pro' })
  th.track('sign_up_completed', { method: 'google', surface: 'hero_cta' }, u)
  th.purchase({ revenue: 19, currency: 'USD', plan: 'pro', transactionId: 'ord_991', surface: 'quota_banner' }, u)
  th.reset()
  th.track('x', undefined, { userId: 'u_9' })
  await th.shutdown()
  const ev = f.calls.flatMap((c) => c.body.events)
  const anon = ev[0].client_id
  expect(anon).toMatch(/^c_/)
  expect(ev[0].user_id).toBeUndefined()
  expect(ev[1]).toMatchObject({ type: 'identify', event: 'identify', client_id: 'user_42', user_id: 'user_42', traits: { plan: 'pro' } })
  expect(ev[2]).toMatchObject({ user_id: 'user_42', props: { method: 'google', surface: 'hero_cta' } })
  expect(ev[3]).toMatchObject({
    event: 'purchase',
    user_id: 'user_42',
    event_id: 'ord_991',
    props: { revenue: 19, currency: 'USD', plan: 'pro', transaction_id: 'ord_991', surface: 'quota_banner' },
  })
  expect(ev[3].props).not.toHaveProperty('transactionId')
  expect(ev[4]).toMatchObject({ client_id: 'u_9', user_id: 'u_9' })
  expect(ev.every((e) => e.session_id === undefined && e.page_location === undefined)).toBe(true)
})

test('server identify does not leak userId onto later events', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch })
  th.identify('user_a')
  th.track('page_view', undefined, { clientId: 'c_b' })
  th.track('x')
  await th.shutdown()
  const ev = f.calls[0].body.events
  expect(ev[0]).toMatchObject({ type: 'identify', user_id: 'user_a', client_id: 'user_a' })
  expect(ev[1].user_id).toBeUndefined()
  expect(ev[2].user_id).toBeUndefined()
  expect(ev[2].client_id).not.toBe('user_a')
})

test('shutdown flushes pending timer queue', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch, flushIntervalMs: 60_000, clientId: 'c' })
  th.track('a')
  th.track('b')
  expect(f.calls.length).toBe(0)
  await th.shutdown()
  expect(f.calls[0].body.events.length).toBe(2)
})

test('timer flushes after interval', async () => {
  const f = fake()
  const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch, flushIntervalMs: 10, clientId: 'c' })
  th.track('a')
  await Bun.sleep(40)
  expect(f.calls.length).toBe(1)
})

test('track never throws when fetch rejects; server retries once then onError', async () => {
  let attempts = 0
  const errors: unknown[] = []
  const th = new Twohelixes({
    writeKey: 'thw_xxx',
    clientId: 'c',
    fetch: (async () => {
      attempts++
      throw new Error('network down')
    }),
    onError: (e, events) => errors.push([e, events.length]),
  })
  expect(() => th.track('a')).not.toThrow()
  await th.flush()
  expect(attempts).toBe(2)
  expect(errors.length).toBe(1)
  expect((errors[0] as [Error, number])[0].message).toBe('network down')
  expect((errors[0] as [Error, number])[1]).toBe(1)
})

test('non-2xx reported via onError, retry succeeds silently', async () => {
  const statuses = [500, 204]
  const errors: unknown[] = []
  const th = new Twohelixes({
    writeKey: 'thw_xxx',
    clientId: 'c',
    fetch: (async () => new Response(null, { status: statuses.shift() ?? 413 })),
    onError: (e) => errors.push(e),
  })
  th.track('a')
  await th.flush()
  expect(errors.length).toBe(0)
  th.track('b')
  await th.flush()
  expect(errors.length).toBe(1)
  expect(String(errors[0])).toContain('413')
})

test('real HTTP round trip via Bun.serve', async () => {
  const got: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ path: new URL(req.url).pathname, ct: req.headers.get('content-type'), body: JSON.parse(await req.text()) })
      return new Response(null, { status: 204 })
    },
  })
  try {
    const th = new Twohelixes({ writeKey: 'thw_xxx', apiUrl: `http://localhost:${server.port}`, clientId: 'c_srv' })
    th.track('begin_checkout', { plan: 'pro', value: 19, currency: 'USD', surface: 'pricing_page' })
    await th.shutdown()
    expect(got).toEqual([
      {
        path: '/v1/collect',
        ct: 'text/plain;charset=UTF-8',
        body: { site_id: 'thw_xxx', events: [expect.objectContaining({ event: 'begin_checkout', client_id: 'c_srv' })] },
      },
    ])
  } finally {
    server.stop(true)
  }
})

describeBrowser()

function describeBrowser() {
  const g = globalThis as any
  const saved = { window: g.window, document: g.document, location: g.location, localStorage: g.localStorage }
  const setup = (extraNav: Record<string, unknown> = {}) => {
    const store = new Map<string, string>()
    const listeners: Record<string, () => void> = {}
    const doc = { referrer: 'https://ref.test/', visibilityState: 'visible', addEventListener: (k: string, fn: () => void) => (listeners[k] = fn) }
    g.document = doc
    g.window = { addEventListener: (k: string, fn: () => void) => (listeners[k] = fn) }
    g.location = { href: 'https://app.test/signup' }
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) }
    const beacons: { url: string; blob: Blob }[] = []
    const nav = navigator as any
    const prev: Record<string, unknown> = {}
    for (const [k, v] of Object.entries({ sendBeacon: (url: string, blob: Blob) => (beacons.push({ url, blob }), true), ...extraNav })) {
      prev[k] = nav[k]
      Object.defineProperty(nav, k, { value: v, configurable: true, writable: true })
    }
    return { store, listeners, doc, beacons, restoreNav: () => Object.entries(prev).forEach(([k, v]) => Object.defineProperty(nav, k, { value: v, configurable: true, writable: true })) }
  }
  let restoreNav = () => {}
  afterEach(() => {
    Object.assign(g, saved)
    restoreNav()
  })

  test('browser: persists th_cid, session id, page_location/referrer, beacon on hidden', async () => {
    const env = setup()
    restoreNav = env.restoreNav
    const f = fake()
    const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch })
    const cid = env.store.get('th_cid')
    expect(cid).toMatch(/^c_/)
    th.page()
    th.track('signup_view', { surface: 'nav' })
    env.doc.visibilityState = 'hidden'
    env.listeners.visibilitychange()
    expect(f.calls.length).toBe(0)
    expect(env.beacons.length).toBe(1)
    expect(env.beacons[0].url).toBe('https://twohelixes.com/v1/collect')
    expect(env.beacons[0].blob.type).toStartWith('text/plain')
    const body = JSON.parse(await env.beacons[0].blob.text())
    expect(body.events[0]).toMatchObject({ event: 'page_view', client_id: cid, page_location: 'https://app.test/signup', referrer: 'https://ref.test/' })
    expect(body.events[0].session_id).toMatch(/^\d{13}$/)
    expect(body.events[1].session_id).toBe(body.events[0].session_id)
    expect(new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch })['cid']).toBe(cid!)
    th.identify('user_42')
    th.track('after')
    await th.shutdown()
    expect(f.calls[0].body.events.map((e) => e.user_id)).toEqual(['user_42', 'user_42'])
    th.reset()
    expect(env.store.get('th_cid')).not.toBe(cid)
    th.track('anon')
    await th.shutdown()
    expect(f.calls[1].body.events[0].user_id).toBeUndefined()
    expect(f.calls[1].body.events[0].client_id).toBe(env.store.get('th_cid')!)
  })

  test('browser: session rotates after 30 min inactivity', async () => {
    restoreNav = setup().restoreNav
    const f = fake()
    const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch })
    const t0 = 1759900000000
    th.track('a', undefined, { timestamp: t0 })
    th.track('b', undefined, { timestamp: t0 + 29 * 60_000 })
    th.track('c', undefined, { timestamp: t0 + 29 * 60_000 + 31 * 60_000 })
    await th.shutdown()
    const ev = f.calls[0].body.events
    expect(ev[0].session_id).toBe(String(t0))
    expect(ev[1].session_id).toBe(String(t0))
    expect(ev[2].session_id).toBe(String(t0 + 60 * 60_000))
    expect(f.calls[0].init.keepalive).toBe(true)
  })

  test('browser: respects doNotTrack and globalPrivacyControl', async () => {
    for (const nav of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
      restoreNav = setup(nav).restoreNav
      const f = fake()
      const th = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch })
      th.track('a')
      await th.shutdown()
      expect(f.calls.length).toBe(0)
      const on = new Twohelixes({ writeKey: 'thw_xxx', fetch: f.fetch, respectDnt: false })
      on.track('a')
      await on.shutdown()
      expect(f.calls.length).toBe(1)
      restoreNav()
    }
  })
}
