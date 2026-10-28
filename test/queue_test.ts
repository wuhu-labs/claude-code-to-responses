import { assertEquals } from '@std/assert'
import type { Bridge } from '../src/bridge.ts'
import type { ClaudeProcess } from '../src/claude/process.ts'
import type { Config } from '../src/config.ts'
import type { GatewayError } from '../src/errors.ts'
import { Lane } from '../src/lane.ts'
import { ResponseStore } from '../src/store.ts'

function fixture(write: () => Promise<void> = () => Promise.resolve()) {
  const root = Deno.makeTempDirSync({ prefix: 'cc2r-queue-unit-' })
  const errors: string[] = []
  const lane = new Lane(
    'session',
    root,
    { key: 'chain', model: 'model', effort: 'high', instructions: 'test', maxOutputTokens: null, tools: [] },
    null,
    { stateDir: root } as Config,
    { unregister() {} } as unknown as Bridge,
    new ResponseStore(root),
    { failure() {}, note() {}, dead() {}, gone() {}, usage() {} },
  )
  lane.proc = { write, kill: () => Promise.resolve() } as unknown as ClaudeProcess
  lane.fail = (error: GatewayError) => {
    errors.push(error.code)
  }
  const internals = lane as unknown as { learn(id: string): void; mirror(e: unknown): void }
  internals.learn('toolu_test')
  return {
    lane,
    errors,
    internals,
    async close() {
      await lane.kill('test')
      Deno.removeSync(root, { recursive: true })
    },
  }
}

Deno.test('queue: results remain unpublished for a racing tool until the mirrored enqueue', async () => {
  const f = fixture()
  try {
    const release = f.lane.release(new Map([['toolu_test', [{ type: 'text' as const, text: 'RESULT' }]]]), [{ type: 'text', text: 'NOTICE' }])
    let answered = false
    const tool = f.lane.toolCall('toolu_test', 'echo', {}, new AbortController().signal).then((r) => {
      answered = true
      return r
    })
    await Promise.resolve()
    assertEquals(answered, false)
    f.internals.mirror({ type: 'queue-operation', operation: 'dequeue' })
    await Promise.resolve()
    assertEquals(answered, false)
    f.internals.mirror({ type: 'queue-operation', operation: 'enqueue' })
    await release
    assertEquals((await tool).content, [{ type: 'text', text: 'RESULT' }])
    assertEquals(f.errors, [])
  } finally {
    await f.close()
  }
})

Deno.test('queue: a second unacknowledged write fails instead of racing or falling back', async () => {
  let writes = 0
  const f = fixture(() => {
    writes++
    return Promise.resolve()
  })
  try {
    const first = f.lane.release(new Map(), [{ type: 'text', text: 'ONE' }])
    await f.lane.release(new Map(), [{ type: 'text', text: 'TWO' }])
    await first
    assertEquals(writes, 1)
    assertEquals(f.lane.dead, true)
    assertEquals(f.errors.every((code) => code === 'notice_undelivered'), true)
  } finally {
    await f.close()
  }
})

Deno.test('queue: missing ack is bounded, typed and kills the lane without publishing results', async () => {
  const f = fixture()
  try {
    await f.lane.release(new Map(), [{ type: 'text', text: 'NOTICE' }])
    assertEquals(f.errors, ['notice_undelivered'])
    assertEquals(f.lane.dead, true)
  } finally {
    await f.close()
  }
})

Deno.test('queue: a broken stdin is typed and kills the lane, with no hook delivery', async () => {
  const f = fixture(() => Promise.reject(new Error('broken pipe')))
  try {
    await f.lane.release(new Map(), [{ type: 'text', text: 'NOTICE' }])
    assertEquals(f.errors, ['claude_code_stdin'])
    assertEquals(f.lane.dead, true)
  } finally {
    await f.close()
  }
})
