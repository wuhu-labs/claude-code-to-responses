// Strict ACP stdio double for the agy lane: a real SQLite conversation store in agy 1.5.17's layout, the planner
// transcript the gateway reads, and the gateway's own stdio MCP shim. It launches the real shim and hook modes, so a
// test exercises the gateway's MCP/fence paths. Nothing here is the gateway's code except the pinned store format.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { lines } from '../../src/claude/lines.ts'
import { decode, encode, type Field, integer, message, setInteger, setMessage, setText, sub, text } from '../../src/agy/pb.ts'
import { readSteps, readTrajectory, type StepsRow, writeSteps, writeTrajectory } from '../../src/agy/rows.ts'
import { createStore } from '../../src/agy/schema.ts'

const [mode, ...argv] = Deno.args
if (argv[0] === '--version') {
  console.log(mode === 'version' ? '9.9.9' : '1.5.17')
  Deno.exit()
}
const [acp, stdio, geminiFlag, gemini, agentFlag, agent] = argv
if (
  acp !== 'acp' || stdio !== '--stdio' || geminiFlag !== '--gemini-dir' || agentFlag !== '--agent' ||
  Deno.env.get('AGY_CLI_DISABLE_AUTO_UPDATE') !== 'true'
) throw new Error('wrong agy flags')
const cwd = Deno.cwd()
const app = `${gemini}/antigravity-cli`
// The evidence is the test's own record of what the model was shown; it lives where the test says, never inside the
// state folder the lost-store cases delete.
const evidence = Deno.env.get('FAKE_AGY_EVIDENCE') ?? `${gemini}/fake-evidence.jsonl`
const record = (kind: string, data: Record<string, unknown> = {}) =>
  Deno.writeTextFileSync(evidence, JSON.stringify({ kind, ...data }) + '\n', { append: true })
const config = JSON.parse(await Deno.readTextFile(`${gemini}/config/mcp_config.json`))
const server = config.mcpServers.responses
if (Object.keys(config.mcpServers).length !== 1 || server.timeoutSeconds !== -1) throw new Error('wrong MCP configuration')
const ag = await Deno.readTextFile(`${cwd}/.agents/agents/${agent}/agent.md`)
if (!ag.includes(`name: ${agent}\n`) || !ag.includes('tools: [view_file]\nmcpServers:\n  - name: responses\ninheritMcp: false\ninheritCustomizations: true')) {
  throw new Error('agent not fenced')
}
if (!ag.includes('[Resource offloaded to file://')) throw new Error('agent carries no image guidance')
const hooks = JSON.parse(await Deno.readTextFile(`${cwd}/.agents/hooks.json`))
const hook = Object.values(hooks)[0] as { PreInvocation: { command: string }[] }
const logDir = `${app}/log`, conversations = `${app}/conversations`
await Deno.mkdir(logDir, { recursive: true })
await Deno.mkdir(conversations, { recursive: true })
// An unrelated recent fallback warning must not be attributed to this process, and the basename is not a PID format.
await Deno.writeTextFile(
  `${logDir}/acp-server-other.log`,
  'Starting ACP server (pid 0, worker=false)\n  session_handlers.go:88] Agent "other" not found, falling back to default\n',
)
const log = `${logDir}/acp-server-fixture-${crypto.randomUUID()}.log`
await Deno.writeTextFile(log, `I1126 01:01:01.000000       1 serve.go:30] Starting ACP server (pid ${Deno.pid}, worker=false, isJetski=false)\n`)
const separator = '\n---\n'
const bodyStart = ag.indexOf(separator)
if (bodyStart === -1) throw new Error('missing agent frontmatter terminator')
record('process', { agy: Deno.pid, cwd, instructions: ag.slice(bodyStart + separator.length) })
const stdout = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
const write = (writer: WritableStreamDefaultWriter<Uint8Array>, v: unknown) => writer.write(encoder.encode(JSON.stringify(v) + '\n'))
const send = (v: unknown) => write(stdout, v)
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })

