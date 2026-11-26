import { assert, assertEquals, assertMatch } from '@std/assert'
import { fileURLToPath } from 'node:url'
import { lines } from '../src/claude/lines.ts'
import { packRecord, unpackRecord } from '../src/records.ts'
import { AGY_RECORD_PREFIX } from '../src/agy/record.ts'
import { kernelBody } from './kernel_shapes.ts'
import { WsClient } from './websocket_client.ts'

const main = fileURLToPath(new URL('../src/agy/main.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/fake_agy.ts', import.meta.url))
const tool = (name = 'lookup') => ({ type: 'function', name, parameters: { type: 'object', properties: {} } })
const message = (role: string, content: unknown) => ({ role, content })
const user = (text: string) => message('user', text)
const MODEL = 'gemini-3.8-flash-low'
const INSTRUCTIONS = 'Fence this conversation.'
const initial = (input: unknown, tools = [tool()]) => ({ instructions: INSTRUCTIONS, model: MODEL, tools, input: [user(String(input))] })
const follow = (r: any, input: unknown[], props = {}) => ({ model: MODEL, previous_response_id: r.id, input, ...props })
const calls = (r: any) => r.output.filter((v: any) => v.type === 'function_call')
const text = (r: any) => r.output.find((v: any) => v.type === 'message')?.content[0].text
const result = (call: any, output: string) => ({ type: 'function_call_output', call_id: call.call_id, output })
const outputs = (r: any, prefix = 'result') => calls(r).map((c: any, i: number) => result(c, `${prefix}-${i}`))
const shellWord = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`

async function rig(mode = 'default') {
  await Deno.mkdir('.state/test', { recursive: true })
  const root = await Deno.realPath(await Deno.makeTempDir({ dir: '.state/test', prefix: 'agy-' }))
  const state = `${root}/state with spaces`
  const fake = `${root}/agy`
  await Deno.writeTextFile(fake, `#!/bin/sh\nexec ${[Deno.execPath(), 'run', '-A', fixture, mode].map(shellWord).join(' ')} "$@"\n`, { mode: 0o700 })
  const processes = new Set<Deno.ChildProcess>()
  const evidenceFile = `${state}/gemini/fake-evidence.jsonl`
  const evidence = async () => (await Deno.readTextFile(evidenceFile)).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const start = async (extra: string[] = []) => {
    const compiled = Deno.env.get('AGY_TEST_GATEWAY')
    const child = new Deno.Command(compiled ?? Deno.execPath(), {
      args: [...(compiled ? [] : ['run', '-A', main]), '--port', '0', '--state-dir', state, '--agy', fake, ...extra],
      stdout: 'null',
      stderr: 'piped',
    }).spawn()
    processes.add(child)
    void child.status.then(() => processes.delete(child))
    const ready = Promise.withResolvers<string>()
    const stderr: string[] = []
    const drain = (async () => {
      for await (const line of lines(child.stderr)) {
        stderr.push(line)
        const address = line.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
        if (address) ready.resolve(address)
      }
      ready.reject(new Error(stderr.join('\n')))
    })()
    const url = await ready.promise
    const stop = async (signal: Deno.Signal = 'SIGTERM') => {
      if (processes.has(child)) child.kill(signal)
      const status = await child.status
      await drain.catch(() => {/* the drain also rejects once the process is gone */})
      if (signal === 'SIGTERM') assertEquals(status.code, 0, stderr.join('\n'))
    }
    const post = (body: unknown) =>
      fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, ...(body as object) }),
        signal: AbortSignal.timeout(20_000),
      })
    const create = async (body: unknown) => {
      const res = await post(body)
      const raw = await res.text()
      assertEquals(res.status, 200, `${raw}\n${stderr.join('\n')}`)
      const events = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
      assertEquals(events.at(-1)?.type, 'response.completed', raw)
      return { response: events.at(-1).response, events }
    }
    return { url, child, stop, create, post, stderr }
  }
  const dispose = async () => {
    for (const child of processes) child.kill('SIGTERM')
    await Promise.all([...processes].map((p) => p.status))
    await Deno.remove(root, { recursive: true })
  }
  return { start, evidence, dispose, state, fake }
}

