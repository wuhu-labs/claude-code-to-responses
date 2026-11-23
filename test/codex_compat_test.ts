import { assert, assertEquals, assertExists, assertRejects } from '@std/assert'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { output, send, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'
import type { WsClient } from './websocket_client.ts'

const base = { model: MODEL, tools: TOOLS, stream: true, store: false, reasoning: { effort: 'low', summary: 'auto' } }
const developer = (text: string) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] })

async function httpError(run: Run, body: Json) {
  const res = await fetch(`${run.tg.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const { error } = await res.json()
  return [res.status, error.code, error.param]
}

async function wsError(ws: WsClient, body: Json) {
  const error = await assertRejects(() => ws.send(body)) as { status?: number; code?: string; param?: string }
  return [error.status, error.code, error.param]
}

Deno.test('Codex client metadata is ignored across transports, and non-function tools stay refused', async () => {
  const run = new Run('codex-fields', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    const body = { ...base, instructions: INSTRUCTIONS, input: 'New turn' }
    for (
      const [fields, code, param] of [
        ...[null, [], 1, false, 'string'].map((client_metadata) => [{ client_metadata }, 'invalid_request', 'client_metadata'] as const),
        ...['web_search', 'namespace'].map((type) => [{ tools: [{ type }] }, 'unsupported', 'tools[0].type'] as const),
        [{ stream: false }, 'unsupported', 'stream'],
      ] as const
    ) {
      assertEquals(await httpError(run, { ...body, ...fields }), [400, code, param])
      assertEquals(await wsError(ws, { ...body, ...fields }), [400, code, param])
    }
    for (const generate of [true, false]) assertEquals(await httpError(run, { ...body, generate }), [400, 'unsupported', 'generate'])
    assertEquals(run.fake.exchanges.length, 0)

    const secret = 'discard-this-client-metadata'
    const a = await send(run.tg.client, { ...body, client_metadata: { turn_id: secret } })
    const b = await ws.send({ ...body, generate: true, previous_response_id: a.response.id, client_metadata: { nested: [secret, 2] } })
    const c = await send(run.tg.client, { ...body, previous_response_id: b.response.id, client_metadata: {} })
    assertEquals([a.status, b.status, c.status], ['completed', 'completed', 'completed'])
    assertEquals([b.response.x_gateway.path, c.response.x_gateway.path], ['live', 'live'])
    assertEquals(run.fake.main().length, 3)
    for (const result of [a, b, c]) {
      const wire = JSON.stringify(result.events)
      assert(!wire.includes('client_metadata') && !wire.includes(secret))
      const record = await decodeRecord(result.response.output.at(-1).encrypted_content)
      assertExists(record)
      assert(!JSON.stringify(record).includes(secret))
    }
    assert(run.fake.exchanges.every((ex) => !ex.raw.includes(secret)))
    // SSE retains opaque provider content in both item events and the terminal response.
    const item = a.response.output.at(-1)
    for (const type of ['response.output_item.added', 'response.output_item.done']) {
      assertEquals(a.events.find((event) => event.type === type && event.item.id === item.id)?.item, item)
    }
  })
})

Deno.test('WebSocket warm-up is validated and socket-local, with no process, backend request or durable response', async () => {
  const run = new Run('codex-warmup', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    const body = { ...base, generate: false, input: [developer(INSTRUCTIONS)] }
    assertEquals(await wsError(ws, { ...body, generate: 'false' }), [400, 'invalid_request', 'generate'])
    assertEquals(await wsError(ws, { ...body, model: '' }), [400, 'invalid_request', 'model'])
    assertEquals(await wsError(ws, { ...body, input: false }), [400, 'invalid_request', 'input'])
    assertEquals(await wsError(ws, { ...body, tools: [{ type: 'namespace' }] }), [400, 'unsupported', 'tools[0].type'])
    assertEquals(await wsError(ws, { ...body, instructions: 'conflicting' }), [400, 'invalid_request', 'instructions'])
    const warm = await ws.send({ ...body, client_metadata: {} })
    assertEquals(warm.events.map((e) => [e.type, e.sequence_number]), [['response.created', 0], ['response.completed', 1]])
    assertEquals(warm.events[0].response.status, 'in_progress')
    assertEquals(warm.events[0].response.id, warm.response.id)
    assertEquals(warm.status, 'completed')
    assertEquals(warm.response.output, [])
    assertEquals([warm.response.usage.input_tokens, warm.response.usage.output_tokens, warm.response.usage.total_tokens], [0, 0, 0])
    assertEquals(run.fake.exchanges.length, 0)
    assertEquals(run.tg.events('spawn').length, 0)
    const cancel = await fetch(`${run.tg.url}/v1/responses/${warm.response.id}/cancel`, { method: 'POST' })
    assertEquals([cancel.status, (await cancel.json()).error.code], [404, 'not_found'])
    const continuation = { ...base, previous_response_id: warm.response.id, input: [developer('More instructions.'), user('First turn.')] }
    const missing = [400, 'previous_response_not_found', 'previous_response_id']
    assertEquals(await httpError(run, continuation), missing)
    assertEquals(await wsError(run.tg.websocket(), continuation), missing)
    for (const previous_response_id of ['resp_missing', warm.response.id]) {
      assertEquals(await wsError(ws, { ...body, previous_response_id }), [400, 'unsupported', 'previous_response_id'])
    }
    const replacement = await ws.send({ ...body, previous_response_id: null, input: [developer('New warm-up.')] })
    assertEquals([replacement.status, replacement.response.previous_response_id], ['completed', null])
    assert(warm.response.id !== replacement.response.id)
    assertEquals(await wsError(ws, continuation), missing)
    await ws.close()
    assertEquals(await wsError(run.tg.websocket(), { ...continuation, previous_response_id: replacement.response.id }), missing)
    assertEquals(run.fake.exchanges.length, 0)
  })
})

Deno.test('WebSocket warm-up plus continuation sends the same upstream bytes as the combined full create', async () => {
  const run = new Run('codex-warmup-bytes', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    const prefix = [{ role: 'system', content: '\n  first\r\n' }]
    const suffix = [developer('é vs. e\u0301\n'), user('Work from this prompt.')]
    const warm = await ws.send({ ...base, model: 'warmup-only', input: prefix, generate: false, tools: [], max_output_tokens: 2048 })
    const actual = { ...base, metadata: { stage: 'generation' }, max_output_tokens: 4096 }
    const split = await ws.send({ ...actual, previous_response_id: warm.response.id, input: suffix })
    const full = await ws.send({ ...actual, input: [...prefix, ...suffix] })
    assertEquals([split.status, full.status], ['completed', 'completed'])
    assertEquals([split.response.x_gateway.path, split.response.previous_response_id], ['new', null])
    assertEquals(split.response.metadata, { stage: 'generation' })
    assertEquals(run.fake.main().length, 2)
    const [a, b] = run.fake.main()
    assertEquals(run.normalize(a.raw), run.normalize(b.raw))

    assertEquals(await wsError(ws, { ...actual, previous_response_id: warm.response.id, input: suffix, instructions: 'Conflict.' }), [
      400,
      'invalid_request',
      'instructions',
    ])

    const top = await ws.send({ ...base, instructions: INSTRUCTIONS, generate: false, input: 'Already sent during warm-up.' })
    const delta = { ...base, previous_response_id: top.response.id }
    assertEquals(await wsError(ws, { ...delta, input: [developer('Too late.')] }), [400, 'unsupported', 'input[1].role'])
    const inherited = await ws.send({ ...delta, input: [] })
    assertEquals(inherited.status, 'completed')
    assertEquals(inherited.response.instructions, INSTRUCTIONS)
    const replaced = await ws.send({ ...delta, input: [], instructions: 'New instructions.' })
    assertEquals(replaced.status, 'completed')
    assertEquals(replaced.response.instructions, 'New instructions.')
  })
})

Deno.test('Codex-shaped WebSocket tool round rebuilds solely from finalized output items on a new socket', async () => {
  const run = new Run('codex-history', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    const prefix = [developer(INSTRUCTIONS)]
    const rest = [developer('\nRound trip.'), user('Call both tools.')]
    run.fake.reply({ blocks: [call('toolu_echo', 'echo', { text: 'one' }), call('toolu_read', 'read', { name: 'two' })] }, { blocks: [text('Done.')] })
    const warm = await ws.send({ ...base, input: prefix, generate: false, client_metadata: { turn_id: 'warm' } })
    const a = await ws.send({ ...base, previous_response_id: warm.response.id, input: rest, client_metadata: { turn_id: 'turn' } })
    assertEquals([a.status, a.response.x_gateway.path], ['completed', 'new'])
    const finalized = (r: typeof a): Json[] => {
      const items = r.events.filter((ev) => ev.type === 'response.output_item.done').map((ev) => ev.item)
      const record = items.find((item) => item.type === 'reasoning')
      assertExists(record?.encrypted_content)
      assertEquals(r.events.find((ev) => ev.type === 'response.output_item.added' && ev.item.id === record.id)?.item, record)
      assertEquals(r.events.at(-1).response.output.find((item: Json) => item.id === record.id)?.encrypted_content, undefined)
      return items
    }
    const first = finalized(a)
    const calls = first.filter((item) => item.type === 'function_call')
    assertEquals(calls.map((c) => c.name), ['echo', 'read'])
    const outputs = calls.map((c) => output(c.call_id, `Result from ${c.name}`))
    const b = await ws.send({ ...base, previous_response_id: a.response.id, input: outputs })
    assertEquals([b.status, b.response.x_gateway.path], ['completed', 'live'])
    const second = finalized(b)
    await ws.close()
    const newWs = run.tg.websocket()
    const resumedWarm = await newWs.send({ ...base, input: prefix, generate: false })
    const resumed = await newWs.send({
      ...base,
      previous_response_id: resumedWarm.response.id,
      input: [...rest, ...first, ...outputs, ...second, user('What were the results?')],
    })
    const { path, records, synthesized_groups } = resumed.response.x_gateway
    assertEquals([resumed.status, path, records, synthesized_groups], ['completed', 'history', 2, 0])
    assertEquals(run.fake.main().length, 3)
  })
})
