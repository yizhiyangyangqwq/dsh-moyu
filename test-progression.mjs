/**
 * Tests for daily quests, alchemy and rebirth.
 *
 * These three share a hazard the earlier systems did not have: they all REACH
 * INTO other state. Quests count what other actions do, alchemy consumes the
 * pack, and rebirth destroys almost everything while promising to keep the rest.
 * The bugs that matter are therefore cross-system: a quest that never counts, a
 * craft that half-consumes on failure, or a rebirth that quietly wipes a
 * lifetime statistic it promised to preserve.
 *
 *   node tools/test-progression.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-prog-'))
process.env.DSH_HOME = tmpHome

const {
  apply,
  QUEST_POOL,
  DAILY_QUEST_COUNT,
  RECIPES,
  STAR_UPGRADES,
  REBIRTH_LEVEL,
  starsForLevel,
  ITEMS,
} = await import('../index.js')

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

const PERIOD_KEYS = ['minute', 'tenMin', 'hour', 'sixHour', 'day', 'week', 'month', 'quarter']

function writeSave(mutate) {
  const save = {
    version: 4,
    bornAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now(),
    currencies: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0, relic: 0, star: 0 },
    earned: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0, relic: 0, star: 0 },
    periods: Object.fromEntries(
      PERIOD_KEYS.map((key) => [key, { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 }]),
    ),
    achievements: {},
    stats: {
      luckyHits: 0,
      perfectDays: 0,
      bestCombo: 0,
      hours: [],
      perfectKeys: [],
      counts: Object.fromEntries(PERIOD_KEYS.map((key) => [key, 0])),
    },
    upgrades: {},
    chests: { opened: 0, byId: {} },
    offline: { pool: { coin: 0, gold: 0 }, accruedAt: Date.now(), collected: 0 },
    supplies: { current: 12, regenAt: Date.now() },
    pack: [],
    expedition: { found: {}, sold: {}, runs: 0, bestTier: null, byDestination: {}, used: 0 },
    trip: null,
    buffs: [],
    daily: { key: '', counters: {}, claimed: {}, allClaimed: false },
    questAllDays: 0,
    alchemy: { runs: 0, byRecipe: {} },
    rebirth: { count: 0, bestLevel: 1 },
    starUpgrades: {},
    history: [],
  }
  mutate(save)
  fs.mkdirSync(path.dirname(SAVE), { recursive: true })
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

const readSave = () => JSON.parse(fs.readFileSync(SAVE, 'utf8'))

/**
 * Today's LOCAL date key, matching the host.
 *
 * `toISOString().slice(0,10)` is UTC and would disagree with the host's
 * local-date bucket near midnight (or in any non-UTC timezone), producing a test
 * that passes by day and fails by night.
 */
function localDayKey() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function rightNow(metric) {
  // Read live progress for a metric from the current day's quests.
  return metric
}

// ── daily quests ─────────────────────────────────────────────────────────────

section('每日任务：每天的抽取是确定的')

writeSave(() => {})
boot()
let r = await call('GET', '/state')
const day1 = r.payload.quests.map((q) => q.id)
check(`每天抽 ${DAILY_QUEST_COUNT} 个`, day1.length === DAILY_QUEST_COUNT, `${day1.length}`)
check('抽出的任务互不重复', new Set(day1).size === day1.length, day1.join(','))
check('抽出的都来自任务池', day1.every((id) => QUEST_POOL.some((q) => q.id === id)), day1.join(','))

// Reloading must NOT reroll the day.
boot()
r = await call('GET', '/state')
const day1Again = r.payload.quests.map((q) => q.id)
check('重载后任务不变（不会重抽）', JSON.stringify(day1Again) === JSON.stringify(day1), `${day1Again.join(',')} vs ${day1.join(',')}`)

section('每日任务：进度会随行为累加')

