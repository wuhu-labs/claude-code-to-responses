// The chain's reservation and the lanes' windows, with deterministic barriers: a request holds its chain from
// planning to its terminal record write, a request that left does nothing on its behalf, and no request stops a
// process it did not start. The gateway runs in this process so a test can open exactly one window and hold it.
import { assertEquals } from '@std/assert'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseRequest, type NormRequest } from '../src/api/request.ts'
import type { EventSink, SinkEvent } from '../src/api/stream.ts'
import { AgyGateway, type Config } from '../src/agy/gateway.ts'

const main = fileURLToPath(new URL('../src/agy/main.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/fake_agy.ts', import.meta.url))
const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
const MODEL = 'gemini-3.8-flash-low'
const INSTRUCTIONS = 'Fence this conversation.'
const tool = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }
const user = (text: string) => ({ role: 'user', content: text })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The client's side of one response: what a transport would do, with the moments a test needs to decide. */
class TestSink implements EventSink {
  readonly events: { type: string; data: any }[] = []
  readonly done = Promise.withResolvers<void>()
  closed = false
  onCancel: (() => void) | null = null

  get isClosed(): boolean {
    return this.closed
  }

  send(type: string, data: any): void {
    this.events.push({ type, data })
    if (TERMINAL.includes(type)) this.done.resolve()
  }

  prepare(events: SinkEvent[]): (() => boolean) | null {
    return () => {
      for (const event of events) this.events.push(event as { type: string; data: any })
      if (events.some((event) => TERMINAL.includes(event.type))) this.done.resolve()
      return true
    }
  }

  close(): void {
    this.closed = true
    this.done.resolve()
  }

  /** The client goes away: the transport's cancel, which marks the sink closed and tells the request. */
  cancel(): void {
    this.closed = true
    this.onCancel?.()
  }

  get terminal(): { type: string; data: any } {
    return this.events.filter((event) => TERMINAL.includes(event.type)).at(-1)!
  }
}

const TERMINAL = ['response.completed', 'response.failed', 'response.incomplete']

interface Harness {
  gw: AgyGateway
  state: string
  request: (body: Record<string, unknown>) => NormRequest
  /** Sends one create and waits for its terminal event, the way a transport does. */
  create: (body: Record<string, unknown>) => Promise<TestSink>
  evidence: () => Promise<any[]>
  dispose: () => Promise<void>
}

