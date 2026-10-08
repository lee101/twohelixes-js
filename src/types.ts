export const Events = {
  PageView: 'page_view',
  SignupView: 'signup_view',
  SignUpStarted: 'sign_up_started',
  SignUpCompleted: 'sign_up_completed',
  SignInStarted: 'sign_in_started',
  SignInCompleted: 'sign_in_completed',
  PaywallOpen: 'paywall_open',
  PaywallSignupClicked: 'paywall_signup_clicked',
  BeginCheckout: 'begin_checkout',
  Purchase: 'purchase',
  Refund: 'refund',
} as const

export type CanonicalEvent = 'page_view' | 'signup_view' | 'sign_up_started' | 'sign_up_completed' | 'sign_in_started' | 'sign_in_completed' | 'paywall_open' | 'paywall_signup_clicked' | 'begin_checkout' | 'purchase' | 'refund'

export type EventName = CanonicalEvent | (string & {})

export interface EventProps {
  /** UI location that triggered the step (hero_cta, nav, export_button, quota_banner, pricing_page, settings). Carry it from paywall_open through begin_checkout and purchase. */
  surface?: string
  method?: string
  plan?: string
  [key: string]: unknown
}

export interface CheckoutProps extends EventProps {
  value?: number
  currency?: string
}

export interface PurchaseProps extends EventProps {
  /** Major units (19.0, not cents). */
  revenue: number
  currency: string
  transaction_id?: string
}

export type PropsFor<E> = E extends 'purchase' | 'refund' ? PurchaseProps : E extends 'begin_checkout' ? CheckoutProps : EventProps

export interface TrackOptions {
  userId?: string
  clientId?: string
  sessionId?: string
  eventId?: string
  timestamp?: Date | number
  url?: string
  referrer?: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface TrackerConfig {
  writeKey: string
  apiUrl?: string
  endpoint?: string
  flushAt?: number
  flushIntervalMs?: number
  maxQueue?: number
  fetch?: FetchLike
  clientId?: string
  respectDnt?: boolean
  onError?: (error: unknown, events: WireEvent[]) => void
}

export interface WireEvent {
  event: string
  client_id: string
  ts: number
  type?: 'identify'
  user_id?: string
  session_id?: string
  event_id?: string
  page_location?: string
  referrer?: string
  props?: Record<string, unknown>
  traits?: Record<string, unknown>
}

export interface ReportsConfig {
  apiKey: string
  apiUrl?: string
  fetch?: FetchLike
}

type Loose = { [key: string]: unknown }

export interface Site extends Loose { id: string; domain?: string; name?: string; write_key?: string }
export interface SitesResponse extends Loose { sites: Site[] }
export interface SummaryResponse extends Loose {}
export interface TimeseriesResponse extends Loose {}
export interface EventsResponse extends Loose { events?: Loose[] }
export interface SchemaResponse extends Loose {}
export interface PathsResponse extends Loose {}
export interface RevenueResponse extends Loose {}
export interface FunnelStep extends Loose { event?: string; sessions?: number; users?: number }
export interface FunnelResponse extends Loose { steps?: FunnelStep[] }
export interface ExportResponse extends Loose { batch?: Loose[] }
export interface AskResponse extends Loose {}
