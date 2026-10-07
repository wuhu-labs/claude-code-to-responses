// The per-release probe: every Claude Code flag and environment variable the gateway pins (src/claude/pins.ts)
// still does what README.md says. Most checks are paired: the pin on, then the pin off, so each one shows its effect.
// Run against a new Claude Code release before adding it to the supported versions: `deno task probe`.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert'
import { assistantUuidFor, contextOf, toolResultEntry, userTextEntry } from '../src/claude/entries.ts'
import { CLAUDE_CODE_VERSION, launchArgs } from '../src/claude/pins.ts'
import { claudeVersion } from '../src/claude/process.ts'
import { call, FakeAnthropic, type Json, text, think } from '../test/fake.ts'
import { CLAUDE, freePort } from '../test/harness.ts'
import { Probe, ProbeTarget, without } from './launcher.ts'

const AGENT_SDK_LINE = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const reqText = (fake: FakeAnthropic) => fake.main().map((e) => e.raw).join('\n')
const toolNames = (b: Json) => (b.tools ?? []).map((t: Json) => t.name)

function probe(name: string, fn: (p: Probe, fake: FakeAnthropic) => Promise<void>) {
  Deno.test(name, async () => {
    const p = new Probe()
    const fake = new FakeAnthropic(freePort())
    try {
      await fn(p, fake)
      for (const r of p.runs) assert(!r.frames.some((f) => f.type === 'control_request'), 'no permission prompt or other host request')
    } finally {
      await p.close()
      await fake.close()
    }
  })
}

Deno.test(`version: the binary is Claude Code ${CLAUDE_CODE_VERSION}`, async () => {
  assertEquals(await claudeVersion(CLAUDE, { PATH: '/usr/bin:/bin', HOME: '/tmp', DISABLE_AUTOUPDATER: '1' }), CLAUDE_CODE_VERSION)
})

probe(
  'headless stream-json, --include-partial-messages, --session-mirror, --system-prompt, --model, --effort, backend env, hooks, toolUseId',
  async (p, fake) => {
    const t = new ProbeTarget(['echo'])
    t.postToolNotice = 'NOTICE-POST'
    const r = p.launch({ name: 'basic', fake, target: t })
    fake.reply({ blocks: [think('a'), call('toolu_b1', 'echo', { text: 'x' })] }, { blocks: [text('done')] })
    const res = await r.turn('hello')
    assertEquals(res.subtype, 'success')
    assert(r.frames.some((f) => f.type === 'system' && f.subtype === 'init'), 'init frame')
    assert(r.frames.some((f) => f.type === 'stream_event' && f.event?.type === 'message_stop'), '--include-partial-messages: stream events')
    // --session-mirror: transcript_mirror frames carry every log line, byte for byte, in order
    await new Promise((res) => setTimeout(res, 300))
    await r.kill()
    const mirrored = r.frames.filter((f) => f.type === 'transcript_mirror').flatMap((f) => f.entries.map((e: Json) => JSON.stringify(e)))
    assertEquals(mirrored, r.log())
    // CLAUDE_CONFIG_DIR + --session-id: the log lives in the isolated config dir under the session id
    assert(r.logFile.startsWith(r.spec.configDir) && r.logFile.endsWith(`${r.spec.sessionId}.jsonl`))
    const [first, second] = fake.main()
    assertEquals(first.body.system[1].text, AGENT_SDK_LINE)
    assertEquals(first.body.system[2].text, 'You are a probe.')
    assertEquals(first.body.model, 'claude-opus-5-5')
    assertEquals(first.body.output_config, { effort: 'high' })
    assertEquals(first.headers['authorization'], 'Bearer probe-key')
    // only the conversation's own requests reach the backend (plus Claude Code's /api/hello)
    assertEquals(fake.exchanges.filter((e) => e.kind !== 'main').map((e) => e.path), ['/api/hello'])
    // MCP calls carry Claude Code's tool_use id; the PostToolUse hook names it and renders its context as a system message
    assertEquals(t.calls.map((c) => c.id), ['toolu_b1'])
    const post = t.hooks.find((h) => h.hook_event_name === 'PostToolUse')
    assertEquals(post.tool_use_id, 'toolu_b1')
    assertEquals(second.body.messages.at(-1).role, 'system')
    assertEquals(second.body.messages.at(-1).content[0].text, 'PostToolUse:mcp__fn__echo hook additional context: NOTICE-POST')
  },
)

