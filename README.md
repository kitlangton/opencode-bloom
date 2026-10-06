# session bloom

A Gource-style film of a day (or a week) of OpenCode sessions. Projects form constellations. Sessions bloom into lit orbs, and subagents spring out of their parents. Kit's prompts beam from a small warm star, and when one session prompts another, a gold comet crosses the sky. A procedural score plays along with the same events.

## Stack

The renderer is WebGPU through [vgpu](https://vgpu.sh), run in headless Chrome on the real GPU. The audio is a small offline TypeScript synth. Both use one deterministic TypeScript simulation, stepped at a fixed 1/480 s.

Why not Psychopomp: Psychopomp is built for authored explainer beats: actors, channels and spring plans. This film is a force layout of hundreds of bodies plus thousands of sparks per second, all driven by data. One instanced draw of screen-space quads with an HDR bloom chain fits that better, and the same page also works as a live preview. The capture loop renders a frame, packs it to yuv420p on the GPU, reads it back through a ring of buffers and streams it over a WebSocket to ffmpeg. That runs at about 25 to 30 fps at 1080p.

## Extract (read-only)

```sh
bun extract/extract.ts --from 2026-10-05                 # one local day
bun extract/extract.ts --from 2026-09-29 --to 2026-10-05 # a range
bun extract/extract.ts --from 2026-10-05 --titles        # private cut; writes *.private.json
```

The extractor opens `~/.local/share/opencode/opencode.db` read-only (`session_v2`, `session_message`, `project`) and writes `data/events-*.json`. Each event has a time, a type, a session and one extra field:

- Event types: `created`, `subagent` (parent to child), `crossPrompt` (taken from `metadata["anomaly.session"].originSessionID`), `user` (Kit or a parent session), `assistant` and `tool`.
- Labels are the last path segment of each directory. Worktrees hang off their main checkout.
- Session titles are left out unless you pass `--titles`.
- Model identifiers are never written. A denylist built from the model IDs in the DB redacts any matching label or title, and the extractor refuses to write output if one leaks.

## Render (one command)

```sh
bun render.ts --out out/day.mp4                                      # 1920x1080, 60 fps, 75 s, with audio
bun render.ts --width 1080 --height 1080 --duration 30 --out out/x.mp4  # square cut for X
bun render.ts --stills 30.6 --still-dir out/stills --width 3840 --height 2160  # poster frames (seconds)
bun render.ts --serve                                                # live preview in a browser
```

Flags:

- `--data <file in data/>`
- `--width`, `--height` (multiples of 4)
- `--fps`
- `--duration` in seconds. The whole range is time-warped so busy stretches play slower.
- `--titles` (needs a private extract)
- `--crf`
- `--no-audio`
- `--start` / `--end` render a sub-range of seconds.

## What's on screen

- **Clock and counters:** an odometer clock and three counters (sessions, subagents, messages). They use Psychopomp's `settle` spring, carry right to left a beat apart, and blur with speed.
- **Sky:** the background follows the log's real clock: night, indigo pre-dawn, warm dawn, a cool dark day, amber dusk, then night again.
- **Camera moments:** the most significant subagent bursts (3+ from one parent within 4 minutes) slow the time warp. The camera eases out, then in, and the project's label lifts.
- **Kit:** a warm comet that flies an arc to each session he prompts. Parent-to-subagent and cross-project prompts are cooler, dimmer comets.
- **Tool sparks:** one glyph and color per kind (read, edit, shell, web, delegate). Edited file names drift off sessions, heavily rate-limited.
- **Session life cycle:** idle sessions cool, and finished subagents stop orbiting.
- **Tilt:** a slow 3D tilt with shallow depth of field that flattens for the end card.
- **Activity strip:** messages per minute along the bottom, with a playhead.
- **End card:** the counters roll up to the day's totals and the camera holds on the full map.

## Sound

`audio/score.ts` replays the simulation and camera. It turns events into notes and pans each one by the node's x position on screen. `audio/synth.ts` renders the result.

- **New sessions:** kalimba plucks, one D-major pentatonic note per project. They are rate-limited into arpeggios.
- **Subagents:** a rising swell timed with the visual anticipation, then a shimmer.
- **Kit's prompts:** soft felt notes.
- **Cross-session prompts:** filtered air that sweeps across the stereo field and lands on an FM bell.
- **Messages and tools:** never individual clicks. Their density drives a tuned granular texture.
- **Comet arrivals:** Kit's land as felt notes, agent comets as faint glints, cross-project ones as a bell.
- **Counters:** odometer ticks, soft and capped. Camera moments get a slow swell. The end card gets a rising run of ticks and a closing chord.
- **Pad:** a warm I–vi–IV–V that breathes with overall activity and resolves home in the outro.

Busy moments duck the pad and the texture. Everything feeds a Freeverb send, then a soft limiter. The mux step normalizes to -16 LUFS integrated with a true peak of -1.5 dBTP.
