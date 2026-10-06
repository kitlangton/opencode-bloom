import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { validateDatabase } from "./database"

let dir: string
let path: string
beforeEach(() => {
  const base = join(tmpdir(), "opencode")
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, "bloom-db-test-"))
  path = join(dir, "history.db")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const create = (sql: string) => {
  const db = new Database(path)
  try { db.exec(sql) } finally { db.close() }
}
const valid = `
  create table session_v2 (id text, parent_id text, directory text, project_id text, title text, time_created integer, fork_session_id text);
  create table session_message (session_id text, type text, time_created integer, data text);
  create table project (id text, worktree text);
`

test("missing history explains V2 installation without creating a database", () => {
  expect(() => validateDatabase(path)).toThrow("database not found")
  expect(() => validateDatabase(path)).toThrow("https://opencode.ai/v2/docs/")
  expect(() => validateDatabase(path)).toThrow("--db /path/to/opencode.db")
  expect(existsSync(path)).toBe(false)
})

test("V1 history is rejected without changing it", () => {
  create("create table session (id text); create table message (id text);")
  const before = readFileSync(path)
  expect(() => validateDatabase(path)).toThrow("missing table: session_v2")
  expect(() => validateDatabase(path)).toThrow("OpenCode V1 history is not supported")
  expect(readFileSync(path)).toEqual(before)
})

test("accepts an empty but compatible V2 database, read-only", () => {
  create(valid)
  const before = readFileSync(path)
  expect(() => validateDatabase(path)).not.toThrow()
  expect(readFileSync(path)).toEqual(before)
})

test("checks message and project tables, not only the V2 session table", () => {
  create(valid)
  const db = new Database(path)
  db.exec("drop table session_message")
  db.close()
  expect(() => validateDatabase(path)).toThrow("missing table: session_message")
})

test("checks the columns used by the extractor", () => {
  create(valid.replace(", fork_session_id text", ""))
  expect(() => validateDatabase(path)).toThrow("missing session_v2 columns: fork_session_id")
})

test("a non-SQLite file gets actionable guidance, not raw SQLite output", () => {
  writeFileSync(path, "not a database")
  expect(() => validateDatabase(path)).toThrow("https://opencode.ai/v2/docs/")
  expect(readFileSync(path, "utf8")).toBe("not a database")
})

test("the CLI exits before extraction or browser setup with V1 history", async () => {
  create("create table session (id text)")
  const out = join(dir, "movie.mp4")
  const p = Bun.spawn([process.execPath, resolve(import.meta.dir, "../bin/opencode-bloom.ts"), "--db", path,
    "--date", "2026-10-05", "--out", out], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  expect(await p.exited).toBe(1)
  expect(stderr).toContain("Bloom requires OpenCode V2 history")
  expect(stderr).toContain("https://opencode.ai/v2/docs/")
  expect(stdout).not.toContain("Extracting")
  expect(stdout).not.toContain("Chromium")
  expect(existsSync(out)).toBe(false)
})
