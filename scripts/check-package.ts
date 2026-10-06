// Refuse to release unexpected files, private extracts, tests or videos.
const p = Bun.spawn(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], { stdout: "pipe", stderr: "pipe" })
const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
if (await p.exited) throw new Error(err)
const [pack]: { files: { path: string }[] }[] = JSON.parse(out)
const names = pack!.files.map((f) => f.path)
const allowed = /^(LICENSE|README\.md|package\.json|render\.ts|bin\/opencode-bloom\.ts|extract\/extract\.ts|(?:cli|audio|web|shared)\/[^/]+\.ts|web\/index\.html)$/
for (const file of names) if (!allowed.test(file) || file.endsWith(".test.ts")) throw new Error(`Unexpected package file: ${file}`)
for (const file of ["package.json", "bin/opencode-bloom.ts", "extract/extract.ts", "render.ts", "web/index.html", "web/main.ts", "audio/score.ts", "audio/mux.ts"])
  if (!names.includes(file)) throw new Error(`Missing package file: ${file}`)
const pkg = await Bun.file("package.json").json()
if (pkg.private || pkg.bin?.["opencode-bloom"] !== "bin/opencode-bloom.ts") throw new Error("Invalid public CLI manifest")
if (!(await Bun.file(pkg.bin["opencode-bloom"]).text()).startsWith("#!/usr/bin/env bun\n")) throw new Error("CLI must use Bun")
console.log(`Package validated: ${names.length} code/documentation files; no extracts, tests or videos.`)
