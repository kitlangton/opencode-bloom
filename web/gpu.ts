import { initFromDevice, storage, draw, effect, target, frame, sampler, texture, surface, type Gpu } from "vgpu"
import { FLOATS, quadWgsl, downWgsl, blurWgsl, compositeWgsl, blitWgsl, yuvWgsl } from "./shaders"

export const MAX_QUADS = 40000
export const MAX_OVERLAY = 4000

export type Vec4 = [number, number, number, number]
export interface PostParams { cam: [number, number]; zoom: number; time: number; bloom: number; exposure: number; blur: [number, number]; grain: number; stars: number; top: Vec4; bottom: Vec4; glow: Vec4; tint: Vec4 }

export async function createGpu(width: number, height: number, canvas: HTMLCanvasElement | null) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) throw new Error("No WebGPU adapter")
  const device = await adapter.requestDevice()
  ;(globalThis as any).__gpuKeepAlive = { adapter, device }
  device.lost.then((info) => console.error("device lost", info.message))
  const gpu: Gpu = await initFromDevice(device)
  const linear = sampler(gpu, { magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })

  const atlas = texture(gpu, { kind: "2d", size: [4096, 4096], format: "rgba8unorm", usage: ["texture_binding", "copy_dst", "render_attachment"] })
  const quadBuf = storage(gpu, MAX_QUADS * FLOATS * 4)
  const quads = draw(gpu, { shader: quadWgsl, vertices: 6, blend: "premultiplied" })
  quads.set({ quads: quadBuf, view: { size: [width, height], pad: [0, 0] }, atlas, smp: linear })
  // Type and UI draw after tonemapping so they stay crisp and unbloomed.
  const overlayBuf = storage(gpu, MAX_OVERLAY * FLOATS * 4)
  const overlay = draw(gpu, { shader: quadWgsl, vertices: 6, blend: "premultiplied" })
  overlay.set({ quads: overlayBuf, view: { size: [width, height], pad: [0, 0] }, atlas, smp: linear })

  const hdr = "rgba16float" as const
  const scene = target(gpu, { size: [width, height], format: hdr, clearColor: [0, 0, 0, 0] })
  const sz = (d: number): [number, number] => [Math.max(1, Math.round(width / d)), Math.max(1, Math.round(height / d))]
  const half = target(gpu, { size: sz(2), format: hdr })
  const q1a = target(gpu, { size: sz(4), format: hdr }), q1b = target(gpu, { size: sz(4), format: hdr })
  const q2a = target(gpu, { size: sz(8), format: hdr }), q2b = target(gpu, { size: sz(8), format: hdr })
  const q3a = target(gpu, { size: sz(16), format: hdr }), q3b = target(gpu, { size: sz(16), format: hdr })
  const out = target(gpu, { size: [width, height], format: "rgba8unorm" })

  const down = (src: typeof scene, gain = 1) => {
    const e = effect(gpu, downWgsl)
    e.set({ src, smp: linear, params: { texel: [1 / src.size[0], 1 / src.size[1]], gain, pad: 0 } })
    return e
  }
  const blur = (src: typeof scene, dx: number, dy: number) => {
    const e = effect(gpu, blurWgsl)
    e.set({ src, smp: linear, params: { dir: [dx / src.size[0], dy / src.size[1]], pad: [0, 0] } })
    return e
  }
  const chain: [typeof scene, ReturnType<typeof effect>][] = [
    [half, down(scene)],
    [q1a, down(half)],
    [q1b, blur(q1a, 1, 0)],
    [q1a, blur(q1b, 0, 1)],
    [q2a, down(q1a)],
    [q2b, blur(q2a, 1, 0)],
    [q2a, blur(q2b, 0, 1)],
    [q3a, down(q2a)],
    [q3b, blur(q3a, 1, 0)],
    [q3a, blur(q3b, 0, 1)],
  ]
  const composite = effect(gpu, compositeWgsl)
  composite.set({ scene, b1: q1a, b2: q2a, b3: q3a, smp: linear, params: { size: [width, height], cam: [0, 0], zoom: 1, time: 0, bloom: 1, exposure: 1, blur: [0, 0], grain: 0, stars: 1, top: [0, 0, 0, 0], bottom: [0, 0, 0, 0], glow: [0, 0, 0, 0], tint: [1, 1, 1, 0] } })

  if (width % 4 || height % 4) throw new Error("width and height must be multiples of 4")
  const yuv = target(gpu, { size: [width / 4, (height * 3) / 2], format: "rgba8unorm" })
  const toYuv = effect(gpu, yuvWgsl)
  toYuv.set({ src: out, params: { size: [width, height], pad: [0, 0] } })

  const screen = canvas ? surface(gpu, canvas, { dpr: [1, 1] }) : null
  const blit = effect(gpu, blitWgsl)
  blit.set({ src: out, smp: linear })

  const RING = 8
  let ring: { buf: GPUBuffer; busy: Promise<unknown> }[] | null = null
  let ringHead = 0

  return {
    gpu,
    uploadAtlas(source: OffscreenCanvas) {
      device.queue.copyExternalImageToTexture({ source }, { texture: (atlas as any).gpu, premultipliedAlpha: true }, [4096, 4096])
    },
    render(data: Float32Array, count: number, over: Float32Array, overCount: number, post: PostParams) {
      quadBuf.write(data.subarray(0, count * FLOATS) as Float32Array<ArrayBuffer>)
      if (overCount) overlayBuf.write(over.subarray(0, overCount * FLOATS) as Float32Array<ArrayBuffer>)
      composite.set({ params: { size: [width, height], ...post } })
      frame(gpu, (f) => {
        f.pass({ target: scene, clear: [0, 0, 0, 0] }, (p) => { if (count) p.draw(quads, { instances: count }) })
        for (const [dst, e] of chain) f.pass(dst, e)
        f.pass(out, composite)
        if (overCount) f.pass({ target: out, clear: false }, (p) => p.draw(overlay, { instances: overCount }))
        if (screen) f.pass(screen, blit)
      })
    },
    // Readback through a ring of reusable buffers so several frames are in flight at once;
    // headless Chrome resolves mapAsync lazily, and allocating per frame exhausts the GPU process.
    /** "rgba": the frame as RGBA bytes; "yuv": the same frame as yuv420p planes. */
    async read(format: "rgba" | "yuv"): Promise<{ pixels: Promise<Uint8Array> }> {
      const src = format === "yuv" ? yuv : out
      const [tw, th] = src.size
      const row = Math.ceil((tw * 4) / 256) * 256
      ring ??= Array.from({ length: RING }, () => ({ buf: device.createBuffer({ size: Math.ceil((width * 4) / 256) * 256 * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: Promise.resolve() as Promise<unknown> }))
      const slot = ring[ringHead++ % RING]!
      await slot.busy
      // The copy is encoded now, before the next frame overwrites the source.
      if (format === "yuv") toYuv.draw(yuv)
      const enc = device.createCommandEncoder()
      enc.copyTextureToBuffer({ texture: (src.color as any).gpu }, { buffer: slot.buf, bytesPerRow: row }, [tw, th])
      device.queue.submit([enc.finish()])
      const pixels = slot.buf.mapAsync(GPUMapMode.READ, 0, row * th).then(() => {
        const mapped = new Uint8Array(slot.buf.getMappedRange(0, row * th))
        const px = new Uint8Array(tw * th * 4)
        if (row === tw * 4) px.set(mapped)
        else for (let y = 0; y < th; y++) px.set(mapped.subarray(y * row, y * row + tw * 4), y * tw * 4)
        slot.buf.unmap()
        return px
      })
      slot.busy = pixels
      return { pixels }
    },
  }
}
