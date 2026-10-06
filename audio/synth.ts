// A tiny offline synth: tuned voices written into stereo buffers, a Freeverb send, sidechain
// ducking, and a gentle master limiter. Deterministic (seeded noise), 48 kHz float.
import { rng } from "../web/sim"

export const SR = 48000
const TAU = Math.PI * 2
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)
const panGains = (p: number): [number, number] => {
  const a = ((p + 1) * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
}

export class Mixer {
  readonly n: number
  readonly L: Float32Array; readonly R: Float32Array
  readonly sL: Float32Array; readonly sR: Float32Array // reverb send
  private ducks: { t: number; depth: number }[] = []
  private rand = rng(99)

  constructor(seconds: number) {
    this.n = Math.ceil(seconds * SR)
    this.L = new Float32Array(this.n); this.R = new Float32Array(this.n)
    this.sL = new Float32Array(this.n); this.sR = new Float32Array(this.n)
  }

  private write(i: number, v: number, pan: number, send: number) {
    if (i < 0 || i >= this.n) return
    const [gl, gr] = panGains(pan)
    this.L[i]! += v * gl; this.R[i]! += v * gr
    this.sL[i]! += v * gl * send; this.sR[i]! += v * gr * send
  }

  /** Kalimba-like tine: a sine with two inharmonic partials that fade faster. */
  pluck(t: number, note: number, pan: number, amp: number) {
    const f = hz(note)
    const start = Math.floor(t * SR), len = Math.floor(2.4 * SR)
    for (let k = 0; k < len; k++) {
      const s = k / SR
      const att = Math.min(1, s / 0.003)
      const v = Math.sin(TAU * f * s) * Math.exp(-s / 0.55)
        + 0.22 * Math.sin(TAU * f * 3.01 * s) * Math.exp(-s / 0.09)
        + 0.07 * Math.sin(TAU * f * 5.97 * s) * Math.exp(-s / 0.035)
      this.write(start + k, v * att * amp, pan, 0.35)
    }
  }

  /** Subagent: a short rising swell that matches the visual anticipation, then a shimmer. */
  spawn(t: number, note: number, pan: number, amp: number) {
    const rise = 0.16
    const f1 = hz(note)
    const start = Math.floor(t * SR)
    let ph = 0
    for (let k = 0; k < rise * SR; k++) {
      const u = k / (rise * SR)
      const f = f1 * Math.pow(2, (u - 1) * 1.0) // glide up an octave into the note
      ph += (TAU * f) / SR
      this.write(start + k, Math.sin(ph) * u * u * amp * 0.45, pan, 0.4)
    }
    const at = start + Math.floor(rise * SR)
    const partials = [12, 19, 24, 28]
    partials.forEach((p, j) => {
      const f = hz(note + p) * (1 + (this.rand() - 0.5) * 0.004)
      const delay = Math.floor(j * 0.022 * SR)
      const len = Math.floor(0.9 * SR)
      const g = amp * 0.32 / (1 + j * 0.6)
      for (let k = 0; k < len; k++) {
        const s = k / SR
        const v = Math.sin(TAU * f * s) * Math.exp(-s / (0.28 - j * 0.04)) * Math.min(1, s / 0.002)
        this.write(at + delay + k, v * g, pan + (j % 2 ? 0.12 : -0.12), 0.65)
      }
    })
    this.duck(t + rise, 0.22)
  }

  /** Cross-session prompt: band-passed air sweeping across the stereo field. */
  whoosh(t: number, dur: number, from: number, to: number, amp: number) {
    const start = Math.floor(t * SR), len = Math.floor(dur * SR)
    let low = 0, band = 0, air1 = 0, air2 = 0
    for (let k = 0; k < len; k++) {
      const u = k / len
      const s = u * u * u * (u * (u * 6 - 15) + 10) // same minimum-jerk travel as the comet
      const fc = 300 * Math.pow(6, Math.sin(Math.PI * Math.min(1, u * 1.15)))
      const fq = 2 * Math.sin((Math.PI * fc) / SR)
      const x = this.rand() * 2 - 1
      low += fq * band
      const high = x - low - 0.35 * band
      band += fq * high
      const env = Math.pow(Math.sin(Math.PI * u), 1.6)
      // two gentle low-passes keep it air, not hiss
      air1 += 0.32 * (band - air1); air2 += 0.32 * (air1 - air2)
      this.write(start + k, air2 * env * amp * 1.4, from + (to - from) * s, 0.45)
    }
    this.duck(t + dur * 0.5, 0.3)
  }

  /** FM bell: the arrival of a cross-session prompt. */
  bell(t: number, note: number, pan: number, amp: number) {
    const f = hz(note)
    const start = Math.floor(t * SR), len = Math.floor(3 * SR)
    for (let k = 0; k < len; k++) {
      const s = k / SR
      const idx = 2.2 * Math.exp(-s / 0.25)
      const v = Math.sin(TAU * f * s + idx * Math.sin(TAU * f * 3.5 * s)) * Math.exp(-s / 0.9) * Math.min(1, s / 0.002)
      this.write(start + k, v * amp, pan, 0.55)
    }
  }

  /** Kit's prompts: a soft felted low note. */
  felt(t: number, note: number, pan: number, amp: number) {
    const f = hz(note)
    const start = Math.floor(t * SR), len = Math.floor(0.9 * SR)
    for (let k = 0; k < len; k++) {
      const s = k / SR
      const v = (Math.sin(TAU * f * s) + 0.25 * Math.sin(TAU * 2 * f * s) * Math.exp(-s / 0.08)) * Math.exp(-s / 0.3) * Math.min(1, s / 0.008)
      this.write(start + k, v * amp, pan, 0.25)
    }
  }

  /** A wooden, filtered tick: the odometer's wheel settling. Soft attack, no click. */
  tick(t: number, amp: number, pan: number) {
    const start = Math.floor(t * SR), len = Math.floor(0.06 * SR)
    const f = 1900 + this.rand() * 200
    for (let k = 0; k < len; k++) {
      const s = k / SR
      const env = Math.min(1, s / 0.0015) * Math.exp(-s / 0.012)
      const v = Math.sin(TAU * f * s) * 0.6 + Math.sin(TAU * f * 1.51 * s) * 0.4 * Math.exp(-s / 0.005)
      this.write(start + k, v * env * amp, pan, 0.25)
    }
  }

  /** A faint high glint for agent-to-agent notes. */
  glint(t: number, note: number, pan: number, amp: number) {
    const f = hz(note)
    const start = Math.floor(t * SR), len = Math.floor(0.5 * SR)
    for (let k = 0; k < len; k++) {
      const s = k / SR
      this.write(start + k, Math.sin(TAU * f * s) * Math.exp(-s / 0.12) * Math.min(1, s / 0.003) * amp, pan, 0.7)
    }
  }

  /** Camera moment: a breathy open fifth that swells with the push-in and blooms. */
  swell(t: number, dur: number, note: number, amp: number) {
    const start = Math.floor(t * SR), len = Math.floor(dur * SR)
    const notes = [note - 12, note - 5, note, note + 7]
    const ph = notes.map(() => this.rand())
    let lp = 0
    for (let k = 0; k < len; k++) {
      const u = k / len
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.25)), 2) * (u > 0.8 ? 1 - (u - 0.8) / 0.2 : 1)
      const cutoff = 300 + 2200 * env
      const a = 1 - Math.exp((-TAU * cutoff) / SR)
      let v = 0
      notes.forEach((n, j) => {
        ph[j] = (ph[j]! + hz(n) / SR) % 1
        v += ph[j]! * 2 - 1
      })
      lp += a * (v / notes.length - lp)
      this.write(start + k, lp * env * amp, Math.sin(TAU * 0.6 * (k / SR)) * 0.4, 0.6)
    }
    this.duck(t + dur * 0.5, 0.2)
  }

  /** The final chord under the end card: soft electric-piano partials with a long tail. */
  chord(t: number, notes: number[], amp: number) {
    const start = Math.floor(t * SR), len = Math.floor(Math.max(0.5, this.n / SR - t) * SR)
    notes.forEach((n, j) => {
      const f = hz(n)
      const pan = (j / (notes.length - 1)) - 0.5
      const delay = Math.floor(j * 0.045 * SR)
      for (let k = 0; k < len - delay; k++) {
        const s = k / SR
        const v = (Math.sin(TAU * f * s) + 0.3 * Math.sin(TAU * 2 * f * s) * Math.exp(-s / 0.4)) * Math.exp(-s / 2.6) * Math.min(1, s / 0.01)
        this.write(start + delay + k, v * amp, pan, 0.6)
      }
    })
  }

  private duck(t: number, depth: number) { this.ducks.push({ t, depth }) }
  private duckGain(times: Float32Array) {
    // a smooth sidechain envelope: 30 ms attack, 450 ms release, deepest event wins
    const g = new Float32Array(times.length).fill(1)
    for (const d of this.ducks) {
      const i0 = Math.max(0, Math.floor((d.t - 0.03) * 100)), i1 = Math.min(g.length, Math.floor((d.t + 0.6) * 100))
      for (let i = i0; i < i1; i++) {
        const s = i / 100 - d.t
        const e = s < 0 ? 1 + s / 0.03 : Math.exp(-s / 0.18)
        g[i] = Math.min(g[i]!, 1 - d.depth * Math.max(0, e))
      }
    }
    return g
  }

  /** Warm pad: I–vi–IV–V in D, breathing with smoothed activity; resolves home in the outro. */
  pad(activity: Float32Array, outroAt: number) {
    const env = new Float32Array(activity.length)
    let e = 0, max = 1e-6
    const smooth = new Float32Array(activity.length)
    for (let i = 0; i < activity.length; i++) { e += (activity[i]! - e) * (1 - Math.exp(-0.01 / 0.25)); smooth[i] = e; max = Math.max(max, e) }
    let s2 = 0
    for (let i = 0; i < activity.length; i++) { s2 += (Math.pow(smooth[i]! / max, 0.5) - s2) * (1 - Math.exp(-0.01 / 2.5)); env[i] = s2 }
    const duck = this.duckGain(env)
    const chords = [[38, 50, 57, 62, 66], [35, 47, 54, 59, 62], [31, 43, 50, 55, 59], [33, 45, 52, 57, 61]]
    const BAR = 8
    const voices = chords[0]!.map(() => ({ ph1: this.rand(), ph2: this.rand(), lp1: 0, lp2: 0 }))
    const end = this.n / SR
    for (let k = 0; k < this.n; k++) {
      const s = k / SR
      const bi = Math.min(env.length - 1, Math.floor(s * 100))
      const bar = s >= outroAt ? 0 : Math.floor(s / BAR) % 4
      const prevBar = s >= outroAt ? (Math.floor(outroAt / BAR) % 4) : (bar + 3) % 4
      const into = s >= outroAt ? (s - outroAt) : s % BAR
      const xf = Math.min(1, into / 1.6) // chords crossfade over 1.6 s
      const fadeIn = Math.min(1, s / 2.5)
      const fadeOut = Math.min(1, Math.max(0, (end - s) / 2.5))
      const breath = 0.85 + 0.15 * Math.sin(TAU * 0.07 * s)
      const amp = (0.035 + 0.11 * env[bi]!) * breath * fadeIn * fadeOut * (0.55 + 0.45 * duck[bi]!)
      const cutoff = 260 + 1100 * env[bi]!
      const a = 1 - Math.exp((-TAU * cutoff) / SR)
      let l = 0, r = 0
      voices.forEach((v, j) => {
        const note = chords[bar]![j]! * xf + chords[prevBar]![j]! * (1 - xf)
        const f = hz(note)
        v.ph1 = (v.ph1 + (f * 1.0021) / SR) % 1
        v.ph2 = (v.ph2 + (f * 0.9979) / SR) % 1
        const saw = (v.ph1 * 2 - 1) + (v.ph2 * 2 - 1)
        v.lp1 += a * (saw - v.lp1)
        v.lp2 += a * (v.lp1 - v.lp2)
        const p = (j / (voices.length - 1)) * 1.2 - 0.6
        const [gl, gr] = panGains(p)
        l += v.lp2 * gl; r += v.lp2 * gr
      })
      const g = amp / voices.length
      this.L[k]! += l * g; this.R[k]! += r * g
      this.sL[k]! += l * g * 0.35; this.sR[k]! += r * g * 0.35
    }
  }

  /** Message texture: density becomes a tuned granular rain, never individual clicks. */
  grains(density: Float32Array, noteAt: (bin: number) => number) {
    const duck = this.duckGain(density)
    let d = 0
    const SCALE = [0, 2, 4, 7, 9, 12]
    for (let i = 0; i < density.length; i++) {
      d += (density[i]! - d) * (1 - Math.exp(-0.01 / 0.12))
      if (d < 0.02) continue
      // grains per 10 ms bin grow with sqrt(density) and stay capped
      const want = Math.min(1.6, Math.sqrt(d) * 0.55)
      let count = Math.floor(want) + (this.rand() < want % 1 ? 1 : 0)
      const amp = 0.022 * Math.min(1.4, 0.5 + Math.sqrt(d) * 0.35) * duck[i]!
      while (count-- > 0) {
        const note = noteAt(i) + SCALE[Math.floor(this.rand() * SCALE.length)]!
        const f = hz(note)
        const len = Math.floor((0.012 + this.rand() * 0.03) * SR)
        const start = Math.floor((i / 100 + this.rand() * 0.01) * SR)
        const pan = (this.rand() * 2 - 1) * 0.7
        for (let k = 0; k < len; k++) {
          const w = 0.5 - 0.5 * Math.cos((TAU * k) / len)
          this.write(start + k, Math.sin((TAU * f * k) / SR) * w * amp, pan, 0.7)
        }
      }
    }
  }

  render(): Uint8Array {
    const [rl, rr] = freeverb(this.sL, this.sR)
    const out = new Float32Array(this.n * 2)
    let peak = 0
    for (let i = 0; i < this.n; i++) {
      const l = this.L[i]! + rl[i]! * 0.9
      const r = this.R[i]! + rr[i]! * 0.9
      out[i * 2] = l; out[i * 2 + 1] = r
      peak = Math.max(peak, Math.abs(l), Math.abs(r))
    }
    // Normalize to -3 dBFS peak, then a soft knee above -6 dBFS keeps transients from clipping.
    const g = 0.7 / Math.max(peak, 1e-6)
    for (let i = 0; i < out.length; i++) {
      const x = out[i]! * g
      const ax = Math.abs(x)
      out[i] = ax < 0.5 ? x : Math.sign(x) * (0.5 + 0.45 * Math.tanh((ax - 0.5) / 0.45))
    }
    return wavFloat(out, 2)
  }
}

