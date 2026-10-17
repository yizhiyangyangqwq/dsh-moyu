/**
 * Host-half test for the shop, chests and offline earnings.
 *
 * These three systems share one property: they are all *stateful over time*, so
 * the failures they invite are the invisible kind — a pool that grows when it
 * should not, a price that changes between display and charge, a chest that
 * pays from a table nobody checked.
 *
 *   node tools/test-economy.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-econ-'))
process.env.DSH_HOME = tmpHome

const { apply, UPGRADES, CHESTS } = await import('../index.js')

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

/** Write a complete save so sections cannot contaminate each other. */
function writeSave(mutate) {
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

// ── shop ─────────────────────────────────────────────────────────────────────

section('商店：目录与价格')

writeSave(() => {})
boot()
let r = await call('GET', '/state')
check('商店项全部返回', r.payload.shop.length === UPGRADES.length, `${r.payload.shop.length}`)
check('初始都是 0 级', r.payload.shop.every((s) => s.level === 0))
check('每项都有下一级价格', r.payload.shop.every((s) => s.nextCost > 0))
check('买不起时 affordable=false', r.payload.shop.every((s) => s.affordable === false))
check('宝箱目录返回', r.payload.chests.length === CHESTS.length, `${r.payload.chests.length}`)

// The price shown must be the price charged: buy, then compare.
writeSave((save) => {
  save.currencies.coin = 100_000
  save.earned.coin = 100_000
  save.currencies.gold = 100_000
  save.earned.gold = 100_000
})
boot()
r = await call('GET', '/state')
const minuteUp = r.payload.shop.find((s) => s.id === 'minuteYield')
const quoted = minuteUp.nextCost
const coinBefore = r.payload.state.currencies.coin

r = await call('POST', '/buy', { upgrade: 'minuteYield' })
check('购买成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('等级 +1', r.payload.result.level === 1)
check('扣除的数量正好是报价', coinBefore - r.payload.state.currencies.coin === quoted, `charged=${coinBefore - r.payload.state.currencies.coin} quoted=${quoted}`)
check('历史里记了这笔', r.payload.state.history.some((e) => e.kind === 'upgrade'))

const secondPrice = r.payload.shop.find((s) => s.id === 'minuteYield').nextCost
check('第二级更贵（价格递增）', secondPrice > quoted, `first=${quoted} second=${secondPrice}`)

section('商店：买不起与满级')

writeSave((save) => {
  save.currencies.coin = 0
})
boot()
r = await call('POST', '/buy', { upgrade: 'minuteYield' })
check('买不起返回 400', r.status === 400, `status=${r.status}`)
check('错误信息说明差多少', r.payload.error.includes('差'), r.payload.error)
check('买不起时不扣钱', (await call('GET', '/state')).payload.state.currencies.coin === 0)

// Max level.
writeSave((save) => {
  save.upgrades.minuteYield = UPGRADES.find((u) => u.id === 'minuteYield').max
  save.currencies.coin = 10_000_000
  save.earned.coin = 10_000_000
})
boot()
r = await call('POST', '/buy', { upgrade: 'minuteYield' })
check('满级后拒绝', r.status === 400, `status=${r.status}`)
check('错误信息说满级', r.payload.error.includes('满级'), r.payload.error)
r = await call('GET', '/state')
check('满级项 maxed=true', r.payload.shop.find((s) => s.id === 'minuteYield').maxed === true)
check('满级项没有报价', r.payload.shop.find((s) => s.id === 'minuteYield').nextCost === null)

section('商店：升级真的生效')

const { UPGRADES: UPS } = await import('../index.js')
const minuteDef = UPS.find((u) => u.id === 'minuteYield')

writeSave((save) => {
  save.upgrades.minuteYield = 10
})
boot()
r = await call('GET', '/state')
const minutePeriod = r.payload.state.periods.find((p) => p.key === 'minute')
const expectedYield = 1 + 10 * minuteDef.step
check(
  '每分钟产出倍率 = 1 + 10×0.12',
  Math.abs(minutePeriod.yieldMultiplier - expectedYield) < 1e-9,
  `got ${minutePeriod.yieldMultiplier}`,
)
check('展示的奖励已含倍率（xp 2→round(2×2.2)=4）', minutePeriod.rewards.xp === 4, `got ${minutePeriod.rewards.xp}`)

// And the claim must actually pay it. A bonus drop can add EXTRA xp on top
// (LUCKY_CHANCE is 12%), so the paid amount is the quoted reward plus whatever
// the lucky drop granted — the deterministic part is the quoted reward itself.
r = await call('POST', '/claim', { period: 'minute' })
const paidXp = r.payload.result.granted.xp
const luckyXp = r.payload.result.lucky !== null && r.payload.result.lucky.key === 'xp' ? r.payload.result.lucky.value : 0
check(
  `领取支付了放大后的经验（报价 ${minutePeriod.rewards.xp} + 幸运 ${luckyXp}）`,
  paidXp === minutePeriod.rewards.xp + luckyXp,
  `paid=${paidXp} quoted=${minutePeriod.rewards.xp} lucky=${luckyXp}`,
)
check('展示值不低于报价', paidXp >= minutePeriod.rewards.xp, `paid=${paidXp}`)

section('商店：幸运与宽限')

writeSave((save) => {
  save.upgrades.luck = 15
})
boot()
r = await call('GET', '/state')
check('幸运加成 = 15×0.02 = 0.3', Math.abs(r.payload.state.modifiers.luck - 0.3) < 1e-9, `got ${r.payload.state.modifiers.luck}`)

writeSave((save) => {
  save.upgrades.streakGuard = 3
})
boot()
r = await call('GET', '/state')
check('宽限加成 = 3', r.payload.state.modifiers.grace === 3, `got ${r.payload.state.modifiers.grace}`)

// Grace must actually widen streak survival: 5 slots late.
writeSave((save) => {
  save.upgrades.streakGuard = 3
  save.periods.minute.lastAt = Date.now() - 5 * 60_000
  save.periods.minute.streak = 9
})
boot()
r = await call('POST', '/claim', { period: 'minute' })
check('有宽限时，隔 5 个槽位仍续上（9→10）', r.payload.result.streak === 10, `got ${r.payload.result.streak}`)

writeSave((save) => {
  save.periods.minute.lastAt = Date.now() - 5 * 60_000
  save.periods.minute.streak = 9
})
boot()
r = await call('POST', '/claim', { period: 'minute' })
check('无宽限时，隔 5 个槽位断掉（→1）', r.payload.result.streak === 1, `got ${r.payload.result.streak}`)

// ── chests ───────────────────────────────────────────────────────────────────

section('宝箱：掉落与扣费')

const wood = CHESTS.find((c) => c.id === 'wood')
const woodLootKeys = wood.loot.map((l) => l.key)

writeSave((save) => {
  save.currencies.coin = 1000
  save.earned.coin = 1000
})
boot()
r = await call('POST', '/open', { chest: 'wood' })
check('开箱成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('有掉落', Object.keys(r.payload.result.granted).length > 0, JSON.stringify(r.payload.result.granted))
check('掉落都来自该箱子的表', Object.keys(r.payload.result.granted).every((k) => woodLootKeys.includes(k)), Object.keys(r.payload.result.granted).join(','))
check('掉落数量都为正', Object.values(r.payload.result.granted).every((v) => v > 0))
check('计数 +1', r.payload.state.chestsOpened === 1)
check('按箱子分别计数', r.payload.chests.find((c) => c.id === 'wood').opened === 1)
check('历史里记了这次开箱', r.payload.state.history.some((e) => e.kind === 'chest'))

// The wood chest COSTS coin but its table can also PAY coin, so net coin is
// random. Assert the cost was charged by comparing against what was granted,
// rather than assuming the balance fell.
const woodCost = wood.cost.coin
const woodLooted = r.payload.result.granted.coin ?? 0
check(
  `净扣 = 花费 ${woodCost} − 掉落 ${woodLooted}`,
  r.payload.state.currencies.coin === 1000 - woodCost + woodLooted,
  `coin=${r.payload.state.currencies.coin} expected=${1000 - woodCost + woodLooted}`,
)

// A chest that cannot pay back its own currency must strictly reduce it.
const silverChest = CHESTS.find((c) => c.id === 'silver')
writeSave((save) => {
  save.currencies.gold = 10_000
  save.earned.gold = 10_000
})
boot()
r = await call('POST', '/open', { chest: 'silver' })
const silverGold = r.payload.result.granted.gold ?? 0
check(
  `银箱净变化 = 掉落 ${silverGold} − 花费 ${silverChest.cost.gold}`,
  r.payload.state.currencies.gold === 10_000 + silverGold - silverChest.cost.gold,
  `gold=${r.payload.state.currencies.gold}`,
)

section('宝箱：买不起')

writeSave(() => {})
boot()
r = await call('POST', '/open', { chest: 'wood' })
check('没钱开箱返回 400', r.status === 400, `status=${r.status}`)
check('错误说明差多少', r.payload.error.includes('差'), r.payload.error)

r = await call('POST', '/open', { chest: 'nope' })
check('未知宝箱返回 400', r.status === 400)
check('错误说明没有该宝箱', r.payload.error.includes('没有这个宝箱'), r.payload.error)

section('宝箱：保底掉落')

// The diamond chest guarantees at least one bar, every time.
let guaranteedOk = true
for (let i = 0; i < 40; i += 1) {
  writeSave((save) => {
    save.currencies.diamond = 12
    save.earned.diamond = 12
  })
  boot()
  const res = await call('POST', '/open', { chest: 'diamond' })
  if (res.status !== 200 || !(res.payload.result.granted.bar >= 1)) {
    guaranteedOk = false
    console.log(`     (iteration ${i}: ${JSON.stringify(res.payload.result?.granted ?? res.payload)})`)
    break
  }
}
check('钻石宝箱 40 次都保底出金条', guaranteedOk)

section('宝箱：多开不崩')

// Silver costs 400 gold and its table can pay up to 380 gold per roll ×3, so a
// lucky chest can be net-positive. What must hold regardless of luck is that the
// cost was charged every time — so track the arithmetic, not the direction.
writeSave((save) => {
  save.currencies.gold = 500_000
  save.earned.gold = 500_000
})
boot()
let allOk = true
let spent = 0
let looted = 0
for (let i = 0; i < 30; i += 1) {
  const res = await call('POST', '/open', { chest: 'silver' })
  if (res.status !== 200) {
    allOk = false
    break
  }
  spent += CHESTS.find((c) => c.id === 'silver').cost.gold
  looted += res.payload.result.granted.gold ?? 0
}
r = await call('GET', '/state')
check('连开 30 个银箱都成功', allOk)
check('计数累计为 30', r.payload.state.chestsOpened === 30, `got ${r.payload.state.chestsOpened}`)
check(
  `30 次账目平衡（花 ${spent}，得 ${looted}）`,
  r.payload.state.currencies.gold === 500_000 - spent + looted,
  `gold=${r.payload.state.currencies.gold} expected=${500_000 - spent + looted}`,
)

// ── offline earnings ─────────────────────────────────────────────────────────

section('离线收益：累积')

// Pretend the process was away for 2 hours.
writeSave((save) => {
  save.offline.accruedAt = Date.now() - 2 * 3_600_000
})
boot()
r = await call('GET', '/state')
check('离线池已累积', r.payload.state.offline.total > 0, JSON.stringify(r.payload.state.offline))
check('离线池含硬币', r.payload.state.offline.pool.coin > 0, JSON.stringify(r.payload.state.offline.pool))
check('离线池含金币', r.payload.state.offline.pool.gold > 0, JSON.stringify(r.payload.state.offline.pool))

// 2 hours at base rates: coin 8/h → 16, gold 3/h → 6.
check('2 小时硬币 = 16', r.payload.state.offline.pool.coin === 16, `got ${r.payload.state.offline.pool.coin}`)
check('2 小时金币 = 6', r.payload.state.offline.pool.gold === 6, `got ${r.payload.state.offline.pool.gold}`)

section('离线收益：上限')

// 100 hours must clamp to the 4-hour base cap.
writeSave((save) => {
  save.offline.accruedAt = Date.now() - 100 * 3_600_000
})
boot()
r = await call('GET', '/state')
check('超长离线被上限截住（硬币 = 8×4）', r.payload.state.offline.pool.coin === 32, `got ${r.payload.state.offline.pool.coin}`)
check('超长离线被上限截住（金币 = 3×4）', r.payload.state.offline.pool.gold === 12, `got ${r.payload.state.offline.pool.gold}`)

section('离线收益：速率与上限升级')

writeSave((save) => {
  save.upgrades.offlineRate = 4
  save.upgrades.offlineCap = 3
  save.offline.accruedAt = Date.now() - 100 * 3_600_000
})
boot()
r = await call('GET', '/state')
// rate = 1 + 4×0.25 = 2 ; cap = 4 + 3×2 = 10 hours
check('速率倍率 = 2', Math.abs(r.payload.state.modifiers.offlineRate - 2) < 1e-9, `got ${r.payload.state.modifiers.offlineRate}`)
check('上限 = 10 小时', Math.abs(r.payload.state.modifiers.offlineCapHours - 10) < 1e-9, `got ${r.payload.state.modifiers.offlineCapHours}`)
// coin: 8 × 2 × 10 = 160 ; gold: 3 × 2 × 10 = 60
check('升级后硬币上限 = 160', r.payload.state.offline.pool.coin === 160, `got ${r.payload.state.offline.pool.coin}`)
check('升级后金币上限 = 60', r.payload.state.offline.pool.gold === 60, `got ${r.payload.state.offline.pool.gold}`)

section('离线收益：领取')

const beforeCoins = r.payload.state.currencies.coin
const poolCoins = r.payload.state.offline.pool.coin
r = await call('POST', '/collect-offline', {})
check('领取成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('硬币到账', r.payload.state.currencies.coin === beforeCoins + poolCoins, `before=${beforeCoins} pool=${poolCoins} after=${r.payload.state.currencies.coin}`)
check('池子被清空', r.payload.state.offline.pool.coin === 0 && r.payload.state.offline.pool.gold === 0, JSON.stringify(r.payload.state.offline.pool))
check('领取计数 +1', r.payload.state.offline.collected === 1)
check('历史里记了这笔', r.payload.state.history.some((e) => e.kind === 'offline'))

r = await call('POST', '/collect-offline', {})
check('空池再领返回 400', r.status === 400, `status=${r.status}`)
check('错误说还没攒下', r.payload.error.includes('还没有'), r.payload.error)

section('离线收益：立刻领取不产生收益')

writeSave((save) => {
  save.offline.accruedAt = Date.now()
})
boot()
r = await call('POST', '/collect-offline', {})
check('刚启动就领，拒绝（无收益）', r.status === 400, `status=${r.status}`)

section('离线收益：池子不会重复累积')

// Reading twice must not double the pool: the clock advanced.
writeSave((save) => {
  save.offline.accruedAt = Date.now() - 2 * 3_600_000
})
boot()
const first = (await call('GET', '/state')).payload.state.offline.pool.coin
const second = (await call('GET', '/state')).payload.state.offline.pool.coin
check('连续两次读取不会翻倍', first === second, `first=${first} second=${second}`)

// ── achievements ─────────────────────────────────────────────────────────────

section('新成就')

writeSave((save) => {
  save.upgrades.minuteYield = UPGRADES.find((u) => u.id === 'minuteYield').max
  save.chests.opened = 60
  save.chests.byId = { wood: 30, silver: 20, gold: 9, diamond: 1 }
  save.offline.collected = 12
})
boot()
r = await call('GET', '/state')
const ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('第一次升级成就', ids.includes('first-upgrade'), ids.join(','))
check('满级一项成就', ids.includes('max-one'), ids.join(','))
check('开箱 50 成就', ids.includes('chest-50'), ids.join(','))
check('钻石宝箱成就', ids.includes('chest-diamond'), ids.join(','))
check('离线 10 次成就', ids.includes('offline-10'), ids.join(','))
check('未达标的 200 箱成就仍锁着', !ids.includes('chest-200'), ids.join(','))
check('未达标的满级五项仍锁着', !ids.includes('max-five'), ids.join(','))
check('未达标的在线 100 次仍锁着', !ids.includes('offline-100'), ids.join(','))

// ── the iron economy ─────────────────────────────────────────────────────────

section('铁锭：货币与外观')

// 铁锭 must sit in the coin family VISUALLY: 硬币 ◉ / 铁锭 ◎ / 金币 ● read as
// three sizes of the same thing. A square symbol breaks that family, and the
// regression this guards against is exactly the one that shipped — the currency
// launched with ▭ and nobody noticed until a player asked why it looked off.
const { CURRENCIES, PERIODS, FORAGE } = await import('../index.js')
const ironCurrency = CURRENCIES.find((c) => c.key === 'iron')
check('铁锭货币存在', ironCurrency !== undefined)
check('铁锭符号是圆的 ◎', ironCurrency.symbol === '◎', `got ${ironCurrency?.symbol}`)
check('采集掉的铁锭物品也是圆的', FORAGE.find((f) => f.id === 'iron-ingot')?.glyph === '◎')

section('铁锭：周签与月签支付铁锭')

// The quoted week reward must include iron, and a claim must pay exactly the
// quote (plus a lucky drop, which is the only legal extra — same pattern as the
// xp assertion above).
check('周签报价含铁锭', (PERIODS.find((p) => p.key === 'week').rewards.iron ?? 0) > 0)
check('月签报价含铁锭', (PERIODS.find((p) => p.key === 'month').rewards.iron ?? 0) > 0)

writeSave(() => {})
boot()
r = await call('GET', '/state')
const weekQuoted = r.payload.state.periods.find((p) => p.key === 'week').rewards.iron
r = await call('POST', '/claim', { period: 'week' })
const luckyIron = r.payload.result.lucky !== null && r.payload.result.lucky.key === 'iron' ? r.payload.result.lucky.value : 0
check(
  `周签支付了报价的铁锭（${weekQuoted} + 幸运 ${luckyIron}）`,
  r.payload.result.granted.iron === weekQuoted + luckyIron,
  `granted=${r.payload.result.granted.iron} quoted=${weekQuoted} lucky=${luckyIron}`,
)

section('铁锭：铁宝箱')

// The iron chest is the currency's sink. Two invariants: it must cost iron, and
// it must NOT be a perpetual motion machine — the iron it can pay back has to
// stay strictly below the price, or opening it forever would print every other
// currency from nothing.
const ironChest = CHESTS.find((c) => c.id === 'iron')
check('铁宝箱存在', ironChest !== undefined)
check('铁宝箱用铁锭计价', (ironChest?.cost.iron ?? 0) > 0, JSON.stringify(ironChest?.cost))
const chestTotalW = ironChest.loot.reduce((s, l) => s + l.w, 0)
const ironBack =
  ironChest.loot.filter((l) => l.key === 'iron').reduce((s, l) => s + ((l.min + l.max) / 2) * (l.w / chestTotalW) * 3, 0)
check(
  `铁宝箱回血低于成本（期望 ${ironBack.toFixed(1)} < ${ironChest.cost.iron}）`,
  ironBack < ironChest.cost.iron,
  `ironBack=${ironBack}`,
)

writeSave((save) => {
  save.currencies.iron = 15
  save.earned.iron = 15
})
boot()
r = await call('POST', '/open', { chest: 'iron' })
check('有铁锭能开铁宝箱', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
const ironLooted = r.payload.result.granted.iron ?? 0
check(
  `铁宝箱净扣铁锭 = 掉落 ${ironLooted} − 花费 ${ironChest.cost.iron}`,
  r.payload.state.currencies.iron === 15 - ironChest.cost.iron + ironLooted,
  `iron=${r.payload.state.currencies.iron}`,
)
check('铁宝箱计入开箱总数', r.payload.state.chestsOpened === 1)

writeSave(() => {})
boot()
r = await call('POST', '/open', { chest: 'iron' })
check('没有铁锭开不了铁宝箱', r.status === 400, `status=${r.status}`)
check('错误说明差多少', r.payload.error.includes('铁锭') && r.payload.error.includes('差'), r.payload.error)

section('铁锭：铁骨行囊')

// The second sink: a shop upgrade priced in iron. The price shown must be the
// price paid, and the pack must actually grow by the stated step.
const ironFrame = UPGRADES.find((u) => u.id === 'ironFrame')
check('铁骨行囊存在且用铁锭计价', ironFrame !== undefined && ironFrame.cost.currency === 'iron')

writeSave((save) => {
  save.currencies.iron = 100
  save.earned.iron = 100
})
boot()
r = await call('GET', '/state')
const frameQuoted = r.payload.shop.find((s) => s.id === 'ironFrame').nextCost
const packBefore = r.payload.state.packSize
r = await call('POST', '/buy', { upgrade: 'ironFrame' })
check('用铁锭买下铁骨行囊', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('扣除的铁锭正好是报价', 100 - r.payload.state.currencies.iron === frameQuoted, `paid=${100 - r.payload.state.currencies.iron} quoted=${frameQuoted}`)
check(`背包容量 +8（${packBefore} → ${packBefore + 8}）`, r.payload.state.packSize === packBefore + 8, `got ${r.payload.state.packSize}`)

// 木宝箱 and 银宝箱 now pay a little iron, so the currency has a chance-based
// source too. Assert the tables declare it — the open-chest behaviour above
// already proves a declared entry is honoured.
check('木宝箱掉落表含铁锭', CHESTS.find((c) => c.id === 'wood').loot.some((l) => l.key === 'iron'))
check('银宝箱掉落表含铁锭', CHESTS.find((c) => c.id === 'silver').loot.some((l) => l.key === 'iron'))

section('旧存档可以升级到新版本')

// A v1 save (no upgrades / chests / offline / expeditions) must load, gain
// every new field, and come out at the current version.
const v1 = {
  version: 1,
  bornAt: Date.now() - 1000,
  lastSeenAt: Date.now(),
  currencies: { xp: 120, coin: 50, gold: 10, diamond: 0, bar: 0 },
  earned: { xp: 120, coin: 50, gold: 10, diamond: 0, bar: 0 },
  periods: {
    minute: { lastAt: 0, lastKey: '', streak: 3, best: 5, total: 12 },
    hour: { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 },
    day: { lastAt: 0, lastKey: '', streak: 2, best: 2, total: 3 },
    week: { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 },
    month: { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 },
  },
  achievements: {},
  stats: { luckyHits: 1, perfectDays: 0, bestCombo: 2, hours: [10], perfectKeys: [], counts: { minute: 12, hour: 0, day: 3, week: 0, month: 0 } },
  history: [],
}
fs.mkdirSync(path.dirname(SAVE), { recursive: true })
fs.writeFileSync(SAVE, `${JSON.stringify(v1, null, 2)}\n`, 'utf8')
boot()
r = await call('GET', '/state')
check('旧存档能加载', r.status === 200)
check('旧数据保留（累计次数）', r.payload.state.total === 15, `got ${r.payload.state.total}`)
check('旧数据保留（货币）', r.payload.state.currencies.xp === 120)
check('新字段已补齐（升级）', r.payload.shop.every((s) => s.level === 0))
check('新字段已补齐（宝箱）', r.payload.state.chestsOpened === 0)
check('新字段已补齐（离线）', typeof r.payload.state.offline.pool.coin === 'number')
check('新字段已补齐（物资）', typeof r.payload.state.supplies.current === 'number')
check('新字段已补齐（背包）', Array.isArray(r.payload.state.pack))
check('新字段已补齐（出行）', r.payload.state.trip === null)
check('新字段已补齐（遗物货币）', typeof r.payload.state.currencies.relic === 'number')
check('新周期已补齐（每十分钟）', r.payload.state.periods.some((p) => p.key === 'tenMin'))
check('新周期已补齐（每季度）', r.payload.state.periods.some((p) => p.key === 'quarter'))
check('离线时钟已播种，不会爆出巨额收益', r.payload.state.offline.pool.coin === 0, `got ${r.payload.state.offline.pool.coin}`)
check('存档版本升到 6', JSON.parse(fs.readFileSync(SAVE, 'utf8')).version === 6)

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
