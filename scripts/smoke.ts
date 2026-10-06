// Packed-consumer proof: bun scripts/smoke.ts /absolute/path/opencode-bloom-0.1.0.tgz
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const tar = resolve(process.argv[2] ?? "opencode-bloom-0.1.0.tgz")
const tempRoot = join(tmpdir(), "opencode")
mkdirSync(tempRoot, { recursive: true })
const root = mkdtempSync(join(tempRoot, "bloom-consumer-"))
const run = async (command: string[]) => {
  const p = Bun.spawn(command, { cwd: root, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") }, stdout: "inherit", stderr: "inherit" })
  if (await p.exited) throw new Error(`Failed: ${command[0]}`)
}
try {
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "bloom-consumer-proof", private: true }))
  await run([process.execPath, "add", tar])
  await run([process.execPath, "x", "--no-install", "opencode-bloom", "--help"])
  const legacy = join(root, "legacy.db")
  const legacyDb = new Database(legacy)
  legacyDb.exec("create table session (id text)")
  legacyDb.close()
  const invalid = join(root, "invalid.db")
  await Bun.write(invalid, "not a SQLite database")
  for (const db of [join(root, "missing.db"), legacy, invalid]) {
    const p = Bun.spawn([process.execPath, "x", "--no-install", "opencode-bloom", "--db", db],
      { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    if (await p.exited !== 1 || !err.includes("Bloom requires OpenCode V2 history") || !err.includes("https://opencode.ai/v2/docs/") || out.includes("Chromium"))
      throw new Error(`Missing actionable database warning for ${db}`)
  }
  console.log("PASS: installed CLI rejects missing, V1 and invalid databases with the V2 installation link.")
  const dbPath = join(root, "fixture.db")
  const db = new Database(dbPath)
  const start = new Date(2026, 9, 5).getTime()
  db.exec(`
    create table project (id text, worktree text);
    create table session_v2 (id text, parent_id text, directory text, project_id text,
      title text, time_created integer, fork_session_id text);
    create table session_message (session_id text, type text, time_created integer, data text);
  `)
  db.query("insert into project values (?, ?)").run("p", "/projects/canvas")
  const session = db.query("insert into session_v2 values (?, ?, ?, ?, ?, ?, ?)")
  session.run("root", null, "/projects/canvas", "p", "excluded title", start, null)
  session.run("child", "root", "/projects/canvas", "p", "excluded child", start + 18_000_000, null)
  const message = db.query("insert into session_message values (?, ?, ?, ?)")
  message.run("root", "user", start + 8_000_000, JSON.stringify({ content: [{ type: "text", text: "excluded conversation" }] }))
  for (let i = 0; i < 8; i++) {
    const time = start + 10_000_000 + i * 5_000_000
    message.run(i >= 2 ? "child" : "root", "assistant", time, JSON.stringify({
      cost: 0.015 + i * 0.005, model: { id: "gpt" }, time: { streamed: time, completed: time + 1000 },
      content: [{ type: "tool", name: "edit", state: { input: { filePath: "/projects/canvas/widget.ts" } } }],
    }))
  }
  db.close()
  const out = join(root, "proof.mp4")
  await run([process.execPath, "x", "--no-install", "opencode-bloom", "--date", "2026-10-05", "--db", dbPath,
    "--duration", "10", "--fps", "30", "--out", out])
  const require = createRequire(join(root, "package.json"))
  const ffmpeg: { path: string } = require("@ffmpeg-installer/ffmpeg")
  const p = Bun.spawn([ffmpeg.path, "-hide_banner", "-i", out, "-f", "null", "-"], { stdout: "pipe", stderr: "pipe" })
  const diagnostic = await new Response(p.stderr).text()
  if (await p.exited) throw new Error(`Movie decode failed: ${diagnostic}`)
  for (const required of ["Video: h264", "Audio: aac", "1920x1080", "Duration: 00:00:10.00"])
    if (!diagnostic.includes(required)) throw new Error(`Missing media property: ${required}`)
  console.log("PASS: installed bunx command rendered a 10-second H.264/AAC 1080p movie and decoded every frame.")
} finally {
  rmSync(root, { recursive: true, force: true }) // only this script's temporary consumer
}
