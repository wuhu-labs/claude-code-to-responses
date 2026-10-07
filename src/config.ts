// Gateway configuration. Every setting is explicit; a missing or wrong one is an error at startup, never a guess.
import { BACKEND_ENV, CLAUDE_CODE_VERSION } from './claude/pins.ts'

export interface Config {
  /** Address of the Responses API listener. */
  hostname: string
  port: number
  /** Loopback port of the MCP and hook endpoint Claude Code calls (0: any free port). */
  bridgePort: number
  /** Gateway state: the response store, Claude Code's config dir and scratch home. */
  stateDir: string
  /** Parent of the per-chain working folders. Must be outside any git repository. */
  workRoot: string
  claudeBinary: string
  /** Fixed TZ for every Claude Code process. */
  tz: string
  idleTimeoutMs: number
  holdTimeoutMs: number
  /** Backend variables (base URL, credentials) handed to Claude Code. */
  backendEnv: Record<string, string>
  /** Check after every process exit that its log on disk starts with the stored records, byte for byte. */
  verifyLogs: boolean
}

export interface Paths {
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

const USAGE = `claude-code-to-responses: an OpenAI Responses API (stateful, streaming) in front of Claude Code ${CLAUDE_CODE_VERSION}

Usage: claude-code-to-responses [options]

  --listen <host:port>       Responses API address (default 127.0.0.1:18330)
  --state-dir <dir>          response store, Claude Code config and scratch home (required)
  --work-root <dir>          parent of the per-chain working folders, outside any git repository (required)
  --claude <path>            Claude Code ${CLAUDE_CODE_VERSION} binary (required)
  --bridge-port <port>       loopback port for Claude Code's MCP and hook calls (default: any free port)
  --tz <zone>                TZ for every Claude Code process (default UTC)
  --idle-timeout <seconds>   kill a process idle at a finished turn after this long (default 1800)
  --hold-timeout <seconds>   kill a process holding tool calls after this long (default 600)
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
    if (!['--listen', '--bridge-port', '--state-dir', '--work-root', '--claude', '--tz', '--idle-timeout', '--hold-timeout'].includes(a)) {
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
  const backendEnv: Record<string, string> = {}
  for (const k of BACKEND_ENV) {
    const v = env[k]
    if (v !== undefined && v !== '') backendEnv[k] = v
  }
  return {
    hostname: m[1],
    port: Number(m[2]),
    bridgePort: Number(opts.get('--bridge-port') ?? 0),
    stateDir: need('--state-dir'),
    workRoot: need('--work-root'),
    claudeBinary: need('--claude'),
    tz: opts.get('--tz') ?? 'UTC',
    idleTimeoutMs: secs('--idle-timeout', 1800),
    holdTimeoutMs: secs('--hold-timeout', 600),
    backendEnv,
    verifyLogs: flags.has('--verify-logs'),
  }
}

/** Resolves folders to real paths and checks the work root is outside git (a git folder changes Claude Code's prompt). */
export function prepare(c: Config): Config {
  Deno.mkdirSync(c.stateDir, { recursive: true })
  Deno.mkdirSync(c.workRoot, { recursive: true })
  const stateDir = Deno.realPathSync(c.stateDir)
  const workRoot = Deno.realPathSync(c.workRoot)
  for (let d = workRoot;; d = d.replace(/\/[^/]+$/, '') || '/') {
    try {
      Deno.statSync(`${d}/.git`)
      throw new ConfigError(
        `--work-root ${workRoot} is inside the git repository at ${d}; Claude Code would announce it in every prompt. Use a folder outside git.`,
      )
    } catch (e) {
      if (e instanceof ConfigError) throw e
    }
    if (d === '/') break
  }
  const p = paths({ ...c, stateDir })
  for (const d of [p.configDir, p.homeDir, p.runDir]) Deno.mkdirSync(d, { recursive: true })
  return { ...c, stateDir, workRoot }
}
