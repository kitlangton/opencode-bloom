// Deterministic world simulation. Everything advances in fixed 1/480 s steps of video
// time, so a frame looks identical however it was reached.
import { EV, type EventLog } from "../shared/events"
import { buildWarp, type Warp } from "./warp"

export const STEP = 1 / 480
export const BEAM_TRAVEL = 0.16

export type RGB = [number, number, number]

// Luminous hues that read on near-black; ordered so neighbors contrast.
const PALETTE: RGB[] = [
  [0.48, 0.64, 1.0], // periwinkle
  [0.37, 0.92, 0.83], // teal
  [0.98, 0.66, 0.83], // pink
  [0.99, 0.83, 0.42], // amber
  [0.66, 0.55, 0.98], // violet
  [0.53, 0.94, 0.67], // mint
  [0.99, 0.73, 0.45], // peach
  [0.4, 0.91, 0.98], // cyan
  [0.97, 0.5, 0.48], // coral
  [0.8, 0.76, 1.0], // lavender
  [0.75, 0.95, 0.45], // lime
]
export const KIT: RGB = [1.0, 0.95, 0.86]
export const GOLD: RGB = [1.0, 0.8, 0.45]

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Hub {
  label: string
  parent: number | null
  color: RGB
  alive: boolean
  born: number
  x: number; y: number; vx: number; vy: number
  count: number
  heat: number // smoothed activity, drives label brightness
  extent: number // smoothed radius of its sessions around the hub
  lastActive: number
}

export interface Node {
  cluster: number
  parent: number | null
  root: boolean
  title?: string
  alive: boolean
  born: number
  x: number; y: number; vx: number; vy: number
  r: number; rv: number // radius spring state
  msgs: number
  energy: number
  lastActive: number
  spawnFlash: number
}

export interface Ring { node: number; t0: number; dur: number; grow: number; color: RGB; width: number; alpha: number }
export interface Comet { from: number; to: number; t0: number; dur: number; bend: number }
export interface Beam { to: number; t0: number }
export interface Pulse { from: number; to: number; t0: number; dur: number }

const MAX_SPARKS = 6000

export class Sim {
  readonly log: EventLog
  readonly warp: Warp
  readonly duration: number
  readonly hubs: Hub[]
  readonly nodes: Node[]
  time = 0
  rings: Ring[] = []
  comets: Comet[] = []
  beams: Beam[] = []
  pulses: Pulse[] = []
  // Sparks live in flat arrays: x, y, vx, vy, age, life, size, node-color index.
  sx = new Float32Array(MAX_SPARKS); sy = new Float32Array(MAX_SPARKS)
  svx = new Float32Array(MAX_SPARKS); svy = new Float32Array(MAX_SPARKS)
  sage = new Float32Array(MAX_SPARKS); slife = new Float32Array(MAX_SPARKS)
  ssize = new Float32Array(MAX_SPARKS); shub = new Int16Array(MAX_SPARKS)
  sparkHead = 0
  avatar = { x: 0, y: 0, vx: 0, vy: 0, target: -1, alive: false, lastPrompt: -1e9, trail: [] as [number, number][], recent: [] as { n: number; t: number }[] }
  private eventTimes: Float64Array
  private next = 0
  private rand = rng(7)
  private bornOrder = 0

