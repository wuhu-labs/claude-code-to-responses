import { join } from 'node:path'
import type { FnTool, InItem } from '../api/request.ts'
import { newId } from '../api/stream.ts'
import { serverError } from '../errors.ts'
import { AcpError, AcpProcess, agentName } from './acp.ts'
import type { Call, Output } from './output.ts'
import { type Planner, promptTokens, sameCall, type Tokens, Transcript } from './transcript.ts'
import {
  type AcpCall,
  CONVERSATION_KEY,
  count,
  type HookStep,
  type JsonObject,
  MCP_NAME,
  MCP_PREFIX,
  object,
  safeId,
  string,
  toolArgs,
  type ToolResult,
  toolResult,
} from './wire.ts'

export type Tier = { name: string; id: string }
export type Launch = {
  agy: string
  workspace: string
  gemini: string
  chain: string
  origin: string
  hook: string
  instructions: string
  model: string
  tools: FnTool[]
}
export type Exchange = {
  output: Output
  finish: (calls: Call[], planner: Planner | null, tokens: Tokens | null, incomplete: boolean) => void
  fail: (error: unknown) => void
}
type Turn = {
  cursor: number
  invocation: number | null
  fallback: number | null
  queue: HookStep[]
  chunks: boolean
  used: Tokens[]
  boundaries: number
  drainedACP: Set<string>
}
type Batch =
  | { kind: 'held'; calls: Call[]; release: (output: ToolResult) => void }
  | { kind: 'draining'; next: number; calls: Call[]; results: Map<string, string> }

const launchTimeout = 30_000

export class Lane {
  readonly token = crypto.randomUUID()
  readonly controller = new AbortController()
  readonly exit: Promise<void>
  session = ''
  tier: Tier | null = null
  head: string | null = null
  timer?: ReturnType<typeof setTimeout>
  private listed = false
  private pendingCall?: AcpCall
  private turn: Turn | null = null
  private active: Exchange | null = null
  private batch: Batch | null = null
  private transcript?: Transcript
  private proc: AcpProcess
  private knownTools: Set<string>

  constructor(readonly spec: Launch, onExit: () => void) {
    this.knownTools = new Set(spec.tools.map((t) => t.name))
    const dir = join(spec.workspace, '.agents', 'agents', agentName(spec.chain))
    Deno.mkdirSync(dir, { recursive: true, mode: 0o700 })
    Deno.writeTextFileSync(
      join(dir, 'agent.md'),
      [
        '---',
        `name: ${agentName(spec.chain)}`,
        'description: Responses API conversation agent.',
        'mainAgent: true',
        'subagent: false',
        'tools: []',
        'mcpServers:',
        `  - name: ${MCP_NAME}`,
        'inheritMcp: false',
        'inheritCustomizations: true',
        '---',
        spec.instructions,
      ].join('\n'),
      { mode: 0o600 },
    )
    Deno.writeTextFileSync(
      join(spec.workspace, '.agents', 'hooks.json'),
      JSON.stringify({
        'responses-steering': { PreInvocation: [{ type: 'command', command: spec.hook, timeout: 30 }] },
      }),
      { mode: 0o600 },
    )
    this.proc = new AcpProcess(
      { ...spec, cwd: spec.workspace, token: this.token },
      (method, p) => {
        if (method === 'session/update' && p.sessionId === this.session) this.update(p.update)
      },
      (p) => this.permission(p),
      (err) => {
        this.controller.abort(err)
        clearTimeout(this.timer)
        if (this.batch?.kind === 'held') this.batch.release(toolResult('agy lane closed', true))
        this.batch = null
        this.active?.fail(err)
        onExit()
      },
    )
    this.exit = this.proc.stopped
  }