probe('--system-prompt-file: the prompt reaches the model byte for byte, as --system-prompt would send it, and stays off argv', async (p, fake) => {
  const prompt = '  Leading spaces\nunicode ünï — "quotes"\n\n'
  fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
  const viaFile = p.launch({ name: 'sp-file', fake, target: new ProbeTarget(), systemPrompt: prompt })
  await viaFile.turn('x')
  assert(!launchArgs(viaFile.spec).includes(prompt))
  const file = `${p.root}/sp-arg.system-prompt.txt`
  await p.launch({
    name: 'sp-arg',
    fake,
    target: new ProbeTarget(),
    systemPrompt: prompt,
    args: (a) => a.map((x, i) => (x === '--system-prompt-file' ? '--system-prompt' : a[i - 1] === '--system-prompt-file' ? Deno.readTextFileSync(file) : x)),
  }).turn('x')
  const [f, g] = fake.main()
  assertEquals(f.body.system[2].text, prompt)
  assertEquals(JSON.stringify(f.body.system), JSON.stringify(g.body.system))
})

probe('Stop hook additionalContext continues inference in the same turn', async (p, fake) => {
  const t = new ProbeTarget(['echo'])
  t.stopNotice = 'NOTICE-STOP'
  const r = p.launch({ name: 'stop', fake, target: t })
  fake.reply({ blocks: [text('first')] }, { blocks: [text('second')] })
  const res = await r.turn('go')
  assertEquals(res.result, 'second')
  assertEquals(fake.main().length, 2)
  assertStringIncludes(JSON.stringify(fake.main()[1].body.messages.at(-1)), 'Stop hook additional context: NOTICE-STOP')
})

probe('--tools "": no native tools, no Skill tool (paired with --tools default)', async (p, fake) => {
  fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
  const r1 = p.launch({ name: 'tools-none', fake, target: new ProbeTarget() })
  await r1.turn('x')
  assertEquals(toolNames(fake.main()[0].body), ['mcp__fn__echo', 'mcp__fn__hold'])
  const r2 = p.launch({ name: 'tools-default', fake, target: new ProbeTarget(), args: (a) => a.map((x, i) => (a[i - 1] === '--tools' ? 'default' : x)) })
  await r2.turn('x')
  const native = toolNames(fake.main()[1].body)
  assert(native.includes('Read') && native.length > 2, native.join(','))
})

probe('--setting-sources "": planted user and project settings (Stop hooks) are ignored (paired: dropping the flag runs them)', async (p, fake) => {
  const userMarker = `${p.root}/user-hook-ran`, projectMarker = `${p.root}/project-hook-ran`
  const work = `/tmp/cc2r-probe/planted-settings`
  Deno.mkdirSync(`${work}/.claude`, { recursive: true })
  Deno.mkdirSync(`${p.root}/config`, { recursive: true })
  const hook = (marker: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `/usr/bin/touch ${marker}` }] }] } })
  Deno.writeTextFileSync(`${p.root}/config/settings.json`, hook(userMarker))
  Deno.writeTextFileSync(`${work}/.claude/settings.json`, hook(projectMarker))
  fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
  await p.launch({ name: 'settings-pinned', fake, target: new ProbeTarget(), workDir: work }).turn('x')
  await new Promise((res) => setTimeout(res, 300))
  assert(!exists(userMarker) && !exists(projectMarker), 'no planted hook ran')
  await p.launch({ name: 'settings-open', fake, target: new ProbeTarget(), workDir: work, args: without('--setting-sources') }).turn('x')
  await new Promise((res) => setTimeout(res, 500))
  assert(exists(userMarker), 'without the flag the user settings hook runs')
  assert(exists(projectMarker), 'without the flag the project settings hook runs')
})

/** Plants an approved, observable MCP server in user scope (.claude.json) and project scope (.mcp.json). */
function plantMcp(p: Probe, work: string) {
  p.bridge.register('ep_planted', new ProbeTarget(['planted_tool']))
  const server = { type: 'http', url: p.bridge.mcpUrl('ep_planted'), headers: { Authorization: `Bearer ${p.bridge.bearer}` } }
  Deno.mkdirSync(`${p.root}/config`, { recursive: true })
  Deno.mkdirSync(work, { recursive: true })
  Deno.writeTextFileSync(`${p.root}/config/.claude.json`, JSON.stringify({ mcpServers: { planted: server } }))
  Deno.writeTextFileSync(`${work}/.mcp.json`, JSON.stringify({ mcpServers: { plantedproj: server } }))
}
const plantedTools = (b: Json) => toolNames(b).filter((n: string) => n.includes('planted'))

