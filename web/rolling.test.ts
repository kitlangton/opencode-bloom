import { describe, expect, test } from "bun:test"
import { Clock, Counter, MoneyCounter } from "./rolling"

const goals = (c: Clock) => [c.hourTens, c.hourOnes, c.tens, c.ones].map((w) => w.pos.goal)
const velocities = (c: Clock, t: number) => [c.hourTens, c.hourOnes, c.tens, c.ones].map((w) => w.sample(t).velocity)

describe("independent clock digits", () => {
  test("one minute changes only minute ones", () => {
    const c = new Clock()
    c.set(0, 12, 31)
    c.set(1, 12, 32)
    expect(goals(c)).toEqual([1, 2, 3, 2])
    expect(velocities(c, 1.2).slice(0, 3)).toEqual([0, 0, 0])
    expect(velocities(c, 1.2)[3]).toBeGreaterThan(0)
  })
  test("minute carry moves only minute digits", () => {
    const c = new Clock()
    c.set(0, 12, 39)
    c.set(1, 12, 40)
    expect(goals(c)).toEqual([1, 2, 4, 10])
    expect(velocities(c, 1.2).slice(0, 2)).toEqual([0, 0])
  })
  test("12 to 13 holds the unchanged hour tens", () => {
    const c = new Clock()
    c.set(0, 12, 59)
    c.set(1, 13, 0)
    expect(goals(c)).toEqual([1, 3, 6, 10])
    expect(velocities(c, 1.3)[0]).toBe(0)
    expect(velocities(c, 1.3)[1]).toBeGreaterThan(0)
    expect(c.hourRolls).toBe(1)
  })
  test("09 to 10 and 23 to 00 carry both hour wheels", () => {
    const c = new Clock()
    c.set(0, 9, 59)
    c.set(1, 10, 0)
    expect(goals(c)).toEqual([1, 10, 6, 10])
    c.set(3, 23, 59)
    c.set(5, 0, 0)
    expect(goals(c)).toEqual([3, 20, 12, 20])
  })
  test("repeated readings do not restart a wheel", () => {
    const c = new Clock()
    c.set(0, 12, 31)
    c.set(1, 12, 32)
    const expected = c.ones.pos.sample(1.3)
    c.set(1.1, 12, 32)
    expect(c.ones.pos.sample(1.3)).toEqual(expected)
  })
})

const faces = (c: Counter, t: number) => c.sample(t).columns
  .sort((a, b) => a.x - b.x)
  .map((p) => p.glyphs.find((g) => Math.abs(g.dy) < 1e-6)?.text).join("")

describe("recorded cost counter", () => {
  test("fixed cents, including zero and sub-dollar values", () => {
    const c = new MoneyCounter()
    c.set(0, 0)
    expect(faces(c, 0)).toBe("000")
    c.set(1, 9)
    expect(faces(c, 2)).toBe("009")
    c.set(3, 105)
    expect(faces(c, 4)).toBe("105")
    expect(c.sample(4).decimalX).toBeCloseTo(1.21)
  })
  test("thousands separator is in dollars, not cents", () => {
    const c = new MoneyCounter()
    c.set(0, 149888)
    const { columns, commas, decimalX } = c.sample(0)
    expect(faces(c, 0)).toBe("149888")
    expect(commas).toHaveLength(1)
    expect(commas[0]!.x).toBeCloseTo(columns[5]!.x + 1.21)
    expect(decimalX).toBeCloseTo(columns[2]!.x + 1.21)
  })
  test("one cent leaves higher places stationary", () => {
    const c = new MoneyCounter()
    c.set(0, 12345)
    c.set(1, 12346)
    expect(c.sample(1.2).columns.slice(1).map((p) => p.velocity)).toEqual([0, 0, 0, 0])
  })
})