  constructor(log: EventLog, opts: { duration: number; intro?: number; outro?: number }) {
    this.log = log
    this.duration = opts.duration
    const intro = opts.intro ?? 1.2
    const outro = opts.outro ?? 5
    const span = log.meta.to - log.meta.from
    this.warp = buildWarp(log.events.map((e) => e[0]), span, intro, opts.duration - outro)
    this.eventTimes = Float64Array.from(log.events, (e) => this.warp.toVideo(e[0]))
    const hueOf = new Map<number, number>()
    let nextHue = 0
    this.hubs = log.clusters.map((c, i) => {
      let color: RGB
      if (c.parent !== null && hueOf.has(c.parent)) {
        const p = PALETTE[hueOf.get(c.parent)!]!
        color = [p[0] * 0.7 + 0.3, p[1] * 0.7 + 0.3, p[2] * 0.7 + 0.3]
      } else {
        hueOf.set(i, nextHue % PALETTE.length)
        color = PALETTE[nextHue++ % PALETTE.length]!
      }
      return { label: c.label, parent: c.parent, color, alive: false, born: 0, x: 0, y: 0, vx: 0, vy: 0, count: 0, heat: 0, extent: 20, lastActive: -1e9 }
    })
    // Worktree hubs inherit hues lazily; resolve now that every parent exists.
    log.clusters.forEach((c, i) => {
      if (c.parent !== null && !hueOf.has(c.parent)) {
        const p = this.hubs[c.parent]!.color
        this.hubs[i]!.color = [p[0] * 0.7 + 0.3, p[1] * 0.7 + 0.3, p[2] * 0.7 + 0.3]
      }
    })
    this.nodes = log.sessions.map((s) => ({
      cluster: s.cluster, parent: s.parent, root: s.parent === null, title: s.title,
      alive: false, born: 0, x: 0, y: 0, vx: 0, vy: 0, r: 0, rv: 0, msgs: 0, energy: 0, lastActive: -1e9, spawnFlash: 0,
    }))
  }

  /** Real wall-clock ms (epoch) currently shown. */
  get realTime() {
    return Math.min(this.log.meta.to - 60_000, this.log.meta.from + this.warp.toReal(this.time))
  }

  advanceTo(t: number) {
    while (this.time + STEP <= t + 1e-9) this.step()
  }

  private bornHub(i: number, near?: { x: number; y: number }) {
    const h = this.hubs[i]!
    if (h.alive) return
    if (h.parent !== null) this.bornHub(h.parent)
    h.alive = true
    h.born = this.time
    const alive = this.hubs.filter((o) => o.alive && o !== h)
    if (h.parent !== null) {
      const p = this.hubs[h.parent]!
      const a = Math.atan2(p.y, p.x) + (this.rand() - 0.5) * 1.6
      h.x = p.x + Math.cos(a) * 170
      h.y = p.y + Math.sin(a) * 170
    } else if (near) {
      const a = this.rand() * Math.PI * 2
      h.x = near.x + Math.cos(a) * 200
      h.y = near.y + Math.sin(a) * 200
    } else if (alive.length === 0) {
      h.x = 0; h.y = 0
    } else {
      // Golden-angle spiral leaves room around the existing city.
      const k = this.bornOrder
      const a = k * 2.39996 + 0.6
      const rad = 140 + 95 * Math.sqrt(k)
      h.x = Math.cos(a) * rad
      h.y = Math.sin(a) * rad * 0.8
    }
    this.bornOrder++
  }

  private born(n: number, spawned: boolean) {
    const node = this.nodes[n]!
    if (node.alive) return
    node.alive = true
    node.born = this.time
    node.lastActive = this.time
    const hub = this.hubs[node.cluster]!
    if (node.parent !== null && this.nodes[node.parent]!.alive) {
      const p = this.nodes[node.parent]!
      const anchor = p.parent !== null ? this.nodes[p.parent]! : this.hubs[p.cluster]!
      const base = Math.atan2(p.y - anchor.y, p.x - anchor.x)
      const a = base + (this.rand() - 0.5) * 2.2
      node.x = p.x + Math.cos(a) * 4
      node.y = p.y + Math.sin(a) * 4
      const kick = spawned ? 260 : 60
      node.vx = p.vx + Math.cos(a) * kick
      node.vy = p.vy + Math.sin(a) * kick
      if (spawned) {
        this.pulses.push({ from: node.parent, to: n, t0: this.time, dur: 0.35 })
        this.burst(node.parent, 10, 140)
      }
    } else {
      this.bornHub(node.cluster)
      const a = this.rand() * Math.PI * 2
      node.x = hub.x + Math.cos(a) * 6
      node.y = hub.y + Math.sin(a) * 6
      node.vx = Math.cos(a) * 120
      node.vy = Math.sin(a) * 120
    }
    node.r = 0
    node.rv = 0
    node.spawnFlash = spawned ? 1 : 0.5
    hub.count++
  }