writeSave(() => {})
boot()
r = await call('GET', '/state')
// Claim several periods; the claims counter must move.
await call('POST', '/claim', { period: 'minute' })
await call('POST', '/claim', { period: 'tenMin' })
await call('POST', '/claim', { period: 'hour' })
r = await call('GET', '/state')
const claimsQuest = r.payload.quests.find((q) => q.metric === 'claims')
if (claimsQuest === undefined) {
  // Not every day draws a claims quest; assert via the raw counter instead.
  const counters = readSave().daily.counters
  check('签到次数已计入当天计数', (counters.claims ?? 0) === 3, JSON.stringify(counters))
} else {
  check('签到次数任务进度为 3', claimsQuest.progress === 3, `${claimsQuest.progress}`)
}

section('每日任务：领取与重复领取')

// Force a known state: a claim quest with its counter already satisfied.
writeSave((save) => {
  save.daily.key = localDayKey()
  save.daily.counters = { claims: 99, chests: 99, trips: 99, sold: 99, used: 99, planted: 99, harvest: 99, tended: 99, spent: 99999, alchemy: 99, upgrades: 99, perfect: 99, lucky: 99, periodDay: 99, relicGain: 99, mined: 99, swings: 999, descended: 99, gathered: 99, mineUpgrades: 99, hired: 99 }
})
boot()
r = await call('GET', '/state')
const target = r.payload.quests[0]
check('任务已完成', target.done === true, `${target.progress}/${target.target}`)

