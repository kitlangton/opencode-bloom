// The sky follows the event log's own clock: night, indigo pre-dawn, a warm dawn, a cool
// day that stays dark enough for the stars of the city to read, amber dusk, night again.
import type { Vec4 } from "./gpu"

type V3 = [number, number, number]
interface Key { h: number; top: V3; bottom: V3; glow: V3; tint: V3; stars: number }

const NIGHT: Omit<Key, "h"> = { top: [0.005, 0.006, 0.013], bottom: [0.011, 0.012, 0.024], glow: [0, 0, 0], tint: [0.85, 0.9, 1.1], stars: 1 }
const DAY: Omit<Key, "h"> = { top: [0.02, 0.05, 0.1], bottom: [0.032, 0.075, 0.125], glow: [0.008, 0.02, 0.03], tint: [0.8, 1.0, 1.2], stars: 0.28 }
const KEYS: Key[] = [
  { h: 0, ...NIGHT },
  { h: 4.2, ...NIGHT },
  { h: 5.4, top: [0.012, 0.011, 0.045], bottom: [0.032, 0.024, 0.085], glow: [0.03, 0.012, 0.05], tint: [0.95, 0.8, 1.25], stars: 0.9 },
  { h: 6.7, top: [0.022, 0.028, 0.07], bottom: [0.12, 0.05, 0.06], glow: [0.17, 0.07, 0.035], tint: [1.25, 0.9, 0.85], stars: 0.55 },
  { h: 8.2, top: [0.02, 0.042, 0.088], bottom: [0.045, 0.068, 0.105], glow: [0.03, 0.028, 0.02], tint: [1.0, 0.98, 1.05], stars: 0.36 },
  { h: 10, ...DAY },
  { h: 17.8, ...DAY },
  { h: 19.2, top: [0.03, 0.03, 0.068], bottom: [0.14, 0.065, 0.022], glow: [0.18, 0.085, 0.02], tint: [1.3, 0.95, 0.7], stars: 0.5 },
  { h: 20.5, top: [0.012, 0.011, 0.034], bottom: [0.032, 0.02, 0.042], glow: [0.025, 0.01, 0.012], tint: [1.0, 0.85, 1.1], stars: 0.85 },
  { h: 21.6, ...NIGHT },
  { h: 24, ...NIGHT },
]

const ease = (t: number) => t * t * (3 - 2 * t)
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

export interface SkyState { top: V3; bottom: V3; glow: V3; tint: V3; stars: number }

export function skyAt(hour: number): SkyState {
  const h = ((hour % 24) + 24) % 24
  let i = 0
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++
  const a = KEYS[i]!, b = KEYS[i + 1]!
  const t = ease(Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h))))
  return { top: lerp3(a.top, b.top, t), bottom: lerp3(a.bottom, b.bottom, t), glow: lerp3(a.glow, b.glow, t), tint: lerp3(a.tint, b.tint, t), stars: a.stars + (b.stars - a.stars) * t }
}

/** Low-passes the sky in video time, so a dawn that the time warp crosses in half a
 *  second still unfolds over a couple of seconds on screen. */
export class Sky {
  private state: SkyState | null = null
  update(hour: number, dt: number) {
    const target = skyAt(hour)
    if (!this.state) { this.state = target; return this.state }
    const k = 1 - Math.exp(-dt / 0.9)
    const s = this.state
    s.top = lerp3(s.top, target.top, k); s.bottom = lerp3(s.bottom, target.bottom, k)
    s.glow = lerp3(s.glow, target.glow, k); s.tint = lerp3(s.tint, target.tint, k)
    s.stars += (target.stars - s.stars) * k
    return s
  }
  get current() { return this.state ?? skyAt(0) }
  post(): { top: Vec4; bottom: Vec4; glow: Vec4; tint: Vec4; stars: number } {
    const s = this.current
    return { top: [...s.top, 0], bottom: [...s.bottom, 0], glow: [...s.glow, 0], tint: [...s.tint, 0], stars: s.stars }
  }
}
