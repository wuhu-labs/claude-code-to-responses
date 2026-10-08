import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { isNoResponseFrame, resultError } from '../src/claude/failure.ts'
import { FakeAnthropic, text } from '../test/fake.ts'
import { freePort } from '../test/harness.ts'
import { Probe, ProbeTarget } from './launcher.ts'

const STALL_ADVICE =
  'If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS or CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to wait longer.'
const cases = [
  { name: '500', status: 500, type: 'api_error' },
  { name: '529', status: 529, type: 'overloaded_error' },
  { name: 'timeout' },
  { name: 'reset' },
  { name: 'no-response-short' },
  { name: 'no-response-default' },
] as const

for (const c of cases) {
  Deno.test(`upstream ${c.name}: pin Claude Code 2.1.284 result and synthetic assistant, then classify`, async () => {
    const p = new Probe()
    const fake = new FakeAnthropic(freePort())
    const listener = c.name === 'reset' ? Deno.listen({ hostname: '127.0.0.1', port: freePort() }) : null
    let closing = false
    let connections = 0
    const resetter = listener
      ? (async () => {
        for await (const conn of listener) {
          try {
            await conn.read(new Uint8Array(65536))
            connections++
            conn.close()
          } catch { /* shutting down */ }
        }
      })().catch((e) => {
        if (!closing) throw e
      })
      : Promise.resolve()
    try {
      const noResponse = c.name.startsWith('no-response')
      const env: Record<string, string> = noResponse
        // Custom endpoints disable the first-party watchdog. This test-only switch arms it while every request
        // still goes to the loopback fake. The gateway never passes these overrides in production.
        ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: 'true', CLAUDE_ENABLE_BYTE_WATCHDOG: 'true' }
        : {}
      if (c.name === 'no-response-short') env.CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS = '10000'
      if (c.name === 'timeout') env.API_TIMEOUT_MS = '1000'
      if (listener) env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${listener.addr.port}`
      if ('status' in c) fake.reply({ blocks: [], error: { status: c.status, type: c.type, message: `probe ${c.status}` } })
      else if (noResponse) fake.reply({ blocks: [text('too late')], delayMs: c.name === 'no-response-default' ? 185000 : 14000 })
      else if (c.name === 'timeout') fake.reply({ blocks: [text('too late')], delayMs: 3500 })
      const r = p.launch({ name: c.name, fake, target: new ProbeTarget(), env })
      const result = await r.turn('x', c.name === 'no-response-default' ? 210000 : 30000)
      const assistant = r.frames.filter((f) => f.type === 'assistant')
      assertEquals([result.type, result.subtype, result.is_error, result.terminal_reason], ['result', 'success', true, 'api_error'])
      assertEquals(result.api_error_status, 'status' in c ? c.status : null)
      assertEquals(assistant.length, 1)
      assertEquals([assistant[0].is_api_error_message, assistant[0].error, assistant[0].message.model], [true, 'server_error', '<synthetic>'])
      assertEquals(assistant[0].message.content, [{ type: 'text', text: result.result }])
      assertEquals(isNoResponseFrame(assistant[0]), noResponse)
      if ('status' in c) assertStringIncludes(result.result, `API Error: ${c.status} probe ${c.status}. This is a server-side issue, usually temporary`)
      else if (c.name === 'timeout') assertEquals(result.result, 'Request timed out')
      else if (c.name === 'reset') assertEquals(result.result, 'API Error: Connection dropped (ECONNRESET)')
      else {
        assertEquals(assistant[0].api_error, 'no_response')
        assertStringIncludes(result.result, STALL_ADVICE)
        if (c.name === 'no-response-short') assertEquals(result.result, `API Error: No response from API (waited 11s). ${STALL_ADVICE}`)
        else assert(/^API Error: No response from API \(waited 3m/.test(result.result), result.result)
      }
      assertEquals(resultError(result, null, isNoResponseFrame(assistant[0])).code, 'server_error')
      assertEquals(r.frames.filter((f) => f.subtype === 'api_retry'), [], 'CLAUDE_CODE_MAX_RETRIES=0: no hidden retry')
      if (listener) assert(connections >= 1)
      else assertEquals(fake.main().length, 1)
      console.log(JSON.stringify({ scenario: c.name, api_error_status: result.api_error_status, result: result.result, api_error: assistant[0].api_error }))
      await r.kill()
      assertEquals((await r.exited).signal, 'SIGKILL', 'stream-json process stays alive after an error result; the gateway kills it')
    } finally {
      await p.close()
      await fake.close()
      closing = true
      listener?.close()
      await resetter
    }
  })
}
