// Odometer reels in the manner of @kitlangton/rolling-number and Psychopomp's `rolling.rs`:
// each wheel follows a critically damped settle (ω = 10 / duration) that inherits velocity on
// retarget, wheels only advance when the value grows, and changed places cascade from the
// right one short beat apart. Time only moves forward here, so each track keeps one move.

/** Psychopomp's `math::dynamics::settle`, verbatim. */
export function settle(from: number, target: number, velocity: number, duration: number, elapsed: number): [number, number] {
  if (duration <= 0 || elapsed >= duration) return [target, 0]
  const t = Math.max(0, elapsed) / duration
  const distance = from - target
  const limit = (Math.max(Math.abs(distance), 1) * 12) / duration
  const inherited = Math.min(limit, Math.max(-limit, velocity)) * duration
  const coefficient = inherited + 10 * distance
  const decay = Math.exp(-10 * t)
  return [target + (distance + coefficient * t) * decay, ((inherited - 10 * coefficient * t) * decay) / duration]
}

export class Track {
  private at = -Infinity
  private delay = 0
  private duration = 0
  private from: number
  private target: number
  private velocity = 0
  constructor(initial: number) { this.from = this.target = initial }

  sample(t: number): [number, number] {
    const local = t - this.at - this.delay
    if (local <= 0) return [this.from, 0]
    return settle(this.from, this.target, this.velocity, this.duration, local)
  }
  get goal() { return this.target }
  resting(t: number) { return t >= this.at + this.delay + this.duration }
  to(t: number, target: number, duration: number, delay = 0) {
    const [p, v] = this.sample(t)
    this.at = t; this.delay = delay; this.duration = duration
    this.from = p; this.velocity = v; this.target = target
  }
}

/** Nearest wheel position showing `face` that only ever advances (for growing values). */
export function rollTarget(position: number, face: number, faces: number) {
  let target = Math.floor(position / faces) * faces + face
  if (target < position - 0.001) target += faces
  return target
}

export interface Glyph { text: string; dy: number; alpha: number }
export interface Column { x: number; glyphs: Glyph[]; smear: number; opacity: number; rise: number; velocity: number }

/** A wheel with an arbitrary list of faces ("0".."9", or "00".."23" for an hour reel). */
export class Wheel {
  readonly pos: Track
  constructor(readonly faces: string[], initial: number) { this.pos = new Track(initial) }
  set(t: number, face: number, duration: number, delay: number) {
    const target = rollTarget(this.pos.goal, face, this.faces.length)
    if (Math.abs(target - this.pos.goal) < 1e-6) return false
    // a moving wheel redirects at once; a resting one waits its turn in the carry
    this.pos.to(t, target, duration, this.pos.resting(t) ? delay : 0)
    return true
  }
  /** One extra revolution (or more) landing on the same face: the end-card roll. */
  spin(t: number, turns: number, duration: number, delay: number) {
    this.pos.to(t, this.pos.goal + turns * this.faces.length, duration, delay)
  }
  sample(t: number): { glyphs: Glyph[]; smear: number; velocity: number } {
    const [p, v] = this.pos.sample(t)
    const n = this.faces.length
    const glyphs: Glyph[] = []
    for (let k = Math.floor(p) - 1; k <= Math.floor(p) + 2; k++) {
      const dy = k - p
      if (Math.abs(dy) >= 1.25) continue
      glyphs.push({ text: this.faces[((k % n) + n) % n]!, dy, alpha: 1 })
    }
    // fast reels crossfade into a smear, full at 24 rows/s
    const smear = Math.min(1, Math.max(0, (Math.abs(v) - 4) / 20))
    return { glyphs, smear, velocity: v }
  }
}

const DIGITS = "0123456789".split("")

/** A growing, comma-grouped integer whose places glide left as it gains digits. */
export class Counter {
  private places: { wheel: Wheel; opacity: Track; rise: Track; x: Track; born: number }[] = []
  private value = -1
  constructor(readonly duration = 0.5, readonly stagger = 0.06) {}

