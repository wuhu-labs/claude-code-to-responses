// WUHU-645: the gateway appends one constant line to the client's system prompt, naming the prefix Claude Code gives
// client tools. The client's bytes come first, unchanged; the line is the same for every chain and tool set.
import { assertEquals } from '@std/assert'
import { systemPrompt, TOOL_NAME_LINE } from '../src/claude/pins.ts'
import { decodeRecord } from '../src/records.ts'
import { call, type Json, text } from './fake.ts'
import { assertPrefix, Driver, output, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, scenarioTest } from './scenario.ts'

// the exact bytes, spelled out rather than imported, so a change to the line is a deliberate test edit
const LINE = 'The tools this prompt names, such as send_message, are available as mcp__fn__send_message and so on.'
const SUFFIX = '\n\n' + LINE

Deno.test('the tool-name line is the documented constant, after a blank line, with the client text untouched', () => {
  assertEquals(TOOL_NAME_LINE, LINE)
  for (const s of ['', 'x', '  padded\r\n', 'ends with newline\n', 'mentions send_message and mcp__fn__send_message']) {
    assertEquals(systemPrompt(s), s + SUFFIX)
  }
})

scenarioTest('Claude Code receives the client prompt byte for byte plus the one constant line, across chains, tool sets and a rebuild', async () => {
  const run = new Run('tool-name-line', false)
  await run.run(async () => {
    // chain 1: the scenario tools, a tool round
    run.fake.reply({ blocks: [call('toolu_line', 'echo', { text: 'x' })] }, { blocks: [text('one')] })
    const held = await run.send([user('call echo')])
    const done = await run.send([output('toolu_line', 'ECHO x')])
    assertEquals(run.drv.text(done), 'one')
    assertEquals(done.response.instructions, INSTRUCTIONS, 'the response echoes the client prompt, not the gateway line')
    assertEquals((await decodeRecord(held.response.output.at(-1).encrypted_content))!.instructions, INSTRUCTIONS)
    const [a1, a2] = run.fake.main()
    assertEquals(a1.body.system[2].text, INSTRUCTIONS + SUFFIX)
    assertEquals(a1.raw.includes(JSON.stringify(INSTRUCTIONS + SUFFIX)), true, 'the raw request body carries exactly these bytes')
    assertPrefix(a1, a2)

    // chain 2: another prompt and another tool set (none, then one differently named tool)
    for (const [i, tools] of [[], [{ type: 'function', name: 'send_message', description: 'Send.', parameters: { type: 'object' } }]].entries()) {
      const prompt = `Another prompt ${i}, naming send_message.\n`
      const d = new Driver(run.drv.client, { instructions: prompt, tools: tools as Json[], model: MODEL, mode: 'previous' })
      d.sender = run.drv.sender ? (body) => run.drv.sender!(body) : null
      run.fake.reply({ blocks: [text(`chain ${i}`)] })
      const r = await d.send([user('hi')])
      assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
      const b = run.fake.main().at(-1)!
      assertEquals(b.body.system[2].text, prompt + SUFFIX)
      // system[0] is Claude Code's billing header, whose cc_version suffix hashes the first user message
      assertEquals(JSON.stringify(b.body.system[1]), JSON.stringify(a1.body.system[1]))
      assertEquals(b.body.system.length, a1.body.system.length)
    }

    // the first chain, rebuilt from its records on a gateway that lost its store: the same system blocks
    await run.disrupt('restart-lost-store')
    run.fake.reply({ blocks: [text('later')] })
    const later = await run.send([user('next')])
    assertEquals(later.status, 'completed', JSON.stringify(later.response.error))
    const rebuilt = run.fake.main().at(-1)!
    assertEquals(rebuilt.body.system[2].text, INSTRUCTIONS + SUFFIX)
    assertPrefix(a2, rebuilt)
  })
})
