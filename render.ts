// Frame-exact video export: serves the WebGPU renderer, drives headless Chrome (real GPU)
// frame by frame, and pipes raw RGBA into ffmpeg.
//   bun render.ts --data events-2026-10-05.json --out out.mp4 [--width 1920 --height 1080 --fps 60 --duration 75]
//   bun render.ts --stills 10,30,60 --still-dir out/stills   (PNG frames at those seconds, no video)
//   bun render.ts --serve   (open the live preview in a browser)
import { parseArgs } from "node:util"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve, isAbsolute } from "node:path"
import { chromium } from "playwright"
import index from "./web/index.html"
import { normalizeAndMux } from "./audio/mux"

const { values: a } = parseArgs({
  options: {
    data: { type: "string", default: "events-2026-10-05.json" },
    out: { type: "string" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    fps: { type: "string", default: "60" },
    duration: { type: "string", default: "75" },
    titles: { type: "boolean", default: false },
    stills: { type: "string" },
    "still-dir": { type: "string", default: "out/stills" },
    start: { type: "string" },
    end: { type: "string" },
    crf: { type: "string", default: "14" },
    threads: { type: "string", default: "2" },
    ffmpeg: { type: "string", default: "ffmpeg" },
    label: { type: "string", default: "you" },
    "no-cost": { type: "boolean", default: false },
    serve: { type: "boolean", default: false },
    port: { type: "string", default: "8517" },
    audio: { type: "boolean", default: true },
    "no-audio": { type: "boolean", default: false },
  },
})

const W = Number(a.width), H = Number(a.height), FPS = Number(a.fps)
const root = import.meta.dir
const dataPath = isAbsolute(a.data!) ? a.data! : join(root, "data", a.data!)
const encoder = a.ffmpeg!
let ffmpeg: ReturnType<typeof Bun.spawn> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const subprocesses = new Set<ReturnType<typeof Bun.spawn>>()
let received = 0
const stillsAt = (a.stills ?? "").split(",").filter(Boolean).map((s) => Math.round(Number(s) * FPS))
const stillDir = resolve(a["still-dir"]!)

async function writePng(px: Uint8Array, file: string) {
  mkdirSync(dirname(file), { recursive: true })
  const p = Bun.spawn([encoder, "-loglevel", "error", "-y", "-probesize", "32", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", "-", "-frames:v", "1", file], { stdin: "pipe" })
  p.stdin.write(px)
  await p.stdin.flush()
  await p.stdin.end()
  if ((await p.exited) !== 0) throw new Error(`PNG encoding failed: ${file}`)
}

// Frames arrive over one WebSocket (ordered, far cheaper than a POST per frame).
let sinkChain: Promise<unknown> = Promise.resolve()
const server = Bun.serve({
  port: Number(a.port),
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws" && srv.upgrade(req)) return
    return new Response("not found", { status: 404 })
  },
  websocket: {
    maxPayloadLength: 256 * 1024 * 1024,
    backpressureLimit: 1024 * 1024 * 1024,
    message(ws, msg) {
      if (typeof msg === "string") {
        if (msg === "flush") sinkChain = sinkChain.then(() => ws.send("flushed"))
        return
      }
      const buf = msg as Uint8Array
      if (buf.length !== (W * H * 3) / 2) { console.error("bad frame size", buf.length); return }
      sinkChain = sinkChain.then(async () => {
        const sink = ffmpeg!.stdin as import("bun").FileSink
        sink.write(buf)
        await sink.flush()
        received++
        if (received % 300 === 0) console.log(`  ${received} frames`)
        ws.send("ack")
      })
    },
  },
  idleTimeout: 0,
  development: false,
  routes: {
    "/": index,
    "/data/events.json": () => new Response(Bun.file(dataPath)),
    "/still": {
      POST: async (req) => {
        const f = Number(new URL(req.url).searchParams.get("f"))
        const file = join(stillDir, `frame-${String(f).padStart(5, "0")}.png`)
        await writePng(new Uint8Array(await req.arrayBuffer()), file)
        console.log("  still", file)
        return new Response("ok")
      },
    },
  },
})

let closing: Promise<void> | undefined
function cleanup() {
  return closing ??= (async () => {
    for (const p of subprocesses) if (p.exitCode === null) p.kill()
    if (ffmpeg?.exitCode === null) ffmpeg.kill()
    await browser?.close().catch(() => {})
    server.stop(true)
  })()
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.on(signal, () => {
  process.exitCode = code
  void cleanup()
})

const params = new URLSearchParams({ w: String(W), h: String(H), fps: String(FPS), duration: a.duration!, data: "events.json", label: a.label! })
if (a.titles) params.set("titles", "")
if (a["no-cost"]) params.set("no-cost", "")

if (a.serve) {
  console.log(`preview: http://localhost:${server.port}/?${params}`)
} else {
  try {
  params.set("capture", "")
  if (a.out) {
    mkdirSync(dirname(resolve(a.out)), { recursive: true })
    ffmpeg = Bun.spawn([
      encoder, "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
      "-c:v", "libx264", "-threads", a.threads!, "-preset", "slow", "-crf", a.crf!, "-pix_fmt", "yuv420p",
      "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-x264-params", "aq-mode=3:aq-strength=0.9", "-movflags", "+faststart",
      resolve(a.out),
    ], { stdin: "pipe", stdout: "inherit", stderr: "inherit" })
  }
  browser = await chromium.launch({
    headless: true,
    args: ["--enable-gpu", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : process.platform === "win32" ? ["--use-angle=d3d11"] : ["--use-angle=vulkan", "--enable-features=Vulkan"])],
  })
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (e) => console.error("pageerror", e.message))
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error("console", m.text()) })
  await page.goto(`http://localhost:${server.port}/?${params}`)
  let pageFailure: string | undefined
  page.on("pageerror", (e) => { pageFailure = e.message })
  try {
    await page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 })
  } catch (error) {
    throw new Error(pageFailure ?? `The renderer could not start. A WebGPU-capable GPU and drivers are required. ${error}`)
  }
  const info = await page.evaluate(() => (window as any).__info)
  console.log("frames", info.totalFrames, info.stats)
  const t0 = performance.now()
  const res = await page.evaluate(
    (o) => (window as any).__capture(o),
    {
      start: a.start ? Math.round(Number(a.start) * FPS) : 0,
      end: a.end ? Math.round(Number(a.end) * FPS) : a.out ? undefined : Math.max(...stillsAt, 0) + 1,
      stills: stillsAt,
      endpoint: a.out ? "/frame" : undefined,
    },
  )
  const secs = (performance.now() - t0) / 1000
  if (res.prof) console.log("ms/frame build, slot-wait, -, n, map-latency, post:", res.prof.map((v: number) => v.toFixed(1)).join(" "))
  console.log(`rendered ${res.frames} frames in ${secs.toFixed(1)} s (${(res.frames / secs).toFixed(1)} fps)`)
  await browser.close()
  if (ffmpeg) {
    await (ffmpeg.stdin as import("bun").FileSink).end()
    if ((await ffmpeg.exited) !== 0) throw new Error("Video encoding failed")
    if (a.audio && !a["no-audio"]) await addScore(resolve(a.out!))
    console.log("wrote", a.out)
  }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode ||= 1
  } finally {
    await cleanup()
  }
}

// Synthesizes the score from the same simulation and muxes it in, loudness-normalized
// (two-pass EBU R128 to -16 LUFS integrated, -1.5 dBTP).
async function addScore(video: string) {
  const wav = video.replace(/\.mp4$/, ".score.wav")
  const run = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    subprocesses.add(p)
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    subprocesses.delete(p)
    if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-2000)}`)
    return out + err
  }
   await run([process.execPath, join(root, "audio/score.ts"), "--data", dataPath, "--duration", a.duration!, "--width", a.width!, "--height", a.height!, "--fps", a.fps!, "--out", wav])
  await normalizeAndMux(video, wav, encoder, run)
}
