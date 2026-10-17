/**
 * Time-logic test for the 签到 plugin.
 *
 * The hard part of a check-in system is not the economy, it is the calendar:
 * does a daily streak survive a day and break after a gap? Does a week start on
 * Monday? Does the monthly bucket roll over correctly? None of that can be
 * tested by clicking once.
 *
 * So this test drives the REAL save file: it rewrites `periods.day.lastKey` and
 * `lastAt` to a chosen moment, then claims and checks the resulting streak. That
 * is exactly what "come back tomorrow" does to the state.
 *
 *   node tools/test-streaks.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-streak-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('../index.js')

const SAVE = path.join(tmpHome, 'checkin', 'state.json')

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

/** Boot a fresh host half, reading whatever is currently on disk. */
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

// ── calendar helpers mirrored from the implementation ────────────────────────

function pad(value) {
  return String(value).padStart(2, '0')
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isoWeekKey(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayNumber = (target.getDay() + 6) % 7
  target.setDate(target.getDate() - dayNumber + 3)
  const firstThursday = new Date(target.getFullYear(), 0, 4)
  const firstDayNumber = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDayNumber + 3)
  const week = 1 + Math.round((target - firstThursday) / (7 * 86_400_000))
  return `${target.getFullYear()}-W${pad(week)}`
}

function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

