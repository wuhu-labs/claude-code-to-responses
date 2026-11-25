// Strict ACP stdio double. It launches the gateway’s real stdio MCP and hook modes.
import { lines } from '../../src/claude/lines.ts'

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
const evidence = `${gemini}/fake-evidence.jsonl`
const record = (kind: string, data: Record<string, unknown> = {}) =>
  Deno.writeTextFileSync(evidence, JSON.stringify({ kind, ...data }) + '\n', {
    append: true,
  })
const config = JSON.parse(await Deno.readTextFile(`${gemini}/config/mcp_config.json`))
const server = config.mcpServers.responses
if (Object.keys(config.mcpServers).length !== 1 || server.timeoutSeconds !== -1) throw new Error('wrong MCP configuration')
const ag = await Deno.readTextFile(`${cwd}/.agents/agents/${agent}/agent.md`)
if (!ag.includes(`name: ${agent}\n`) || !ag.includes('tools: []\nmcpServers:\n  - name: responses\ninheritMcp: false\ninheritCustomizations: true')) {
  throw new Error('agent not fenced')
}
const hooks = JSON.parse(await Deno.readTextFile(`${cwd}/.agents/hooks.json`))
const hook = Object.values(hooks)[0] as { PreInvocation: { command: string }[] }
const logDir = `${app}/log`, conversations = `${app}/conversations`
await Deno.mkdir(logDir, { recursive: true })
await Deno.mkdir(conversations, { recursive: true })
const log = `${logDir}/acp-server-20261126_010101-${Deno.pid}.log`
await Deno.writeTextFile(log, `I1126 01:01:01.000000       1 serve.go:30] Starting ACP server (pid ${Deno.pid}, worker=false, isJetski=false)\n`)
record('process', { agy: Deno.pid, cwd, instructions: ag.split('\n---\n')[1] })
const stdout = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
const write = (writer: WritableStreamDefaultWriter<Uint8Array>, v: unknown) => writer.write(encoder.encode(JSON.stringify(v) + '\n'))
const send = (v: unknown) => write(stdout, v)
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })

let session = '', step = 0, toolNum = 0, prompting = false
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
  const out = mcp.stdout
  void (async () => {
    for await (const line of lines(out)) {
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
function append(brief: unknown, full = brief) {
  const dir = logPath()
  Deno.mkdirSync(dir, { recursive: true })
  for (const [file, line] of [['transcript.jsonl', brief], ['transcript_full.jsonl', full]] as const) {
    if (file === 'transcript_full.jsonl' && mode === 'brief-only') continue
    Deno.writeTextFileSync(`${dir}/${file}`, JSON.stringify(line) + '\n', { append: true })
  }
  step++
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
  for (const value of steps) append({ step_index: step, type: value.userMessage ? 'USER_INPUT' : 'SYSTEM_MESSAGE', ...value })
  return steps
}

const rawArgs = (i: number) => ({ index: i, value: ['héllo', { nested: true }, null], toolSummary: `Generated call ${i}` })
const plannerCall = (name: string, i: number, full: boolean) => ({
  name: `mcp_responses_${name}`,
  args: full ? rawArgs(i) : Object.fromEntries(Object.entries(rawArgs(i)).map(([k, v]) => [k, JSON.stringify(v)])),
})

async function issue(name: string, i: number) {
  const id = `call_${session.replaceAll('-', '')}_${++toolNum}`
  const args = rawArgs(i)
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
  const permissionId = `${toolNum}`
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
    _meta: {
      'antigravity.google/conversation_id': session,
      progressToken: `${crypto.randomUUID()}:${step}`,
    },
  })
  const output = result.result?.content?.[0]?.text
  if (typeof output !== 'string') throw new Error('MCP result was not served')
  record('output', { index: i, output })
  append({ step_index: step, type: 'GENERIC', output })
  await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
  return output
}

async function prompt(id: unknown, text: string) {
  if (prompting) throw new Error('overlapping ACP prompts')
  prompting = true
  record('prompt', { session, text })
  append({ step_index: step, type: 'USER_INPUT', content: text })
  await invoke(0)
  let answer = `answer:${text}`
  if (text === 'batch' || text === 'missing-planner') {
    if (!tools.length) throw new Error('no fake tools')
    const name = tools[0],
      first = {
        step_index: step,
        type: 'PLANNER_RESPONSE',
        input_tokens: 100,
        cache_read_tokens: 20,
        output_tokens: 25,
        content: 'Planning.',
        thinking: 'Thinking.',
      }
    if (text !== 'missing-planner') {
      append({ ...first, tool_calls: [0, 1, 2].map((i) => plannerCall(name, i, false)) }, {
        ...first,
        tool_calls: [0, 1, 2].map((i) => plannerCall(name, i, true)),
      })
    } else step++
    await chunk('agent_thought_chunk', 'Think')
    await chunk('agent_thought_chunk', 'ing.')
    await chunk('agent_message_chunk', 'Planning.')
    const results = []
    for (let i = 0; i < 3; i++) results.push(await issue(name, i))
    const messages = await invoke(1)
    answer = JSON.stringify({ results, messages })
  }
  append({ step_index: step, type: 'PLANNER_RESPONSE', input_tokens: 150, cache_read_tokens: 25, output_tokens: 10, content: answer })
  await chunk('agent_message_chunk', text === 'batch' || text === 'missing-planner' ? `\n\n${answer}` : answer)
  prompting = false
  await reply(id, {
    stopReason: 'end_turn',
    usage: { inputTokens: 250, cachedReadTokens: 45, cachedWriteTokens: 0, outputTokens: 35, thoughtTokens: 5, totalTokens: 330 },
  })
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
      session = resume ? p.sessionId : crypto.randomUUID()
      if (resume) {
        try {
          await Deno.stat(`${conversations}/${session}.db`)
        } catch {
          await send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'conversation not found' } })
          break
        }
        const file = await Deno.readTextFile(`${logPath()}/transcript.jsonl`)
        step = Math.max(...file.trim().split('\n').map((x) => JSON.parse(x).step_index)) + 1
      } else await Deno.writeTextFile(`${conversations}/${session}.db`, 'fake conversation')
      await loadMcp()
      startSessionLog()
      await reply(msg.id, { sessionId: session, ...(resume ? {} : { _meta: { antigravity: { tier: { name: 'Fake Ultra', id: 'fake-ultra' } } } }) })
      break
    }
    case 'session/set_config_option':
      if (p.sessionId !== session || p.configId !== 'model' || p.value !== 'gemini-3.8-flash-low') throw new Error('wrong model selection')
      await reply(msg.id, {})
      break
    case 'session/prompt':
      if (p.sessionId !== session || p.prompt.length !== 1 || p.prompt[0].type !== 'text') throw new Error('wrong prompt shape')
      void prompt(msg.id, p.prompt[0].text).catch((e) => {
        record('error', { message: String(e) })
        Deno.exit(1)
      })
      break
    default:
      permissions.get(msg.id)?.resolve(msg.result)
  }
}
if (writer!) await writer.close()
if (mcp) await mcp.status
