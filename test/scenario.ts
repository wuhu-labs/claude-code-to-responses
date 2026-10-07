// Scenario runs: the same conversation driven twice, once on one live process (the control) and once with
// evictions and gateway restarts in between. The model must see byte-identical requests either way.
import { assertEquals } from '@std/assert'
import { FakeAnthropic, type Json } from './fake.ts'
import { cleanup, type Dirs, dirs, Driver, freePort, type Result, TestGateway } from './harness.ts'

export const MODEL = 'claude-opus-5-5'
export const INSTRUCTIONS = 'You are a test agent. Use the tools when asked.'
export const TOOLS = [
  {
    type: 'function',
    name: 'echo',
    description: 'Echo the text back.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    type: 'function',
    name: 'read',
    description: 'Read a named thing.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
]
export const toolsImpl = {
  echo: (a: Json) => `ECHO ${a.text}`,
  read: (a: Json) => `CONTENT OF ${a.name}`,
}

export type Disruption = 'idle' | 'restart' | 'restart-lost-store' | 'hold'

export class Run {
  fake: FakeAnthropic
  tg!: TestGateway
  drv!: Driver
  d: Dirs
  gateways: TestGateway[] = []
  disruptions: { kind: Disruption; beforeRequest: number }[] = []
  /** The device id every gateway of this run is configured with (the same across restarts and fresh state dirs). */
  deviceId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('')

  constructor(
    readonly name: string,
    readonly live: boolean,
    readonly opts: {
      claudeBinary?: string
      mode?: 'previous' | 'history'
      tz?: string
      workDir?: string
      idleTimeoutMs?: number
      holdTimeoutMs?: number
      recordTimeoutMs?: number
    } = {},
  ) {
    this.fake = new FakeAnthropic(freePort())
    this.d = dirs(name)
    if (opts.workDir) this.d.workDir = opts.workDir
  }

  backend() {
    return { ANTHROPIC_BASE_URL: this.fake.url, ANTHROPIC_AUTH_TOKEN: 'fake-key' }
  }

  async start(): Promise<void> {
    this.tg = await TestGateway.start({
      dirs: this.d,
      claudeBinary: this.opts.claudeBinary,
      backendEnv: this.backend(),
      tz: this.opts.tz,
      idleTimeoutMs: this.opts.idleTimeoutMs,
      holdTimeoutMs: this.opts.holdTimeoutMs,
      recordTimeoutMs: this.opts.recordTimeoutMs,
      deviceId: this.deviceId,
    })
    this.gateways.push(this.tg)
    this.drv = new Driver(this.tg.client, { instructions: INSTRUCTIONS, tools: TOOLS, model: MODEL, mode: this.opts.mode ?? 'previous' })
  }

  /** Evicts or restarts between requests, unless this is the control run. */
  async disrupt(kind: Disruption, o: { tz?: string; workDir?: string } = {}): Promise<void> {
    if (this.live) return
    this.disruptions.push({ kind, beforeRequest: this.fake.main().length })
    if (kind === 'idle' || kind === 'hold') {
      await this.tg.evictAll(kind === 'idle' ? 'idle_timeout' : 'hold_timeout')
      return
    }
    await this.tg.close()
    this.tg.assertClean()
    if (kind === 'restart-lost-store') this.d = { stateDir: dirs(`${this.name}-fresh`).stateDir, workDir: o.workDir ?? this.d.workDir }
    else if (o.workDir) this.d = { ...this.d, workDir: o.workDir }
    this.tg = await TestGateway.start({
      dirs: this.d,
      claudeBinary: this.opts.claudeBinary,
      backendEnv: this.backend(),
      tz: o.tz ?? this.opts.tz,
      idleTimeoutMs: this.opts.idleTimeoutMs,
      holdTimeoutMs: this.opts.holdTimeoutMs,
      recordTimeoutMs: this.opts.recordTimeoutMs,
      deviceId: this.deviceId,
    })
    this.gateways.push(this.tg)
    this.drv.client = this.tg.client
  }

  /** Sends through the driver; a lost store answers previous_response_not_found, and the full history goes instead. */
  async send(input: Json[]): Promise<Result> {
    try {
      return await this.drv.send(input)
    } catch (e) {
      const err = e as { status?: number; code?: string; error?: Json }
      if (err.status === 400 && (err.code ?? err.error?.code) === 'previous_response_not_found') return await this.drv.send(input, 'history')
      throw e
    }
  }

  async turn(text: string, notices: string[] = []): Promise<Result> {
    let r = await this.send([{ role: 'user', content: text }])
    while (r.status === 'completed' && this.drv.calls(r).length) {
      const outs: Json[] = []
      for (const c of this.drv.calls(r)) {
        outs.push({ type: 'function_call_output', call_id: c.call_id, output: (toolsImpl as Json)[c.name](JSON.parse(c.arguments)) })
      }
      r = await this.send([...outs, ...notices.splice(0).map((n) => ({ role: 'user', content: n }))])
    }
    assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
    return r
  }

  /** Replaces this run's working folders with a placeholder, for comparing two runs. */
  normalize = (s: string): string => {
    const sessions = new Set(this.gateways.flatMap((g) => g.events('spawn').map((e) => e.data.session as string)))
    for (const g of this.gateways) s = s.replaceAll(g.gw.config.workDir, '<WORK>')
    for (const sid of sessions) s = s.replaceAll(sid, '<SESSION>')
    const devices = new Set(this.gateways.flatMap((g) => g.events('spawn').map((e) => e.data.device as string)))
    for (const d of devices) s = s.replaceAll(d, '<DEVICE>')
    return s
  }

  /** Runs the test body; on failure the run is still torn down, without hiding the failure. */
  async run(fn: () => Promise<void>, start = true): Promise<void> {
    if (start) await this.start()
    try {
      await fn()
    } catch (e) {
      await this.close().catch((c) => console.error('teardown after a failure:', c))
      throw e
    }
    await this.close()
  }

  async close(): Promise<void> {
    await this.tg.close()
    for (const g of this.gateways) g.assertClean()
    await this.fake.close()
    cleanup(this.d)
  }
}