let session = '', step = 0, toolNum = 0, prompting = false
let trajectory = ''
let rows = new Map<number, StepsRow>()
let mcp: Deno.ChildProcess | undefined
let writer: WritableStreamDefaultWriter<Uint8Array>
const mcpReplies = new Map<number, PromiseWithResolvers<any>>()
const permissions = new Map<string, PromiseWithResolvers<any>>()
let mcpID = 0
let tools: string[] = []

async function callMcp(method: string, params: unknown = {}) {
  const id = ++mcpID
  const wait = Promise.withResolvers<any>()
  mcpReplies.set(id, wait)
  await write(writer, { jsonrpc: '2.0', id, method, params })
  return await wait.promise
}

async function loadMcp() {
  mcp = new Deno.Command(server.command, { args: server.args, stdin: 'piped', stdout: 'piped', stderr: 'inherit' }).spawn()
  record('shim', { pid: mcp.pid })
  writer = mcp.stdin.getWriter()
  void (async () => {
    for await (const line of lines(mcp.stdout)) {
      const msg = JSON.parse(line)
      mcpReplies.get(msg.id)?.resolve(msg)
      mcpReplies.delete(msg.id)
    }
  })()
  if ((await callMcp('server/discover')).error?.code !== -32601) throw new Error('discover should be unsupported')
  if ((await callMcp('initialize', { protocolVersion: '2025-11-25' })).result?.protocolVersion !== '2025-11-25') throw new Error('MCP initialization failed')
  await write(writer, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const found = (await callMcp('tools/list')).result?.tools
  if (!found?.every((t: any) => t._meta?.['antigravity/alwaysLoad'] === true && t.inputSchema.type === 'object')) throw new Error('wrong tool declaration')
  tools = found.map((t: any) => t.name)
  record('listed', { names: tools })
}

function startSessionLog() {
  if (mode === 'fallback-agent') {
    Deno.writeTextFileSync(log, `W1126 01:01:01.000001       5 session_handlers.go:88] Agent "${agent}" not found, falling back to default\n`, { append: true })
  }
  Deno.writeTextFileSync(log, `I1126 01:01:01.000002       5 server.go:1287] Starting conversation update stream for ${session}\n`, { append: true })
}

const update = (update: unknown) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update } })
const chunk = (sessionUpdate: string, text: string) => update({ sessionUpdate, content: { type: 'text', text } })
const logPath = () => `${app}/brain/${session}/.system_generated/logs`
function appendTranscript(brief: unknown, full = brief) {
  const dir = logPath()
  Deno.mkdirSync(dir, { recursive: true })
  for (const [file, line] of [['transcript.jsonl', brief], ['transcript_full.jsonl', full]] as const) {
    if (file === 'transcript_full.jsonl' && mode === 'brief-only') continue
    Deno.writeTextFileSync(`${dir}/${file}`, JSON.stringify(line) + '\n', { append: true })
  }
}

// ---- the store, as agy 1.5.17 writes it -------------------------------------------------------------

const dbPath = () => `${conversations}/${session}.db`
const second = () => Math.floor(Date.now() / 1000)
const stamp = (): Field[] => [{ field: 1, wt: 0, value: BigInt(second()) }, { field: 2, wt: 0, value: 1_000_000n }]
const int = (field: number, value: number): Field => ({ field, wt: 0, value: BigInt(value) })
const str = (field: number, value: string): Field => ({ field, wt: 2, value: new TextEncoder().encode(value) })
const bytes_ = (field: number, value: Uint8Array): Field => ({ field, wt: 2, value })
const sub_ = (field: number, tree: Field[]): Field => ({ field, wt: 2, value: encode(tree) })

