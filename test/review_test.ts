// Regression tests for the M1 review findings.
import { assert, assertEquals } from '@std/assert'
import { decodeRecord, encodeRecord } from '../src/records.ts'
import { type Json, text } from './fake.ts'
import { user } from './harness.ts'
import { INSTRUCTIONS, MODEL, Run, TOOLS } from './scenario.ts'

async function post(url: string, body: Json) {
  const res = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.headers.get('content-type')?.includes('event-stream')) {
    await res.body?.cancel()
    return { status: res.status, body: null }
  }
  return { status: res.status, body: await res.json() }
}

Deno.test('a client record whose session is a path is refused before any file is touched', async () => {
  const victim = `/tmp/cc2r-victim-${Date.now()}`
  Deno.mkdirSync(victim, { recursive: true })
  Deno.writeTextFileSync(`${victim}/canary`, 'alive')
  const run = new Run('forged-session', false)
  await run.run(async () => {
    run.fake.reply({ blocks: [text('one')] })
    await run.turn('one')
    const history = structuredClone(run.drv.history)
    const item = history.find((i: Json) => i.type === 'reasoning' && i.encrypted_content?.startsWith('cc2r.record.'))
    const rec = (await decodeRecord(item.encrypted_content))!
    for (const session of [`${'../'.repeat(24)}${victim.slice(1)}`, 'not-a-uuid']) {
      item.encrypted_content = await encodeRecord({ ...rec, session })
      const r = await post(run.tg.url, { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, input: [...history, user('two')] })
      assertEquals([r.status, r.body?.error?.code], [400, 'invalid_provider_record'])
    }
    // other fields that reach paths or the log are checked too
    for (const bad of [{ id: '../x' }, { prev: 'resp_../x' }, { entries: ['{"a":1}\n{"b":2}'] }, { entries: ['not json'] }, { end: 'calls', calls: [] }]) {
      item.encrypted_content = await encodeRecord({ ...rec, ...bad } as Json)
      const r = await post(run.tg.url, { model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, stream: true, input: [...history, user('two')] })
      assertEquals([r.status, r.body?.error?.code], [400, 'invalid_provider_record'], JSON.stringify(bad))
    }
    assertEquals(Deno.readTextFileSync(`${victim}/canary`), 'alive')
  })
  Deno.removeSync(victim, { recursive: true })
})