async function assertStopped(pids: number[]) {
  const deadline = performance.now() + 2500
  while (true) {
    const raw = await new Deno.Command('/bin/ps', { args: ['-p', pids.join(','), '-o', 'pid=,stat='], stderr: 'null' }).output()
    const live = new TextDecoder().decode(raw.stdout).trim().split('\n').filter((l) => /\d+\s+[^Z\s]/.test(l))
    if (!live.length) return
    assert(performance.now() < deadline, `processes still running: ${live}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const pids = (events: any[]) => events.flatMap((e) => e.kind === 'process' ? [e.agy] : e.kind === 'shim' ? [e.pid] : [])
const promptsOf = (events: any[]) => events.filter((e) => e.kind === 'prompt')

/** What the model sees before a turn: the rows agy renders upstream, one per line, without the resume notices. */
function upstream(visible: string[]): string[] {
  return visible.filter((row) => !/^\d+:101:/.test(row)).map((row) => row.replace(/^\d+:/, ''))
}

/** One scripted conversation: plain turn, a held batch, its release plus a notice, then two plain turns. */
async function conversation(disrupt: boolean) {
  const r = await rig()
  let gw = await r.start(disrupt ? ['--hold-timeout', '0.2'] : [])
  const history: any[] = []
  const responses = []
  let release: { checks: any[]; prompts: any[] } = { checks: [], prompts: [] }
  const send = async (input: unknown[], previous: string | null) => {
    const body = { model: MODEL, instructions: INSTRUCTIONS, tools: [tool()], input: previous ? input : [...history, ...input] }
    const made = await gw.create(previous ? { ...body, previous_response_id: previous } : body)
    assertEquals(made.response.status, 'completed')
    history.push(...input, ...made.response.output)
    return made.response
  }
  const first = await send([user('Remember KUMQUAT-3311.')], null)
  responses.push(first)
  const second = await send([user('batch')], first.id)
  responses.push(second)
  assertEquals(calls(second).length, 3)
  if (disrupt) await assertStopped(pids(await r.evidence()))
  const third = await send([...outputs(second), user('user notice')], second.id)
  responses.push(third)
  if (disrupt) {
    const events = await r.evidence()
    release = { checks: events.filter((e) => e.kind === 'resume-check'), prompts: promptsOf(events) }
    await gw.stop()
    gw = await r.start()
  }
  const fourth = await send([user('What did the calls return?')], third.id)
  responses.push(fourth)
  if (disrupt) {
    await gw.stop()
    await Deno.remove(r.state, { recursive: true })
    gw = await r.start()
  }
  const fifth = await send([user('And now?')], disrupt ? null : fourth.id)
  responses.push(fifth)
  await gw.stop()
  const final = promptsOf(await r.evidence())
  await r.dispose()
  return { responses, release, prompts: final }
}

Deno.test('agy: one conversation keeps one store and one upstream on the live path and through every rebuild', async () => {
  const live = await conversation(false)
  assertEquals(live.responses.map((r) => r.x_gateway.path), ['new', 'live', 'live', 'live', 'live'])
  const rebuilt = await conversation(true)
  assertEquals(rebuilt.responses.map((r) => r.x_gateway.path), ['new', 'live', 'store', 'store', 'history'])
  assertEquals(rebuilt.responses[2].x_gateway.patched, 3)
  // the pending calls the record names were completed by the gateway's own write
  assertEquals(rebuilt.release.checks.length, 1)
  assertEquals(rebuilt.release.checks[0].pending.length, 3)
  assertEquals(rebuilt.release.checks[0].completed, ['result-0', 'result-1', 'result-2'])
  // the last turn sees exactly the rows the live conversation saw, apart from the resume notices
  const last = (prompts: any[]) => upstream(prompts.at(-1).visible)
  assertEquals(last(rebuilt.prompts), last(live.prompts))
})

Deno.test('agy: a live process releases held calls itself, and a restart during a hold completes them from the store', async () => {
  const r = await rig()
  try {
    let gw = await r.start()
    const { response } = await gw.create(initial('batch'))
    assertEquals(calls(response).length, 3)
    const live = await gw.create(follow(response, [...outputs(response).reverse(), user('user notice')]))
    assertEquals(live.response.x_gateway.path, 'live')
    assertEquals(JSON.parse(text(live.response)), {
      results: ['result-0', 'result-1', 'result-2'],
      messages: [{ userMessage: 'user notice' }],
    })
    // the second batch is held across a gateway restart, then released from the store
    const second = await gw.create(follow(live.response, [user('pair')]))
    assertEquals(calls(second.response).length, 2)
    await gw.stop()
    gw = await r.start()
    const released = await gw.create(follow(second.response, outputs(second.response, 'after')))
    assertEquals([released.response.x_gateway.path, released.response.x_gateway.patched], ['store', 2])
    const check = (await r.evidence()).filter((e) => e.kind === 'resume-check').at(-1)
    assertEquals(check.completed, ['after-0', 'after-1'])
    assertEquals(JSON.parse(text(released.response)).results, ['after-0', 'after-1'])
    await gw.stop()
    await assertStopped(pids(await r.evidence()))
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a history no record covers is refused before any process starts', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    const res = await gw.post({
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [user('earlier'), message('assistant', 'answer'), user('continue')],
    })
    assertEquals(res.status, 400)
    assertEquals((await res.json()).error.code, 'provider_record_missing')
    assertEquals((await r.evidence().catch(() => [])).filter((e) => e.kind === 'process').length, 0)
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: another lane\'s record and another agy version are typed refusals', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    const first = await gw.create(initial('Remember the marker.'))
    const record = first.response.output.find((item: any) => item.type === 'reasoning' && item.encrypted_content)?.encrypted_content
    assert(record?.startsWith(AGY_RECORD_PREFIX))
    const items = first.response.output.filter((item: any) => !(item.type === 'reasoning' && item.encrypted_content?.startsWith(AGY_RECORD_PREFIX)))
    const body = (mutation: string) => ({
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [user('Remember the marker.'), ...items, { type: 'reasoning', summary: [], encrypted_content: mutation }],
    })
    const other = await gw.post(body('cc2r.record.v1.h4sIAAAAAAAA'))
    assertEquals([other.status, (await other.json()).error.code], [400, 'provider_record_foreign'])
    const older = await unpackRecord(AGY_RECORD_PREFIX, record!) as any
    const olderBody = await packRecord(AGY_RECORD_PREFIX, { ...older, agy: '1.5.16' })
    const version = await gw.post(body(olderBody))
    assertEquals([version.status, (await version.json()).error.code], [400, 'provider_record_foreign'])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: an image is refused and the output ids must be the held calls', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    const { response } = await gw.create(initial('batch'))
    const image = await gw.post(follow(response, [...outputs(response), message('user', [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }])]))
    assertEquals([image.status, (await image.json()).error.code], [400, 'unsupported'])
    const missing = await gw.post(follow(response, [result(calls(response)[0], 'x')]))
    assertEquals((await missing.json()).error.code, 'missing_tool_output')
    const unknown = await gw.post(follow(response, [...outputs(response), result({ call_id: 'nope' }, 'x')]))
    assertEquals((await unknown.json()).error.code, 'unexpected_tool_output')
    const duplicate = await gw.post(follow(response, [...outputs(response), result(calls(response)[0], 'again')]))
    assertEquals((await duplicate.json()).error.code, 'unexpected_tool_output')
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a large tool output is written as agy\'s preview, with the whole text in output.txt', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--hold-timeout', '0.2'])
    const { response } = await gw.create(initial('pair'))
    await assertStopped(pids(await r.evidence()))
    const big = `BIG ${'x'.repeat(30_000)} TAILMARKER-4411`
    const released = await gw.create(follow(response, [result(calls(response)[0], big), result(calls(response)[1], 'small-1')]))
    assertEquals([released.response.x_gateway.path, released.response.x_gateway.patched], ['store', 2])
    const written = (await r.evidence()).filter((e) => e.kind === 'step-output').find((e) => e.preview)
    assert(written, 'the resumed store was not checked')
    assertEquals(written.preview, true)
    assertEquals(written.stepBytes < 10_241, true)
    assertEquals(written.fileBytes > 30_000, true)
    assertMatch(written.stored, /^The tool's output was truncated due to being too long\./)
    assertMatch(written.stored, /TAILMARKER-4411$/)
    assertEquals(written.body, big)
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: usage and cancel behave as before', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--idle-timeout', '0.3', '--hold-timeout', '0.3'])
    const { response } = await gw.create(initial('batch'))
    assertEquals(response.usage, {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 145,
    })
    const usage = await (await fetch(`${gw.url}/v1/usage`)).json()
    assertEquals(usage.tier, { id: 'fake-ultra', name: 'Fake Ultra' })
    assert(!('rate_limits' in usage))
    const res = await gw.post(initial('hold-generation'))
    assertEquals(res.status, 200)
    assert(res.body)
    let id = '', terminal: any
    for await (const line of lines(res.body)) {
      if (!line.startsWith('data: ')) continue
      const ev = JSON.parse(line.slice(6))
      if (ev.type === 'response.created') id = ev.response.id
      if (ev.type === 'response.output_text.delta') {
        const stop = await fetch(`${gw.url}/v1/responses/${id}/cancel`, { method: 'POST' })
        assertEquals(stop.status, 200)
        assertEquals((await stop.json()).status, 'cancelled')
      }
      if (ev.type === 'response.failed') terminal = ev.response
    }
    assertEquals([terminal?.id, terminal?.status, terminal?.error.code], [id, 'cancelled', 'cancelled'])
    await assertStopped(pids(await r.evidence()))
    const retry = await gw.post({ ...initial('again'), previous_response_id: terminal.id })
    assertEquals([retry.status, (await retry.json()).error.code], [400, 'previous_response_not_found'])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: instructions concatenate, warm-up generates on the follow-up, namespaces stay unsupported', async () => {
  const r = await rig()
  try {
    const gw = await r.start(), ws = new WsClient(new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses'))
    try {
      const base = { model: MODEL, tools: [] as unknown[] }
      const top = 'Top-level prompt.\r\n'
      const developer = { type: 'message', ...message('developer', [{ type: 'input_text', text: 'Developer: é' }, { type: 'input_text', text: '\n' }]) }
      const system = message('system', 'System: e\u0301\n ')
      const input = [developer, system, user('Start coding.')]
      const sent = { ...base, instructions: top, input }
      const bad = await gw.post({ ...sent, tools: [{ type: 'namespace', name: 'multi_agent_v1' }] })
      const rejected = await bad.json()
      assertEquals([bad.status, rejected.error.code, rejected.error.param], [400, 'unsupported', 'tools[0].type'])
      const expected = top + 'Developer: é\nSystem: e\u0301\n '
      const http = await gw.create(sent)
      assertEquals(http.response.instructions, expected)
      assertEquals(text(http.response), 'answer:Start coding.')
      const warm = await ws.send({ ...sent, generate: false, input: [developer] })
      assertEquals([warm.status, warm.response.output], ['completed', []])
      const actual = await ws.send({ ...base, instructions: top, previous_response_id: warm.response.id, input: input.slice(1) })
      assertEquals([actual.status, actual.response.instructions, text(actual.response)], ['completed', expected, 'answer:Start coding.'])
      const history = [developer, system, user('batch')]
      const round = await ws.send({ ...sent, tools: [tool()], input: history })
      assertEquals(calls(round.response).length, 3)
      const finalized = round.events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)
      const replay = await gw.create({ ...sent, tools: [tool()], input: [...history, ...finalized, ...outputs(round.response), user('Use the results.')] })
      assertEquals([replay.response.x_gateway.path, replay.response.previous_response_id], ['live', null])
      assertEquals(JSON.parse(text(replay.response)).results, ['result-0', 'result-1', 'result-2'])
    } finally {
      await ws.close()
    }
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: kernel-shaped bodies and JSON function arguments', async () => {
  const r = await rig()
  try {
    const gw = await r.start(), ws = new WsClient(new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses'))
    try {
      const first = await ws.send(kernelBody({ ...initial('batch'), input: [user('batch')] }))
      assertEquals(calls(first.response).length, 3)
      const next = await ws.send(kernelBody({ ...follow(first.response, outputs(first.response)), tools: [tool()] }))
      assertEquals(next.response.x_gateway.path, 'live')
      assertEquals(JSON.parse(text(next.response)).results, ['result-0', 'result-1', 'result-2'])
    } finally {
      await ws.close()
    }
    // a full create whose history carries no record is refused: the agy lane never renders history as text
    const call = { type: 'function_call', call_id: 'call_pi', name: 'echo', arguments: '{"a":"text"}' }
    const refused = await gw.post({
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool('echo')],
      input: [user('Use the tool.'), call, result(call, 'Tool output')],
    })
    assertEquals([refused.status, (await refused.json()).error.code], [400, 'provider_record_missing'])
    // a record-backed history still matches when the client reserialized its function arguments
    const round = await gw.create({ model: MODEL, instructions: INSTRUCTIONS, tools: [tool()], input: [user('batch')] })
    const finalized = round.response.output
    const reserialized = finalized.map((item: any) => item.type === 'function_call'
      ? { ...item, arguments: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(item.arguments)).reverse())) }
      : item)
    const ended = await gw.create(follow(round.response, outputs(round.response)))
    const replay = await gw.create({
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [user('batch'), ...reserialized, ...outputs(round.response), ...ended.response.output, user('Again.')],
    })
    // both records matched: the reserialized call arguments did not break the run
    assertEquals([replay.response.status, replay.response.x_gateway.records], ['completed', 2])
    assertEquals(text(replay.response), 'answer:Again.')
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: an unchecked version is refused at startup', async () => {
  const r = await rig('version')
  try {
    const compiled = Deno.env.get('AGY_TEST_GATEWAY')
    const child = new Deno.Command(compiled ?? Deno.execPath(), {
      args: [...(compiled ? [] : ['run', '-A', main]), '--port', '0', '--state-dir', r.state, '--agy', r.fake],
      stdout: 'null',
      stderr: 'piped',
    })
    const out = await child.output()
    assertEquals(out.code, 2)
    assertMatch(new TextDecoder().decode(out.stderr), /agy version 9\.9\.9 is not checked/)
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a default-agent fallback is refused before any prompt', async () => {
  const r = await rig('fallback-agent')
  try {
    const gw = await r.start()
    const failure = await gw.post(initial('do not send'))
    assertEquals(failure.status, 500)
    assertMatch((await failure.json()).error.message, /default agent; no prompt was sent/)
    assertEquals((await r.evidence()).filter((e) => e.kind === 'prompt').length, 0)
    await gw.stop()
  } finally {
    await r.dispose()
  }
})