probe('--strict-mcp-config: with settings open, planted user and project MCP servers are ignored (paired: dropping the flag loads them)', async (p, fake) => {
  const work = '/tmp/cc2r-probe/planted-mcp-strict'
  plantMcp(p, work)
  fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
  const strict = p.launch({ name: 'mcp-strict', fake, target: new ProbeTarget(), workDir: work, args: without('--setting-sources') })
  await strict.turn('x')
  assertEquals(strict.frames.find((f) => f.subtype === 'init').mcp_servers.map((s: Json) => s.name), ['fn'])
  assertEquals(plantedTools(fake.main()[0].body), [])
  const open = p.launch({
    name: 'mcp-open',
    fake,
    target: new ProbeTarget(),
    workDir: work,
    args: (a) => without('--strict-mcp-config', false)(without('--setting-sources')(a)),
  })
  await open.turn('x')
  assertEquals(plantedTools(fake.main()[1].body), ['mcp__planted__planted_tool', 'mcp__plantedproj__planted_tool'])
})

probe('--setting-sources "" keeps planted MCP servers out on its own too (paired, with --strict-mcp-config dropped)', async (p, fake) => {
  const work = '/tmp/cc2r-probe/planted-mcp-sources'
  plantMcp(p, work)
  fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
  await p.launch({ name: 'mcp-sources-pinned', fake, target: new ProbeTarget(), workDir: work, args: without('--strict-mcp-config', false) }).turn('x')
  assertEquals(plantedTools(fake.main()[0].body), [])
  await p.launch({
    name: 'mcp-sources-open',
    fake,
    target: new ProbeTarget(),
    workDir: work,
    args: (a) => without('--strict-mcp-config', false)(without('--setting-sources')(a)),
  }).turn('x')
  assertEquals(plantedTools(fake.main()[1].body).length, 2)
})

function exists(p: string) {
  try {
    Deno.statSync(p)
    return true
  } catch {
    return false
  }
}

probe('ENABLE_TOOL_SEARCH=false: MCP tools load eagerly (paired with true, which defers them)', async (p, fake) => {
  fake.reply({ blocks: [text('a')] }, { blocks: [text('b')] })
  await p.launch({ name: 'search-off', fake, target: new ProbeTarget() }).turn('x')
  await p.launch({ name: 'search-on', fake, target: new ProbeTarget(), env: { ENABLE_TOOL_SEARCH: 'true' } }).turn('x')
  const [off, on] = fake.main()
  assertEquals(toolNames(off.body), ['mcp__fn__echo', 'mcp__fn__hold'])
  assert(!off.raw.includes('defer_loading'))
  assert(on.raw.includes('defer_loading'), 'tool search defers tools when enabled')
})

probe('DISABLE_AUTO_COMPACT=1: at the limit the turn ends as blocking_limit, no compaction (paired)', async (p, fake) => {
  fake.reply({ blocks: [text('huge')], usage: { input_tokens: 960_000 } })
  const r = p.launch({ name: 'compact-off', fake, target: new ProbeTarget() })
  await r.turn('one')
  const res = await r.turn('two')
  assertEquals([res.is_error, res.terminal_reason, res.result], [true, 'blocking_limit', 'Prompt is too long'])
  assertEquals(fake.exchanges.filter((e) => e.kind !== 'other').length, 1, 'no second request, no compaction request')
  fake.reply({ blocks: [text('huge')], usage: { input_tokens: 960_000 } })
  const r2 = p.launch({ name: 'compact-on', fake, target: new ProbeTarget(), env: { DISABLE_AUTO_COMPACT: undefined } })
  await r2.turn('one')
  const from = r2.frames.length
  await r2.user('two')
  await r2.until((f) => f.type === 'result' || (f.type === 'system' && f.status === 'compacting'), 30000, from)
  assert(r2.frames.slice(from).some((f) => f.type === 'system' && f.status === 'compacting'), 'without the pin Claude Code compacts')
})

probe('CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off: no token counts in the prompt (paired)', async (p, fake) => {
  fake.reply({ blocks: [call('toolu_t', 'echo', {})] }, { blocks: [text('a')] })
  await p.launch({ name: 'tokens-off', fake, target: new ProbeTarget() }).turn('x')
  assert(!reqText(fake).includes('<total_tokens>'))
  const n = fake.main().length
  fake.reply({ blocks: [call('toolu_t2', 'echo', {})] }, { blocks: [text('a')] })
  await p.launch({ name: 'tokens-on', fake, target: new ProbeTarget(), env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: undefined } }).turn('x')
  assert(fake.main().slice(n).some((e) => e.raw.includes('<total_tokens>')))
})

