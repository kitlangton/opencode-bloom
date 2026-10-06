// Procedural score for a render: replays the same deterministic simulation and camera as
// the video, turns events into notes, and synthesizes a stereo WAV.
//   bun audio/score.ts --data events-2026-10-05.json --duration 75 --width 1920 --height 1080 --out out/x.wav
import { parseArgs } from "node:util"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { EV, type EventLog } from "../shared/events"
import { Sim } from "../web/sim"
import { createScene } from "../web/scene"
import { Mixer } from "./synth"

const { values: a } = parseArgs({
  options: {
    data: { type: "string", default: "events-2026-10-05.json" },
    duration: { type: "string", default: "75" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    fps: { type: "string", default: "60" },
    out: { type: "string", default: "out/score.wav" },
  },
})

const W = Number(a.width), H = Number(a.height), FPS = Number(a.fps), D = Number(a.duration)
const log: EventLog = await Bun.file(join(import.meta.dir, "../data", a.data!)).json()
const sim = new Sim(log, { duration: D, outro: D >= 60 ? 7 : 5 })
// Text is irrelevant to sound; a stub atlas lets the scene (and so the camera) run headless.
const atlas: any = { get: (s: string, px: number) => ({ uv: [0, 0, 1, 1], w: s.length * px * 0.6 + 4, h: px * 1.4, ascent: px }), pad: () => 2, takeDirty: () => false }
const scene = createScene(W, H, atlas, { titles: false, dateLabel: () => "", timeLabel: () => "00:00", hourOf: () => 0 })

type Hit = { e: [number, number, number, number]; t: number }
const hits: Hit[] = []
sim.onEvent = (e, t) => hits.push({ e, t })

const mix = new Mixer(D + 3)
// A pentatonic home key (D major pentatonic); every project owns one degree of it.
const SCALE = [0, 2, 4, 7, 9]
const ROOT = 62 // D4
const noteOf = (cluster: number, octave = 0) => {
  const deg = (cluster * 3) % SCALE.length
  const oct = Math.floor(((cluster * 3) / SCALE.length) % 2)
  return ROOT + SCALE[deg]! + 12 * (oct + octave)
}
const panOf = (n: number, cam: { x: number; y: number; zoom: number }) => {
  const node = sim.nodes[n]!
  const u = Math.min(W, H) / 1080
  const x = (node.x - cam.x) * cam.zoom * u + W / 2
  return Math.max(-0.85, Math.min(0.85, (x / W) * 2 - 1))
}

// Rate limits: plucks and spawns queue into a short arpeggio instead of stacking.
let lastPluck = -1, lastSpawn = -1, lastKit = -1, lastGlint = -1, lastTick = -1, lastMsgStep = 0
const lastCount = { sessions: 0, subagents: 0 }
const activity = new Float32Array(Math.ceil((D + 3) * 100)) // 10 ms bins, for pad + texture
const texture = new Float32Array(activity.length)
const texCluster = new Int16Array(activity.length).fill(-1)

for (let f = 0; f < D * FPS; f++) {
  hits.length = 0
  sim.advanceTo(f / FPS)
  sim.sampleTrail()
  const { cam } = scene.build(sim, 1 / FPS)
  // Arrivals: Kit's comet lands as a felt note; agent comets as a faint high glint;
  // cross-project comets on a bell.
  for (const c of sim.cues.splice(0)) {
    const pan = panOf(c.node, cam)
    const cl = sim.nodes[c.node]!.cluster
    if (c.kind === "kit" && c.time - lastKit > 0.12) { lastKit = c.time; mix.felt(c.time, noteOf(cl, -1), pan, 0.12) }
    else if (c.kind === "agent" && c.time - lastGlint > 0.09) { lastGlint = c.time; mix.glint(c.time, noteOf(cl, 2), pan, 0.035) }
    else if (c.kind === "cross") mix.bell(c.time, noteOf(cl, 1), pan, 0.16)
  }
  // The odometer: a very soft tick when a wheel settles, never more than ~14/s.
  for (const k of ["sessions", "subagents"] as const) {
    if (sim.counts[k] !== lastCount[k]) { lastCount[k] = sim.counts[k]; if (f / FPS - lastTick > 0.07) { lastTick = f / FPS; mix.tick(f / FPS + 0.18, k === "sessions" ? 0.05 : 0.035, -0.75) } }
  }
  const msgStep = Math.floor(sim.counts.messages / 100)
  if (msgStep !== lastMsgStep) { lastMsgStep = msgStep; if (f / FPS - lastTick > 0.07) { lastTick = f / FPS; mix.tick(f / FPS + 0.2, 0.025, -0.65) } }
  for (const { e, t } of hits) {
    const [, type, n, x] = e
    const cluster = sim.nodes[n]!.cluster
    const bin = Math.min(activity.length - 1, Math.floor(t * 100))
    if (type === EV.assistant || type === EV.tool || type === EV.user) texCluster[bin] = cluster
    switch (type) {
      case EV.created: {
        const at = Math.max(t, lastPluck + 0.075)
        if (at - t > 0.5) break
        lastPluck = at
        mix.pluck(at, noteOf(cluster), panOf(n, cam), 0.34)
        activity[bin]! += 3
        break
      }
      case EV.subagent: {
        const at = Math.max(t, lastSpawn + 0.06)
        const crowded = at - t > 0.35
        lastSpawn = crowded ? lastSpawn : at
        mix.spawn(crowded ? t : at, noteOf(cluster, 1), panOf(n, cam), crowded ? 0.12 : 0.26)
        activity[bin]! += 4
        break
      }
      case EV.crossPrompt: {
        const from = panOf(x, cam), to = panOf(n, cam)
        mix.whoosh(t, 1.1, from, to, 0.2)
        activity[bin]! += 3
        break
      }
      case EV.user: {
        activity[bin]! += 1.5
        texture[bin]! += 1
        break
      }
      case EV.assistant:
        activity[bin]! += 0.4
        texture[bin]! += 0.6
        break
      case EV.tool:
        activity[bin]! += 0.15
        texture[bin]! += 0.35
        break
    }
  }
}

// Camera moments: a slow swell that rises with the push-in and resolves on the bloom.
for (const m of sim.moments) mix.swell(m.at - 2.0, 4.6, noteOf(m.cluster), 0.16)
// End card: the counters roll up on a rising run of soft ticks, then the map settles on a chord.
{
  const at = sim.warp.end + 0.25 + 0.9
  for (let i = 0; i < 16; i++) mix.tick(at + 0.2 + i * 0.075 * (1 + i * 0.05), 0.03 + i * 0.002, -0.4 + (i % 3) * 0.4)
  mix.chord(at + 1.9, [ROOT - 12, ROOT, ROOT + 4, ROOT + 7, ROOT + 14], 0.09)
}
mix.pad(activity, sim.warp.end)
// grain pitch follows the project that produced the latest message, so the rain is tuned
let held = 0
const grainNote = Int16Array.from(texCluster, (c) => (held = c >= 0 ? c : held))
mix.grains(texture, (bin) => noteOf(grainNote[bin]!, 1))
const wav = mix.render()
mkdirSync(dirname(a.out!), { recursive: true })
writeFileSync(a.out!, wav)
console.log("wrote", a.out)
