import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

const REQUIREMENT = "Bloom requires OpenCode V2 history; OpenCode V1 history is not supported."
const INSTALL = "Install or upgrade OpenCode V2: https://opencode.ai/v2/docs/"

const schema = {
  session_v2: ["id", "parent_id", "directory", "project_id", "title", "time_created", "fork_session_id"],
  session_message: ["session_id", "type", "time_created", "data"],
  project: ["id", "worktree"],
}

export function validateDatabase(path: string) {
  const fail = (reason: string): never => {
    throw new Error(`${reason}\n${REQUIREMENT}\n${INSTALL}\nIf V2 is already installed, use --db /path/to/opencode.db to select its database.`)
  }
  if (!existsSync(path)) fail(`OpenCode database not found: ${path}.`)
  let db: Database
  try {
    db = new Database(path, { readonly: true })
  } catch {
    return fail(`Cannot open the OpenCode database: ${path}. Check the path and read permissions.`)
  }
  try {
    let tables: Set<string>
    try {
      tables = new Set(db.query<{ name: string }, []>("select name from sqlite_master where type='table'").all().map((row) => row.name))
    } catch {
      return fail(`Cannot read the database: ${path}. It may not be a valid SQLite database.`)
    }
    for (const [table, required] of Object.entries(schema)) {
      if (!tables.has(table)) fail(`This database is not compatible with Bloom (missing table: ${table}).`)
      let columns: Set<string>
      try {
        columns = new Set(db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((row) => row.name))
      } catch {
        return fail(`Cannot inspect the database schema: ${path}.`)
      }
      const missing = required.filter((column) => !columns.has(column))
      if (missing.length) fail(`This database is not compatible with Bloom (missing ${table} columns: ${missing.join(", ")}).`)
    }
  } finally {
    db.close()
  }
}
