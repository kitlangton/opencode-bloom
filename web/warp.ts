// Maps real time to video time so busy stretches play slowly and quiet ones skip by,
// with a smooth rate (no visible lurches in the clock).
export interface Warp {
  /** video seconds at which the event stream starts and ends */
  start: number
  end: number
  /** real ms (relative to log start) -> video seconds */
  toVideo(ms: number): number
  /** video seconds -> real ms */
  toReal(sec: number): number
}

/** `boosts` slow time around chosen real moments: [ms, extra rate, sigma in minutes] */
export function buildWarp(times: number[], spanMs: number, start: number, end: number, boosts: [number, number, number][] = []): Warp {
  const BIN = 60_000
  const n = Math.ceil(spanMs / BIN)
  const raw = new Float64Array(n)
  for (const t of times) raw[Math.min(n - 1, Math.max(0, Math.floor(t / BIN)))]! += 1
  // Gaussian smoothing, sigma = 10 minutes.
  const sigma = 10
  const kernel: number[] = []
  for (let k = -3 * sigma; k <= 3 * sigma; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)))
  const sm = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0
    kernel.forEach((kv, j) => {
      const idx = i + j - 3 * sigma
      if (idx >= 0 && idx < n) { s += raw[idx]! * kv; w += kv }
    })
    sm[i] = s / w
  }
  let max = 0
  for (const v of sm) max = Math.max(max, v)
  const rate = Array.from(sm, (v, i) => {
    let r = 0.07 + Math.pow(v / (max || 1), 0.6)
    for (const [ms, extra, sig] of boosts) {
      const d = (i + 0.5 - ms / BIN) / sig
      r += extra * Math.exp(-0.5 * d * d)
    }
    return r
  })
  const cum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i]! + rate[i]!
  const total = cum[n]!
  const dur = end - start
  const toVideo = (ms: number) => {
    const f = Math.min(n, Math.max(0, ms / BIN))
    const i = Math.min(n - 1, Math.floor(f))
    return start + ((cum[i]! + (f - i) * rate[i]!) / total) * dur
  }
  const toReal = (sec: number) => {
    const u = Math.min(1, Math.max(0, (sec - start) / dur)) * total
    let lo = 0, hi = n
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! <= u) lo = mid
      else hi = mid
    }
    return (lo + (u - cum[lo]!) / rate[lo]!) * BIN
  }
  return { start, end, toVideo, toReal }
}
