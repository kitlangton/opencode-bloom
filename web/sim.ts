// Deterministic world simulation. Everything advances in fixed 1/480 s steps of video
// time, so a frame looks identical however it was reached.
import { EV, type EventLog } from "../shared/events"
import { buildWarp, type Warp } from "./warp"

export const STEP = 1 / 480
export const BEAM_TRAVEL = 0.16
/** a parent gathers itself this long before a subagent is released */
export const ANTICIPATION = 0.16

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
  gather: number // anticipation: light drawn in before a child is released
}

/** A camera moment: a burst of subagents worth slowing down for. Times are video seconds. */
export interface Moment { parent: number; cluster: number; at: number; end: number; count: number }

export interface Ring { node: number; t0: number; dur: number; grow: number; color: RGB; width: number; alpha: number }
/** Agent-to-agent prompts. "cross" crosses projects and leaves its arc lingering. */
export interface Comet { from: number; to: number; t0: number; dur: number; bend: number; kind: "cross" | "agent" }
export const COOL: RGB = [0.62, 0.8, 1.0]
export type Cue = { kind: "kit" | "agent" | "cross" | "moment"; node: number; time: number }
export interface Pulse { from: number; to: number; t0: number; dur: number }

const MAX_SPARKS = 6000

export class Sim {
  readonly log: EventLog
  readonly warp: Warp
  readonly duration: number
  readonly hubs: Hub[]
  readonly nodes: Node[]
  readonly moments: Moment[]
  time = 0
  rings: Ring[] = []
  comets: Comet[] = []
  cues: Cue[] = []
  /** file names drifting off sessions as they're edited (Gource-style), sparsely */
  drifts: { node: number; name: string; t0: number; angle: number }[] = []
  private lastDrift = -1e9
  private lastDriftBy = new Map<number, number>()
  counts = { sessions: 0, subagents: 0, messages: 0 }
  recordedCostUSD = 0
  private nextCost = 0
  pulses: Pulse[] = []
  // Sparks live in flat arrays: x, y, vx, vy, age, life, size, node-color index.
  sx = new Float32Array(MAX_SPARKS); sy = new Float32Array(MAX_SPARKS)
  svx = new Float32Array(MAX_SPARKS); svy = new Float32Array(MAX_SPARKS)
  sage = new Float32Array(MAX_SPARKS); slife = new Float32Array(MAX_SPARKS)
  ssize = new Float32Array(MAX_SPARKS); shub = new Int16Array(MAX_SPARKS); skind = new Int8Array(MAX_SPARKS)
  sparkHead = 0
  /** Kit: a comet that flies an arc to each session he prompts, then idles in orbit there. */
  avatar = {
    x: 0, y: 0, vx: 0, vy: 0, alive: false, target: -1, lastArrive: -1e9,
    flight: null as null | { fx: number; fy: number; to: number; t0: number; dur: number; bend: number },
    queue: [] as number[], trail: [] as [number, number][], orbit: 0, flights: 0,
  }
  private eventTimes: Float64Array
  private next = 0
  private pendingBirths: { n: number; at: number }[] = []
  /** optional observer for audio: every dispatched event with the time it took effect */
  onEvent?: (e: [number, number, number, number], time: number) => void
  private rand = rng(7)
  private bornOrder = 0

  constructor(log: EventLog, opts: { duration: number; intro?: number; outro?: number; moments?: number }) {
    this.log = log
    this.duration = opts.duration
    const intro = opts.intro ?? 1.2
    const outro = opts.outro ?? 5
    const span = log.meta.to - log.meta.from
    const times = log.events.map((e) => e[0])
    const base = buildWarp(times, span, intro, opts.duration - outro)
    const bursts = findBursts(log)
    // Pick the most significant bursts, kept apart in video time so each gets room.
    const max = opts.moments ?? Math.max(1, Math.round(opts.duration / 18))
    const gap = Math.max(6, opts.duration / (max + 2))
    const chosen: typeof bursts = []
    for (const b of bursts) {
      if (chosen.length >= max) break
      const v = base.toVideo(b.start)
      if (v < intro + 3 || v > opts.duration - outro - 3) continue
      if (chosen.some((c) => Math.abs(base.toVideo(c.start) - v) < gap)) continue
      chosen.push(b)
    }
    // Slow time around each: about 1.6x the local rate for a few minutes.
    this.warp = buildWarp(times, span, intro, opts.duration - outro, chosen.map((b) => [(b.start + b.end) / 2, 0.55, 2.5]))
    this.moments = chosen.map((b) => ({ parent: b.parent, cluster: log.sessions[b.parent]!.cluster, at: this.warp.toVideo(b.start), end: this.warp.toVideo(b.end), count: b.count }))
      .sort((a, b) => a.at - b.at)
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
      alive: false, born: 0, x: 0, y: 0, vx: 0, vy: 0, r: 0, rv: 0, msgs: 0, energy: 0, lastActive: -1e9, spawnFlash: 0, gather: 0,
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
    if (node.root) this.counts.sessions++
    else this.counts.subagents++
  }

