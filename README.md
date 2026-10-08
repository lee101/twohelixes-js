# twohelixes

Tiny, zero-dependency TypeScript client for [twoHelixes](https://twohelixes.com) product analytics: event tracking for the browser, Node and Bun, plus a typed reporting client (summary, funnels, paths, revenue, natural-language queries).

## Install

```sh
bun add github:lee101/twohelixes-js
# or, once published
bun add twohelixes
npm i twohelixes
```

Two credentials: the write key (`thw_...`) is public and ships in browser JS; the API key (`th_...`) is secret and only used server-side for reporting.

## Browser

```ts
import { Twohelixes } from 'twohelixes'

const th = new Twohelixes({ writeKey: 'thw_xxx' })

th.page()
th.track('paywall_open', { surface: 'export_button', plan: 'pro' })
th.identify('user_42', { plan: 'free' })
th.reset() // on logout: forget user, rotate client id
```

- Anonymous client id persisted in `localStorage` (`th_cid`); session id rotates after 30 min inactivity.
- `page_location` and `referrer` are filled from `location` / `document`.
- Events batch (20 events or 2s), and the queue is flushed with `navigator.sendBeacon` on `visibilitychange`/`pagehide`.
- Honors `navigator.doNotTrack === '1'` and Global Privacy Control (disable with `respectDnt: false`).

## Node / Bun server

```ts
import { Twohelixes } from 'twohelixes'

const th = new Twohelixes({ writeKey: process.env.TWOHELIXES_WRITE_KEY! })

th.track('sign_up_completed', { method: 'google', surface: 'hero_cta' }, { userId: 'user_42', clientId: req.cookies.th_cid })
th.purchase({ revenue: 19, currency: 'USD', plan: 'pro', transactionId: 'ord_991', surface: 'quota_banner' }, { userId: 'user_42' })

await th.shutdown()
```

On the server nothing is stored and `identify()` is not sticky (one instance serves many users): pass `userId` / `clientId` per call. `clientId` falls back to `userId`, then a random per-instance id. Failed batches are retried once and then reported to `onError`; `track()` never throws.

## Canonical SaaS funnel

Use the canonical names (typed as `CanonicalEvent`, also available as `Events.*`) and carry the same `surface` from paywall through purchase so funnels can answer "which placement converts".

```ts
th.track('signup_view', { surface: 'pricing_page' })
th.track('sign_up_started', { method: 'google', surface: 'pricing_page' })
th.track('sign_up_completed', { method: 'google', surface: 'pricing_page' })
th.identify(user.id)

th.track('paywall_open', { surface: 'quota_banner', plan: 'pro' })
th.track('begin_checkout', { plan: 'pro', value: 19, currency: 'USD', surface: 'quota_banner' })

// server, from the payment webhook; event_id = transaction id dedupes retries
th.purchase({ revenue: 19, currency: 'USD', plan: 'pro', transactionId: session.id, surface: 'quota_banner' }, { userId: user.id })
```

`revenue` is in major units (`19.0`, not cents). Other events: `sign_in_started`, `sign_in_completed`, `paywall_signup_clicked`, `refund`.

## Reporting

```ts
import { TwohelixesReports, TwohelixesApiError } from 'twohelixes'

const r = new TwohelixesReports({ apiKey: process.env.TWOHELIXES_API_KEY! })
const { sites } = await r.sites()
const site = sites[0].id

await r.summary(site, { days: 30 })
await r.revenue(site, { days: 30 })
await r.paths(site, { mode: 'events', start: 'paywall_open', depth: 6 })

const funnel = await r.funnel(site, ['page_view:/signup', 'sign_up_started', 'sign_up_completed|sign_in_completed', 'paywall_open', 'begin_checkout', 'purchase'], { days: 30 })

const answer = await r.ask(site, 'which surfaces open the paywall most and which convert?', { days: 30 })
```

Funnel steps are passed through verbatim (`page_view:/signup` restricts to a path, `a|b` matches either event). Methods: `sites`, `summary`, `timeseries`, `events`, `schema`, `paths`, `revenue`, `funnel`, `exportBatch`, `ask`. Non-2xx responses throw `TwohelixesApiError` with `status`, `code`, `detail`.

## Agents / MCP

Query your analytics from Claude Code and other MCP clients with [twohelixes-cli](https://github.com/lee101/twohelixes-cli):

```sh
claude mcp add twohelixes -- twohelixes-cli mcp
```

API reference: [twohelixes.com](https://twohelixes.com).

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

## License

MIT