/** The step metadata (`5`) every step carries: when it was enqueued, its position in the conversation. */
function step5(idx: number, extra: Field[]): Field[] {
  return [
    sub_(1, stamp()),
    int(3, 2),
    int(11, 1320),
    str(12, crypto.randomUUID()),
    sub_(20, [str(1, trajectory), int(2, idx), int(3, 2), str(4, session)]),
    str(35, crypto.randomUUID().replaceAll('-', '')),
    int(38, 3),
    ...extra,
  ]
}

function putRow(idx: number, stepType: number, status: number, stepPayload: Field[]): StepsRow {
  const tree = [...stepPayload]
  const metadata = sub(tree, 5) ?? []
  const row: StepsRow = {
    idx,
    step_type: stepType,
    status,
    has_subtrajectory: 0,
    metadata: encode(metadata),
    error_details: null,
    permissions: null,
    task_details: null,
    render_info: null,
    step_payload: encode(tree),
    step_format: 0,
  }
  rows.set(idx, row)
  return row
}

function flush() {
  const db = new DatabaseSync(dbPath())
  db.exec('DELETE FROM steps')
  writeSteps(db, [...rows.values()].sort((a, b) => a.idx - b.idx))
  db.close()
}

/** The context agy renders a prompt from: every step row before the new turn. A digest makes it comparable. */
function contextDigest(): string {
  const hash = createHash('sha256')
  for (const row of [...rows.values()].sort((a, b) => a.idx - b.idx)) {
    hash.update(`${row.idx}:${row.step_type}:${row.status}:${row.step_payload ? Buffer.from(row.step_payload).toString('base64') : ''}|`)
  }
  const db = new DatabaseSync(dbPath(), { readOnly: true })
  const blob = readTrajectory(db)?.blob
  db.close()
  if (blob) hash.update(Buffer.from(blob.data).toString('base64'))
  return hash.digest('hex')
}

function openStore(): { pending: number[]; completed: string[] } {
  const db = new DatabaseSync(dbPath(), { readOnly: true })
  const stored = readSteps(db)
  const storedTrajectory = readTrajectory(db)
  db.close()
  rows = new Map(stored.map((row) => [row.idx, row]))
  trajectory = storedTrajectory?.meta.trajectory_id ?? trajectory
  step = stored.reduce((max, row) => Math.max(max, row.idx), -1) + 1
  return recover()
}

/**
 * The tool results the conversation ends with: agy reopens a store whose last steps are the gateway's completed calls.
 * Each must carry the measured shape, and its output file the same text, before the model continues.
 */
function recover(): { pending: number[]; completed: string[] } {
  const ordered = [...rows.values()].sort((a, b) => a.idx - b.idx)
  const pending: number[] = []
  for (let i = ordered.length - 1; i >= 0 && ordered[i].step_type === 132; i--) pending.unshift(ordered[i].idx)
  const completed: string[] = []
  for (const idx of pending) {
    const row = rows.get(idx)!
    const payload = row.step_payload ? decode(row.step_payload) : []
    const stat = integer(payload, 4)
    const render = message(sub(payload, 140), 2)
    const output = render ? text(render, 1) : null
    const fileUrl = render ? text(render, 7) : null
    const statusText = render ? text(sub(render, 3), 5) : null
    const file = fileUrl?.replace('file://', '')
    const preview = output !== null && output.startsWith("The tool's output was truncated due to being too long.")
    const ok = row.status === 3 && stat === 3 && output !== null && statusText === 'Executed' && !!file && exists(file)
    if (!ok) throw new Error(`step ${idx} was not completed before the conversation was reopened (status ${row.status}, payload ${stat})`)
    if (!preview && (!output.startsWith('Created At: ') || !output.includes('\nCompleted At: '))) {
      throw new Error(`step ${idx} holds an output without agy's header: ${JSON.stringify(output.slice(0, 80))}`)
    }
    const fileText = Deno.readTextFileSync(file!)
    const body = fileText.split('\n').slice(2).join('\n')
    // a stored output is the file's text itself; a large one is agy's preview of it, ending in its tail
    if (!preview ? fileText !== output : !(fileText.startsWith('Created At: ') && output.endsWith(body.slice(-4096)))) {
      throw new Error(`step ${idx}: output.txt and the step's text disagree`)
    }
    record('step-output', {
      idx,
      stored: output,
      stepBytes: new TextEncoder().encode(output).length,
      fileBytes: new TextEncoder().encode(fileText).length,
      headerBytes: new TextEncoder().encode(output).length - new TextEncoder().encode(body).length,
      preview,
      body,
    })
    completed.push(body)
  }
  return { pending, completed }
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path)
    return true
  } catch {
    return false
  }
}

