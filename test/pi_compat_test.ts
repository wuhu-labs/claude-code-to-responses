import { assertEquals, assertExists, assertRejects } from '@std/assert'
import { call, type Json, text } from './fake.ts'
import { output, send, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

Deno.test('HTTP history with reserialized function arguments replays the original model bytes', async () => {
  const run = new Run('pi-arguments', false)
  await run.run(async () => {
    const body = { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS }
    const input = [user('Use the tool.')]
    run.fake.reply({ blocks: [call('toolu_pi', 'echo', { z: ['a', { y: 1, x: true }], a: 'text' })] }, { blocks: [text('Done.')] })
    const first = await send(run.tg.client, { ...body, input })
    const original = first.response.output.find((item: Json) => item.type === 'function_call')
    assertExists(original)
    const result = output(original.call_id, 'Tool output')
    await run.tg.evictAll()
    const continued = await send(run.tg.client, { ...body, previous_response_id: first.response.id, input: [result] })
    assertEquals([continued.status, continued.response.x_gateway.path], ['completed', 'store'])
    const giveHistory = (args: string) =>
      send(run.tg.client, {
        ...body,
        input: [...input, ...first.response.output.map((item: Json) => item.id === original.id ? { ...item, arguments: args } : item), result],
      })
    await run.disrupt('restart-lost-store')
    const replayed = await giveHistory('{ "a": "text", "z": ["a", {"x":true,"y":1}] }')
    assertEquals([replayed.status, replayed.response.x_gateway.records, replayed.response.x_gateway.synthesized_groups], ['completed', 1, 0])
    assertEquals(run.fake.main()[2].raw, run.fake.main()[1].raw)
    const changed = await giveHistory('{"a":"text","z":["a",{"x":true,"y":2}]}')
    assertEquals([changed.status, changed.response.x_gateway.records, changed.response.x_gateway.synthesized_groups], ['completed', 0, 1])
    const malformed = await assertRejects(() => giveHistory('[]')) as { status?: number; code?: string }
    assertEquals([malformed.status, malformed.code], [400, 'invalid_function_arguments'])
  })
})
