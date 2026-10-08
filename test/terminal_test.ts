// Regression of Sol's completion-boundary overflow and the equivalent SSE transport-acceptance boundary.
import { assert, assertEquals } from '@std/assert'
import { parseRequest } from '../src/api/request.ts'
import { SseSink } from '../src/api/stream.ts'
import { SocketWriter, WS_MAX_BUFFERED_BYTES, WS_MAX_MESSAGE_BYTES } from '../src/websocket.ts'
import { type Json, text } from './fake.ts'
import { sameRequest, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }

Deno.test('terminal overflow: drained blocks plus an oversized terminal never commit an undeliverable WebSocket success', async () => {
  const blockCount = 17
  const run = new Run('ws-terminal-overflow', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('warm')] })
    const previous = await run.send([user('warm')])
    const lane = [...run.tg.gw.lanes.values()][0]
    // Inflate only the aggregate terminal at the real commit boundary; model blocks still stream and drain.
    lane.beforeCommit = async () => {
      const state = lane.active!.state
      const object = state.object.bind(state)
      state.object = () => ({ ...object(), extra: 'x'.repeat(WS_MAX_MESSAGE_BYTES) })
    }
    run.fake.reply({ blocks: Array.from({ length: blockCount }, () => text('x'.repeat(1024 * 1024))), gapMs: 100 })
    const ws = run.tg.websocket()
    await ws.opened
    ws.socket.send(JSON.stringify({ type: 'response.create', ...base, previous_response_id: previous.response.id, input: 'large response' }))
    let id = '', terminal = false, error: Json = null, doneBlocks = 0
    while (true) {
      const event = await ws.next()
      if (event.type === 'response.created') id = event.response.id
      if (event.type === 'response.output_text.done') doneBlocks++
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
        terminal = true
        break
      }
      if (event.type === 'error') {
        error = event
        break
      }
    }
    await ws.closed
    await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
    assertEquals(error?.error.code, 'websocket_message_too_large')
    assertEquals(error?.status, 413)
    assertEquals(doneBlocks, blockCount, 'each model block streamed and drained before aggregate terminal rejection')
    assertEquals(terminal, false)
    assertEquals(run.tg.gw.store.has(id), false)
    assertEquals(lane.head?.responseId, previous.response.id)
    assertEquals(run.tg.events('completed').map((e) => e.data.response), [previous.response.id])
    assertEquals(run.tg.events('client_disconnect').map((e) => e.data.response), [id])
    const cancel = await fetch(`${run.tg.url}/v1/responses/${id}/cancel`, { method: 'POST' })
    assertEquals(cancel.status, 404)
    await cancel.body?.cancel()
    run.fake.reply({ blocks: [text('retry')] })
    const retry = await run.send([user('large response')])
    assertEquals(retry.response.x_gateway.path, 'store')
    assert(sameRequest(run.fake.main()[1], run.fake.main()[2]), 'failed attempt did not alter the retry prefix')
  })
})

Deno.test('terminal batch preflight rejects aggregate WebSocket backpressure before emitting any final item', () => {
  const sent: Json[] = [], closes: number[] = []
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: WS_MAX_BUFFERED_BYTES - 100,
    send: (s: string) => sent.push(JSON.parse(s)),
    close: (code: number) => closes.push(code),
  }
  const writer = new SocketWriter(socket as unknown as WebSocket)
  const prepare = writer.prepare([{ type: 'response.output_item.done', item: 'x'.repeat(40) }, { type: 'response.completed', response: 'y'.repeat(40) }])
  assertEquals(prepare, null)
  assertEquals(sent.map((e) => e.type), ['error'])
  assertEquals(sent[0].error.code, 'websocket_backpressure')
  assertEquals(closes, [1013])
})

Deno.test('SSE cancellation exactly between terminal preflight and enqueue rolls back disk and preserves the previous head', async () => {
  const run = new Run('sse-terminal-refusal', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('warm')] })
    const previous = await run.send([user('warm')])
    const lane = [...run.tg.gw.lanes.values()][0]
    const sink = new SseSink(), reader = sink.stream.getReader()
    const original = sink.prepare.bind(sink)
    let id = '', rejectedAtEnqueue = false
    sink.prepare = (events) => {
      const prepared = original(events)
      const terminal = events.find((e) => e.type === 'response.completed')
      if (!terminal) return prepared
      id = terminal.data.response.id
      return () => {
        // The underlying ReadableStream.cancel callback runs synchronously, as a refused HTTP body would.
        void reader.cancel()
        rejectedAtEnqueue = true
        assertEquals(run.tg.gw.store.has(id), true, 'the synchronous disk write is rolled back if enqueue fails')
        return prepared!()
      }
    }
    run.fake.reply({ blocks: [text('discarded')] })
    const req = parseRequest({ ...base, stream: true, previous_response_id: previous.response.id, input: 'next' })
    await run.tg.gw.createInto(req, sink)
    await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
    assertEquals(rejectedAtEnqueue, true)
    assertEquals(run.tg.gw.store.has(id), false)
    assertEquals(lane.head?.responseId, previous.response.id)
    assertEquals(run.tg.events('client_disconnect').map((e) => e.data.response), [id], 'cancellation is idempotent')
    assertEquals(run.tg.events('completed').map((e) => e.data.response), [previous.response.id])
    run.fake.reply({ blocks: [text('retry')] })
    const retry = await run.send([user('next')])
    assertEquals(retry.response.x_gateway.path, 'store')
    assert(sameRequest(run.fake.main()[1], run.fake.main()[2]))
  })
})

Deno.test('SSE HTTP body abort before terminal acceptance does not retain a successful attempt', async () => {
  const run = new Run('sse-terminal-abort', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('warm')] })
    const previous = await run.send([user('warm')])
    const lane = [...run.tg.gw.lanes.values()][0]
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((r) => entered = r), gate = new Promise<void>((r) => release = r)
    lane.beforeCommit = async () => {
      entered()
      await gate
    }
    run.fake.reply({ blocks: [text('aborted')] })
    const controller = new AbortController()
    const response = await fetch(`${run.tg.url}/v1/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, stream: true, previous_response_id: previous.response.id, input: 'next' }),
    })
    await ready
    const id = lane.active!.state.id
    controller.abort()
    await response.body!.cancel().catch(() => {})
    await run.tg.waitEvent('client_disconnect', (d) => d.response === id)
    release()
    await run.tg.waitEvent('kill', (d) => d.reason === 'client_disconnected')
    assertEquals(run.tg.gw.store.has(id), false)
    assertEquals(lane.head?.responseId, previous.response.id)
  })
})

Deno.test('SSE cancellation after accepted terminal queuing retains success, the same boundary as WebSocket', async () => {
  const run = new Run('sse-terminal-accepted', false)
  await run.run(async () => {
    const sink = new SseSink(), reader = sink.stream.getReader()
    run.fake.reply({ blocks: [text('success')] })
    await run.tg.gw.createInto(parseRequest({ ...base, stream: true, input: 'complete' }), sink)
    const committed = await run.tg.waitEvent('completed')
    // Never read the stream; acceptance is the transport's enqueue, not a peer reading or parsing its bytes.
    await reader.cancel()
    assertEquals(run.tg.gw.store.has(committed.response), true)
    assertEquals([...run.tg.gw.lanes.values()][0].head!.responseId, committed.response)
    assertEquals(run.tg.events('client_disconnect').length, 0)
  })
})