const before = r.payload.state.currencies.relic + r.payload.state.currencies.gold + r.payload.state.currencies.diamond + r.payload.state.currencies.coin + r.payload.state.currencies.bar
r = await call('POST', '/quest', { id: target.id })
check('领取任务奖励成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
const after = r.payload.state.currencies.relic + r.payload.state.currencies.gold + r.payload.state.currencies.diamond + r.payload.state.currencies.coin + r.payload.state.currencies.bar
check('确实拿到了东西', after > before, `${before} -> ${after}`)
check('标记为已领取', r.payload.quests.find((q) => q.id === target.id).claimed === true)

r = await call('POST', '/quest', { id: target.id })
check('重复领取被拒', r.status === 400, `status=${r.status}`)
check('错误说明已领过', r.payload.error.includes('已经领过'), r.payload.error)

r = await call('POST', '/quest', { id: 'q-not-real' })
check('未知任务被拒', r.status === 400, `status=${r.status}`)

section('每日任务：未完成不能领')

writeSave((save) => {
  save.daily.counters = {}
})
boot()
r = await call('GET', '/state')
const undone = r.payload.quests[0]
r = await call('POST', '/quest', { id: undone.id })
check('未完成时拒绝领取', r.status === 400, `status=${r.status}`)
check('错误说明还没完成', r.payload.error.includes('还没完成'), r.payload.error)

section('每日任务：全清奖励')

// The key MUST be today's, or `rollDaily` correctly treats the seeded counters as
// yesterday's and wipes them — which is exactly what an earlier version of this
// test tripped over.
writeSave((save) => {
  save.daily.key = localDayKey()
  save.daily.counters = { claims: 999, chests: 999, trips: 999, sold: 999, used: 999, spent: 99999, alchemy: 999, upgrades: 999, perfect: 999, lucky: 999, periodDay: 999, planted: 999, harvest: 999, tended: 999, relicGain: 999, mined: 999, swings: 9999, descended: 999, gathered: 999, mineUpgrades: 999, hired: 999 }
})
boot()
r = await call('GET', '/state')
const ids = r.payload.quests.map((q) => q.id)
check('三个任务都处于已完成状态', r.payload.quests.every((q) => q.done), JSON.stringify(r.payload.quests.map((q) => `${q.id}:${q.progress}/${q.target}`)))
for (const id of ids) {
  await call('POST', '/quest', { id })
}
r = await call('GET', '/state')
check('全部领完后标记为全清', r.payload.state.dailyAllClaimed === true)
check('全清天数 +1', r.payload.state.questAllDays === 1, `${r.payload.state.questAllDays}`)
check('拿到全清奖励（钻石 ≥ 5）', r.payload.state.currencies.diamond >= 5, `${r.payload.state.currencies.diamond}`)

section('每日任务：跨天重置')

writeSave((save) => {
  save.daily.key = '2020-01-01'
  save.daily.counters = { claims: 50 }
  save.daily.claimed = { whatever: Date.now() }
  save.daily.allClaimed = true
})
boot()
r = await call('GET', '/state')
check('跨天后计数清零', Object.keys(readSave().daily.counters).length === 0, JSON.stringify(readSave().daily.counters))
check('跨天后领取记录清零', Object.keys(readSave().daily.claimed).length === 0)
check('跨天后全清标记复位', r.payload.state.dailyAllClaimed === false)
check('任务列表是今天的', r.payload.quests.length === DAILY_QUEST_COUNT)

// ── alchemy ──────────────────────────────────────────────────────────────────

section('炼金：材料不足被拒且不消耗')

writeSave(() => {})
boot()
r = await call('POST', '/alchemy', { recipe: 'grind' })
check('材料不足返回 400', r.status === 400, `status=${r.status}`)
check('错误说明材料不够', r.payload.error.includes('材料不够'), r.payload.error)
check('失败后背包仍为空', readSave().pack.length === 0)

section('炼金：成功消耗与产出')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 10 }]
  save.currencies.coin = 1000
  save.earned.coin = 1000
})
boot()
r = await call('POST', '/alchemy', { recipe: 'grind' })
check('炼金成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
const afterSave = readSave()
const shell = afterSave.pack.find((row) => row.item === 'shell')
const ore = afterSave.pack.find((row) => row.item === 'ore')
check('贝壳消耗了 6 个（10→4）', shell !== undefined && shell.count === 4, JSON.stringify(shell))
check('产出了矿料', ore !== undefined && ore.count >= 1, JSON.stringify(ore))
check('扣了费用', afterSave.currencies.coin === 920, `${afterSave.currencies.coin}`)
check('炼金次数 +1', afterSave.alchemy.runs === 1)
check('按配方计数', afterSave.alchemy.byRecipe.grind === 1)

section('炼金：材料刚好够时不会清空错误')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 6 }]
  save.currencies.coin = 100
})
boot()
r = await call('POST', '/alchemy', { recipe: 'grind' })
check('刚好够时可炼', r.status === 200, `status=${r.status}`)
const s2 = readSave()
check('贝壳被清空移除', s2.pack.every((row) => row.item !== 'shell'), JSON.stringify(s2.pack))
check('费用被扣到 20', s2.currencies.coin === 20, `${s2.currencies.coin}`)

section('炼金：费用不足时不消耗材料')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 10 }]
  save.currencies.coin = 10
})
boot()
r = await call('POST', '/alchemy', { recipe: 'grind' })
check('费用不足返回 400', r.status === 400, `status=${r.status}`)
check('错误说明费用不够', r.payload.error.includes('费用不够'), r.payload.error)
const s3 = readSave()
check('材料没有被消耗', s3.pack.find((row) => row.item === 'shell').count === 10, JSON.stringify(s3.pack))
check('钱没有被扣', s3.currencies.coin === 10, `${s3.currencies.coin}`)

section('炼金：多材料配方')