probe('CLAUDE_CODE_SILENT_TURN_REMINDER=0: no "hasn\'t heard from you" reminder after silent tool rounds (paired)', async (p, fake) => {
  for (const [label, v] of [['silent-off', '0'], ['silent-on', undefined]] as const) {
    const n = fake.main().length
    for (let i = 0; i < 7; i++) fake.reply({ blocks: [call(`toolu_${label}_${i}`, 'echo', {})] })
    fake.reply({ blocks: [text('done')] })
    await p.launch({ name: label, fake, target: new ProbeTarget(['echo']), env: { CLAUDE_CODE_SILENT_TURN_REMINDER: v } }).turn('go')
    const seen = fake.main().slice(n).some((e) => e.raw.includes("hasn't heard from you"))
    assertEquals(seen, v === undefined, label)
  }
})

probe('anthropic/maxResultSizeChars + MAX_MCP_OUTPUT_TOKENS: results up to 500,000 characters stay inline (paired)', async (p, fake) => {
  const cases: [string, number[], boolean][] = [['one-500k', [500_000], true], ['ten-30k', Array(10).fill(30_000), true], ['no-meta-60k', [60_000], false]]
  for (const [label, sizes, meta] of cases) {
    const t = new ProbeTarget(['echo'])
    t.withMeta = meta
    let k = 0
    t.resultFor = () => ({ content: [{ type: 'text', text: 'r'.repeat(sizes[k++]) }] })
    fake.reply({ blocks: sizes.map((_, i) => call(`toolu_${label.replace(/\W/g, '')}_${i}`, 'echo', {})) }, { blocks: [text('done')] })
    await p.launch({ name: label, fake, target: t }).turn('go', 60000)
    const results = fake.main().at(-1)!.body.messages.at(-1).content.filter((b: Json) => b.type === 'tool_result')
    if (meta) {
      assertEquals(results.map((b: Json) => b.content[0].text.length), sizes, label)
    } else {
      assertStringIncludes(JSON.stringify(results[0]), '<persisted-output>', 'without the annotation Claude Code moves the result to a file')
    }
  }
})

probe('CLAUDE_CODE_MAX_RETRIES=0 and the error result: an upstream error ends the turn at once as api_error with its status (paired)', async (p, fake) => {
  const cases: [number, string][] = [[400, 'invalid_request_error'], [401, 'authentication_error'], [429, 'rate_limit_error'], [500, 'api_error'], [
    529,
    'overloaded_error',
  ]]
  for (const [status, type] of cases) {
    const n = fake.main().length
    fake.reply({ blocks: [text('never')], error: { status, type, message: `probe ${status}` } })
    const res = await p.launch({ name: `err-${status}`, fake, target: new ProbeTarget() }).turn('x')
    assertEquals([res.is_error, res.terminal_reason, res.api_error_status], [true, 'api_error', status], String(status))
    assertStringIncludes(res.result, 'API Error')
    assertEquals(fake.main().length - n, 1, `${status}: no retry`)
  }
  // without the pin Claude Code retries by itself
  fake.fallback = () => ({ blocks: [text('never')], error: { status: 529, type: 'overloaded_error', message: 'probe' } })
  const r = p.launch({ name: 'err-retrying', fake, target: new ProbeTarget(), env: { CLAUDE_CODE_MAX_RETRIES: undefined } })
  await r.user('x')
  const retry = await r.until((f) => f.type === 'system' && f.subtype === 'api_retry', 20000)
  assertEquals(retry.error_status, 529)
})

