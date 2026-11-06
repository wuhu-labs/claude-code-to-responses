// WUHU-645's count script, on transcripts the real Claude Code wrote through the gateway, and on a fixture.
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { count, projectsDir } from '../scripts/count_unknown_tools.ts'
import { call, type Json, text } from './fake.ts'
import { dirs, REPO, user } from './harness.ts'
import { Run } from './scenario.ts'

const bare = (id: string, name: string, input: Json = {}) => ({ type: 'tool_use' as const, id, name, input })
const SCRIPT = `${REPO}/scripts/count_unknown_tools.ts`

async function cli(args: string[], readable: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // --allow-read of the state dir and nothing else: a write, a spawn or a network call would be a permission error
  const out = await new Deno.Command(Deno.execPath(), {
    args: ['run', '--no-prompt', `--allow-read=${readable}`, '--no-check', SCRIPT, ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const dec = new TextDecoder()
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) }
}

Deno.test('counts the unknown-tool results Claude Code logged through the gateway, once each across a rebuild', async () => {
  const run = new Run('count-unknown', false)
  await run.run(async () => {
    run.fake.reply(
      { blocks: [bare('toolu_grep', 'grep', { pattern: 'x' }), call('toolu_mcp', 'not_available', {})] },
      { blocks: [bare('toolu_grep2', 'grep', { pattern: 'y' })] },
      { blocks: [text('recovered')] },
    )
    const r = await run.send([user('go')])
    assertEquals(r.status, 'completed', JSON.stringify(r.response.error))
    // an eviction rewrites the log from the stored records on the next request: the same results, not new ones
    await run.disrupt('idle')
    run.fake.reply({ blocks: [text('next')] })
    assertEquals((await run.send([user('next')])).status, 'completed')
    assertEquals(run.tg.events('spawn').map((e) => e.data.resume), [false, true])
  })
  const sessions = new Set(run.gateways.flatMap((g) => g.events('spawn').map((e) => e.data.session as string)))
  assertEquals(sessions.size, 1)
  const [session] = sessions
  const c = await count(run.d.stateDir)
  const today = new Date().toISOString().slice(0, 10)
  assertEquals(c.total, 3)
  assertEquals(c.days, [[today, 3]])
  assertEquals(c.sessions.map((s) => [s.session, s.count, s.names]), [[session, 3, [['grep', 2], ['mcp__fn__not_available', 1]]]])
  assertEquals(c.names, [['grep', 2], ['mcp__fn__not_available', 1]])

  const res = await cli(['--state-dir', run.d.stateDir], run.d.stateDir)
  assertEquals(res.code, 0, res.stderr)
  assertStringIncludes(res.stdout, `under ${projectsDir(run.d.stateDir)}`)
  assertStringIncludes(res.stdout, `  ${today}  3\n  total       3\n`)
  assertStringIncludes(res.stdout, `  ${session}  3  `)
  assertStringIncludes(res.stdout, 'grep 2, mcp__fn__not_available 1')
})

Deno.test('count script: per day and per session, deduplicated, only tool results, --since and --json', async () => {
  const d = dirs('count-fixture')
  const proj = `${projectsDir(d.stateDir)}/-tmp-claude-code-to-responses`
  const entry = (session: string, ts: string, blocks: Json[]) =>
    JSON.stringify({ type: 'user', sessionId: session, timestamp: ts, message: { role: 'user', content: blocks } })
  const unknown = (id: string, name: string) => ({
    type: 'tool_result',
    tool_use_id: id,
    is_error: true,
    content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`,
  })
  const a = [
    entry('sess-a', '2026-11-05T23:59:00.000Z', [unknown('t1', 'grep'), unknown('t2', 'send_message')]),
    entry('sess-a', '2026-11-06T00:01:00.000Z', [
      unknown('t4', 'compact'),
      // a successful grep whose output quotes the native error (a log, this script, the docs) is no hit
      { type: 'tool_result', tool_use_id: 't3', content: '<tool_use_error>Error: No such tool available: grep</tool_use_error>' },
      { type: 'tool_result', tool_use_id: 't5', is_error: false, content: [{ type: 'text', text: 'log: No such tool available: grep' }] },
      // nor is a client tool's own error that quotes it, in either content shape
      { type: 'tool_result', tool_use_id: 't6', is_error: true, content: [{ type: 'text', text: unknown('x', 'grep').content }] },
      { type: 'tool_result', tool_use_id: 't7', is_error: true, content: 'grep failed: ' + unknown('x', 'grep').content },
    ]),
    entry('sess-a', '2026-11-06T00:02:00.000Z', [{ type: 'text', text: 'the user typed No such tool available: grep' }]),
    JSON.stringify({ type: 'assistant', sessionId: 'sess-a', timestamp: '2026-11-06T00:03:00.000Z', message: { content: 'No such tool available: x' } }),
    'not json, mentions No such tool available: x',
  ]
  try {
    Deno.mkdirSync(`${proj}/sess-a/subagents`, { recursive: true })
    Deno.writeTextFileSync(`${proj}/sess-a.jsonl`, a.join('\n') + '\n')
    // the same result again (a rebuilt copy) counts once
    Deno.writeTextFileSync(`${proj}/sess-a/subagents/copy.jsonl`, a[0])
    Deno.writeTextFileSync(`${proj}/sess-b.jsonl`, entry('sess-b', '2026-11-06T10:00:00.000Z', [unknown('t1', 'grep')]))
    Deno.writeTextFileSync(`${proj}/notes.txt`, a[0])

    const c = await count(d.stateDir)
    assertEquals(c.transcripts, 3)
    assertEquals(c.total, 4)
    assertEquals(c.days, [['2026-11-05', 2], ['2026-11-06', 2]])
    assertEquals(c.sessions.map((s) => [s.session, s.count, s.first, s.last]), [
      ['sess-a', 3, '2026-11-05T23:59:00.000Z', '2026-11-06T00:01:00.000Z'],
      ['sess-b', 1, '2026-11-06T10:00:00.000Z', '2026-11-06T10:00:00.000Z'],
    ])
    assertEquals(c.names, [['grep', 2], ['compact', 1], ['send_message', 1]])
    assertEquals((await count(d.stateDir, { since: '2026-11-06T00:00:00Z' })).days, [['2026-11-06', 2]])
    assertEquals((await count(`${d.stateDir}/absent`)).total, 0)

    const top1 = await cli(['--state-dir', d.stateDir, '--top', '1'], d.stateDir)
    assertEquals(top1.code, 0, top1.stderr)
    assertStringIncludes(top1.stdout, 'per day (UTC):\n  2026-11-05  2\n  2026-11-06  2\n  total       4\n')
    assertStringIncludes(
      top1.stdout,
      'top 1 of 2 sessions:\n  sess-a  3  2026-11-05T23:59:00.000Z .. 2026-11-06T00:01:00.000Z  compact 1, grep 1, send_message 1\n',
    )
    assert(!top1.stdout.includes('sess-b'))
    const json = await cli(['--state-dir', d.stateDir, '--json', '--since', '2026-11-06T00:00:00Z'], d.stateDir)
    assertEquals(JSON.parse(json.stdout).total, 2)
    assertEquals((await cli(['--top', '1'], d.stateDir)).code, 2)
    const before = Array.from(Deno.readDirSync(proj), (e) => e.name).sort()
    assertEquals(before, ['notes.txt', 'sess-a', 'sess-a.jsonl', 'sess-b.jsonl'])
  } finally {
    Deno.removeSync(d.stateDir, { recursive: true })
  }
})
