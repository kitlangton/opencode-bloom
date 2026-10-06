// Read-only extractor: OpenCode's SQLite store -> compact session event log.
// `bun extract/extract.ts --from 2026-10-05 [--to 2026-10-06] [--titles] [--out data/x.json]`
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { EV, type EventLog, type Cluster, type SessionNode, TOOL_KINDS } from "../shared/events"

const { values: args } = parseArgs({
  options: {
    from: { type: "string", default: "2026-10-05" },
    to: { type: "string" },
    titles: { type: "boolean", default: false },
    db: { type: "string", default: join(homedir(), ".local/share/opencode/opencode.db") },
    out: { type: "string" },
    deny: { type: "string", default: process.env.SESSION_BLOOM_DENY ?? "" },
  },
})

const day = (s: string, offset = 0) => {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y!, m! - 1, d! + offset).getTime()
}
const from = day(args.from!)
const to = day(args.to ?? args.from!, 1)
const out = args.out ?? `data/events-${args.from}${args.to ? `_${args.to}` : ""}${args.titles ? ".private" : ""}.json`

const db = new Database(args.db, { readonly: true })
db.exec("PRAGMA query_only = 1")

// ---- privacy: derive a denylist from model identifiers seen in the DB, never stored in the repo
const GENERIC = new Set(["claude", "opus", "sonnet", "haiku", "gpt", "gemini", "free", "eap", "mini", "pro", "preview", "default", "latest", "flash", "nano", "turbo", "chat", "codex", "high", "low", "medium"])
const modelIds = db.query<{ id: string }, [number, number]>(
  `select distinct json_extract(data,'$.model.id') id from session_message where time_created between ? and ? and type='assistant'`,
).all(from - 30 * 86_400_000, to).map((r) => r.id).filter(Boolean)
const deny = new Set<string>(args.deny!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
for (const id of modelIds) for (const tok of id.toLowerCase().split(/[^a-z0-9]+/)) {
  if (tok.length >= 4 && !/^\d+$/.test(tok) && !GENERIC.has(tok)) deny.add(tok)
}
const denyRe = deny.size ? new RegExp([...deny].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null
const isDenied = (s: string) => !!denyRe && new RegExp(denyRe.source, "i").test(s)
const scrub = (s: string) => (denyRe ? s.replace(denyRe, "•••") : s)

// ---- messages in window
type Row = { sid: string; type: string; t: number; origin: string | null; streamed: number | null; completed: number | null; cost: number | null; tools: string | null; files: string | null }
const rows = db.query<Row, [number, number]>(`
  select m.session_id sid, m.type type, m.time_created t,
    case when m.type='user' then json_extract(m.data,'$.metadata."anomaly.session".originSessionID') end origin,
    case when m.type='assistant' then json_extract(m.data,'$.time.streamed') end streamed,
    case when m.type='assistant' then json_extract(m.data,'$.time.completed') end completed,
    case when m.type='assistant' then json_extract(m.data,'$.cost') end cost,
    case when m.type='assistant' then (select json_group_array(json_extract(c.value,'$.name')) from json_each(m.data,'$.content') c where json_extract(c.value,'$.type')='tool') end tools,
    case when m.type='assistant' then (select json_group_array(coalesce(json_extract(c.value,'$.state.input.filePath'), json_extract(c.value,'$.state.input.path'), '')) from json_each(m.data,'$.content') c where json_extract(c.value,'$.type')='tool') end files
  from session_message m
  join session_v2 s on s.id = m.session_id
  where m.time_created >= ? and m.time_created < ? and m.type in ('user','assistant')
    and (s.fork_session_id is null or m.time_created >= s.time_created)
  order by m.time_created`).all(from, to)

type S = { id: string; parent_id: string | null; directory: string; project_id: string; title: string | null; time_created: number }
const sessionStmt = db.query<S, [string]>(`select id, parent_id, directory, project_id, title, time_created from session_v2 where id = ?`)
const worktreeStmt = db.query<{ worktree: string }, [string]>(`select worktree from project where id = ?`)

const sessions = new Map<string, S>()
const load = (id: string): S | undefined => {
  if (sessions.has(id)) return sessions.get(id)
  const s = sessionStmt.get(id) ?? undefined
  if (s) sessions.set(id, s)
  return s
}
for (const r of rows) load(r.sid)
// Pull in ancestors and session origins so every edge has both endpoints.
for (const r of rows) if (r.origin) load(r.origin)
for (const s of [...sessions.values()]) {
  let cur: S | undefined = s
  while (cur?.parent_id) cur = load(cur.parent_id)
}

// ---- clusters: one per directory; worktrees hang off their project's main checkout
const home = homedir()
const clusters: Cluster[] = []
const clusterIndex = new Map<string, number>()
const labelOf = (dir: string) => {
  const seg = dir.replace(/\/+$/, "").split("/").pop() || "/"
  if (dir === home) return "~"
  return seg
}
let redacted = 0
const cluster = (dir: string, projectId: string | null): number => {
  const hit = clusterIndex.get(dir)
  if (hit !== undefined) return hit
  let parent: number | null = null
  if (projectId) {
    const main = worktreeStmt.get(projectId)?.worktree
    if (main && main !== dir && main !== "/" && dir.includes("/worktree/")) parent = cluster(main, null)
  }
  let label = labelOf(dir)
  if (isDenied(label)) label = `project-${++redacted}`
  const i = clusters.length
  clusters.push({ label, parent, worktree: dir.includes("/worktree/") })
  clusterIndex.set(dir, i)
  return i
}

const nodes: SessionNode[] = []
const nodeIndex = new Map<string, number>()
const firstSeen = new Map<string, number>()
for (const r of rows) if (!firstSeen.has(r.sid)) firstSeen.set(r.sid, r.t)
const node = (id: string): number => {
  const hit = nodeIndex.get(id)
  if (hit !== undefined) return hit
  const s = sessions.get(id)!
  const parent = s.parent_id && sessions.has(s.parent_id) ? node(s.parent_id) : null
  const i = nodes.length
  nodes.push({
    cluster: cluster(s.directory, s.project_id),
    parent,
    created: s.time_created,
    ...(args.titles && s.title ? { title: scrub(s.title) } : {}),
  })
  nodeIndex.set(id, i)
  return i
}
// Stable order: by creation time.
for (const s of [...sessions.values()].sort((a, b) => a.time_created - b.time_created)) node(s.id)

// ---- edited files: basenames only, and nothing that looks like a secret or config
const files: string[] = []
const fileIdx = new Map<string, number>()
const SECRETISH = /env|secret|token|cred|key|passw|auth|\.pem$|\.p12$/i
const fileIndex = (path: string) => {
  const base = path.split("/").pop() ?? ""
  if (!base || base.startsWith(".") || base.length > 40 || SECRETISH.test(base) || isDenied(base)) return -1
  let i = fileIdx.get(base)
  if (i === undefined) { i = files.length; files.push(base); fileIdx.set(base, i) }
  return i
}

// ---- events
const events: [number, number, number, number][] = []
const appeared = new Set<number>()
const toolKind = (name: string) => {
  const k = TOOL_KINDS.findIndex((group) => group.includes(name))
  return k < 0 ? TOOL_KINDS.length : k
}
const appear = (n: number, t: number) => {
  if (appeared.has(n)) return
  const parent = nodes[n]!.parent
  if (parent !== null) appear(parent, t)
  appeared.add(n)
  const spawned = parent !== null && nodes[n]!.created >= from
  events.push([Math.max(from, t), spawned ? EV.subagent : EV.created, n, parent ?? -1])
}

for (const r of rows) {
  const n = node(r.sid)
  appear(n, r.t)
  if (r.type === "user") {
    if (r.origin && sessions.has(r.origin)) {
      const o = node(r.origin)
      appear(o, r.t)
      events.push([r.t, EV.crossPrompt, n, o])
    } else {
      // A subagent's prompt comes from its parent; a root prompt comes from Kit.
      events.push([r.t, EV.user, n, nodes[n]!.parent === null ? 1 : 0])
    }
  } else {
    events.push([r.t, EV.assistant, n, 0])
    const tools: string[] = r.tools ? JSON.parse(r.tools) : []
    const a = r.streamed ?? r.t
    const b = Math.max(a, Math.min(r.completed ?? a, a + 120_000))
    const paths: string[] = r.files ? JSON.parse(r.files) : []
    tools.forEach((name, i) => {
      const t = Math.round(a + ((b - a) * (i + 0.5)) / tools.length)
      events.push([Math.min(t, to - 1), EV.tool, n, toolKind(name)])
      if (name === "edit" || name === "write") {
        const f = fileIndex(paths[i] ?? "")
        if (f >= 0) events.push([Math.min(t, to - 1), EV.file, n, f])
      }
    })
  }
}
events.sort((x, y) => x[0] - y[0] || x[1] - y[1])

const count = (type: number) => events.filter((e) => e[1] === type).length
const costs: [number, number][] = rows
  .filter((r) => r.type === "assistant" && Number.isFinite(r.cost) && r.cost! > 0)
  .map((r) => [Math.min(to - 1, Math.max(r.t, r.completed ?? r.t)) - from, r.cost!] as [number, number])
  .sort((a, b) => a[0] - b[0])
const log: EventLog = {
  meta: {
    from,
    to,
    tzOffsetMinutes: new Date(from).getTimezoneOffset(),
    titles: args.titles!,
    stats: {
      sessions: appeared.size,
      roots: [...appeared].filter((n) => nodes[n]!.parent === null).length,
      subagents: count(EV.subagent),
      crossPrompts: count(EV.crossPrompt),
      userMessages: count(EV.user),
      humanPrompts: events.filter((e) => e[1] === EV.user && e[3] === 1).length,
      assistantMessages: count(EV.assistant),
      toolCalls: count(EV.tool),
      clusters: clusters.length,
      recordedCostUSD: costs.reduce((sum, [, usd]) => sum + usd, 0),
      unpricedMessages: rows.filter((r) => r.type === "assistant" && r.cost === null).length,
    },
  },
  clusters,
  sessions: nodes,
  files,
  costs,
  events: events.map(([t, type, n, x]) => [t - from, type, n, x]),
}

// Never let a model identifier through, whatever the flags.
const serialized = JSON.stringify(log)
for (const id of modelIds) if (serialized.includes(id)) throw new Error("model identifier leaked into event log")
if (denyRe && new RegExp(denyRe.source, "i").test(serialized)) throw new Error("denied token leaked into event log")

mkdirSync("data", { recursive: true })
writeFileSync(out, serialized)
console.log(out, log.meta.stats)
