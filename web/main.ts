import type { EventLog } from "../shared/events"
import { Sim } from "./sim"
import { createGpu } from "./gpu"
import { createScene } from "./scene"
import { createAtlas } from "./text"

const q = new URLSearchParams(location.search)
const width = Number(q.get("w") ?? 1920)
const height = Number(q.get("h") ?? 1080)
const duration = Number(q.get("duration") ?? 75)
const fps = Number(q.get("fps") ?? 60)
const capture = q.has("capture")
const dataFile = q.get("data") ?? "events-2026-10-05.json"

const log: EventLog = await (await fetch(`/data/${dataFile}`)).json()
const titles = q.has("titles") && log.meta.titles

const canvas = document.querySelector("canvas")!
canvas.width = width
canvas.height = height
if (capture) canvas.style.display = "none"
else {
  const fit = () => {
    const k = Math.min(innerWidth / width, innerHeight / height)
    canvas.style.width = `${width * k}px`
    canvas.style.height = `${height * k}px`
  }
  fit()
  addEventListener("resize", fit)
}

const gpu = await createGpu(width, height, capture ? null : canvas)
const atlas = createAtlas()

// The log stores times relative to local midnight of the first day, and the renderer
// formats in that same zone regardless of where the browser runs.
const tz = log.meta.tzOffsetMinutes
const local = (ms: number) => new Date(ms - tz * 60_000)
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const scene = createScene(width, height, atlas, {
  titles,
  dateLabel: (ms) => {
    const d = local(ms)
    return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`.toUpperCase()
  },
  hourOf: (ms) => {
    const d = local(ms)
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  },
  timeLabel: (ms) => {
    const d = local(ms)
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
  },
})

const sim = new Sim(log, { duration, outro: duration >= 60 ? 7 : 5 })
const scale = Math.min(width, height) / 1080
const totalFrames = Math.round(duration * fps)

function renderFrame(f: number) {
  sim.advanceTo(f / fps)
  sim.sampleTrail()
  const { count, overCount, cam, sky } = scene.build(sim, 1 / fps)
  if (atlas.takeDirty()) gpu.uploadAtlas(atlas.canvas)
  gpu.render(scene.data, count, scene.overData, overCount, {
    cam: [cam.x, cam.y], zoom: cam.zoom, time: f / fps, bloom: 1, exposure: 1.05,
    // shutter of half a frame along the camera's screen-space velocity
    blur: [-cam.vx * cam.zoom * scale / fps * 0.5, -cam.vy * cam.zoom * scale / fps * 0.5],
    grain: 0.022,
    ...sky.post(),
  })
}

let frameIndex = 0
;(window as any).__info = { totalFrames, stats: log.meta.stats }
;(window as any).__capture = async (opts: { start?: number; end?: number; stills?: number[]; endpoint?: string }) => {
  const start = opts.start ?? 0
  const end = Math.min(opts.end ?? totalFrames, totalFrames)
  const stills = new Set(opts.stills ?? [])
  const video = opts.endpoint !== undefined
  let pending: Promise<unknown> = Promise.resolve()
  let ws: WebSocket | null = null
  let inflight = 0
  let queued = 0
  let wake: (() => void) | null = null
  if (video) {
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.binaryType = "arraybuffer"
    await new Promise((r) => (ws!.onopen = r))
    ws.onmessage = (m) => {
      if (m.data === "ack") { inflight--; wake?.() }
      if (m.data === "flushed") { wake?.() }
    }
  }
  const prof: number[] = [0, 0, 0, 0]
  ;(window as any).__prof = prof
  for (let f = 0; f < end; f++) {
    // frames before `start` still run so the simulation reaches the same state
    if (f < start && !stills.has(f)) { sim.advanceTo(f / fps); sim.sampleTrail(); scene.build(sim, 1 / fps); continue }
    const t0 = performance.now()
    renderFrame(f)
    const t1 = performance.now()
    if ((video && f >= start) || stills.has(f)) {
      const isStill = stills.has(f), isVideo = video && f >= start
      const stillPixels = isStill && isVideo ? (await gpu.read("rgba")).pixels : null
      const { pixels } = await gpu.read(isVideo ? "yuv" : "rgba")
      const t2 = performance.now()
      // Sends stay ordered: each waits for the previous frame's. Bound the backlog so
      // rendering can't run ahead of the encoder and pile up frames in memory.
      if (++queued > 16) await pending
      const prev = pending
      pending = pixels.then(async (px) => {
        const body = px as Uint8Array<ArrayBuffer>
        const tm = performance.now()
        prof[4] = (prof[4] ?? 0) + (tm - t2)
        await prev
        const tf = performance.now()
        if (isStill) await fetch(`/still?f=${f}`, { method: "POST", body: ((await stillPixels) ?? body) as Uint8Array<ArrayBuffer> })
        if (isVideo) {
          while (inflight > 12) await new Promise<void>((r) => (wake = r))
          inflight++
          ws!.send(body)
        }
        queued--
        prof[5] = (prof[5] ?? 0) + (performance.now() - tf)
      })
      prof[0] = prof[0]! + t1 - t0; prof[1] = prof[1]! + t2 - t1; prof[3] = prof[3]! + 1
    }
  }
  await pending
  while (inflight > 0) await new Promise<void>((r) => (wake = r))
  ws?.close()
  return { frames: end - start, prof: prof.map((v, i) => (i !== 3 ? v / Math.max(1, prof[3]!) : v)) }
}

if (!capture) {
  const t0 = Number(q.get("t") ?? 0)
  while (frameIndex < t0 * fps) { sim.advanceTo(frameIndex / fps); sim.sampleTrail(); scene.build(sim, 1 / fps); frameIndex++ }
  const loop = () => {
    renderFrame(frameIndex)
    frameIndex = (frameIndex + 1) % totalFrames
    requestAnimationFrame(loop)
  }
  loop()
}
;(window as any).__ready = true
