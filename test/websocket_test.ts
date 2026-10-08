import { rawSocket, readRawFrame, writeAll } from './raw_websocket.ts'
import { replayLog } from '../src/replay.ts'
import { assert, assertEquals, assertExists, assertRejects } from '@std/assert'
import { SocketWriter, WS_DRAIN_TIMEOUT_MS, WS_MAX_BUFFERED_BYTES, WS_MAX_MESSAGE_BYTES } from '../src/websocket.ts'
import { decodeRecord } from '../src/records.ts'
import { noisePng } from './images.ts'
import { call, type Json, text } from './fake.ts'
import { assertPrefix, output, sameRequest, send, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'
import { WsClient } from './websocket_client.ts'

const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
const create = (ws: WsClient, body: Json) => ws.socket.send(JSON.stringify({ type: 'response.create', ...base, ...body }))
async function until(ws: WsClient, type: string): Promise<Json> {
  while (true) {
    const event = await ws.next()
    if (event.type === type) return event
  }
}

Deno.test('WebSocket continuation shares HTTP/SSE chains in both directions, including store rebuild', async () => {
  const run = new Run('ws-mixed', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    run.fake.reply({ blocks: [call('toolu_mixed', 'echo', { text: 'a' })] })
    const a = await send(run.tg.client, { ...base, input: 'HTTP first' })
    run.fake.reply({ blocks: [text('WS continued')] })
    const b = await ws.send({ ...base, previous_response_id: a.response.id, input: [output('toolu_mixed', 'A'), user('NOTICE')] })
    assertEquals(b.response.x_gateway.path, 'live')
    await run.tg.evictAll()
    run.fake.reply({ blocks: [text('HTTP rebuilt')] })
    const c = await send(run.tg.client, { ...base, previous_response_id: b.response.id, input: 'HTTP again' })
    assertEquals(c.response.x_gateway.path, 'store')
    run.fake.reply({ blocks: [text('WS again')] })
    const d = await ws.send({ ...base, previous_response_id: c.response.id, input: 'WS again' })
    assertEquals(d.response.x_gateway.path, 'live')
    assertEquals(run.tg.gw.lanes.size, 1)
    const requests = run.fake.main()
    for (let i = 1; i < requests.length; i++) assertPrefix(requests[i - 1], requests[i])
  })
})

Deno.test('WebSocket accepts a create above the former 16 MiB cap without dropping input', async () => {
  assertEquals(WS_MAX_MESSAGE_BYTES, 128 * 1024 * 1024)
  assertEquals(WS_MAX_BUFFERED_BYTES, WS_MAX_MESSAGE_BYTES)
  const run = new Run('ws-large-create', false)
  await run.run(async () => {
    const input = 'x'.repeat(17 * 1024 * 1024)
    run.tg.gw.createInto = async (request, sink) => {
      const item = request.input[0]
      assert(item.kind === 'message' && item.parts[0].type === 'text')
      assertEquals(item.parts[0].text, input)
      sink.send('response.completed', { response: { id: 'resp_large', status: 'completed' } })
      sink.close()
    }
    const reply = await run.tg.websocket().send({ ...base, input })
    assertEquals(reply.status, 'completed')
  })
})

