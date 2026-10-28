// Subscription usage: a backend 429 that says when the limit resets, and `codex.rate_limits` on the WebSocket.
// Claude Code reports usage (`rate_limit_event`) only with a subscription token, so these runs use a fake OAuth token
// against the fake endpoint (probe/probe_test.ts pins what 2.1.284 makes of each response).
import { assert, assertEquals, assertThrows } from '@std/assert'
import {
  codexRateLimits,
  MAX_RETRY_AFTER_SECONDS,
  parseRateLimitEvent,
  rateLimitError,
  type RateLimitInfo,
  RateLimitShapeError,
  retryAfterSeconds,
  UsageLedger,
} from '../src/usage.ts'
import { call, type Json, type Reply, text } from './fake.ts'
import { cleanup, dirs, TestGateway, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'
import type { WsClient } from './websocket_client.ts'

const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
const now = () => Math.floor(Date.now() / 1000)
const unified = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [`anthropic-ratelimit-unified-${k}`, v]))
const LIMITED = { status: 429, type: 'rate_limit_error', message: "This request would exceed your account's rate limit. Please try again later." }

/** Runs with a subscription token: the only backend Claude Code reports usage for. */
class UsageRun extends Run {
  override backend(): Record<string, string> {
    return { ANTHROPIC_BASE_URL: this.fake.url, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake-usage-test' }
  }
}

/**
 * `codexSocketUsage` from Wuhu's kernel (SpaceServer/Sources/ProviderUsage.swift), as its contract reads: a window
 * needs `window_minutes` an Int > 0, `used_percent` a Double in 0...100 and `reset_at` epoch seconds; `plan_type` is an
 * optional String. Strict here: a window the kernel would drop is a failure, not an omission.
 */
function kernelParse(event: Json): { primary?: Json; secondary?: Json; plan?: string } {
  assertEquals(event.type, 'codex.rate_limits')
  const rl = event.rate_limits
  assert(typeof rl === 'object' && rl !== null, 'rate_limits is an object')
  const out: { primary?: Json; secondary?: Json; plan?: string } = {}
  for (const name of ['primary', 'secondary'] as const) {
    const w = rl[name]
    if (w === undefined) continue
    assert(Number.isInteger(w.window_minutes) && w.window_minutes > 0, `${name}.window_minutes ${w.window_minutes}`)
    assert(
      typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) && w.used_percent >= 0 && w.used_percent <= 100,
      `${name}.used_percent ${w.used_percent}`,
    )
    assert(typeof w.reset_at === 'number' && Number.isFinite(w.reset_at), `${name}.reset_at ${w.reset_at}`)
    out[name] = w
  }
  if (event.plan_type !== undefined) {
    assertEquals(typeof event.plan_type, 'string')
    out.plan = event.plan_type
  }
  return out
}

// ---- units -------------------------------------------------------------------------------------------

Deno.test('rate_limit_event: the shapes 2.1.284 produces parse; anything else is a RateLimitShapeError', () => {
  assertEquals(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false } }), {
    status: 'allowed',
    resetsAt: null,
    rateLimitType: null,
    windows: {},
  })
  const full = parseRateLimitEvent({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: 1760000000,
      rateLimitType: 'seven_day_opus',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: 1759990000 },
        seven_day: { utilization: 1.07, resetsAt: 1760000000 },
        seven_day_overage_included: { utilization: 0.6, resetsAt: 1760000000 },
      },
    },
  })
  assertEquals(full, {
    status: 'rejected',
    resetsAt: 1760000000,
    rateLimitType: 'seven_day_opus',
    windows: {
      five_hour: { utilization: 0.25, resetsAt: 1759990000 },
      seven_day: { utilization: 1.07, resetsAt: 1760000000 },
      seven_day_overage_included: { utilization: 0.6, resetsAt: 1760000000 },
    },
  })
  for (
    const info of [
      undefined,
      [],
      { status: 'throttled' },
      { status: 'rejected', resetsAt: '1760000000' },
      { status: 'rejected', resetsAt: 1.5 },
      { status: 'rejected', rateLimitType: 'monthly' },
      { status: 'allowed', unifiedWindows: [] },
      { status: 'allowed', unifiedWindows: { five_hour: { utilization: '0.2', resetsAt: 1 } } },
      { status: 'allowed', unifiedWindows: { five_hour: { utilization: -0.1, resetsAt: 1 } } },
      { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.1 } } },
      { status: 'allowed', unifiedWindows: { seven_day_overage_included: null } },
      { status: 'allowed', unifiedWindows: { unknown: { utilization: 0, resetsAt: 1 } } },
      { status: 'allowed', unifiedWindows: { overage: { utilization: -1, resetsAt: 1 } } },
      { status: 'allowed', unifiedWindows: { seven_day_opus: { utilization: 0, resetsAt: 1 } } },
    ]
  ) {
    assertThrows(() => parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: info }), RateLimitShapeError, undefined, JSON.stringify(info))
  }
})