/** Pretend the last daily claim happened `daysAgo` local days ago. */
function setLastDailyClaim(daysAgo, streak) {
  const save = JSON.parse(fs.readFileSync(SAVE, 'utf8'))
  const when = new Date()
  when.setDate(when.getDate() - daysAgo)
  when.setHours(12, 0, 0, 0)
  save.periods.day.lastAt = when.getTime()
  save.periods.day.lastKey = dayKey(when)
  save.periods.day.streak = streak
  save.periods.day.best = Math.max(save.periods.day.best, streak)
  save.periods.day.total = Math.max(save.periods.day.total, streak)
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

function setLastClaim(periodKey, { bucket, daysAgo, streak, lastAt }) {
  const save = JSON.parse(fs.readFileSync(SAVE, 'utf8'))
  save.periods[periodKey].lastKey = bucket
  save.periods[periodKey].streak = streak
  save.periods[periodKey].best = Math.max(save.periods[periodKey].best, streak)
  if (daysAgo !== undefined) {
    const when = new Date()
    when.setDate(when.getDate() - daysAgo)
    when.setHours(12, 0, 0, 0)
    save.periods[periodKey].lastAt = when.getTime()
  }
  if (lastAt !== undefined) save.periods[periodKey].lastAt = lastAt
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

// ── the tests ────────────────────────────────────────────────────────────────

section('每日连续签到')

// Day 1.
boot()
let r = await call('POST', '/claim', { period: 'day' })
check('第一次每日签到 streak = 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

// Yesterday → today: the streak must continue.
setLastDailyClaim(1, 4)
boot()
r = await call('POST', '/claim', { period: 'day' })
check('昨天签过 → streak 递增到 5', r.payload.result.streak === 5, `got ${r.payload.result.streak}`)

// Two days ago → today: the chain is broken.
setLastDailyClaim(2, 9)
boot()
r = await call('POST', '/claim', { period: 'day' })
check('前天签过（断了一天）→ streak 重置为 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

// Long absence.
setLastDailyClaim(30, 40)
boot()
r = await call('POST', '/claim', { period: 'day' })
check('隔了 30 天 → streak 重置为 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

// Same day twice is refused.
setLastDailyClaim(0, 3)
boot()
r = await call('POST', '/claim', { period: 'day' })
check('同一天再签 → 被拒绝', r.status === 400, `status=${r.status}`)

section('连续签到的倍率')

setLastDailyClaim(1, 19)
boot()
r = await call('POST', '/claim', { period: 'day' })
// streak becomes 20 → multiplier 1 + 19*0.05 = 1.95 → 40 gold becomes 78
check('streak 20 时倍率约 1.95', Math.abs(r.payload.result.multiplier - 1.95) < 0.001, `got ${r.payload.result.multiplier}`)
check('奖励随倍率放大（金币 > 基础 40）', r.payload.result.granted.gold > 40, `gold=${r.payload.result.granted.gold}`)

// The cap must hold: a huge streak must not produce a runaway reward.
// Cap is STREAK_CAP=30 steps of 0.05 → the multiplier tops out at exactly 2.5.
setLastDailyClaim(1, 500)
boot()
r = await call('POST', '/claim', { period: 'day' })
check('倍率被上限截在 2.5', Math.abs(r.payload.result.multiplier - 2.5) < 0.0001, `got ${r.payload.result.multiplier}`)
// The cap applies to the QUOTED reward, and a lucky drop can add gold on top
// (LUCKY_CHANCE is 12%). Asserting `granted.gold === 100` therefore failed about
// one run in eight — a flaky assertion, not a broken cap. Subtract the lucky
// portion so this checks the multiplier and nothing else.
const luckyGold =
  r.payload.result.lucky !== null && r.payload.result.lucky.key === 'gold' ? r.payload.result.lucky.value : 0
check(
  '金币被截在 100（40 × 2.5，外加可能的幸运掉落）',
  r.payload.result.granted.gold === 100 + luckyGold,
  `gold=${r.payload.result.granted.gold} lucky=${luckyGold}`,
)

section('每周连续签到')

const now = new Date()
const lastWeek = new Date(now)
lastWeek.setDate(lastWeek.getDate() - 7)

boot()
setLastClaim('week', { bucket: isoWeekKey(lastWeek), daysAgo: 7, streak: 6 })
boot()
r = await call('POST', '/claim', { period: 'week' })
check('上周签过 → streak 递增到 7', r.payload.result.streak === 7, `got ${r.payload.result.streak}`)

const twoWeeksAgo = new Date(now)
twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
setLastClaim('week', { bucket: isoWeekKey(twoWeeksAgo), daysAgo: 14, streak: 11 })
boot()
r = await call('POST', '/claim', { period: 'week' })
check('隔了一周 → streak 重置为 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

section('每月连续签到')

const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15)
setLastClaim('month', { bucket: monthKey(lastMonth), lastAt: lastMonth.getTime(), streak: 3 })
boot()
r = await call('POST', '/claim', { period: 'month' })
check('上月签过 → streak 递增到 4', r.payload.result.streak === 4, `got ${r.payload.result.streak}`)

const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 15)
setLastClaim('month', { bucket: monthKey(twoMonthsAgo), lastAt: twoMonthsAgo.getTime(), streak: 8 })
boot()
r = await call('POST', '/claim', { period: 'month' })
check('隔了一月 → streak 重置为 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

section('间隔周期：每分钟的宽限')

// Claimed 30s ago: still inside the same slot → refused.
setLastClaim('minute', { lastAt: Date.now() - 30_000, streak: 2 })
boot()
r = await call('POST', '/claim', { period: 'minute' })
check('30 秒前签过 → 被拒绝', r.status === 400, `status=${r.status}`)

// Claimed 2 slots ago: within the 3-slot grace → streak continues.
setLastClaim('minute', { lastAt: Date.now() - 125_000, streak: 7 })
boot()
r = await call('POST', '/claim', { period: 'minute' })
check('隔了 2 个槽位 → streak 递增到 8', r.payload.result.streak === 8, `got ${r.payload.result.streak}`)

// Claimed 10 slots ago: outside the grace → reset.
setLastClaim('minute', { lastAt: Date.now() - 10 * 60_000, streak: 30 })
boot()
r = await call('POST', '/claim', { period: 'minute' })
check('隔了 10 个槽位 → streak 重置为 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

section('等级曲线')

// XP for level 1→2 is 50; level 2→3 is 85. 50 XP must land exactly on level 2.
const savePath = SAVE
const save = JSON.parse(fs.readFileSync(savePath, 'utf8'))
save.currencies.xp = 50
save.earned.xp = 50
fs.writeFileSync(savePath, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
boot()
r = await call('GET', '/state')
check('50 经验 → 等级 2', r.payload.state.level === 2, `level=${r.payload.state.level}`)
check('50 经验时进度为 0', Math.abs(r.payload.state.levelProgress) < 0.0001, `progress=${r.payload.state.levelProgress}`)

// 50 + 85 = 135 must land on level 3.
const save2 = JSON.parse(fs.readFileSync(savePath, 'utf8'))
save2.currencies.xp = 135
save2.earned.xp = 135
fs.writeFileSync(savePath, `${JSON.stringify(save2, null, 2)}\n`, 'utf8')
boot()
r = await call('GET', '/state')
check('135 经验 → 等级 3', r.payload.state.level === 3, `level=${r.payload.state.level}`)

// One XP short must NOT advance.
const save3 = JSON.parse(fs.readFileSync(savePath, 'utf8'))
save3.currencies.xp = 134
save3.earned.xp = 134
fs.writeFileSync(savePath, `${JSON.stringify(save3, null, 2)}\n`, 'utf8')
boot()
r = await call('GET', '/state')
check('134 经验仍是等级 2', r.payload.state.level === 2, `level=${r.payload.state.level}`)

section('成就随存档导入解锁')

/**
 * Build a COMPLETE save from scratch rather than patching the previous one.
 * Earlier sections deliberately set extreme values (a 500-day streak) to probe
 * the multiplier cap; inheriting those would unlock achievements this section
 * means to leave locked. Explicit isolation is the point.
 */
function writeExplicitSave(mutate) {
  const save = {
    version: 3,
    bornAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now(),
    currencies: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0, relic: 0 },
    earned: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0, relic: 0 },
    periods: Object.fromEntries(
      ['minute', 'tenMin', 'hour', 'sixHour', 'day', 'week', 'month', 'quarter'].map((key) => [
        key,
        { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 },
      ]),
    ),
    achievements: {},
    stats: {
      luckyHits: 0,
      perfectDays: 0,
      bestCombo: 0,
      hours: [],
      perfectKeys: [],
      counts: {
        minute: 0,
        tenMin: 0,
        hour: 0,
        sixHour: 0,
        day: 0,
        week: 0,
        month: 0,
        quarter: 0,
      },
    },
    upgrades: {},
    chests: { opened: 0, byId: {} },
    offline: { pool: { coin: 0, gold: 0 }, accruedAt: Date.now(), collected: 0 },
    supplies: { current: 12, regenAt: Date.now() },
    pack: [],
    expedition: { found: {}, sold: {}, runs: 0, bestTier: null, byDestination: {}, used: 0 },
    trip: null,
    buffs: [],
    history: [],
  }
  mutate(save)
  fs.mkdirSync(path.dirname(SAVE), { recursive: true })
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

writeExplicitSave((save) => {
  // `all-five` ("五毒俱全") requires every currency to have been HELD at least
  // once. That is now SEVEN currencies, and 星辰 is deliberately left at 0 — it is
  // only obtainable by rebirthing, so a real early-game save cannot have it and
  // the achievement correctly stays locked here. This is asserted explicitly
  // below rather than being an accident of the fixture.
  save.currencies = { xp: 10, coin: 1200, gold: 12_000, diamond: 5, bar: 1, relic: 2, star: 0 }
  save.earned = { xp: 10, coin: 1200, gold: 12_000, diamond: 5, bar: 1, relic: 2, star: 0 }
  save.periods.day.best = 8
  save.periods.day.streak = 8
  save.periods.hour.best = 30
  save.stats.counts.week = 60
})
boot()
r = await call('GET', '/state')
const unlockedIds = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('金币成就已解锁', unlockedIds.includes('gold-10k'), unlockedIds.join(','))
check('连签 7 天成就已解锁', unlockedIds.includes('streak-7'), unlockedIds.join(','))
check('每小时连签成就已解锁', unlockedIds.includes('hour-24'), unlockedIds.join(','))
check('周周不落成就已解锁', unlockedIds.includes('week-52'), unlockedIds.join(','))
check('第一根金条成就已解锁', unlockedIds.includes('first-bar'), unlockedIds.join(','))
check(
  '五毒俱全（需持有全部 7 种货币）仍锁着——星辰要转生才有',
  !unlockedIds.includes('all-five'),
  unlockedIds.join(','),
)
check('未达标的 365 天成就仍锁着', !unlockedIds.includes('streak-365'), unlockedIds.join(','))
check('未达标的等级成就仍锁着', !unlockedIds.includes('level-50'), unlockedIds.join(','))
check('未达标的高额金币成就仍锁着', !unlockedIds.includes('gold-100k'), unlockedIds.join(','))

section('全勤日')

// Claim every period inside one day; a perfect day must register.
writeExplicitSave(() => {})
boot()
r = await call('POST', '/claim-all')
const periodCount = r.payload.state.periods.length
check(`一次领完 ${periodCount} 项`, r.payload.result.claimed === periodCount, `claimed=${r.payload.result.claimed}`)
check('全勤日 +1', r.payload.state.perfectDays === 1, `perfectDays=${r.payload.state.perfectDays}`)
check('全勤日成就已解锁', r.payload.achievements.some((a) => a.id === 'perfect-day' && a.unlockedAt !== null))
check(
  '连领成就已解锁',
  r.payload.achievements.some((a) => a.id === 'combo-5' && a.unlockedAt !== null),
)
check(
  '八面玲珑（八周期各签一次）已解锁',
  r.payload.achievements.some((a) => a.id === 'all-periods' && a.unlockedAt !== null),
)

section('新周期：每十分钟 / 每六小时 / 每季度')

writeExplicitSave(() => {})
boot()
r = await call('POST', '/claim', { period: 'tenMin' })
check('每十分钟可以签到', r.status === 200 && r.payload.result.granted.xp > 0, JSON.stringify(r.payload).slice(0, 140))
r = await call('POST', '/claim', { period: 'sixHour' })
check('每六小时可以签到', r.status === 200 && r.payload.result.granted.gold > 0, JSON.stringify(r.payload).slice(0, 140))

// Quarter streaks follow calendar quarters, like month.
const nowDate = new Date()
const lastQuarter = new Date(nowDate.getFullYear(), nowDate.getMonth() - 3, 15)
writeExplicitSave((save) => {
  save.periods.quarter.lastKey = `${lastQuarter.getFullYear()}-Q${Math.floor(lastQuarter.getMonth() / 3) + 1}`
  save.periods.quarter.lastAt = lastQuarter.getTime()
  save.periods.quarter.streak = 2
})
boot()
r = await call('POST', '/claim', { period: 'quarter' })
check('上个季度签过 → 季度连签 2→3', r.payload.result.streak === 3, `got ${r.payload.result.streak}`)
check('季度奖励含金条', r.payload.result.granted.bar >= 1, JSON.stringify(r.payload.result.granted))

const twoQuartersAgo = new Date(nowDate.getFullYear(), nowDate.getMonth() - 6, 15)
writeExplicitSave((save) => {
  save.periods.quarter.lastKey = `${twoQuartersAgo.getFullYear()}-Q${Math.floor(twoQuartersAgo.getMonth() / 3) + 1}`
  save.periods.quarter.lastAt = twoQuartersAgo.getTime()
  save.periods.quarter.streak = 5
})
boot()
r = await call('POST', '/claim', { period: 'quarter' })
check('隔了一个季度 → 季度连签归 1', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

// Same quarter twice must be refused.
writeExplicitSave(() => {})
boot()
await call('POST', '/claim', { period: 'quarter' })
r = await call('POST', '/claim', { period: 'quarter' })
check('同一季度再签 → 被拒绝', r.status === 400, `status=${r.status}`)

section('存档损坏时能恢复')

fs.writeFileSync(savePath, '{ this is not json', 'utf8')
boot()
r = await call('GET', '/state')
check('损坏存档不会崩溃，回退到新存档', r.status === 200 && r.payload.state.total === 0, `status=${r.status}`)

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
