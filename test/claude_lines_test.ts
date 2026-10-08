import { assertEquals } from '@std/assert'
import { lines } from '../src/claude/lines.ts'

Deno.test('Claude stdout lines preserve fragmented UTF-8, empty lines and unterminated tails', async () => {
  const text = '\n{"text":"🌍"}\n\nlast 🌏'
  const bytes = new TextEncoder().encode(text)
  let at = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at === bytes.length) c.close()
      else c.enqueue(bytes.subarray(at, ++at))
    },
  })
  const actual: string[] = []
  for await (const line of lines(stream)) actual.push(line)
  assertEquals(actual, ['{"text":"🌍"}', 'last 🌏'])
})

Deno.test('Claude stdout large unterminated fragments join once without rescanning accumulated input', async () => {
  const text = 'x'.repeat(8 * 1024 * 1024)
  const bytes = new TextEncoder().encode(text + '\nnext\n')
  let at = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at === bytes.length) c.close()
      else {
        const end = Math.min(at + 1024, bytes.length)
        c.enqueue(bytes.subarray(at, end))
        at = end
      }
    },
  })
  const actual: string[] = []
  for await (const line of lines(stream)) actual.push(line)
  assertEquals(actual, [text, 'next'])
})