Deno.test('codex.rate_limits: five_hour is primary (300), seven_day secondary (10080); unreported windows are omitted', () => {
  assertEquals(codexRateLimits({}), null)
  const both = codexRateLimits({ five_hour: { utilization: 0.25, resetsAt: 1759990000 }, seven_day: { utilization: 1.07, resetsAt: 1760000000 } })
  assertEquals(both, {
    type: 'codex.rate_limits',
    rate_limits: {
      primary: { used_percent: 25, window_minutes: 300, reset_at: 1759990000 },
      // used past its cap: full, within the kernel's 0...100
      secondary: { used_percent: 100, window_minutes: 10080, reset_at: 1760000000 },
      windows: {
        five_hour: { used_percent: 25, window_minutes: 300, reset_at: 1759990000 },
        seven_day: { used_percent: 100, window_minutes: 10080, reset_at: 1760000000 },
      },
    },
  })
  const p = kernelParse(both)
  assertEquals([p.primary?.window_minutes, p.secondary?.window_minutes, p.plan], [300, 10080, undefined])
  const five = codexRateLimits({ five_hour: { utilization: 0, resetsAt: 1759990000 } })
  assertEquals(Object.keys(kernelParse(five)), ['primary'])
  assertEquals(five.rate_limits.secondary, undefined)
  const seven = codexRateLimits({ seven_day: { utilization: 0.5, resetsAt: 1760000000 } })
  assertEquals(Object.keys(kernelParse(seven)), ['secondary'])
  assertEquals(seven.rate_limits.primary, undefined)
})

Deno.test('codex.rate_limits: model-only windows survive without primary or secondary', () => {
  const event = codexRateLimits(
    parseRateLimitEvent({
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          seven_day_overage_included: { utilization: 1.07, resetsAt: 1760000000 },
          overage: { utilization: 0.2, resetsAt: 1760000000 },
        },
      },
    }).windows,
  )
  assertEquals(event, {
    type: 'codex.rate_limits',
    rate_limits: {
      windows: {
        seven_day_overage_included: { used_percent: 100, window_minutes: 10080, reset_at: 1760000000 },
      },
    },
  })
})

Deno.test('codex.rate_limits: a credit-only overage report is validated but has no timed event', () => {
  const info = parseRateLimitEvent({
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        overage: { utilization: 0.2, resetsAt: 1760000000 },
      },
    },
  })
  assertEquals(info.windows, { overage: { utilization: 0.2, resetsAt: 1760000000 } })
  assertEquals(codexRateLimits(info.windows), null)
})

const report = (w: Record<string, [number, number]>): Json => {
  const window = ([used, reset]: [number, number], minutes: number) => ({ used_percent: used, window_minutes: minutes, reset_at: reset })
  return {
    type: 'codex.rate_limits',
    rate_limits: {
      primary: window(w.five_hour, 300),
      secondary: window(w.seven_day, 10080),
      windows: {
        five_hour: window(w.five_hour, 300),
        seven_day: window(w.seven_day, 10080),
        seven_day_overage_included: window(w.seven_day_overage_included, 10080),
      },
    },
  }
}

