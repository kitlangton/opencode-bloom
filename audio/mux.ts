import { rename, unlink } from "node:fs/promises"

export async function normalizeAndMux(video: string, wav: string, encoder: string, run: (command: string[]) => Promise<string>) {
  const target = "I=-16:TP=-1.5:LRA=11"
  const measure = await run([encoder, "-hide_banner", "-nostats", "-i", wav, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"])
  const m = JSON.parse(measure.slice(measure.lastIndexOf("{"), measure.lastIndexOf("}") + 1))
  // Silence has no finite integrated loudness; leave it silent instead of feeding -inf to loudnorm.
  const finite = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].every((v) => Number.isFinite(Number(v)))
  const norm = finite ? `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` : "anull"
  const tmp = video.replace(/\.mp4$/, ".mux.mp4")
  // Explicit stereo negotiation also works with the bundled FFmpeg 4.x binary.
  await run([encoder, "-loglevel", "error", "-y", "-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
    "-af", `${norm},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`, "-ac", "2",
    "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", tmp])
  await rename(tmp, video)
  await unlink(wav)
}
