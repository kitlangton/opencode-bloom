// Quads are drawn in screen pixels. Each one is 16 floats:
//   a: x0 y0 x1 y1    b: size thick kind endAlpha    c: r g b a    uv: u0 v0 u1 v1
// kind: 0 glow, 1 disc, 2 ring, 3 line, 4 text, 5 soft line, 6 orb, 7 star flare; +10 = additive (writes no alpha)
export const FLOATS = 16

export const quadWgsl = /* wgsl */ `
struct Quad { a: vec4f, b: vec4f, c: vec4f, uv: vec4f }
struct View { size: vec2f, pad: vec2f }

@group(0) @binding(0) var<storage, read> quads: array<Quad>;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) id: u32,
  @location(2) tuv: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let q = quads[i];
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let c = corners[v];
  let kind = q.b.z % 10.0;
  var p: vec2f;
  var tuv = vec2f(0.0);
  if (kind == 3.0 || kind == 5.0) {
    let d = q.a.zw - q.a.xy;
    let len = max(length(d), 0.0001);
    let dir = d / len;
    let nrm = vec2f(-dir.y, dir.x);
    let e = q.b.x + 1.5 + q.uv.x;
    p = q.a.xy + dir * (-e + c.x * (len + 2.0 * e)) + nrm * (-e + c.y * 2.0 * e);
  } else if (kind == 4.0) {
    p = mix(q.a.xy, q.a.zw, c);
    tuv = mix(q.uv.xy, q.uv.zw, c);
  } else {
    var e = q.b.x + 1.5 + q.uv.x;
    if (kind == 2.0) { e = q.b.x + q.b.y + 1.5 + q.uv.x; }
    if (kind == 7.0) { e = q.b.x + q.b.y * 3.0 + 1.5; }
    p = q.a.xy + (c * 2.0 - 1.0) * e;
  }
  var o: Out;
  o.pos = vec4f(p / view.size * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  o.p = p;
  o.id = i;
  o.tuv = tuv;
  return o;
}

fn segDist(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return vec2f(length(pa - ba * h), h);
}

@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let q = quads[in.id];
  let kindRaw = q.b.z;
  let additive = kindRaw >= 10.0;
  let kind = kindRaw % 10.0;
  let texel = textureSampleLevel(atlas, smp, in.tuv, 0.0);
  // depth-of-field softness in px (non-text quads carry it in uv.x)
  let soft = 1.0 + select(q.uv.x, 0.0, kind == 4.0);
  var cov = 0.0;
  if (kind == 0.0) {
    let d = length(in.p - q.a.xy) / max(q.b.x, 0.001);
    let g = exp(-d * d * 4.5);
    cov = max(0.0, (g - 0.011) / 0.989);
  } else if (kind == 1.0) {
    let d = length(in.p - q.a.xy);
    cov = clamp((q.b.x - d) / soft + 0.5, 0.0, 1.0);
  } else if (kind == 2.0) {
    let d = length(in.p - q.a.xy);
    let w = max(q.b.y, 0.6);
    cov = clamp((w * 0.5 - abs(d - q.b.x)) / soft + 0.5, 0.0, 1.0) * min(1.0, q.b.y / 0.6) * (0.6 + 0.4 / soft);
  } else if (kind == 3.0) {
    let s = segDist(in.p, q.a.xy, q.a.zw);
    let w = max(q.b.x, 0.5);
    cov = clamp((w - s.x) / soft + 0.5, 0.0, 1.0) * min(1.0, q.b.x / 0.5) * mix(1.0, q.b.w, s.y) * (0.6 + 0.4 / soft);
  } else if (kind == 5.0) {
    let s = segDist(in.p, q.a.xy, q.a.zw);
    let d = s.x / max(q.b.x, 0.001);
    cov = max(0.0, exp(-d * d * 4.5) - 0.011) * mix(1.0, q.b.w, s.y);
  } else if (kind == 6.0) {
    // orb: a lit sphere-ish body. Hot core, soft limb, a faint highlight up and to the left,
    // and a rim that catches the halo so it reads as volume rather than a flat ring.
    let rel = in.p - q.a.xy;
    let r = max(q.b.x, 0.5);
    let d = length(rel) / r;
    cov = clamp((q.b.x - length(rel)) / soft + 0.5, 0.0, 1.0);
    let core = exp(-d * d * 2.2);
    let limb = mix(0.5, 1.0, sqrt(max(0.0, 1.0 - d * d)));
    let hl = exp(-dot(rel / r + vec2f(0.35, 0.4), rel / r + vec2f(0.35, 0.4)) * 6.0);
    let rim = smoothstep(0.7, 1.0, d) * 0.35;
    let shade = q.c.rgb * (limb * 0.8 + rim) + mix(q.c.rgb, vec3f(1.0), 0.6) * (core * q.b.y + hl * 0.25);
    let a6 = cov * q.c.a;
    return vec4f(shade * a6, select(a6, 0.0, additive));
  } else if (kind == 7.0) {
    // four-point star flare: thin gaussian spikes that taper to nothing
    let rel = in.p - q.a.xy;
    let len = max(q.b.x, 1.0);
    let w = max(q.b.y, 0.4);
    let h = exp(-(rel.y * rel.y) / (w * w)) * pow(max(0.0, 1.0 - abs(rel.x) / len), 3.0);
    let v = exp(-(rel.x * rel.x) / (w * w)) * pow(max(0.0, 1.0 - abs(rel.y) / len), 3.0);
    let c = exp(-dot(rel, rel) / (w * w * 9.0));
    cov = max(h, v) + c * 0.6;
  } else {
    // text: red = fill, green = soft shadow that darkens what's behind.
    // b.x/b.y/b.w optionally clip to a reel window [top, bottom] with a soft edge fade.
    var clip = 1.0;
    if (q.b.w > 0.0) {
      clip = smoothstep(q.b.x, q.b.x + q.b.w, in.p.y) * (1.0 - smoothstep(q.b.y - q.b.w, q.b.y, in.p.y));
    }
    let fill = texel.r * abs(q.c.a) * clip;
    let shadow = select(texel.g * q.c.a * 0.75 * clip, 0.0, q.c.a < 0.0);
    return vec4f(q.c.rgb * fill, max(fill, shadow));
  }
  let a = cov * q.c.a;
  return vec4f(q.c.rgb * a, select(a, 0.0, additive));
}
`