Deno.test('the usage ledger: windows merge by name, survive a reload, and a passed reset reads as an unused window', () => {
  const dir = Deno.makeTempDirSync()
  const path = `${dir}/usage.json`
  const t = 1_760_000_000, ms = t * 1000
  const reported = (windows: RateLimitInfo['windows']): RateLimitInfo => ({ status: 'allowed', resetsAt: null, rateLimitType: null, windows })
  try {
    const ledger = new UsageLedger(path)
    assertEquals(ledger.report(ms), report({ five_hour: [0, t + 300 * 60], seven_day: [0, t + 10080 * 60], seven_day_overage_included: [0, t + 10080 * 60] }))
    ledger.record(reported({}))
    assertThrows(() => Deno.statSync(path), Deno.errors.NotFound)
    ledger.record(reported({ five_hour: { utilization: 0.25, resetsAt: t + 600 }, seven_day: { utilization: 0.5, resetsAt: t + 86400 } }))
    ledger.record(reported({ seven_day_overage_included: { utilization: 1.2, resetsAt: t + 86400 }, overage: { utilization: 0.1, resetsAt: t + 86400 } }))
    const held = report({ five_hour: [25, t + 600], seven_day: [50, t + 86400], seven_day_overage_included: [100, t + 86400] })
    assertEquals(ledger.report(ms), held)
    const reloaded = new UsageLedger(path)
    assertEquals(reloaded.report(ms), held)
    const later = t + 601
    assertEquals(
      reloaded.report(later * 1000),
      report({ five_hour: [0, later + 300 * 60], seven_day: [50, t + 86400], seven_day_overage_included: [100, t + 86400] }),
    )
    reloaded.record(reported({ five_hour: { utilization: 0.05, resetsAt: later + 3600 } }))
    assertEquals(
      new UsageLedger(path).report(later * 1000),
      report({ five_hour: [5, later + 3600], seven_day: [50, t + 86400], seven_day_overage_included: [100, t + 86400] }),
    )
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('the usage ledger: a file it cannot read starts it empty', () => {
  const dir = Deno.makeTempDirSync()
  const path = `${dir}/usage.json`
  const empty = report({ five_hour: [0, 1_760_018_000], seven_day: [0, 1_760_604_800], seven_day_overage_included: [0, 1_760_604_800] })
  try {
    for (const text of ['{', '[]', '{"five_hour":{"utilization":-1,"resetsAt":1760000600}}', '{"hourly":{"utilization":0.5,"resetsAt":1760000600}}']) {
      Deno.writeTextFileSync(path, text)
      assertEquals(new UsageLedger(path).report(1_760_000_000_000), empty, text)
    }
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('the 429 mapping: a reported reset is usage_limit_reached with a capped Retry-After; none stays rate_limit_exceeded', () => {
  const t = 1_760_000_000_000
  assertEquals(retryAfterSeconds(1_760_000_600, t), 600)
  assertEquals(retryAfterSeconds(1_760_000_000.2, t), 1) // rounded up: never early
  assertEquals(retryAfterSeconds(1_759_999_000, t), 0)
  assertEquals(retryAfterSeconds(1_760_604_800, t), MAX_RETRY_AFTER_SECONDS)
  const rejected = (w: Partial<RateLimitInfo>): RateLimitInfo => ({
    status: 'rejected',
    resetsAt: null,
    rateLimitType: 'five_hour',
    windows: {},
    ...w,
  })
  const e = rateLimitError("You've hit your session limit", rejected({ resetsAt: 1_760_000_600 }), t)
  assertEquals([e.status, e.code, e.headers], [429, 'usage_limit_reached', { 'retry-after': '600' }])
  const body: Json = e.toJSON().error
  assertEquals([body.limit_type, body.resets_at], ['five_hour', 1_760_000_600])
  assertEquals<Json>(e.toResponseError(), {
    code: 'usage_limit_reached',
    message: e.message,
    limit_type: 'five_hour',
    resets_at: 1_760_000_600,
    status: 429,
    headers: { 'retry-after': '600' },
  })
  assertEquals(rateLimitError('x', rejected({ resetsAt: 1_760_604_800, rateLimitType: 'seven_day' }), t).headers, { 'retry-after': '3600' })
  for (const latest of [null, rejected({}), { ...rejected({ resetsAt: 1_760_000_600 }), status: 'allowed' as const }]) {
    const r = rateLimitError('API Error: Server is temporarily limiting requests', latest, t)
    assertEquals([r.status, r.code, r.headers, Object.keys(r.toJSON().error)], [429, 'rate_limit_exceeded', {}, ['message', 'type', 'param', 'code']])
  }
})

// ---- the gateway -------------------------------------------------------------------------------------

async function sse(run: Run, input: string): Promise<{ status: number; headers: Headers; body: Json; events: Json[] }> {
  const res = await fetch(`${run.tg.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, input, stream: true }),
  })
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, headers: res.headers, body: await res.json(), events: [] }
  const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  return { status: res.status, headers: res.headers, body: null, events }
}

/** One create on the socket: every event up to the terminal one or the error event. */
async function wsCreate(ws: WsClient, input: string): Promise<Json[]> {
  await ws.opened
  ws.socket.send(JSON.stringify({ type: 'response.create', ...base, input }))
  const events: Json[] = []
  while (true) {
    const ev = await ws.next()
    events.push(ev)
    if (['error', 'response.completed', 'response.failed', 'response.incomplete'].includes(ev.type)) return events
  }
}

const limit = (reset: number, claim: string, windows: Record<string, string> = {}): Reply => ({
  blocks: [text('never')],
  error: LIMITED,
  headers: unified({ status: 'rejected', reset: String(reset), 'representative-claim': claim, ...windows }),
})

for (const transport of ['sse', 'websocket'] as const) {
  Deno.test(`${transport}: a usage limit with a reset is 429 usage_limit_reached, Retry-After to the reset, the type and reset in the body`, async () => {
    const run = new UsageRun(`usage-limit-${transport}`, false)
    await run.run(async () => {
      const reset = now() + 600
      run.fake.reply(limit(reset, 'five_hour', { '5h-utilization': '1', '5h-reset': String(reset) }))
      let status: number, retryAfter: string | null, error: Json, events: Json[] = []
      const ws = transport === 'websocket' ? run.tg.websocket() : null
      if (!ws) {
        const r = await sse(run, 'over the limit')
        ;[status, retryAfter, error] = [r.status, r.headers.get('retry-after'), r.body.error]
      } else {
        events = await wsCreate(ws, 'over the limit')
        const e = events.at(-1)
        assertEquals(e.type, 'error')
        ;[status, retryAfter, error] = [e.status, e.headers['retry-after'], e.error]
      }
      assertEquals(status, 429)
      const seconds = Number(retryAfter)
      assert(seconds >= 595 && seconds <= 600, `Retry-After ${retryAfter}`)
      assertEquals([error.code, error.type, error.limit_type, error.resets_at], ['usage_limit_reached', 'server_error', 'five_hour', reset])
      assert(error.message.includes("You've hit your session limit"), error.message)
      if (transport === 'websocket') {
        // refused as a request: nothing of the response went out, only the usage report before the error
        assertEquals(events.map((e) => e.type), ['codex.rate_limits', 'error'])
        assertEquals(kernelParse(events[0]).primary, { used_percent: 100, window_minutes: 300, reset_at: reset })
      }
      // nothing is answered from memory: the next request goes to the backend, and works once it does (on the same socket)
      run.fake.reply({ blocks: [text('back')] })
      const next = ws ? (await wsCreate(ws, 'again')).at(-1) : (await sse(run, 'again')).events.at(-1)
      assertEquals(next.type, 'response.completed')
      assertEquals(run.fake.main().length, 2)
    })
  })

  Deno.test(`${transport}: Retry-After is capped at an hour (a weekly limit days away)`, async () => {
    const run = new UsageRun(`usage-cap-${transport}`, false)
    await run.run(async () => {
      const reset = now() + 4 * 86400
      run.fake.reply(limit(reset, 'seven_day', { '7d-utilization': '1', '7d-reset': String(reset) }))
      if (transport === 'sse') {
        const r = await sse(run, 'weekly')
        assertEquals([r.status, r.headers.get('retry-after'), r.body.error.code, r.body.error.limit_type, r.body.error.resets_at], [
          429,
          '3600',
          'usage_limit_reached',
          'seven_day',
          reset,
        ])
      } else {
        const e = (await wsCreate(run.tg.websocket(), 'weekly')).at(-1)
        assertEquals([e.type, e.status, e.headers, e.error.code, e.error.limit_type, e.error.resets_at], [
          'error',
          429,
          { 'retry-after': '3600' },
          'usage_limit_reached',
          'seven_day',
          reset,
        ])
      }
    })
  })

  Deno.test(`${transport}: a 429 without a reset stays rate_limit_exceeded, without Retry-After (Claude Code drops the backend's)`, async () => {
    const run = new UsageRun(`usage-no-reset-${transport}`, false)
    await run.run(async () => {
      const replies: Reply[] = [
        { blocks: [text('never')], error: LIMITED, headers: unified({ status: 'rejected', 'representative-claim': 'five_hour' }) },
        { blocks: [text('never')], error: LIMITED, headers: { 'retry-after': '37' } },
      ]
      for (const reply of replies) {
        run.fake.reply(reply)
        if (transport === 'sse') {
          const r = await sse(run, 'limited')
          assertEquals([r.status, r.headers.get('retry-after'), r.body.error.code, r.body.error.limit_type], [429, null, 'rate_limit_exceeded', undefined])
        } else {
          const e = (await wsCreate(run.tg.websocket(), 'limited')).at(-1)
          assertEquals([e.type, e.status, e.headers, e.error.code, e.error.limit_type], ['error', 429, undefined, 'rate_limit_exceeded', undefined])
        }
      }
    })
  })
}

Deno.test('websocket: codex.rate_limits on a normal success, in the shape the kernel parses; only reported windows', async () => {
  const run = new UsageRun('usage-event-ws', false)
  await run.run(async () => {
    const r5 = now() + 3 * 3600, r7 = now() + 4 * 86400
    const ws = run.tg.websocket()
    run.fake.reply({
      blocks: [text('one')],
      headers: unified({
        status: 'allowed',
        '5h-utilization': '0.3',
        '5h-reset': String(r5),
        '7d-utilization': '0.5',
        '7d-reset': String(r7),
        '7d_oi-utilization': '0.8',
        '7d_oi-reset': String(r7),
      }),
    })
    const one = await wsCreate(ws, 'one')
    assertEquals(one.at(-1).type, 'response.completed')
    const usage = one.filter((e) => e.type === 'codex.rate_limits')
    assertEquals(usage.length, 1)
    assertEquals(usage[0], {
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: 30, window_minutes: 300, reset_at: r5 },
        secondary: { used_percent: 50, window_minutes: 10080, reset_at: r7 },
        windows: {
          five_hour: { used_percent: 30, window_minutes: 300, reset_at: r5 },
          seven_day: { used_percent: 50, window_minutes: 10080, reset_at: r7 },
          seven_day_overage_included: { used_percent: 80, window_minutes: 10080, reset_at: r7 },
        },
      },
    })
    kernelParse(usage[0])
    assertEquals(run.tg.events('rate_limit').at(-1)?.data.windows.seven_day_overage_included, { utilization: 0.8, resetsAt: r7 })
    // outside the response's sequence
    assertEquals(usage[0].sequence_number, undefined)

    // only the weekly window reported: no primary
    run.fake.reply({ blocks: [text('two')], headers: unified({ status: 'allowed', '7d-utilization': '0.6', '7d-reset': String(r7) }) })
    const two = (await wsCreate(ws, 'two')).filter((e) => e.type === 'codex.rate_limits')
    assertEquals(two.map((e) => e.rate_limits), [{
      secondary: { used_percent: 60, window_minutes: 10080, reset_at: r7 },
      windows: { seven_day: { used_percent: 60, window_minutes: 10080, reset_at: r7 } },
    }])

    // a report without windows (no unified headers) sends nothing: never an invented window
    run.fake.reply({ blocks: [text('three')] })
    const before = run.tg.events('rate_limit').length
    const three = await wsCreate(ws, 'three')
    assertEquals(three.filter((e) => e.type === 'codex.rate_limits'), [])
    assertEquals(run.tg.events('rate_limit').length, before + 1)
    assertEquals(run.tg.events('rate_limit').at(-1)?.data.status, 'allowed')
  })
})

Deno.test('websocket: a report after a tool-call response completed reaches the socket in the idle window', async () => {
  const run = new UsageRun('usage-event-idle', false)
  await run.run(async () => {
    const r5 = now() + 3600
    const ws = run.tg.websocket()
    // the response ends at the model's message_stop; Claude Code reports usage just after it
    run.fake.reply({
      blocks: [call('toolu_idle', 'echo', { text: 'x' })],
      headers: unified({ status: 'allowed', '5h-utilization': '0.42', '5h-reset': String(r5) }),
    })
    const events = await wsCreate(ws, 'call a tool')
    assertEquals(events.at(-1).type, 'response.completed')
    const usage = events.find((e) => e.type === 'codex.rate_limits') ?? await ws.next()
    assertEquals(kernelParse(usage).primary, { used_percent: 42, window_minutes: 300, reset_at: r5 })
  })
})

Deno.test('sse: the stream carries only standard Responses events, no codex.rate_limits', async () => {
  const run = new UsageRun('usage-event-sse', false)
  await run.run(async () => {
    const r5 = now() + 3600
    run.fake.reply({ blocks: [text('one')], headers: unified({ status: 'allowed', '5h-utilization': '0.3', '5h-reset': String(r5) }) })
    const r = await sse(run, 'one')
    assertEquals(r.events.at(-1).type, 'response.completed')
    assertEquals(r.events.filter((e) => !e.type.startsWith('response.')), [])
    assertEquals(run.tg.events('rate_limit').length, 1)
  })
})

for (const transport of ['sse', 'websocket'] as const) {
  Deno.test(`${transport}: a 429 after a hidden native tool round, before any client output, is still refused as a request`, async () => {
    const run = new UsageRun(`usage-after-native-${transport}`, false)
    await run.run(async () => {
      const reset = now() + 600
      // a call of a tool the client never defined is answered by Claude Code itself and emits nothing to the client
      run.fake.reply({ blocks: [call('toolu_n', 'nonexistent', {})] }, limit(reset, 'five_hour'))
      if (transport === 'sse') {
        const r = await sse(run, 'call something unknown')
        assertEquals([r.status, r.headers.get('retry-after') !== null, r.body.error.code, r.body.error.resets_at], [429, true, 'usage_limit_reached', reset])
      } else {
        const events = await wsCreate(run.tg.websocket(), 'call something unknown')
        assertEquals(events.filter((e) => e.type.startsWith('response.')), [])
        const e = events.at(-1)
        assertEquals([e.type, e.status, e.error.code, e.error.resets_at], ['error', 429, 'usage_limit_reached', reset])
      }
      assertEquals(run.fake.main().length, 2)
    })
  })
}

for (const transport of ['sse', 'websocket'] as const) {
  for (const weekly of [false, true]) {
    Deno.test(`${transport}: a ${weekly ? 'weekly' : 'session'} limit after output carries the kernel's status and capped retry header in response.failed`, async () => {
      const run = new UsageRun(`usage-after-output-${transport}-${weekly}`, false, { transport })
      await run.run(async () => {
        const reset = now() + (weekly ? 604800 : 900)
        const claim = weekly ? 'seven_day' : 'five_hour'
        // A hidden native tool after visible text causes another inference in this response.
        run.fake.reply(
          { blocks: [call('toolu_k', 'echo', { text: 'k' })] },
          { blocks: [text('first part'), call('toolu_native', 'nonexistent', {})] },
          limit(reset, claim),
        )
        await run.send([user('T1')])
        const lane = [...run.tg.gw.lanes.values()][0]
        // Capture the already-computed error: the pre-output refusal sends exactly these HTTP headers.
        const fail = lane.fail.bind(lane)
        let expected: Json
        lane.fail = (error) => {
          expected = { status: error.status, headers: error.headers }
          fail(error)
        }
        const r = await run.send([{ type: 'function_call_output', call_id: 'toolu_k', output: 'K' }, user('NOTICE-STOP')])
        assertEquals(r.status, 'failed')
        assertEquals(r.events.find((e) => e.type.startsWith('response.'))?.type, 'response.created')
        assert(r.events.some((e) => e.type === 'response.output_text.delta'))
        const terminal = r.events.at(-1)
        assertEquals(terminal.type, 'response.failed', 'not a request-level error after output')
        const error = terminal.response.error // exact location the kernel's ResponsesWebSocketEvents reads
        assertEquals([error.code, error.limit_type, error.resets_at], ['usage_limit_reached', claim, reset])
        assertEquals({ status: error.status, headers: error.headers }, expected)
        assertEquals(error.status, 429)
        assertEquals(typeof error.headers['retry-after'], 'string')
        if (weekly) assertEquals(error.headers, { 'retry-after': '3600' })
        else assert(Number(error.headers['retry-after']) > 0 && Number(error.headers['retry-after']) <= 900)
      })
    })
  }
}

for (const transport of ['sse', 'websocket'] as const) {
  Deno.test(`${transport}: a bare 429 after output fails with status 429 and empty retry headers`, async () => {
    const run = new UsageRun(`bare-429-after-output-${transport}`, false, { transport })
    await run.run(async () => {
      // With no unified reset headers, Code reports a bare rejection, not a known subscription reset.
      run.fake.reply(
        { blocks: [call('toolu_k', 'echo', { text: 'k' })] },
        { blocks: [text('first part'), call('toolu_native', 'nonexistent', {})] },
        { blocks: [], error: LIMITED },
      )
      await run.send([user('T1')])
      const lane = [...run.tg.gw.lanes.values()][0]
      const r = await run.send([{ type: 'function_call_output', call_id: 'toolu_k', output: 'K' }, user('NOTICE-STOP')])
      assertEquals(r.status, 'failed')
      assert(r.events.some((e) => e.type === 'response.output_text.delta'))
      assertEquals(r.events.at(-1).type, 'response.failed', 'already-streamed output cannot become a request-level error')
      const error = r.events.at(-1).response.error
      assertEquals(error, { code: 'rate_limit_exceeded', message: error.message, status: 429, headers: {} })
      assertEquals(error.headers['retry-after'], undefined)
      assertEquals(error.limit_type, undefined)
      assertEquals(error.resets_at, undefined)
      assertEquals(run.fake.main().length, 3)
    })
  })
}

Deno.test('sse: a client that leaves while its response is held is noticed at the first output, which cancels it', async () => {
  const run = new UsageRun('usage-held-abort', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('too late')], delayMs: 1500 })
    const ac = new AbortController()
    const res = fetch(`${run.tg.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, input: 'slow', stream: true }),
      signal: ac.signal,
    }).catch((e) => e)
    await run.tg.waitEvent('request')
    while (run.fake.main().length === 0) await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    assert((await res) instanceof Error)
    await run.tg.waitEvent('client_disconnect')
    assertEquals(run.tg.events('completed').length, 0)
    // the conversation is free again
    run.fake.reply({ blocks: [text('fine')] })
    assertEquals((await sse(run, 'again')).events.at(-1).type, 'response.completed')
  })
})

Deno.test('GET /v1/usage serves the saved windows in the WebSocket event shape, across a restart', async () => {
  const run = new UsageRun('usage-read', false)
  await run.run(async () => {
    const usage = async () => (await fetch(`${run.tg.url}/v1/usage`)).json()
    const t = now()
    const fresh = await usage()
    assertEquals(Object.keys(fresh.rate_limits.windows), ['five_hour', 'seven_day', 'seven_day_overage_included'])
    assertEquals(Object.values(fresh.rate_limits.windows).map((w) => (w as Json).used_percent), [0, 0, 0])
    assert(fresh.rate_limits.primary.reset_at >= t + 300 * 60, 'an unreported window resets a full window later')
    const r5 = t + 3 * 3600, r7 = t + 4 * 86400
    run.fake.reply({
      blocks: [text('one')],
      headers: unified({ status: 'allowed', '5h-utilization': '0.3', '5h-reset': String(r5), '7d-utilization': '0.5', '7d-reset': String(r7) }),
    })
    assertEquals((await sse(run, 'one')).events.at(-1).type, 'response.completed')
    const saved = await usage()
    kernelParse(saved)
    assertEquals([saved.rate_limits.primary, saved.rate_limits.windows.seven_day], [
      { used_percent: 30, window_minutes: 300, reset_at: r5 },
      { used_percent: 50, window_minutes: 10080, reset_at: r7 },
    ])
    assertEquals(saved.rate_limits.windows.seven_day_overage_included.used_percent, 0)
    await run.disrupt('restart')
    assertEquals(await usage(), saved)
  })
})

Deno.test('GET /v1/usage sits behind the same bearer token as /v1/responses', async () => {
  const d = dirs('usage-auth')
  const tg = await TestGateway.start({
    dirs: d,
    backendEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'unused' },
    authToken: 'usage-secret',
  })
  try {
    const refused = await fetch(`${tg.url}/v1/usage`)
    assertEquals([refused.status, (await refused.json()).error.code], [401, 'invalid_api_key'])
    const read = await fetch(`${tg.url}/v1/usage`, { headers: { authorization: 'Bearer usage-secret' } })
    assertEquals([read.status, (await read.json()).type], [200, 'codex.rate_limits'])
  } finally {
    await tg.close()
    cleanup(d)
  }
})