Deno.test('WebSocket large image create commits provider content and replays identical upstream bytes after eviction', async () => {
  const run = new Run('ws-large-image-rebuild', false)
  await run.run(async () => {
    const png = await noisePng()
    const images = Array.from({ length: 22 }, () => ({ type: 'input_image', image_url: `data:image/png;base64,${png}` }))
    const body = { ...base, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect all 22 images.' }, ...images] }] }
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'response.create', ...body })).length
    assert(bytes > 16 * 1024 * 1024 && bytes < WS_MAX_MESSAGE_BYTES)
    const ws = run.tg.websocket()
    run.fake.reply({ blocks: [text('saw all images')], usage: { input_tokens: 50_000 } })
    const first = await ws.send(body)
    assertEquals(first.status, 'completed', JSON.stringify(first.response.error))
    assertEquals(run.tg.events('spawn').length, 1)
    const upstream = run.fake.main()[0].body.messages[0].content
    assertEquals(upstream.find((b: Json) => b.type === 'text').text, 'Inspect all 22 images.')
    const actualImages = upstream.filter((b: Json) => b.type === 'image')
    assertEquals(actualImages.length, images.length)
    for (const image of actualImages) {
      // Pinned Claude Code may natively re-encode PNGs; assert the saved provider bytes, not the input encoding.
      assert(['image/png', 'image/jpeg'].includes(image.source.media_type))
      assert(image.source.data.startsWith(image.source.media_type === 'image/jpeg' ? '/9j/' : 'iVBOR'))
      assert(atob(image.source.data).length > 100_000)
    }
    const record = await decodeRecord(first.response.output.at(-1).encrypted_content)
    assertExists(record)
    assertEquals(run.tg.gw.store.get(first.response.id), record)
    assert(record.entries.every((line) => !line.includes('"type":"image"')))
    const savedImages = replayLog(record, run.tg.gw.store).flatMap((entry) => JSON.parse(entry).message?.content ?? []).filter((b: Json) => b.type === 'image')
    assertEquals(savedImages, actualImages.map(({ cache_control: _, ...image }: Json) => image))
    const nextBody = { ...base, previous_response_id: first.response.id, input: 'Describe the same images.' }
    run.fake.reply({ blocks: [text('live continuation')], usage: { input_tokens: 50_000 } })
    const live = await ws.send(nextBody)
    assertEquals([live.status, live.response.x_gateway.path], ['completed', 'live'])
    await run.tg.evictAll()
    assertEquals(run.tg.gw.lanes.size, 0)
    run.fake.reply({ blocks: [text('rebuilt continuation')], usage: { input_tokens: 50_000 } })
    const rebuilt = await ws.send(nextBody)
    assertEquals([rebuilt.status, rebuilt.response.x_gateway.path], ['completed', 'store'])
    assertEquals(run.tg.events('spawn').length, 2)
    assertEquals(run.fake.main().length, 3)
    assertEquals(run.fake.main()[2].raw, run.fake.main()[1].raw, 'eviction/rebuild preserves the entire upstream request byte for byte')
  })
})

Deno.test('WebSocket synthesized image history commits a slim record and replays exact upstream bytes', async () => {
  const run = new Run('ws-large-history-record', false)
  await run.run(async () => {
    const png = await noisePng()
    const input: Json[] = []
    for (let n = 0; n < 3; n++) {
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: `History ${n}` },
          ...Array.from({ length: 20 }, () => ({ type: 'input_image', image_url: `data:image/png;base64,${png}` })),
        ],
      })
      input.push({ role: 'assistant', content: `Saw group ${n}` })
    }
    input.push(user('Summarize the history.'))
    run.fake.reply({ blocks: [text('history retained')], usage: { input_tokens: 50_000 } })
    const ws = run.tg.websocket()
    const first = await ws.send({ ...base, input })
    assertEquals(first.status, 'completed')
    const item = first.response.output.at(-1)
    assert(item.encrypted_content.length < 32 * 1024)
    const record = await decodeRecord(item.encrypted_content)
    assertExists(record)
    assertEquals(run.tg.gw.store.get(first.response.id), record)
    const added = first.events.find((e) => e.type === 'response.output_item.added' && e.item.id === item.id)
    const done = first.events.find((e) => e.type === 'response.output_item.done' && e.item.id === item.id)
    assertEquals(added.item.encrypted_content, item.encrypted_content)
    assertEquals(done.item, { type: item.type, id: item.id, summary: item.summary })
    assertEquals(first.events.at(-1).response.output.at(-1), done.item)
    const images = (entries: string[]) => entries.flatMap((line) => JSON.parse(line).message?.content ?? []).filter((b: Json) => b.type === 'image')
    assertEquals(images(replayLog(record, run.tg.gw.store)).length, 60)
    const upstreamImages = run.fake.main()[0].body.messages.flatMap((m: Json) => m.content).filter((b: Json) => b.type === 'image')
    assertEquals(upstreamImages.length, 60)
    const nextBody = { ...base, previous_response_id: first.response.id, input: 'Describe them again.' }
    run.fake.reply({ blocks: [text('continued')], usage: { input_tokens: 50_000 } })
    assertEquals((await ws.send(nextBody)).status, 'completed')
    await run.tg.evictAll()
    run.fake.reply({ blocks: [text('rebuilt')], usage: { input_tokens: 50_000 } })
    assertEquals((await ws.send(nextBody)).status, 'completed')
    assertEquals(run.fake.main()[2].raw, run.fake.main()[1].raw)
  })
})

