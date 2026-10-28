import { assert, assertEquals, assertMatch } from '@std/assert'
import { parseRequest } from '../src/api/request.ts'
import { type EventSink, ResponseState } from '../src/api/stream.ts'
import type { Bridge } from '../src/bridge.ts'
import type { ClaudeProcess } from '../src/claude/process.ts'
import type { Config } from '../src/config.ts'
import { serverError } from '../src/errors.ts'
import {
  diagnosticMessageId,
  FAILURE_LOG_MAX_BYTES,
  type FailureDiagnostic,
  FailureLog,
  MALFORMED_REASONS,
  type MalformedReason,
  shape,
  toolArgumentsError,
  toolHeaderError,
  toolSummary,
} from '../src/failures.ts'
import { Active, Lane } from '../src/lane.ts'
import { ResponseStore } from '../src/store.ts'
import { type Json, text } from './fake.ts'
import { sameRequest, user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

const good = { type: 'tool_use', id: 'toolu_safe', name: 'mcp__fn__echo', input: { 'PRIVATE-KEY': 'PRIVATE-VALUE' } }
const cases: {
  reason: MalformedReason | 'internal_error' | 'claude_code_killed'
  header?: Json
  args?: string
  field: string
  type: string
  length: number | null
}[] = [
  { reason: 'id_missing', header: { ...good, id: undefined }, field: 'id', type: 'missing', length: null },
  { reason: 'id_type', header: { ...good, id: 42 }, field: 'id', type: 'number', length: null },
  { reason: 'id_length', header: { ...good, id: 'x'.repeat(129) }, field: 'id', type: 'string', length: 129 },
  { reason: 'id_charset', header: { ...good, id: 'private/id' }, field: 'id', type: 'string', length: 10 },
  { reason: 'name_missing', header: { ...good, name: undefined }, field: 'name', type: 'missing', length: null },
  { reason: 'name_type', header: { ...good, name: { 'PRIVATE-KEY': 'PRIVATE-VALUE' } }, field: 'name', type: 'object', length: null },
  { reason: 'name_length', header: { ...good, name: 'x'.repeat(65) }, field: 'name', type: 'string', length: 65 },
  { reason: 'name_charset', header: { ...good, name: 'private/tool' }, field: 'name', type: 'string', length: 12 },
  { reason: 'input_missing', header: { ...good, input: undefined }, field: 'input', type: 'missing', length: null },
  { reason: 'input_not_object', header: { ...good, input: ['PRIVATE-VALUE'] }, field: 'input', type: 'array', length: 1 },
  { reason: 'arguments_invalid_json', args: '{"PRIVATE-KEY":"PRIVATE-VALUE"', field: 'arguments', type: 'string', length: 30 },
  { reason: 'arguments_not_object', args: '["PRIVATE-VALUE"]', field: 'arguments', type: 'string', length: 17 },
  { reason: 'tool_use_without_tool', field: 'stop_reason', type: 'string', length: 8 },
]

// Drive the actual lane failure sites without asking Claude Code to repair/drop a deliberately malformed frame.
for (
  const c of [
    ...cases,
    ...(['internal_error', 'claude_code_killed'] as const).map((reason) => ({
      reason,
      header: undefined,
      args: undefined,
      field: null,
      type: null,
      length: null,
    })),
  ]
) {
  Deno.test(`failure diagnostics: lane ${c.reason} is typed, durable before kill and value-free`, async () => {
    const root = Deno.makeTempDirSync()
    const log = new FailureLog(root)
    const state = new ResponseState(parseRequest({ model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, input: 'PRIVATE-PROMPT' }))
    const terminal: Json[] = [], order: string[] = []
    const sink: EventSink = {
      isClosed: false,
      onCancel: null,
      prepare() {
        return () => true
      },
      send(type, data) {
        if (type === 'response.failed') {
          order.push('terminal')
          terminal.push(data.response)
        }
      },
      close() {},
    }
    const config = { stateDir: root, workDir: root } as Config
    const lane = new Lane(
      'session_safe',
      root,
      { key: 'chain', model: MODEL, effort: 'high', instructions: INSTRUCTIONS, maxOutputTokens: null, tools: state.req.tools },
      null,
      config,
      { unregister() {} } as unknown as Bridge,
      new ResponseStore(root),
      {
        failure(record) {
          log.append(record)
          order.push('persist')
        },
        note() {},
        dead() {},
        gone() {},
        usage() {},
      },
    )
    lane.attach(new Active(state, sink, 'resp_previous', []))
    let atKill: FailureDiagnostic | null = null
    lane.proc = {
      pid: 123,
      kill() {
        order.push('kill')
        atKill = JSON.parse(Deno.readTextFileSync(log.path))
        return Promise.resolve()
      },
    } as unknown as ClaudeProcess
    const stream = (event: Json) => (lane as unknown as { streamEvent(e: Json): void }).streamEvent(event)
    try {
      stream({ type: 'message_start', message: { id: 'msg_safe' } })
      if (c.reason === 'internal_error') lane.fail(serverError('internal_error', 'PRIVATE-ERROR'))
      else if (c.reason === 'claude_code_killed') void lane.kill('PRIVATE-KILL-REASON')
      else if (c.header) stream({ type: 'content_block_start', index: 3, content_block: { ...c.header, text: 'PRIVATE-TEXT' } })
      else if (c.args !== undefined) {
        stream({ type: 'content_block_start', index: 3, content_block: good })
        stream({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: c.args } })
        stream({ type: 'content_block_stop', index: 3 })
      } else {
        stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
        stream({ type: 'message_stop' })
      }
      await lane.gone
      assertEquals(order, ['persist', 'terminal', 'kill'])
      assertEquals(terminal.length, 1)
      const isMalformed = MALFORMED_REASONS.includes(c.reason as MalformedReason)
      assertEquals(terminal[0].error.code, isMalformed ? 'malformed_model_message' : c.reason)
      assertEquals(terminal[0].error.reason, isMalformed ? c.reason : undefined)
      assert(atKill)
      const d = atKill as FailureDiagnostic
      assertEquals([d.response_id, d.previous_response_id, d.claude_session_id, d.message_id], [state.id, 'resp_previous', 'session_safe', 'msg_safe'])
      assertEquals([d.reason, d.block_index, d.failed_field, d.field?.type ?? null, d.field?.length ?? null], [
        isMalformed ? c.reason : null,
        c.reason === 'tool_use_without_tool' || !isMalformed ? null : 3,
        c.field,
        c.type,
        c.length,
      ])
      assertMatch(d.time, /^\d{4}-\d\d-\d\dT/)
      const raw = Deno.readTextFileSync(log.path)
      for (
        const privateValue of [
          'PRIVATE-PROMPT',
          'PRIVATE-TEXT',
          'PRIVATE-KEY',
          'PRIVATE-VALUE',
          'PRIVATE-ERROR',
          'PRIVATE-KILL-REASON',
          'private/id',
          'private/tool',
        ]
      ) {
        assert(!raw.includes(privateValue), `diagnostic leaked ${privateValue}`)
      }
      if (c.reason === 'name_charset' || c.reason === 'name_length') {
        assertEquals(d.tool?.name, undefined)
        assertMatch(d.tool!.hash!, /^[a-f0-9]{16}$/)
      }
      lane.fail(serverError('internal_error', 'PRIVATE-ERROR')) // duplicate failure is not logged
      assertEquals(Deno.readTextFileSync(log.path).split('\n').filter(Boolean).length, 1)
    } finally {
      await lane.gone
      Deno.removeSync(root, { recursive: true })
    }
  })
}

