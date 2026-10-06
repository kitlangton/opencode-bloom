export const EV = {
  created: 0, // a session first appears (root, or a child whose parent predates the window)
  subagent: 1, // x = parent session index
  crossPrompt: 2, // x = origin session index (an independent session prompted or created by another)
  user: 3, // x = 1 when Kit typed it, 0 when a parent session wrote it
  assistant: 4,
  tool: 5, // x = tool kind index
  file: 6, // x = index into log.files: a file basename the session edited
} as const

// Tool kinds drive spark color: read, write, run, web, delegate, other.
export const TOOL_KINDS: string[][] = [
  ["read", "grep", "glob", "canvas_read"],
  ["edit", "write", "patch", "canvas_upsert_card"],
  ["shell", "execute"],
  ["websearch", "webfetch"],
  ["subagent", "skill", "question", "opencode_image_generate", "opencode_image_edit"],
]

export interface Cluster {
  label: string
  parent: number | null
  worktree: boolean
}

export interface SessionNode {
  cluster: number
  parent: number | null
  created: number
  title?: string
}

export interface EventLog {
  meta: {
    from: number
    to: number
    tzOffsetMinutes: number
    titles: boolean
    stats: Record<string, number>
  }
  clusters: Cluster[]
  sessions: SessionNode[]
  /** basenames of edited files (public-safe: no directories, no secrets-looking names) */
  files?: string[]
  /** [ms since meta.from, EV type, session index, extra] */
  events: [number, number, number, number][]
}