async function harness(): Promise<Harness> {
  await Deno.mkdir('.state/test', { recursive: true })
  const root = await Deno.realPath(await Deno.makeTempDir({ dir: '.state/test', prefix: 'agy-res-' }))
  const state = `${root}/state`
  const evidenceFile = `${root}/evidence.jsonl`
  const agy = `${root}/agy`
  await Deno.writeTextFile(
    agy,
    `#!/bin/sh\nexport FAKE_AGY_EVIDENCE=${shellWord(evidenceFile)}\nexec ${[Deno.execPath(), 'run', '-A', fixture, 'default'].map(shellWord).join(' ')} "$@"\n`,
    { mode: 0o700 },
  )
  const config: Config = {
    state,
    agy,
    port: 0,
    allowUncheckedVersion: false,
    idleMs: 1_800_000,
    holdMs: 600_000,
    helper: [Deno.execPath(), 'run', '-A', main],
  }
  const gw = await AgyGateway.start(config)
  const server = gw.listen(() => {})
  const request = (body: Record<string, unknown>) => parseRequest({ stream: true, model: MODEL, instructions: INSTRUCTIONS, tools: [tool], ...body }, 'sse', 'agy')
  const create = async (body: Record<string, unknown>) => {
    const sink = new TestSink()
    await gw.createInto(request(body), sink)
    await Promise.race([sink.done.promise, sleep(20_000).then(() => {
      throw new Error(`no terminal event: ${JSON.stringify(sink.events.map((event) => event.type))}`)
    })])
    return sink
  }
  const evidence = async () => (await Deno.readTextFile(evidenceFile)).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const dispose = async () => {
    await gw.close()
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
  return { gw, state, request, create, evidence, dispose }
}

/** The outputs a held batch is waiting for, as the client sends them. */
function outputs(terminal: any): { type: string; call_id: string; output: string }[] {
  return terminal.data.response.output
    .filter((item: any) => item.type === 'function_call')
    .map((item: any, i: number) => ({ type: 'function_call_output', call_id: item.call_id, output: `result-${i}` }))
}

/** The record a response emitted, for a request that carries this lane's reasoning. */
function recordOf(terminal: any): string {
  return terminal.data.response.output.find((item: any) => item.type === 'reasoning' && item.encrypted_content).encrypted_content
}

/** A create the gateway must refuse while another request owns the chain: `409 conversation_busy`, nothing served. */
async function assertBusy(h: Harness, body: Record<string, unknown>, why: string) {
  const sink = new TestSink()
  const outcome = await Promise.race([
    h.gw.createInto(h.request(body), sink).then(() => 'returned', (e) => `threw ${(e as Error).message}`),
    sleep(3000).then(() => 'still running'),
  ])
  assertEquals(outcome, 'returned', why)
  assertEquals([sink.terminal.type, sink.terminal.data.response.error.code], ['response.failed', 'conversation_busy'], why)
}

Deno.test('agy: a request that leaves while the echoed reasoning decodes does not stop the lane at the parent', async () => {
  const h = await harness()
  try {
    const first = await h.create({ input: [user('Remember one.')] })
    const second = await h.create({ previous_response_id: first.terminal.data.response.id, input: [user('Second turn.')] })
    assertEquals(second.terminal.data.response.x_gateway.path, 'live')
    const lane = [...h.gw.lanes.values()][0]
    assertEquals([lane.dead, lane.head], [false, second.terminal.data.response.id])
    // the echoed reasoning decodes before anything else happens; hold it there and let the client leave
    const decode = (h.gw as any).withoutOwnReasoning.bind(h.gw)
    const inside = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    ;(h.gw as any).withoutOwnReasoning = async (...args: unknown[]) => {
      inside.resolve()
      await resume.promise
      return decode(...args)
    }
    const sink = new TestSink()
    const running = h.gw.createInto(h.request({
      previous_response_id: second.terminal.data.response.id,
      input: [{ type: 'reasoning', summary: [], encrypted_content: recordOf(first.terminal) }, user('Again.')],
    }), sink)
    await inside.promise
    sink.cancel()
    resume.resolve()
    await running
    // the live process at the parent is the chain's, not the departed request's: it is still there and still serves
    assertEquals([lane.dead, lane.head], [false, second.terminal.data.response.id])
    const next = await h.create({ previous_response_id: second.terminal.data.response.id, input: [user('Onward.')] })
    assertEquals([next.terminal.type, next.terminal.data.response.x_gateway.path], ['response.completed', 'live'])
  } finally {
    await h.dispose()
  }
})

Deno.test('agy: a cancelled request awaiting eviction keeps the chain reserved and writes nothing', async () => {
  const h = await harness()
  try {
    const first = await h.create({ input: [user('one')] })
    const second = await h.create({ previous_response_id: first.terminal.data.response.id, input: [user('two')] })
    assertEquals(second.terminal.data.response.x_gateway.path, 'live')
    const conversation = first.terminal.data.response.x_gateway.conversation
    const db = `${h.state}/gemini/antigravity-cli/conversations/${conversation}.db`
    const before = createHash('sha256').update(await Deno.readFile(db)).digest('hex')
    // the rebuild's eviction is where the cancelled request would still race the store
    const evict = (h.gw.chains as any).evict.bind(h.gw.chains)
    const inside = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    ;(h.gw.chains as any).evict = async (chain: string, reason: string) => {
      inside.resolve()
      await resume.promise
      return evict(chain, reason)
    }
    const sink = new TestSink()
    const branch = { previous_response_id: first.terminal.data.response.id, input: [user('branch')] }
    const running = h.gw.createInto(h.request(branch), sink)
    await inside.promise
    sink.cancel()
    // the chain is still the cancelled request's: a second writer on the same store would race it
    await assertBusy(h, branch, 'the chain was released while a cancelled request still awaited eviction')
    resume.resolve()
    await running
    assertEquals(createHash('sha256').update(await Deno.readFile(db)).digest('hex'), before, 'the cancelled request assembled the store')
    // the request stopped touching the store before it released the chain
    const after = await h.create(branch)
    assertEquals(after.terminal.type, 'response.completed')
  } finally {
    await h.dispose()
  }
})

Deno.test('agy: the chain stays busy through the record write after the lane has no active exchange', async () => {
  const h = await harness()
  try {
    const first = await h.create({ input: [user('one')] })
    const lane = [...h.gw.lanes.values()][0]
    // the record is cut from agy's store while the lane's exchange is already finished
    const snapshot = (h.gw as any).snapshotFor.bind(h.gw)
    const inside = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    ;(h.gw as any).snapshotFor = async (...args: unknown[]) => {
      inside.resolve()
      await resume.promise
      return snapshot(...args)
    }
    const running = h.create({ previous_response_id: first.terminal.data.response.id, input: [user('two')] })
    await inside.promise
    assertEquals([lane.busy, lane.dead], [false, false], 'the lane is mid-commit, not busy with an exchange')
    await assertBusy(
      h,
      { previous_response_id: first.terminal.data.response.id, input: [user('three')] },
      'the chain was free while the previous response was still writing its record',
    )
    resume.resolve()
    const done = await running
    assertEquals(done.terminal.type, 'response.completed')
    // the commit released it once: the next request on the chain is served
    const next = await h.create({ previous_response_id: done.terminal.data.response.id, input: [user('three')] })
    assertEquals(next.terminal.type, 'response.completed')
  } finally {
    await h.dispose()
  }
})
