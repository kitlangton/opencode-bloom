import { expect, test } from "bun:test"
import { parseOptions } from "./options"

test("defaults to yesterday, including month and year boundaries", () => {
  const opts = parseOptions([], new Date(2026, 0, 1, 12))
  expect(opts.mode).toBe("render")
  if (opts.mode !== "render") throw new Error("not a render")
  expect(opts.date).toBe("2025-12-31")
  expect([opts.width, opts.height, opts.duration, opts.fps]).toEqual([1920, 1080, 75, 60])
  expect(opts.label).toBe("you")
})

test("4k square has observable geometry and duration defaults", () => {
  const opts = parseOptions(["--date", "2026-10-05", "--quality", "4k", "--square", "--no-cost", "--no-audio"])
  if (opts.mode !== "render") throw new Error("not a render")
  expect([opts.width, opts.height, opts.duration]).toEqual([2160, 2160, 30])
  expect(opts.out.endsWith("opencode-bloom-2026-10-05-square-4k.mp4")).toBe(true)
  expect(opts.cost).toBe(false)
  expect(opts.audio).toBe(false)
})

test("help and version need no database or render options", () => {
  expect(parseOptions(["--help"])).toEqual({ mode: "help" })
  expect(parseOptions(["--version"])).toEqual({ mode: "version" })
})

test("rejects dates, qualities and render settings that cannot work", () => {
  for (const args of [
    ["--date", "2026-02-30"], ["--date", "10/5/2026"], ["--quality", "8k"],
    ["--duration", "NaN"], ["--duration", "-1"], ["--duration", "601"], ["--fps", "24"],
    ["--out", "movie.mov"], ["--label", ""], ["--label", "x\nline"], ["--unknown"],
  ]) expect(() => parseOptions(args)).toThrow()
})
