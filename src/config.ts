// Gateway configuration. Every setting is explicit; a missing or wrong one is an error at startup, never a guess.
import { BACKEND_ENV, CLAUDE_CODE_VERSION } from './claude/pins.ts'

export interface Config {
  /** Address of the Responses API listener. */
  hostname: string
  port: number
  /** Bearer token clients must send; required unless the listener is on loopback. Read from an environment variable. */
  authToken?: string
  /** Loopback port of the MCP and hook endpoint Claude Code calls (0: any free port). */
  bridgePort: number
  /** Gateway state: the response store, Claude Code's config dir and scratch home. */
  stateDir: string
  /** Parent of the per-chain working folders. Must be outside any git repository. */
  /** The one working folder every Claude Code session runs in: the same absolute path everywhere, outside git. */
  workDir: string
  claudeBinary: string
  /** Fixed TZ for every Claude Code process. */
  tz: string
  idleTimeoutMs: number
  holdTimeoutMs: number
  /** Backend variables (base URL, credentials) handed to Claude Code. */
  backendEnv: Record<string, string>
  /** Check after every process exit that its log on disk starts with the stored records, byte for byte. */
  verifyLogs: boolean
  /** How long a stopped model message may wait for its log entries and its turn's result (default 15 s). */
  recordTimeoutMs?: number
  /**
   * The gateway's Claude Code device id, sent in every request's metadata.user_id: from --device-id or
   * CLAUDE_CODE_TO_RESPONSES_DEVICE_ID, else generated once into <state-dir>/device-id. Set by prepare().
   */
  deviceId?: string
}

export const DEVICE_ID_ENV = 'CLAUDE_CODE_TO_RESPONSES_DEVICE_ID'
const DEVICE_ID = /^[0-9a-f]{64}$/

export interface Paths {
  /** Claude Code's config folder, shared by every session: each session's log is projects/<work dir>/<session>.jsonl. */
  configDir: string
  homeDir: string
  runDir: string
}

export function paths(c: Config): Paths {
  return {
    configDir: `${c.stateDir}/claude/config`,
    homeDir: `${c.stateDir}/claude/home`,
    runDir: `${c.stateDir}/run`,
  }
}

export class ConfigError extends Error {}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

const USAGE = `claude-code-to-responses: an OpenAI Responses API (stateful, streaming) in front of Claude Code ${CLAUDE_CODE_VERSION}

Usage: claude-code-to-responses [options]

  --listen <host:port>       Responses API address (default 127.0.0.1:18330)
  --state-dir <dir>          response store, Claude Code config and scratch home (required)
  --work-dir <dir>           the working folder of every session, outside any git repository
                             (default /tmp/claude-code-to-responses; keep it the same on every machine)
  --claude <path>            Claude Code ${CLAUDE_CODE_VERSION} binary (required)
  --auth-token-env <VAR>     clients must send 'Authorization: Bearer <$VAR>'; required off loopback
  --bridge-port <port>       loopback port for Claude Code's MCP and hook calls (default: any free port)
  --tz <zone>                TZ for every Claude Code process (default UTC)
  --idle-timeout <seconds>   kill a process idle at a finished turn after this long (default 1800)
  --hold-timeout <seconds>   kill a process holding tool calls after this long (default 600)
  --device-id <64 hex>       the Claude Code device id sent in metadata.user_id (or CLAUDE_CODE_TO_RESPONSES_DEVICE_ID);
                             default: generated once into <state-dir>/device-id. Give every gateway that should share
                             a backend cache the same one
  --verify-logs              check each exited process's log against the stored records

Backend: ${BACKEND_ENV.join(', ')} are read from the gateway's environment and handed to Claude Code.
With none set, Claude Code uses the login in its own config dir (<state-dir>/claude/config).
`

