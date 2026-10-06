import { parseArgs } from "node:util"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function parseOptions(args: string[], now = new Date()) {
  const { values: a } = parseArgs({ args, options: {
    date: { type: "string" },
    quality: { type: "string", default: "1080p" },
    square: { type: "boolean", default: false },
    duration: { type: "string" },
    fps: { type: "string", default: "60" },
    out: { type: "string" },
    db: { type: "string" },
    label: { type: "string", default: "you" },
    "no-audio": { type: "boolean", default: false },
    "no-cost": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  } })
  if (a.help) return { mode: "help" as const }
  if (a.version) return { mode: "version" as const }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const date = a.date ?? localDate(yesterday)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use --date YYYY-MM-DD.")
  const [year, month, day] = date.split("-").map(Number)
  if (localDate(new Date(year!, month! - 1, day!)) !== date) throw new Error(`Invalid date: ${date}`)
  if (a.quality !== "1080p" && a.quality !== "4k") throw new Error("Use --quality 1080p or --quality 4k.")
  const duration = Number(a.duration ?? (a.square ? 30 : 75))
  if (!Number.isFinite(duration) || duration < 10 || duration > 600) throw new Error("Duration must be between 10 and 600 seconds.")
  const fps = Number(a.fps)
  if (fps !== 30 && fps !== 60) throw new Error("Use --fps 30 or --fps 60.")
  const height = a.quality === "4k" ? 2160 : 1080
  const width = a.square ? height : a.quality === "4k" ? 3840 : 1920
  const out = resolve(a.out ?? `opencode-bloom-${date}${a.square ? "-square" : ""}${a.quality === "4k" ? "-4k" : ""}.mp4`)
  if (!out.toLowerCase().endsWith(".mp4")) throw new Error("The output path must end in .mp4.")
  if (existsSync(out)) throw new Error(`Output already exists: ${out}. Choose another --out path.`)
  if (!a.label.trim() || a.label.length > 32 || /[\x00-\x1f\x7f]/.test(a.label)) throw new Error("Label must be 1–32 printable characters.")
  const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
  const db = a.db ? resolve(a.db) : resolve(dataDir, process.env.OPENCODE_DB || "opencode.db")
  return { mode: "render" as const, date, width, height, duration, fps, out, db, label: a.label,
    audio: !a["no-audio"], cost: !a["no-cost"], crf: a.quality === "4k" ? 12 : 14 }
}
