// The Claude lane's wire messages are the base's, byte for byte. This one names the response whose provider record
// a full history could not read; it is easy to lose by accident when the two lanes share their history matching.
import { assertEquals } from '@std/assert'
import { user } from './harness.ts'
import { Run } from './scenario.ts'

Deno.test('a malformed second record answers with the base message, the response ordinal included', async () => {
  const run = new Run('claude-record-message', true, { mode: 'history' })
  await run.run(async () => {
    await run.turn('one')
    await run.turn('two')
    const records = run.drv.history.filter((item: any) => item.type === 'reasoning' && item.encrypted_content?.startsWith('cc2r.record.v1.'))
    assertEquals(records.length, 2, 'the history carries both provider records')
    const broken = records[1]
    broken.encrypted_content = `${broken.encrypted_content.slice(0, -8)}AAAAAAAA`
    const error = await run.drv.send([user('three')]).then(() => null, (e: { error?: { message: string; code: string } }) => e.error)
    assertEquals(error?.code, 'invalid_provider_record')
    assertEquals(error?.message, 'The provider record of response 2 in the history is malformed: not valid gzip+base64 JSON.')
  })
})