// Bilinear 4-tap downsample (dual-filter style).
export const downWgsl = /* wgsl */ `
struct P { texel: vec2f, gain: f32, pad: f32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> params: P;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let o = params.texel;
  var c = textureSampleLevel(src, smp, uv, 0.0) * 4.0;
  c += textureSampleLevel(src, smp, uv + vec2f(-o.x, -o.y), 0.0);
  c += textureSampleLevel(src, smp, uv + vec2f(o.x, -o.y), 0.0);
  c += textureSampleLevel(src, smp, uv + vec2f(-o.x, o.y), 0.0);
  c += textureSampleLevel(src, smp, uv + vec2f(o.x, o.y), 0.0);
  return vec4f(c.rgb / 8.0 * params.gain, 1.0);
}
`

// Separable 9-tap gaussian using linear-sampling offsets.
export const blurWgsl = /* wgsl */ `
struct P { dir: vec2f, pad: vec2f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> params: P;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = params.dir;
  var c = textureSampleLevel(src, smp, uv, 0.0).rgb * 0.2270270270;
  c += textureSampleLevel(src, smp, uv + d * 1.3846153846, 0.0).rgb * 0.3162162162;
  c += textureSampleLevel(src, smp, uv - d * 1.3846153846, 0.0).rgb * 0.3162162162;
  c += textureSampleLevel(src, smp, uv + d * 3.2307692308, 0.0).rgb * 0.0702702703;
  c += textureSampleLevel(src, smp, uv - d * 3.2307692308, 0.0).rgb * 0.0702702703;
  return vec4f(c, 1.0);
}
`

