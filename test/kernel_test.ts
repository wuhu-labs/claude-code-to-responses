import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { parseRequest } from '../src/api/request.ts'
import { GatewayError } from '../src/errors.ts'
import { decodeRecord, encodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { assertPrefix, user } from './harness.ts'
import { kernelBody } from './kernel_shapes.ts'
import { MODEL, Run, TOOLS } from './scenario.ts'

const base = () => kernelBody({ model: MODEL, instructions: 'You are helpful.', tools: TOOLS, input: [user('Hello')] })
function bad(body: Json, code: string, param: string) {
  const e = assertThrows(() => parseRequest(body, 'websocket'), GatewayError)
  assertEquals([e.status, e.code, e.param], [400, code, param])
}

Deno.test('real monorepo recording bodies: full create and named forced compaction, on both transports', async () => {
  for (const name of ['wuhu-full-create', 'wuhu-forced-compact']) {
    const body = JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}.json`, import.meta.url)))
    const http = parseRequest(body)
    const { stream: _stream, ...socketBody } = body
    const ws = parseRequest({ ...socketBody, max_output_tokens: 4096, prompt_cache_key: 'kernel-session' }, 'websocket')
    assertEquals(http.instructions, 'You are a long-running session agent. Keep answers to one sentence.')
    assertEquals(ws.input, http.input)
    assertEquals(ws.tools.map((t) => t.name), ['get_weather', 'compact'])
    if (name === 'wuhu-forced-compact') {
      assertEquals(body.tool_choice, { name: 'compact', type: 'function' })
      assert(ws.input.some((it) => it.kind === 'reasoning' && it.encrypted !== null))
      assert(ws.input.some((it) => it.kind === 'message' && it.role === 'assistant'))
    }
  }
})

Deno.test('kernel full create and warm delta normalize without putting instructions in history', () => {
  const b = base()
  const r = parseRequest(b, 'websocket')
  assertEquals(r.instructions, 'You are helpful.')
  assertEquals(r.maxOutputTokens, 4096)
  assertEquals(r.input, [{ kind: 'message', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }])
  const delta = { ...b, previous_response_id: 'resp_test', input: [{ type: 'function_call_output', call_id: 'provider-call', output: 'tool result' }] }
  assertEquals(parseRequest(delta, 'websocket').instructions, null)
  assertEquals(parseRequest({ ...b, tool_choice: { type: 'function', name: 'echo' } }, 'websocket').tools.length, 2)
})

Deno.test('prompt-less kernel full creates require a nonempty session prompt with an explicit typed error', () => {
  const body = base()
  for (const input of [[user('Hello')], [{ role: 'system', content: '' }, user('Hello')]]) {
    const e = assertThrows(() => parseRequest({ ...body, input }, 'websocket'), GatewayError)
    assertEquals([e.status, e.code, e.param], [400, 'invalid_request', 'instructions'])
    assertEquals(e.message, 'The kernel must carry a nonempty session prompt in top-level instructions or leading system/developer text.')
  }
})

Deno.test('instruction joining is literal concatenation of leading parts/messages, never trimmed or separated', () => {
  const b = base()
  b.input = [
    { role: 'system', content: [{ type: 'input_text', text: '  a\n' }, { type: 'input_text', text: '' }, { type: 'input_text', text: 'é' }] },
    { type: 'message', role: 'developer', content: '\r\n e\u0301  ' },
    { role: 'developer', content: [{ type: 'input_text', text: '\n' }] },
    user('Hello'),
  ]
  assertEquals(parseRequest(b, 'websocket').instructions, '  a\né\r\n e\u0301  \n')
  assertEquals(parseRequest({ ...b, input: [user('Hello')], instructions: '  explicit\n' }, 'websocket').instructions, '  explicit\n')
})

Deno.test('invalid kernel-adjacent shapes are typed errors, not dropped or rerouted', () => {
  const b = base()
  bad({ ...b, instructions: 'also top level' }, 'invalid_request', 'instructions')
  bad({ ...b, input: [user('Hello'), { role: 'system', content: 'late' }] }, 'unsupported', 'input[1].role')
  bad({ ...b, instructions: 'x', input: [user('Hello'), { role: 'developer', content: 'late' }] }, 'unsupported', 'input[1].role')
  bad({ ...b, previous_response_id: 'resp_test' }, 'unsupported', 'input[0].role')
  bad(
    { ...b, input: [{ role: 'system', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }, user('Hello')] },
    'unsupported',
    'input[0].content[0].type',
  )
  for (const value of [0, -1, 1.5, '4096', Number.MAX_SAFE_INTEGER + 1]) bad({ ...b, max_output_tokens: value }, 'invalid_request', 'max_output_tokens')
  bad({ ...b, reasoning: { effort: 'high', summary: 'detailed' } }, 'unsupported', 'reasoning.summary')
  bad({ ...b, reasoning: { effort: 'medium', summary: 'auto', max_tokens: 1000 } }, 'unsupported', 'reasoning.max_tokens')
  bad({ ...b, temperature: 0.5 }, 'unsupported', 'temperature')
  bad({ ...b, tool_choice: 'required' }, 'unsupported', 'tool_choice')
  bad({ ...b, tool_choice: { type: 'function', name: 'absent' } }, 'invalid_request', 'tool_choice.name')
  bad({ ...b, tools: [{ type: 'web_search' }] }, 'unsupported', 'tools[0].type')
  bad({ ...b, input: [...b.input, { type: 'web_search_call', id: 'ws_1' }] }, 'unsupported', 'input[2].type')
  const neutral = { ...b, parallel_tool_calls: true, text: { format: { type: 'text' }, verbosity: 'medium' }, metadata: { session: 'test' } }
  assertEquals(parseRequest(neutral, 'websocket').metadata, { session: 'test' })
})

Deno.test('kernel WebSocket delta inherits durable instructions, enforces cap/chain identity, and named compaction does not force a tool', async () => {
  const run = new Run('kernel-contract', false, { transport: 'websocket' })
  await run.run(async () => {
    let ws = run.tg.websocket()
    const b = base()
    run.fake.reply({ blocks: [call('toolu_kernel', 'echo', { text: 'x' })] })
    const first = await ws.send(b)
    assertEquals(first.status, 'completed')
    assertEquals(run.fake.main()[0].body.system[2].text, 'You are helpful.')
    assertEquals(run.fake.main()[0].body.max_tokens, 4096)
    assertEquals(first.response.max_output_tokens, 4096)
    const delta = { ...b, previous_response_id: first.response.id, input: [{ type: 'function_call_output', call_id: 'toolu_kernel', output: 'tool result' }] }
    for (const change of [{ instructions: 'different' }, { max_output_tokens: 8192 }, { max_output_tokens: null }]) {
      const e = await assertRejects(() => ws.send({ ...delta, ...change })) as Json
      assertEquals([e.status, e.code], [400, 'previous_response_not_found'])
    }
    assertEquals(run.fake.main().length, 1)
    await run.disrupt('restart')
    ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('done')] })
    const second = await ws.send(delta)
    assertEquals([second.status, second.response.instructions, second.response.x_gateway.path], ['completed', 'You are helpful.', 'store'])
    assertEquals(run.fake.main()[1].body.max_tokens, 4096)
    assertPrefix(run.fake.main()[0], run.fake.main()[1])
    const forced = {
      ...b,
      tool_choice: { type: 'function', name: 'echo' },
      input: [...b.input, ...first.response.output, ...delta.input, ...second.response.output, user('compact now')],
    }
    run.fake.reply({ blocks: [text('no tool called')] })
    const compact = await ws.send(forced)
    assertEquals(compact.status, 'completed')
    assertEquals(compact.response.output.filter((i: Json) => i.type === 'function_call'), [])
    assertEquals(compact.response.tool_choice, 'auto')
    assertEquals(compact.response.x_gateway.records, 2)
    assertPrefix(run.fake.main()[1], run.fake.main()[2])
  })
})

Deno.test('legacy record without saved instructions inherits its live lane prompt on a kernel delta', async () => {
  const run = new Run('kernel-legacy-live', false, { transport: 'websocket' })
  await run.run(async () => {
    const body = base(), ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('one')] })
    const first = await ws.send(body)
    const record = run.tg.gw.store.get(first.response.id)!
    delete record.instructions
    run.tg.gw.store.put(record)
    run.fake.reply({ blocks: [text('two')] })
    const second = await ws.send({ ...body, previous_response_id: first.response.id, input: [user('next')] })
    assertEquals([second.status, second.response.instructions, second.response.x_gateway.path], ['completed', 'You are helpful.', 'live'])
    assertEquals(second.response.x_gateway.session, first.response.x_gateway.session)
    assertEquals(run.tg.events('spawn').length, 1)
    assertPrefix(run.fake.main()[0], run.fake.main()[1])
    assertEquals(run.tg.gw.store.get(second.response.id)!.instructions, 'You are helpful.')
  })
})

Deno.test('legacy provider records work with explicit instructions; omitted instructions fail typed after restart', async () => {
  const run = new Run('kernel-legacy', false, { transport: 'websocket' })
  await run.run(async () => {
    const b = base(), ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('one')] })
    const first = await ws.send(b)
    const rec = run.tg.gw.store.get(first.response.id)!
    delete rec.instructions
    run.tg.gw.store.put(rec)
    await run.disrupt('restart')
    const delta = { ...b, previous_response_id: first.response.id, input: [user('next')] }
    const next = run.tg.websocket()
    const e = await assertRejects(() => next.send(delta)) as Json
    assertEquals(e.code, 'previous_response_not_found')
    run.fake.reply({ blocks: [text('two')] })
    assertEquals((await next.send({ ...delta, instructions: 'You are helpful.' })).status, 'completed')
    const opaque = await encodeRecord({ ...rec, instructions: 42 } as Json)
    await assertRejects(() => decodeRecord(opaque))
  })
})

Deno.test('no-auth gateway ignores the kernel bearer on HTTP and WebSocket upgrades', async () => {
  const run = new Run('kernel-bearer', false)
  await run.run(async () => {
    assertEquals(run.tg.gw.config.authToken, undefined)
    run.fake.reply({ blocks: [text('hello')] })
    // The SDK always sends Bearer unused when authToken is absent.
    const r = await run.turn('hello')
    assertEquals(r.status, 'completed')
    const u = new URL(run.tg.url)
    const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port) })
    try {
      await conn.write(
        new TextEncoder().encode(
          `GET /v1/responses HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer kernel-placeholder\r\n\r\n`,
        ),
      )
      const buf = new Uint8Array(4096)
      const n = await conn.read(buf)
      assert(n !== null)
      assert(new TextDecoder().decode(buf.subarray(0, n)).startsWith('HTTP/1.1 101'))
    } finally {
      conn.close()
    }
  })
})