Deno.test('WebSocket accepts a fragmented create above Deno native 64 MiB frame ceiling', async () => {
  const run = new Run('ws-fragmented-create', false)
  await run.run(async () => {
    const input = 'x'.repeat(65 * 1024 * 1024)
    run.tg.gw.createInto = async (request, sink) => {
      const item = request.input[0]
      assert(item.kind === 'message' && item.parts[0].type === 'text')
      assertEquals(item.parts[0].text, input)
      sink.send('response.completed', { response: { id: 'resp_fragmented', status: 'completed' } })
      sink.close()
    }
    const conn = await rawSocket(run.tg.url)
    try {
      const bytes = new TextEncoder().encode(JSON.stringify({ type: 'response.create', ...base, input }))
      for (let at = 0; at < bytes.length; at += 16 * 1024 * 1024) {
        const end = Math.min(at + 16 * 1024 * 1024, bytes.length)
        const header = new Uint8Array(14)
        header[0] = (end === bytes.length ? 0x80 : 0) | (at === 0 ? 1 : 0)
        header[1] = 0xff
        new DataView(header.buffer).setBigUint64(2, BigInt(end - at))
        await writeAll(conn, header)
        await writeAll(conn, bytes.subarray(at, end))
      }
      const event = JSON.parse(new TextDecoder().decode((await readRawFrame(conn)).payload))
      assertEquals(event.response.status, 'completed')
    } finally {
      conn.close()
    }
  })
})

Deno.test('WebSocket single flight reserves before async create; rejected requests leave active work intact', async () => {
  const run = new Run('ws-flight', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    await ws.opened
    run.fake.reply({ blocks: [text('first')], delayMs: 200 })
    create(ws, { input: 'first' })
    create(ws, { input: 'never run' })
    const error = await until(ws, 'error')
    assertEquals([error.status, error.error.code], [409, 'websocket_response_in_progress'])
    const terminal = await until(ws, 'response.completed')
    assertEquals(run.fake.main().length, 1)
    run.fake.reply({ blocks: [text('next')] })
    const next = await ws.send({ ...base, previous_response_id: terminal.response.id, input: 'after terminal' })
    assertEquals(next.status, 'completed')
    assertEquals(run.fake.main().length, 2)
  })
})

Deno.test('WebSocket misuse is typed, has no fallback, and a recoverable error permits the next create', async () => {
  const run = new Run('ws-errors', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    await ws.opened
    for (
      const [value, code, param] of [
        ['{', 'invalid_request', null],
        ['[]', 'invalid_request', null],
        [JSON.stringify({ type: 'response.cancel' }), 'unsupported', 'type'],
        [JSON.stringify({ type: 'response.interrupt' }), 'unsupported', 'type'],
        [JSON.stringify({ type: 'response.create', ...base, input: 'x', stream: true }), 'unsupported', 'stream'],
        [JSON.stringify({ type: 'response.create', ...base, input: 'x', stream: false }), 'unsupported', 'stream'],
        [JSON.stringify({ type: 'response.create', ...base, input: 'x', stream_id: 'lane' }), 'unsupported', 'stream_id'],
        [JSON.stringify({ type: 'response.create', ...base, input: 'x', generate: false }), 'unsupported', 'generate'],
        [JSON.stringify({ type: 'response.create', ...base, input: 'x', store: 'false' }), 'invalid_request', 'store'],
        [
          JSON.stringify({ type: 'response.create', ...base, input: 'x', previous_response_id: 'resp_missing' }),
          'previous_response_not_found',
          'previous_response_id',
        ],
      ]
    ) {
      ws.socket.send(value!)
      const e = await ws.next()
      assertEquals([e.type, e.status, e.error.code, e.error.param], ['error', 400, code, param])
      assert(typeof e.error.type === 'string' && typeof e.error.message === 'string')
    }
    ws.socket.send(new Uint8Array([123, 125]))
    assertEquals((await ws.next()).error.code, 'unsupported')
    assertEquals(run.fake.main().length, 0)
    assertEquals(run.tg.gw.lanes.size, 0)
    run.fake.reply({ blocks: [text('recovered')] })
    assertEquals((await ws.send({ ...base, input: 'valid' })).status, 'completed')
  })
})