/** agy's own write of a finished tool result, as measured: the header, "Executed", the markdown and the file. */
function completeNatively(idx: number, outputText: string) {
  const row = rows.get(idx)
  if (!row?.step_payload) throw new Error(`step ${idx} has no payload`)
  const payload = decode(row.step_payload)
  const step5 = sub(payload, 5)
  const when = stamp()
  setInteger(payload, 4, 3)
  setMessage(step5, 8, when)
  setMessage(payload, 5, step5)
  const result = sub(payload, 140)
  const render = message(result, 2) ?? []
  const file = `${app}/brain/${session}/.system_generated/steps/${idx}/output.txt`
  const url = `file://${file}`
  const header = `Created At: ${iso()}\nCompleted At: ${iso()}\n${outputText}`
  Deno.mkdirSync(file.replace(/\/output\.txt$/, ''), { recursive: true })
  Deno.writeTextFileSync(file, header)
  setText(render, 1, header)
  const inner = message(render, 3) ?? []
  setText(inner, 5, 'Executed')
  const markdown = message(inner, 10) ?? []
  const args: Record<string, string> = {}
  for (const pair of result) {
    if (pair.field !== 1 || pair.wt !== 2) continue
    const decoded = message([pair], 1)
    const key = decoded ? text(decoded, 1) : null
    if (key && key !== 'toolSummary') args[key] = decoded ? text(decoded, 2) ?? '' : ''
  }
  setText(markdown, 1, `**Arguments**\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n\n**Result**\n\`\`\`\n${outputText}\n\`\`\``)
  setMessage(inner, 10, markdown)
  setMessage(render, 3, inner)
  setText(render, 7, url)
  setMessage(result, 2, render)
  setMessage(payload, 140, result)
  const metadata = row.metadata ? decode(row.metadata) : []
  setMessage(metadata, 8, when)
  rows.set(idx, { ...row, status: 3, step_payload: encode(payload), metadata: encode(metadata) })
  flush()
}

/** agy's own `read_file` step: a built-in call agy answers itself, whose payload keeps the file's bytes. */
function readFileStep(image: { mimeType: string; data: string }, path: string) {
  const idx = step++
  const call = sub_(4, [str(1, `call_read_${idx}`), str(2, 'read_file'), str(3, JSON.stringify({ Path: path }))])
  const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))
  putRow(idx, 132, 3, [
    int(1, 132),
    int(4, 3),
    sub_(5, step5(idx, [call])),
    sub_(140, [
      sub_(2, [
        str(1, `Created At: 2026-01-01T00:00:00+00:00\nCompleted At: 2026-01-01T00:00:00+00:00\nShowing binary file of type ${image.mimeType}`),
        sub_(4, [str(1, image.mimeType), bytes_(2, bytes)]),
        sub_(3, [str(5, 'Analyzed')]),
      ]),
    ]),
  ])
  flush()
  appendTranscript({ step_index: idx, type: 'GENERIC', output: `Showing binary file of type ${image.mimeType}` })
  planner(step, 'Looking at the image.', '', null)
}

