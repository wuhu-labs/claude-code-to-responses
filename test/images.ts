// A real one-pixel PNG, shared by the gateway matrix and the appended-log probe.
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII='
export const IMAGE = { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }
export const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }

/** Deterministic 450x450 RGB noise PNG, 810,940 base64 characters: exercises native MCP image-size annotations. */
export async function noisePng(): Promise<string> {
  const crc32 = (bytes: Uint8Array): number => {
    let c = ~0
    for (const b of bytes) {
      c ^= b
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, bytes: Uint8Array): Uint8Array => {
    const name = new TextEncoder().encode(type), out = new Uint8Array(12 + bytes.length)
    new DataView(out.buffer).setUint32(0, bytes.length)
    out.set(name, 4)
    out.set(bytes, 8)
    new DataView(out.buffer).setUint32(8 + bytes.length, crc32(out.subarray(4, 8 + bytes.length)))
    return out
  }
  const width = 450, height = 450, raw = new Uint8Array(height * (1 + width * 3))
  let seed = 123456789
  for (let i = 0; i < raw.length; i++) {
    if (i % (1 + width * 3) === 0) continue
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    raw[i] = (seed >>> 24) & 0xff
  }
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array())])
  let binary = ''
  for (const byte of png) binary += String.fromCharCode(byte)
  return btoa(binary)
}
