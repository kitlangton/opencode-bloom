// Frame-exact video export: serves the WebGPU renderer, drives headless Chrome (real GPU)
// frame by frame, and pipes raw RGBA into ffmpeg.
//   bun render.ts --data events-2026-10-05.json --out out.mp4 [--width 1920 --height 1080 --fps 60 --duration 75]
//   bun render.ts --stills 10,30,60 --still-dir out/stills   (PNG frames at those seconds, no video)
//   bun render.ts --serve   (open the live preview in a browser)
import { parseArgs } from "node:util"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { chromium } from "playwright"
import index from "./web/index.html"

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
    serve: { type: "boolean", default: false },
    port: { type: "string", default: "8517" },
  },
})

const W = Number(a.width), H = Number(a.height), FPS = Number(a.fps)
const root = import.meta.dir
let ffmpeg: ReturnType<typeof Bun.spawn> | null = null
let received = 0
const stillsAt = (a.stills ?? "").split(",").filter(Boolean).map((s) => Math.round(Number(s) * FPS))
const stillDir = resolve(a["still-dir"]!)

async function writePng(px: Uint8Array, file: string) {
  mkdirSync(dirname(file), { recursive: true })
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", "-", "-frames:v", "1", file], { stdin: "pipe" })
  p.stdin.write(px)
  await p.stdin.end()
  await p.exited
}

// Frames arrive over one WebSocket (ordered, far cheaper than a POST per frame).
let sinkChain: Promise<unknown> = Promise.resolve()
const server = Bun.serve({
  port: Number(a.port),
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
    "/data/:file": (req) => new Response(Bun.file(join(root, "data", req.params.file))),
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

const params = new URLSearchParams({ w: String(W), h: String(H), fps: String(FPS), duration: a.duration!, data: a.data! })
if (a.titles) params.set("titles", "")

if (a.serve) {
  console.log(`preview: http://localhost:${server.port}/?${params}`)
} else {
  params.set("capture", "")
  if (a.out) {
    mkdirSync(dirname(resolve(a.out)), { recursive: true })
    ffmpeg = Bun.spawn([
      "ffmpeg", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", a.crf!, "-pix_fmt", "yuv420p",
      "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-x264-params", "aq-mode=3:aq-strength=0.9", "-movflags", "+faststart",
      resolve(a.out),
    ], { stdin: "pipe", stdout: "inherit", stderr: "inherit" })
  }
  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-gpu", "--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
  })
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (e) => console.error("pageerror", e.message))
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error("console", m.text()) })
  await page.goto(`http://localhost:${server.port}/?${params}`)
  await page.waitForFunction(() => (window as any).__ready, null, { timeout: 60_000 })
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
    await ffmpeg.exited
    console.log("wrote", a.out)
  }
  server.stop(true)
  process.exit(0)
}