Deno.test('failure diagnostics: every reason is covered and original header/argument boundaries stay strict', () => {
  assertEquals(cases.map((c) => c.reason), [...MALFORMED_REASONS])
  for (const field of ['id', 'name']) {
    assertEquals(toolHeaderError({ ...good, [field]: '' }, 0)?.reason, `${field}_length`)
    assertEquals(toolHeaderError({ ...good, [field]: null }, 0)?.reason, `${field}_type`)
    for (const bad of ['with.space', 'with space', 'ü', 'x\n']) {
      assertEquals(toolHeaderError({ ...good, [field]: bad }, 0)?.reason, `${field}_charset`)
    }
  }
  assertEquals(toolHeaderError({ ...good, id: 'x'.repeat(128), name: 'x'.repeat(64) }, 0), null)
  for (const input of [null, 0, false, '', []]) assertEquals(toolHeaderError({ ...good, input }, 0)?.reason, 'input_not_object')
  for (const buf of ['', '  \n', '{}', '{"PRIVATE-KEY":"PRIVATE-VALUE"}']) assertEquals(toolArgumentsError(buf, 0, toolSummary(good.name)), null)
  for (const buf of ['null', 'false', '42', '"PRIVATE-VALUE"', '[]']) {
    assertEquals(toolArgumentsError(buf, 0, toolSummary(good.name))?.reason, 'arguments_not_object')
  }
  assertEquals(toolArgumentsError('{', 0, toolSummary(good.name))?.details.input, shape(undefined))
  assertEquals(shape({ 'PRIVATE-KEY': 'PRIVATE-VALUE' }), { type: 'object', length: null, key_count: 1 })
  assertEquals(toolSummary('private/tool'), { type: 'string', length: 12, hash: 'cbe8072a674ba4b1' })
  assertEquals(diagnosticMessageId('PRIVATE/TEXT'), null)
  assertEquals(diagnosticMessageId('x'.repeat(129)), null)
})