  get current() { return this.value }

  set(t: number, value: number) {
    if (value === this.value) return
    const s = String(Math.max(0, Math.floor(value)))
    let rank = 0
    for (let i = 0; i < s.length; i++) {
      const d = Number(s[s.length - 1 - i])
      const place = this.places[i]
      if (!place) {
        // new leading digits rise in from below after space starts opening
        const p = { wheel: new Wheel(DIGITS, d), opacity: new Track(0), rise: new Track(0.6), x: new Track(this.slot(i, s.length)), born: t }
        const delay = this.value < 0 ? 0 : this.stagger * (rank + 1)
        p.opacity.to(t, 1, this.duration * 0.8, delay)
        p.rise.to(t, 0, this.duration, delay)
        if (this.value < 0) { p.opacity = new Track(1); p.rise = new Track(0) }
        this.places.push(p)
        rank++
      } else if (place.wheel.set(t, d, this.duration, this.stagger * rank)) rank++
    }
    this.value = value
    this.places.forEach((p, i) => {
      const x = this.slot(i, s.length)
      if (Math.abs(p.x.goal - x) > 1e-6) p.x.to(t, x, this.duration)
    })
  }

  /** x of place i (0 = ones) in digit advances, measured from the left of the number. */
  private slot(i: number, len: number) {
    const lead = len - 1 - i
    const commasBefore = Math.floor((len - 1) / 3) - Math.floor(i / 3)
    return lead + commasBefore * 0.42
  }

  /** Spin every place one extra turn, right to left: the end-card roll-up. */
  spin(t: number, duration: number, stagger: number) {
    this.places.forEach((p, i) => p.wheel.spin(t, 1, duration, i * stagger))
  }

  width(t: number) {
    let w = 0
    for (const p of this.places) w = Math.max(w, p.x.sample(t)[0] + 1)
    return w
  }

  /** Columns in digit-advance units plus the grouping commas. */
  sample(t: number): { columns: Column[]; commas: { x: number; opacity: number }[] } {
    const columns: Column[] = this.places.map((p) => {
      const w = p.wheel.sample(t)
      return { x: p.x.sample(t)[0], glyphs: w.glyphs, smear: w.smear, velocity: w.velocity, opacity: Math.min(1, p.opacity.sample(t)[0]), rise: p.rise.sample(t)[0] }
    })
    const commas: { x: number; opacity: number }[] = []
    for (let i = 3; i < this.places.length; i += 3) {
      const p = this.places[i]!
      commas.push({ x: p.x.sample(t)[0] + 1.21, opacity: Math.min(1, p.opacity.sample(t)[0]) })
    }
    return { columns, commas }
  }
}

/** HH:MM with an hour reel of 24 faces, a tens-of-minutes reel of 6 and a ones reel of 10. */
export class Clock {
  readonly hour = new Wheel(Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")), 0)
  readonly tens = new Wheel("012345".split(""), 0)
  readonly ones = new Wheel(DIGITS, 0)
  private last = -1
  hourRolls = 0
  constructor(readonly duration = 0.45, readonly stagger = 0.07) {}

  set(t: number, hh: number, mm: number) {
    const key = hh * 60 + mm
    if (key === this.last) return
    if (this.last < 0) {
      this.hour.pos.to(t, hh, 0); this.tens.pos.to(t, Math.floor(mm / 10), 0); this.ones.pos.to(t, mm % 10, 0)
      this.last = key
      return
    }
    // carry cascades from the right, one beat per place
    let rank = 0
    if (this.ones.set(t, mm % 10, this.duration, 0)) rank++
    if (this.tens.set(t, Math.floor(mm / 10), this.duration, this.stagger * rank)) rank++
    if (this.hour.set(t, hh, this.duration * 1.25, this.stagger * rank)) this.hourRolls++
    this.last = key
  }
}
