// A real one-pixel PNG, shared by the gateway matrix and the appended-log probe.
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII='
export const IMAGE = { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }
export const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
