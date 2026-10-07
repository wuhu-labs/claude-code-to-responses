// Regression of MiMo's post-attach spawn failure: both transports must terminate and unlock the chain.
import { assert, assertEquals } from '@std/assert'
import { GatewayError } from '../src/errors.ts'
import { Lane } from '../src/lane.ts'
import { text } from './fake.ts'
import { sameRequest, send, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const base = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }

for (const transport of ['websocket', 'sse'] as const) {
  for (const trigger of ['before-spawn', 'after-spawn', 'typed'] as const) {
    Deno.test(`${transport}: post-attach ${trigger} exception emits typed response.failed and allows byte-identical retry`, async () => {
      const run = new Run(`start-fail-${transport}-${trigger}`, false)
      await run.run(async () => {
        run.fake.reply({ blocks: [text('warm')] })
        const previous = await run.send([user('warm')])
        const body = { ...base, previous_response_id: previous.response.id, input: 'second' }
        // Capture the model request for this exact continuation, then rebuild from the same parent.
        run.fake.reply({ blocks: [text('control')] })
        const control = await send(run.tg.client, body)
        await run.tg.evictAll()
        const ws = transport === 'websocket' ? run.tg.websocket() : null
        const request = () => ws ? ws.send(body) : send(run.tg.client, body)
        let failedLane: Lane | null = null
        const original = Lane.prototype.spawn
        Lane.prototype.spawn = function (opts) {
          failedLane = this
          if (trigger === 'after-spawn') original.call(this, opts)
          if (trigger === 'typed') throw new GatewayError(500, 'server_error', 'claude_code_error', 'Injected typed startup failure.')
          throw new Error('Injected startup failure (disk full/fork failure).')
        }
        let failed
        try {
          failed = await request()
        } finally {
          Lane.prototype.spawn = original
        }
        const code = trigger === 'typed' ? 'claude_code_error' : 'internal_error'
        assertEquals(failed.events.map((e) => e.type), ['response.created', 'response.in_progress', 'response.failed'])
        assertEquals(failed.events.map((e) => e.sequence_number), [0, 1, 2])
        assertEquals([failed.status, failed.response.error.code], ['failed', code])
        assertEquals(failed.response.previous_response_id, previous.response.id)
        assertEquals(run.tg.gw.store.has(failed.response.id), false)
        assertEquals(run.tg.gw.lanes.size, 0, 'failure immediately unreserves and removes the lane')
        assert(failedLane)
        assertEquals((failedLane as Lane).active, null)
        await run.tg.waitEvent('kill', (d) => d.reason === `failed: ${code}`)
        assertEquals(run.fake.main().length, 2, 'failure did not start another model turn')
        run.fake.reply({ blocks: [text('retry')] })
        const retried = await request() // The WebSocket case deliberately reuses the same socket.
        assertEquals([retried.status, retried.response.x_gateway.path], ['completed', 'store'])
        assertEquals(retried.response.previous_response_id, previous.response.id)
        assert(sameRequest(run.fake.main()[1], run.fake.main()[2]), 'retry input is byte-identical to the control continuation')
        assertEquals(run.tg.events('completed').map((e) => e.data.response), [previous.response.id, control.response.id, retried.response.id])
      })
    })
  }

  Deno.test(`${transport}: a real torn .claude.json failure terminates the stream and is retryable after repair`, async () => {
    const run = new Run(`start-config-${transport}`, false)
    await run.run(async () => {
      run.fake.reply({ blocks: [text('warm')] })
      const previous = await run.send([user('warm')])
      const body = { ...base, previous_response_id: previous.response.id, input: 'second' }
      run.fake.reply({ blocks: [text('control')] })
      await send(run.tg.client, body)
      await run.tg.evictAll()
      const configPath = `${run.tg.gw.config.stateDir}/claude/config/.claude.json`
      const originalConfig = Deno.readTextFileSync(configPath)
      const ws = transport === 'websocket' ? run.tg.websocket() : null
      const request = () => ws ? ws.send(body) : send(run.tg.client, body)
      Deno.writeTextFileSync(configPath, '{"userID":')
      let failed
      try {
        failed = await request()
      } finally {
        Deno.writeTextFileSync(configPath, originalConfig)
      }
      assertEquals(failed.events.map((e) => e.type), ['response.created', 'response.in_progress', 'response.failed'])
      assertEquals([failed.status, failed.response.error.code], ['failed', 'internal_error'])
      assertEquals(run.tg.gw.store.has(failed.response.id), false)
      assertEquals(run.tg.gw.lanes.size, 0)
      await run.tg.waitEvent('kill', (d) => d.reason === 'failed: internal_error')
      run.fake.reply({ blocks: [text('retry after repair')] })
      const retry = await request()
      assertEquals([retry.status, retry.response.x_gateway.path], ['completed', 'store'])
      assert(sameRequest(run.fake.main()[1], run.fake.main()[2]))
    })
  })
}
