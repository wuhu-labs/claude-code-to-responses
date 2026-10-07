// A synchronous record-write failure after model completion must not reject an un-awaited task or wedge a lane.
import { assert, assertEquals } from '@std/assert'
import { text } from './fake.ts'
import { sameRequest, user } from './harness.ts'
import { Run } from './scenario.ts'

for (const transport of ['websocket', 'sse'] as const) {
  Deno.test(`${transport}: store.put exception emits typed response.failed and allows byte-identical retry`, async () => {
    const run = new Run(`store-put-failure-${transport}`, false, { transport })
    await run.run(async () => {
      run.fake.reply({ blocks: [text('warm')] })
      const previous = await run.send([user('warm')])
      const lane = [...run.tg.gw.lanes.values()][0]
      const put = run.tg.gw.store.put.bind(run.tg.gw.store)
      let attempted = ''
      run.tg.gw.store.put = (record) => {
        attempted = record.id
        throw new Error('ENOSPC: injected atomic record-write failure')
      }
      run.fake.reply({ blocks: [text('output before failed write')] })
      let failed
      try {
        failed = await run.send([user('second')])
      } finally {
        run.tg.gw.store.put = put
      }
      assertEquals(failed.status, 'failed')
      assertEquals(failed.response.error.code, 'internal_error')
      assertEquals(failed.events.slice(0, 2).map((e) => e.type), ['response.created', 'response.in_progress'])
      assertEquals(failed.events.at(-1).type, 'response.failed')
      assertEquals(failed.events.some((e) => e.type === 'response.completed'), false)
      assertEquals(failed.events.filter((e) => e.type === 'response.output_text.done').length, 1, 'failure occurs after model output finishes')
      assertEquals(failed.response.id, attempted)
      assertEquals(run.tg.gw.store.has(attempted), false)
      assertEquals(lane.active, null)
      assertEquals(lane.head?.responseId, previous.response.id)
      assertEquals(run.tg.gw.lanes.size, 0)
      assertEquals(run.drv.prevId, previous.response.id)
      assertEquals(run.tg.events('completed').map((e) => e.data.response), [previous.response.id])
      await run.tg.waitEvent('kill', (d) => d.reason === 'failed: internal_error')
      run.fake.reply({ blocks: [text('retry succeeds')] })
      const retry = await run.send([user('second')]) // Reuses the WebSocket, proving its single-flight slot was released.
      assertEquals([retry.status, retry.response.x_gateway.path], ['completed', 'store'])
      assertEquals(retry.response.previous_response_id, previous.response.id)
      assert(sameRequest(run.fake.main()[1], run.fake.main()[2]), 'retry sees byte-identical model input and no failed-attempt tail')
    })
  })
}
