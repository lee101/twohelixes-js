import type { EventName, FetchLike, EventProps, PropsFor, TrackOptions, TrackerConfig, WireEvent } from './types'

export const DEFAULT_API_URL = 'https://twohelixes.com'
export const MAX_BATCH = 2000
const SESSION_MS = 30 * 60 * 1000
const CID_KEY = 'th_cid'
const SID_KEY = 'th_sid'

const rid = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '')

const ls = (key: string, value?: string): string | null => {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {}
  return null
}

export class Twohelixes {
  private readonly endpoint: string
  private readonly flushAt: number
  private readonly interval: number
  private readonly maxQueue: number
  private readonly fetcher: FetchLike
  private readonly onError?: TrackerConfig['onError']
  private readonly browser = typeof window !== 'undefined' && typeof document !== 'undefined'
  private readonly disabled: boolean
  private queue: WireEvent[] = []
  private timer?: ReturnType<typeof setTimeout>
  private chain: Promise<void> = Promise.resolve()
  private cid?: string
  private sid?: string
  private lastSeen = 0
  private anon?: string
  private userId?: string
  readonly writeKey: string

  constructor(cfg: TrackerConfig) {
    this.writeKey = cfg.writeKey
    this.endpoint = cfg.endpoint ?? (cfg.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '') + '/v1/collect'
    this.flushAt = Math.min(Math.max(cfg.flushAt ?? 20, 1), MAX_BATCH)
    this.interval = cfg.flushIntervalMs ?? (this.browser ? 2000 : 5000)
    this.maxQueue = cfg.maxQueue ?? 10000
    this.fetcher = cfg.fetch ?? ((u, i) => fetch(u, i))
    this.onError = cfg.onError
    const nav: any = typeof navigator !== 'undefined' ? navigator : {}
    this.disabled = this.browser && (cfg.respectDnt ?? true) && (nav.doNotTrack === '1' || nav.globalPrivacyControl === true)
    if (this.browser) {
      this.cid = cfg.clientId ?? ls(CID_KEY) ?? undefined
      if (!this.cid) ls(CID_KEY, (this.cid = 'c_' + rid()))
      if (!this.disabled) {
        document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.beacon())
        window.addEventListener('pagehide', () => this.beacon())
      }
    } else {
      this.cid = cfg.clientId
    }
  }

  track<E extends EventName>(event: E, props?: PropsFor<E>, opts: TrackOptions = {}): void {
    try {
      this.build(event, props, opts)
    } catch (err) {
      this.report(err, [])
    }
  }

  private build(event: string, props: EventProps | undefined, opts: TrackOptions): void {
    const ts = opts.timestamp instanceof Date ? opts.timestamp.getTime() : opts.timestamp ?? Date.now()
    const userId = opts.userId ?? this.userId
    const e: WireEvent = { event, client_id: this.clientId(opts, userId), ts }
    if (userId) e.user_id = userId
    const sid = opts.sessionId ?? this.session(ts)
    if (sid) e.session_id = sid
    if (opts.eventId) e.event_id = opts.eventId
    const url = opts.url ?? (this.browser ? location.href : undefined)
    if (url) e.page_location = url
    const ref = opts.referrer ?? (this.browser ? document.referrer : undefined)
    if (ref) e.referrer = ref
    if (props && Object.keys(props).length) e.props = props
    this.push(e)
  }

  page(arg?: string | EventProps, opts: TrackOptions = {}): void {
    typeof arg === 'string' ? this.track('page_view', undefined, { ...opts, url: arg }) : this.track('page_view', arg, opts)
  }

  identify(userId: string, traits?: Record<string, unknown>, opts: TrackOptions = {}): void {
    if (this.browser) this.userId = userId
    const ts = opts.timestamp instanceof Date ? opts.timestamp.getTime() : opts.timestamp ?? Date.now()
    this.push({ type: 'identify', event: 'identify', client_id: this.clientId(opts, userId), user_id: userId, ts, ...(traits && { traits }) })
  }

  purchase(p: { revenue: number; currency: string; plan?: string; transactionId?: string; surface?: string; [k: string]: unknown }, opts: TrackOptions = {}): void {
    const { transactionId, ...rest } = p
    this.track('purchase', { ...rest, ...(transactionId && { transaction_id: transactionId }) }, { ...opts, eventId: opts.eventId ?? transactionId })
  }

  reset(): void {
    this.userId = this.sid = this.anon = undefined
    if (this.browser) ls(CID_KEY, (this.cid = 'c_' + rid())), ls(SID_KEY, '')
    else this.cid = undefined
  }

  flush(): Promise<void> {
    this.clearTimer()
    return (this.chain = this.chain.then(async () => {
      while (this.queue.length) await this.send(this.queue.splice(0, MAX_BATCH))
    }))
  }

  async shutdown(): Promise<void> {
    await this.flush()
    this.clearTimer()
  }

  private clientId(opts: TrackOptions, userId?: string): string {
    return opts.clientId ?? this.cid ?? userId ?? (this.anon ??= 'c_' + rid())
  }

  private session(now: number): string | undefined {
    if (!this.browser) return undefined
    if (!this.sid) {
      const [id, seen] = (ls(SID_KEY) ?? '').split('.')
      if (id) (this.sid = id), (this.lastSeen = Number(seen) || 0)
    }
    if (!this.sid || now - this.lastSeen > SESSION_MS) this.sid = String(now)
    this.lastSeen = Math.max(this.lastSeen, now)
    ls(SID_KEY, `${this.sid}.${this.lastSeen}`)
    return this.sid
  }

  private push(e: WireEvent): void {
    if (this.disabled) return
    this.queue.push(e)
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue)
    if (this.queue.length >= this.flushAt) void this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.interval)
      ;(this.timer as any).unref?.()
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private body(events: WireEvent[]): string {
    return JSON.stringify({ site_id: this.writeKey, events })
  }

  private async send(events: WireEvent[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: this.body(events),
          keepalive: this.browser,
        })
        if (!res.ok) throw new Error(`twohelixes collect: HTTP ${res.status}`)
        return
      } catch (err) {
        if (this.browser || attempt > 0) return void this.report(err, events)
      }
    }
  }

  private beacon(): void {
    this.clearTimer()
    while (this.queue.length) {
      const events = this.queue.splice(0, MAX_BATCH)
      const body = this.body(events)
      let ok = false
      try {
        ok = navigator.sendBeacon?.(this.endpoint, new Blob([body], { type: 'text/plain' })) ?? false
      } catch {}
      if (!ok) void this.send(events)
    }
  }

  private report(err: unknown, events: WireEvent[]): void {
    try {
      this.onError?.(err, events)
    } catch {}
  }
}
