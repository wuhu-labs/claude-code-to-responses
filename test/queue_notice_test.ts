import { assert, assertEquals } from '@std/assert'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { assertPrefix, output, user } from './harness.ts'
import { IMAGE, PNG } from './images.ts'
import { queueWrapper } from './queue.ts'
import { Run } from './scenario.ts'

for (const image of [false, true]) {
  Deno.test(`queue gateway: 40 KB ${image ? 'image' : 'text'} notice survives live, idle and lost-store cache prefixes`, async () => {
    const run = new Run(`queue-large-${image}`, false)
    await run.run(async () => {
      const notice = 'NOTICE-BEGIN\n' + 'x'.repeat(40000) + '\nNOTICE-END'
      run.fake.reply({ blocks: [call('toolu_large', 'echo', {})] }, { blocks: [text('seen')] })
      await run.send([user('go')])
      const r = await run.send([
        output('toolu_large', 'RESULT'),
        image ? { role: 'user', content: [{ type: 'input_text', text: notice }, IMAGE] } : user(notice),
      ])
      assertEquals(r.status, 'completed')
      assertEquals(run.fake.main().length, 2)
      const blocks = run.fake.main()[1].body.messages.flatMap((m: Json) => Array.isArray(m.content) ? m.content : [])
      assert(blocks.some((b: Json) => b.text === (image ? '<system-reminder>\n' + queueWrapper(notice) + '\n</system-reminder>' : queueWrapper(notice))))
      assertEquals(blocks.find((b: Json) => b.type === 'tool_result').content[0].text, 'RESULT')
      assertEquals(run.tg.events('spawn').length, 1, 'images do not evict the process')
      const record = (await decodeRecord(r.response.output.at(-1).encrypted_content))!
      assert(!JSON.stringify(record).includes(PNG), 'record templates never embed image bytes')
      for (const disruption of ['idle', 'restart-lost-store'] as const) {
        const before = run.fake.main().at(-1)!
        await run.disrupt(disruption)
        run.fake.reply({ blocks: [text('next')] })
        await run.turn('next')
        assertPrefix(before, run.fake.main().at(-1)!)
      }
    })
  })
}
