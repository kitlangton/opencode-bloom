// Turns simulation state into screen-space quads: camera, bodies, light, type.
import { FLOATS } from "./shaders"
import { MAX_QUADS, MAX_OVERLAY } from "./gpu"
import { COOL, KIT, STEP, arc, rng, type RGB, type Sim } from "./sim"
import { Clock, Counter, type Column } from "./rolling"
import { Sky } from "./sky"
import type { Atlas } from "./text"

const GLOW = 10, DISC = 1, RING = 2, LINE = 3, TEXT = 4, SOFT = 15, ADD_DISC = 11, ADD_RING = 12, ADD_LINE = 13, ORB = 6, FLARE = 17

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k]
const WHITE: RGB = [1, 1, 1]
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
// minimum-jerk travel: continuous velocity and acceleration at both ends
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

export class Camera {
  x = 0; y = 0; vx = 0; vy = 0
  lz = 0; vz = 0
  primed = false

  constructor(readonly width: number, readonly height: number, readonly unit: number) {}

  private fit(sim: Sim, outro: boolean) {
    let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    let activeCount = 0
    for (const n of sim.nodes) {
      if (!n.alive) continue
      const pad = n.r + 26
      bx0 = Math.min(bx0, n.x - pad); by0 = Math.min(by0, n.y - pad)
      bx1 = Math.max(bx1, n.x + pad); by1 = Math.max(by1, n.y + pad)
      const recent = sim.time - n.lastActive < 5 || sim.time - n.born < 2
      if (recent) {
        activeCount++
        ax0 = Math.min(ax0, n.x - pad); ay0 = Math.min(ay0, n.y - pad)
        ax1 = Math.max(ax1, n.x + pad); ay1 = Math.max(ay1, n.y + pad)
      }
    }
    for (const h of sim.hubs) {
      if (!h.alive) continue
      bx0 = Math.min(bx0, h.x - 60); by0 = Math.min(by0, h.y - 30)
      bx1 = Math.max(bx1, h.x + 60); by1 = Math.max(by1, h.y + 30)
    }
    if (!isFinite(bx0)) return null
    let x0 = bx0, y0 = by0, x1 = bx1, y1 = by1
    if (activeCount && !outro) {
      const k = 0.4 // keep the whole city partly in mind so the camera doesn't lurch
      x0 = ax0 + (bx0 - ax0) * k; y0 = ay0 + (by0 - ay0) * k
      x1 = ax1 + (bx1 - ax1) * k; y1 = ay1 + (by1 - ay1) * k
    }
    // A camera moment pulls the frame in around the burst: the parent and its children.
    const { e, m } = sim.moment()
    if (m && e > 0 && !outro) {
      const p = sim.nodes[m.parent]!
      let fx0 = p.x - 110, fy0 = p.y - 80, fx1 = p.x + 110, fy1 = p.y + 80
      for (const n of sim.nodes) {
        // only the children of this burst, not every subagent the parent ever had
        if (!n.alive || n.parent !== m.parent || n.born < m.at - 1.5) continue
        fx0 = Math.min(fx0, n.x - 50); fy0 = Math.min(fy0, n.y - 50)
        fx1 = Math.max(fx1, n.x + 50); fy1 = Math.max(fy1, n.y + 50)
      }
      const k = e * 0.85
      x0 += (fx0 - x0) * k; y0 += (fy0 - y0) * k; x1 += (fx1 - x1) * k; y1 += (fy1 - y1) * k
    }
    return { x0, y0, x1, y1 }
  }

  update(sim: Sim, dt: number) {
    const outro = sim.time > sim.warp.end
    const box = this.fit(sim, outro)
    if (!box) return
    const W = this.width, H = this.height, u = this.unit
    const mx = W * 0.09, mt = H * (outro ? 0.14 : 0.17), mb = H * (outro ? 0.17 : 0.09)
    const cx = (box.x0 + box.x1) / 2
    const cy = (box.y0 + box.y1) / 2
    const bw = Math.max(240, box.x1 - box.x0), bh = Math.max(200, box.y1 - box.y0)
    const z = Math.min((W - 2 * mx) / (bw * u), (H - mt - mb) / (bh * u))
    let tz = Math.log(Math.min(1.9, Math.max(0.12, z)))
    // anticipation: the camera eases back a touch just before it pushes in
    for (const m of sim.moments) {
      const d = (sim.time - (m.at - 2.3)) / 0.45
      tz -= 0.07 * Math.exp(-d * d)
    }
    // shift target so the box centers in the area between header and legend
    const ty = cy - ((mt - mb) / 2) / (Math.exp(this.lz) * u)
    if (!this.primed) {
      this.primed = true
      this.x = cx; this.y = ty; this.lz = tz
    }
    const steps = Math.round(dt / STEP)
    const me = sim.moment().e
    const wc = outro ? 1.1 : 1.5 + 0.5 * me, wz = outro ? 0.9 : 1.1 + 0.5 * me
    for (let i = 0; i < steps; i++) {
      this.vx += (-(this.x - cx) * wc * wc - 2 * wc * this.vx) * STEP
      this.vy += (-(this.y - ty) * wc * wc - 2 * wc * this.vy) * STEP
      this.vz += (-(this.lz - tz) * wz * wz - 2 * wz * this.vz) * STEP
      this.x += this.vx * STEP; this.y += this.vy * STEP; this.lz += this.vz * STEP
    }
  }