for (const continuation of [false, true]) {
  Deno.test(`WebSocket close mid-${continuation ? 'continuation' : 'stream'} cancels and rebuilds from the last completed response`, async () => {
    const run = new Run(`ws-close-${continuation}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: continuation ? [call('toolu_close', 'echo', { text: 'x' })] : [text('warm')] })
      const previous = await run.send([user('warm')])
      const input = continuation ? [output('toolu_close', 'X')] : [user('slow')]
      run.fake.reply({ blocks: [text('partial'), text('never complete')], gapMs: 300 })
      const ws = run.tg.websocket()
      await ws.opened
      create(ws, { previous_response_id: previous.response.id, input })
      const started = await until(ws, 'response.created')
      await until(ws, 'response.output_text.delta')
      await ws.close()
      await run.tg.waitEvent('client_disconnect', (d) => d.response === started.response.id)
      await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
      assertEquals(run.tg.gw.store.has(started.response.id), false)
      assertEquals(run.tg.gw.lanes.size, 0)
      run.fake.reply({ blocks: [text('retried')] })
      const r = await run.send(input)
      assertEquals(r.status, 'completed')
      assertEquals(r.response.x_gateway.path, 'store')
      if (continuation) assertEquals(r.response.x_gateway.resume, 'interrupted_turn')
      else assert(sameRequest(run.fake.main()[1], run.fake.main()[2]))
    })
  })
}

Deno.test('WebSocket close mid-hold preserves completed calls; HTTP can release them, with no client-tool cancellation', async () => {
  const run = new Run('ws-close-hold', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    run.fake.reply({ blocks: [call('toolu_held', 'echo', { text: 'x' })] })
    const held = await ws.send({ ...base, input: 'hold' })
    await run.tg.waitEvent('hold')
    await ws.close()
    assertEquals(run.tg.gw.store.has(held.response.id), true)
    assertEquals(run.tg.events('client_disconnect').length, 0, 'a completed response is not cancelled')
    run.fake.reply({ blocks: [text('released')] })
    const next = await send(run.tg.client, { ...base, previous_response_id: held.response.id, input: [output('toolu_held', 'X')] })
    assertEquals(next.status, 'completed')
    assertEquals(next.response.x_gateway.path, 'live')
  })
})

Deno.test('WebSocket close while async planning is pending never spawns or releases work', async () => {
  const run = new Run('ws-close-plan', false)
  await run.run(async () => {
    const original = run.tg.gw.createInto.bind(run.tg.gw)
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>((r) => entered = r)
    const gate = new Promise<void>((r) => release = r)
    run.tg.gw.createInto = async (req, sink) => {
      entered()
      await gate
      await original(req, sink)
    }
    const ws = run.tg.websocket()
    await ws.opened
    create(ws, { input: 'never spawn' })
    await arrived
    await ws.close()
    release()
    await run.tg.waitEvent('client_disconnect')
    await run.tg.waitEvent('kill')
    assertEquals(run.tg.events('spawn').length, 0)
    assertEquals(run.fake.main().length, 0)
    assertEquals(run.tg.gw.lanes.size, 0)
  })
})

Deno.test('WebSocket refused upgrade uses the HTTP auth error; valid auth uses the same route', async () => {
  const run = new Run('ws-auth', false)
  await run.run(async () => {
    run.tg.gw.config.authToken = 'test-only-token'
    for (const authorization of ['', 'Bearer wrong']) {
      const r = await fetch(`${run.tg.url}/v1/responses`, { headers: { upgrade: 'websocket', authorization } })
      assertEquals(r.status, 401)
      assertEquals((await r.json()).error.code, 'invalid_api_key')
    }
    const conn = await rawSocket(run.tg.url, 'test-only-token')
    conn.close()
    const plain = await fetch(`${run.tg.url}/v1/responses`, { headers: { authorization: 'Bearer test-only-token' } })
    assertEquals(plain.status, 400)
    assertEquals((await plain.json()).error.code, 'invalid_request')
    assertEquals(run.tg.events('spawn').length, 0)
  })
})

Deno.test('WebSocket oversized inbound text yields typed 413 and closes with 1009 before creating a lane', async () => {
  const run = new Run('ws-oversize', false)
  await run.run(async () => {
    const conn = await rawSocket(run.tg.url)
    try {
      await oversizedFragments(conn, 1)
      const error = JSON.parse(new TextDecoder().decode((await readRawFrame(conn)).payload))
      assertEquals([error.type, error.status, error.error.code], ['error', 413, 'websocket_message_too_large'])
      const close = await readRawFrame(conn)
      assertEquals(new DataView(close.payload.buffer).getUint16(0), 1009)
      assertEquals(run.tg.events('spawn').length, 0)
    } finally {
      conn.close()
    }
  })
})

// A raw peer is required for true network backpressure: the JS WebSocket API always reads the network,
// even when its owner has no message listener. Read only the upgrade, then never consume another byte.
// Deno's native socket rejects individual frames >=64 MiB, independently of the application's message cap.
async function oversizedFragments(conn: Deno.TcpConn, opcode: number): Promise<void> {
  const chunk = new Uint8Array(1024 * 1024).fill(120)
  const header = new Uint8Array(14)
  header[1] = 0xff
  new DataView(header.buffer).setBigUint64(2, BigInt(chunk.byteLength))
  for (let i = 0; i < WS_MAX_MESSAGE_BYTES / chunk.byteLength; i++) {
    header[0] = i === 0 ? opcode : 0
    await writeAll(conn, header)
    await writeAll(conn, chunk)
  }
  await writeAll(conn, new Uint8Array([0x80, 0x81, 0, 0, 0, 0, 120]))
}
async function rawCreate(conn: Deno.TcpConn, body: Json): Promise<void> {
  const text = new TextEncoder().encode(JSON.stringify({ type: 'response.create', ...base, ...body }))
  assert(text.length < 65536)
  const header = text.length < 126 ? [0x81, 0x80 | text.length] : [0x81, 0xfe, text.length >> 8, text.length & 255]
  // All-zero mask is valid; the payload is still explicitly masked.
  await writeAll(conn, new Uint8Array([...header, 0, 0, 0, 0, ...text]))
}

Deno.test('WebSocket a real non-reading TCP peer cannot wedge the lane or block an HTTP retry', async () => {
  const run = new Run('ws-no-read', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('warm')] })
    const previous = await run.send([user('warm')])
    const conn = await rawSocket(run.tg.url)
    try {
      run.fake.reply({ blocks: Array.from({ length: 100 }, () => text('x'.repeat(512 * 1024))) })
      await rawCreate(conn, { previous_response_id: previous.response.id, input: 'huge' })
      await run.tg.waitEvent('client_disconnect', () => true, 15000)
      await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
      assertEquals(run.tg.gw.lanes.size, 0)
      run.fake.reply({ blocks: [text('retry works')] })
      const next = await run.send([user('huge')])
      assertEquals(next.status, 'completed')
      assertEquals(next.response.x_gateway.path, 'store')
    } finally {
      conn.close()
    }
  })
})

Deno.test('WebSocket writer bounds buffered bytes and outbound message size with typed errors', async () => {
  const events: Json[] = [], closes: number[] = []
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (s: string) => events.push(JSON.parse(s)), close: (n: number) => closes.push(n) }
  const writer = new SocketWriter(socket as unknown as WebSocket)
  let cancelled = 0
  writer.onDisconnect = () => cancelled++
  socket.bufferedAmount = WS_MAX_BUFFERED_BYTES
  assertEquals(writer.send({ type: 'event' }), false)
  await Promise.resolve()
  assertEquals(events[0].error.code, 'websocket_backpressure')
  assertEquals(closes, [1013])
  assertEquals(cancelled, 1)
  writer.disconnect()
  await Promise.resolve()
  assertEquals(cancelled, 1)
  const other = new SocketWriter({ ...socket, bufferedAmount: 0 } as unknown as WebSocket)
  assertEquals(other.send({ data: 'x'.repeat(WS_MAX_MESSAGE_BYTES) }), false)
  assertEquals(events.at(-1).error.code, 'response_too_large')
})

Deno.test('WebSocket writer drain deadline closes a slow peer even after the response is terminal', async () => {
  const events: Json[] = [], closes: number[] = []
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 1, send: (s: string) => events.push(JSON.parse(s)), close: (n: number) => closes.push(n) }
  const writer = new SocketWriter(socket as unknown as WebSocket)
  writer.send({ type: 'response.completed' })
  await new Promise((r) => setTimeout(r, WS_DRAIN_TIMEOUT_MS + 100))
  assertEquals(events.at(-1).error.code, 'websocket_backpressure')
  assertEquals(closes, [1013])
  assertEquals(writer.isClosed, true)
})

Deno.test('WebSocket model failures use response.failed and leave the connection reusable', async () => {
  const run = new Run('ws-terminals', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    run.fake.reply({ blocks: [], error: { status: 400, type: 'invalid_request_error', message: 'context too long: 250000 tokens > 200000' } })
    const b = await ws.send({ ...base, input: 'context overflow' })
    assertEquals(b.events.at(-1).type, 'response.failed')
    assertEquals(b.response.error.code, 'upstream_invalid_request')
    await assertRejects(() => ws.send({ ...base, input: 'x', previous_response_id: 'resp_not_found' }), Error)
    run.fake.reply({ blocks: [text('after failure')] })
    assertEquals((await ws.send({ ...base, input: 'valid' })).status, 'completed')
  })
})

Deno.test('WebSocket close in the asynchronous record-commit window cancels before the store advances', async () => {
  const run = new Run('ws-close-commit', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('warm')] })
    const previous = await run.send([user('warm')])
    const lane = [...run.tg.gw.lanes.values()][0]
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>((r) => entered = r)
    const gate = new Promise<void>((r) => release = r)
    lane.beforeCommit = async () => {
      entered()
      await gate
    }
    run.fake.reply({ blocks: [text('not committed')] })
    const ws = run.tg.websocket()
    await ws.opened
    create(ws, { previous_response_id: previous.response.id, input: 'next' })
    const started = await until(ws, 'response.created')
    await arrived
    await ws.close()
    await run.tg.waitEvent('client_disconnect', (d) => d.response === started.response.id)
    await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
    release()
    assertEquals(lane.active, null)
    assertEquals(run.tg.gw.store.has(started.response.id), false)
    run.fake.reply({ blocks: [text('retry')] })
    const retry = await run.send([user('next')])
    assertEquals(retry.response.x_gateway.path, 'store')
    assert(sameRequest(run.fake.main()[1], run.fake.main()[2]))
  })
})

Deno.test('WebSocket HTTP cancel can cancel a WebSocket response and the socket remains reusable', async () => {
  const run = new Run('ws-http-cancel', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    await ws.opened
    run.fake.reply({ blocks: [text('partial'), text('never sent')], gapMs: 300 })
    create(ws, { input: 'cancel this' })
    const started = await until(ws, 'response.created')
    await until(ws, 'response.output_text.delta')
    const response = await fetch(`${run.tg.url}/v1/responses/${started.response.id}/cancel`, { method: 'POST' })
    assertEquals([response.status, (await response.json()).status], [200, 'cancelled'])
    const terminal = await until(ws, 'response.failed')
    assertEquals([terminal.response.status, terminal.response.error.code], ['cancelled', 'cancelled'])
    run.fake.reply({ blocks: [text('next')] })
    assertEquals((await ws.send({ ...base, input: 'next' })).status, 'completed')
  })
})

Deno.test('WebSocket gateway shutdown closes an idle persistent socket and rejects new upgrades', async () => {
  const run = new Run('ws-shutdown', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    await ws.opened
    const closing = new Promise<CloseEvent>((r) => ws.socket.addEventListener('close', r, { once: true }))
    await run.tg.gw.close()
    assertEquals((await closing).code, 1001)
    const result = await fetch(`${run.tg.url}/v1/responses`, { headers: { upgrade: 'websocket' } })
    assertEquals(result.status, 503)
    assertEquals((await result.json()).error.code, 'shutting_down')
  })
})

Deno.test('WebSocket incomplete terminal passes through unchanged and releases the single-flight slot', async () => {
  const run = new Run('ws-incomplete', false)
  await run.run(async () => {
    // Claude Code may automatically continue max_tokens model messages. Inject the lane's terminal at the
    // shared sink boundary instead of pretending the fake backend controls that Claude Code policy.
    run.tg.gw.createInto = async (_request, sink) => {
      sink.send('response.created', { response: { id: 'resp_test', status: 'in_progress' } })
      sink.send('response.incomplete', { response: { id: 'resp_test', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
      sink.close()
    }
    const ws = run.tg.websocket()
    for (let i = 0; i < 2; i++) {
      const result = await ws.send({ ...base, input: 'incomplete' })
      assertEquals(result.status, 'incomplete')
      assertEquals(result.response.incomplete_details.reason, 'max_output_tokens')
      assertEquals(result.events.map((e) => e.sequence_number), [0, 1])
    }
  })
})

Deno.test('WebSocket oversized fragmented binary message gets the size error before binary-JSON validation', async () => {
  const run = new Run('ws-oversize-binary', false)
  await run.run(async () => {
    const conn = await rawSocket(run.tg.url)
    try {
      await oversizedFragments(conn, 2)
      const event = JSON.parse(new TextDecoder().decode((await readRawFrame(conn)).payload))
      assertEquals([event.type, event.status, event.error.code], ['error', 413, 'websocket_message_too_large'])
      assertEquals(new DataView((await readRawFrame(conn)).payload.buffer).getUint16(0), 1009)
      assertEquals(run.tg.events('spawn').length, 0)
    } finally {
      conn.close()
    }
  })
})

Deno.test('WebSocket an oversized initial response event does not launch Claude Code', async () => {
  const run = new Run('ws-initial-overflow', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    // Inflate the created event at the real Gateway start boundary. Output-budget rejection must happen
    // before any model process launches, rather than cancelling after a needless inference starts.
    const original = run.tg.gw.createInto.bind(run.tg.gw)
    run.tg.gw.createInto = async (request, sink) => {
      const originalSend = sink.send.bind(sink)
      sink.send = (type, data) => {
        if (type === 'response.created') data.response.extra = 'x'.repeat(WS_MAX_MESSAGE_BYTES)
        originalSend(type, data)
      }
      await original(request, sink)
    }
    await ws.opened
    create(ws, { input: 'do not run' })
    const event = await ws.next()
    assertEquals(event.error.code, 'response_too_large')
    await ws.closed
    await run.tg.waitEvent('kill')
    assertEquals(run.tg.events('spawn').length, 0)
    assertEquals(run.fake.main().length, 0)
  })
})

Deno.test('WebSocket store:false retains a chain on the same socket, after reconnect and eviction, and over HTTP', async () => {
  const run = new Run('ws-store-false', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    run.fake.reply({ blocks: [call('toolu_store_a', 'echo', { text: 'a' })] })
    const first = await ws.send({ ...base, store: false, input: 'first' })
    run.fake.reply({ blocks: [text('same socket')] })
    const second = await ws.send({ ...base, store: false, previous_response_id: first.response.id, input: [output('toolu_store_a', 'A')] })
    assertEquals(second.response.x_gateway.path, 'live')
    await ws.close()
    await run.tg.evictAll()
    const reconnect = run.tg.websocket()
    run.fake.reply({ blocks: [call('toolu_store_b', 'echo', { text: 'b' })] })
    const third = await reconnect.send({ ...base, store: false, previous_response_id: second.response.id, input: 'after reconnect' })
    assertEquals(third.response.x_gateway.path, 'store')
    run.fake.reply({ blocks: [text('HTTP continued')] })
    const fourth = await send(run.tg.client, { ...base, store: false, previous_response_id: third.response.id, input: [output('toolu_store_b', 'B')] })
    assertEquals(fourth.response.x_gateway.path, 'live')
    for (const result of [first, second, third, fourth]) {
      assertEquals(result.status, 'completed')
      assertEquals(result.response.store, true, 'response reports actual gateway retention')
      assertEquals(run.tg.gw.store.has(result.response.id), true)
    }
    assertEquals(run.tg.gw.store.chain(fourth.response.id)!.map((r) => r.id), [first, second, third, fourth].map((r) => r.response.id))
    const requests = run.fake.main()
    for (let i = 1; i < requests.length; i++) assertPrefix(requests[i - 1], requests[i])
  })
})

Deno.test('HTTP store:false, store:true and absent store accept requests without changing chain retention', async () => {
  const run = new Run('http-store-flags', false)
  await run.run(async () => {
    let previous: string | null = null
    for (const flag of [{ store: false }, { store: true }, {}]) {
      run.fake.reply({ blocks: [text('retained')] })
      const result = await send(run.tg.client, { ...base, ...flag, ...(previous ? { previous_response_id: previous } : {}), input: 'continue' })
      assertEquals(result.status, 'completed')
      assertEquals(result.response.store, true)
      assertEquals(run.tg.gw.store.has(result.response.id), true)
      assertEquals(result.response.x_gateway.path, previous ? 'store' : 'new')
      previous = result.response.id
      await run.tg.evictAll()
    }
    assertEquals(run.tg.gw.store.chain(previous!)!.length, 3)
  })
})

Deno.test('store rejects all non-boolean values with typed 400 on HTTP and WebSocket', async () => {
  const run = new Run('store-types', false)
  await run.run(async () => {
    const ws = run.tg.websocket()
    await ws.opened
    for (const store of [null, 'false', 'true', 0, 1, [], {}]) {
      const body = { ...base, input: 'never run', store }
      const http = await fetch(`${run.tg.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
      })
      const error = await http.json()
      assertEquals([http.status, error.error.code, error.error.param], [400, 'invalid_request', 'store'])
      create(ws, body)
      const event = await ws.next()
      assertEquals([event.type, event.status, event.error.code, event.error.param], ['error', 400, 'invalid_request', 'store'])
    }
    assertEquals(run.tg.events('spawn').length, 0)
    assertEquals(run.fake.main().length, 0)
  })
})

