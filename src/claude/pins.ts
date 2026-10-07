// Every Claude Code flag and environment variable the gateway relies on, in one place.
// README.md documents each with the version it was measured on; probe/probe_test.ts asserts each.

/** The only Claude Code version these pins were measured on. Any other version is refused. */
export const CLAUDE_CODE_VERSION = '2.1.284'

/** MCP server name; the model sees each client tool as `mcp__fn__<name>`. */
export const MCP_SERVER = 'fn'
export const MCP_PREFIX = `mcp__${MCP_SERVER}__`

/** Anthropic tool names are at most 64 characters, so client tool names get what the prefix leaves. */
export const MAX_TOOL_NAME = 64 - MCP_PREFIX.length

/** Claude Code's ceiling for a per-tool `anthropic/maxResultSizeChars` (2.1.284: rxe=500000).
 * Results up to this many characters stay inline; the gateway refuses longer ones. */
export const MAX_RESULT_CHARS = 500_000

/** MCP server timeout in ms: the maximum Claude Code accepts (clamped to 2^31-1). Holds end by eviction, never by this. */
export const MCP_TIMEOUT_MS = 2_147_483_647

/** MAX_MCP_OUTPUT_TOKENS, raised so Claude Code never truncates a result the gateway accepted. */
export const MAX_MCP_OUTPUT_TOKENS = '1000000'

/** The user text the gateway writes after tool results on the interrupted-turn resume when no notice came with them. */
export const RESUME_LINE = 'Continue from where you left off.'

export interface LaunchSpec {
  binary: string
  sessionId: string
  resume: boolean
  model: string
  effort: string
  instructions: string
  workDir: string
  configDir: string
  homeDir: string
  tz: string
  settingsPath: string
  mcpConfigPath: string
  /** Resume a turn interrupted during a held call (the log ends with tool results + a user text). */
  interruptedTurn: boolean
  /** Backend variables handed through from the gateway's own environment (base URL, credentials). */
  backendEnv: Record<string, string>
}

export function launchArgs(s: LaunchSpec): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-mirror',
    '--include-partial-messages',
    '--model',
    s.model,
    '--effort',
    s.effort,
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    '--settings',
    s.settingsPath,
    '--strict-mcp-config',
    '--mcp-config',
    s.mcpConfigPath,
    '--system-prompt',
    s.instructions,
    s.resume ? '--resume' : '--session-id',
    s.sessionId,
  ]
}

export function launchEnv(s: LaunchSpec): Record<string, string> {
  return {
    HOME: s.homeDir,
    CLAUDE_CONFIG_DIR: s.configDir,
    TZ: s.tz,
    PATH: '/usr/bin:/bin',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_TOOL_SEARCH: 'false',
    DISABLE_AUTO_COMPACT: '1',
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
    CLAUDE_CODE_SILENT_TURN_REMINDER: '0',
    MAX_MCP_OUTPUT_TOKENS,
    CLAUDE_CODE_MAX_RETRIES: '0',
    ...(s.interruptedTurn ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' } : {}),
    ...s.backendEnv,
  }
}

/** The backend variables the gateway passes through from its own environment, and nothing else. */
export const BACKEND_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

export function settingsJson(hookUrl: string, bearer: string) {
  const hook = [{ hooks: [{ type: 'http', url: hookUrl, headers: { Authorization: `Bearer ${bearer}` }, timeout: 600 }] }]
  return {
    hooks: { PostToolUse: hook, PostToolUseFailure: hook, Stop: hook },
    permissions: { allow: [`mcp__${MCP_SERVER}`] },
  }
}

export function mcpConfigJson(mcpUrl: string, bearer: string) {
  return {
    mcpServers: {
      [MCP_SERVER]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${bearer}` }, timeout: MCP_TIMEOUT_MS },
    },
  }
}

/** The folder Claude Code keeps a working directory's session logs in. */
export function projectDir(configDir: string, workDir: string): string {
  return `${configDir}/projects/${workDir.replace(/[^a-zA-Z0-9]/g, '-')}`
}

export function logPath(configDir: string, workDir: string, sessionId: string): string {
  return `${projectDir(configDir, workDir)}/${sessionId}.jsonl`
}

/** Effort names the gateway accepts in `reasoning.effort`, mapped to `--effort`. */
export const EFFORTS: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
export const DEFAULT_EFFORT = 'high'