probe(
  'MAX_MCP_OUTPUT_TOKENS lifts the 25,000-token cap on MCP results (paired, without the size annotation); with the annotation it is a backstop only',
  async (p, fake) => {
    const big = (label: string, meta: boolean, env: Record<string, string | undefined>, size: number) => {
      const t = new ProbeTarget(['echo'])
      t.withMeta = meta
      t.resultFor = () => ({ content: [{ type: 'text', text: 'r'.repeat(size) }] })
      fake.reply({ blocks: [call(`toolu_${label.replace(/\W/g, '')}`, 'echo', {})] }, { blocks: [text('done')] })
      return p.launch({ name: label, fake, target: t, env }).turn('go', 60000).then(() =>
        fake.main().at(-1)!.body.messages.at(-1).content.find((b: Json) => b.type === 'tool_result')
      )
    }
    // without the annotation: unset, the token cap refuses the result; set, it passes the cap (and the size limit applies)
    const capped = JSON.stringify(await big('cap-unset', false, { MAX_MCP_OUTPUT_TOKENS: undefined }, 120_000))
    assertStringIncludes(capped, 'exceeds maximum allowed tokens')
    const lifted = JSON.stringify(await big('cap-set', false, {}, 120_000))
    assert(!lifted.includes('exceeds maximum allowed tokens'))
    assertStringIncludes(lifted, '<persisted-output>')
    // with the annotation a 500,000-character result stays inline either way
    for (const [label, env] of [['annotated-set', {}], ['annotated-unset', { MAX_MCP_OUTPUT_TOKENS: undefined }]] as const) {
      assertEquals((await big(label, true, env, 500_000)).content[0].text.length, 500_000, label)
    }
  },
)

Deno.test("a device id seeded as userID in the config folder's .claude.json becomes metadata.user_id's device_id (paired with a fresh folder)", async () => {
  const fake = new FakeAnthropic(freePort())
  const device = 'd'.repeat(32) + 'e'.repeat(32)
  const seen: string[] = []
  try {
    for (const seed of [true, false, true]) {
      const p = new Probe()
      try {
        Deno.mkdirSync(`${p.root}/config`, { recursive: true })
        if (seed) Deno.writeTextFileSync(`${p.root}/config/.claude.json`, JSON.stringify({ userID: device }))
        fake.reply({ blocks: [text('a')] })
        const r = p.launch({ name: 'device', fake, target: new ProbeTarget() })
        await r.turn('x')
        const meta = JSON.parse(fake.main().at(-1)!.body.metadata.user_id)
        assertEquals(meta.session_id, r.spec.sessionId)
        seen.push(meta.device_id)
        // Claude Code keeps the seeded id (and writes a generated one to the same key)
        assertEquals(JSON.parse(Deno.readTextFileSync(`${p.root}/config/.claude.json`)).userID, meta.device_id)
      } finally {
        await p.close()
      }
    }
  } finally {
    await fake.close()
  }
  assertEquals(seen[0], device)
  assertEquals(seen[2], device)
  assert(/^[0-9a-f]{64}$/.test(seen[1]) && seen[1] !== device, 'a fresh folder generates its own id')
})

probe('a log rebuilt from the mirrored entries resumes into a byte-identical request', async (p, fake) => {
  const work = '/tmp/cc2r-probe/rebuild'
  const script = () => {
    fake.reply({ blocks: [think('a'), text('one')] })
    fake.reply({ blocks: [call('toolu_rb', 'echo', { text: 'x' })] }, { blocks: [text('two')] })
    fake.reply({ blocks: [text('three')] })
  }
  script()
  const live = p.launch({ name: 'rb-live', fake, target: new ProbeTarget(), workDir: work })
  for (const m of ['one', 'two', 'three']) await live.turn(m)
  await live.kill()
  script()
  const a = p.launch({ name: 'rb-a', fake, target: new ProbeTarget(), workDir: work })
  for (const m of ['one', 'two']) await a.turn(m)
  await new Promise((res) => setTimeout(res, 300))
  await a.kill()
  const entries = a.frames.filter((f) => f.type === 'transcript_mirror').flatMap((f) => f.entries.map((e: Json) => JSON.stringify(e)))
  const b = p.launch({ name: 'rb-b', fake, target: new ProbeTarget(), workDir: work, sessionId: a.spec.sessionId, resume: true, log: entries })
  await b.turn('three')
  const reqs = fake.main()
  const strip = (e: Json) => JSON.stringify({ ...e.body, metadata: null })
  assertEquals(strip(reqs[7]), strip(reqs[3]))
})