  async start(resume: string | null): Promise<boolean> {
    const hello = await this.proc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'agy-to-responses', version: '1.0.0' },
    }, launchTimeout)
    if (hello.protocolVersion !== 1) throw serverError('upstream_error', 'agy did not negotiate ACP 1.')
    const cwd = this.spec.workspace, mcpServers: never[] = []
    let response: JsonObject
    if (resume) {
      try {
        response = await this.proc.request('session/resume', { sessionId: resume, cwd, mcpServers }, launchTimeout)
      } catch (e) {
        if (e instanceof AcpError) return false
        throw e
      }
    } else response = await this.proc.request('session/new', { cwd, mcpServers }, launchTimeout)
    const id = response.sessionId ?? resume
    if (!safeId(id) || (resume && id !== resume)) throw serverError('upstream_error', 'agy returned an invalid ACP session ID.')
    this.session = id
    this.transcript = new Transcript(this.spec.gemini, id)
    await this.verifyAgent()
    const meta = object(object(object(response._meta)?.antigravity)?.tier)
    if (typeof meta?.name === 'string' && typeof meta.id === 'string') this.tier = { name: meta.name, id: meta.id }
    await this.proc.request('session/set_config_option', { sessionId: id, configId: 'model', value: this.spec.model }, launchTimeout)
    if (this.spec.tools.length && !this.listed) throw serverError('upstream_error', 'agy did not load the fenced agent’s MCP tools.')
    return true
  }

  stop() {
    this.proc.stop()
    return this.exit
  }

  fail(error: unknown) {
    this.active?.fail(error)
    this.proc.stop()
  }

  private async verifyAgent() {
    const dir = join(this.spec.gemini, 'antigravity-cli', 'log')
    const signal = this.controller.signal
    const deadline = performance.now() + 1500
    while (performance.now() < deadline) {
      signal.throwIfAborted()
      try {
        for await (const file of Deno.readDir(dir)) {
          if (!file.isFile || !/^acp-server-.*\.log$/.test(file.name)) continue
          const path = join(dir, file.name)
          const mtime = (await Deno.stat(path)).mtime
          if (!mtime || mtime.getTime() < this.proc.startedAt - 1000) continue
          const log = await Deno.readTextFile(path)
          if (!log.includes(`Starting ACP server (pid ${this.proc.pid},`)) continue
          if (/session_handlers\.go:\d+\] Agent ".*" not found, falling back to default/.test(log)) {
            throw serverError('upstream_error', 'agy fell back to the default agent; no prompt was sent.')
          }
          if (log.split('\n').some((line) => line.trimEnd().endsWith(`Starting conversation update stream for ${this.session}`))) return
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    throw serverError('upstream_error', 'Could not verify the fenced agent in the agy process log; no prompt was sent.')
  }

  async run(exchange: Exchange, prompt: string) {
    if (this.turn || this.active || !this.transcript) throw new Error('overlapping ACP prompt')
    this.active = exchange
    const cursor = await this.transcript.head()
    this.controller.signal.throwIfAborted()
    const turn = this.turn = { cursor, invocation: null, fallback: null, queue: [], chunks: false, used: [], boundaries: 0, drainedACP: new Set() }
    const result = await this.proc.request('session/prompt', { sessionId: this.session, prompt: [{ type: 'text', text: prompt }] })
    if (this.turn !== turn) return
    if (this.batch || !this.active) throw serverError('upstream_error', 'agy ended its prompt before issuing every planned tool call.')
    if (turn.queue.length) throw serverError('notice_undelivered', 'agy ended before the PreInvocation hook consumed queued messages.')
    const current = this.active
    const line = await this.transcript.find(turn.cursor, (p) => p.calls.length === 0, this.controller.signal)
    if (this.active !== current) return
    const remainder = remainingTokens(promptTokens(result.usage), turn)
    const counts = line?.usage ?? remainder
    if (counts?.thought_tokens === null && remainder?.thought_tokens != null) counts.thought_tokens = remainder.thought_tokens
    this.active = null
    this.turn = null
    this.pendingCall = undefined
    current.finish([], line, counts, result.stopReason === 'max_tokens')
  }

  continue(exchange: Exchange, results: Map<string, string>, steps: HookStep[]) {
    if (!this.turn || this.active || this.batch?.kind !== 'held') throw new Error('no agy tool hold is available')
    const { calls, release } = this.batch
    this.active = exchange
    this.turn.queue.push(...steps) // Hook sees the whole queue before any call is released.
    this.batch = calls.length === 1 ? null : { kind: 'draining', next: 1, calls, results }
    release(toolResult(results.get(calls[0].callId)!))
  }

  list() {
    this.listed = true
    return {
      tools: this.spec.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        inputSchema: parameters,
        _meta: { 'antigravity/alwaysLoad': true },
      })),
    }
  }

  hook(p: JsonObject) {
    const turn = this.turn, inv = count(p.invocationNum)
    if (!turn || p.conversationId !== this.session || inv === undefined || p.hookEventName !== 'PreInvocation') return {}
    if (turn.invocation !== null && inv <= turn.invocation) return {}
    turn.invocation = inv
    const steps = count(p.initialNumSteps)
    if (steps !== undefined) turn.cursor = Math.max(turn.cursor, steps - 1)
    turn.chunks = false
    const injectSteps = turn.queue.splice(0)
    return injectSteps.length ? { injectSteps } : {}
  }

  async tool(p: JsonObject): Promise<ToolResult> {
    const name = string(p.name), args = object(p.arguments) ?? {}, meta = object(p._meta)
    const turn = this.turn, call = this.pendingCall
    if (
      !turn || !name || !this.knownTools.has(name) || meta?.[CONVERSATION_KEY] !== this.session || !call ||
      !sameCall(call, { name: MCP_PREFIX + name, args: toolArgs(args) }) || turn.drainedACP.has(call.id)
    ) {
      throw serverError('upstream_error', 'agy’s MCP call did not match its ACP announcement.')
    }
    this.pendingCall = undefined
    turn.drainedACP.add(call.id)
    if (this.batch?.kind === 'draining') {
      const batch = this.batch, expect = batch.calls[batch.next++]
      if (!expect || !sameCall(call, { name: MCP_PREFIX + expect.name, args: expect.args })) {
        throw serverError('upstream_error', 'agy issued a different call than the planner listed.')
      }
      if (batch.next === batch.calls.length) this.batch = null
      return toolResult(batch.results.get(expect.callId)!)
    }
    const active = this.active
    if (!active || this.batch || !this.transcript) throw serverError('upstream_error', 'agy issued an unowned tool call.')
    const token = string(meta?.progressToken)
    const stepIndex = token?.match(/:(\d+)$/)?.[1]
    // The transcript planner precedes the execution step. A fallback invocation stays in fallback even if its line appears later.
    const line = turn.fallback !== null && turn.fallback === turn.invocation ? null : await this.transcript.find(
      turn.cursor,
      (p) => p.calls.length > 0 && sameCall(p.calls[0], call),
      this.controller.signal,
      stepIndex === undefined ? Infinity : Number(stepIndex),
    )
    this.controller.signal.throwIfAborted()
    const group = line?.calls.every((c) => c.name.startsWith(MCP_PREFIX) && this.knownTools.has(c.name.slice(MCP_PREFIX.length))) ? line : null
    const calls = (group?.calls ?? [call]).map((c, i) => ({
      callId: i === 0 ? call.id : newId('call'),
      name: c.name.slice(MCP_PREFIX.length),
      args: c.args,
    }))
    if (!group) {
      turn.fallback = turn.invocation
      console.error('agy planner did not identify a complete client tool batch; emitting one call')
    }
    if (line) turn.cursor = line.index
    if (group?.usage) turn.used.push(group.usage)
    turn.boundaries++
    const hold = new Promise<ToolResult>((release) => this.batch = { kind: 'held', calls, release })
    this.active = null
    active.finish(calls, group, group?.usage ?? null, false)
    return await hold
  }

  private permission(p: JsonObject) {
    const call = object(p.toolCall), name = string(call?.name)
    const allow = p.sessionId === this.session && name?.startsWith(MCP_PREFIX) && this.knownTools.has(name.slice(MCP_PREFIX.length))
    const options = Array.isArray(p.options) ? p.options.map(object) : []
    const option = options.find((o) => o?.kind === (allow ? 'allow_once' : 'reject_once'))
    return { outcome: option && typeof option.optionId === 'string' ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
  }

  private update(value: unknown) {
    const p = object(value)
    if (!p || !this.turn) return
    if (p.sessionUpdate === 'tool_call') {
      const id = string(p.toolCallId), name = string(p.name), args = object(p.rawInput) ?? object(p.args)
      if (id && name?.startsWith(MCP_PREFIX) && args) this.pendingCall = { id, name, args: toolArgs(args) }
    } else if (p.sessionUpdate === 'agent_message_chunk' || p.sessionUpdate === 'agent_thought_chunk') {
      const content = object(p.content), text = string(content?.text)
      if (content?.type !== 'text' || !text || !this.active) return
      const type = p.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought'
      // ACP prefixes continuation text with a separator for its single combined turn. Responses split at each inference.
      const delta = type === 'text' && !this.turn.chunks && this.turn.boundaries ? text.replace(/^\n\n/, '') : text
      if (type === 'text') this.turn.chunks = true
      this.active.output.chunk(type, delta)
    }
  }
}

function remainingTokens(total: Tokens | null, turn: Turn): Tokens | null {
  if (!total || turn.used.length !== turn.boundaries) return null
  for (const prior of turn.used) {
    for (const key of ['input_tokens', 'cached_read_tokens', 'cached_write_tokens', 'output_tokens'] as const) total[key] -= prior[key]
    total.thought_tokens = total.thought_tokens === null || prior.thought_tokens === null ? null : total.thought_tokens - prior.thought_tokens
  }
  if ([total.input_tokens, total.output_tokens, total.cached_read_tokens, total.cached_write_tokens].some((x) => x < 0)) return null
  return total
}

export function injection(notices: Extract<InItem, { kind: 'message' }>[]): HookStep[] {
  return notices.flatMap<HookStep>((item) => {
    const text = item.parts.map((p) => p.type === 'text' ? p.text : '').join('\n')
    if (!text) return []
    return item.role === 'user' ? [{ userMessage: text }] : [{ systemMessage: { systemMessage: text } }]
  })
}