function freeverb(inL: Float32Array, inR: Float32Array): [Float32Array, Float32Array] {
  const k = SR / 44100
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
  const aps = [556, 441, 341, 225]
  const room = 0.86, damp = 0.3, pre = Math.floor(0.025 * SR)
  const chan = (input: Float32Array, spread: number) => {
    const out = new Float32Array(input.length)
    const cs = combs.map((c) => ({ buf: new Float32Array(Math.floor((c + spread) * k)), i: 0, lp: 0 }))
    const as = aps.map((c) => ({ buf: new Float32Array(Math.floor((c + spread) * k)), i: 0 }))
    for (let n = 0; n < input.length; n++) {
      const x = (n >= pre ? input[n - pre]! : 0) * 0.015
      let y = 0
      for (const c of cs) {
        const o = c.buf[c.i]!
        c.lp = o * (1 - damp) + c.lp * damp
        c.buf[c.i] = x + c.lp * room
        c.i = (c.i + 1) % c.buf.length
        y += o
      }
      for (const a of as) {
        const b = a.buf[a.i]!
        a.buf[a.i] = y + b * 0.5
        y = b - y
        a.i = (a.i + 1) % a.buf.length
      }
      out[n] = y
    }
    return out
  }
  return [chan(inL, 0), chan(inR, 23)]
}

function wavFloat(samples: Float32Array, channels: number): Uint8Array {
  const data = samples.length * 4
  const buf = new ArrayBuffer(44 + data)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE")
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, channels, true)
  v.setUint32(24, SR, true); v.setUint32(28, SR * channels * 4, true); v.setUint16(32, channels * 4, true); v.setUint16(34, 32, true)
  str(36, "data"); v.setUint32(40, data, true)
  new Float32Array(buf, 44).set(samples)
  return new Uint8Array(buf)
}