probe('CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1: tool results + a user text resume the turn with nothing foreign (paired)', async (p, fake) => {
  const t = new ProbeTarget(['hold'])
  fake.reply({ blocks: [call('toolu_h', 'hold', {})] })
  const a = p.launch({ name: 'r7-a', fake, target: t })
  await a.user('hold please')
  while (!t.held.has('toolu_h')) await new Promise((res) => setTimeout(res, 50))
  await new Promise((res) => setTimeout(res, 300))
  await a.kill()
  const log = a.log()
  const ctx = contextOf(log, a.spec.sessionId, a.spec.workDir)
  const tail = [
    toolResultEntry(ctx, 'toolu_h', [{ type: 'text', text: 'HELD RESULT' }], assistantUuidFor(log, 'toolu_h')),
    userTextEntry(ctx, 'NOTICE AS USER TEXT'),
  ].map((e) => JSON.stringify(e))
  // without the variable nothing happens
  const n = fake.main().length
  const quiet = p.launch({ name: 'r7-quiet', fake, target: t, workDir: a.spec.workDir, sessionId: a.spec.sessionId, resume: true, log: [...log, ...tail] })
  await new Promise((res) => setTimeout(res, 5000))
  assertEquals(fake.main().length, n, 'no request without CLAUDE_CODE_RESUME_INTERRUPTED_TURN')
  await quiet.kill()
  fake.reply({ blocks: [text('resumed')] })
  const b = p.launch({
    name: 'r7-b',
    fake,
    target: t,
    workDir: a.spec.workDir,
    sessionId: a.spec.sessionId,
    resume: true,
    interruptedTurn: true,
    log: [...log, ...tail],
  })
  await b.until((f) => f.type === 'result', 20000)
  const msgs = fake.main().at(-1)!.body.messages
  const last = msgs.at(-1)
  assertEquals(last.role, 'user')
  assertEquals(last.content.map((c: Json) => c.type), ['tool_result', 'text'])
  assertEquals(last.content[1].text, 'NOTICE AS USER TEXT')
  assert(!fake.main().at(-1)!.raw.includes('Continue from where you left off'))
  assertEquals(msgs.at(-2).content[0].id, 'toolu_h')
  assertEquals(msgs.length, 4, 'nothing after the user text')
})

probe('a resumed log without the atis-latch line gets one written outside the mirror; with it, nothing is', async (p, fake) => {
  fake.reply({ blocks: [text('one')] }, { blocks: [text('two')] }, { blocks: [text('three')] })
  const a = p.launch({ name: 'latch-a', fake, target: new ProbeTarget() })
  await a.turn('one')
  await new Promise((res) => setTimeout(res, 300))
  await a.kill()
  const full = a.log()
  assert(full.some((l) => l.includes('"atis-latch"')))
  for (const [label, log] of [['latch-kept', full], ['latch-dropped', full.filter((l) => !l.includes('"atis-latch"'))]] as const) {
    const b = p.launch({ name: label, fake, target: new ProbeTarget(), workDir: a.spec.workDir, sessionId: a.spec.sessionId, resume: true, log })
    await b.turn('again')
    await new Promise((res) => setTimeout(res, 300))
    await b.kill()
    const mirrored = b.frames.filter((f) => f.type === 'transcript_mirror').flatMap((f) => f.entries.map((e: Json) => JSON.stringify(e)))
    const extra = b.log().slice(log.length).filter((l) => !mirrored.includes(l))
    assertEquals(extra.map((l) => JSON.parse(l).type), label === 'latch-kept' ? [] : ['atis-latch'], label)
  }
})

probe('TZ decides the date Claude Code announces', async (p, fake) => {
  for (const tz of ['Etc/GMT+12', 'Etc/GMT-14']) {
    fake.reply({ blocks: [text('a')] })
    await p.launch({ name: `tz${tz.replace(/\W/g, '')}`, fake, target: new ProbeTarget(), tz }).turn('x')
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    assertStringIncludes(JSON.stringify(fake.main().at(-1)!.body.messages[1]), `Today's date is ${date}.`)
  }
  const [x, y] = fake.main()
  assertNotEquals(JSON.stringify(x.body.messages[1]), JSON.stringify(y.body.messages[1]))
})

probe('MCP server timeout 2147483647: a call held 65 s still returns (the HTTP default would give up at 60 s)', async (p, fake) => {
  const t = new ProbeTarget(['hold'])
  fake.reply({ blocks: [call('toolu_long', 'hold', {})] }, { blocks: [text('done')] })
  const r = p.launch({ name: 'long-hold', fake, target: t })
  await r.user('hold')
  while (!t.held.has('toolu_long')) await new Promise((res) => setTimeout(res, 50))
  await new Promise((res) => setTimeout(res, 65_000))
  t.release('toolu_long', 'AFTER 65 S')
  const res = await r.until((f) => f.type === 'result', 20000)
  assertEquals(res.result, 'done')
  assertStringIncludes(fake.main().at(-1)!.raw, 'AFTER 65 S')
})