  private spark(n: number, speed: number, life: number, size: number, angle?: number) {
    const node = this.nodes[n]!
    const i = this.sparkHead
    this.sparkHead = (this.sparkHead + 1) % MAX_SPARKS
    const a = angle ?? this.rand() * Math.PI * 2
    const s = speed * (0.6 + this.rand() * 0.8)
    const r = node.r * 0.8
    this.sx[i] = node.x + Math.cos(a) * r
    this.sy[i] = node.y + Math.sin(a) * r
    this.svx[i] = node.vx * 0.5 + Math.cos(a) * s
    this.svy[i] = node.vy * 0.5 + Math.sin(a) * s
    this.sage[i] = 0
    this.slife[i] = life * (0.7 + this.rand() * 0.6)
    this.ssize[i] = size
    this.shub[i] = node.cluster
  }

  private burst(n: number, count: number, speed: number) {
    const off = this.rand() * Math.PI * 2
    for (let k = 0; k < count; k++) this.spark(n, speed, 0.9, 1.5, off + (k / count) * Math.PI * 2)
  }

  private touch(n: number, energy: number) {
    const node = this.nodes[n]!
    node.energy = Math.min(2.5, node.energy + energy)
    node.lastActive = this.time
    const hub = this.hubs[node.cluster]!
    hub.lastActive = this.time
    hub.heat = Math.min(1.5, hub.heat + energy * 0.15)
  }

  private dispatch(e: [number, number, number, number]) {
    const [, type, n, x] = e
    switch (type) {
      case EV.created:
        this.born(n, false)
        break
      case EV.subagent:
        this.born(n, true)
        this.touch(n, 1)
        break
      case EV.crossPrompt: {
        this.born(x, false)
        const target = this.nodes[n]!
        if (!target.alive) {
          this.bornHub(target.cluster, this.hubs[this.nodes[x]!.cluster]!)
          this.born(n, false)
        }
        this.comets.push({ from: x, to: n, t0: this.time, dur: 1.1, bend: this.rand() < 0.5 ? -0.28 : 0.28 })
        this.touch(x, 0.6)
        this.nodes[n]!.msgs++
        break
      }
      case EV.user: {
        const node = this.nodes[n]!
        node.msgs++
        this.touch(n, 0.9)
        if (x === 1) {
          const av = this.avatar
          if (!av.alive) {
            av.alive = true
            av.x = node.x + 60; av.y = node.y - 60
          }
          av.target = n
          av.lastPrompt = this.time
          av.recent.push({ n, t: this.time })
          this.beams.push({ to: n, t0: this.time })
          // the ring opens when the beam's bead lands
          this.rings.push({ node: n, t0: this.time + BEAM_TRAVEL, dur: 1.1, grow: 34, color: KIT, width: 1.6, alpha: 0.9 })
        } else {
          this.rings.push({ node: n, t0: this.time, dur: 0.8, grow: 18, color: this.hubs[node.cluster]!.color, width: 1.2, alpha: 0.7 })
        }
        break
      }
      case EV.assistant:
        this.nodes[n]!.msgs++
        this.touch(n, 0.32)
        break
      case EV.tool: {
        const big = x === 1 || x === 4
        this.spark(n, big ? 95 : 70, big ? 1.1 : 0.8, big ? 1.6 : 1.1)
        this.touch(n, 0.05)
        break
      }
    }
  }

