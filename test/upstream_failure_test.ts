import { assert, assertEquals } from '@std/assert'
import { resultError } from '../src/claude/failure.ts'
import { call, text } from './fake.ts'
import { freePort, sameRequest, send, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

Deno.test('a status-less api_error is upstream_unreachable whatever its text; a 5xx is server_error', () => {
  for (const status of [500, 502, 503, 504, 529, 599]) {
    assertEquals(resultError({ terminal_reason: 'api_error', api_error_status: status, result: 'API Error' }, null).code, 'server_error')
  }
  for (
    const result of [
      'Request timed out',
      'API Error: Connection dropped (ECONNRESET)',
      'API Error: No response from API (waited 3m1s). …',
      'API Error: Connection refused (ECONNREFUSED)',
      'API Error: arbitrary failure',
      'Request timed out\nuser text',
    ]
  ) {
    assertEquals(resultError({ terminal_reason: 'api_error', api_error_status: null, result }, null).code, 'upstream_unreachable')
    assertEquals(resultError({ terminal_reason: 'api_error', result }, null).code, 'upstream_unreachable')
  }
  for (
    const frame of [
      { terminal_reason: 'unknown', result: 'Request timed out' },
      { terminal_reason: 'api_error', api_error_status: '500', result: 'Request timed out' },
    ]
  ) assertEquals(resultError(frame, null).code, 'claude_code_error')
  for (
    const [status, code] of [
      [400, 'upstream_invalid_request'],
      [401, 'upstream_authentication_error'],
      [403, 'upstream_authentication_error'],
      [429, 'rate_limit_exceeded'],
      [200, 'upstream_error'],
      [600, 'upstream_error'],
    ] as const
  ) {
    assertEquals(resultError({ terminal_reason: 'api_error', api_error_status: status, result: 'Request timed out' }, null).code, code)
  }
})

const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
for (const transport of ['sse', 'websocket'] as const) {
  for (const status of [500, 529]) {
    Deno.test(`${transport}: ${status} is server_error, never stored, and retries the committed parent byte-identically`, async () => {
      const run = new Run(`retry-${transport}-${status}`, false)
      await run.run(async () => {
        run.fake.reply({ blocks: [text('parent')] })
        const parent = await run.send([user('first')])
        const ws = transport === 'websocket' ? run.tg.websocket() : null
        const body = { ...base, previous_response_id: parent.response.id, input: 'next' }
        const request = () => ws ? ws.send(body) : send(run.tg.client, body)
        run.fake.reply({ blocks: [], error: { status, type: status === 529 ? 'overloaded_error' : 'api_error', message: 'probe upstream failure' } })
        const failed = await request()
        assertEquals([failed.status, failed.response.error.code], ['failed', 'server_error'])
        assertEquals(failed.events.map((e) => e.type), ['response.created', 'response.in_progress', 'response.failed'])
        assertEquals(run.tg.gw.store.has(failed.response.id), false)
        assertEquals(run.fake.main().length, 2, 'no gateway-side retries')
        run.fake.reply({ blocks: [text('retry succeeded')] })
        const retried = await request()
        assertEquals([retried.status, retried.response.previous_response_id], ['completed', parent.response.id])
        assert(sameRequest(run.fake.main()[1], run.fake.main()[2]))
        assertEquals(run.fake.main()[1].raw, run.fake.main()[2].raw)
      })
    })
  }

  Deno.test(`${transport}: provisional text and function calls from a failed attempt are discarded; retry starts at the last committed parent`, async () => {
    const run = new Run(`retry-output-${transport}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: [text('committed parent')] })
      const parent = await run.send([user('first')])
      const lane = [...run.tg.gw.lanes.values()][0]
      lane.beforeCommit = () => {
        lane.fail(resultError({ terminal_reason: 'api_error', api_error_status: 500, result: 'API Error: 500 failed after output' }, null))
        return Promise.resolve()
      }
      const ws = transport === 'websocket' ? run.tg.websocket() : null
      const body = { ...base, previous_response_id: parent.response.id, input: 'next' }
      const request = () => ws ? ws.send(body) : send(run.tg.client, body)
      run.fake.reply({ blocks: [text('provisional text'), call('toolu_provisional', 'echo', { text: 'do not execute' })] })
      const failed = await request()
      assertEquals([failed.status, failed.response.error.code], ['failed', 'server_error'])
      assert(failed.events.some((e) => e.type === 'response.output_text.delta' && e.delta === 'provisional text'))
      assert(failed.events.some((e) => e.type === 'response.output_item.done' && e.item.call_id === 'toolu_provisional'))
      assertEquals(run.tg.gw.store.has(failed.response.id), false)
      assertEquals(run.tg.gw.store.has(parent.response.id), true)
      assertEquals(run.tg.events('completed').map((e) => e.data.response), [parent.response.id])
      // Like the kernel, only successful responses enter history or execute tools.
      const committed = [parent.response]
      run.fake.reply({ blocks: [text('retry text'), call('toolu_retry', 'echo', { text: 'retry tool' })] })
      const retried = await request()
      assertEquals(retried.status, 'completed')
      assert(sameRequest(run.fake.main()[1], run.fake.main().at(-1)!), 'retry starts from precisely the failed model input')
      assertEquals(run.fake.main()[1].raw, run.fake.main().at(-1)!.raw)
      committed.push(retried.response)
      assertEquals(committed.flatMap((r) => r.output).filter((i) => i.type === 'message').flatMap((i) => i.content).map((i) => i.text), [
        'committed parent',
        'retry text',
      ])
      assertEquals(committed.flatMap((r) => r.output).filter((i) => i.type === 'function_call').map((i) => i.call_id), ['toolu_retry'])
    })
  })
}

for (const transport of ['sse', 'websocket'] as const) {
  for (const failure of ['timeout', 'reset', 'refused', 'no-response'] as const) {
    Deno.test(`${transport}: real Claude Code ${failure} maps to upstream_unreachable and a fresh retry succeeds`, async () => {
      const run = new Run(`transport-failure-${transport}-${failure}`, false)
      const listener = failure === 'reset' ? Deno.listen({ hostname: '127.0.0.1', port: 0 }) : null
      const closedPort = failure === 'refused' ? freePort() : null
      let closing = false
      const resetter = listener
        ? (async () => {
          for await (const conn of listener) {
            await conn.read(new Uint8Array(65536))
            conn.close()
          }
        })().catch((e) => {
          if (!closing) throw e
        })
        : Promise.resolve()
      const normalBackend = run.backend.bind(run)
      run.backend = () => ({
        ...normalBackend(),
        ...(listener ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${listener.addr.port}` } : {}),
        ...(closedPort ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${closedPort}` } : {}),
        ...(failure === 'timeout' ? { API_TIMEOUT_MS: '1000' } : {}),
        ...(failure === 'no-response'
          ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: 'true', CLAUDE_ENABLE_BYTE_WATCHDOG: 'true', CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '10000' }
          : {}),
      })
      try {
        await run.run(async () => {
          const ws = transport === 'websocket' ? run.tg.websocket() : null
          const body = { ...base, input: 'fresh request' }
          const request = () => ws ? ws.send(body) : send(run.tg.client, body)
          if (failure === 'timeout' || failure === 'no-response') run.fake.reply({ blocks: [text('too late')], delayMs: failure === 'timeout' ? 3500 : 14000 })
          const failed = await request()
          assertEquals([failed.status, failed.response.error.code], ['failed', 'upstream_unreachable'])
          assertEquals(failed.events.map((e) => e.type), ['response.created', 'response.in_progress', 'response.failed'])
          assertEquals(run.tg.gw.store.has(failed.response.id), false)
          assertEquals(run.tg.gw.lanes.size, 0)
          if (listener || closedPort) run.tg.gw.config.backendEnv.ANTHROPIC_BASE_URL = run.fake.url
          run.fake.reply({ blocks: [text('recovered')] })
          const retried = await request()
          assertEquals([retried.status, retried.response.previous_response_id], ['completed', null])
        })
      } finally {
        closing = true
        listener?.close()
        await resetter
      }
    })
  }
}
