import { assert, assertEquals, assertMatch } from '@std/assert'
import { createHash } from 'node:crypto'
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

Deno.test('agy: a full-history release on a live held batch steers it with only the new messages', async () => {
  const r = await rig()
  try {
    const gw = await r.start(), ws = new WsClient(new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses'))
    const tools = [tool()]
    try {
      const send = (body: any) => ws.send(body)
      const turn = user('Remember one.')
      const first = (await send({ model: MODEL, instructions: INSTRUCTIONS, tools, input: [turn] })).response
      const batch = (await send({ model: MODEL, instructions: INSTRUCTIONS, previous_response_id: first.id, input: [user('batch')] })).response
      const held = outputs(batch)
      // the client resends the whole history with the outputs and one new message, on the live held process
      const full = {
        model: MODEL,
        instructions: INSTRUCTIONS,
        tools,
        input: [turn, ...first.output, user('batch'), ...batch.output, ...held, user('only this notice')],
      }
      const released = await send(full)
      assertEquals(released.response.x_gateway.path, 'live')
      assertEquals(JSON.parse(text(released.response)), {
        results: ['result-0', 'result-1', 'result-2'],
        messages: [{ userMessage: 'only this notice' }],
      })
    } finally {
      await ws.close()
    }
    // the same over SSE
    const sseTurn = user('Remember two.')
    const first = await gw.create({ ...initial(''), input: [sseTurn] })
    const batch = await gw.create(follow(first.response, [user('batch')]))
    const full = {
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [sseTurn, ...first.response.output, user('batch'), ...batch.response.output, ...outputs(batch.response), user('only this notice')],
    }
    const released = await gw.create(full)
    assertEquals(released.response.x_gateway.path, 'live')
    assertEquals(JSON.parse(text(released.response)).messages, [{ userMessage: 'only this notice' }])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a history rebuild refills the gateway store, and a cached chain prefers the store', async () => {
  const r = await rig()
  try {
    let gw = await r.start()
    const turn = user('Remember the marker.')
    const history: any[] = [turn]
    const first = await gw.create({ ...initial(''), input: [turn] })
    history.push(...first.response.output)
    const batch = await gw.create(follow(first.response, [user('batch')]))
    history.push(user('batch'), ...batch.response.output)
    const outputsAtHead = outputs(batch.response)
    // losing the state: the history rebuild must put the whole chain back into the store
    await gw.stop()
    await Deno.remove(r.state, { recursive: true })
    gw = await r.start()
    const rebuilt = await gw.create({ model: MODEL, instructions: INSTRUCTIONS, tools: [tool()], input: [...history, ...outputsAtHead] })
    assertEquals([rebuilt.response.x_gateway.path, rebuilt.response.x_gateway.patched], ['history', 3])
    // a delta naming the rebuilt response works: the chain is in the store again
    const next = await gw.create(follow(rebuilt.response, [user('After the rebuild.')]))
    assertEquals(next.response.status, 'completed')
    assert(['live', 'store'].includes(next.response.x_gateway.path), JSON.stringify(next.response.x_gateway))
    // and a full-history request at a cached parent takes the store, not the history route
    await gw.stop()
    gw = await r.start()
    const cached = await gw.create({ model: MODEL, instructions: INSTRUCTIONS, tools: [tool()], input: [...history, ...outputsAtHead, user('Again.')] })
    assertEquals([cached.response.status, cached.response.x_gateway.path], ['completed', 'store'])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: absent planner falls back to one call per response, without a second ACP prompt', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    let { response } = await gw.create(initial('missing-planner'))
    try {
    for (let i = 0; i < 3; i++) {
      assertEquals(calls(response).map((c: any) => JSON.parse(c.arguments).index), [i])
      ;({ response } = await gw.create(follow(response, [result(calls(response)[0], `fallback-${i}`)])))
    }
    assertEquals(JSON.parse(text(response)).results, ['fallback-0', 'fallback-1', 'fallback-2'])
    assertEquals((await r.evidence()).filter((e) => e.kind === 'prompt').length, 1)
    assertMatch(gw.stderr.join('\n'), /emitting one call/)
    } catch (e) { console.error('STDERR', gw.stderr.join('\n')); throw e }
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: an untested binary stamps its own version and never assembles or patches the pinned store', async () => {
  const r = await rig('version')
  try {
    const gw = await r.start(['--allow-untested-agy', '--hold-timeout', '0.2'])
    const first = await gw.create(initial('Remember one.'))
    assertEquals(first.response.x_gateway.path, 'new')
    const record = first.response.output.find((item: any) => item.type === 'reasoning' && item.encrypted_content)?.encrypted_content
    const decoded = await unpackRecord(AGY_RECORD_PREFIX, record) as any
    assertEquals(decoded.agy, '9.9.9')
    // a live continuation still works
    const batch = await gw.create(follow(first.response, [user('batch')]))
    assertEquals(calls(batch.response).length, 3)
    const live = await gw.create(follow(batch.response, outputs(batch.response)))
    assertEquals(live.response.x_gateway.path, 'live')
    // a rebuild that would assemble the store or write a step is refused before any process
    const held = await gw.create(follow(live.response, [user('pair')]))
    await assertStopped(pids(await r.evidence()))
    const rebuilt = await gw.post(follow(held.response, outputs(held.response)))
    assertEquals(rebuilt.status, 500)
    const refusal = await rebuilt.json()
    assertEquals(refusal.error.code, 'store_unreadable')
    assertMatch(refusal.error.message, /not the measured 1\.5\.17/)
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a rebuild under other paths continues and says so', async () => {
  const a = await rig(), b = await rig()
  try {
    const first = await a.start()
    const turn = user('Remember the marker.')
    const response = await first.create({ ...initial(''), input: [turn] })
    assertEquals(response.response.x_gateway.paths, undefined)
    await first.stop()
    const second = await b.start()
    const moved = await second.create({ model: MODEL, instructions: INSTRUCTIONS, tools: [tool()], input: [turn, ...response.response.output, user('Again.')] })
    assertEquals(moved.response.status, 'completed')
    assertEquals([moved.response.x_gateway.path, moved.response.x_gateway.paths], ['history', 'elsewhere'])
    await second.stop()
  } finally {
    await a.dispose()
    await b.dispose()
  }
})

Deno.test('agy: pending steps the record does not name are refused before any write', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--hold-timeout', '0.2'])
    const { response } = await gw.create(initial('missing-planner'))
    // the planner was absent, so the record names one call while agy wrote three pending rows
    assertEquals(calls(response).length, 1)
    await assertStopped(pids(await r.evidence()))
    const conversation = response.x_gateway.conversation
    const db = `${r.state}/gemini/antigravity-cli/conversations/${conversation}.db`
    const before = createHash('sha256').update(await Deno.readFile(db)).digest('hex')
    const refused = await gw.post(follow(response, [result(calls(response)[0], 'one')]))
    assertEquals([refused.status, (await refused.json()).error.code], [400, 'store_mismatch'])
    const after = createHash('sha256').update(await Deno.readFile(db)).digest('hex')
    assertEquals(after, before, 'the refused rebuild wrote the store')
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a chain head without its trajectory blob is refused before any process starts', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--idle-timeout', '0.2', '--hold-timeout', '0.2'])
    const response = await gw.create(initial('Remember the marker.'))
    await assertStopped(pids(await r.evidence()))
    const processes = (await r.evidence()).filter((e) => e.kind === 'process').length
    const record = response.response.output.find((item: any) => item.type === 'reasoning' && item.encrypted_content)?.encrypted_content
    const decoded = await unpackRecord(AGY_RECORD_PREFIX, record) as any
    assert(decoded.trajectory?.blob, 'the head record has no trajectory blob to drop')
    const headless = await packRecord(AGY_RECORD_PREFIX, { ...decoded, trajectory: { ...decoded.trajectory, blob: null } })
    const items = response.response.output.filter((item: any) => !(item.type === 'reasoning' && item.encrypted_content?.startsWith(AGY_RECORD_PREFIX)))
    const refused = await gw.post({
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [user('Remember the marker.'), ...items, { type: 'reasoning', summary: [], encrypted_content: headless }, user('Again.')],
    })
    assertEquals([refused.status, (await refused.json()).error.code], [400, 'provider_record_missing'])
    assertEquals((await r.evidence()).filter((e) => e.kind === 'process').length, processes)
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: steering keeps user, developer and system messages on a held-call delta', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--hold-timeout', '0.2'])
    const { response } = await gw.create(initial('batch'))
    const notices = [message('user', 'user notice'), message('developer', 'observation'), message('system', 'system notice')]
    const live = await gw.create(follow(response, [...outputs(response), ...notices]))
    assertEquals(live.response.x_gateway.path, 'live')
    assertEquals(JSON.parse(text(live.response)), {
      results: ['result-0', 'result-1', 'result-2'],
      messages: [
        { userMessage: 'user notice' },
        { systemMessage: { systemMessage: 'observation' } },
        { systemMessage: { systemMessage: 'system notice' } },
      ],
    })
    // the same three roles on a rebuilt conversation: the user message is the prompt, the other two ride the hook
    const second = await gw.create(follow(live.response, [user('pair')]))
    await assertStopped(pids(await r.evidence()))
    const rebuilt = await gw.create(follow(second.response, [...outputs(second.response, 'after'), ...notices]))
    assertEquals([rebuilt.response.x_gateway.path, rebuilt.response.x_gateway.patched], ['store', 2])
    const evidence = await r.evidence()
    assertEquals(evidence.filter((e) => e.kind === 'prompt').at(-1).text, 'user notice')
    const hooks = evidence.filter((e) => e.kind === 'hook' && e.invocationNum === 0)
    assertEquals(hooks.at(-1).steps, [
      { systemMessage: { systemMessage: 'observation' } },
      { systemMessage: { systemMessage: 'system notice' } },
    ])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a socket that leaves during planning does not evict the live lane', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    const first = await gw.create(initial('Remember one.'))
    const held = await gw.create(follow(first.response, [user('batch')]))
    const conversation = first.response.x_gateway.conversation
    const db = `${r.state}/gemini/antigravity-cli/conversations/${conversation}.db`
    const before = createHash('sha256').update(await Deno.readFile(db)).digest('hex')
    const dispatched = (await r.evidence()).length
    // a full history whose head is the first response, on a socket closed right after the create
    const socket = new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses')
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
    socket.send(JSON.stringify({
      type: 'response.create',
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [user('Remember one.'), ...first.response.output, user('Again.')],
    }))
    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // the socket that left did nothing on its behalf: it launched no process and assembled no store
    assertEquals((await r.evidence()).slice(dispatched).filter((e) => e.kind !== 'hook' && e.kind !== 'prompt'), [])
    assertEquals(createHash('sha256').update(await Deno.readFile(db)).digest('hex'), before, 'the closed socket assembled the store')
    // the lane that was holding the batch is still the chain's live process, and the chain is not reserved
    const live = await gw.create(follow(held.response, outputs(held.response)))
    assertEquals([live.response.status, live.response.x_gateway.path], ['completed', 'live'])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: a socket that leaves while its history is being matched writes nothing', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--hold-timeout', '0.2'])
    const { response } = await gw.create(initial('batch'))
    await assertStopped(pids(await r.evidence()))
    const conversation = response.x_gateway.conversation
    const db = `${r.state}/gemini/antigravity-cli/conversations/${conversation}.db`
    const before = createHash('sha256').update(await Deno.readFile(db)).digest('hex')
    const socket = new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses')
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
    socket.send(JSON.stringify({
      type: 'response.create',
      model: MODEL,
      instructions: INSTRUCTIONS,
      tools: [tool()],
      input: [user('batch'), ...response.output, ...outputs(response)],
    }))
    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = createHash('sha256').update(await Deno.readFile(db)).digest('hex')
    assertEquals(after, before, 'the cancelled request assembled the store')
    // the chain is free and its store untouched: the same release now works and completes the calls
    const released = await gw.create(follow(response, outputs(response)))
    assertEquals([released.response.status, released.response.x_gateway.path, released.response.x_gateway.patched], ['completed', 'store', 3])
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: one validator, one outcome for every kind of unusable reasoning, in both modes', async () => {
  const r = await rig()
  try {
    const gw = await r.start(['--idle-timeout', '0.2', '--hold-timeout', '0.2'])
    const first = await gw.create(initial('batch'))
    const record = first.response.output.find((item: any) => item.type === 'reasoning' && item.encrypted_content)?.encrypted_content
    const decoded = await unpackRecord(AGY_RECORD_PREFIX, record!) as any
    const items = first.response.output.filter((item: any) => !(item.type === 'reasoning' && item.encrypted_content?.startsWith(AGY_RECORD_PREFIX)))
    const withRecord = (content: string) => ({ type: 'reasoning', summary: [], encrypted_content: content })
    const olderVersion = await packRecord(AGY_RECORD_PREFIX, { ...decoded, agy: '1.5.16' })
    const claude = await packRecord('cc2r.record.v1.', { v: 1 })
    const oldEnvelope = await packRecord('agy2r.record.v0.', decoded)
    const badBase64 = await packRecord(AGY_RECORD_PREFIX, { ...decoded, steps: [{ ...decoded.steps[0], step_payload: 'A' }] })
    const corrupt = `${AGY_RECORD_PREFIX}not-gzip`
    const notARecord = encodeThinkingText()
    const cases: [string, string, string | null][] = [
      ['a corrupt record', corrupt, 'invalid_provider_record'],
      ['another agy version', olderVersion, 'provider_record_foreign'],
      ["the Claude lane's record", claude, 'provider_record_foreign'],
      ['an older agy envelope', oldEnvelope, 'provider_record_foreign'],
      ['invalid base64 in a row', badBase64, 'invalid_provider_record'],
      ['a thinking item', notARecord, null],
    ]
    for (const [name, content, code] of cases) {
      // a delta naming the chain head reads every reasoning item it was sent
      const delta = await gw.post(follow(first.response, [withRecord(content)]))
      // and a full history reads the record beside the response it closes
      const full = await gw.post({
        model: MODEL,
        instructions: INSTRUCTIONS,
        tools: [tool()],
        input: [user('batch'), user('batch'), ...items, withRecord(content), user('Again.')],
      })
      if (code === null) {
        // a thinking item carries no record: the delta drops it and goes on to the missing outputs
        assertEquals([name, delta.status, (await delta.json()).error.code], [name, 400, 'missing_tool_output'])
        continue
      }
      assertEquals([name, delta.status, (await delta.json()).error.code], [name, 400, code], `${name} (delta)`)
      assertEquals([name, full.status, (await full.json()).error.code], [name, 400, code], `${name} (full history)`)
    }
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

/** agy's own thinking text: a reasoning item with no opaque content at all, which is the lane's state already. */
function encodeThinkingText(): string {
  return ''
}

/** One transport's way of sending a create; both answer with the terminal response object. */
function connection(gw: { url: string; create: (body: unknown) => Promise<{ response: any }> }, transport: 'sse' | 'ws') {
  if (transport === 'sse') return { send: async (body: any) => (await gw.create(body)).response, close: async () => {} }
  const ws = new WsClient(new WebSocket(gw.url.replace('http:', 'ws:') + '/v1/responses'))
  return { send: async (body: any) => (await ws.send(body)).response, close: () => ws.close() }
}

/** The transcript the model was shown: user turns, planner lines and resume notices, in order. */
function transcript(visible: string[]): string[] {
  return visible.filter((row) => /^\d+:(14|15|101):/.test(row)).map((row) => row.replace(/^\d+:/, ''))
}

const USER1 = 'Remember the marker KUMQUAT-3311.'

for (const transport of ['sse', 'ws'] as const) {
  for (const disruption of ['live', 'evict', 'restart', 'restart-lost-store'] as const) {
    Deno.test(`agy: ${disruption} over ${transport}: one conversation, one prefix, one system part`, async () => {
      const r = await rig()
      try {
        let gw = await r.start(disruption === 'evict' ? ['--hold-timeout', '0.2'] : [])
        let conn = connection(gw, transport)
        const history: any[] = []
        const send = async (input: any[], previous: string | null) => {
          const body = { model: MODEL, instructions: INSTRUCTIONS, tools: [tool()], input: previous ? input : [...history, ...input] }
          const response = await conn.send(previous ? { ...body, previous_response_id: previous } : body)
          assertEquals(response.status, 'completed', JSON.stringify(response.error))
          history.push(...input, ...response.output)
          return response
        }
        try {
          const first = await send([user(USER1)], null)
          assertEquals(first.x_gateway.path, 'new')
          const batch = await send([user('batch')], first.id)
          assertEquals(calls(batch).length, 3)
          if (disruption === 'evict') await assertStopped(pids(await r.evidence()))
          if (disruption === 'restart' || disruption === 'restart-lost-store') {
            await conn.close()
            await gw.stop()
            if (disruption === 'restart-lost-store') await Deno.remove(r.state, { recursive: true })
            gw = await r.start()
            conn = connection(gw, transport)
          }
          const outputsAtHead = outputs(batch)
          const lost = disruption === 'restart-lost-store'
          const released = await send(outputsAtHead, lost ? null : batch.id)
          assertEquals(released.x_gateway.path, lost ? 'history' : disruption === 'live' ? 'live' : 'store')
          assertEquals(released.x_gateway.patched, disruption === 'live' ? 0 : 3)
          const again = await send([user('And one more, please.')], released.id)
          assertEquals(again.status, 'completed')
          // the live process did the release itself; every rebuild completed the three steps first
          const events = await r.evidence()
          if (disruption !== 'live') {
            const checks = events.filter((e) => e.kind === 'resume-check')
            assertEquals(checks.at(-1).completed.length >= 3, true)
          }
          // every inference's transcript starts with the one before it
          const promptsSeen = promptsOf(events).map((p) => transcript(p.visible))
          for (let i = 1; i < promptsSeen.length; i++) {
            const before = promptsSeen[i - 1], now = promptsSeen[i]
            assert(now.length >= before.length, `prompt ${i}: ${now.length} rows, before ${before.length}`)
            for (let j = 0; j < before.length; j++) assertEquals(now[j], before[j], `prompt ${i} changed transcript row ${j}`)
          }
          // the system part is one thing for the whole conversation: agent text, working folder and tool set
          const processes = events.filter((e) => e.kind === 'process')
          assertEquals(new Set(processes.map((p) => p.cwd)).size, 1, 'the working folder changed within the chain')
          assertEquals(new Set(processes.map((p) => p.instructions)).size, 1, 'the agent text changed within the chain')
          assertEquals(new Set(events.filter((e) => e.kind === 'listed').map((e) => JSON.stringify(e.names))).size, 1, 'the tool set changed')
        } finally {
          await conn.close().catch(() => {})
        }
        await gw.stop()
        await assertStopped(pids(await r.evidence()))
      } finally {
        await r.dispose()
      }
    })
  }
}

Deno.test('agy: a second create on a chain in progress is 409 conversation_busy', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    const first = await gw.create(initial('Remember one.'))
    const inFlight = await gw.post(follow(first.response, [user('hold-generation')]))
    assertEquals(inFlight.status, 200)
    const reader = inFlight.body!.getReader()
    let buffer = ''
    let id = ''
    while (!id) {
      const { value, done } = await reader.read()
      assert(!done, 'the in-flight response ended before it started')
      buffer += new TextDecoder().decode(value)
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6))
        if (event.type === 'response.created') id = event.response.id
      }
    }
    const busy = await gw.post(follow(first.response, [user('another request')]))
    assertEquals([busy.status, (await busy.json()).error.code], [409, 'conversation_busy'])
    const cancelled = await fetch(`${gw.url}/v1/responses/${id}/cancel`, { method: 'POST' })
    assertEquals(cancelled.status, 200)
    await reader.cancel().catch(() => {})
    await gw.stop()
  } finally {
    await r.dispose()
  }
})

Deno.test('agy: naming an earlier response rebuilds at it while a later process is live', async () => {
  const r = await rig()
  try {
    const gw = await r.start()
    const first = await gw.create(initial('Remember one.'))
    const second = await gw.create(follow(first.response, [user('Second turn.')]))
    assertEquals(second.response.x_gateway.path, 'live')
    // the live process sits at the second response; naming the first one rebuilds at it
    const earlier = await gw.create(follow(first.response, [user('From the first response again.')]))
    assertEquals([earlier.response.status, earlier.response.x_gateway.path], ['completed', 'store'])
    // and the rebuilt conversation continues normally
    const next = await gw.create(follow(earlier.response, [user('Onward.')]))
    assertEquals(next.response.status, 'completed')
    await gw.stop()
  } finally {
    await r.dispose()
  }
})