  private step() {
    const dt = STEP
    this.time += dt
    const t = this.time
    const events = this.log.events
    while (this.next < events.length && this.eventTimes[this.next]! <= t) this.dispatch(events[this.next++]!)

    const nodes = this.nodes
    const hubs = this.hubs

    // Hub forces: mutual repulsion scaled by cluster size, worktree tethers, gentle gravity.
    for (let i = 0; i < hubs.length; i++) {
      const a = hubs[i]!
      if (!a.alive) continue
      let fx = -a.x * 0.22, fy = -a.y * 0.5
      for (let j = 0; j < hubs.length; j++) {
        if (i === j) continue
        const b = hubs[j]!
        if (!b.alive) continue
        const dx = a.x - b.x, dy = a.y - b.y
        const d2 = dx * dx + dy * dy + 1
        const d = Math.sqrt(d2)
        const want = a.extent + b.extent + 70
        // long-range soft push plus a firm push when territories overlap
        let f = 26000 / d2 * (1 + Math.sqrt(a.count + b.count) * 0.5)
        if (d < want) f += (want - d) * 9
        fx += (dx / d) * f
        fy += (dy / d) * f
      }
      if (a.parent !== null) {
        const p = hubs[a.parent]!
        const dx = p.x - a.x, dy = p.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-6
        const rest = a.extent + p.extent + 60
        const f = (d - rest) * 3
        fx += (dx / d) * f; fy += (dy / d) * f
        p.vx -= (dx / d) * f * dt * 0.5; p.vy -= (dy / d) * f * dt * 0.5
      }
      a.vx += fx * dt; a.vy += fy * dt
    }

    // Session forces.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!
      if (!a.alive) continue
      let fx = 0, fy = 0
      const anchor = a.parent !== null && nodes[a.parent]!.alive ? nodes[a.parent]! : null
      const hub = hubs[a.cluster]!
      const ax = anchor ? anchor.x : hub.x
      const ay = anchor ? anchor.y : hub.y
      {
        // Reciprocal tether: the anchor feels the pull too (scaled by mass), otherwise
        // children pushing on a parent they don't pull back would propel it forever.
        const dx = ax - a.x, dy = ay - a.y
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-6
        const rest = anchor ? anchor.r + a.r + 16 : 30 + a.r
        const k = anchor ? 70 : 40
        const f = (d - rest) * k
        const ux = dx / d, uy = dy / d
        fx += ux * f; fy += uy * f
        const ma = a.root ? 2 : 1
        const mb = anchor ? (anchor.root ? 2 : 1) : 4 + hub.count
        const back = (f * dt * ma) / mb
        if (anchor) { anchor.vx -= ux * back; anchor.vy -= uy * back }
        else { hub.vx -= ux * back; hub.vy -= uy * back }
        fx /= ma; fy /= ma
      }
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!
        if (!b.alive) continue
        const dx = a.x - b.x, dy = a.y - b.y
        const d2 = dx * dx + dy * dy
        const cut = 70 + a.r + b.r
        if (d2 > cut * cut) continue
        const d = Math.sqrt(d2) + 0.01
        const fall = 1 - d / cut
        const f = 5200 * fall * fall * (1 + (a.r + b.r) * 0.05)
        const ux = dx / d, uy = dy / d
        fx += ux * f; fy += uy * f
        b.vx -= ux * f * dt; b.vy -= uy * f * dt
      }
      // Sessions of other clusters keep clear of a foreign hub.
      a.vx += fx * dt; a.vy += fy * dt
    }

    const damp = Math.exp(-5.5 * dt)
    const hubDamp = Math.exp(-4 * dt)
    for (const h of hubs) {
      if (!h.alive) continue
      h.vx *= hubDamp; h.vy *= hubDamp
      h.x += h.vx * dt; h.y += h.vy * dt
      h.heat *= Math.exp(-0.45 * dt)
    }
    // Per-cluster extent (radius of territory) eases toward the real spread.
    // Territory is measured around the members' own centroid, so a hub that drifts from its
    // sessions can't inflate its extent and push itself further away (a runaway loop).
    const spread = new Float64Array(hubs.length)
    const members = new Float64Array(hubs.length)
    const cxs = new Float64Array(hubs.length), cys = new Float64Array(hubs.length)
    for (const n of nodes) {
      if (!n.alive) continue
      n.vx *= damp; n.vy *= damp
      n.x += n.vx * dt; n.y += n.vy * dt
      n.energy *= Math.exp(-1.1 * dt)
      n.spawnFlash *= Math.exp(-3 * dt)
      // radius spring: underdamped so new sessions pop, then grows with message count
      const target = (n.root ? 4.2 : 2.6) + Math.sqrt(n.msgs) * (n.root ? 0.62 : 0.5)
      const w = 16, z = 0.42
      n.rv += (-(n.r - target) * w * w - 2 * z * w * n.rv) * dt
      n.r += n.rv * dt
      cxs[n.cluster]! += n.x; cys[n.cluster]! += n.y
      members[n.cluster]! += 1
    }
    for (const n of nodes) {
      if (!n.alive) continue
      const m = members[n.cluster]!
      const d = Math.hypot(n.x - cxs[n.cluster]! / m, n.y - cys[n.cluster]! / m) + n.r
      spread[n.cluster]! += d * d
    }
    for (let i = 0; i < hubs.length; i++) {
      const h = hubs[i]!
      if (!h.alive) continue
      const rms = members[i]! ? Math.sqrt(spread[i]! / members[i]!) : 0
      const want = Math.min(Math.max(24, rms * 1.5 + 10), 40 + 22 * Math.sqrt(members[i]!))
      h.extent += (want - h.extent) * (1 - Math.exp(-1 * dt))
    }

    // Kit's avatar glides toward the sessions he has been prompting (weighted toward the
    // latest), like a Gource committer drifting among the files it touches.
    const av = this.avatar
    if (av.alive && av.target >= 0) {
      let tx = 0, ty = 0, tw = 0
      for (const p of av.recent) {
        const w = Math.exp(-(t - p.t) / 0.9) * (p.n === av.target ? 2 : 1)
        const n = nodes[p.n]!
        tx += n.x * w; ty += n.y * w; tw += w
      }
      if (tw < 1e-4) { const n = nodes[av.target]!; tx = n.x; ty = n.y; tw = 1 }
      tx = tx / tw + 26; ty = ty / tw - 26
      const w = 3.6, z = 0.9
      av.vx += (-(av.x - tx) * w * w - 2 * z * w * av.vx) * dt
      av.vy += (-(av.y - ty) * w * w - 2 * z * w * av.vy) * dt
      av.x += av.vx * dt; av.y += av.vy * dt
    }

    // Sparks: ballistic with drag.
    const drag = Math.exp(-2.6 * dt)
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sage[i]! >= this.slife[i]!) continue
      this.sage[i]! += dt
      this.svx[i]! *= drag; this.svy[i]! *= drag
      this.sx[i]! += this.svx[i]! * dt; this.sy[i]! += this.svy[i]! * dt
    }

    if (Math.round(t / dt) % 32 === 0) {
      this.rings = this.rings.filter((r) => t - r.t0 < r.dur)
      this.comets = this.comets.filter((c) => t - c.t0 < c.dur + 2.2)
      this.beams = this.beams.filter((b) => t - b.t0 < 0.9)
      this.avatar.recent = this.avatar.recent.filter((p) => t - p.t < 5)
      this.pulses = this.pulses.filter((p) => t - p.t0 < p.dur + 0.1)
    }
  }

  /** Called once per rendered frame to sample the avatar trail. */
  sampleTrail() {
    const av = this.avatar
    if (!av.alive) return
    av.trail.unshift([av.x, av.y])
    if (av.trail.length > 18) av.trail.pop()
  }
}
