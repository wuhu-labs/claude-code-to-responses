export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder()
  let parts: string[] = []
  for await (const chunk of stream) {
    const text = dec.decode(chunk, { stream: true })
    let start = 0, end: number
    while ((end = text.indexOf('\n', start)) >= 0) {
      const part = text.slice(start, end)
      const line = parts.length ? [...parts, part].join('') : part
      parts = []
      if (line) yield line
      start = end + 1
    }
    if (start < text.length) parts.push(text.slice(start))
  }
  const tail = dec.decode()
  if (tail) parts.push(tail)
  if (parts.length) yield parts.join('')
}