Deno.test('WebSocket deterministic batch overflow is a nonretryable 413 with required byte counts', () => {
  const sent: Json[] = [], closes: number[] = []
  const writer = new SocketWriter(
    {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (s: string) => sent.push(JSON.parse(s)),
      close: (code: number) => closes.push(code),
    } as unknown as WebSocket,
  )
  assertEquals(writer.prepare([{ data: 'x'.repeat(65 * 1024 * 1024) }, { data: 'x'.repeat(65 * 1024 * 1024) }]), null)
  assertEquals([sent[0].status, sent[0].error.type, sent[0].error.code], [413, 'invalid_request_error', 'response_too_large'])
  assert(sent[0].error.message.includes('136314902'))
  assert(sent[0].error.message.includes('134217728'))
  assertEquals(closes, [1009])
})

Deno.test('WebSocket real native tool framing produces a record above 42 MiB without deterministic backpressure', async () => {
  const run = new Run('ws-large-own-record', false)
  await run.run(async () => {
    const signature = (await noisePng()).repeat(55)
    run.fake.reply({ blocks: [call('toolu_native_record', 'not_offered', { signature })], usage: { input_tokens: 50_000 } }, {
      blocks: [text('done')],
      usage: { input_tokens: 50_000 },
    })
    const dir = Deno.makeTempDirSync({ prefix: 'cc2r-large-peer-' })
    const file = `${dir}/opaque`
    const peer = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '-A',
        new URL('./raw_websocket_peer.ts', import.meta.url).pathname,
        run.tg.url,
        JSON.stringify({ type: 'response.create', ...base, input: 'Think.' }),
        file,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).spawn()
    let opaque: string, result: Json
    try {
      const output = await peer.output()
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr))
      result = JSON.parse(new TextDecoder().decode(output.stdout))
      opaque = Deno.readTextFileSync(file)
    } finally {
      try {
        peer.kill('SIGTERM')
      } catch { /* already exited */ }
      Deno.removeSync(dir, { recursive: true })
    }
    assertEquals(result.status, 'completed')
    const item = { encrypted_content: opaque! }
    assert(item.encrypted_content.length > 42 * 1024 * 1024)
    const record = await decodeRecord(item.encrypted_content)
    assertExists(record)
    assertEquals(run.tg.gw.store.get(result.id), record)
    const saved = record.entries.flatMap((l) => JSON.parse(l).message?.content ?? []).find((b: Json) => b.type === 'tool_use')
    assertEquals(saved.input.signature, signature)
    assertEquals(result.recordBytes, opaque!.length)
    assertEquals(result.addedId, result.doneId)
    assertEquals(result.addedId, result.terminalId)
    assertEquals(result.doneOpaque, false)
    assertEquals(result.terminalOpaque, false)
    assertEquals(record.nativeCalls, ['toolu_native_record'])
  })
})