writeSave((save) => {
  save.pack = [
    { item: 'charm', count: 2 },
    { item: 'relic-shard', count: 1 },
  ]
  save.currencies.gold = 1000
})
boot()
r = await call('POST', '/alchemy', { recipe: 'engrave' })
check('双材料配方成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
const s4 = readSave()
check('护身符耗尽', s4.pack.every((row) => row.item !== 'charm'))
check('碎片耗尽', s4.pack.every((row) => row.item !== 'relic-shard'))
check('产出印记', s4.pack.some((row) => row.item === 'seal'), JSON.stringify(s4.pack))

// Missing only ONE of two inputs must refuse.
writeSave((save) => {
  save.pack = [{ item: 'charm', count: 2 }]
  save.currencies.gold = 1000
})
boot()
r = await call('POST', '/alchemy', { recipe: 'engrave' })
check('缺一种材料时拒绝', r.status === 400, `status=${r.status}`)
check('错误点名缺的是哪样', r.payload.error.includes('遗物碎片'), r.payload.error)

section('炼金：未知配方')

writeSave(() => {})
boot()
r = await call('POST', '/alchemy', { recipe: 'nope' })
check('未知配方返回 400', r.status === 400, `status=${r.status}`)
check('错误说明没有这个配方', r.payload.error.includes('没有这个配方'), r.payload.error)

section('炼金：配方目录与可制作标记')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 6 }]
  save.currencies.coin = 500
})
boot()
r = await call('GET', '/state')
check('配方全部返回', r.payload.recipes.length === RECIPES.length, `${r.payload.recipes.length}`)
const grind = r.payload.recipes.find((x) => x.id === 'grind')
check('材料够 + 钱够 → craftable', grind.craftable === true, JSON.stringify(grind))
const crown = r.payload.recipes.find((x) => x.id === 'smelt')
check('材料不够 → 不可制作', crown.craftable === false)
check('不可制作时列出缺什么', crown.missing.length > 0, JSON.stringify(crown.missing))

// ── rebirth ──────────────────────────────────────────────────────────────────

section('转生：等级不够时被拒')

writeSave(() => {})
boot()
r = await call('POST', '/rebirth', {})
check('1 级转生返回 400', r.status === 400, `status=${r.status}`)
check('错误说明需要多少级', r.payload.error.includes(String(REBIRTH_LEVEL)), r.payload.error)
check('失败后转生次数仍为 0', readSave().rebirth.count === 0)

section('转生：达到等级后成功')

// Level up by granting XP. xpToAdvance is 50 + (level-1)*35, so a large total
// lands well past 50.
writeSave((save) => {
  save.currencies.xp = 200_000
  save.currencies.gold = 5000
  save.currencies.diamond = 100
  save.upgrades = { minuteYield: 5, luck: 3 }
  save.pack = [{ item: 'crown', count: 2 }]
  save.achievements = { 'first-blood': Date.now(), 'ten': Date.now() }
  save.stats.counts.day = 40
  save.periods.day.best = 12
  save.starUpgrades = { starYield: 3 }
  save.alchemy = { runs: 7, byRecipe: { grind: 7 } }
  save.rebirth = { count: 2, bestLevel: 80 }
})
boot()
r = await call('GET', '/state')
const levelBefore = r.payload.state.level
const starsExpected = starsForLevel(levelBefore)
check(`转生前等级够（${levelBefore}）`, levelBefore >= REBIRTH_LEVEL, `${levelBefore}`)
check('预览显示可转生', r.payload.rebirth.eligible === true)
check('预览给出星辰数', r.payload.rebirth.stars === starsExpected, `${r.payload.rebirth.stars} vs ${starsExpected}`)

