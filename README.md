# OpenCode Bloom

A Gource-style film of your local OpenCode V2 sessions. Projects form constellations, sessions light up, and subagents branch from their parents. Your prompts travel between them as comets. The soundtrack follows the same activity.

## Run

Install [Bun](https://bun.sh), then render yesterday:

```sh
bunx opencode-bloom
```

Choose a day or a format:

```sh
bunx opencode-bloom --date 2026-10-05
bunx opencode-bloom --date 2026-10-05 --quality 4k
bunx opencode-bloom --date 2026-10-05 --square
```

The default is a 75-second, 1080p/60 fps MP4 with audio, saved in your current directory. `--square` defaults to 30 seconds. `--quality 4k` renders at native 3840×2160, or 2160×2160 for square videos.

The first run downloads Playwright's Chromium into its browser cache. FFmpeg comes through a platform-specific npm dependency, so there is no Homebrew setup or postinstall script to approve. Later renders can run offline. Rendering uses your GPU and can take several minutes.

Requirements: Bun 1.3+, an OpenCode **V2** database, and a working WebGPU-capable GPU. macOS is tested; Linux and Windows rendering is experimental and may require additional browser system libraries or GPU drivers. This release does not read V1 history.

If the database is missing, unreadable or incompatible, Bloom stops before downloading Chromium or rendering and links to the [OpenCode V2 installation guide](https://opencode.ai/v2/docs/). If you already use V2 with a different database path, pass `--db /path/to/opencode.db`. Bloom never migrates or modifies your database.

```sh
bunx opencode-bloom --help
bunx opencode-bloom --date 2026-10-05 --out day.mp4 --label alice
bunx opencode-bloom --date 2026-10-05 --no-cost
bunx opencode-bloom --date 2026-10-05 --db /path/to/opencode.db
```

The database defaults to `$XDG_DATA_HOME/opencode/opencode.db`, or `~/.local/share/opencode/opencode.db`. `OPENCODE_DB` is respected. Days use your local timezone. An existing output file is never overwritten.

## Privacy

The database is opened read-only. Rendering serves the extracted activity on loopback, and no history is uploaded. The CLI removes its temporary extract when it finishes and publishes only the completed MP4 to the output path.

Conversation text, session titles, full directory paths and model IDs are excluded from CLI exports. **Project directory basenames, some edited file basenames, activity times and recorded costs are visible.** Review the video before sharing; automatic redaction is not a guarantee that a label is safe. `--no-cost` hides the cost counter. Your history and videos are excluded from the npm package and this repository.

## Stack

The renderer is WebGPU through [vgpu](https://vgpu.sh), run in headless Chrome on the real GPU. The audio is a small offline TypeScript synth. Both use one deterministic TypeScript simulation, stepped at a fixed 1/480 s.

The capture loop renders a frame, packs it to yuv420p on the GPU, reads it back through a ring of buffers and streams it over a WebSocket to FFmpeg. Video uses H.264, BT.709 color and MP4 fast-start; the soundtrack is AAC. Encoding defaults to two threads to limit CPU contention.

## Develop

```sh
bun install
bun run typecheck
bun run test
bun bin/opencode-bloom.ts --date 2026-10-05
```

## Extract (read-only)

```sh
bun extract/extract.ts --from 2026-10-05                 # one local day
bun extract/extract.ts --from 2026-09-29 --to 2026-10-05 # a range
bun extract/extract.ts --from 2026-10-05 --titles        # private cut; writes *.private.json
```

The extractor opens `~/.local/share/opencode/opencode.db` read-only (`session_v2`, `session_message`, `project`) and writes `data/events-*.json`. Each event has a time, a type, a session and one extra field:

- Event types: `created`, `subagent` (parent to child), `crossPrompt` (taken from `metadata["anomaly.session"].originSessionID`), `user` (you or a parent session), `assistant` and `tool`.
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

- **Clock and counters:** an odometer clock with four independent digit wheels. Unchanged digits stay still. Sessions, subagents, messages and recorded USD cost use the same `settle` spring, carry right to left a beat apart, and blur with speed. Cost has fixed cents, a stationary dollar sign and decimal point.
- **Sky:** the background follows the log's real clock: night, indigo pre-dawn, warm dawn, a cool dark day, amber dusk, then night again.
- **Camera moments:** the most significant subagent bursts (3+ from one parent within 4 minutes) slow the time warp. The camera eases out, then in, and the project's label lifts.
- **Your prompts:** a warm comet that flies an arc to each session you prompt. Parent-to-subagent and cross-project prompts are cooler, dimmer comets.
- **Tool sparks:** one glyph and color per kind (read, edit, shell, web, delegate). Edited file names drift off sessions, heavily rate-limited.
- **Session life cycle:** idle sessions cool, and finished subagents stop orbiting.
- **Tilt:** a slow 3D tilt with shallow depth of field that flattens for the end card.
- **Activity strip:** messages per minute along the bottom, with a playhead.
- **End card:** the counters roll up to the day's totals and the camera holds on the full map.

## Recorded cost

The extractor reads each assistant message's stored `cost` once, including subagents, and skips history copied into forks using OpenCode V2's own stats rule. It does not add session totals, which would double-count those messages. The running total appears as responses complete; cents are rounded only for display, after summing the full-precision amounts. Adding cost does not change the activity time warp.

This is OpenCode's recorded model pricing, **not an invoice or subscription bill**. Zero-price messages add nothing, missing prices are counted in `meta.stats.unpricedMessages`, and other tools' charges are not included. Old extracts without cost data still render with three counters. A response started in the selected day but finished later is placed at the window's end.

## High-quality export

```sh
bun extract/extract.ts --from 2026-10-05 --out data/events-2026-10-05-v4.json
bun render.ts --data events-2026-10-05-v4.json --width 3840 --height 2160 --fps 60 --duration 75 --crf 12 --threads 2 --out out/day-4k.mp4
```

This renders natively at 4K rather than upscaling. H.264 video, BT.709 color, AAC audio and MP4 fast-start keep the output easy to upload. Encoding defaults to two threads to avoid monopolizing a machine shared by build/test jobs. `bun run test` covers independent clock carries, currency formatting and timestamped cost accumulation; `bun run typecheck` checks the full project.

## Sound

`audio/score.ts` replays the simulation and camera. It turns events into notes and pans each one by the node's x position on screen. `audio/synth.ts` renders the result.

- **New sessions:** kalimba plucks, one D-major pentatonic note per project. They are rate-limited into arpeggios.
- **Subagents:** a rising swell timed with the visual anticipation, then a shimmer.
- **Your prompts:** soft felt notes.
- **Cross-session prompts:** filtered air that sweeps across the stereo field and lands on an FM bell.
- **Messages and tools:** never individual clicks. Their density drives a tuned granular texture.
- **Comet arrivals:** your prompts land as felt notes, agent comets as faint glints, cross-project ones as a bell.
- **Counters:** odometer ticks, soft and capped. Camera moments get a slow swell. The end card gets a rising run of ticks and a closing chord.
- **Pad:** a warm I–vi–IV–V that breathes with overall activity and resolves home in the outro.

Busy moments duck the pad and the texture. Everything feeds a Freeverb send, then a soft limiter. The mux step normalizes to -16 LUFS integrated with a true peak of -1.5 dBTP.

## Releases

Releases use version tags, not Changesets. `npm run prepublishOnly` checks the types, tests and packed file list. A matching `vX.Y.Z` tag runs `.github/workflows/release.yml` to publish through npm's GitHub trusted publisher. The package check rejects unexpected files, test sources, private extracts and videos.

## License

MIT for this project. Chromium, FFmpeg and the npm dependencies have their own licenses; FFmpeg is a separate executable, not linked into this code. This is an independent visualization project, not an official OpenCode product.