  private spark(n: number, speed: number, life: number, size: number, angle?: number, kind = 4) {
    const node = this.nodes[n]!
    if (!node.alive) return
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
    this.skind[i] = kind
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
      case EV.subagent: {
        // Anticipation: the parent draws in (contracts, light gathers), then releases the child.
        const p = this.nodes[n]!.parent
        if (p !== null && this.nodes[p]!.alive && !this.nodes[n]!.alive) {
          const parent = this.nodes[p]!
          parent.rv -= parent.r * 5
          parent.gather = 1
          this.pendingBirths.push({ n, at: this.time + ANTICIPATION })
        } else {
          this.born(n, true)
        }
        this.touch(n, 1)
        break
      }
      case EV.crossPrompt: {
        this.born(x, false)
        const target = this.nodes[n]!
        if (!target.alive) {
          this.bornHub(target.cluster, this.hubs[this.nodes[x]!.cluster]!)
          this.born(n, false)
        }
        this.comets.push({ from: x, to: n, t0: this.time, dur: 1.1, bend: this.rand() < 0.5 ? -0.28 : 0.28, kind: "cross" })
        this.cues.push({ kind: "cross", node: n, time: this.time + 1.1 })
        this.counts.messages++
        this.touch(x, 0.6)
        this.nodes[n]!.msgs++
        break
      }
      case EV.user: {
        const node = this.nodes[n]!
        node.msgs++
        this.touch(n, 0.9)
        this.counts.messages++
        if (x === 1) {
          const av = this.avatar
          if (!av.alive) {
            av.alive = true
            av.x = node.x + 80; av.y = node.y - 80
          }
          // A backlog is cut short: older prompts land as a quiet flash, no flight.
          while (av.queue.length >= 2) this.land(av.queue.shift()!, 0.4)
          av.queue.push(n)
          if (!av.flight) this.launch()
        } else if (node.parent !== null && this.nodes[node.parent]!.alive && this.time - node.born > 0.3) {
          // a parent writes to its subagent: a dim, cool comet
          this.comets.push({ from: node.parent, to: n, t0: this.time, dur: 0.6, bend: n % 2 ? 0.3 : -0.3, kind: "agent" })
          this.cues.push({ kind: "agent", node: n, time: this.time + 0.6 })
        }
        break
      }
      case EV.assistant:
        this.counts.messages++
        this.nodes[n]!.msgs++
        this.touch(n, 0.32)
        break
      case EV.file: {
        // rate-limited hard: one name every ~0.45 s overall, one per session per 2.5 s,
        // and never more than five in the air
        const name = this.log.files?.[x]
        if (!name || !this.nodes[n]!.alive) break
        if (this.time - this.lastDrift < 0.45 || this.time - (this.lastDriftBy.get(n) ?? -1e9) < 2.5) break
        if (this.drifts.filter((d) => this.time - d.t0 < 1.6).length >= 5) break
        this.lastDrift = this.time
        this.lastDriftBy.set(n, this.time)
        this.drifts.push({ node: n, name, t0: this.time, angle: this.rand() * Math.PI * 2 })
        break
      }
      case EV.tool: {
        const big = x === 1 || x === 4
        this.spark(n, big ? 95 : 70, big ? 1.1 : 0.8, big ? 1.6 : 1.1, undefined, Math.min(4, x))
        this.touch(n, 0.05)
        break
      }
    }
  }

  private step() {
    const dt = STEP
    this.time += dt
    const t = this.time
    const costs = this.log.costs ?? []
    const real = this.warp.toReal(t)
    while (t >= this.warp.start && this.nextCost < costs.length && costs[this.nextCost]![0] <= real) {
      this.recordedCostUSD += costs[this.nextCost++]![1]
    }
    const events = this.log.events
    while (this.next < events.length && this.eventTimes[this.next]! <= t) {
      const e = events[this.next++]!
      this.dispatch(e)
      this.onEvent?.(e, t)
    }
    if (this.pendingBirths.length) {
      const due = this.pendingBirths.filter((b) => b.at <= t)
      if (due.length) {
        this.pendingBirths = this.pendingBirths.filter((b) => b.at > t)
        for (const b of due) {
          const node = this.nodes[b.n]!
          if (!node.alive) { this.born(b.n, true); node.energy = Math.max(node.energy, 1) }
        }
      }
    }

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
        // leaves orbit their parent slowly; siblings share a direction, like a little system
        if (anchor && a.parent !== null) {
          // finished leaves stop circling and settle into fixed points of the map
          const settled = Math.min(1, Math.max(0, (this.time - a.lastActive - 6) / 8))
          const spin = (a.parent % 2 ? 1 : -1) * 9 * (1 - settled)
          fx += -uy * spin; fy += ux * spin
        }
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
      n.gather *= Math.exp(-7 * dt)
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

    // Kit's comet: minimum-jerk travel along an arc whose end tracks the moving session;
    // between flights it eases out to a slow orbit around the last session it reached.
    const av = this.avatar
    if (av.alive) {
      const f = av.flight
      if (f) {
        const u = Math.min(1, (t - f.t0) / f.dur)
        const n = nodes[f.to]!
        const p = arc(f.fx, f.fy, n.x, n.y, f.bend, smootherstep(u))
        av.vx = (p[0] - av.x) / dt; av.vy = (p[1] - av.y) / dt
        av.x = p[0]; av.y = p[1]
        if (u >= 1) {
          av.flight = null
          av.vx = 0; av.vy = 0
          this.land(f.to, 1)
          av.target = f.to
          av.lastArrive = t
          av.orbit = Math.atan2(f.fy - n.y, f.fx - n.x)
          this.cues.push({ kind: "kit", node: f.to, time: t })
          if (av.queue.length) this.launch()
        }
      } else if (av.target >= 0) {
        const n = nodes[av.target]!
        av.orbit += dt * 0.7
        const rad = n.r + 16
        const tx = n.x + Math.cos(av.orbit) * rad, ty = n.y + Math.sin(av.orbit) * rad
        const w = 5, z = 0.95
        av.vx += (-(av.x - tx) * w * w - 2 * z * w * av.vx) * dt
        av.vy += (-(av.y - ty) * w * w - 2 * z * w * av.vy) * dt
        av.x += av.vx * dt; av.y += av.vy * dt
      }
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
      this.pulses = this.pulses.filter((p) => t - p.t0 < p.dur + 0.1)
      this.drifts = this.drifts.filter((d) => t - d.t0 < 1.8)
    }
  }

  private launch() {
    const av = this.avatar
    const to = av.queue.shift()
    if (to === undefined) return
    const n = this.nodes[to]!
    const d = Math.hypot(n.x - av.x, n.y - av.y)
    // quicker hops when prompts are piling up
    const hurry = av.queue.length ? 0.75 : 1
    av.flight = { fx: av.x, fy: av.y, to, t0: this.time, dur: Math.min(0.75, Math.max(0.3, 0.22 + d / 900)) * hurry, bend: av.flights++ % 2 ? 0.22 : -0.22 }
  }

  /** Kit's prompt arrives: the session flashes and a warm ring opens. */
  private land(n: number, strength: number) {
    const node = this.nodes[n]!
    node.energy = Math.min(2.5, node.energy + 0.5 * strength)
    node.spawnFlash = Math.max(node.spawnFlash, 0.35 * strength)
    this.rings.push({ node: n, t0: this.time, dur: 1.0, grow: 30 * strength, color: KIT, width: 1.5, alpha: 0.85 * strength })
  }

  /** How strongly a camera moment holds right now (0..1), and which. */
  moment(t = this.time): { e: number; m: Moment | null } {
    let best = 0, which: Moment | null = null
    for (const m of this.moments) {
      const up = smootherstep(Math.min(1, Math.max(0, (t - (m.at - 2.0)) / 1.5)))
      const down = 1 - smootherstep(Math.min(1, Math.max(0, (t - (m.end + 2.4)) / 1.7)))
      const e = up * down
      if (e > best) { best = e; which = m }
    }
    return { e: best, m: which }
  }

  /** Called once per rendered frame to sample the avatar trail. */
  sampleTrail() {
    const av = this.avatar
    if (!av.alive) return
    av.trail.unshift([av.x, av.y])
    if (av.trail.length > 14) av.trail.pop()
  }
}

