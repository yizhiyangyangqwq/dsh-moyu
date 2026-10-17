/**
 * Build the update payload for a release.
 *
 * The updater (index.js) expects two things at its configured base URL:
 *
 *   manifest.json   { version, notes, files: { "index.js": "<sha256>", ... } }
 *   index.js, client.js, package.json   — the bytes named in that manifest
 *
 * This script writes exactly that into `dist/`, hashing whatever is on disk
 * RIGHT NOW. So the release process is:
 *
 *   1. edit the plugin, bump the version in package.json AND index.js
 *   2. add a CHANGELOG entry
 *   3. run this script
 *   4. commit `dist/` and push
 *
 * Deliberately not a build step: `dist/` holds verbatim copies of the two
 * hand-written files, because "update" here means "replace those files", not
 * "run a bundler". Keeping the payload inspectable is worth more than saving
 * two files of duplication.
 *
 *   node tools/build-dist.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(pluginDir, 'dist')

/** The files the updater may replace. Kept in sync with UPDATE_FILES in index.js. */
const FILES = ['index.js', 'client.js', 'package.json']

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// ── read and cross-check the version ────────────────────────────────────────
//
// Two sources, compared on purpose: the updater compares what it FETCHES against
// what package.json says, while the browser half displays VERSION from index.js.
// If they drift, an update can install a build that reports the old number, and
// then immediately look "out of date" again forever.

const packageRaw = fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')
const packageJson = JSON.parse(packageRaw)
const packageVersion = packageJson.version

const indexSource = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8')
const versionMatch = indexSource.match(/export const VERSION = '([^']+)'/)
if (versionMatch === null) fail('index.js 里找不到 `export const VERSION = ...`')
const indexVersion = versionMatch[1]

if (packageVersion !== indexVersion) {
  fail(`版本不一致：package.json 是 ${packageVersion}，index.js 是 ${indexVersion}。先让它们一致。`)
}

// The changelog entry for the version being released must exist, or the 公告
// tab would ship with no explanation of the thing that just changed.
const changelogMatch = indexSource.match(/export const CHANGELOG = \[([\s\S]*?)\n\]/)
if (changelogMatch === null) fail('index.js 里找不到 `export const CHANGELOG = [...]`')
if (!changelogMatch[1].includes(`version: '${packageVersion}'`)) {
  fail(`CHANGELOG 里没有 ${packageVersion} 这一条。发行前先写更新说明。`)
}

// ── hash the real files ─────────────────────────────────────────────────────

const fileHashes = {}
const payloads = new Map()
for (const name of FILES) {
  const full = path.join(pluginDir, name)
  if (!fs.existsSync(full)) fail(`缺少文件：${name}`)
  const buffer = fs.readFileSync(full)
  fileHashes[name] = sha256(buffer)
  payloads.set(name, buffer)
}

// ── the manifest ────────────────────────────────────────────────────────────

/**
 * Release notes for the manifest.
 *
 * Parsed out of the CHANGELOG rather than retyped, so the remote "what's new"
 * and the in-app one can never disagree.
 */
function notesFor(version) {
  const block = indexSource.split(`version: '${version}'`)[1] ?? ''
  const notesBlock = block.split('notes: [')[1] ?? ''
  const body = notesBlock.split(']')[0] ?? ''
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
}

const manifest = {
  version: packageVersion,
  releasedAt: new Date().toISOString(),
  notes: notesFor(packageVersion),
  files: fileHashes,
}

// ── write dist/ ─────────────────────────────────────────────────────────────

fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })

for (const [name, buffer] of payloads) {
  fs.writeFileSync(path.join(distDir, name), buffer)
}
fs.writeFileSync(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// ── verify what was just written, by re-reading it ──────────────────────────
//
// Hashing the buffer in memory proves nothing about the file on disk; the
// updater verifies the DOWNLOADED bytes, so this verifies the WRITTEN ones.

for (const name of FILES) {
  const written = sha256(fs.readFileSync(path.join(distDir, name)))
  if (written !== fileHashes[name]) fail(`dist/${name} 写入后校验失败`)
}

console.log(`✓ dist/ 已生成 — v${packageVersion}`)
console.log(`  文件：${FILES.join('、')}`)
console.log(`  notes：${manifest.notes.length} 条`)
console.log('')
console.log('下一步：把 dist/ 提交上去，并确认 index.js 里的 UPDATE_BASE 指向它所在的地址。')
console.log(`  当前 UPDATE_BASE 指向：raw.githubusercontent.com/.../main/dist`)
