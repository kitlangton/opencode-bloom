import { expect, test } from "bun:test"
import { EV, type EventLog } from "../shared/events"
import { Sim } from "./sim"

const log: EventLog = {
  meta: { from: 0, to: 60_000, tzOffsetMinutes: 0, titles: false, stats: {} },
  clusters: [{ label: "example", parent: null, worktree: false }],
  sessions: [{ cluster: 0, parent: null, created: 0 }],
  events: [[0, EV.created, 0, -1], [30_000, EV.assistant, 0, 0]],
  costs: [[0, 0.1234], [30_000, 0.5678], [59_999, 1.0001]],
}

test("cost follows recorded timestamps without changing the activity warp", () => {
  const s = new Sim(log, { duration: 10, outro: 2 })
  const old = new Sim({ ...log, costs: undefined }, { duration: 10, outro: 2 })
  expect(s.warp.toVideo(30_000)).toBe(old.warp.toVideo(30_000))
  s.advanceTo(1)
  expect(s.recordedCostUSD).toBe(0)
  s.advanceTo(s.warp.toVideo(30_000) + 0.01)
  expect(s.recordedCostUSD).toBeCloseTo(0.6912, 6)
  s.advanceTo(10)
  expect(s.recordedCostUSD).toBeCloseTo(1.6913, 6)
})

test("old logs remain compatible and cents are rounded only after summing", () => {
  const s = new Sim({ ...log, costs: undefined }, { duration: 10, outro: 2 })
  s.advanceTo(10)
  expect(s.recordedCostUSD).toBe(0)
  const tiny = new Sim({ ...log, costs: [[0, 0.004], [0, 0.004]] }, { duration: 10, outro: 2 })
  tiny.advanceTo(10)
  expect(Math.round(tiny.recordedCostUSD * 100)).toBe(1)
})
