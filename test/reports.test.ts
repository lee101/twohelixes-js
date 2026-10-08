import { expect, test } from 'bun:test'
import { TwohelixesApiError, TwohelixesReports } from '../src'

const fake = (status = 200, payload: unknown = { ok: true }) => {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init })
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status })
  })
  return { calls, fetch }
}

test('sends bearer header and builds analytics urls', async () => {
  const f = fake(200, { sites: [{ id: 's1' }] })
  const r = new TwohelixesReports({ apiKey: 'th_xxx', fetch: f.fetch })
  expect((await r.sites()).sites[0].id).toBe('s1')
  await r.summary('s1', { days: 30 })
  await r.timeseries('s1')
  await r.events('s1', { limit: 50 })
  await r.schema('s1', { days: 30, event: 'purchase' })
  await r.paths('s1', { mode: 'events', start: 'paywall_open', depth: 6, limit: 10 })
  await r.revenue('s1', { days: 7 })
  await r.exportBatch('s1', { days: 1 })
  const urls = f.calls.map((c) => c.url.pathname + c.url.search)
  expect(urls).toEqual([
    '/v1/analytics/sites',
    '/v1/analytics/summary?site_id=s1&days=30',
    '/v1/analytics/timeseries?site_id=s1',
    '/v1/analytics/events?site_id=s1&limit=50',
    '/v1/analytics/schema?site_id=s1&days=30&event=purchase',
    '/v1/analytics/paths?site_id=s1&mode=events&start=paywall_open&depth=6&limit=10',
    '/v1/analytics/revenue?site_id=s1&days=7',
    '/v1/analytics/export?site_id=s1&days=1',
  ])
  for (const c of f.calls) {
    expect(c.url.origin).toBe('https://twohelixes.com')
    expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer th_xxx')
    expect(c.init.method).toBe('GET')
  }
})

test('funnel steps pass through verbatim, URL-encoded', async () => {
  const f = fake(200, { steps: [] })
  const r = new TwohelixesReports({ apiKey: 'th_xxx', apiUrl: 'http://localhost:9/', fetch: f.fetch })
  const steps = 'page_view:/signup,sign_up_completed|sign_in_completed'
  await r.funnel('s1', steps, { days: 14 })
  await r.funnel('s1', ['page_view:/signup', 'sign_up_completed|sign_in_completed'])
  for (const c of f.calls) {
    expect(c.url.origin + c.url.pathname).toBe('http://localhost:9/v1/analytics/funnel')
    expect(c.url.searchParams.get('steps')).toBe(steps)
    expect(c.url.search).toContain('steps=page_view%3A%2Fsignup%2Csign_up_completed%7Csign_in_completed')
  }
  expect(f.calls[0].url.searchParams.get('days')).toBe('14')
})

test('ask posts natural language query', async () => {
  const f = fake(200, { answer: 'hero_cta' })
  const r = new TwohelixesReports({ apiKey: 'th_xxx', fetch: f.fetch })
  expect((await r.ask('s1', 'which surfaces convert?', { days: 30 })).answer).toBe('hero_cta')
  const c = f.calls[0]
  expect(c.url.toString()).toBe('https://twohelixes.com/v1/query')
  expect(c.init.method).toBe('POST')
  expect((c.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  expect(JSON.parse(c.init.body as string)).toEqual({ q: 'which surfaces convert?', analytics_site_id: 's1', days: 30 })
})

test('maps errors to TwohelixesApiError', async () => {
  const cases: [number, unknown, string, string | undefined][] = [
    [403, { error: 'forbidden', detail: 'key does not own site' }, 'forbidden', 'key does not own site'],
    [400, { error: 'bad_request', message: 'days out of range' }, 'bad_request', 'days out of range'],
    [502, 'upstream exploded', 'http_502', 'upstream exploded'],
  ]
  for (const [status, payload, code, detail] of cases) {
    const r = new TwohelixesReports({ apiKey: 'th_xxx', fetch: fake(status, payload).fetch })
    const err = await r.summary('s1').catch((e) => e)
    expect(err).toBeInstanceOf(TwohelixesApiError)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ status, code, detail })
  }
})

test('works against Bun.serve', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      req.headers.get('authorization') === 'Bearer th_xxx'
        ? Response.json({ path: new URL(req.url).pathname, days: new URL(req.url).searchParams.get('days') })
        : Response.json({ error: 'unauthorized' }, { status: 401 }),
  })
  try {
    const ok = new TwohelixesReports({ apiKey: 'th_xxx', apiUrl: `http://localhost:${server.port}` })
    expect(await ok.revenue('s1', { days: 30 })).toEqual({ path: '/v1/analytics/revenue', days: '30' })
    const bad = new TwohelixesReports({ apiKey: 'th_nope', apiUrl: `http://localhost:${server.port}` })
    expect(await bad.sites().catch((e) => e.code)).toBe('unauthorized')
  } finally {
    server.stop(true)
  }
})
