/**
 * Host-half test for the 签到 plugin.
 *
 * Runs the REAL `apply()` from index.js against a fake Cordis ctx and a fake
 * HTTP layer, then drives the routes end to end. This catches the things that
 * actually break: date bucketing, streak continuation, level maths, achievement
 * unlocking, and the save round-trip.
 *
 *   node tools/test-host.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-test-'))
process.env.DSH_HOME = tmpHome

const { apply, PERIODS, ACHIEVEMENTS, CURRENCIES } = await import('../index.js')

// ── fake Cordis ctx + HTTP ───────────────────────────────────────────────────

let route = null

/**
 * `ctx.effect(callback)` must actually RUN the callback: that is how the plugin
 * registers its route. A stub that only returns a disposer silently swallows the
 * registration, so this mirror of the real contract matters.
 */
function makeEffect() {
  return (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  }
}

const fakeCtx = {
  logger: { info: () => {}, warn: (...a) => console.log('  [warn]', ...a) },
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

apply(fakeCtx, {})

if (route === null) throw new Error('route was never registered')

/** Drive one request through the real handler. */
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

// ── assertion helpers ────────────────────────────────────────────────────────

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

// ── tests ────────────────────────────────────────────────────────────────────

section('初始状态')

let r = await call('GET', '/state')
check('GET /state 返回 200', r.status === 200, `status=${r.status}`)
// Assert against the tables the host exports rather than hardcoded counts, so
// adding a period or a currency does not break this suite.
check('周期数量与 PERIODS 一致', r.payload.state.periods.length === PERIODS.length, `${r.payload.state.periods.length} vs ${PERIODS.length}`)
check('货币数量与 CURRENCIES 一致', r.payload.currencies.length === CURRENCIES.length, `${r.payload.currencies.length} vs ${CURRENCIES.length}`)
check('成就表非空', r.payload.achievements.length > 30, `count=${r.payload.achievements.length}`)
check('初始等级为 1', r.payload.state.level === 1)
check('所有周期初始都可领', r.payload.state.readyCount === PERIODS.length, `readyCount=${r.payload.state.readyCount}`)
check('初始没有任何成就', r.payload.achievements.every((a) => a.unlockedAt === null))

section('领取：每分钟')

r = await call('POST', '/claim', { period: 'minute' })
check('领取成功', r.status === 200, JSON.stringify(r.payload).slice(0, 200))
check('拿到经验', r.payload.result.granted.xp > 0, JSON.stringify(r.payload.result.granted))
check('拿到硬币', r.payload.result.granted.coin > 0)
check('streak 为 1', r.payload.result.streak === 1)
check('解锁了「第一次签到」', r.payload.result.unlocked.some((a) => a.id === 'first-blood'))
check('领完后 readyCount 少一', r.payload.state.readyCount === PERIODS.length - 1, `got ${r.payload.state.readyCount}`)
check('响应同时带完整快照', r.payload.state.periods.length === PERIODS.length)

section('重复领取被拒')

r = await call('POST', '/claim', { period: 'minute' })
check('第二次领取返回 400', r.status === 400, `status=${r.status}`)
check('错误信息提到等待', typeof r.payload.error === 'string' && r.payload.error.includes('等'), r.payload.error)

section('日历周期：每日')

r = await call('POST', '/claim', { period: 'day' })
check('每日签到成功', r.status === 200)
check('每日给金币', r.payload.result.granted.gold > 0, JSON.stringify(r.payload.result.granted))
check('每日 streak 为 1', r.payload.result.streak === 1)

section('全部领取')

// Two periods are already claimed (minute, day), so claim-all takes the rest.
const expectedRemaining = PERIODS.length - 2
r = await call('POST', '/claim-all')
check('claim-all 成功', r.status === 200)
check(
  `领到了剩余的 ${expectedRemaining} 项`,
  r.payload.result.claimed === expectedRemaining,
  `claimed=${r.payload.result.claimed}`,
)
check(
  'combo 记录了这次的连领数',
  r.payload.state.bestCombo === expectedRemaining,
  `bestCombo=${r.payload.state.bestCombo}`,
)

section('等级与货币')

r = await call('GET', '/state')
check('经验大于 0', r.payload.state.currencies.xp > 0)
check('累计经验等于持有经验（无消费）', r.payload.state.earned.xp === r.payload.state.currencies.xp)
check('等级进度在 0..1 之间', r.payload.state.levelProgress >= 0 && r.payload.state.levelProgress < 1)
check(
  '等级与经验一致',
  r.payload.state.level === 1 ? r.payload.state.currencies.xp < 50 : true,
  `level=${r.payload.state.level} xp=${r.payload.state.currencies.xp}`,
)

section('存档持久化')

const saveFile = path.join(tmpHome, 'checkin', 'state.json')
check('存档文件已写入', fs.existsSync(saveFile), saveFile)
const onDisk = JSON.parse(fs.readFileSync(saveFile, 'utf8'))
check('存档里周期数与 PERIODS 一致', Object.keys(onDisk.periods).length === PERIODS.length, `${Object.keys(onDisk.periods).length}`)
check('存档里成就已记录', Object.keys(onDisk.achievements).length > 0)
check('存档版本是 6', onDisk.version === 6, `version=${onDisk.version}`)

section('重载：成就与统计不丢')

route = null
apply(fakeCtx, {})
r = await call('GET', '/state')
const claimedSoFar = PERIODS.length
check(
  `重载后累计次数保留（${claimedSoFar}）`,
  r.payload.state.total === claimedSoFar,
  `total=${r.payload.state.total}`,
)
check('重载后成就保留', r.payload.achievements.some((a) => a.unlockedAt !== null))
check('重载后货币保留', r.payload.state.currencies.xp > 0)

section('重置')

r = await call('POST', '/reset')
check('重置成功', r.status === 200)
check('重置后累计归零', r.payload.state.total === 0, `total=${r.payload.state.total}`)
check('重置后有备份路径', typeof r.payload.result.backupPath === 'string' && fs.existsSync(r.payload.result.backupPath))

section('未知周期被拒')

r = await call('POST', '/claim', { period: 'nonsense' })
check('未知周期返回 400', r.status === 400)
check('错误信息说明没有该周期', r.payload.error.includes('没有这个周期'), r.payload.error)

section('未知路由')

r = await call('GET', '/nope')
check('未知路由返回 404', r.status === 404)

// ── clean up ─────────────────────────────────────────────────────────────────

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
