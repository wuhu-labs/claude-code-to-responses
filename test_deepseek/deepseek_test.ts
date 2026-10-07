// Backend 2: DeepSeek through its Anthropic-compatible endpoint. Real tool rounds through the OpenAI SDK driver,
// and the cache hits DeepSeek reports on the first request after each kind of eviction.
// Needs DEEPSEEK_API_KEY in the environment; without it the test fails (it is never skipped silently).
import { assert, assertEquals } from '@std/assert'
import { cleanup, type Dirs, dirs, Driver, type Result, TestGateway } from '../test/harness.ts'
import type { Json } from '../test/fake.ts'

const BASE_URL = 'https://api.deepseek.com/anthropic'
const MODEL = 'deepseek-flash'
/** The first request after an eviction must find at least this share of the previous request's input in DeepSeek's
 * cache: everything it had before, the new tail aside (a tool result after a hold can be most of the input). */
const MIN_PREFIX = 0.9

const INSTRUCTIONS = [
  'You are the archivist of a small library. You answer questions about its documents.',
  'Rules: always read a document with the read_doc tool before saying anything about it; never guess its contents.',
  'Use the add tool for every sum, however small. When asked to use tools, call them; do not ask for permission.',
  'Keep every answer to one or two sentences.',
].join('\n')

const TOOLS = [
  {
    type: 'function',
    name: 'read_doc',
    description: 'Read a document of the library by name. Returns its full text.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Document name, e.g. alpha' } }, required: ['name'] },
  },
  {
    type: 'function',
    name: 'add',
    description: 'Add two integers and return the sum.',
    parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
  },
]

/** A deterministic document of about 1,500 tokens, so the history grows to a few thousand tokens. */
function doc(name: string): string {
  const lines = [`Document ${name.toUpperCase()}.`]
  for (let i = 1; i <= 60; i++) {
    lines.push(
      `Section ${i} of ${name}: the shelf ${(i * 7) % 13} holds ${i * 3} volumes on ${['rivers', 'stars', 'trade', 'glass', 'bells'][i % 5]}, catalogued in ${
        1900 + i
      }.`,
    )
  }
  lines.push(`The key number of ${name} is ${name.length * 111}.`)
  return lines.join('\n')
}

const tools = {
  read_doc: (a: Json) => doc(String(a.name ?? 'unknown')),
  add: (a: Json) => String(Number(a.a) + Number(a.b)),
}

interface Measure {
  kind: string
  /** Input tokens of this request, and of the request before it in the conversation. */
  input: number
  previous: number
  cached: number
  /** cached / input */
  hit: number
  /** cached / previous: how much of what the model had already seen was read from the cache */
  prefix: number
  path: string
  resume?: string
}

const measures: Measure[] = []
function measure(kind: string, r: Result, previous: Result): Measure {
  const u = r.response.usage
  const prev = previous.response.usage.input_tokens
  const cached = u.input_tokens_details.cached_tokens
  const m = {
    kind,
    input: u.input_tokens,
    previous: prev,
    cached,
    hit: cached / u.input_tokens,
    prefix: Math.min(1, cached / prev),
    path: r.response.x_gateway.path,
    resume: r.response.x_gateway.resume,
  }
  measures.push(m)
  console.log(
    `${kind.padEnd(44)} input ${String(m.input).padStart(6)}  previous ${String(prev).padStart(6)}  cached ${String(cached).padStart(6)}  hit ${
      (m.hit * 100).toFixed(1).padStart(5)
    }%  prefix ${(m.prefix * 100).toFixed(1).padStart(5)}%  (${m.path}${m.resume ? `, ${m.resume}` : ''})`,
  )
  return m
}

