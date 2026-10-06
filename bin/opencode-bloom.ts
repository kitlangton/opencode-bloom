#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import ffmpeg from "@ffmpeg-installer/ffmpeg"
import { parseOptions } from "../cli/options"
import type { EventLog } from "../shared/events"
import pkg from "../package.json"

const HELP = `opencode-bloom [options]

Render yesterday's local OpenCode V2 activity as an MP4.

  --date YYYY-MM-DD   Day to render (local timezone; default: yesterday)
  --quality 4k       Native 4K export (default: 1080p)
  --square           Square, 30-second cut (default: widescreen, 75 seconds)
  --out video.mp4    Output path (default: opencode-bloom-YYYY-MM-DD.mp4)
  --db path          OpenCode V2 SQLite database
  --label name       Your comet label (default: you)
  --duration 75      Video seconds, 10–600
  --fps 60           30 or 60 fps
  --no-cost          Hide the recorded USD cost counter
  --no-audio         Export without the soundtrack
  -h, --help         Show help
  -v, --version      Show version

Chromium is downloaded on first use. FFmpeg is included as a platform dependency.
Session contents are never uploaded. Review project and file labels before sharing.`

const root = resolve(import.meta.dir, "..")
let child: ReturnType<typeof Bun.spawn> | undefined
let temp: string | undefined
const run = async (args: string[], cwd = temp) => {
  child = Bun.spawn(args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  child = undefined
  if (code !== 0) throw new Error(`Command failed (${code}): ${args[1] ?? args[0]}`)
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  child?.kill(signal)
  // Wait for the renderer to close Chrome before removing its working directory.
  process.exitCode = signal === "SIGINT" ? 130 : 143
})

try {
  const opts = parseOptions(process.argv.slice(2))
  if (opts.mode === "help") console.log(HELP)
  else if (opts.mode === "version") console.log(pkg.version)
  else {
    if (!existsSync(opts.db)) throw new Error(`OpenCode database not found: ${opts.db}. Set --db to your OpenCode V2 database.`)
    const db = new Database(opts.db, { readonly: true })
    try {
      if (!db.query("select name from sqlite_master where type='table' and name='session_v2'").get())
        throw new Error("This release requires OpenCode V2 history (session_v2). This database uses a different schema.")
    } finally { db.close() }
    const tempRoot = join(tmpdir(), "opencode")
    mkdirSync(tempRoot, { recursive: true })
    temp = mkdtempSync(join(tempRoot, "bloom-"))
    const data = join(temp, "events.json")
    console.log(`Extracting ${opts.date}…`)
    await run([process.execPath, join(root, "extract/extract.ts"), "--from", opts.date, "--db", opts.db, "--out", data])
    const log: EventLog = await Bun.file(data).json()
    if (!log.events.length) throw new Error(`No OpenCode activity found for ${opts.date}.`)
    console.log("Checking Chromium (first run downloads the browser)…")
    const playwrightCli = join(dirname(fileURLToPath(import.meta.resolve("playwright/package.json"))), "cli.js")
    await run([process.execPath, playwrightCli, "install", "chromium", "--only-shell"])
    mkdirSync(dirname(opts.out), { recursive: true })
    // Render privately, then move only the finished movie into the requested directory.
    const staged = join(dirname(opts.out), `.opencode-bloom-${process.pid}-${Date.now()}.mp4`)
    try {
      console.log(`Rendering ${opts.width}×${opts.height}, ${opts.fps} fps…`)
      await run([process.execPath, join(root, "render.ts"), "--data", data, "--width", String(opts.width), "--height", String(opts.height),
        "--duration", String(opts.duration), "--fps", String(opts.fps), "--out", staged, "--port", "0", "--ffmpeg", ffmpeg.path,
        "--label", opts.label, "--crf", String(opts.crf), "--threads", "2", ...(opts.audio ? [] : ["--no-audio"]), ...(opts.cost ? [] : ["--no-cost"])])
      // COPYFILE_EXCL also prevents a file created during rendering from being overwritten.
      const fs = await import("node:fs/promises")
      await fs.copyFile(staged, opts.out, (await import("node:fs")).constants.COPYFILE_EXCL)
      console.log(`Wrote ${opts.out}`)
    } finally {
      for (const file of [staged, staged.replace(/\.mp4$/, ".score.wav"), staged.replace(/\.mp4$/, ".mux.mp4")])
        rmSync(file, { force: true })
    }
  }
} catch (error) {
  console.error(`opencode-bloom: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode ||= 1
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true })
}
