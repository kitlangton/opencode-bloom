import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ffmpeg from "@ffmpeg-installer/ffmpeg"
import { Mixer } from "./synth"
import { normalizeAndMux } from "./mux"

for (const silent of [false, true]) test(`bundled encoder muxes ${silent ? "silent" : "synthesized"} stereo audio`, async () => {
  const root = join(tmpdir(), "opencode")
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, "bloom-mux-test-"))
  const video = join(dir, "video.mp4"), wav = join(dir, "score.wav")
  const run = async (command: string[]) => {
    const p = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    if (await p.exited) throw new Error(err)
    return out + err
  }
  try {
    await run([ffmpeg.path, "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=10:d=3", "-c:v", "libx264", "-threads", "2", video])
    const synth = new Mixer(3)
    if (!silent) for (let t = 0; t < 2.5; t += 0.4) synth.pluck(t, 62, 0, 0.2)
    await Bun.write(wav, synth.render())
    await normalizeAndMux(video, wav, ffmpeg.path, run)
    const diagnostic = await run([ffmpeg.path, "-hide_banner", "-i", video, "-f", "null", "-"])
    expect(diagnostic).toContain("Audio: aac")
    expect(diagnostic).toContain("48000 Hz, stereo")
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)