Deno.test('DeepSeek: real tool rounds, and the cache stays warm after every kind of eviction', async () => {
  const key = Deno.env.get('DEEPSEEK_API_KEY')
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set: this test runs against DeepSeek and needs the key in the environment')
  const backendEnv = { ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: key }
  let d: Dirs = dirs('deepseek')
  const firstDirs = d
  let tg = await TestGateway.start({ dirs: d, backendEnv })
  const gateways = [tg]
  const drv = new Driver(tg.client, { instructions: INSTRUCTIONS, tools: TOOLS, model: MODEL, mode: 'previous' })
  /** 'keep': same state; 'store': the response store is lost, Claude Code's config dir kept; 'all': a fresh state dir. */
  const restart = async (lose: 'keep' | 'store' | 'all') => {
    await tg.close()
    if (lose === 'store') {
      const state = Deno.realPathSync(d.stateDir)
      for (const sub of ['responses', 'tails']) Deno.removeSync(`${state}/${sub}`, { recursive: true })
    }
    if (lose === 'all') d = { stateDir: dirs('deepseek-fresh').stateDir, workRoot: d.workRoot }
    tg = await TestGateway.start({ dirs: d, backendEnv })
    gateways.push(tg)
    drv.client = tg.client
  }
  /** Sends; a store that lost the id answers previous_response_not_found, and the full history goes instead. */
  const send = async (input: Json[]): Promise<Result> => {
    try {
      return await drv.send(input)
    } catch (e) {
      const err = e as { status?: number; code?: string }
      if (err.status === 400 && err.code === 'previous_response_not_found') return await drv.send(input, 'history')
      throw e
    }
  }
  const outputs = async (r: Result) => {
    const outs: Json[] = []
    for (const c of drv.calls(r)) {
      outs.push({ type: 'function_call_output', call_id: c.call_id, output: await (tools as Json)[c.name](JSON.parse(c.arguments)) })
    }
    return outs
  }
  /** One user turn, run to its end; returns every response of it. */
  const turn = async (text: string): Promise<Result[]> => {
    const rs = [await send([{ role: 'user', content: text }])]
    while (rs.at(-1)!.status === 'completed' && drv.calls(rs.at(-1)!).length) rs.push(await send(await outputs(rs.at(-1)!)))
    for (const r of rs) assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
    return rs
  }
  const pause = () => new Promise((r) => setTimeout(r, 3000)) // let DeepSeek finish writing its cache

  try {
    // warm up: two documents and a sum, all through real tool calls
    const t1 = await turn('Read document alpha and tell me its key number.')
    assert(t1.some((r) => drv.calls(r).some((c: Json) => c.name === 'read_doc')), 'the model read the document')
    const t2 = await turn('Now read document beta, then add the key numbers of alpha and beta with the add tool.')
    assert(t2.some((r) => drv.calls(r).some((c: Json) => c.name === 'add')), 'the model used the add tool')
    measure('live (a turn start, for comparison)', t2[0], t1.at(-1)!)
    await pause()

    // 1. idle eviction, rebuilt from the store
    let last = t2.at(-1)!
    await tg.evictAll('idle_timeout')
    const t3 = await turn('Which of the two documents has the larger key number? Answer without tools.')
    const idle = measure('after an idle eviction', t3[0], last)
    await pause()

    // 2. eviction while Claude Code holds a call: the interrupted-turn resume
    const held = await send([{ role: 'user', content: 'Read document gamma and tell me its key number.' }])
    assert(drv.calls(held).length > 0, 'the model called a tool')
    await pause()
    await tg.evictAll('hold_timeout')
    const resumed = await send(await outputs(held))
    const hold = measure('after an eviction during a hold', resumed, held)
    last = resumed
    while (drv.calls(last).length) last = await send(await outputs(last))
    assertEquals(last.status, 'completed')
    await pause()

    // 3. gateway restart, state kept: rebuilt from the store
    await restart('keep')
    const t4 = await turn('Add 17 and 25 with the add tool.')
    const restarted = measure('after a gateway restart', t4[0], last)
    last = t4.at(-1)!
    await pause()

    // 4. gateway restart that lost its response store: the full history, rebuilt from the records it carries
    await restart('store')
    const t5 = await turn('In one sentence, what is document alpha about?')
    const lost = measure('after a restart that lost the response store', t5[0], last)
    assertEquals([t5[0].response.x_gateway.path, t5[0].response.x_gateway.synthesized_groups], ['history', 0])
    last = t5.at(-1)!
    await pause()

    // 5. a fresh state dir: same bytes to the model, but a new Claude Code device id in metadata.user_id, which
    //    DeepSeek keys its cache on. Reported, not asserted: a known miss.
    await restart('all')
    const t6 = await turn('Thank you. Reply with one word.')
    measure('after a restart with a fresh state dir (known miss)', t6[0], last)
    assertEquals([t6[0].response.x_gateway.path, t6[0].response.x_gateway.synthesized_groups], ['history', 0])
    last = t6.at(-1)!
    await pause()
    const t7 = await turn('And one more word, please.')
    measure('live (the turn after)', t7[0], last)

    for (const m of [idle, hold, restarted, lost]) assert(m.prefix >= MIN_PREFIX, `${m.kind}: prefix ${(m.prefix * 100).toFixed(1)}% < ${MIN_PREFIX * 100}%`)
    for (const g of gateways) g.assertClean()
  } finally {
    await tg.close()
    cleanup(d)
    cleanup(firstDirs)
    Deno.mkdirSync(`${new URL('..', import.meta.url).pathname}.state`, { recursive: true })
    Deno.writeTextFileSync(`${new URL('..', import.meta.url).pathname}.state/deepseek-cache.json`, JSON.stringify(measures, null, 2))
  }
})
