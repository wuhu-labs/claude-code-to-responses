// Subscription usage as Claude Code reports it (`rate_limit_event`), and what the gateway makes of it: a 429 that says
// when the limit resets, and the `codex.rate_limits` WebSocket event Wuhu's kernel puts on its usage board.
// Measured on 2.1.284 against the fake endpoint (probe/probe_test.ts, "rate_limit_event …").
import { GatewayError } from './errors.ts'

// deno-lint-ignore no-explicit-any
type Json = any

/** The longest Retry-After the gateway sends, for every limit type (weekly included): one request an hour at most. */
export const MAX_RETRY_AFTER_SECONDS = 3600

/** The kernel's window lengths: the 5-hour window is `primary`, the weekly one `secondary`. */
export const PRIMARY_WINDOW_MINUTES = 300
export const SECONDARY_WINDOW_MINUTES = 10080

export interface UsageWindow {
  /** Fraction of the window used; above 1 when usage legitimately ran past the cap (Claude Code's own schema). */
  utilization: number
  /** Unix epoch seconds. */
  resetsAt: number
}

/** The part of 2.1.284's `rate_limit_info` the gateway reads. Everything else in the frame is left alone. */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt: number | null
  rateLimitType: string | null
  windows: Record<string, UsageWindow>
}

const WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_overage_included: 10080,
}

const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected'])
/** 2.1.284's `rateLimitType` enum. */
const LIMIT_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage'])

export class RateLimitShapeError extends Error {}

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function window(w: Json, name: string): UsageWindow {
  if (typeof w !== 'object' || w === null) throw new RateLimitShapeError(`unifiedWindows.${name} is not an object`)
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization) || w.utilization < 0) {
    throw new RateLimitShapeError(`unifiedWindows.${name}.utilization is not a finite non-negative number`)
  }
  if (!isEpoch(w.resetsAt)) throw new RateLimitShapeError(`unifiedWindows.${name}.resetsAt is not epoch seconds`)
  return { utilization: w.utilization, resetsAt: w.resetsAt }
}

/**
 * Reads a `rate_limit_event` frame. A shape 2.1.284 does not produce is a RateLimitShapeError, never a guess: the
 * lane turns it into the typed `unexpected_rate_limit_event`.
 */
export function parseRateLimitEvent(frame: Json): RateLimitInfo {
  const info = frame?.rate_limit_info
  if (typeof info !== 'object' || info === null || Array.isArray(info)) throw new RateLimitShapeError('rate_limit_info is not an object')
  if (!STATUSES.has(info.status)) throw new RateLimitShapeError(`unknown status ${JSON.stringify(info.status)}`)
  if (info.resetsAt !== undefined && !isEpoch(info.resetsAt)) throw new RateLimitShapeError('resetsAt is not epoch seconds')
  if (info.rateLimitType !== undefined && !LIMIT_TYPES.has(info.rateLimitType)) {
    throw new RateLimitShapeError(`unknown rateLimitType ${JSON.stringify(info.rateLimitType)}`)
  }
  const w = info.unifiedWindows
  if (w !== undefined && (typeof w !== 'object' || w === null || Array.isArray(w))) throw new RateLimitShapeError('unifiedWindows is not an object')
  const windows: Record<string, UsageWindow> = {}
  for (const [name, value] of Object.entries(w ?? {})) {
    if (!Object.hasOwn(WINDOW_MINUTES, name)) throw new RateLimitShapeError(`unknown window ${JSON.stringify(name)}`)
    windows[name] = window(value, name)
  }
  return {
    status: info.status,
    resetsAt: info.resetsAt ?? null,
    rateLimitType: info.rateLimitType ?? null,
    windows,
  }
}

function kernelWindow(w: UsageWindow, minutes: number): Json {
  // the kernel takes 0...100; a window used past its cap is full
  return { used_percent: Math.min(100, w.utilization * 100), window_minutes: minutes, reset_at: w.resetsAt }
}

/**
 * The `codex.rate_limits` event for one report, or null when Claude Code reported no window. Only reported windows are
 * sent under their Claude names in `windows`, with `five_hour` also as `primary`, `seven_day` as `secondary`. Claude Code reports no plan, so there is no
 * `plan_type`.
 */
export function codexRateLimits(info: RateLimitInfo): Json | null {
  const rateLimits: Json = {}
  if (info.windows.five_hour) rateLimits.primary = kernelWindow(info.windows.five_hour, PRIMARY_WINDOW_MINUTES)
  if (info.windows.seven_day) rateLimits.secondary = kernelWindow(info.windows.seven_day, SECONDARY_WINDOW_MINUTES)
  if (!Object.keys(info.windows).length) return null
  rateLimits.windows = Object.fromEntries(Object.entries(info.windows).map(([name, w]) => [name, kernelWindow(w, WINDOW_MINUTES[name])]))
  return { type: 'codex.rate_limits', rate_limits: rateLimits }
}

/** Seconds until `resetsAt`, rounded up, within 0...MAX_RETRY_AFTER_SECONDS. */
export function retryAfterSeconds(resetsAt: number, nowMs = Date.now()): number {
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(resetsAt - nowMs / 1000)))
}

/**
 * A backend 429. With Claude Code's latest report saying `rejected` with a reset time, it is the subscription's usage
 * limit: `usage_limit_reached`, the limit type and exact reset in the body, and a capped `Retry-After`. Otherwise it
 * stays `rate_limit_exceeded`, without `Retry-After`: Claude Code 2.1.284 surfaces no backend `retry-after` (probed).
 */
export function rateLimitError(text: string, latest: RateLimitInfo | null, nowMs = Date.now()): GatewayError {
  if (latest?.status === 'rejected' && latest.resetsAt !== null) {
    const retryAfter = retryAfterSeconds(latest.resetsAt, nowMs)
    return new GatewayError(
      429,
      'server_error',
      'usage_limit_reached',
      `The subscription's usage limit (${latest.rateLimitType ?? 'type not reported'}) is reached until ${
        new Date(latest.resetsAt * 1000).toISOString()
      }: ${text}`,
      null,
      { extra: { limit_type: latest.rateLimitType, resets_at: latest.resetsAt }, headers: { 'retry-after': String(retryAfter) } },
    )
  }
  return new GatewayError(429, 'server_error', 'rate_limit_exceeded', text)
}

/** The error codes a response refused before any output becomes a request-level 429 for. */
export const REQUEST_LEVEL_429 = new Set(['usage_limit_reached', 'rate_limit_exceeded'])