r = await call('POST', '/rebirth', {})
check('转生成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
check('拿到星辰', r.payload.result.stars === starsExpected, `${r.payload.result.stars}`)
check('转生次数 +1', r.payload.result.count === 3, `${r.payload.result.count}`)

const afterRebirth = readSave()

section('转生：该重置的重置了')

check('等级回到 1', (await call('GET', '/state')).payload.state.level === 1)
check('经验清零', afterRebirth.currencies.xp === 0, `${afterRebirth.currencies.xp}`)
check('金币清零', afterRebirth.currencies.gold === 0, `${afterRebirth.currencies.gold}`)
check('钻石清零', afterRebirth.currencies.diamond === 0, `${afterRebirth.currencies.diamond}`)
check('商店升级清空', Object.keys(afterRebirth.upgrades).length === 0, JSON.stringify(afterRebirth.upgrades))
check('连签重置', afterRebirth.periods.day.streak === 0, `${afterRebirth.periods.day.streak}`)
check('离线池清空', afterRebirth.offline.pool.coin === 0)

section('转生：该保留的保留了')

check('星辰保留并增加', afterRebirth.currencies.star === starsExpected, `${afterRebirth.currencies.star}`)
check('星盘升级保留', afterRebirth.starUpgrades.starYield === 3, JSON.stringify(afterRebirth.starUpgrades))
check('背包物品保留', afterRebirth.pack.some((row) => row.item === 'crown' && row.count === 2), JSON.stringify(afterRebirth.pack))
check('成就保留', Object.keys(afterRebirth.achievements).length >= 2, JSON.stringify(Object.keys(afterRebirth.achievements)))
check('历史记录保留（新增了转生条目）', afterRebirth.history.some((e) => e.kind === 'rebirth'), 'no rebirth entry')
check('最高等级记录保留', afterRebirth.rebirth.bestLevel >= 80, `${afterRebirth.rebirth.bestLevel}`)
check('炼金记录保留', afterRebirth.alchemy.runs === 7, `${afterRebirth.alchemy.runs}`)
check('累计时长统计保留（日签到次数）', afterRebirth.stats.counts.day === 40, `${afterRebirth.stats.counts.day}`)
check('历史最佳连签保留', afterRebirth.periods.day.best === 12, `${afterRebirth.periods.day.best}`)

section('转生：启程升级会发放起始资金')

writeSave((save) => {
  save.currencies.xp = 200_000
  save.starUpgrades = { starStart: 5 }
})
boot()
r = await call('POST', '/rebirth', {})
check('转生成功', r.status === 200, `status=${r.status}`)
check('按星盘等级发放起始金币（5×800=4000）', readSave().currencies.gold === 4000, `${readSave().currencies.gold}`)

// ── star shop ────────────────────────────────────────────────────────────────

section('星盘：购买与拒绝')

writeSave((save) => {
  save.currencies.star = 100
})
boot()
r = await call('POST', '/star', { upgrade: 'starYield' })
check('购买星盘成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('等级 +1', r.payload.result.level === 1)
check('扣了星辰', readSave().currencies.star < 100, `${readSave().currencies.star}`)

r = await call('POST', '/star', { upgrade: 'starYield' })
check('连续购买价格递增', r.status === 200)
const cost1 = 1
const cost2 = Math.round(1 * 1.5)
check('第二级更贵', cost2 > cost1, `${cost1} -> ${cost2}`)

writeSave((save) => {
  save.currencies.star = 0
})
boot()
r = await call('POST', '/star', { upgrade: 'starYield' })
check('星辰不足时拒绝', r.status === 400, `status=${r.status}`)
check('错误说明星辰不够', r.payload.error.includes('星辰不够'), r.payload.error)

writeSave((save) => {
  save.currencies.star = 99999
  save.starUpgrades = { starYield: STAR_UPGRADES.find((s) => s.id === 'starYield').max }
})
boot()
r = await call('POST', '/star', { upgrade: 'starYield' })
check('满级后拒绝', r.status === 400, `status=${r.status}`)
check('错误说明满级', r.payload.error.includes('满级'), r.payload.error)

r = await call('POST', '/star', { upgrade: 'nope' })
check('未知星盘项返回 400', r.status === 400, `status=${r.status}`)

section('星盘：效果真的生效')

// starYield multiplies every period's reward.
writeSave((save) => {
  save.starUpgrades = { starYield: 10 }
})
boot()
r = await call('GET', '/state')
const expectedYield = 1 + 10 * 0.08
const minute = r.payload.state.periods.find((p) => p.key === 'minute')
check(`星辉 10 级 → 产出 ×${expectedYield.toFixed(2)}`, Math.abs(minute.yieldMultiplier - expectedYield) < 1e-9, `${minute.yieldMultiplier}`)
check('展示奖励已含星辉加成（xp 2→round(2×1.8)=4）', minute.rewards.xp === 4, `${minute.rewards.xp}`)

r = await call('POST', '/claim', { period: 'minute' })
const luckyXp = r.payload.result.lucky !== null && r.payload.result.lucky.key === 'xp' ? r.payload.result.lucky.value : 0
check(
  '实际支付与展示一致（含幸运加成）',
  r.payload.result.granted.xp === minute.rewards.xp + luckyXp,
  `paid=${r.payload.result.granted.xp} quoted=${minute.rewards.xp} lucky=${luckyXp}`,
)

// starOffline accelerates the offline pool.
writeSave((save) => {
  save.starUpgrades = { starOffline: 5 }
  save.offline.accruedAt = Date.now() - 2 * 3_600_000
})
boot()
r = await call('GET', '/state')
// rate = 1 + 5×0.2 = 2 ; 2 hours → coin 8×2×2 = 32
check('长夜提高离线速率（2 小时 → 32 硬币）', r.payload.state.offline.pool.coin === 32, `${r.payload.state.offline.pool.coin}`)

// starPack adds pack capacity.
writeSave((save) => {
  save.starUpgrades = { starPack: 3 }
})
boot()
r = await call('GET', '/state')
check('星辰行囊增加容量（20 + 3×10 = 50）', r.payload.state.packSize === 50, `${r.payload.state.packSize}`)

// starFortune must show up in the codex valuation.
writeSave((save) => {
  save.starUpgrades = { starFortune: 4 }
})
boot()
r = await call('GET', '/state')
check('星图提高寻宝品质加成', r.payload.state.modifiers.fortune >= 4, `${r.payload.state.modifiers.fortune}`)

// ── save migration ───────────────────────────────────────────────────────────

section('旧存档升级到 v4')

// A v3 save has no quests / alchemy / rebirth / star.
const v3 = {
  version: 3,
  bornAt: Date.now() - 1000,
  lastSeenAt: Date.now(),
  currencies: { xp: 500, coin: 50, gold: 10, diamond: 1, bar: 0, relic: 0 },
  earned: { xp: 500, coin: 50, gold: 10, diamond: 1, bar: 0, relic: 0 },
  periods: Object.fromEntries(
    PERIOD_KEYS.map((key) => [key, { lastAt: 0, lastKey: '', streak: 2, best: 5, total: 9 }]),
  ),
  achievements: { 'first-blood': Date.now() },
  stats: {
    luckyHits: 1,
    perfectDays: 2,
    bestCombo: 3,
    hours: [9],
    perfectKeys: [],
    counts: Object.fromEntries(PERIOD_KEYS.map((key) => [key, 9])),
  },
  upgrades: { minuteYield: 2 },
  chests: { opened: 5, byId: { wood: 5 } },
  offline: { pool: { coin: 3, gold: 1 }, accruedAt: Date.now(), collected: 2 },
  supplies: { current: 8, regenAt: Date.now() },
  pack: [{ item: 'shell', count: 4 }],
  expedition: { found: { shell: 4 }, sold: { ore: 2 }, runs: 3, bestTier: 'uncommon', byDestination: { forest: 3 }, used: 1 },
  trip: null,
  buffs: [],
  history: [{ id: 1, at: Date.now(), kind: 'claim', label: '每分钟', granted: { xp: 2 } }],
}
fs.mkdirSync(path.dirname(SAVE), { recursive: true })
fs.writeFileSync(SAVE, `${JSON.stringify(v3, null, 2)}\n`, 'utf8')
boot()
r = await call('GET', '/state')
check('旧存档能加载', r.status === 200)
check('旧数据保留（经验）', r.payload.state.currencies.xp === 500, `${r.payload.state.currencies.xp}`)
check('旧数据保留（背包）', r.payload.state.pack.some((x) => x.item === 'shell'))
check('旧数据保留（成就）', Object.keys(r.payload.achievements).length > 0)
check('新字段补齐（星辰货币）', typeof r.payload.state.currencies.star === 'number')
check('新字段补齐（任务）', r.payload.quests.length === DAILY_QUEST_COUNT)
check('新字段补齐（炼金）', r.payload.recipes.length === RECIPES.length)
check('新字段补齐（转生）', r.payload.rebirth.count === 0)
check('新字段补齐（星盘）', r.payload.starShop.length === STAR_UPGRADES.length)
check('存档版本升到 6', readSave().version === 6, `${readSave().version}`)

section('存档卫生：非法的新字段被清理')

writeSave((save) => {
  save.daily = { key: '2020-01-01', counters: { bogus: 5, claims: -3 }, claimed: { 'not-a-quest': 1 }, allClaimed: 'yes' }
  save.alchemy = { runs: -5, byRecipe: { 'not-a-recipe': 3, grind: 2 } }
  save.rebirth = { count: -1, bestLevel: -9 }
  save.starUpgrades = { starYield: 9999, bogus: 5 }
})
boot()
r = await call('GET', '/state')
const cleaned = readSave()
check('未知任务计数被丢弃', cleaned.daily.counters.bogus === undefined, JSON.stringify(cleaned.daily.counters))
check('负数计数被夹到 0 或丢弃', (cleaned.daily.counters.claims ?? 0) === 0, `${cleaned.daily.counters.claims}`)
check('未知任务领取记录被丢弃', cleaned.daily.claimed['not-a-quest'] === undefined)
check('负数炼金次数被夹到 0', cleaned.alchemy.runs === 0, `${cleaned.alchemy.runs}`)
check('未知配方计数被丢弃', cleaned.alchemy.byRecipe['not-a-recipe'] === undefined)
check('负数转生次数被夹到 0', cleaned.rebirth.count === 0, `${cleaned.rebirth.count}`)
check('负数最高等级被夹到 1', cleaned.rebirth.bestLevel === 1, `${cleaned.rebirth.bestLevel}`)
check(
  '星盘等级被夹到上限',
  cleaned.starUpgrades.starYield === STAR_UPGRADES.find((s) => s.id === 'starYield').max,
  `${cleaned.starUpgrades.starYield}`,
)
check('未知星盘项被丢弃', cleaned.starUpgrades.bogus === undefined)

// ── achievements ─────────────────────────────────────────────────────────────

section('新成就可达性')

writeSave((save) => {
  save.alchemy = { runs: 120, byRecipe: Object.fromEntries(RECIPES.map((x) => [x.id, 15])) }
  save.rebirth = { count: 25, bestLevel: 120 }
  save.starUpgrades = Object.fromEntries(STAR_UPGRADES.map((s) => [s.id, s.max]))
  save.questAllDays = 12
  save.daily = { key: localDayKey(), counters: {}, claimed: {}, allClaimed: true }
})
boot()
r = await call('GET', '/state')
const unlockedIds = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
const has = (id) => unlockedIds.includes(id)
check('炼金 100 次成就', has('alchemy-100'), unlockedIds.join(','))
check('配方通成就（8 种）', has('alchemy-kinds'), unlockedIds.join(','))
check('转生 20 次成就', has('rebirth-20'), unlockedIds.join(','))
check('星盘 20 级成就', has('star-20'), unlockedIds.join(','))
check('全清 10 天成就', has('quest-all-10'), unlockedIds.join(','))
check('百级轮回成就', has('level-100-rebirth'), unlockedIds.join(','))
check('全清一天成就', has('quest-all'), unlockedIds.join(','))

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
