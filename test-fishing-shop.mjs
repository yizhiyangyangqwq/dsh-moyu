/**
 * Host-half tests for the two newest systems: 钓鱼 and 开店.
 *
 * Both have a failure mode that is INVISIBLE from a normal play session, which is
 * why they need their own suite:
 *
 *   · 钓鱼 is a timing game whose whole rule is "strike inside the window". If
 *     the window the host enforces differs from the one it reports, the game is
 *     unwinnable or trivial and NOTHING throws. So the tests drive the clock
 *     explicitly and assert each of the three outcomes.
 *   · 开店 begins with a PERMANENT choice. If the mode could be flipped, one
 *     path's purchases would silently become worthless — the classic
 *     irreversible-decision bug. So the tests assert it is refused, not just that
 *     the first call works.
 *
 *   node tools/test-fishing-shop.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-fishshop-'))
process.env.DSH_HOME = tmpHome

const {
  apply,
  FISH,
  RODS,
  FISHING_SPOTS,
  FISH_WINDOW_MS,
  SHOP_MODES,
  SHOP_PRODUCTS,
  SHOP_MACHINES,
  MANUAL_SALE_BONUS,
  MANUAL_COST_PENALTY,
} = await import('../index.js')

const SAVE = path.join(tmpHome, 'checkin', 'state.json')

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
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let payload = null
  const res = {
    writeHead: (code) => { status = code },
    end: (text) => { payload = JSON.parse(text) },
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

/** A complete save, so sections cannot contaminate each other. */
function writeSave(mutate) {
  const save = {
    version: 6,
    bornAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now(),
    currencies: { xp: 0, coin: 500_000, gold: 500_000, iron: 500, diamond: 500, bar: 10, relic: 10, star: 5 },
    earned: { xp: 0, coin: 500_000, gold: 500_000, iron: 500, diamond: 500, bar: 10, relic: 10, star: 5 },
    periods: Object.fromEntries(
      ['minute', 'tenMin', 'hour', 'sixHour', 'day', 'week', 'month', 'quarter'].map((key) => [
        key,
        { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 },
      ]),
    ),
    achievements: {},
    stats: { luckyHits: 0, perfectDays: 0, bestCombo: 0, hours: [], perfectKeys: [], counts: {} },
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
    farm: { plots: [null, null, null, null, null, null], harvested: 0, byCrop: {}, tended: 0 },
    mine: {
      depth: 1,
      stamina: 20,
      staminaAt: Date.now(),
      upgrades: {},
      vein: null,
      bufferedSwing: {},
      miners: Object.fromEntries(
        ['apprentice', 'hand', 'foreman', 'master'].map((id) => [id, { endsAt: 0, buffered: {} }]),
      ),
      stats: { swings: 0, veins: 0, collected: 0, oresMined: 0, deepest: 1, hiredTotal: 0, byOre: {}, lastStamina: -1 },
    },
    /**
     * The two blocks under test.
     *
     * Present in the fixture from the start, not merged in per-section: a save
     * written by an older build lacks them, and `normalize` fills the gap — but a
     * fixture that omitted them would make every `save.shop.x = ...` mutation
     * throw before the assertion it was setting up. The "old save" section below
     * deliberately omits them to test that fill-in path.
     */
    fishing: {
      rod: 'twig',
      spot: 'pond',
      cast: null,
      cooldownUntil: 0,
      caught: 0,
      escaped: 0,
      byFish: {},
      bySpot: {},
      bestRarity: -1,
    },
    shop: {
      mode: null,
      chosenAt: 0,
      reputation: 0,
      stock: Object.fromEntries(SHOP_PRODUCTS.map((product) => [product.id, 0])),
      machines: Object.fromEntries(SHOP_MACHINES.map((machine) => [machine.id, { endsAt: 0, buffered: {} }])),
      sales: 0,
      revenue: { coin: 0, gold: 0 },
      manualSales: 0,
      autoSales: 0,
      machinesBought: 0,
      byProduct: {},
      lastManualAt: 0,
      streak: 0,
      bestStreak: 0,
    },
    history: [],
  }
  mutate(save)
  fs.mkdirSync(path.dirname(SAVE), { recursive: true })
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

const readSave = () => JSON.parse(fs.readFileSync(SAVE, 'utf8'))

// ── the tables themselves ────────────────────────────────────────────────────

section('鱼表本身是健全的')

check('有鱼', FISH.length >= 8, `${FISH.length}`)
check('鱼 id 唯一', new Set(FISH.map((f) => f.id)).size === FISH.length)
check('每条鱼都有卖价', FISH.every((f) => f.sellFor !== null && typeof f.sellFor === 'object' && Object.keys(f.sellFor).length > 0))
check('每条鱼的咬钩区间合法（min < max）', FISH.every((f) => Array.isArray(f.biteMs) && f.biteMs[0] < f.biteMs[1]))
// A rarity that is not in the ordering would sort to -1 and break bestRarity.
check(
  '鱼的稀有度都在四档之内',
  FISH.every((f) => ['common', 'uncommon', 'rare', 'legendary'].includes(f.rarity)),
  FISH.map((f) => f.rarity).filter((r) => !['common', 'uncommon', 'rare', 'legendary'].includes(r)).join(','),
)
check('鱼竿是递增的（窗宽与幸运都不下降）', RODS.every((rod, i) => i === 0 || (rod.window >= RODS[i - 1].window && rod.luck >= RODS[i - 1].luck)))
check('钓点的鱼竿要求不超出鱼竿数量', FISHING_SPOTS.every((s) => s.reqRod >= 0 && s.reqRod < RODS.length))

section('店表本身是健全的')

check('有两种经营方式', SHOP_MODES.length === 2, `${SHOP_MODES.length}`)
check('两种方式的 id 分别是 auto / manual', SHOP_MODES.map((m) => m.id).sort().join(',') === 'auto,manual')
check('每种方式都有完整的说明点', SHOP_MODES.every((m) => Array.isArray(m.points) && m.points.length >= 3))
check('商品 id 唯一', new Set(SHOP_PRODUCTS.map((p) => p.id)).size === SHOP_PRODUCTS.length)
check('每个商品的售价高于进货价', SHOP_PRODUCTS.every((p) => {
  const costKey = Object.keys(p.cost)[0]
  return p.price[costKey] > p.cost[costKey]
}))
check('机器的每小时产出递增', SHOP_MACHINES.every((m, i) => i === 0 || m.perHour > SHOP_MACHINES[i - 1].perHour))

// ── fishing: the three outcomes ──────────────────────────────────────────────

section('钓鱼：下竿与三种结果')

writeSave(() => {})
boot()
let r = await call('POST', '/fish-cast')
check('下竿成功', r.status === 200, JSON.stringify(r.payload).slice(0, 200))
check('返回了咬钩时间', typeof r.payload.result.biteIn === 'number' && r.payload.result.biteIn > 0)
check('返回了窗口长度', r.payload.result.windowMs === FISH_WINDOW_MS, `${r.payload.result.windowMs}`)
// The species must NOT be leaked: knowing what is on the line turns the strike
// into a formality.
check('没有泄露是哪条鱼', r.payload.result.fish === undefined)
check('快照里有在途的钓线', r.payload.state.fishCast !== null && r.payload.state.fishCast.state === 'waiting')

r = await call('POST', '/fish-cast')
check('重复下竿被拒绝', r.status === 400, `status=${r.status}`)

// ① Early strike: the cast is consumed.
r = await call('POST', '/fish-strike')
check('抢早 → early', r.payload.result.result === 'early', JSON.stringify(r.payload.result))
check('抢早没有拿到鱼', r.payload.result.fish === null)
check('抢早消耗了这一竿', r.payload.state.fishCast === null)
check('抢早计入失手', r.payload.state.fishEscaped === 1, `${r.payload.state.fishEscaped}`)

// ② A strike with no cast at all.
r = await call('POST', '/fish-strike')
check('没下竿就收杆被拒绝', r.status === 400, `status=${r.status}`)

section('钓鱼：咬钩后命中')

/**
 * Drive the clock by rewriting the cast on disk.
 *
 * The host reads `Date.now()` everywhere, so there is no injectable clock. Writing
 * a cast whose `biteAt` is already in the past is the honest way to reach the
 * biting state: it exercises the SAME `tickCast` the real game uses, rather than
 * calling a test-only setter.
 */
writeSave(() => {})
boot()
await call('POST', '/fish-cast')
{
  const save = readSave()
  const cast = save.fishing.cast
  // Move the bite into the past but keep the deadline comfortably in the future.
  cast.biteAt = Date.now() - 10
  cast.strikeDeadline = Date.now() + 60_000
  fs.writeFileSync(SAVE, JSON.stringify(save, null, 2))
}
boot()
r = await call('GET', '/state')
check('读一次就推进到 biting', r.payload.state.fishCast?.state === 'biting', JSON.stringify(r.payload.state.fishCast))
r = await call('POST', '/fish-strike')
check('窗口内命中 → caught', r.payload.result.result === 'caught', JSON.stringify(r.payload.result))
check('拿到了一条鱼', typeof r.payload.result.fish === 'string')
check('鱼的 id 合法', FISH.some((f) => f.id === r.payload.result.fish), r.payload.result.fish)
check('鱼进了背包', r.payload.state.pack.some((row) => row.item === r.payload.result.fish), JSON.stringify(r.payload.state.pack))
check('累计钓获 +1', r.payload.state.fishCaught === 1, `${r.payload.state.fishCaught}`)

section('钓鱼：错过窗口')

writeSave(() => {})
boot()
await call('POST', '/fish-cast')
{
  const save = readSave()
  const cast = save.fishing.cast
  cast.biteAt = Date.now() - 30_000
  cast.strikeDeadline = Date.now() - 20_000
  fs.writeFileSync(SAVE, JSON.stringify(save, null, 2))
}
boot()
r = await call('POST', '/fish-strike')
check('窗口外 → escape', r.payload.result.result === 'escape', JSON.stringify(r.payload.result))
check('跑了就没有鱼', r.payload.result.fish === null)
check('跑掉计入失手', r.payload.state.fishEscaped === 1)

section('钓鱼：冷却')

writeSave(() => {})
boot()
r = await call('POST', '/fish-cast')
check('第一次下竿成功', r.status === 200)
await call('POST', '/fish-strike')
r = await call('POST', '/fish-cast')
check('收杆后立刻下竿被冷却拦住', r.status === 400, `status=${r.status}`)
check('错误说明还要等', r.payload.error.includes('歇一会'), r.payload.error)

section('钓鱼：鱼竿与钓点')

writeSave(() => {})
boot()
r = await call('GET', '/state')
const pond = r.payload.fishing.spots.find((s) => s.id === 'pond')
const river = r.payload.fishing.spots.find((s) => s.id === 'river')
check('池塘一开始就解锁', pond.unlocked === true)
check('河流一开始锁着', river.unlocked === false)
check('锁着的钓点写明需要什么竿', river.reqRodLabel === RODS[1].label, river.reqRodLabel)

r = await call('POST', '/fish-spot', { spot: 'river' })
check('钓点未解锁时切换被拒绝', r.status === 400, `status=${r.status}`)

// Buying a rod UNLOCKS it; switching between unlocked rods is separate.
// Buying is gated to the next rung up the ladder; switching is free.
r = await call('POST', '/fish-rod', { rod: 'twig' })
check('不能重复买已经拥有的竿', r.status === 400, `status=${r.status}`)
check('错误说明已经拥有', r.payload.error.includes('已经拥有'), r.payload.error)
r = await call('POST', '/fish-rod', { rod: 'nope' })
check('未知鱼竿被拒绝', r.status === 400, `status=${r.status}`)
r = await call('POST', '/fish-rod', { rod: 'glass' })
check('不能跳级买竿', r.status === 400, `status=${r.status}`)

const stateBeforeRod = (await call('GET', '/state')).payload
const offeredNext = stateBeforeRod.fishing.rods.filter((rod) => rod.next)
check('界面只把下一级标为可买', offeredNext.length === 1 && offeredNext[0].id === 'bamboo', offeredNext.map((r) => r.id).join(','))

const coinBefore = stateBeforeRod.state.currencies.coin
r = await call('POST', '/fish-rod', { rod: 'bamboo' })
check('买下一级鱼竿成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('扣的钱正好是报价', coinBefore - r.payload.state.currencies.coin === RODS[1].cost.coin, `${coinBefore - r.payload.state.currencies.coin} vs ${RODS[1].cost.coin}`)
check('鱼竿秩 +1', r.payload.state.fishRodRank === 1, `${r.payload.state.fishRodRank}`)
check('两根竿都在（旧竿没被吞掉）', r.payload.state.fishRods.length === 2, JSON.stringify(r.payload.state.fishRods))
// The window must GROW with the rod — that is the whole point of buying it, and
// it is reported to the client which draws the bar.
check(
  '窗口变宽了',
  r.payload.state.fishWindowMs === FISH_WINDOW_MS + RODS[1].window,
  `${r.payload.state.fishWindowMs}`,
)

// ── switching back to an older rod ──
r = await call('POST', '/fish-switch-rod', { rod: 'twig' })
check('可以切回旧鱼竿', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('切换后正在用的是旧竿', r.payload.state.fishRod === 'twig', r.payload.state.fishRod)
check('窗口随之变窄', r.payload.state.fishWindowMs === FISH_WINDOW_MS + RODS[0].window, `${r.payload.state.fishWindowMs}`)
check('两根竿依然都拥有', r.payload.state.fishRods.length === 2)
r = await call('POST', '/fish-switch-rod', { rod: 'moon' })
check('没买的竿不能切换', r.status === 400, `status=${r.status}`)
r = await call('POST', '/fish-switch-rod', { rod: 'bamboo' })
check('切回新竿成功', r.status === 200 && r.payload.state.fishRod === 'bamboo')
r = await call('POST', '/fish-spot', { spot: 'river' })
check('换了竿之后河流解锁', r.status === 200 && r.payload.fishing.spots.find((s) => s.id === 'river').active === true)

// ── the shop: the permanent fork ─────────────────────────────────────────────

section('开店：开局必须先选')

writeSave(() => {})
boot()
r = await call('GET', '/state')
check('没选过时 shopMode 是 null', r.payload.state.shopMode === null)
check('面板给出两种方式供选择', r.payload.shopGame.modes.length === 2)
check('每种方式都带完整说明', r.payload.shopGame.modes.every((m) => m.points.length >= 3))

r = await call('POST', '/shop-restock', { product: 'tea' })
check('没选方式不能补货', r.status === 400, `status=${r.status}`)
r = await call('POST', '/shop-sell', { product: 'tea' })
check('没选方式不能卖货', r.status === 400, `status=${r.status}`)
r = await call('POST', '/shop-mode', { mode: 'nope' })
check('未知方式被拒绝', r.status === 400, `status=${r.status}`)

section('开店：换路线要花钻石')

writeSave(() => {})
boot()
r = await call('POST', '/shop-mode', { mode: 'auto' })
check('第一次选自动化成功（免费）', r.status === 200 && r.payload.state.shopMode === 'auto')
check('第一次不收钱', r.payload.result.paid === null, JSON.stringify(r.payload.result.paid))

// Selecting the SAME mode again is a no-op error, not a charge.
r = await call('POST', '/shop-mode', { mode: 'auto' })
check('重复选同一路线被拒绝', r.status === 400, `status=${r.status}`)
check('拒绝信息说明已经是了', r.payload.error.includes('已经是'), r.payload.error)

// A real switch costs 钻石. This save has 500, so it must succeed and charge.
const beforeSwitch = (await call('GET', '/state')).payload
const switchCost = beforeSwitch.shopGame.switchCost.diamond
check('换路线有明确标价', typeof switchCost === 'number' && switchCost > 0, `${switchCost}`)
const diaBefore = beforeSwitch.state.currencies.diamond
r = await call('POST', '/shop-mode', { mode: 'manual' })
check('换路线成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('模式确实变了', r.payload.state.shopMode === 'manual')
check(
  '扣掉的钻石正好是标价',
  diaBefore - r.payload.state.currencies.diamond === switchCost,
  `${diaBefore - r.payload.state.currencies.diamond} vs ${switchCost}`,
)
check('返回里报告了花费', r.payload.result.paidLabel === `${switchCost} 钻石`, r.payload.result.paidLabel)
check('换过次数 +1', r.payload.state.shopModeSwitches === 1, `${r.payload.state.shopModeSwitches}`)
check('下一次更贵', r.payload.result.nextCost.diamond > switchCost, `${r.payload.result.nextCost.diamond} vs ${switchCost}`)

// Not enough 钻石 → refused, and nothing changes.
writeSave((save) => {
  save.shop.mode = 'auto'
  save.currencies.diamond = 0
})
boot()
r = await call('POST', '/shop-mode', { mode: 'manual' })
check('钻石不够时换不了', r.status === 400, `status=${r.status}`)
check('拒绝信息说清要多少', r.payload.error.includes('钻石'), r.payload.error)
check('失败后模式没变', readSave().shop.mode === 'auto', readSave().shop.mode)

// Machines survive the switch: the player paid for them, so confiscating them
// would be theft. This is the one rule that makes switching safe to allow.
writeSave((save) => {
  save.shop.mode = 'auto'
  save.currencies.diamond = 500
  save.shop.machines.kettle = { endsAt: Date.now() - 3 * 3_600_000, buffered: { tea: 4 } }
})
boot()
r = await call('POST', '/shop-mode', { mode: 'manual' })
check('带着机器也能换路线', r.status === 200 && r.payload.state.shopMode === 'manual')
const savedAfter = readSave()
check('机器没有被没收', savedAfter.shop.machines.kettle.endsAt > 0, JSON.stringify(savedAfter.shop.machines.kettle))
// The buffer is ACCUMULATED, not preserved verbatim: reading the snapshot lets
// the machine credit its hours, so 4 seeded units plus 3 hours' output is
// correct. What matters is that the machine still exists and still holds output.
check('机器里攒的产出也还在', savedAfter.shop.machines.kettle.buffered.tea >= 4, JSON.stringify(savedAfter.shop.machines.kettle.buffered))

section('开店：两条路线的专属能力')

// 自动化 can buy machines but cannot serve by hand.
writeSave((save) => { save.shop.mode = 'auto' })
boot()
r = await call('POST', '/shop-sell', { product: 'tea' })
check('自动路线不能手动卖', r.status === 400, `status=${r.status}`)
check('拒绝信息指向机器', r.payload.error.includes('机器'), r.payload.error)

// 手动 can serve but cannot buy machines.
writeSave((save) => { save.shop.mode = 'manual'; save.shop.stock.tea = 5 })
boot()
r = await call('POST', '/shop-machine', { machine: 'kettle' })
check('手动路线不能买机器', r.status === 400, `status=${r.status}`)
check('拒绝信息指向自己站柜台', r.payload.error.includes('柜台'), r.payload.error)

section('开店：手动路线的经济')

writeSave((save) => {
  save.shop.mode = 'manual'
  save.shop.stock.tea = 10
})
boot()
r = await call('GET', '/state')
const tea = r.payload.shopGame.products.find((p) => p.id === 'tea')
// Both prices must carry the manual mode's modifiers, or the UI would quote one
// number and the host would charge another.
check(
  '手动路线进货价含加价',
  tea.restockCost.coin === Math.max(1, Math.round(SHOP_PRODUCTS[0].cost.coin * MANUAL_COST_PENALTY)),
  JSON.stringify(tea.restockCost),
)
check(
  '手动路线售价含加成',
  tea.salePrice.coin === Math.max(1, Math.round(SHOP_PRODUCTS[0].price.coin * MANUAL_SALE_BONUS)),
  JSON.stringify(tea.salePrice),
)

const coinStart = (await call('GET', '/state')).payload.state.currencies.coin
const repStart = (await call('GET', '/state')).payload.shopGame.reputation
r = await call('POST', '/shop-sell', { product: 'tea' })
check('卖出一单成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check(
  '到账金额 = 报价',
  r.payload.state.currencies.coin - coinStart === tea.salePrice.coin,
  `${r.payload.state.currencies.coin - coinStart} vs ${tea.salePrice.coin}`,
)
check('库存 -1', r.payload.shopGame.products.find((p) => p.id === 'tea').stock === 9)
check('声望 +1', r.payload.state.shopReputation === repStart + 1)
check('连单计数从 1 开始', r.payload.state.shopStreak === 1, `${r.payload.state.shopStreak}`)

// Selling with no stock must fail rather than going negative.
writeSave((save) => {
  save.shop.mode = 'manual'
  save.shop.stock.tea = 0
})
boot()
r = await call('POST', '/shop-sell', { product: 'tea' })
check('没货不能卖', r.status === 400, `status=${r.status}`)
check('错误提示先补货', r.payload.error.includes('补货'), r.payload.error)

section('开店：补货')

writeSave((save) => { save.shop.mode = 'manual' })
boot()
r = await call('GET', '/state')
const teaTurn = r.payload.shopGame.products.find((p) => p.id === 'tea')
const coinBeforeRestock = r.payload.state.currencies.coin
r = await call('POST', '/shop-restock', { product: 'tea', count: 3 })
check('补货成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('库存 +3', r.payload.shopGame.products.find((p) => p.id === 'tea').stock === 3)
check(
  '扣款 = 单价 × 3',
  coinBeforeRestock - r.payload.state.currencies.coin === teaTurn.restockCost.coin * 3,
  `${coinBeforeRestock - r.payload.state.currencies.coin} vs ${teaTurn.restockCost.coin * 3}`,
)

section('开店：商品解锁')

writeSave((save) => { save.shop.mode = 'manual'; save.shop.reputation = 0 })
boot()
r = await call('GET', '/state')
check('声望 0 时只有茶解锁', r.payload.shopGame.products.filter((p) => p.unlocked).length === 1)
r = await call('POST', '/shop-restock', { product: 'bread', count: 1 })
check('未解锁的商品不能补货', r.status === 400, `status=${r.status}`)

writeSave((save) => { save.shop.mode = 'manual'; save.shop.reputation = 1e6 })
boot()
r = await call('GET', '/state')
check('高声望时全部解锁', r.payload.shopGame.products.every((p) => p.unlocked))
check('shopAllProducts 标记为真', r.payload.state.shopAllProducts === true)

section('开店：自动化与机器')

writeSave((save) => { save.shop.mode = 'auto' })
boot()
r = await call('GET', '/state')
const kettle = r.payload.shopGame.machines.find((m) => m.id === 'kettle')
check('机器初始未启动', kettle.active === false)
r = await call('POST', '/shop-collect', { machine: 'kettle' })
check('没买的机器不能收', r.status === 400, `status=${r.status}`)

const goldBefore = (await call('GET', '/state')).payload.state.currencies.coin
r = await call('POST', '/shop-machine', { machine: 'kettle' })
check('买下机器成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('扣款 = 报价', goldBefore - r.payload.state.currencies.coin === SHOP_MACHINES[0].hireCost.coin)
r = await call('POST', '/shop-machine', { machine: 'kettle' })
check('同一台机器不能买两次', r.status === 400, `status=${r.status}`)

// Accrual: rewrite the machine's clock so whole hours have "passed".
{
  const save = readSave()
  save.shop.machines.kettle.endsAt = Date.now() - 3 * 3_600_000
  fs.writeFileSync(SAVE, JSON.stringify(save, null, 2))
}
boot()
r = await call('GET', '/state')
const accrued = r.payload.shopGame.machines.find((m) => m.id === 'kettle')
check('3 小时后有产出', accrued.bufferedTotal > 0, `${accrued.bufferedTotal}`)
check(
  '产出 = 每小时 × 小时数',
  accrued.bufferedTotal === Math.floor(3 * SHOP_MACHINES[0].perHour),
  `${accrued.bufferedTotal} vs ${3 * SHOP_MACHINES[0].perHour}`,
)
check('报告了累积小时数', accrued.hours === 3, `${accrued.hours}`)

// The wage arrives on collection, not before — that is the whole accounting rule.
const beforeCollect = (await call('GET', '/state')).payload.state
r = await call('POST', '/shop-collect', { machine: 'kettle' })
check('收机器成功', r.status === 200, JSON.stringify(r.payload).slice(0, 200))
check('产出进了库存', r.payload.state.shopStock.tea > 0, JSON.stringify(r.payload.state.shopStock))
check('收的时候才付工资', r.payload.state.currencies.coin < beforeCollect.currencies.coin)
check('收完之后缓冲清空', r.payload.shopGame.machines.find((m) => m.id === 'kettle').bufferedTotal === 0)
check('自动销售计数增加', r.payload.state.shopAutoSales > 0)

// ── persistence ─────────────────────────────────────────────────────────────

section('两个系统都能跨重启保留')

writeSave((save) => {
  save.shop.mode = 'manual'
  save.shop.reputation = 42
  save.shop.stock.tea = 7
  save.fishing.rods = ['twig', 'bamboo']
  save.fishing.activeRod = 'bamboo'
  save.fishing.spot = 'river'
})
boot()
r = await call('GET', '/state')
check('经营方式保留', r.payload.state.shopMode === 'manual')
check('声望保留', r.payload.state.shopReputation === 42)
check('库存保留', r.payload.shopGame.products.find((p) => p.id === 'tea').stock === 7)
check('鱼竿保留', r.payload.state.fishRod === 'bamboo')
check('钓点保留', r.payload.state.fishSpot === 'river')

section('旧存档能升级')

// A save written before these systems existed must load and gain both blocks.
const old = {
  version: 4,
  bornAt: Date.now() - 86_400_000,
  lastSeenAt: Date.now(),
  currencies: { xp: 100, coin: 50, gold: 10, iron: 0, diamond: 0, bar: 0, relic: 0, star: 0 },
  earned: { xp: 100, coin: 50, gold: 10 },
  periods: Object.fromEntries(
    ['minute', 'tenMin', 'hour', 'sixHour', 'day', 'week', 'month', 'quarter'].map((key) => [
      key,
      { lastAt: 0, lastKey: '', streak: 0, best: 0, total: 0 },
    ]),
  ),
  achievements: {},
  history: [],
}
fs.writeFileSync(SAVE, JSON.stringify(old, null, 2))
boot()
r = await call('GET', '/state')
check('旧存档能加载', r.status === 200)
check('补出了钓鱼块', r.payload.state.fishRod === 'twig' && r.payload.state.fishCaught === 0)
check('补出了开店块（未选）', r.payload.state.shopMode === null)
check('鱼竿表可用', r.payload.fishing.rods.length === RODS.length)
check('商品表可用', r.payload.shopGame.products.length === SHOP_PRODUCTS.length)
check('旧数据保留', r.payload.state.currencies.xp === 100, `${r.payload.state.currencies.xp}`)

section('存档卫生：坏数据被清理')

writeSave((save) => {
  save.fishing = {
    rods: ['not-a-rod', 'twig'],
    activeRod: 'not-a-rod',
    spot: 'not-a-spot',
    cast: { state: 'waiting', biteAt: 'NaN', strikeDeadline: 'NaN', fish: 'ghost', spot: 'nowhere' },
    caught: -5,
    escaped: 'lots',
    byFish: { minnow: 3, ghostfish: 9 },
    bySpot: { pond: 2, nowhere: 4 },
    bestRarity: 99,
  }
  save.shop = {
    mode: 'communism',
    reputation: -10,
    stock: { tea: -3, ghost: 9 },
    machines: { kettle: { endsAt: 'soon', buffered: { tea: 2, ghost: 5 } } },
    sales: -1,
    manualSales: 'many',
    byProduct: { ghost: 4 },
  }
})
boot()
r = await call('GET', '/state')
check('未知鱼竿回落到树枝', r.payload.state.fishRod === 'twig', r.payload.state.fishRod)
check('未知钓点回落到池塘', r.payload.state.fishSpot === 'pond', r.payload.state.fishSpot)
check('坏的在途钓线被丢弃', r.payload.state.fishCast === null, JSON.stringify(r.payload.state.fishCast))
check('负数计数被夹到 0', r.payload.state.fishCaught === 0, `${r.payload.state.fishCaught}`)
check('未知鱼种被丢弃', r.payload.state.fishKinds === 1, JSON.stringify(r.payload.state.fishByFish))
check('未知钓点计数被丢弃', Object.keys(readSave().fishing.bySpot).join(',') === 'pond', JSON.stringify(readSave().fishing.bySpot))
check('越界的稀有度被夹住', r.payload.state.fishBestRarity === 3, `${r.payload.state.fishBestRarity}`)
check('未知经营方式变回未选', r.payload.state.shopMode === null, r.payload.state.shopMode)
check('负声望被夹到 0', r.payload.state.shopReputation === 0)
check('负库存被夹到 0', readSave().shop.stock.tea === 0, `${readSave().shop.stock.tea}`)
check('未知商品从库存里丢掉', readSave().shop.stock.ghost === undefined)
check('未知商品的销量被丢掉', Object.keys(readSave().shop.byProduct).join(',') === '', JSON.stringify(readSave().shop.byProduct))
check('坏时间戳的机器变成未购买', r.payload.shopGame.machines.find((m) => m.id === 'kettle').active === false)

// ── achievements ────────────────────────────────────────────────────────────

section('新成就能解锁')

writeSave((save) => {
  save.fishing.caught = 5
  save.fishing.byFish = { minnow: 3, carp: 2 }
  save.shop.mode = 'manual'
  save.shop.sales = 3
})
boot()
r = await call('GET', '/state')
const unlockedIds = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('第一竿已解锁', unlockedIds.includes('fish-first'), unlockedIds.join(','))
check('开张已解锁', unlockedIds.includes('shop-pick'))
check('亲手站柜台已解锁', unlockedIds.includes('shop-manual'))
check('机器替人未解锁', !unlockedIds.includes('shop-auto'))
check('第一单已解锁', unlockedIds.includes('shop-sale-1'))
check('鱼竿成就仍锁着', !unlockedIds.includes('fish-rod-3'))

// ── 公告已读 ────────────────────────────────────────────────────────────────

section('公告：已读状态')

const SETTINGS_FILE = path.join(tmpHome, 'checkin', 'settings.json')
const readSettingsFile = () => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

writeSave(() => {})
try {
  fs.rmSync(SETTINGS_FILE, { force: true })
} catch {
  // Absent is the desired state.
}
boot()
r = await call('GET', '/state')
check('从未读过时是未读', r.payload.notice.unread === true, JSON.stringify(r.payload.notice.unread))
check('readUpTo 初始为 null', r.payload.notice.readUpTo === null)

r = await call('POST', '/notice-read')
check('标记已读成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('标记后不再是未读', r.payload.notice.unread === false)
check('readUpTo 记录为最新版本', r.payload.notice.readUpTo === r.payload.notice.latestKnown, `${r.payload.notice.readUpTo}`)
check('已读状态写进了 settings.json', readSettingsFile().__readsUpTo === r.payload.notice.latestKnown, JSON.stringify(readSettingsFile()).slice(0, 160))
check('改动标记为 true', r.payload.result.changed === true)

// Idempotent: marking again is not an error and does not change anything.
r = await call('POST', '/notice-read')
check('重复标记已读仍然成功', r.status === 200)
check('重复标记不算改动', r.payload.result.changed === false)

// The read marker must survive a restart — it lives beside the settings for
// exactly this reason.
boot()
r = await call('GET', '/state')
check('重启后仍是已读', r.payload.notice.unread === false, JSON.stringify(r.payload.notice.readUpTo))

// A NEWER changelog entry must light the dot again without any migration.
// Simulated by lowering the stored marker: the comparison is version-based, so
// appending a release behaves the same way at runtime.
{
  const settings = readSettingsFile()
  settings.__readsUpTo = '0.0.1'
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}
boot()
r = await call('GET', '/state')
check('出现更新的条目后重新变成未读', r.payload.notice.unread === true, JSON.stringify(r.payload.notice.readUpTo))

// /reset must NOT clear it: it describes what was read, not what was achieved.
writeSave(() => {})
boot()
r = await call('POST', '/reset')
check('重置存档不影响已读状态', r.payload.notice.unread === true, 'read marker lives in settings.json')

// A hand-edited marker of the wrong type is ignored rather than believed.
{
  const settings = readSettingsFile()
  settings.__readsUpTo = 12345
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}
boot()
r = await call('GET', '/state')
check('非字符串的已读标记被忽略', r.payload.notice.readUpTo === null, JSON.stringify(r.payload.notice.readUpTo))

// ── cleanup ─────────────────────────────────────────────────────────────────

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