// Background, bloom composite, filmic tonemap, vignette and dither.
export const compositeWgsl = /* wgsl */ `
struct P {
  size: vec2f, cam: vec2f, zoom: f32, time: f32, bloom: f32, exposure: f32, blur: vec2f, grain: f32, stars: f32,
  top: vec4f, bottom: vec4f, glow: vec4f, tint: vec4f,
}
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var b1: texture_2d<f32>;
@group(0) @binding(2) var b2: texture_2d<f32>;
@group(0) @binding(3) var b3: texture_2d<f32>;
@group(0) @binding(4) var smp: sampler;
@group(0) @binding(5) var<uniform> params: P;

fn hash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1, 0)), u.x), mix(hash(i + vec2f(0, 1)), hash(i + vec2f(1, 1)), u.x), u.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var s = 0.0;
  var a = 0.5;
  for (var i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
  return s;
}
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * params.size;
  let aspect = params.size.x / params.size.y;
  let centered = (uv - 0.5) * vec2f(aspect, 1.0);
  // Sky follows the clock: a vertical gradient, a horizon glow at dawn and dusk, and the
  // old radial falloff kept as a soft vignette inside the sky.
  var bg = mix(params.top.rgb, params.bottom.rgb, smoothstep(0.0, 1.0, uv.y));
  let hz = vec2f((uv.x - 0.5) * aspect * 0.55, (1.15 - uv.y) * 1.6);
  bg += params.glow.rgb * exp(-dot(hz, hz) * 1.6);
  bg *= mix(1.0, 0.55, smoothstep(0.2, 1.1, length(centered)));
  let wp = centered * 2.2 / pow(params.zoom, 0.25) + params.cam * 0.00025;
  let n1 = fbm(wp * 1.3 + vec2f(params.time * 0.004, 0.0));
  let n2 = fbm(wp * 2.1 - vec2f(3.1, params.time * 0.003));
  let neb = smoothstep(0.45, 0.95, n1) * 0.55 + smoothstep(0.55, 1.0, n2) * 0.35;
  bg += neb * mix(vec3f(0.035, 0.03, 0.08), vec3f(0.01, 0.045, 0.06), n2) * 0.9 * params.tint.rgb * (0.45 + 0.55 * params.stars);

  // camera motion blur: average the scene along the camera's screen velocity
  var s = vec4f(0.0);
  let bv = params.blur / params.size;
  if (length(params.blur) > 0.75) {
    for (var i = 0; i < 9; i++) {
      let f = f32(i) / 8.0 - 0.5;
      s += textureSampleLevel(scene, smp, uv + bv * f, 0.0);
    }
    s /= 9.0;
  } else {
    s = textureSampleLevel(scene, smp, uv, 0.0);
  }
  // chromatic bloom: the wide layers split slightly, red outward and blue inward
  let ofs = (uv - 0.5) * 0.012;
  let wide = vec3f(
    textureSampleLevel(b2, smp, uv + ofs, 0.0).r * 0.55 + textureSampleLevel(b3, smp, uv + ofs * 2.0, 0.0).r * 0.75,
    textureSampleLevel(b2, smp, uv, 0.0).g * 0.55 + textureSampleLevel(b3, smp, uv, 0.0).g * 0.75,
    textureSampleLevel(b2, smp, uv - ofs, 0.0).b * 0.55 + textureSampleLevel(b3, smp, uv - ofs * 2.0, 0.0).b * 0.75);
  let bloom = (textureSampleLevel(b1, smp, uv, 0.0).rgb * 0.5 + wide) * mix(vec3f(1.0), params.tint.rgb, 0.18);
  var hdr = bg * (1.0 - s.a) + s.rgb + bloom * params.bloom;
  var col = aces(hdr * params.exposure);
  // vignette
  let v = smoothstep(1.25, 0.35, length(centered * vec2f(0.9, 1.1)));
  col *= mix(0.72, 1.0, v);
  col = pow(col, vec3f(1.0 / 1.12));
  // film grain, strongest in the midtones, re-seeded every frame
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  let g = hash(px * 0.73 + vec2f(fract(params.time * 7.31) * 517.0, fract(params.time * 3.17) * 911.0)) - 0.5;
  col += g * params.grain * (0.35 + 1.4 * lum * (1.0 - lum));
  col += (hash(px + fract(params.time) * 91.0) - 0.5) / 255.0 * 1.5;
  return vec4f(col, 1.0);
}
`

export const blitWgsl = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(src, smp, uv, 0.0);
}
`

// Packs the final frame into yuv420p bytes (BT.709, limited range) inside an rgba8 target
// of W/4 x 1.5H texels, so readback is exactly the planar frame ffmpeg expects.
export const yuvWgsl = /* wgsl */ `
struct P { size: vec2f, pad: vec2f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: P;

fn rgb(x: i32, y: i32) -> vec3f { return textureLoad(src, vec2i(x, y), 0).rgb; }
fn luma(c: vec3f) -> f32 { return (16.0 + 219.0 * dot(c, vec3f(0.2126, 0.7152, 0.0722))) / 255.0; }
fn chroma(c: vec3f) -> vec2f {
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return (vec2f(128.0) + 224.0 * vec2f((c.b - y) / 1.8556, (c.r - y) / 1.5748)) / 255.0;
}
fn block(i: i32, w: i32) -> vec3f {
  let hw = w / 2;
  let cx = (i % hw) * 2;
  let cy = (i / hw) * 2;
  return (rgb(cx, cy) + rgb(cx + 1, cy) + rgb(cx, cy + 1) + rgb(cx + 1, cy + 1)) * 0.25;
}

@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let w = i32(params.size.x);
  let h = i32(params.size.y);
  let tx = i32(pos.x);
  let ty = i32(pos.y);
  var o = vec4f(0.0);
  if (ty < h) {
    let x = tx * 4;
    o = vec4f(luma(rgb(x, ty)), luma(rgb(x + 1, ty)), luma(rgb(x + 2, ty)), luma(rgb(x + 3, ty)));
  } else {
    let q = h / 4;
    let r = ty - h;
    let isV = r >= q;
    let base = (r % q) * w + tx * 4;
    for (var k = 0; k < 4; k++) {
      let c = chroma(block(base + k, w));
      o[k] = select(c.x, c.y, isV);
    }
  }
  return o;
}
`