/** A tool result agy offloads: the image goes to `media_<n>.<ext>` and the output text names it. */
function completeWithImages(idx: number, outputText: string, images: { mimeType: string; data: string }[]): string {
  const dir = `${app}/brain/${session}/.system_generated/steps/${idx}`
  Deno.mkdirSync(dir, { recursive: true })
  const pointers = images.map((image, n) => {
    const file = `${dir}/media_${n}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`
    Deno.writeFileSync(file, Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)))
    return `[Resource offloaded to file://${file}]`
  })
  const text = [outputText, ...pointers].filter(Boolean).join('\n')
  completeNatively(idx, text)
  readFileStep(images[0], `${dir}/media_0.${images[0].mimeType === 'image/jpeg' ? 'jpg' : 'png'}`)
  return text
}

function iso(): string {
  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${
    offset < 0 ? '-' : '+'
  }${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

async function invoke(invocationNum: number) {
  const payload = {
    conversationId: session,
    cwd,
    transcriptPath: `${logPath()}/transcript.jsonl`,
    hookEventName: 'PreInvocation',
    initialNumSteps: step,
    invocationNum,
  }
  const input = JSON.stringify(payload)
  async function once() {
    const hookChild = new Deno.Command('/bin/sh', { args: ['-c', hook.PreInvocation[0].command], stdin: 'piped', stdout: 'piped', stderr: 'inherit' }).spawn()
    const writer = hookChild.stdin.getWriter()
    await writer.write(encoder.encode(input))
    await writer.close()
    const out = await hookChild.output()
    if (!out.success) throw new Error('hook failed')
    return JSON.parse(new TextDecoder().decode(out.stdout)).injectSteps ?? []
  }
  const injections = await Promise.all([once(), once()])
  const steps = injections.flatMap((steps) =>
    steps.every((step: any) => typeof step.userMessage === 'string' || typeof step.systemMessage?.systemMessage === 'string') ? steps : []
  )
  record('hook', { invocationNum, steps })
  for (const value of steps) {
    appendTranscript({ step_index: step, type: value.userMessage ? 'USER_INPUT' : 'SYSTEM_MESSAGE', ...value })
    const kind = value.userMessage ? 14 : 101
    putRow(step, kind, 3, [int(1, kind), int(4, 3), sub_(5, step5(step, [sub_(19, [str(2, value.userMessage ?? value.systemMessage.systemMessage)])]))])
    step++
    flush()
  }
  return steps
}

const rawArgs = (i: number) => ({ index: i, value: ['héllo', { nested: true }, null], toolSummary: `Generated call ${i}` })
const plannerCall = (name: string, i: number, full: boolean) => ({
  name: `mcp_responses_${name}`,
  args: full ? rawArgs(i) : Object.fromEntries(Object.entries(rawArgs(i)).map(([k, v]) => [k, JSON.stringify(v)])),
})

/** agy writes every planned call's step before it issues the first: pending for the first, queued for the rest. */
function planCalls(name: string, count: number): { idx: number; id: string; args: Record<string, unknown>; i: number }[] {
  const planned = []
  for (let i = 0; i < count; i++) {
    // `alias-conflict`: agy wrote two client calls under one provider call id, which a record cannot express
    const id = mode === 'alias-conflict' && i > 0 ? `call_${session.replaceAll('-', '')}_${toolNum}` : `call_${session.replaceAll('-', '')}_${++toolNum}`
    const args = rawArgs(i)
    const args140 = Object.entries({ toolSummary: args.toolSummary, ...Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'toolSummary')) })
      .map(([k, v]) => sub_(1, [str(1, k), str(2, typeof v === 'string' ? v : JSON.stringify(v))]))
    const callField = sub_(4, [str(1, id), str(2, `mcp_responses_${name}`), str(3, JSON.stringify(args))])
    const pair = [str(1, 'mcp'), str(2, `responses/${name}`)]
    const identity = [sub_(2, [sub_(1, pair), int(2, 1), str(5, 'mcp'), str(6, `responses/${name}`)])]
    const renderInfo = [
      sub_(1, [sub_(21, [sub_(1, pair), str(5, `Run ${name} from MCP server responses`), sub_(6, [int(1, 5)])])]),
      sub_(2, [str(1, trajectory), int(2, step), sub_(21, [int(1, 1), str(4, '')])]),
    ]
    const payload = i === 0
      ? [
        int(1, 132),
        int(4, 2),
        sub_(5, step5(step, [callField, sub_(6, stamp()), sub_(7, stamp())])),
        sub_(133, identity),
        sub_(147, renderInfo),
        sub_(140, [...args140, sub_(2, [sub_(3, [str(5, 'Executing'), str(6, 'build'), str(7, 'actions')])])]),
      ]
      : [int(1, 132), int(4, 1), sub_(5, step5(step, [callField])), sub_(140, args140)]
    putRow(step, 132, i === 0 ? 2 : 1, payload)
    planned.push({ idx: step++, id, args, i })
  }
  flush()
  return planned
}

