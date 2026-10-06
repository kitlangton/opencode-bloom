import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EventLog } from "../shared/events"

test("extract counts actual messages once, excludes fork copies and preserves cost precision", async () => {
  const root = join(tmpdir(), "opencode")
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, "bloom-extract-test-"))
  const path = join(dir, "fixture.db"), out = join(dir, "events.json")
  const db = new Database(path)
  try {
    db.exec(`
      create table project (id text, worktree text);
      create table session_v2 (id text, parent_id text, directory text, project_id text,
        title text, time_created integer, fork_session_id text);
      create table session_message (session_id text, type text, time_created integer, data text);
    `)
    const start = Date.parse("2026-10-05T00:00:00Z")
    const session = db.query("insert into session_v2 values (?, ?, ?, ?, ?, ?, ?)")
    session.run("root", null, "/project", "p", "private title", start, null)
    session.run("fork", null, "/project", "p", "private fork", start + 2000, "root")
    db.query("insert into project values (?, ?)").run("p", "/project")
    const message = db.query("insert into session_message values (?, ?, ?, ?)")
    const info = (cost?: number) => JSON.stringify({ cost, time: { completed: start + 3000 }, content: [] })
    message.run("root", "assistant", start + 1000, info(0.0199))
    message.run("fork", "assistant", start + 1000, info(0.0199)) // copied history
    message.run("fork", "assistant", start + 2500, info(0.0002)) // new inference
    message.run("root", "assistant", start + 4000, info()) // unknown price
    message.run("root", "assistant", start + 5000, info(0)) // valid zero price
    db.close()
    const p = Bun.spawn(["bun", join(import.meta.dir, "extract.ts"), "--from", "2026-10-05", "--db", path, "--out", out], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TZ: "UTC" } })
    const err = await new Response(p.stderr).text()
    expect(await p.exited, err).toBe(0)
    const log: EventLog = await Bun.file(out).json()
    expect(log.meta.stats.assistantMessages).toBe(4)
    expect(log.costs).toEqual([[3000, 0.0199], [3000, 0.0002]])
    expect(log.meta.stats.recordedCostUSD).toBeCloseTo(0.0201, 6)
    expect(log.meta.stats.unpricedMessages).toBe(1)
    expect(log.sessions.every((s) => s.title === undefined)).toBe(true)
  } finally {
    db.close()
    rmSync(dir, { recursive: true }) // only this test's generated directory
  }
})
