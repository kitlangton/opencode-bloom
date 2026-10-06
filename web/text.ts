// Text rasterized once into a 2048² atlas at exact output pixel size, addressed by uv.
export interface Glyph { uv: [number, number, number, number]; w: number; h: number; ascent: number }

const SIZE = 2048
const FONT = `-apple-system, "SF Pro Display", "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`

export function createAtlas() {
  const canvas = new OffscreenCanvas(SIZE, SIZE)
  const ctx = canvas.getContext("2d")!
  const map = new Map<string, Glyph>()
  let x = 0, y = 0, rowH = 0
  let dirty = false
  function get(text: string, px: number, weight = 500, tracking = 0): Glyph {
    const key = `${text}|${px}|${weight}|${tracking}`
    const hit = map.get(key)
    if (hit) return hit
    ctx.font = `${weight} ${px}px ${FONT}`
    ;(ctx as any).letterSpacing = `${tracking}px`
    const m = ctx.measureText(text)
    const pad = Math.ceil(px * 0.45)
    const w = Math.ceil(m.width) + pad * 2
    const h = Math.ceil(px * 1.35) + pad
    if (x + w > SIZE) { x = 0; y += rowH + 2; rowH = 0 }
    if (y + h > SIZE) throw new Error("text atlas full")
    ctx.textBaseline = "alphabetic"
    const ascent = Math.ceil(px * 0.95) + Math.floor(pad / 2)
    // green channel: a soft shadow (drawn via an offscreen glyph so only its shadow lands);
    // red channel: the fill. "lighter" keeps the channels separable.
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.shadowColor = "#0f0"
    ctx.shadowBlur = Math.max(2, px * 0.28)
    ctx.shadowOffsetX = 4096
    ctx.fillStyle = "#0f0"
    ctx.fillText(text, x + pad - 4096, y + ascent)
    ctx.restore()
    ctx.save()
    ctx.globalCompositeOperation = "lighter"
    ctx.fillStyle = "#f00"
    ctx.fillText(text, x + pad, y + ascent)
    ctx.restore()
    const g: Glyph = { uv: [x / SIZE, y / SIZE, (x + w) / SIZE, (y + h) / SIZE], w, h, ascent }
    // offset so callers position by the text's left edge
    ;(g as any).pad = pad
    map.set(key, g)
    x += w + 2
    rowH = Math.max(rowH, h)
    dirty = true
    return g
  }
  return {
    canvas,
    get,
    pad: (g: Glyph) => (g as any).pad as number,
    takeDirty() { const d = dirty; dirty = false; return d },
  }
}

export type Atlas = ReturnType<typeof createAtlas>