/** One MCP tool call: agy announces the step it wrote, asks the gateway, then records the result natively. */
async function issue(planned: { idx: number; id: string; args: Record<string, unknown>; i: number }, name: string): Promise<string> {
  const { idx, id, args, i } = planned
  const call = {
    sessionUpdate: 'tool_call',
    name: `mcp_responses_${name}`,
    toolCallId: id,
    title: `Run mcp_responses_${name}`,
    status: 'in_progress',
    rawInput: args,
    args,
  }
  await update(call)
  await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'pending' })
  const permissionId = `${toolNum}-${i}`
  const permission = Promise.withResolvers<any>()
  permissions.set(permissionId, permission)
  await send({
    jsonrpc: '2.0',
    id: permissionId,
    method: 'session/request_permission',
    params: {
      sessionId: session,
      toolCall: call,
      options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
    },
  })
  if ((await permission.promise)?.outcome?.optionId !== 'allow') throw new Error('MCP permission denied')
  permissions.delete(permissionId)
  const { toolSummary: _, ...given } = args
  const result = await callMcp('tools/call', {
    name,
    arguments: given,
    _meta: { 'antigravity.google/conversation_id': session, progressToken: `${crypto.randomUUID()}:${idx}` },
  })
  const content = Array.isArray(result.result?.content) ? result.result.content : []
  const texts = content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text as string)
  const images = content.filter((item: any) => item?.type === 'image' && typeof item.data === 'string')
    .map((item: any) => ({ mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png', data: item.data as string }))
  if (!texts.length && !images.length) throw new Error('MCP result was not served')
  const output = texts.join('\n')
  record('output', { index: i, output, images: images.length })
  appendTranscript({ step_index: idx, type: 'GENERIC', output })
  const seen = images.length ? completeWithImages(idx, output, images) : (completeNatively(idx, output), output)
  await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
  return seen
}

/** A planner line: the transcript row the gateway reads, and the store row agy writes with it. */
function planner(index: number, content: string, thinking: string, calls: { name: string; i: number }[] | null) {
  const row = {
    step_index: index,
    type: 'PLANNER_RESPONSE',
    input_tokens: 100,
    cache_read_tokens: 20,
    output_tokens: 25,
    content,
    thinking,
    ...(calls ? { tool_calls: calls.map((c) => plannerCall(c.name, c.i, false)) } : {}),
  }
  const full = calls ? { ...row, tool_calls: calls.map((c) => plannerCall(c.name, c.i, true)) } : row
  appendTranscript(row, full)
  putRow(index, 15, 3, [
    int(1, 15),
    int(4, 3),
    sub_(5, step5(index, [sub_(6, stamp()), sub_(9, [int(1, 100), int(2, 25)])])),
    sub_(19, [str(2, content)]),
  ])
  step = Math.max(step, index + 1)
  flush()
}

function fieldBytes(fields: Field[], field: number): Uint8Array | null {
  for (const f of fields) if (f.field === field && f.wt === 2) return f.value as Uint8Array
  return null
}

/** What the model sees of an image step: the byte digest, so a rebuild can be compared without the bytes. */
function imageMark(bytes: Uint8Array | null, mime: string | null): string {
  return bytes ? ` [${mime ?? 'image'}:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}]` : ''
}

/** What agy renders upstream, in step order: user turns, planner text, resume notices and tool results. */
function visibleRows(): string[] {
  return [...rows.values()].sort((a, b) => a.idx - b.idx).map((row) => {
    const payload = row.step_payload ? decode(row.step_payload) : []
    let shown = ''
    if (row.step_type === 132) {
      const render = message(sub(payload, 140), 2)
      const output = render ? text(render, 1) : null
      const file = render ? message(render, 4) : null
      shown = output === null ? '' : output.replace(/^Created At: [^\n]*\nCompleted At: [^\n]*\n/, '')
      shown += imageMark(file ? fieldBytes(file, 2) : null, file ? text(file, 1) : null)
    } else if (row.step_type === 14) {
      // a user turn keeps its text in its step metadata (5.19.2); its image is 5.19.9.2
      const meta = sub(message(payload, 5) ?? [], 19)
      const upload = message(meta, 9) ?? []
      shown = text(meta, 2) ?? ''
      shown += imageMark(fieldBytes(upload, 2), text(message(upload, 1) ?? [], 13))
    } else {
      shown = text(sub(payload, 19), 2) ?? ''
    }
    return `${row.idx}:${row.step_type}:${shown}`
  })
}

let recovered: string[] = []

/** What the model sees for the inference about to start: the whole transcript, in store order. */
const inference = () => record('inference', { session, visible: visibleRows(), steps: rows.size })

async function prompt(id: unknown, promptText: string, images: { mimeType: string; data: string }[] = []) {
  if (prompting) throw new Error('overlapping ACP prompts')
  prompting = true
  const imageDigests = images.map((image) => createHash('sha256').update(Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))).digest('hex').slice(0, 16))
  record('prompt', { session, text: promptText, images: imageDigests, context: contextDigest(), visible: visibleRows(), steps: rows.size })
  const content = [str(2, promptText)]
  for (const image of images) {
    content.push(sub_(9, [sub_(1, [str(13, image.mimeType)]), bytes_(2, Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)))]))
  }
  putRow(step, 14, 3, [int(1, 14), int(4, 3), sub_(5, step5(step, [sub_(19, content)]))])
  appendTranscript({ step_index: step, type: 'USER_INPUT', content: promptText })
  step++
  flush()
  inference()
  await invoke(0)
  if (promptText === 'hold-generation') {
    await chunk('agent_message_chunk', 'Still generating.')
    return // Never send the prompt result; the test cancels after seeing the live chunk.
  }
  let answer = promptText === 'output-limit' ? 'Partial text.' : `answer:${promptText}`
  if (recovered.length) {
    answer = JSON.stringify({ results: recovered, messages: promptText.trim() ? [{ userMessage: promptText }] : [] })
    recovered = []
  }
  const plan = promptText === 'batch' || promptText === 'missing-planner' || promptText === 'pair' || promptText === 'image'
  if (plan) {
    if (!tools.length) throw new Error('no fake tools')
    const name = tools[0]
    const count = promptText === 'pair' ? 2 : promptText === 'image' ? 1 : 3
    if (promptText !== 'missing-planner') planner(step, 'Planning.', 'Thinking.', Array.from({ length: count }, (_, i) => ({ name, i })))
    else step++
    await chunk('agent_thought_chunk', 'Think')
    await chunk('agent_thought_chunk', 'ing.')
    await chunk('agent_message_chunk', 'Planning.')
    const planned = planCalls(name, count)
    const results = []
    for (const call of planned) results.push(await issue(call, name))
    const messages = await invoke(1)
    // the second inference of this prompt follows the tool results: snapshot what the model sees then
    inference()
    answer = JSON.stringify({ results, messages })
  }
  planner(step, answer, '', null)
  await chunk('agent_message_chunk', plan ? `\n\n${answer}` : answer)
  prompting = false
  await reply(id, {
    stopReason: promptText === 'output-limit' ? 'max_tokens' : 'end_turn',
    usage: { inputTokens: 250, cachedReadTokens: 45, cachedWriteTokens: 0, outputTokens: 35, thoughtTokens: 5, totalTokens: 330 },
  })
}

