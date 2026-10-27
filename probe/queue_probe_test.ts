// The queue path paired with the old hook path on the pinned binary, never a paid endpoint.
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { contextOf, queuedNoticeEntry, userContentEntry } from '../src/claude/entries.ts'
import { call, FakeAnthropic, type Json, text } from '../test/fake.ts'
import { IMAGE_BLOCK } from '../test/images.ts'
import { assertPrefix, freePort } from '../test/harness.ts'
import { Probe, ProbeTarget } from './launcher.ts'

import { queueWrapper } from '../test/queue.ts'

for (const image of [false, true]) {
  Deno.test(`queue: 40 KB ${image ? 'image' : 'text'} notice, same step, subsequent prefix and interrupted resume`, async () => {
    const p = new Probe(), fake = new FakeAnthropic(freePort())
    try {
      const t = new ProbeTarget(['hold'])
      const r = p.launch({ name: 'queue', fake, target: t })
      fake.reply({ blocks: [call('toolu_queue', 'hold', {})] }, { blocks: [text('done')] })
      await r.user('go')
      await r.until((f) => f.type === 'stream_event' && f.event?.type === 'message_stop')
      const notice = 'NOTICE-BEGIN\n' + 'x'.repeat(40000) + '\nNOTICE-END'
      const parts = [{ type: 'text', text: notice }, ...(image ? [IMAGE_BLOCK] : [])]
      const from = r.frames.length
      await r.userContent(parts)
      await r.until((f) => f.type === 'transcript_mirror' && f.entries.some((e: Json) => e.type === 'queue-operation' && e.operation === 'enqueue'), 5000, from)
      assertEquals(fake.main().length, 1, 'tool still held at enqueue ack')
      // Release can race with a later MCP invocation: only the acknowledged queue is allowed to win.
      while (!t.held.has('toolu_queue')) await new Promise((resolve) => setTimeout(resolve, 1))
      t.release('toolu_queue', 'RESULT')
      await r.until((f) => f.type === 'result')
      assertEquals(fake.main().length, 2)
      const live = fake.main()[1].body
      const result = live.messages.flatMap((m: Json) => Array.isArray(m.content) ? m.content : []).find((b: Json) => b.type === 'tool_result')
      assertEquals(result.content[0].text, 'RESULT')
      const last = live.messages.at(-1)
      const blocks = last.content
      if (image) {
        assertEquals(last.role, 'user')
        assertEquals(blocks.map((b: Json) => b.type), ['tool_result', 'text', 'image'])
        assertEquals(blocks[1].text, '<system-reminder>\n' + queueWrapper(notice) + '\n</system-reminder>')
        assertEquals(blocks[2].source, IMAGE_BLOCK.source)
      } else {
        assertEquals(last.role, 'system')
        assertEquals(blocks[0].text, queueWrapper(notice))
      }
      // Subsequent steps must retain all previously model-visible bytes.
      fake.reply({ blocks: [text('later')] })
      await r.turn('next')
      assertPrefix(fake.main()[1], fake.main()[2])
      await r.kill()
      // Resume the interrupted turn using the gateway's synthetic queued-command attachment.
      const log = r.log()
      const queued = log.findIndex((l) => JSON.parse(l).attachment?.type === 'queued_command')
      const prefix = log.slice(0, queued)
      const ctx = contextOf(prefix, r.spec.sessionId, r.spec.workDir)
      const noticeParts = [
        { type: 'text' as const, text: notice },
        ...(image ? [{ type: 'image' as const, mediaType: 'image/png', data: IMAGE_BLOCK.source.data }] : []),
      ]
      prefix.push(JSON.stringify(queuedNoticeEntry(ctx, noticeParts)))
      prefix.push(JSON.stringify(userContentEntry(ctx, [])))
      fake.reply({ blocks: [text('resumed')] })
      const resumed = p.launch({
        name: 'queue-resume',
        fake,
        target: new ProbeTarget(['hold']),
        sessionId: r.spec.sessionId,
        workDir: r.spec.workDir,
        resume: true,
        interruptedTurn: true,
        log: prefix,
      })
      await resumed.until((f) => f.type === 'result')
      assertPrefix(fake.main()[1], fake.main()[3])
    } finally {
      await p.close()
      await fake.close()
    }
  })
}

Deno.test('queue paired control: a 40 KB hook notice is persisted/truncated, never delivered whole', async () => {
  const p = new Probe(), fake = new FakeAnthropic(freePort())
  try {
    const target = new ProbeTarget(['echo'])
    target.postToolNotice = 'HOOK-BEGIN' + 'x'.repeat(40000) + 'HOOK-END'
    const r = p.launch({ name: 'hook-cap', fake, target })
    fake.reply({ blocks: [call('toolu_hook', 'echo', {})] }, { blocks: [text('done')] })
    await r.turn('go')
    const body = JSON.stringify(fake.main()[1].body.messages)
    assertStringIncludes(body, '<persisted-output>')
    assert(!body.includes(target.postToolNotice ?? 'x'.repeat(40000)))
  } finally {
    await p.close()
    await fake.close()
  }
})

Deno.test('queue paired slash boundary: one-space guard works for turns but a mid-turn slash notice disappears', async () => {
  const p = new Probe(), fake = new FakeAnthropic(freePort())
  try {
    const target = new ProbeTarget(['hold'])
    const r = p.launch({ name: 'queue-slash', fake, target })
    fake.reply({ blocks: [call('toolu_slash', 'hold', {})] }, { blocks: [text('done')] }, { blocks: [text('turn')] })
    await r.user('go')
    await r.until((f) => f.type === 'stream_event' && f.event?.type === 'message_stop')
    const from = r.frames.length
    await r.user(' /compact')
    await r.until((f) => f.type === 'transcript_mirror' && f.entries.some((e: Json) => e.type === 'queue-operation' && e.operation === 'enqueue'), 5000, from)
    while (!target.held.has('toolu_slash')) await new Promise((resolve) => setTimeout(resolve, 1))
    target.release('toolu_slash', 'RESULT')
    await r.until((f) => f.type === 'result')
    assert(!JSON.stringify(fake.main()[1].body.messages).includes('/compact'))
    await r.turn(' /compact')
    assertStringIncludes(JSON.stringify(fake.main()[2].body.messages), ' /compact')
  } finally {
    await p.close()
    await fake.close()
  }
})
