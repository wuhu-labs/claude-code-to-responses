// A lane is one Claude Code session (one chain of responses) and, while it lives, the one process serving it.
// It turns Claude Code's stream into Responses events, holds MCP calls until the client's outputs come,
// delivers notices through hooks, and records every log entry so the process can be killed and rebuilt.
import type { FnTool, InItem, Part } from './api/request.ts'
import { newId, type ResponseState, type SseSink, type UsageTotals } from './api/stream.ts'
import { type Bridge, type BridgeTarget, McpCallError, StaleEpoch } from './bridge.ts'
import { ClaudeProcess, type Frame } from './claude/process.ts'
import { type LaunchSpec, logPath, MAX_RESULT_CHARS, MCP_PREFIX, mcpConfigJson, projectDir, settingsJson } from './claude/pins.ts'
import { chainConfigDir, type Config, paths } from './config.ts'
import { type ErrorCode, GatewayError, serverError } from './errors.ts'
import { type CallRef, digestItems, encodeRecord, encodeThinking, type ProviderRecord } from './records.ts'
import type { ResponseStore } from './store.ts'

// deno-lint-ignore no-explicit-any
type Json = any

export interface ChainSpec {
  key: string
  model: string
  effort: string
  instructions: string
  tools: FnTool[]
}

export interface Head {
  responseId: string
  end: 'turn' | 'calls'
  calls: CallRef[]
}

export interface LaneEvents {
  /** The gateway's log of lifecycle events, for tests and diagnostics. */
  note(kind: string, data: Json): void
  /** The lane stops serving requests (its process is being killed). */
  dead(lane: Lane): void
  /** Its process has exited. */
  gone(lane: Lane): void
}

interface BlockState {
  type: string
  outputIndex: number
  item: Json
  buf: string
  signature: string
  done: boolean
}

interface MsgState {
  id: string
  blocks: Map<number, BlockState>
  stopReason: string | null
  stopped: boolean
  usage: UsageTotals
}

export class Active {
  msg: MsgState | null = null
  finished = false
  usage: UsageTotals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }
  /** Output items as the client will replay them, for the record digest. */
  outputs: InItem[] = []
  mirrorTimer: ReturnType<typeof setTimeout> | undefined
  /** Claude Code's current turn is this response's (its input went in), so the turn's result is its business. */
  ownsTurn = false
  /** The turn's result arrived. */
  turnEnded = false
  /** Its record is being cut from the log. */
  finishing = false
  constructor(
    readonly state: ResponseState,
    readonly sink: SseSink,
    /** The response this one continues in the log; null when it starts it. */
    readonly prevId: string | null,
    /** Every input item the record covers: synthesized history, then this request's input. */
    readonly covered: InItem[],
  ) {}
}

export class Lane implements BridgeTarget {
  proc: ClaudeProcess | null = null
  epoch = ''
  head: Head | null
  /**
   * Log lines since `head`'s record, verbatim, as they are on disk: the head's tail, the gateway's own writes for this
   * attempt, then whatever Claude Code appended. The log file is the truth; the mirror only says when to read it.
   */
  pending: string[] = []
  /** Bytes of the log file already read into records or `pending`. */
  private logOffset = 0
  /** Mirrored lines since the last record: the disk must hold each before a record is cut. */
  private mirroredLines: string[] = []
  active: Active | null = null
  dead = false
  private turnOpen = false
  private turnWaiters: (() => void)[] = []
  /** MCP calls waiting for the client's output, by tool_use id (a duplicate call waits beside the first). */
  private held = new Map<string, Set<(r: Json) => void>>()
  /** The client's outputs, by tool_use id; kept, so a duplicate call gets the same answer. */
  private results = new Map<string, Json>()
  /** tool_use ids the model has produced in this process's stream; MCP calls for any other id are refused. */
  private known = new Set<string>()
  private answered = new Set<string>()
  private knownWaiters = new Map<string, (() => void)[]>()
  private staged: { callId: string; text: string } | null = null
  private continuing = false
  /** For each model message id: the stream indexes whose log entries the mirror has delivered. */
  private mirrored = new Map<string, Set<number>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private runDir = ''

  constructor(
    readonly sessionId: string,
    /** The chain's device id, seeded into its config folder so metadata.user_id is the same on every rebuild. */
    readonly device: string,
    readonly workDir: string,
    readonly chain: ChainSpec,
    head: Head | null,
    private readonly config: Config,
    private readonly bridge: Bridge,
    private readonly store: ResponseStore,
    private readonly events: LaneEvents,
  ) {
    this.head = head
  }