export function parseArgs(argv: string[], env: Record<string, string | undefined>): Config {
  const opts = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') throw new ConfigError(USAGE)
    if (a === '--verify-logs') {
      flags.add(a)
      continue
    }
    if (
      !['--listen', '--auth-token-env', '--device-id', '--bridge-port', '--state-dir', '--work-dir', '--claude', '--tz', '--idle-timeout', '--hold-timeout']
        .includes(a)
    ) {
      throw new ConfigError(`unknown option ${a}\n\n${USAGE}`)
    }
    const v = argv[++i]
    if (v === undefined) throw new ConfigError(`${a} needs a value`)
    opts.set(a, v)
  }
  const need = (k: string) => {
    const v = opts.get(k)
    if (!v) throw new ConfigError(`${k} is required\n\n${USAGE}`)
    return v
  }
  const listen = opts.get('--listen') ?? '127.0.0.1:18330'
  const m = /^(.+):(\d+)$/.exec(listen)
  if (!m) throw new ConfigError(`--listen must be host:port, got ${listen}`)
  const secs = (k: string, d: number) => {
    const v = opts.get(k)
    if (v === undefined) return d * 1000
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${k} must be a positive number of seconds`)
    return n * 1000
  }
  let authToken: string | undefined
  const tokenVar = opts.get('--auth-token-env')
  if (tokenVar !== undefined) {
    authToken = env[tokenVar]
    if (!authToken) throw new ConfigError(`--auth-token-env ${tokenVar}: the variable is not set or empty`)
  }
  if (!isLoopback(m[1]) && !authToken) {
    throw new ConfigError(`--listen ${listen} is reachable beyond this machine: configure a token with --auth-token-env, or listen on loopback`)
  }
  const deviceId = opts.get('--device-id') ?? env[DEVICE_ID_ENV]
  if (deviceId !== undefined && !DEVICE_ID.test(deviceId)) {
    throw new ConfigError(`the device id must be 64 lowercase hex digits (from --device-id or ${DEVICE_ID_ENV})`)
  }
  const backendEnv: Record<string, string> = {}
  for (const k of BACKEND_ENV) {
    const v = env[k]
    if (v !== undefined && v !== '') backendEnv[k] = v
  }
  return {
    hostname: m[1],
    port: Number(m[2]),
    authToken,
    deviceId,
    bridgePort: Number(opts.get('--bridge-port') ?? 0),
    stateDir: need('--state-dir'),
    workDir: opts.get('--work-dir') ?? '/tmp/claude-code-to-responses',
    claudeBinary: need('--claude'),
    tz: opts.get('--tz') ?? 'UTC',
    idleTimeoutMs: secs('--idle-timeout', 1800),
    holdTimeoutMs: secs('--hold-timeout', 600),
    backendEnv,
    verifyLogs: flags.has('--verify-logs'),
  }
}

/** Resolves folders to real paths and checks the work root is outside git (a git folder changes Claude Code's prompt). */
/** The real path a folder has or will have: its deepest existing ancestor resolved, the rest appended. */
function realTarget(path: string): string {
  const abs = path.startsWith('/') ? path : `${Deno.cwd()}/${path}`
  const parts = abs.split('/').filter((x) => x && x !== '.')
  const rest: string[] = []
  while (true) {
    const cur = '/' + parts.join('/')
    try {
      return [Deno.realPathSync(cur), ...rest].join('/').replace(/\/+/g, '/')
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound) || parts.length === 0) throw e
      rest.unshift(parts.pop()!)
    }
  }
}

/** The repository a folder is in, if any: a folder that does not exist yet can only be in its ancestors' one. */
function gitRootOf(path: string): string | null {
  for (let d = path;; d = d.replace(/\/[^/]+$/, '') || '/') {
    try {
      Deno.statSync(`${d}/.git`)
      return d
    } catch { /* not here */ }
    if (d === '/') return null
  }
}

/** Checks every setting first, then creates the folders (owner-only) and resolves them to real paths. */
export function prepare(c: Config): Config {
  const target = realTarget(c.workDir)
  const repo = gitRootOf(target)
  if (repo !== null) {
    throw new ConfigError(
      `--work-dir ${target} is inside the git repository at ${repo}; Claude Code would announce it in every prompt. Use a folder outside git.`,
    )
  }
  // the state holds every conversation (records, logs) and the backend's credentials: owner-only, whatever the umask
  Deno.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 })
  Deno.mkdirSync(c.workDir, { recursive: true, mode: 0o700 })
  const stateDir = Deno.realPathSync(c.stateDir)
  const workDir = Deno.realPathSync(c.workDir)
  Deno.chmodSync(stateDir, 0o700)
  Deno.chmodSync(workDir, 0o700)
  const p = paths({ ...c, stateDir })
  for (const d of [p.configDir, p.homeDir, p.runDir]) Deno.mkdirSync(d, { recursive: true, mode: 0o700 })
  return { ...c, stateDir, workDir, deviceId: c.deviceId ?? stateDeviceId(stateDir) }
}

/** The device id generated on this state dir's first start and kept in <state-dir>/device-id. */
function stateDeviceId(stateDir: string): string {
  const path = `${stateDir}/device-id`
  try {
    const id = Deno.readTextFileSync(path).trim()
    if (!DEVICE_ID.test(id)) throw new ConfigError(`${path} does not hold a device id (64 lowercase hex digits)`)
    return id
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  const id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  Deno.writeTextFileSync(path, id + '\n', { mode: 0o600 })
  return id
}