/** Groups of 3+ subagents from one parent within a few real minutes, most significant first. */
export function findBursts(log: EventLog) {
  const WINDOW = 4 * 60_000
  const byParent = new Map<number, number[]>()
  for (const e of log.events) if (e[1] === EV.subagent && e[3] >= 0) {
    const list = byParent.get(e[3]) ?? []
    list.push(e[0])
    byParent.set(e[3], list)
  }
  const bursts: { parent: number; start: number; end: number; count: number; score: number }[] = []
  for (const [parent, ts] of byParent) {
    let i = 0
    while (i < ts.length) {
      let j = i
      while (j + 1 < ts.length && ts[j + 1]! - ts[i]! <= WINDOW) j++
      const count = j - i + 1
      if (count >= 3) {
        // tighter bursts score higher
        const spread = Math.max(15_000, ts[j]! - ts[i]!)
        bursts.push({ parent, start: ts[i]!, end: ts[j]!, count, score: count * Math.sqrt(WINDOW / spread) })
        i = j + 1
      } else i++
    }
  }
  return bursts.sort((a, b) => b.score - a.score || a.start - b.start)
}

export const smootherstep = (u: number) => u * u * u * (u * (u * 6 - 15) + 10)

/** A quadratic arc bowed sideways by `bend` (fraction of the chord). */
export function arc(ax: number, ay: number, bx: number, by: number, bend: number, s: number): [number, number] {
  const dx = bx - ax, dy = by - ay
  const mx = (ax + bx) / 2 - dy * bend, my = (ay + by) / 2 + dx * bend
  const i = 1 - s
  return [i * i * ax + 2 * i * s * mx + s * s * bx, i * i * ay + 2 * i * s * my + s * s * by]
}
