// Eviction during a held call: the interrupted-turn resume with the gateway-written user text.
import { assert, assertEquals, assertExists } from '@std/assert'
import { RESUME_LINE } from '../src/claude/pins.ts'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text, think } from './fake.ts'
import { assertPrefix, output, user } from './harness.ts'
import { Run } from './scenario.ts'

/** The messages of a request from the assistant tool_use message on. */
function tailFrom(body: Json, callId: string): Json[] {
  const i = body.messages.findIndex((m: Json) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: Json) => b.id === callId))
  return body.messages.slice(i)
}

async function holdConversation(run: Run, withNotice: boolean) {
  const f = run.fake
  f.reply({ blocks: [text('ready')] })
  await run.turn('H1 warm up')
  f.reply({ blocks: [think('need two'), call('toolu_h1', 'echo', { text: 'slow' }), call('toolu_h2', 'read', { name: 'big' })] })
  const r = await run.send([user('H2 run two slow tools')])
  assertEquals(run.drv.calls(r).length, 2)
  // the tools run long: the process is evicted while Claude Code holds the first call
  await run.tg.waitEvent('hold', (d) => d.call === 'toolu_h1')
  await run.disrupt('hold')
  f.reply({ blocks: [text('H2 reply')] })
  const outs = [output('toolu_h2', 'BIG CONTENT'), output('toolu_h1', 'ECHO slow')]
  const r2 = await run.send(withNotice ? [...outs, user('NOTICE during the hold')] : outs)
  assertEquals(r2.status, 'completed', JSON.stringify(r2.response.error))
  // later evictions and a lost store must reproduce the resume text exactly
  await run.disrupt('idle')
  f.reply({ blocks: [text('H3 reply')] })
  await run.turn('H3 after another eviction')
  await run.disrupt('restart-lost-store')
  f.reply({ blocks: [text('H4 reply')] })
  await run.turn('H4 after a lost store')
}

for (const withNotice of [true, false]) {
  Deno.test(`eviction during a hold resumes the interrupted turn with ${withNotice ? 'the notices' : 'the fixed line'} as the user text`, async () => {
    const run = new Run(`hold-${withNotice ? 'notice' : 'plain'}`, false)
    await run.run(async () => {
      await holdConversation(run, withNotice)
      const reqs = run.fake.main()
      assertEquals(reqs.length, 5)
      const [, beforeHold, afterHold, h3, h4] = reqs
      // up to the held tool_use, the resumed request repeats the one before the eviction
      assertPrefix(beforeHold, { ...afterHold, body: { ...afterHold.body, messages: afterHold.body.messages.slice(0, beforeHold.body.messages.length) } })
      // then exactly the tool results and the gateway's user text: nothing Claude Code made up
      const tail = tailFrom(afterHold.body, 'toolu_h1')
      assertEquals(tail.length, 2, JSON.stringify(tail))
      const results = tail[1]
      assertEquals(results.role, 'user')
      const blocks = results.content
      assertEquals(blocks.map((b: Json) => b.type), ['tool_result', 'tool_result', 'text'])
      assertEquals(blocks.slice(0, 2).map((b: Json) => [b.tool_use_id, b.content[0].text]), [['toolu_h1', 'ECHO slow'], ['toolu_h2', 'BIG CONTENT']])
      assertEquals(blocks[2].text, withNotice ? 'NOTICE during the hold' : RESUME_LINE)
      assert(!JSON.stringify(afterHold.body).includes('No response requested'))
      if (withNotice) assert(!JSON.stringify(afterHold.body).includes(RESUME_LINE))
      // the resume text is in that response's provider record, so every later rebuild repeats it byte for byte
      const resumed = run.drv.results[2]
      assertEquals(resumed.response.x_gateway.resume, 'interrupted_turn')
      const rec = await decodeRecord(resumed.response.output.at(-1).encrypted_content)
      assertExists(rec)
      assert(rec.entries.some((e) => e.includes(withNotice ? 'NOTICE during the hold' : RESUME_LINE)))
      assertPrefix(afterHold, h3)
      assertPrefix(h3, h4)
      assertEquals(run.drv.results.at(-1)!.response.x_gateway.path, 'history')
    })
  })
}

Deno.test('the hold timeout kills a process whose held call outlives it; the client tool is untouched', async () => {
  const run = new Run('hold-timer', false, { holdTimeoutMs: 400 })
  await run.run(async () => {
    run.fake.reply({ blocks: [call('toolu_t', 'echo', { text: 'long' })] })
    const r = await run.send([user('start a long tool')])
    const pid = run.tg.events('spawn')[0].data.pid
    const killed = await run.tg.waitEvent('kill', (d) => d.reason === 'hold_timeout', 5000)
    assertEquals(killed.pid, pid)
    // the client's tool finishes much later; its output still lands
    await new Promise((res) => setTimeout(res, 300))
    run.fake.reply({ blocks: [text('finished')] })
    const r2 = await run.send([output(run.drv.calls(r)[0].call_id, 'LONG RESULT')])
    assertEquals(r2.status, 'completed')
    assertEquals(run.drv.text(r2), 'finished')
    assertEquals(r2.response.x_gateway.resume, 'interrupted_turn')
  })
})