function newStore() {
  session = crypto.randomUUID()
  trajectory = crypto.randomUUID()
  rows = new Map()
  step = 0
  Deno.mkdirSync(conversations, { recursive: true })
  const db = createStore(dbPath())
  db.close()
  const db2 = new DatabaseSync(dbPath())
  writeTrajectory(db2, {
    meta: { trajectory_id: trajectory, cascade_id: session, trajectory_type: 4, source: 17 },
    blob: { id: 'main', data: new TextEncoder().encode(`rig blob ${session}`) },
  })
  db2.close()
}

for await (const line of lines(Deno.stdin.readable)) {
  const msg = JSON.parse(line), p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      if (p.protocolVersion !== 1) throw new Error('wrong ACP version')
      await reply(msg.id, { protocolVersion: 1, agentInfo: { version: '1.5.17' } })
      break
    case 'session/new':
    case 'session/resume': {
      if (p.cwd !== cwd || p.mcpServers.length) throw new Error('wrong session workspace or session MCP servers')
      const resume = msg.method === 'session/resume'
      record(resume ? 'resume' : 'new', { id: p.sessionId })
      if (resume) {
        session = p.sessionId
        try {
          await Deno.stat(dbPath())
        } catch {
          await send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'conversation not found' } })
          break
        }
        let opened
        try {
          opened = openStore()
        } catch (e) {
          record('error', { message: String(e) })
          await send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } })
          break
        }
        const { pending, completed } = opened
        recovered = completed
        record('resume-check', { pending, completed })
        appendTranscript({ step_index: step, type: 'SYSTEM_MESSAGE', content: 'resume notice' })
        putRow(step, 101, 3, [int(1, 101), int(4, 3), sub_(5, step5(step, [sub_(19, [str(2, 'resume notice')])]))])
        step++
        flush()
      } else {
        newStore()
      }
      await loadMcp()
      startSessionLog()
      await reply(msg.id, {
        sessionId: session,
        ...(resume ? {} : { _meta: { antigravity: { tier: { name: 'Fake Ultra', id: 'fake-ultra' } } } }),
      })
      break
    }
    case 'session/set_config_option':
      if (p.sessionId !== session || p.configId !== 'model' || p.value !== 'gemini-3.8-flash-low') throw new Error('wrong model selection')
      record('config', { model: p.value })
      await reply(msg.id, {})
      break
    case 'session/prompt': {
      if (p.sessionId !== session || !Array.isArray(p.prompt) || !p.prompt.length) throw new Error('wrong prompt shape')
      const texts = p.prompt.filter((block: any) => block?.type === 'text')
      const images = p.prompt.filter((block: any) => block?.type === 'image')
      const other = p.prompt.filter((block: any) => block?.type !== 'text' && block?.type !== 'image')
      if (texts.length > 1 || other.length || !texts.length) throw new Error('wrong prompt shape')
      void prompt(msg.id, texts[0].text, images.map((block: any) => ({ mimeType: block.mimeType, data: block.data }))).catch((e) => {
        record('error', { message: String(e) })
        Deno.exit(1)
      })
      break
    }
    default:
      permissions.get(msg.id)?.resolve(msg.result)
  }
}
if (writer!) await writer.close()
if (mcp) await mcp.status