  get zoom() { return Math.exp(this.lz) }
}

export interface SceneOptions { titles: boolean; dateLabel: (ms: number) => string; timeLabel: (ms: number) => string; hourOf: (ms: number) => number }

export function createScene(width: number, height: number, atlas: Atlas, opts: SceneOptions) {
  const unit = height / 1080 // resolution scale; layout is authored at 1080 p
  const u = Math.min(width, height) / 1080
  const data = new Float32Array(MAX_QUADS * FLOATS)
  const overData = new Float32Array(MAX_OVERLAY * FLOATS)
  const bufs = [data, overData], caps = [MAX_QUADS, MAX_OVERLAY], counts = [0, 0]
  let layer = 0 // 0: world (bloomed), 1: overlay (crisp, after tonemap)
  const cam = new Camera(width, height, u)
  const labels: { x: number; y: number; a: number; side: number }[] = []

  const push = (x0: number, y0: number, x1: number, y1: number, size: number, thick: number, kind: number, endAlpha: number, c: RGB, a: number, uv?: [number, number, number, number]) => {
    if (counts[layer]! >= caps[layer]! || Math.abs(a) <= 0.002) return
    const data = bufs[layer]!
    const b = counts[layer]!++ * FLOATS
    data[b] = x0; data[b + 1] = y0; data[b + 2] = x1; data[b + 3] = y1
    data[b + 4] = size; data[b + 5] = thick; data[b + 6] = kind; data[b + 7] = endAlpha
    data[b + 8] = c[0]; data[b + 9] = c[1]; data[b + 10] = c[2]; data[b + 11] = Math.max(-64, Math.min(a, 64))
    if (uv) { data[b + 12] = uv[0]; data[b + 13] = uv[1]; data[b + 14] = uv[2]; data[b + 15] = uv[3] }
    else { data[b + 12] = 0; data[b + 13] = 0; data[b + 14] = 0; data[b + 15] = 0 }
  }
  const glow = (x: number, y: number, r: number, c: RGB, a: number) => push(x, y, 0, 0, r, 0, GLOW, 1, c, a)
  const disc = (x: number, y: number, r: number, c: RGB, a: number, additive = false) => push(x, y, 0, 0, r, 0, additive ? ADD_DISC : DISC, 1, c, a)
  const ring = (x: number, y: number, r: number, w: number, c: RGB, a: number, additive = true) => push(x, y, 0, 0, r, w, additive ? ADD_RING : RING, 1, c, a)
  const line = (x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a: number, endAlpha = 1, additive = false) => push(x0, y0, x1, y1, w, 0, additive ? ADD_LINE : LINE, endAlpha, c, a)
  const orb = (x: number, y: number, r: number, c: RGB, core: number) => push(x, y, 0, 0, r, core, ORB, 1, c, 1)
  const flare = (x: number, y: number, len: number, w: number, c: RGB, a: number) => push(x, y, 0, 0, len, w, FLARE, 1, c, a)
  const soft = (x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a: number, endAlpha = 1) => push(x0, y0, x1, y1, w, 0, SOFT, endAlpha, c, a)
  // Moving labels stay unsnapped so they glide; fixed UI snaps to whole pixels for crispness.
  const text = (s: string, x: number, y: number, px: number, c: RGB, a: number, opts: { weight?: number; align?: "left" | "right" | "center"; tracking?: number; snap?: boolean; clip?: [number, number, number]; shadow?: boolean } = {}) => {
    const g = atlas.get(s, Math.round(px), opts.weight ?? 500, opts.tracking ?? 0)
    const pad = atlas.pad(g)
    let left = x - pad
    const inner = g.w - pad * 2
    if (opts.align === "right") left -= inner
    else if (opts.align === "center") left -= inner / 2
    let top = y - g.ascent
    if (opts.snap) { top = Math.round(top); left = Math.round(left) }
    const cl = opts.clip
    // a negative alpha tells the shader to skip the soft shadow
    push(left, top, left + g.w, top + g.h, cl ? cl[0] : 0, cl ? cl[1] : 0, TEXT, cl ? cl[2] : 0, c, opts.shadow === false ? -a : a, g.uv)
    return inner
  }

  // Three star layers at different depths: dust far away, a mid field, and a few near
  // bright stars that parallax most and carry small flares.
  type Star = { x: number; y: number; s: number; tw: number; ph: number; c: RGB; depth: number }
  const stars: Star[] = []
  {
    const r = rng(42)
    const tint = (): RGB => { const w = r(); return w < 0.2 ? [1, 0.85, 0.7] : w < 0.5 ? [0.7, 0.8, 1] : [0.9, 0.92, 1] }
    for (let i = 0; i < 900; i++) stars.push({ x: r(), y: r(), s: Math.pow(r(), 4) * 0.5, tw: 0.2 + r() * 0.8, ph: r() * 6.28, c: tint(), depth: 0.015 })
    for (let i = 0; i < 260; i++) stars.push({ x: r(), y: r(), s: 0.2 + Math.pow(r(), 3) * 0.6, tw: 0.2 + r() * 0.8, ph: r() * 6.28, c: tint(), depth: 0.05 })
    for (let i = 0; i < 26; i++) stars.push({ x: r(), y: r(), s: 0.75 + r() * 0.25, tw: 0.15 + r() * 0.3, ph: r() * 6.28, c: tint(), depth: 0.11 })
  }

  const sky = new Sky()
  const clock = new Clock()
  const counters = [
    { label: "SESSIONS", key: "sessions" as const, c: new Counter(0.5, 0.06) },
    { label: "SUBAGENTS", key: "subagents" as const, c: new Counter(0.5, 0.06) },
    { label: "MESSAGES", key: "messages" as const, c: new Counter(0.5, 0.06) },
  ]
  let spun = false
  let lastRead = -1
  let shutter = 1 / 120
  const hud = { rect: [0, 0, 340 * unit, 200 * unit] as [number, number, number, number] }
  const cooled = (n: { lastActive: number }) => clamp01((sim0!.time - n.lastActive - 6) / 10)
  let sim0: Sim | null = null

  // One reel column: faces clipped to a window one row tall with soft top and bottom
  // edges, and a vertical smear that fades in with speed.
  function reel(col: Column, x: number, baseline: number, px: number, color: RGB, alpha: number, weight: number) {
    const row = px * 1.2
    const top = baseline - px * 0.98, bottom = top + row
    const fade = px * 0.14
    const rise = col.rise * row
    // Honest motion blur: each face is averaged over the shutter (half a frame) of its own
    // travel, so a slow carry stays crisp and a racing ones-reel softens into a column.
    const travel = Math.min(1.6, Math.abs(col.velocity) * shutter)
    const taps = travel > 0.04 ? 9 : 1
    for (const g of col.glyphs) {
      const y = baseline + g.dy * row + rise
      const a = (alpha * col.opacity) / taps
      for (let k = 0; k < taps; k++) {
        const off = taps === 1 ? 0 : ((k + 0.5) / taps - 0.5) * travel * row
        text(g.text, x, y + off, px, color, a, { weight, align: "center", clip: [top, bottom, fade], snap: taps === 1 && Math.abs(g.dy) < 1e-4, shadow: taps === 1 })
      }
    }
  }

  function drawHud(sim: Sim, dt: number) {
    shutter = dt * 0.5
    const t = sim.time
    const real = sim.realTime
    const L = 56 * unit, T = 64 * unit
    const ui = clamp01((t - 0.1) / 0.8)
    const [hh, mm] = opts.timeLabel(real).split(":").map(Number) as [number, number]
    clock.set(t, hh, mm)
    // counters take a new reading ten times a second: a steady odometer cadence
    if (t - lastRead >= 0.1 || t > sim.warp.end) { lastRead = t; for (const k of counters) k.c.set(t, sim.counts[k.key]) }

    text(opts.dateLabel(real), L, T, 15 * unit, [0.8, 0.84, 0.95], 0.55 * ui, { weight: 500, tracking: 1.2 * unit, snap: true })
    const px = 40 * unit
    const adv = digitAdvance(px, 300)
    const ink: RGB = [0.93, 0.95, 1]
    const base = T + 44 * unit
    const cw = clock.hour.sample(t)
    reel({ x: 0, glyphs: cw.glyphs, smear: cw.smear, opacity: 1, rise: 0, velocity: cw.velocity }, L + adv, base, px, ink, 0.92 * ui, 300)
    text(":", L + adv * 2.21, base, px, ink, 0.92 * ui, { weight: 300, align: "center", snap: true })
    const tw = clock.tens.sample(t), ow = clock.ones.sample(t)
    reel({ x: 0, glyphs: tw.glyphs, smear: tw.smear, opacity: 1, rise: 0, velocity: tw.velocity }, L + adv * 2.92, base, px, ink, 0.92 * ui, 300)
    reel({ x: 0, glyphs: ow.glyphs, smear: ow.smear, opacity: 1, rise: 0, velocity: ow.velocity }, L + adv * 3.92, base, px, ink, 0.92 * ui, 300)

    // Counters sit under the clock; in the end card they glide to a centered row and grow.
    const endAt = sim.warp.end + 0.25
    const e = smoother(clamp01((t - endAt) / 1.3))
    if (!spun && t >= endAt + 0.9) {
      spun = true
      counters.forEach((k, i) => k.c.spin(t + i * 0.12, 1.6, 0.07))
    }
    const cpx = (19 + 15 * e) * unit
    const lpx = (10 + 2 * e) * unit
    const cadv = digitAdvance(cpx, 400)
    const gapSmall = 30 * unit, gapBig = 70 * unit
    const widths = counters.map((k) => Math.max(k.c.width(t) * cadv, measure(k.label, lpx, 600, 1.4 * unit)))
    const gap = gapSmall + (gapBig - gapSmall) * e
    const rowW = widths.reduce((a, b) => a + b, 0) + gap * (counters.length - 1)
    const x0a = L, y0a = T + 100 * unit
    const x0b = (width - rowW) / 2, y0b = height - 92 * unit
    let x = x0a + (x0b - x0a) * e
    const y = y0a + (y0b - y0a) * e
    hud.rect = [0, 0, Math.max(L + adv * 5, x0a + rowW) + 20 * unit, y0a + 30 * unit]
    const ca = 0.85 * clamp01((t - 0.6) / 0.8)
    counters.forEach((k, i) => {
      const { columns, commas } = k.c.sample(t)
      for (const col of columns) reel(col, x + (col.x + 0.5) * cadv, y, cpx, ink, ca, 400)
      for (const cm of commas) text(",", x + cm.x * cadv, y, cpx, ink, ca * cm.opacity, { weight: 400, align: "center" })
      text(k.label, x, y + (16 + 8 * e) * unit, lpx, [0.72, 0.77, 0.9], 0.5 * ca, { weight: 600, tracking: 1.4 * unit })
      x += widths[i]! + gap
    })
  }

  // A travelling head: a tapering run of glows along the path behind it.
  function cometHead(at: (s: number) => [number, number], hp: number, c: RGB, k: number, spread: number) {
    const S = u
    const TAIL = 12
    for (let i = 0; i < TAIL; i++) {
      const p = at(Math.max(0, hp - (i / TAIL) * spread))
      const f = 1 - i / TAIL
      glow(p[0], p[1], (3 + 6 * f) * S, c, 0.38 * k * f * f)
    }
    const p = at(hp)
    disc(p[0], p[1], 1.8 * S, mix(c, WHITE, 0.55), 1.3 * k, true)
  }

  function digitAdvance(px: number, weight: number) {
    let m = 0
    for (const d of "0123456789") m = Math.max(m, measure(d, px, weight, 0))
    return m
  }

  function build(sim: Sim, frameDt: number) {
    sim0 = sim
    counts[0] = 0; counts[1] = 0; layer = 0
    cam.update(sim, frameDt)
    const z = cam.zoom
    const S = u
    const ox = width / 2, oy = height / 2
    const sx = (x: number) => (x - cam.x) * z * S + ox
    const sy = (y: number) => (y - cam.y) * z * S + oy
    const bodyScale = Math.pow(z, 0.72) * S
    const t = sim.time
    const intro = clamp01((t - 0.15) / 1.2)
    const skyState = sky.update(opts.hourOf(sim.realTime), frameDt)

    // stars
    for (const st of stars) {
      const parX = cam.x * z * S * st.depth, parY = cam.y * z * S * st.depth
      const x = ((st.x * width - parX) % width + width) % width
      const y = ((st.y * height - parY) % height + height) % height
      const tw = 0.65 + 0.35 * Math.sin(t * st.tw * 1.3 + st.ph)
      // day washes out the faint layers first; the near bright stars hold on longest
      const vis = clamp01(skyState.stars * (1.25 + st.depth * 6) - st.depth * 0.5)
      const a = (0.1 + st.s * 0.6) * tw * intro * vis
      disc(x, y, (0.45 + st.s * 1.0) * S, st.c, a, true)
      if (st.s > 0.5) glow(x, y, 7 * S * st.s, st.c, a * 0.14)
      if (st.depth > 0.1) flare(x, y, 9 * S, 0.45 * S, st.c, a * 0.35)
    }

    const nodes = sim.nodes, hubs = sim.hubs
    const act = (n: { lastActive: number; energy: number }) => clamp01(Math.exp(-(t - n.lastActive) / 3.5) * 0.6 + Math.min(1, n.energy) * 0.6)

    // nebula tint: a broad, faint haze of each active project's color around its sessions
    for (let i = 0; i < hubs.length; i++) {
      const h = hubs[i]!
      if (!h.alive) continue
      const heat = clamp01(h.heat * 0.8 + Math.exp(-(t - h.lastActive) / 6) * 0.4)
      if (heat < 0.02) continue
      glow(sx(h.x), sy(h.y), (h.extent * z * S) * 2.2 + 160 * S, h.color, 0.035 * heat)
    }

    // worktree tethers
    for (const h of hubs) {
      if (!h.alive || h.parent === null) continue
      const p = hubs[h.parent]!
      const a = 0.07 * clamp01((t - h.born) * 2)
      line(sx(h.x), sy(h.y), sx(p.x), sy(p.y), 0.6 * S, h.color, a, 0.3)
    }

    // edges: curved, tapered filaments from parent (or project root) out to each session.
    // When a session is busy, light flows outward along its filament. Old, idle edges cool.
    for (let ni = 0; ni < nodes.length; ni++) {
      const n = nodes[ni]!
      if (!n.alive) continue
      const p = n.parent !== null && nodes[n.parent]!.alive ? nodes[n.parent]! : null
      const h = hubs[n.cluster]!
      const k = act(n)
      const born = clamp01((t - n.born) / 0.5)
      const idle = t - n.lastActive
      const a = (0.05 + 0.08 * Math.exp(-idle / 25) + 0.4 * k) * born
      const ax = sx(p ? p.x : h.x), ay = sy(p ? p.y : h.y)
      const bx = sx(n.x), by = sy(n.y)
      const dx = bx - ax, dy = by - ay
      const len = Math.hypot(dx, dy)
      if (len < 0.5) continue
      const bend = (ni % 2 ? 1 : -1) * 0.16
      const mx = (ax + bx) / 2 - dy * bend, my = (ay + by) / 2 + dx * bend
      const at = (s: number): [number, number] => {
        const i = 1 - s
        return [i * i * ax + 2 * i * s * mx + s * s * bx, i * i * ay + 2 * i * s * my + s * s * by]
      }
      // grows out from the parent on birth
      const end = smoother(born)
      const SEG = len > 60 * S ? 8 : 4
      const w0 = (p ? 1.1 : 0.9) * (0.75 + 0.4 * k) * S, w1 = 0.35 * S
      const col = mix(h.color, WHITE, 0.2)
      let prev = at(0)
      for (let si = 1; si <= SEG; si++) {
        const s1 = (si / SEG) * end
        const cur = at(s1)
        const f = (si - 0.5) / SEG
        line(prev[0], prev[1], cur[0], cur[1], w0 + (w1 - w0) * f, col, a * (1 - 0.45 * f), 1)
        prev = cur
      }
      const e = Math.min(1, n.energy)
      if (e > 0.12 && born >= 1) {
        for (let j = 0; j < 2; j++) {
          const s = (t * (0.9 + (ni % 5) * 0.08) + j * 0.5 + ni * 0.137) % 1
          const q = at(smoother(s))
          const fade = Math.sin(Math.PI * s)
          glow(q[0], q[1], 6 * S, col, 0.5 * e * fade)
          disc(q[0], q[1], 0.9 * S, mix(col, WHITE, 0.6), 0.9 * e * fade, true)
        }
      }
    }

    // Agent-to-agent comets: cool and dimmer than Kit's. Cross-project ones leave their arc
    // hanging in the sky for a moment; a parent's note to its subagent is a quick glint.
    for (const c of sim.comets) {
      const a = nodes[c.from]!, b = nodes[c.to]!
      const age = t - c.t0
      const ax = sx(a.x), ay = sy(a.y), bx = sx(b.x), by = sy(b.y)
      const at = (s: number) => arc(ax, ay, bx, by, c.bend, s)
      const hp = smoother(clamp01(age / c.dur))
      const cross = c.kind === "cross"
      const k = cross ? 1 : 0.55
      if (cross) {
        const fade = age < c.dur ? 1 : Math.max(0, 1 - (age - c.dur) / 2.2)
        const SEG = 28
        for (let i = 0; i < SEG; i++) {
          const p0 = at((i / SEG) * hp), p1 = at(((i + 1) / SEG) * hp)
          line(p0[0], p0[1], p1[0], p1[1], 0.7 * S, COOL, 0.28 * fade * (0.4 + 0.6 * (i / SEG)), 1, true)
        }
      }
      if (age < c.dur + 0.05) cometHead(at, hp, COOL, k, cross ? 0.12 : 0.18)
      const arr = age - c.dur
      if (arr > 0 && arr < 0.9) {
        const e = easeOut(arr / 0.9)
        ring(bx, by, b.r * bodyScale + 3 * S + e * (cross ? 40 : 16) * S, 1.3 * S * (1 - e) + 0.2, COOL, 0.75 * k * (1 - e))
        if (cross) glow(bx, by, 34 * S, COOL, 0.4 * (1 - e) * (1 - e))
      }
    }

    // subagent spawn pulses: a bead races down the new edge
    for (const p of sim.pulses) {
      const a = nodes[p.from]!, b = nodes[p.to]!
      const k = clamp01((t - p.t0) / p.dur)
      const e = easeOut(k)
      const x = sx(a.x) + (sx(b.x) - sx(a.x)) * e, y = sy(a.y) + (sy(b.y) - sy(a.y)) * e
      const c = mix(hubs[b.cluster]!.color, WHITE, 0.5)
      soft(sx(a.x), sy(a.y), x, y, 3 * S, c, 0.5 * (1 - k * 0.5), 1)
      glow(x, y, 12 * S, c, 0.8 * (1 - k * 0.6))
    }

    const av = sim.avatar

    // halos (additive)
    for (const n of nodes) {
      if (!n.alive) continue
      const h = hubs[n.cluster]!
      const k = act(n)
      const r = n.r * bodyScale
      const e = Math.min(1.6, n.energy)
      // long-idle sessions cool into steady points: their coronas go out
      const kk = (n.root ? 1 : 0.5) * (1 - 0.75 * cooled(n))
      const x = sx(n.x), y = sy(n.y)
      // big bodies get a wide, soft corona; small ones only a tight glow
      glow(x, y, r * 2 + (5 + 6 * e) * S, h.color, ((0.08 + 0.2 * k + 0.2 * e) * kk + n.spawnFlash * 0.6))
      if (n.root) glow(x, y, r * 5 + (14 + 16 * e) * S, h.color, (0.03 + 0.06 * k + 0.08 * e) * Math.min(1, r / (6 * S)))
      // anticipation: light pulls inward before a subagent is released
      if (n.gather > 0.02) {
        const g = n.gather
        ring(x, y, r + (2 + 22 * g) * S, 1.2 * S, mix(h.color, WHITE, 0.6), 0.7 * (1 - g) * g * 4)
        glow(x, y, r * 2.5 + 10 * S, mix(h.color, WHITE, 0.4), 0.35 * g)
      }
    }

    // sparks: a tiny glyph per tool kind. read: a round mote; edit: a four-point glint;
    // shell: a short streak along its flight; web: a hollow ring; anything else: a mote.
    for (let i = 0; i < sim.sage.length; i++) {
      const age = sim.sage[i]!, life = sim.slife[i]!
      if (age >= life) continue
      const k = age / life
      const a = Math.pow(1 - k, 1.6)
      const c = mix(hubs[sim.shub[i]!]!.color, WHITE, 0.45)
      const x = sx(sim.sx[i]!), y = sy(sim.sy[i]!)
      const s = sim.ssize[i]! * Math.pow(z, 0.45) * S
      glow(x, y, s * 4.5, c, 0.2 * a)
      switch (sim.skind[i]) {
        case 1: flare(x, y, s * 3.2, 0.35 * S, mix(c, WHITE, 0.3), 1.1 * a); break
        case 2: {
          const vx = sim.svx[i]! * z * S * 0.035, vy = sim.svy[i]! * z * S * 0.035
          line(x, y, x - vx, y - vy, s * 0.55, c, 0.9 * a, 0.15, true)
          break
        }
        case 3: ring(x, y, s * 1.3, 0.5 * S, c, 0.9 * a); break
        default: disc(x, y, s * (1 - k * 0.5), c, 0.9 * a, true)
      }
    }

    // rings
    for (const r of sim.rings) {
      const n = nodes[r.node]!
      if (!n.alive || t < r.t0) continue
      const k = clamp01((t - r.t0) / r.dur)
      const e = easeOut(k)
      ring(sx(n.x), sy(n.y), n.r * bodyScale + 2 * S + e * r.grow * S * Math.pow(z, 0.3), r.width * S * (1 - k) + 0.2, r.color, r.alpha * (1 - k) * (1 - k))
    }

    // hubs: a quiet marker at each project's root
    for (const h of hubs) {
      if (!h.alive) continue
      const born = clamp01((t - h.born) / 0.6)
      const heat = clamp01(h.heat)
      glow(sx(h.x), sy(h.y), 10 * S, h.color, (0.06 + 0.16 * heat) * born)
      disc(sx(h.x), sy(h.y), 1.6 * S * born, mix(h.color, WHITE, 0.3), 0.35 + 0.35 * heat)
    }

    // bodies: subagents first, then sessions on top
    for (const pass of [false, true]) {
      for (const n of nodes) {
        if (!n.alive || n.root !== pass) continue
        const h = hubs[n.cluster]!
        const k = act(n)
        const r = Math.max(0, n.r * bodyScale)
        const x = sx(n.x), y = sy(n.y)
        const ember = n.root ? 0.62 : 0.42
        const bright = ember + (1.15 - ember) * k + Math.min(1, n.energy) * 0.5
        const e = Math.min(1, n.energy)
        const cool = cooled(n)
        const tinted = mix(mix(h.color, [0.72, 0.8, 0.95], cool * 0.45), WHITE, 0.08 + 0.3 * e + n.spawnFlash * 0.4)
        const col = scale(tinted, bright * (1 - 0.22 * cool))
        disc(x, y, r + 1.4 * S, [0.01, 0.012, 0.025], 0.85) // dark rim separates overlapping bodies
        orb(x, y, r, col, 0.45 + 0.9 * e + n.spawnFlash)
        if (n.root) {
          // parents are stars: a fine orbit ring and a flare that brightens with activity
          ring(x, y, r + 3.2 * S, 0.8 * S, mix(h.color, WHITE, 0.3), 0.18 + 0.4 * k, true)
          const fl = clamp01((r - 4 * S) / (10 * S))
          flare(x, y, r * 2.6 + 18 * S * (0.4 + e), 0.55 * S, mix(h.color, WHITE, 0.55), (0.12 + 0.6 * e + 0.25 * k) * fl * (1 - 0.6 * cool))
        }
      }
    }

    // Kit: a warm comet with a short tapered tail; it flares as it lands
    if (av.alive) {
      const avx = sx(av.x), avy = sy(av.y)
      const pulse = Math.exp(-(t - av.lastArrive) * 5)
      const n = av.trail.length
      for (let i = 1; i < n; i++) {
        const [x0, y0] = av.trail[i - 1]!, [x1, y1] = av.trail[i]!
        const k = 1 - i / n
        line(sx(x0), sy(y0), sx(x1), sy(y1), (2.0 * k + 0.25) * S, KIT, 0.5 * k * k, 1, true)
        glow(sx(x1), sy(y1), (7 * k + 2) * S, KIT, 0.12 * k)
      }
      glow(avx, avy, (20 + 22 * pulse) * S, KIT, 0.32 + 0.55 * pulse)
      disc(avx, avy, 3.2 * S, KIT, 1.6, true)
      disc(avx, avy, 2.0 * S, WHITE, 2.2, true)
      flare(avx, avy, (10 + 16 * pulse) * S, 0.5 * S, KIT, 0.5 + 0.6 * pulse)
    }

    // ---- overlay: everything below draws after tonemapping
    layer = 1
    if (av.alive) text("kit", sx(av.x) + 9 * S, sy(av.y) - 8 * S, 13 * S, KIT, 0.8, { weight: 600, tracking: 0.5 * S })

    // Project labels caption their constellation. Busier, bigger projects place first; each
    // label tries below, above, right and left of its cluster, stays inside the frame, and
    // fades out rather than overlap another label or a session.
    const M = 22 * unit
    const placed: [number, number, number, number][] = [hud.rect] // clock and counters
    const mom = sim.moment()
    const bodies: [number, number, number][] = []
    for (const n of nodes) if (n.alive && n.root) bodies.push([sx(n.x), sy(n.y), n.r * bodyScale + 3 * S])
    const hits = (r: [number, number, number, number], own: number) =>
      placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]) ||
      bodies.some(([x, y, rad], bi) => x + rad > r[0] && x - rad < r[2] && y + rad > r[1] && y - rad < r[3] && ownBodies[bi] !== own)
    const ownBodies: number[] = []
    for (const n of nodes) if (n.alive && n.root) ownBodies.push(n.cluster)
    const importance = (h: (typeof hubs)[number]) => clamp01(h.heat * 1.2 + Math.exp(-(t - h.lastActive) / 3) * 0.45) + Math.log2(1 + h.count) * 0.12
    const order = hubs.map((_, i) => i).filter((i) => hubs[i]!.alive).sort((a, b) => importance(hubs[b]!) - importance(hubs[a]!) || a - b)
    const px = 14 * S
    const outro = clamp01((t - sim.warp.end - 0.8) / 1.5)
    for (const i of order) {
      const h = hubs[i]!
      let cx = 0, cy = 0, m = 0
      for (const n of nodes) if (n.alive && n.cluster === i) { cx += sx(n.x); cy += sy(n.y); m++ }
      let x0: number, y0: number, x1: number, y1: number
      if (m === 0) { cx = sx(h.x); cy = sy(h.y); x0 = x1 = cx; y0 = y1 = cy }
      else {
        cx /= m; cy /= m
        let rms = 0
        for (const n of nodes) if (n.alive && n.cluster === i) rms += (sx(n.x) - cx) ** 2 + (sy(n.y) - cy) ** 2
        const lim = Math.max(80 * S, 2.5 * Math.sqrt(rms / m))
        x0 = y0 = Infinity; x1 = y1 = -Infinity
        for (const n of nodes) {
          if (!n.alive || n.cluster !== i) continue
          const x = sx(n.x), y = sy(n.y)
          if (!n.root && Math.hypot(x - cx, y - cy) > lim) continue
          const r = n.r * bodyScale + 5 * S
          x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r)
        }
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
      }
      const w = measure(h.label, px, 500, 0.3 * S)
      // candidate baselines (x is the label's center)
      const cands: [number, number][] = [
        [cx, y1 + 17 * S], [cx, y0 - 7 * S],
        [x1 + 8 * S + w / 2, cy + 5 * S], [x0 - 8 * S - w / 2, cy + 5 * S],
      ]
      const rectOf = ([x, y]: [number, number]): [number, number, number, number] => {
        // edge-aware: slide the label back inside the frame
        const cxl = Math.min(width - M - w / 2, Math.max(M + w / 2, x))
        const cyl = Math.min(height - M, Math.max(M + px, y))
        return [cxl - w / 2 - 4 * S, cyl - px, cxl + w / 2 + 4 * S, cyl + 4 * S]
      }
      const st = (labels[i] ??= { x: cx, y: y1 + 17 * S, a: 0, side: 0 })
      // prefer the slot we used last frame, so labels don't hop around
      const tryOrder = [st.side, 0, 1, 2, 3].filter((v, k, arr) => arr.indexOf(v) === k)
      let chosen = -1
      for (const c of tryOrder) if (!hits(rectOf(cands[c]!), i)) { chosen = c; break }
      const visible = chosen >= 0
      if (visible) st.side = chosen
      const r = rectOf(cands[st.side]!)
      if (visible) placed.push(r)
      const tx = (r[0] + r[2]) / 2, ty = r[3] - 4 * S
      const fresh = st.a < 0.01
      st.x = fresh ? tx : st.x + (tx - st.x) * 0.18
      st.y = fresh ? ty : st.y + (ty - st.y) * 0.18
      const imp = importance(h)
      const born = clamp01((t - h.born - 0.15) / 0.8)
      // small, quiet projects recede when the camera pulls far back
      const zoomFade = clamp01(0.45 + imp + z * 0.6)
      // a camera moment brightens its project's name while the burst blooms
      const lift = mom.m && mom.m.cluster === i ? mom.e : 0
      const ta = visible || lift > 0.05 ? Math.max((0.3 + 0.65 * clamp01(imp)) * zoomFade, 0.75 * outro, lift) * born : 0
      st.a = Math.max(0, st.a + (ta - st.a) * 0.14)
      text(h.label, st.x, st.y, px * (1 + 0.12 * lift), mix(h.color, WHITE, 0.6 + 0.3 * lift), st.a, { weight: lift > 0.5 ? 600 : 500, align: "center", tracking: 0.3 * S })
    }

    if (opts.titles) {
      for (const n of nodes) {
        if (!n.alive || !n.root || !n.title) continue
        const k = clamp01(Math.min(1, n.energy) * 1.2)
        if (k < 0.05) continue
        const s = n.title.length > 46 ? n.title.slice(0, 45) + "…" : n.title
        text(s, sx(n.x) + n.r * bodyScale + 8 * S, sy(n.y) + 4 * S, 11.5 * S, WHITE, 0.7 * k, { weight: 500 })
      }
    }

    drawHud(sim, frameDt)

    return { count: counts[0]!, overCount: counts[1]!, cam, sky }
  }

  function measure(s: string, px: number, weight: number, tracking: number) {
    const g = atlas.get(s, Math.round(px), weight, tracking)
    return g.w - atlas.pad(g) * 2
  }

  function atlasAdvance(px: number) {
    let m = 0
    for (const d of "0123456789") {
      const g = atlas.get(d, Math.round(px), 300, 0)
      m = Math.max(m, g.w - atlas.pad(g) * 2)
    }
    return m
  }

  return { data, overData, build, cam }
}