  get logFile(): string {
    return logPath(this.configDir, this.workDir, this.sessionId)
  }

  get configDir(): string {
    return chainConfigDir(this.config, this.sessionId)
  }

  /** Reads the complete lines Claude Code appended to the log since the last read into `pending`. */
  private readLog(): void {
    let f: Deno.FsFile
    try {
      f = Deno.openSync(this.logFile, { read: true })
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return
      throw e
    }
    try {
      const size = f.statSync().size
      if (size <= this.logOffset) return
      const buf = new Uint8Array(size - this.logOffset)
      f.seekSync(this.logOffset, Deno.SeekMode.Start)
      let got = 0
      while (got < buf.length) {
        const n = f.readSync(buf.subarray(got))
        if (n === null || n === 0) break
        got += n
      }
      const end = buf.subarray(0, got).lastIndexOf(10) // only whole lines
      if (end < 0) return
      const text = new TextDecoder().decode(buf.subarray(0, end + 1))
      this.logOffset += end + 1
      for (const l of text.split('\n')) if (l !== '') this.pending.push(l)
    } finally {
      f.close()
    }
  }

  // ---- process lifecycle -------------------------------------------------------------------------------

  /**
   * Writes a rebuilt log (when resuming) and starts Claude Code. The log is the stored records (`log`), the tail
   * Claude Code wrote after the last of them (already in `pending`), then this attempt's own entries (`attempt`:
   * synthesized history, the interrupted-turn results and text), which the response's record will carry.
   */
  spawn(opts: { resume: boolean; interruptedTurn: boolean; log?: string[]; attempt?: string[] }): void {
    const p = paths(this.config)
    Deno.mkdirSync(this.configDir, { recursive: true, mode: 0o700 })
    this.seedDevice()
    if (opts.resume) {
      const dir = projectDir(this.configDir, this.workDir)
      Deno.mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        Deno.removeSync(`${dir}/${this.sessionId}`, { recursive: true })
      } catch { /* none */ }
      const lines = [...(opts.log ?? []), ...this.pending, ...(opts.attempt ?? [])]
      const text = lines.map((l) => l + '\n').join('')
      Deno.writeTextFileSync(this.logFile, text, { mode: 0o600 })
      this.logOffset = new TextEncoder().encode(text).length
    } else {
      this.logOffset = 0
    }
    this.pending.push(...(opts.attempt ?? []))
    this.epoch = newId('ep')
    this.runDir = `${p.runDir}/${this.epoch}`
    Deno.mkdirSync(this.runDir, { recursive: true, mode: 0o700 })
    const settingsPath = `${this.runDir}/settings.json`
    const mcpConfigPath = `${this.runDir}/mcp.json`
    const systemPromptPath = `${this.runDir}/system-prompt.txt`
    Deno.writeTextFileSync(systemPromptPath, this.chain.instructions, { mode: 0o600 })
    Deno.writeTextFileSync(settingsPath, JSON.stringify(settingsJson(this.bridge.hookUrl(this.epoch), this.bridge.bearer)), { mode: 0o600 })
    Deno.writeTextFileSync(mcpConfigPath, JSON.stringify(mcpConfigJson(this.bridge.mcpUrl(this.epoch), this.bridge.bearer)), { mode: 0o600 })
    const spec: LaunchSpec = {
      binary: this.config.claudeBinary,
      sessionId: this.sessionId,
      resume: opts.resume,
      model: this.chain.model,
      effort: this.chain.effort,
      systemPromptPath,
      workDir: this.workDir,
      configDir: this.configDir,
      homeDir: p.homeDir,
      tz: this.config.tz,
      settingsPath,
      mcpConfigPath,
      interruptedTurn: opts.interruptedTurn,
      backendEnv: this.config.backendEnv,
    }
    this.bridge.register(this.epoch, this)
    const epoch = this.epoch
    this.turnOpen = opts.interruptedTurn
    // the interrupted-turn resume starts the active response's turn by itself
    if (opts.interruptedTurn && this.active) this.active.ownsTurn = true
    const spawnedFrom = Date.now()
    this.proc = new ClaudeProcess(spec, (f) => this.onFrame(f), (s) => this.onExit(epoch, s), (e) => this.onFrameError(e))
    // the pid registry, written in the same synchronous step as the spawn: a gateway that dies without killing its
    // processes finds them at its next start (pid, executable, and a start-time window; a pid alone is never trusted)
    Deno.writeTextFileSync(
      `${this.runDir}/proc.json`,
      JSON.stringify({ pid: this.proc.pid, binary: this.config.claudeBinary, spawnedFrom, spawnedTo: Date.now() }),
      { mode: 0o600 },
    )
    this.events.note('spawn', {
      session: this.sessionId,
      device: this.device,
      pid: this.proc.pid,
      epoch,
      resume: opts.resume,
      interruptedTurn: opts.interruptedTurn,
    })
  }

  /**
   * Claude Code takes its device id (metadata.user_id's device_id) from its config folder's .claude.json `userID` and
   * generates one only when there is none (probed). Seeding the chain's own id there before every launch makes
   * metadata.user_id the same wherever and whenever the chain is rebuilt.
   */
  private seedDevice(): void {
    const path = `${this.configDir}/.claude.json`
    // deno-lint-ignore no-explicit-any
    let state: any = {}
    try {
      state = JSON.parse(Deno.readTextFileSync(path))
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
    if (state.userID === this.device) return
    state.userID = this.device
    Deno.writeTextFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
  }

  /** A bug in handling Claude Code's output: the response fails visibly and the process goes. */
  private onFrameError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    this.events.note('frame_error', { session: this.sessionId, message })
    this.fail(serverError('internal_error', `The gateway failed on Claude Code's output: ${message}`))
    void this.kill('frame_error')
  }

  private onExit(epoch: string, s: Deno.CommandStatus): void {
    if (this.epoch !== epoch || this.dead) return
    this.events.note('exit', { session: this.sessionId, code: s.code, signal: s.signal })
    const err = serverError(
      'claude_code_exited',
      `Claude Code exited (code ${s.code}${s.signal ? `, signal ${s.signal}` : ''}): ${this.proc?.stderr.slice(-1000) ?? ''}`,
    )
    this.fail(err)
    void this.kill('exited')
  }

  private killing: Promise<void> | null = null

  /** Kills the process. Held calls lose only the gateway's wait: the client's tools are the client's.
   * The lane leaves the gateway at once; the returned promise settles once the process is gone. */
  kill(reason: string): Promise<void> {
    if (!this.killing) {
      this.dead = true
      this.killing = this.teardown(reason)
      this.events.dead(this)
    }
    return this.killing
  }

  /** Settles once the process is gone and its tail is stored; resolved for a lane never killed. */
  get gone(): Promise<void> {
    return this.killing ?? Promise.resolve()
  }

  private async teardown(reason: string): Promise<void> {
    const atRest = this.pendingAtAttach === null
    clearTimeout(this.timer)
    this.bridge.unregister(this.epoch)
    for (const [, resolvers] of this.held) {
      for (const resolve of resolvers) resolve({ content: [{ type: 'text', text: 'gateway: process evicted' }], isError: true })
    }
    this.held.clear()
    for (const [, ws] of this.knownWaiters) for (const w of ws) w()
    this.knownWaiters.clear()
    this.wakeTurn()
    const proc = this.proc
    if (proc) await proc.kill()
    this.events.note('kill', { session: this.sessionId, pid: proc?.pid, reason })
    // a response still open when its process goes always ends, even one caught between finishing and completing
    if (this.active && this.active.state.status === 'in_progress') {
      this.active.finished = false
      this.fail(serverError('claude_code_killed', `Claude Code was killed (${reason}).`))
    }
    try {
      Deno.removeSync(this.runDir, { recursive: true })
    } catch { /* gone */ }
    if (this.head) this.keepTail(atRest)
    this.events.gone(this)
  }

  /**
   * Stores what Claude Code wrote after the head response's record (its tail), so a rebuild loses nothing. At rest
   * that is everything on disk past the stored records, mirrored or not; after a failed or cancelled attempt it is
   * what came before the attempt, never the attempt itself.
   */
  private keepTail(atRest: boolean): void {
    const chain = this.store.chain(this.head!.responseId)
    if (!chain) return this.events.note('verify_error', { session: this.sessionId, error: 'chain missing from store' })
    try {
      this.readLog() // the process is gone: everything it wrote is on disk
    } catch (e) {
      this.events.note('verify_error', { session: this.sessionId, error: String(e) })
    }
    const tail = atRest ? this.pending : this.pending.slice(0, this.pendingAtAttach ?? this.pending.length)
    // the log is the stored chain, then this tail (and, after a failed attempt, the attempt), byte for byte
    let disk: string[] = []
    try {
      disk = Deno.readTextFileSync(this.logFile).split('\n').filter((l) => l !== '')
    } catch { /* checked below */ }
    const want = [...chain.flatMap((r) => r.entries), ...tail]
    const i = want.findIndex((l, i) => disk[i] !== l)
    if (i >= 0 || (atRest && disk.length !== want.length)) {
      const at = i >= 0 ? i : want.length
      this.events.note('verify_error', { session: this.sessionId, line: at, disk: disk[at]?.slice(0, 300) ?? null, want: want[at]?.slice(0, 300) ?? null })
    } else if (this.config.verifyLogs) {
      this.events.note('verify_ok', { session: this.sessionId, lines: want.length })
    }
    if (tail.length) {
      this.store.putTail(this.head!.responseId, tail)
      this.events.note('tail', { session: this.sessionId, response: this.head!.responseId, lines: tail.length })
    }
  }

  private armEviction(): void {
    clearTimeout(this.timer)
    if (this.dead || this.active || !this.head) return
    const hold = this.head.end === 'calls'
    const ms = hold ? this.config.holdTimeoutMs : this.config.idleTimeoutMs
    this.timer = setTimeout(() => void this.kill(hold ? 'hold_timeout' : 'idle_timeout'), ms)
  }

  // ---- requests --------------------------------------------------------------------------------------

  /** Length of `pending` when the active response attached: what came before is the head's tail. Null at rest. */
  private pendingAtAttach: number | null = null

  attach(a: Active): void {
    clearTimeout(this.timer)
    this.active = a
    // anything Claude Code wrote while the lane sat at rest belongs before this attempt
    if (this.proc && !this.dead) this.readLog()
    this.pendingAtAttach = this.pending.length
    a.sink.onCancel = () => {
      this.events.note('client_disconnect', { session: this.sessionId, response: a.state.id })
      this.cancel(a.state.id, 'client_disconnected')
    }
  }

  /** A new user turn through stdin, once Claude Code's previous turn has ended. */
  /** Never rejects: a failed write (a broken pipe) fails the response and kills the process. */
  async startTurn(parts: Part[]): Promise<void> {
    await this.turnClosed()
    if (this.dead) return
    this.turnOpen = true
    if (this.active) this.active.ownsTurn = true
    try {
      await this.proc!.write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: contentFor(parts) } })
    } catch (e) {
      this.events.note('stdin_failed', { session: this.sessionId, message: String(e) })
      this.fail(serverError('claude_code_stdin', `Could not write the turn to Claude Code: ${e instanceof Error ? e.message : e}`))
      void this.kill('stdin_failed')
    }
  }

  /** Releases held calls with the client's outputs. Notices are staged on the last call's hook first. */
  release(outputs: Map<string, Part[]>, notices: string | null): void {
    // the held calls are the open turn's: this response continues it
    if (this.active) this.active.ownsTurn = true
    const calls = this.head!.calls
    this.staged = notices !== null ? { callId: calls[calls.length - 1].id, text: notices } : null
    for (const [id, parts] of outputs) this.results.set(id, mcpResult(parts))
    for (const [id, resolvers] of [...this.held]) {
      const r = this.results.get(id)
      if (r === undefined) continue
      this.held.delete(id)
      this.answered.add(id)
      for (const resolve of resolvers) resolve(r)
    }
  }

  cancel(responseId: string, reason: string): boolean {
    const a = this.active
    if (!a || a.finished || a.state.id !== responseId) return false
    a.finished = true
    a.state.status = 'cancelled'
    a.state.error = { code: 'cancelled' satisfies ErrorCode, message: `The response was cancelled (${reason}).` }
    a.sink.send('response.failed', { response: a.state.object() })
    a.sink.close()
    this.active = null
    void this.kill(reason)
    return true
  }

  private turnClosed(): Promise<void> {
    if (!this.turnOpen || this.dead) return Promise.resolve()
    return new Promise((r) => this.turnWaiters.push(r))
  }

  private wakeTurn(): void {
    const w = this.turnWaiters.splice(0)
    for (const f of w) f()
  }

  // ---- MCP and hooks ---------------------------------------------------------------------------------

  mcpTools(): Json[] {
    return this.chain.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
      _meta: { 'anthropic/maxResultSizeChars': MAX_RESULT_CHARS },
    }))
  }

  async toolCall(callId: string, _name: string, _args: Json, signal: AbortSignal): Promise<Json> {
    const stale = () => new StaleEpoch('stale Claude Code process: it was killed')
    if (this.dead) throw stale()
    if (!this.known.has(callId)) {
      // Claude Code calls a tool once its block is streamed; give the stream a moment to catch up with the call
      await this.whenKnown(callId, 2000)
      if (this.dead) throw stale()
      if (!this.known.has(callId)) {
        this.events.note('unknown_call', { session: this.sessionId, call: callId })
        throw new McpCallError(-32602, `unknown tool call '${callId}': the model made no such call`)
      }
    }
    if (this.held.has(callId) || this.answered.has(callId)) this.events.note('duplicate_call', { session: this.sessionId, call: callId })
    const ready = this.results.get(callId)
    if (ready !== undefined) {
      this.answered.add(callId)
      return ready
    }
    this.events.note('hold', { session: this.sessionId, call: callId })
    return await new Promise((resolve) => {
      const set = this.held.get(callId) ?? new Set()
      set.add(resolve)
      this.held.set(callId, set)
      signal.addEventListener('abort', () => {
        set.delete(resolve)
        if (set.size === 0 && this.held.get(callId) === set) this.held.delete(callId)
      })
    })
  }

  private whenKnown(callId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(() => {
        // a waiter that timed out leaves, so bogus ids cannot pile up
        const ws = (this.knownWaiters.get(callId) ?? []).filter((w) => w !== done)
        if (ws.length) this.knownWaiters.set(callId, ws)
        else this.knownWaiters.delete(callId)
        done()
      }, ms)
      const ws = this.knownWaiters.get(callId) ?? []
      ws.push(done)
      this.knownWaiters.set(callId, ws)
    })
  }

  /** MCP calls waiting to learn whether the model made their tool_use id (for tests). */
  get unknownCallWaiters(): number {
    let n = 0
    for (const ws of this.knownWaiters.values()) n += ws.length
    return n
  }

  private learn(callId: string): void {
    this.known.add(callId)
    const ws = this.knownWaiters.get(callId)
    this.knownWaiters.delete(callId)
    for (const w of ws ?? []) w()
  }

  hook(body: Json): Json {
    if (this.dead) throw new StaleEpoch('stale Claude Code process: it was killed')
    const event = body?.hook_event_name
    if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && this.staged && body.tool_use_id === this.staged.callId) {
      const text = this.staged.text
      this.staged = null
      this.events.note('notice', { session: this.sessionId, via: event, call: body.tool_use_id })
      return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
    }
    if (event === 'Stop' && this.staged && this.active && !this.active.finished) {
      // the last call's hook never ran: the notices continue this response's inference from the end-of-turn hook
      const text = this.staged.text
      this.staged = null
      this.continuing = true
      this.events.note('notice', { session: this.sessionId, via: 'Stop' })
      return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } }
    }
    return {}
  }

  // ---- Claude Code's stream -------------------------------------------------------------------------

  private onFrame(f: Frame): void {
    if (this.dead) return
    switch (f.type) {
      case 'transcript_mirror':
        for (const e of f.entries ?? []) this.mirror(e)
        break
      case 'stream_event':
        this.streamEvent(f.event)
        break
      case 'result':
        this.onResult(f)
        break
      case 'control_request':
        this.fail(serverError('unexpected_control_request', `Claude Code asked the host: ${JSON.stringify(f.request ?? {}).slice(0, 300)}`))
        void this.kill('control_request')
        break
    }
  }

  private mirror(e: Json): void {
    this.mirroredLines.push(JSON.stringify(e))
    if (e?.type === 'assistant' && typeof e.message?.id === 'string' && typeof e.apiBlockIndex === 'number') {
      const m = this.mirrored.get(e.message.id) ?? new Set<number>()
      m.add(e.apiBlockIndex)
      this.mirrored.set(e.message.id, m)
      this.maybeFinish()
    }
  }

  private onResult(f: Frame): void {
    this.turnOpen = false
    this.wakeTurn()
    const a = this.active
    // a result can only end the active response's own turn, never the previous one's
    if (!a || a.finished || !a.ownsTurn) return
    if (f.is_error) return this.fail(resultError(f))
    if (!a.msg?.stopped) {
      return this.fail(serverError('turn_ended_without_message', `Claude Code ended its turn without a model message: ${String(f.result ?? '').slice(0, 300)}`))
    }
    a.turnEnded = true
    this.maybeFinish()
  }

  private streamEvent(ev: Json): void {
    const a = this.active
    if (ev?.type === 'message_start') {
      if (!a || a.finished) {
        this.events.note('unowned_inference', { session: this.sessionId })
        void this.kill('unowned_inference')
        return
      }
      if (a.msg && !a.msg.stopped) {
        return this.fail(serverError('upstream_stream_cut', 'The model stream was cut short and Claude Code retried; the partial output cannot be withdrawn.'))
      }
      this.continuing = false
      // the response goes on with a new model message: the wait for the last one's record is over
      clearTimeout(a.mirrorTimer)
      const u = ev.message?.usage ?? {}
      a.msg = {
        id: ev.message?.id,
        blocks: new Map(),
        stopReason: null,
        stopped: false,
        usage: {
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheCreation: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        },
      }
      return
    }
    if (!a || a.finished || !a.msg) return
    const msg = a.msg
    const sink = a.sink
    switch (ev.type) {
      case 'content_block_start': {
        const cb = ev.content_block ?? {}
        const outputIndex = a.state.output.length
        let item: Json
        if (cb.type === 'text') {
          item = { type: 'message', id: newId('msg'), status: 'in_progress', role: 'assistant', content: [] }
        } else if (cb.type === 'thinking') {
          item = { type: 'reasoning', id: newId('rs'), summary: [], content: [] }
        } else if (cb.type === 'redacted_thinking') {
          item = { type: 'reasoning', id: newId('rs'), summary: [], encrypted_content: encodeThinking({ redacted: cb.data }) }
        } else if (cb.type === 'tool_use') {
          const name = String(cb.name ?? '')
          if (!name.startsWith(MCP_PREFIX)) return this.fail(serverError('unexpected_tool', `The model called '${name}', which is not a client tool.`))
          item = { type: 'function_call', id: newId('fc'), call_id: cb.id, name: name.slice(MCP_PREFIX.length), arguments: '', status: 'in_progress' }
          this.learn(cb.id)
        } else {
          return this.fail(serverError('unexpected_block', `Unsupported content block '${cb.type}' from the model.`))
        }
        a.state.output.push(item)
        msg.blocks.set(ev.index, { type: cb.type, outputIndex, item, buf: '', signature: '', done: false })
        sink.send('response.output_item.added', { output_index: outputIndex, item: structuredClone(item) })
        if (cb.type === 'text') {
          sink.send('response.content_part.added', {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
          })
        }
        return
      }
      case 'content_block_delta': {
        const b = msg.blocks.get(ev.index)
        if (!b) return
        const d = ev.delta ?? {}
        if (d.type === 'text_delta') {
          b.buf += d.text
          sink.send('response.output_text.delta', { item_id: b.item.id, output_index: b.outputIndex, content_index: 0, delta: d.text, logprobs: [] })
        } else if (d.type === 'thinking_delta') {
          b.buf += d.thinking
          sink.send('response.reasoning_text.delta', { item_id: b.item.id, output_index: b.outputIndex, content_index: 0, delta: d.thinking })
        } else if (d.type === 'signature_delta') {
          b.signature += d.signature
        } else if (d.type === 'input_json_delta') {
          b.buf += d.partial_json
          sink.send('response.function_call_arguments.delta', { item_id: b.item.id, output_index: b.outputIndex, delta: d.partial_json })
        }
        return
      }
      case 'content_block_stop': {
        const b = msg.blocks.get(ev.index)
        if (!b || b.done) return
        b.done = true
        const it = b.item
        if (b.type === 'text') {
          const part = { type: 'output_text', text: b.buf, annotations: [], logprobs: [] }
          sink.send('response.output_text.done', { item_id: it.id, output_index: b.outputIndex, content_index: 0, text: b.buf, logprobs: [] })
          sink.send('response.content_part.done', { item_id: it.id, output_index: b.outputIndex, content_index: 0, part })
          it.content = [part]
          it.status = 'completed'
          a.outputs.push({ kind: 'message', role: 'assistant', parts: [{ type: 'text', text: b.buf }] })
        } else if (b.type === 'thinking') {
          sink.send('response.reasoning_text.done', { item_id: it.id, output_index: b.outputIndex, content_index: 0, text: b.buf })
          it.content = [{ type: 'reasoning_text', text: b.buf }]
          it.encrypted_content = encodeThinking({ thinking: b.buf, signature: b.signature })
        } else if (b.type === 'tool_use') {
          it.arguments = b.buf.trim() ? b.buf : '{}'
          it.status = 'completed'
          sink.send('response.function_call_arguments.done', { item_id: it.id, output_index: b.outputIndex, name: it.name, arguments: it.arguments })
          a.outputs.push({ kind: 'function_call', callId: it.call_id, name: it.name, arguments: it.arguments })
        }
        sink.send('response.output_item.done', { output_index: b.outputIndex, item: structuredClone(it) })
        return
      }
      case 'message_delta': {
        if (ev.delta?.stop_reason) msg.stopReason = ev.delta.stop_reason
        const u = ev.usage ?? {}
        if (typeof u.output_tokens === 'number') msg.usage.output = u.output_tokens
        if (typeof u.input_tokens === 'number') msg.usage.input = u.input_tokens
        if (typeof u.cache_read_input_tokens === 'number') msg.usage.cacheRead = u.cache_read_input_tokens
        if (typeof u.cache_creation_input_tokens === 'number') msg.usage.cacheCreation = u.cache_creation_input_tokens
        return
      }
      case 'message_stop': {
        if (!msg.stopReason) return this.fail(serverError('upstream_stream_cut', 'The model stream ended without a stop reason.'))
        msg.stopped = true
        a.usage.input += msg.usage.input
        a.usage.cacheRead += msg.usage.cacheRead
        a.usage.cacheCreation += msg.usage.cacheCreation
        a.usage.output += msg.usage.output
        clearTimeout(a.mirrorTimer)
        a.mirrorTimer = setTimeout(() => {
          if (this.active === a && !a.finished) this.fail(serverError('record_incomplete', 'Claude Code did not log every block of the model message.'))
        }, this.config.recordTimeoutMs ?? 15000)
        this.maybeFinish()
        return
      }
    }
  }

  /**
   * A response ends at the model's message_stop, once the log entries of every block are in hand. When the model
   * ends its turn, the response also waits for the turn's result: Claude Code has then logged the turn's end-of-turn
   * hook, so the record holds the whole turn and nothing is left over for the next one.
   */
  private maybeFinish(): void {
    const a = this.active
    if (!a || a.finished || a.finishing || !a.msg?.stopped) return
    const msg = a.msg
    const m = this.mirrored.get(msg.id)
    for (const i of msg.blocks.keys()) if (!m?.has(i)) return
    // every block is logged: the wait the record timer guards is over (the turn's end may legitimately take longer)
    clearTimeout(a.mirrorTimer)
    const calls = msg.stopReason === 'tool_use'
    const callBlocks = [...msg.blocks.values()].filter((b) => b.type === 'tool_use')
    if (calls && (callBlocks.length === 0 || !m)) {
      return this.fail(serverError('malformed_model_message', 'The model stopped for tool use without calling a tool.'))
    }
    if (!calls && (this.staged || this.continuing)) return // notices go in at the end-of-turn hook; inference goes on
    if (!calls && !a.turnEnded) return
    if (calls && this.staged) return this.fail(serverError('notice_undelivered', 'The model called tools again before the notices could be delivered.'))
    a.finishing = true
    const callRefs: CallRef[] = calls ? callBlocks.map((b) => ({ id: b.item.call_id, name: b.item.name })) : []
    void this.cutRecord(a, msg.id, Math.max(...msg.blocks.keys()), calls, callRefs, msg.stopReason!)
  }

  /**
   * Cuts the response's record from the log on disk, once the disk holds everything the mirror announced. A turn's
   * end takes every line so far; held calls take the lines through the message's last block (Claude Code writes
   * nothing more while it waits; anything that comes later goes to the next record or the tail).
   */
  private async cutRecord(a: Active, msgId: string, lastBlock: number, calls: boolean, callRefs: CallRef[], stopReason: string): Promise<void> {
    const deadline = Date.now() + 2000
    while (true) {
      if (this.active !== a || a.finished) return
      this.readLog()
      const have = new Set(this.pending)
      let cut = -1
      if (calls) {
        cut = this.pending.findIndex((l) => {
          if (!l.includes(msgId)) return false
          const e = JSON.parse(l)
          return e.type === 'assistant' && e.message?.id === msgId && e.apiBlockIndex === lastBlock
        }) + 1
      } else if (this.mirroredLines.every((l) => have.has(l))) {
        cut = this.pending.length
      }
      if (cut > 0) {
        clearTimeout(a.mirrorTimer)
        a.finished = true
        return this.complete(a, calls ? 'calls' : 'turn', callRefs, cut, stopReason)
      }
      if (Date.now() > deadline) {
        a.finishing = false
        return this.fail(serverError('record_incomplete', 'The log on disk does not hold what Claude Code reported writing.'))
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** Awaited before a response commits (tests use it to kill a lane in that window). */
  beforeCommit: (() => Promise<void>) | null = null

  /**
   * Prepares the record (asynchronously), then commits in one synchronous step: the record goes to the store, the head
   * moves and the client is told it completed. A lane killed before that step fails the response and stores nothing,
   * so the client and the store never disagree.
   */
  private async complete(a: Active, end: 'turn' | 'calls', calls: CallRef[], cut: number, stopReason: string): Promise<void> {
    const entries = this.pending.slice(0, cut)
    const record: ProviderRecord = {
      v: 1,
      id: a.state.id,
      prev: a.prevId,
      chain: this.chain.key,
      session: this.sessionId,
      device: this.device,
      end,
      calls,
      digest: await digestItems([...a.covered, ...a.outputs]),
      entries,
    }
    const item = { type: 'reasoning', id: newId('rs'), summary: [], encrypted_content: await encodeRecord(record) }
    await this.beforeCommit?.()
    if (this.dead || a.state.status !== 'in_progress') return // failed meanwhile: the store never hears of it
    // ---- commit: synchronous from here on
    this.pending = this.pending.slice(cut)
    const taken = new Set(entries)
    this.mirroredLines = this.mirroredLines.filter((l) => !taken.has(l))
    this.mirrored.clear()
    this.store.put(record)
    this.head = { responseId: a.state.id, end, calls }
    this.pendingAtAttach = null
    if (this.active === a) this.active = null
    const outputIndex = a.state.output.length
    a.state.output.push(item)
    a.sink.send('response.output_item.added', { output_index: outputIndex, item })
    a.sink.send('response.output_item.done', { output_index: outputIndex, item })
    a.state.usage = a.usage
    if (stopReason === 'max_tokens') {
      a.state.status = 'incomplete'
      a.state.incomplete = { reason: 'max_output_tokens' }
      a.sink.send('response.incomplete', { response: a.state.object() })
    } else {
      a.state.status = 'completed'
      a.sink.send('response.completed', { response: a.state.object() })
    }
    a.sink.close()
    this.events.note('completed', { session: this.sessionId, response: a.state.id, end, calls: calls.length, entries: entries.length, usage: a.usage })
    this.armEviction()
  }

  /** Ends the active response with an error. The lane's state is unknown afterwards, so the process goes. */
  fail(err: GatewayError): void {
    const a = this.active
    if (!a || a.finished) return
    a.finished = true
    clearTimeout(a.mirrorTimer)
    this.active = null
    a.state.status = 'failed'
    a.state.error = err.toResponseError()
    a.state.usage = a.usage
    a.sink.send('response.failed', { response: a.state.object() })
    a.sink.close()
    this.events.note('failed', { session: this.sessionId, response: a.state.id, code: err.code, message: err.message.slice(0, 500) })
    void this.kill(`failed: ${err.code}`)
  }
}

export function contentFor(parts: Part[]): Json[] {
  return parts.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
  )
}

export function mcpResult(parts: Part[]): Json {
  return {
    content: parts.map((p) => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', data: p.data, mimeType: p.mediaType }),
    isError: false,
  }
}

export function outputChars(parts: Part[]): number {
  return parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0)
}
export { MAX_RESULT_CHARS }

/**
 * Maps the error result of a turn. Measured on 2.1.284: an upstream error ends the turn with
 * `terminal_reason: "api_error"`, `api_error_status: <HTTP status>` and `result: "API Error: …"`; the context limit
 * with `terminal_reason: "blocking_limit"` and "Prompt is too long". The probe checks both shapes per release.
 */
function resultError(f: Frame): GatewayError {
  const text = String(f.result ?? f.errors?.join?.('; ') ?? 'Claude Code reported an error')
  // the local blocking limit, or the backend refusing the prompt as too long ("prompt is too long: N tokens > M maximum")
  if (f.terminal_reason === 'blocking_limit' || /prompt is too long/i.test(text)) {
    return new GatewayError(400, 'invalid_request_error', 'context_length_exceeded', `The context is too long for the model: ${text}`)
  }
  const status = typeof f.api_error_status === 'number' ? f.api_error_status : null
  if (f.terminal_reason === 'api_error' && status !== null) {
    if (status === 429) return new GatewayError(429, 'server_error', 'rate_limit_exceeded', text)
    if (status === 401 || status === 403) return new GatewayError(status, 'server_error', 'upstream_authentication_error', text)
    if (status === 529) return new GatewayError(503, 'server_error', 'upstream_overloaded', text)
    if (status >= 400 && status < 500) return new GatewayError(400, 'invalid_request_error', 'upstream_invalid_request', text)
    return new GatewayError(502, 'server_error', 'upstream_error', text)
  }
  return serverError('claude_code_error', `Claude Code ended the turn with an error (${f.terminal_reason ?? 'unknown'}): ${text}`)
}
