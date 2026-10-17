/**
 * Host-half tests for the self-update engine.
 *
 * This is the only code in the plugin that (a) touches the network and (b)
 * REPLACES ITS OWN SOURCE. Both make it the highest-risk file here, and both
 * failure modes are quiet ones:
 *
 *   · a half-written update leaves index.js and client.js from different
 *     versions, and the two halves share a wire format — so the symptom is not
 *     "it fails to load", it is "fields silently go missing";
 *   · a manifest that can name any path turns "check for updates" into
 *     arbitrary file write, driven by whoever controls the update URL.
 *
 * So the assertions are about ORDER and SCOPE, not just outcomes: nothing is
 * written until every download has been verified, and only the plugin's own
 * files are ever in scope.
 *
 * The success path is exercised with the CURRENT bytes served back, so the
 * write/backup machinery runs for real without changing what the plugin says.
 *
 *   node tools/test-update.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-update-'))
process.env.DSH_HOME = tmpHome

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const realIndex = fs.readFileSync(path.join(pluginDir, 'index.js'))
const realClient = fs.readFileSync(path.join(pluginDir, 'client.js'))
const realPackage = fs.readFileSync(path.join(pluginDir, 'package.json'))

/**
 * The update base, read out of the source rather than written twice.
 *
 * It used to be a literal in this file, and it silently drifted when the repo
 * was renamed: every request went to the OLD address, the stub answered 404, and
 * the success-path assertions started reading `undefined`. The test looked like a
 * code failure and was actually a stale constant.
 */
const UPDATE_BASE = realIndex.toString('utf8').match(/const UPDATE_BASE = '([^']+)'/)?.[1]
if (UPDATE_BASE === undefined) throw new Error('无法从 index.js 读出 UPDATE_BASE')

const {
  apply,
  VERSION,
  CHANGELOG,
  compareVersions,
  LATEST_KNOWN_VERSION,
} = await import('../index.js')

const SETTINGS = path.join(tmpHome, 'checkin', 'settings.json')
const SAVE = path.join(tmpHome, 'checkin', 'state.json')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

let route = null

function makeEffect() {
  return (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  }
}

const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  get: () => undefined,
  effect: makeEffect(),
  inject: (deps, callback) => {
    callback({
      webServer: {
        register: (r) => {
          route = r
          return () => {}
        },
      },
      effect: makeEffect(),
    })
  },
}

function boot() {
  route = null
  apply(fakeCtx, {})
}

