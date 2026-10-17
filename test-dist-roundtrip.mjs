/**
 * End-to-end check: does the updater accept what build-dist.mjs produced?
 *
 * The unit suite (test-update.mjs) stubs the network with hand-made manifests,
 * which proves the ENGINE. This proves the PAIRING — that dist/manifest.json's
 * shape and the code's expectations actually match. Those two are written by
 * different files and would otherwise only be reconciled at the moment a real
 * user pressed 更新, which is the worst possible time to find out.
 *
 * Serves the real dist/ directory over a stub fetch, then walks the whole flow.
 *
 *   node tools/test-dist-roundtrip.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-dist-'))
process.env.DSH_HOME = tmpHome

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(pluginDir, 'dist')

if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
  console.error('dist/manifest.json 不存在 —— 先运行 tools/build-dist.mjs')
  process.exit(1)
}

const manifestRaw = fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8')
const manifest = JSON.parse(manifestRaw)

const { apply, VERSION } = await import('../index.js')

const SETTINGS = path.join(tmpHome, 'checkin', 'settings.json')

let route = null
const makeEffect = () => (callback) => {
  const dispose = callback()
  return typeof dispose === 'function' ? dispose : () => {}
}

const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  get: () => undefined,
  effect: makeEffect(),
  inject: (deps, callback) => {
    callback({
      webServer: { register: (r) => { route = r; return () => {} } },
      effect: makeEffect(),
    })
  },
}

async function call(method, routePath, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: `/api/checkin${routePath}`,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let payload = null
  await route.handler(req, {
    writeHead: (c) => { status = c },
    end: (text) => { payload = JSON.parse(text) },
  })
  return { status, payload }
}

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── stub fetch to serve the REAL dist/ ───────────────────────────────────────

const served = []
globalThis.fetch = async (url) => {
  const key = String(url)
  served.push(key)
  const name = key.split('/').pop()
  const full = path.join(distDir, name)
  if (!fs.existsSync(full)) {
    return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } }
  }
  const buffer = fs.readFileSync(full)
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

console.log('dist 往返测试（用真实 dist/ 当更新源）\n')

// ── the manifest's own shape ────────────────────────────────────────────────

check('manifest 有 version', typeof manifest.version === 'string', String(manifest.version))
check('manifest 版本与代码一致', manifest.version === VERSION, `${manifest.version} vs ${VERSION}`)
check('manifest 有 files 映射', manifest.files !== null && typeof manifest.files === 'object')
check(
  'manifest 包含更新器会处理的文件',
  ['index.js', 'client.js'].every((n) => typeof manifest.files[n] === 'string'),
  Object.keys(manifest.files).join(','),
)
check(
  'manifest 里的哈希都是 64 位十六进制',
  Object.values(manifest.files).every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)),
  JSON.stringify(manifest.files).slice(0, 120),
)
check('manifest 带更新说明', Array.isArray(manifest.notes) && manifest.notes.length > 0, `${manifest.notes?.length}`)
check('dist 里的文件都在 manifest 里', ['index.js', 'client.js', 'package.json'].every((n) => fs.existsSync(path.join(distDir, n)) && typeof manifest.files[n] === 'string'))

// ── the flow ────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
fs.writeFileSync(SETTINGS, JSON.stringify({ allowUpdateCheck: true }), 'utf8')
route = null
apply(fakeCtx, {})

let r = await call('POST', '/update-check', {})
check('用真实 manifest 检查成功', r.payload.result.ok === true, JSON.stringify(r.payload.result).slice(0, 200))
check('同版本 → current', r.payload.result.state === 'current', r.payload.result.state)
check('带回的 latest 就是 manifest 的版本', r.payload.result.latest === manifest.version)
check('带回的说明条数与 manifest 一致', Array.isArray(r.payload.result.notes) && r.payload.result.notes.length === manifest.notes.length, `${r.payload.result.notes?.length} vs ${manifest.notes?.length}`)

// Applying at the same version must be a no-op — that is the guard that stops a
// working install from being needlessly overwritten.
const before = fs.readFileSync(path.join(pluginDir, 'index.js'))
r = await call('POST', '/update-apply', { confirm: true })
check('同版本更新 → upToDate', r.payload.result.upToDate === true, JSON.stringify(r.payload.result).slice(0, 160))
check('同版本不重写 index.js', fs.readFileSync(path.join(pluginDir, 'index.js')).equals(before))

// Now prove the download+verify path accepts these exact bytes by asking for a
// version ABOVE what is installed. The files served are the real ones, so this
// exercises hash verification against genuine content.
const indexSource = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8')
const bumped = manifestRaw
  .replace(`"version": "${manifest.version}"`, '"version": "999.0.0"')
check('可以构造一个更高版本（仅内存中）', bumped.includes('999.0.0'))

const bumpedManifest = JSON.parse(bumped)
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const key = String(url)
  served.push(key)
  const name = key.split('/').pop()
  if (name === 'manifest.json') {
    const buffer = Buffer.from(JSON.stringify(bumpedManifest), 'utf8')
    return { ok: true, status: 200, async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) } }
  }
  const full = path.join(distDir, name)
  if (!fs.existsSync(full)) {
    return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } }
  }
  const buffer = fs.readFileSync(full)
  return { ok: true, status: 200, async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) } }
}
void indexSource

/**
 * Snapshot EVERY file the updater may touch, before it touches anything.
 *
 * The bug this prevents, and it is a nasty one: an earlier version restored only
 * `client.js` after the update, so the `index.js` the updater had just replaced
 * with the (by then stale) copies in `dist/` was left in place. Running the suite
 * therefore silently reverted real source edits — and because the reverted file
 * still loaded and still passed everything, the damage only showed up as "my
 * changes are gone" much later. Restore from this snapshot in a `finally`, so it
 * happens even if an assertion throws.
 */
const preserved = new Map()
for (const name of ['index.js', 'client.js', 'package.json']) {
  const full = path.join(pluginDir, name)
  if (fs.existsSync(full)) preserved.set(full, fs.readFileSync(full))
}

const clientBefore = fs.readFileSync(path.join(pluginDir, 'client.js'))
try {
  r = await call('POST', '/update-apply', { confirm: true })
  check('真实 dist 的字节通过哈希校验', r.status === 200 && r.payload.result.updated === true, JSON.stringify(r.payload).slice(0, 240))
  check('写到盘上的 client.js 与 dist 里的完全一致', fs.readFileSync(path.join(pluginDir, 'client.js')).equals(fs.readFileSync(path.join(distDir, 'client.js'))))
  check('留下的备份内容 = 更新前的内容', fs.readdirSync(pluginDir).filter((n) => n.includes('.backup-')).some((n) => fs.readFileSync(path.join(pluginDir, n)).equals(clientBefore)))
} finally {
  // Unconditional restore, from the pre-update bytes — never from a .backup file,
  // which by this point contains whatever the updater decided to save.
  for (const [full, bytes] of preserved) fs.writeFileSync(full, bytes)
  for (const name of fs.readdirSync(pluginDir)) {
    if (name.includes('.backup-') || name.includes('.tmp-')) {
      fs.rmSync(path.join(pluginDir, name), { force: true })
    }
  }
  globalThis.fetch = originalFetch
  fs.rmSync(tmpHome, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