Deno.test('failure diagnostics: log survives reopening, rotates with bounded bytes and private permissions', () => {
  const root = Deno.makeTempDirSync()
  try {
    const log = new FailureLog(root)
    const record: FailureDiagnostic = {
      time: '2026-10-08T06:43:52.000Z',
      response_id: 'resp_safe',
      previous_response_id: null,
      claude_session_id: 'session_safe',
      message_id: 'msg_safe',
      code: 'malformed_model_message',
      reason: 'name_charset',
      block_index: 0,
      failed_field: 'name',
      field: shape('private/tool'),
      tool: toolSummary('private/tool'),
      input: shape({ value: 'PRIVATE' }),
    }
    log.append(record)
    const line = Deno.readTextFileSync(log.path)
    assertEquals(JSON.parse(line), record)
    assertEquals(Deno.statSync(log.path).mode! & 0o777, 0o600)
    // Size of the existing active file, not an unbounded in-memory history, determines rotation.
    Deno.writeTextFileSync(log.path, line.repeat(Math.floor(FAILURE_LOG_MAX_BYTES / line.length)))
    new FailureLog(root).append(record)
    assertEquals(Deno.readTextFileSync(`${log.path}.1`).endsWith('\n'), true)
    assertEquals(Deno.readTextFileSync(log.path), line)
    Deno.writeTextFileSync(log.path, line.repeat(Math.floor(FAILURE_LOG_MAX_BYTES / line.length)))
    log.append({ ...record, response_id: 'resp_new' }) // overwrites the previous archive, not a third file
    assertEquals([...Deno.readDirSync(root)].map((x) => x.name).sort(), ['failures.jsonl', 'failures.jsonl.1'])
    for (const file of Deno.readDirSync(root)) assert(Deno.statSync(`${root}/${file.name}`).size <= FAILURE_LOG_MAX_BYTES)
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
})

for (const transport of ['sse', 'websocket'] as const) {
  Deno.test(`${transport}: sanitized file + journal precede real child kill; reason survives failed tail and resume`, async () => {
    const run = new Run(`failure-diag-${transport}`, false, { transport })
    await run.run(async () => {
      run.fake.reply({ blocks: [text('warm')] })
      const previous = await run.send([user('warm')])
      const lane = [...run.tg.gw.lanes.values()][0]
      const proc = lane.proc!, kill = proc.kill.bind(proc)
      const journal: string[] = [], error = console.error
      let atKill: string | null = null, journalAtKill: string[] = []
      proc.kill = () => {
        atKill = Deno.readTextFileSync(run.tg.gw.failures.path)
        journalAtKill = [...journal]
        return kill()
      }
      console.error = (...args: unknown[]) => {
        journal.push(args.join(' '))
        error(...args)
      }
      try {
        run.fake.reply({ blocks: [{ type: 'tool_use', id: 'toolu_bad', name: 'private/tool', input: { 'PRIVATE-KEY': 'PRIVATE-VALUE' } }] })
        const failed = await run.send([user('PRIVATE-PROMPT')])
        await lane.gone
        assertEquals([failed.status, failed.response.error.code, failed.response.error.reason], ['failed', 'malformed_model_message', 'name_charset'])
        assert(atKill)
        const raw = atKill as string
        const record = JSON.parse(raw)
        assertEquals([record.previous_response_id, record.claude_session_id, record.input.key_count], [previous.response.id, lane.sessionId, 0])
        assertEquals(journalAtKill, [`failure ${raw.trim()}`])
        for (const value of ['private/tool', 'PRIVATE-KEY', 'PRIVATE-VALUE', 'PRIVATE-PROMPT']) assert(!raw.includes(value))
        assertEquals(run.tg.gw.store.has(failed.response.id), false)
        run.fake.reply({ blocks: [text('retry')] })
        const retry = await run.send([user('PRIVATE-PROMPT')])
        assertEquals([retry.status, retry.response.x_gateway.path], ['completed', 'store'])
        assert(sameRequest(run.fake.main()[1], run.fake.main()[2]))
        assertEquals(Deno.readTextFileSync(run.tg.gw.failures.path), raw, 'retained after retry overwrites the failed attempt log')
        await run.disrupt('restart')
        assertEquals(Deno.readTextFileSync(run.tg.gw.failures.path), atKill)
        run.fake.reply({ blocks: [text('after restart')] })
        const restarted = await run.send([user('after restart')])
        assertEquals([restarted.status, restarted.response.x_gateway.path], ['completed', 'store'])
        assertEquals(Deno.readTextFileSync(run.tg.gw.failures.path), raw, 'retained after the restart-based resumed turn completes')
        await run.disrupt('idle')
        run.fake.reply({ blocks: [text('after eviction')] })
        const evicted = await run.send([user('after eviction')])
        assertEquals([evicted.status, evicted.response.x_gateway.path], ['completed', 'store'])
        assertEquals(Deno.readTextFileSync(run.tg.gw.failures.path), raw, 'retained after the eviction-based resumed turn completes')
      } finally {
        console.error = error
      }
    })
  })

  Deno.test(`${transport}: failure diagnostics I/O error remains explicit and never strands or detours`, async () => {
    const run = new Run(`failure-diag-io-${transport}`, false, { transport })
    await run.run(async () => {
      run.fake.reply({ blocks: [text('warm')] })
      await run.send([user('warm')])
      const lane = [...run.tg.gw.lanes.values()][0]
      Deno.mkdirSync(run.tg.gw.failures.path) // actual unwritable destination, not a silent dropped append
      run.fake.reply({ blocks: [{ type: 'tool_use', id: 'toolu_bad', name: 'private/tool', input: {} }] })
      const failed = await run.send([user('go')])
      await lane.gone
      assertEquals(failed.response.error.reason, 'name_charset')
      assertEquals(failed.response.error.diagnostic_error, 'failure_diagnostics_write_failed')
      assertEquals(run.tg.gw.lanes.size, 0)
      assertEquals(run.fake.main().length, 2, 'no automatic regeneration/fallback')
    })
  })
}

for (const transport of ['sse', 'websocket'] as const) {
  Deno.test(`${transport}: ENOSPC after a partial append reports failure, rolls back and recovered writes are valid JSONL`, async () => {
    const run = new Run(`failure-diag-partial-${transport}`, false, { transport })
    await run.run(async () => {
      const badReply = () => run.fake.reply({ blocks: [{ type: 'tool_use', id: 'toolu_bad', name: 'private/tool', input: {} }] })
      badReply()
      const first = await run.send([user('go')])
      await run.tg.waitEvent('kill', (d) => d.session === first.response.x_gateway.session)
      const path = run.tg.gw.failures.path, baseline = Deno.readTextFileSync(path)
      const open = Deno.openSync, error = console.error, journal: string[] = []
      let writes = 0
      // Inject a real 40-byte prefix write before the ENOSPC throw, only into the diagnostic append fd.
      Deno.openSync = (name, options) => {
        const file = open(name, options)
        if (name === path && options?.append) {
          const write = file.writeSync.bind(file)
          file.writeSync = (bytes) => {
            if (++writes === 1) return write(bytes.subarray(0, 40))
            throw new Error('ENOSPC: no space left on device (injected)')
          }
        }
        return file
      }
      console.error = (...args: unknown[]) => {
        journal.push(args.join(' '))
        error(...args)
      }
      try {
        badReply()
        const failed = await run.send([user('go')])
        await run.tg.waitEvent('kill', (d) => d.session === failed.response.x_gateway.session)
        assertEquals(writes, 2)
        assertEquals(failed.response.error.reason, 'name_charset')
        assertEquals(failed.response.error.diagnostic_error, 'failure_diagnostics_write_failed')
        assertEquals(Deno.readTextFileSync(path), baseline, 'incomplete append was rolled back without damaging earlier records')
        assertEquals(journal.length, 1)
        const diagnostic = JSON.parse(journal[0].slice('failure '.length))
        assertEquals([diagnostic.response_id, diagnostic.diagnostic_error], [failed.response.id, 'failure_diagnostics_write_failed'])
        Deno.openSync = open
        badReply()
        const recovered = await run.send([user('go')])
        await run.tg.waitEvent('kill', (d) => d.session === recovered.response.x_gateway.session)
        assertEquals(recovered.response.error.diagnostic_error, undefined)
        const records = Deno.readTextFileSync(path).trimEnd().split('\n').map((line) => JSON.parse(line))
        assertEquals(records.map((r) => r.response_id), [first.response.id, recovered.response.id])
        assertEquals(journal.length, 2, 'the earlier persistence failure remains in the journal')
      } finally {
        Deno.openSync = open
        console.error = error
      }
    })
  })
}

Deno.test('failure diagnostics: append recovers an unterminated suffix, including across scan chunks and after rotation', () => {
  const root = Deno.makeTempDirSync()
  try {
    const log = new FailureLog(root)
    const record: FailureDiagnostic = {
      time: '2026-10-08T06:43:52.000Z',
      response_id: 'resp_safe',
      previous_response_id: null,
      claude_session_id: 'session_safe',
      message_id: 'msg_safe',
      code: 'malformed_model_message',
      reason: 'name_charset',
      block_index: 0,
      failed_field: 'name',
      field: shape('private/tool'),
      tool: toolSummary('private/tool'),
      input: shape({}),
    }
    log.append(record)
    const baseline = Deno.readTextFileSync(log.path)
    // This also covers a crash or a failed truncate rollback without trusting a process-local flag.
    Deno.writeTextFileSync(log.path, 'x'.repeat(9000), { append: true })
    new FailureLog(root).append({ ...record, response_id: 'resp_recovered' })
    assertEquals(Deno.readTextFileSync(log.path).trimEnd().split('\n').map((line) => JSON.parse(line).response_id), ['resp_safe', 'resp_recovered'])
    Deno.writeTextFileSync(log.path, 'x'.repeat(9000))
    log.append(record)
    assertEquals(Deno.readTextFileSync(log.path), baseline, 'an incomplete first record is removed')
    const old = baseline.repeat(Math.floor(FAILURE_LOG_MAX_BYTES / baseline.length))
    Deno.writeTextFileSync(log.path, old)
    const open = Deno.openSync
    Deno.openSync = (path, options) => {
      const file = open(path, options)
      if (path === log.path && options?.append) {
        const write = file.writeSync.bind(file)
        let partial = false
        file.writeSync = (bytes) => {
          if (!partial) {
            partial = true
            return write(bytes.subarray(0, 40))
          }
          throw new Error('ENOSPC: no space left on device (injected)')
        }
      }
      return file
    }
    try {
      let failed = false
      try {
        log.append(record)
      } catch {
        failed = true
      }
      assert(failed)
      assertEquals(Deno.readTextFileSync(log.path), '', 'rollback after rotation truncates to zero, not the old archive size')
      assertEquals(Deno.readTextFileSync(`${log.path}.1`), old)
    } finally {
      Deno.openSync = open
    }
    log.append(record)
    assertEquals(JSON.parse(Deno.readTextFileSync(log.path)), record)
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
})