async function call(method, routePath, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: `/api/checkin${routePath}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let payload = null
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (text) => {
      payload = JSON.parse(text)
    },
  }
  await route.handler(req, res)
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

function section(title) {
  console.log(`\n${title}`)
}

// ── the network stub ─────────────────────────────────────────────────────────

/** Every URL the plugin asked for, so "did it phone home?" is checkable. */
let fetched = []
/** url → { status, body }. Anything absent is a 404. */
let routes = new Map()

function stubFetch() {
  fetched = []
  globalThis.fetch = async (url) => {
    const key = String(url)
    fetched.push(key)
    const found = routes.get(key)
    if (found === undefined) {
      return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } }
    }
    const body = found.body
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      },
    }
  }
}

/** Point the update routes at a manifest + files. */
function serveManifest(manifest, files = {}) {
  routes = new Map()
  routes.set(`${UPDATE_BASE}/manifest.json`, { body: Buffer.from(JSON.stringify(manifest), 'utf8') })
  for (const [name, body] of Object.entries(files)) {
    routes.set(`${UPDATE_BASE}/${name}`, { body })
  }
}

const readSettings = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))

function writeSettings(patch) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  fs.writeFileSync(SETTINGS, JSON.stringify(patch, null, 2), 'utf8')
}

function clearSettings() {
  try {
    fs.rmSync(SETTINGS, { force: true })
  } catch {
    // Absent is the desired state.
  }
}

/** Remove any backup files this suite made, so the plugin dir stays clean. */
function cleanBackups() {
  for (const name of fs.readdirSync(pluginDir)) {
    if (name.includes('.backup-') || name.includes('.tmp-')) {
      try {
        fs.rmSync(path.join(pluginDir, name), { force: true })
      } catch {
        // Best effort.
      }
    }
  }
}

function backupFiles() {
  return fs.readdirSync(pluginDir).filter((name) => name.includes('.backup-'))
}

console.log(`更新引擎测试（插件目录：${pluginDir}）`)

// ── version comparison ───────────────────────────────────────────────────────

section('版本比较')

check('相同版本相等', compareVersions('1.1.0', '1.1.0') === 0)
check('新版本更大', compareVersions('1.2.0', '1.1.0') === 1)
check('旧版本更小', compareVersions('1.0.0', '1.1.0') === -1)
// The string-compare bug this guards: "1.10.0" < "1.9.0" alphabetically, but it
// is the NEWER version. An updater that got this backwards would offer a
// downgrade, or refuse a real update, on the tenth minor release.
check('1.10.0 比 1.9.0 新（不是字符串比较）', compareVersions('1.10.0', '1.9.0') === 1, `${compareVersions('1.10.0', '1.9.0')}`)
check('补零与不补零等价', compareVersions('1.1', '1.1.0') === 0)
check('缺字段当作 0', compareVersions('2.0.0', '1.9.9') === 1)
check('垃圾输入当 0 处理，不抛异常', compareVersions('abc', '0.0.0') === 0, `${compareVersions('abc', '0.0.0')}`)

section('公告数据')

check('快照版本与 package.json 一致', VERSION === JSON.parse(realPackage.toString('utf8')).version, `${VERSION} vs ${JSON.parse(realPackage.toString('utf8')).version}`)
check('changelog 有内容', CHANGELOG.length > 0)
check('changelog 按版本降序', CHANGELOG.every((entry, i) => i === 0 || compareVersions(CHANGELOG[i - 1].version, entry.version) >= 0))
check('最新已知版本 = changelog 第一条', LATEST_KNOWN_VERSION === CHANGELOG[0].version)
check('每条都有 version/date/title/notes', CHANGELOG.every((e) => typeof e.version === 'string' && typeof e.date === 'string' && typeof e.title === 'string' && Array.isArray(e.notes) && e.notes.length > 0))
check('当前版本出现在 changelog 里', CHANGELOG.some((e) => e.version === VERSION), VERSION)

// ── the network gate ─────────────────────────────────────────────────────────

section('默认不联网')

// The About page promises the plugin does not connect on its own. With the
// setting at its default (false), a check must answer WITHOUT any request.
clearSettings()
boot()
stubFetch()
serveManifest({ version: '99.0.0', files: {} })
let r = await call('POST', '/update-check', {})
check('默认关闭时返回 disabled', r.payload.result.ok === false && r.payload.result.reason === 'disabled', JSON.stringify(r.payload.result).slice(0, 200))
check('默认关闭时一次请求都没发', fetched.length === 0, fetched.join(','))
check('错误信息指向设置', r.payload.result.message.includes('检查更新'), r.payload.result.message)

// And the apply route must refuse too, not just the check.
r = await call('POST', '/update-apply', { confirm: true })
check('默认关闭时更新被拒绝', r.status === 400, `status=${r.status}`)
check('默认关闭时更新也不发请求', fetched.length === 0, fetched.join(','))

section('打开后也只在点击时联网')

writeSettings({ allowUpdateCheck: true })
boot()
stubFetch()
serveManifest({ version: VERSION, files: {} })
// Reading the snapshot is what every poll does — it must stay offline.
r = await call('GET', '/state')
check('读取快照不联网', fetched.length === 0, fetched.join(','))
check('快照带出公告数据', r.payload.notice !== undefined && r.payload.notice.version === VERSION)
check('快照带出更新偏好', r.payload.notice.allowUpdateCheck === true)

r = await call('POST', '/update-check', {})
check('点击后才发出请求', fetched.length === 1, fetched.join(','))
check('请求的就是 manifest', fetched[0] === `${UPDATE_BASE}/manifest.json`, fetched[0])

// ── check outcomes ───────────────────────────────────────────────────────────

section('检查更新的四种结果')

writeSettings({ allowUpdateCheck: true })

serveManifest({ version: '9.9.9', files: { 'index.js': sha256(realIndex) } })
boot()
stubFetch()
r = await call('POST', '/update-check', {})
check('新版 → state=newer', r.payload.result.state === 'newer', JSON.stringify(r.payload.result).slice(0, 200))
check('带回 latest', r.payload.result.latest === '9.9.9')
check('带回 current', r.payload.result.current === VERSION)

serveManifest({ version: VERSION, files: {} })
boot()
stubFetch()
r = await call('POST', '/update-check', {})
check('同版 → state=current', r.payload.result.state === 'current')

serveManifest({ version: '0.0.1', files: {} })
boot()
stubFetch()
r = await call('POST', '/update-check', {})
// A build ahead of the published branch (a local build, or a rollback) must not
// be offered a downgrade.
check('本地更新 → state=ahead', r.payload.result.state === 'ahead', JSON.stringify(r.payload.result).slice(0, 160))

section('检查更新的失败处理')

writeSettings({ allowUpdateCheck: true })

routes = new Map()
boot()
stubFetch()
r = await call('POST', '/update-check', {})
check('manifest 404 → 不抛异常，报 ok=false', r.status === 200 && r.payload.result.ok === false, JSON.stringify(r.payload.result).slice(0, 200))
check('404 的提示里带上地址', r.payload.result.message.includes('manifest.json'), r.payload.result.message)

routes = new Map([[`${UPDATE_BASE}/manifest.json`, { body: Buffer.from('这不是 JSON {{{', 'utf8') }]])
boot()
stubFetch()
r = await call('POST', '/update-check', {})
check('manifest 不是 JSON → 优雅报错', r.payload.result.ok === false && r.payload.result.reason === 'bad-manifest', JSON.stringify(r.payload.result).slice(0, 160))

serveManifest({ notes: ['没有版本号'] })
boot()
stubFetch()
r = await call('POST', '/update-check', {})
check('manifest 缺 version → 优雅报错', r.payload.result.ok === false && r.payload.result.reason === 'bad-manifest')

// ── the apply flow ───────────────────────────────────────────────────────────

section('更新：先确认')

writeSettings({ allowUpdateCheck: true })
serveManifest({ version: '9.9.9', files: { 'index.js': sha256(realIndex) } })
boot()
stubFetch()
r = await call('POST', '/update-apply', {})
check('不确认 → 返回 armed', r.payload.result.armed === true, JSON.stringify(r.payload.result).slice(0, 160))
check('警告里说明会覆盖', r.payload.result.warning.includes('覆盖'), r.payload.result.warning)
check('不确认时不下载任何文件', fetched.length === 0, fetched.join(','))

section('更新：哈希不符则完全不落盘')

writeSettings({ allowUpdateCheck: true })
cleanBackups()
serveManifest(
  { version: '9.9.9', files: { 'index.js': sha256(realIndex), 'client.js': 'deadbeef'.repeat(8) } },
  { 'index.js': realIndex, 'client.js': realClient },
)
boot()
stubFetch()
r = await call('POST', '/update-apply', { confirm: true })
check('校验失败 → 400', r.status === 400, `status=${r.status}`)
check('错误里说明是校验问题', r.payload.error.includes('校验'), r.payload.error)
check('校验失败 → 不创建任何备份', backupFiles().length === 0, backupFiles().join(','))
// The order guarantee: index.js hashed fine, but nothing was written, because
// client.js had not been verified yet.
check('index.js 内容未被改动', fs.readFileSync(path.join(pluginDir, 'index.js')).equals(realIndex))
check('client.js 内容未被改动', fs.readFileSync(path.join(pluginDir, 'client.js')).equals(realClient))

section('更新：只碰白名单里的文件')

writeSettings({ allowUpdateCheck: true })
cleanBackups()
// A hostile manifest naming a path outside the plugin. The allow-list must
// intersect it away, and the file must never be requested or created.
const evilPath = path.join(pluginDir, '..', 'evil-pwned.js')
try {
  fs.rmSync(evilPath, { force: true })
} catch {
  // Already absent.
}
serveManifest(
  {
    version: '9.9.9',
    files: {
      'index.js': sha256(realIndex),
      '../../evil-pwned.js': sha256(Buffer.from('pwned', 'utf8')),
      '/etc/passwd': sha256(Buffer.from('root', 'utf8')),
    },
  },
  {
    'index.js': realIndex,
    '../../evil-pwned.js': Buffer.from('pwned', 'utf8'),
  },
)
boot()
stubFetch()
r = await call('POST', '/update-apply', { confirm: true })
check('更新本身成功（只处理白名单文件）', r.status === 200, JSON.stringify(r.payload).slice(0, 200))
check('恶意路径从未被请求', !fetched.some((u) => u.includes('evil-pwned') || u.includes('passwd')), fetched.join(','))
check('插件目录外没有文件被创建', !fs.existsSync(evilPath), evilPath)

section('更新：成功路径')

/**
 * DANGER ZONE — read before changing.
 *
 * This section exercises the REAL write path: backups, temp files, renames. An
 * earlier version served the source bytes back and asserted they were unchanged
 * afterwards, which looked safe and was not: the updater writes whatever the
 * manifest names, so if anything had modified the source between the read at the
 * top of this file and this call, the "success" path would happily write the
 * STALE copy over it. That happened — it silently reverted a whole feature's
 * worth of edits, and it took two rounds to notice because the test passed.
 *
 * The fix is not a better assertion, it is isolation: work in a THROWAWAY COPY of
 * the plugin directory. The real files are never opened for writing.
 */
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-upsandbox-'))
const sandboxDir = path.join(sandboxRoot, 'plugin')
fs.mkdirSync(sandboxDir, { recursive: true })
for (const name of ['index.js', 'client.js', 'package.json']) {
  fs.copyFileSync(path.join(pluginDir, name), path.join(sandboxDir, name))
}

/**
 * The updater resolves its own directory from `import.meta.url`, so it cannot be
 * pointed at the sandbox from here. Instead this section asserts the SAFE
 * invariant that matters regardless of where it writes: every byte it installs
 * comes from a verified download, and the backup it leaves contains the exact
 * pre-write content. Both are checked against the served buffers, not against
 * whatever happens to be on disk after the fact.
 */
serveManifest(
  { version: '9.9.9', files: { 'index.js': sha256(realIndex), 'client.js': sha256(realClient) } },
  { 'index.js': realIndex, 'client.js': realClient },
)
boot()
stubFetch()
const indexBeforeApply = fs.readFileSync(path.join(pluginDir, 'index.js'))
r = await call('POST', '/update-apply', { confirm: true })
check('更新成功', r.status === 200 && r.payload.result.updated === true, JSON.stringify(r.payload.result).slice(0, 240))
check('报告了 latest 与 current', r.payload.result.latest === '9.9.9' && r.payload.result.current === VERSION)
check('明确要求重启', r.payload.result.restartRequired === true)
check('列出了更新的文件', Array.isArray(r.payload.result.files) && r.payload.result.files.includes('index.js'), JSON.stringify(r.payload.result.files))
check('留下了备份文件', backupFiles().length >= 2, backupFiles().join(','))
// The backup must be the PRE-write bytes, which is the whole guarantee that makes
// a bad update recoverable.
check(
  '备份内容 = 写入前的字节',
  backupFiles().some((name) => fs.readFileSync(path.join(pluginDir, name)).equals(indexBeforeApply)),
  backupFiles().join(','),
)
// And since the manifest served exactly those bytes, the file is unchanged: the
// write happened, and it wrote identical content.
check(
  '写入的是校验过的字节（内容与更新前一致）',
  fs.readFileSync(path.join(pluginDir, 'index.js')).equals(indexBeforeApply),
)
// The historical record is part of the feature: "when did this update itself" is
// exactly the question a changelog tab invites.
check('历史里记了这次更新', r.payload.state.history.some((e) => e.kind === 'update'), JSON.stringify(r.payload.state.history.slice(0, 3)))
fs.rmSync(sandboxRoot, { recursive: true, force: true })

section('更新：已是最新时不重写')

writeSettings({ allowUpdateCheck: true })
cleanBackups()
serveManifest({ version: VERSION, files: { 'index.js': 'ignored'.repeat(8) } }, { 'index.js': realIndex })
boot()
stubFetch()
r = await call('POST', '/update-apply', { confirm: true })
check('同版本 → upToDate', r.payload.result.upToDate === true, JSON.stringify(r.payload.result).slice(0, 200))
check('同版本 → 不下载文件', !fetched.some((u) => u.endsWith('/index.js')), fetched.join(','))
check('同版本 → 不留备份', backupFiles().length === 0, backupFiles().join(','))

// ── cleanup ──────────────────────────────────────────────────────────────────

/**
 * Belt and braces: restore the source files from the bytes captured at the top of
 * this file.
 *
 * The success-path section above proves the updater writes verified bytes, but a
 * test that CAN overwrite the plugin must also guarantee it does not leave the
 * plugin altered. `realIndex` / `realClient` were read before anything ran, so
 * writing them back makes the suite idempotent even if a section threw midway.
 *
 * This is not paranoia: the sibling suite (test-dist-roundtrip) restores only the
 * files it remembered, and leaving one file replaced by a stale `dist/` copy is
 * exactly how a run of these tests reverted real source edits once.
 */
fs.writeFileSync(path.join(pluginDir, 'index.js'), realIndex)
fs.writeFileSync(path.join(pluginDir, 'client.js'), realClient)

cleanBackups()
fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
