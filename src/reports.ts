import { DEFAULT_API_URL } from './tracker'
import type {
  AskResponse, EventsResponse, FetchLike, ExportResponse, FunnelResponse, PathsResponse, ReportsConfig, RevenueResponse,
  SchemaResponse, SitesResponse, SummaryResponse, TimeseriesResponse,
} from './types'

type Query = Record<string, string | number | undefined>
export interface DaysOpts { days?: number }

export class TwohelixesApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(`twohelixes ${status} ${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'TwohelixesApiError'
  }
}

export class TwohelixesReports {
  private readonly apiUrl: string
  private readonly fetcher: FetchLike

  constructor(private readonly cfg: ReportsConfig) {
    this.apiUrl = (cfg.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
    this.fetcher = cfg.fetch ?? ((u, i) => fetch(u, i))
  }

  sites = () => this.get<SitesResponse>('sites')
  summary = (siteId: string, o: DaysOpts = {}) => this.get<SummaryResponse>('summary', { site_id: siteId, ...o })
  timeseries = (siteId: string, o: DaysOpts = {}) => this.get<TimeseriesResponse>('timeseries', { site_id: siteId, ...o })
  events = (siteId: string, o: DaysOpts & { limit?: number } = {}) => this.get<EventsResponse>('events', { site_id: siteId, ...o })
  schema = (siteId: string, o: DaysOpts & { event?: string } = {}) => this.get<SchemaResponse>('schema', { site_id: siteId, ...o })
  paths = (siteId: string, o: DaysOpts & { mode?: 'both' | 'events' | 'pages'; start?: string; depth?: number; limit?: number } = {}) =>
    this.get<PathsResponse>('paths', { site_id: siteId, ...o })
  revenue = (siteId: string, o: DaysOpts = {}) => this.get<RevenueResponse>('revenue', { site_id: siteId, ...o })
  funnel = (siteId: string, steps: string | string[], o: DaysOpts = {}) =>
    this.get<FunnelResponse>('funnel', { site_id: siteId, steps: Array.isArray(steps) ? steps.join(',') : steps, ...o })
  exportBatch = (siteId: string, o: DaysOpts & { limit?: number } = {}) => this.get<ExportResponse>('export', { site_id: siteId, ...o })
  ask = (siteId: string, question: string, o: DaysOpts = {}) =>
    this.request<AskResponse>('/v1/query', {}, { q: question, analytics_site_id: siteId, ...o })

  private get<T>(name: string, q: Query = {}): Promise<T> {
    return this.request<T>(`/v1/analytics/${name}`, q)
  }

  private async request<T>(path: string, q: Query, body?: unknown): Promise<T> {
    const url = new URL(this.apiUrl + path)
    for (const [k, v] of Object.entries(q)) if (v !== undefined) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await this.fetcher(url.toString(), { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let data: any
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = undefined
    }
    if (!res.ok) throw new TwohelixesApiError(res.status, data?.error ?? `http_${res.status}`, data?.detail ?? data?.message ?? (data ? undefined : text.slice(0, 500)))
    if (data === undefined) throw new TwohelixesApiError(res.status, 'invalid_json', text.slice(0, 500))
    return data as T
  }
}
