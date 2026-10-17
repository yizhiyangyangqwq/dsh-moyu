/**
 * Tests for the farm.
 *
 * The farm is unlike the other systems in one specific way: its most important
 * behaviour is INVISIBLE to a single action. Growth happens between calls, at a
 * rate that ailments and watering change over time, and the failure modes are all
 * "the numbers drifted" rather than "it threw":
 *
 *   · progress that outruns the clock, or stalls behind it
 *   · an absence that stacks up ailments instead of rolling once per milestone
 *   · neglect that kills a crop (it must not — it only slows growth)
 *   · a harvest that overflows a full pack silently
 *   · farm produce leaking into the expedition loot pool
 *   · a crop whose price makes a nearby crop pointless
 *
 * This suite drives those by REWRITING THE CLOCK in the save, which is the only
 * way to test a system whose whole point is elapsed time.
 *
 *   node tools/test-farm.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-farm-'))
process.env.DSH_HOME = tmpHome

const {
  apply,
  CROPS,
  FARM_PRODUCE,
  AILMENTS,
  ITEMS,
  ALL_ITEMS,
  EXPEDITIONS,
  ORES,
  FORAGE_EXTRA_ITEMS,
  FISH_ITEMS,
  FARM_PLOTS_BASE,
  FARM_PLOTS_MAX,
  VALUATION,
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

const readSave = () => JSON.parse(fs.readFileSync(SAVE, 'utf8'))
const writeRaw = (save) => fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')

function writeSave(mutate) {
  const save = {
    version: 5,
    bornAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now(),
    currencies: { xp: 0, coin: 100_000, gold: 100_000, diamond: 1_000, bar: 0, relic: 0, star: 0 },
    earned: { xp: 0, coin: 100_000, gold: 100_000, diamond: 1_000, bar: 0, relic: 0, star: 0 },
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
    farm: { plots: Array.from({ length: FARM_PLOTS_BASE }, () => null), harvested: 0, byCrop: {}, tended: 0 },
    history: [],
  }
  mutate(save)
  fs.mkdirSync(path.dirname(SAVE), { recursive: true })
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

/** Plant a crop and then rewind its clock by `elapsedMs`. */
function plantAndAge(cropId, elapsedMs, plot = 0) {
  writeSave(() => {})
  boot()
  return (async () => {
    const planted = await call('POST', '/plant', { plot, crop: cropId })
    if (planted.status !== 200) return planted
    const save = readSave()
    const record = save.farm.plots[plot]
    record.plantedAt -= elapsedMs
    record.settleAt -= elapsedMs
    writeRaw(save)
    boot()
    return planted
  })()
}

// ── planting ─────────────────────────────────────────────────────────────────

section('种植：基础')

writeSave(() => {})
boot()
let r = await call('GET', '/state')
check('初始有 6 块地', r.payload.farm.plots.length === FARM_PLOTS_BASE, `${r.payload.farm.plots.length}`)
check('初始全部为空', r.payload.farm.plots.every((p) => p.empty === true))
check('作物目录与 CROPS 一致', r.payload.crops.length === CROPS.length, `${r.payload.crops.length}`)
check('作物带出产名称', r.payload.crops.every((c) => typeof c.yieldLabel === 'string' && c.yieldLabel.length > 0))

r = await call('POST', '/plant', { plot: 0, crop: 'radish' })
check('种植成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('扣了种子钱（硬币 -20）', r.payload.state.currencies.coin === 99_980, `${r.payload.state.currencies.coin}`)
check('地块记录了作物', r.payload.farm.plots[0].crop === 'radish', `${r.payload.farm.plots[0].crop}`)
check('进度从 0 开始', r.payload.farm.plots[0].percent === 0, `${r.payload.farm.plots[0].percent}`)

section('种植：拒绝的情况')

r = await call('POST', '/plant', { plot: 0, crop: 'radish' })
check('同一块地不能重复种', r.status === 400, `status=${r.status}`)
check('错误说明地已占用', r.payload.error.includes('已经种着'), r.payload.error)

r = await call('POST', '/plant', { plot: 99, crop: 'radish' })
check('越界的地块被拒', r.status === 400, `status=${r.status}`)
check('错误说明没有这块地', r.payload.error.includes('没有第'), r.payload.error)

r = await call('POST', '/plant', { plot: 1, crop: 'nonsense' })
check('未知作物被拒', r.status === 400, `status=${r.status}`)
check('错误说明没有这种作物', r.payload.error.includes('没有这种作物'), r.payload.error)

// Seeds must be charged, and a failed charge must leave the plot empty.
writeSave((save) => {
  save.currencies.coin = 0
  save.currencies.gold = 0
  save.currencies.diamond = 0
})
boot()
r = await call('POST', '/plant', { plot: 0, crop: 'radish' })
check('买不起种子时被拒', r.status === 400, `status=${r.status}`)
check('错误说明种子不够', r.payload.error.includes('种子不够'), r.payload.error)
check('失败后地块仍为空', readSave().farm.plots[0] === null)

// ── growth over time ─────────────────────────────────────────────────────────

section('生长：随真实时间推进')

await plantAndAge('radish', 150_000) // 2.5 min of a 5 min crop
r = await call('GET', '/state')
const half = r.payload.farm.plots[0]
check('时间推进后进度增加', half.percent > 0, `${half.percent}%`)
check('进度约为一半', half.percent >= 40 && half.percent <= 60, `${half.percent}%`)
check('尚未成熟', half.ready === false)
check('给出剩余时间', half.remainingMs > 0, `${half.remainingMs}`)

await plantAndAge('radish', 400_000) // past the 5 min need
r = await call('GET', '/state')
check('足够时间后成熟', r.payload.farm.plots[0].ready === true, `${r.payload.farm.plots[0].percent}%`)
check('进度封顶在 100%', r.payload.farm.plots[0].percent === 100, `${r.payload.farm.plots[0].percent}`)

// A long absence must not overshoot past 100%, and must not stack ailments.
await plantAndAge('radish', 30 * 24 * 3_600_000)
r = await call('GET', '/state')
check('长期离线后仍只是成熟（不溢出）', r.payload.farm.plots[0].percent === 100, `${r.payload.farm.plots[0].percent}`)
const longAilments = readSave().farm.plots[0].ailments
check(
  '长期离线不会堆一地病害（每种里程碑只掷一次）',
  longAilments.length <= 1,
  JSON.stringify(longAilments),
)

// ── ailments and tending ─────────────────────────────────────────────────────

section('照看：浇水与除害')

// A healthy immature plot: tending waters it and raises the rate.
await plantAndAge('radish', 10_000)
r = await call('POST', '/tend', { plot: 0 })
check('照看健康作物 = 浇水', r.status === 200 && r.payload.result.action.kind === 'water', JSON.stringify(r.payload.result))
r = await call('GET', '/state')
check('浇水后速率提高', r.payload.farm.plots[0].rate > 1, `${r.payload.farm.plots[0].rate}`)
check('标记为已浇水', r.payload.farm.plots[0].watered === true)
check('有浇水剩余时间', r.payload.farm.plots[0].wateredMs > 0, `${r.payload.farm.plots[0].wateredMs}`)

// An ailing plot: tending cures instead of watering.
writeSave((save) => {
  save.farm.plots[0] = {
    crop: 'radish', plantedAt: Date.now() - 1000, progress: 0.1, settleAt: Date.now(),
    checks: 1, wateredUntil: 0, ailments: ['dry'],
  }
})
boot()
r = await call('POST', '/tend', { plot: 0 })
check('有病害时照看 = 除害', r.payload.result.action.kind === 'cure', JSON.stringify(r.payload.result))
check('除的是缺水', r.payload.result.action.ailment === 'dry', `${r.payload.result.action.ailment}`)
check('病害被清掉', readSave().farm.plots[0].ailments.length === 0)

section('病害：只减速，不毁作物')

writeSave((save) => {
  save.farm.plots[0] = {
    crop: 'wheat', plantedAt: Date.now(), progress: 0, settleAt: Date.now(),
    checks: 0, wateredUntil: 0, ailments: ['dry', 'weed', 'pest'],
  }
})
boot()
r = await call('GET', '/state')
const sick = r.payload.farm.plots[0]
check('三种病害同时存在', sick.ailments.length === 3, `${sick.ailments.length}`)
check('速率被压低但仍为正', sick.rate > 0 && sick.rate < 1, `${sick.rate}`)
check('作物没有被毁', sick.empty === false && sick.crop === 'wheat')
check('仍然给出剩余时间（不是无穷）', Number.isFinite(sick.remainingMs) && sick.remainingMs > 0, `${sick.remainingMs}`)

// Even fully neglected, it must eventually ripen.
writeSave((save) => {
  save.farm.plots[0] = {
    crop: 'radish', plantedAt: Date.now() - 10 * 3_600_000, progress: 0, settleAt: Date.now() - 10 * 3_600_000,
    checks: 99, wateredUntil: 0, ailments: ['dry', 'weed', 'pest'],
  }
})
boot()
r = await call('GET', '/state')
check('被完全忽视 10 小时后仍然成熟（不会死）', r.payload.farm.plots[0].ready === true, `${r.payload.farm.plots[0].percent}%`)

section('照看：边界')

writeSave(() => {})
boot()
r = await call('POST', '/tend', { plot: 0 })
check('空地上照看被拒', r.status === 400, `status=${r.status}`)
check('错误说明这块地是空的', r.payload.error.includes('空的'), r.payload.error)

writeSave((save) => {
  save.farm.plots[0] = {
    crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(),
    checks: 2, wateredUntil: 0, ailments: [],
  }
})
boot()
r = await call('POST', '/tend', { plot: 0 })
check('成熟的作物不能再照看', r.status === 400, `status=${r.status}`)
check('错误提示去收获', r.payload.error.includes('熟'), r.payload.error)

section('一键照看')

writeSave((save) => {
  save.farm.plots[0] = { crop: 'radish', plantedAt: Date.now(), progress: 0.1, settleAt: Date.now(), checks: 1, wateredUntil: 0, ailments: ['dry'] }
  save.farm.plots[1] = { crop: 'wheat', plantedAt: Date.now(), progress: 0.1, settleAt: Date.now(), checks: 1, wateredUntil: 0, ailments: [] }
  save.farm.plots[2] = null
  // plot 3 is ready: a bulk tend must skip it.
  save.farm.plots[3] = { crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
})
boot()
r = await call('POST', '/tend-all', {})
check('一键照看成功', r.status === 200, `status=${r.status}`)
check('照看了 2 块（跳过成熟与空地）', r.payload.result.tended === 2, `${r.payload.result.tended}`)
check('没有失败项', r.payload.result.failures.length === 0, JSON.stringify(r.payload.result.failures))
const after = readSave()
check('地块 0 的病害被清除', after.farm.plots[0].ailments.length === 0)
check('地块 1 被浇水', after.farm.plots[1].wateredUntil > Date.now())
check('成熟的地块 3 未被改动', after.farm.plots[3].wateredUntil === 0)

// ── harvesting ───────────────────────────────────────────────────────────────

section('收获：产出与背包')

writeSave((save) => {
  save.farm.plots[0] = { crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
})
boot()
r = await call('POST', '/harvest', { plot: 0 })
check('收获成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('存入数量在产量范围内', r.payload.result.stored >= 2 && r.payload.result.stored <= 4, `${r.payload.result.stored}`)
check('没有损失', r.payload.result.lost === 0, `${r.payload.result.lost}`)
check('地块被清空', readSave().farm.plots[0] === null)
check('产出进入背包', r.payload.state.pack.some((row) => row.item === 'radish'), JSON.stringify(r.payload.state.pack))
check('收获计数增加', r.payload.state.farmHarvested === r.payload.result.stored, `${r.payload.state.farmHarvested}`)

section('收获：未熟被拒')

writeSave((save) => {
  save.farm.plots[0] = { crop: 'wheat', plantedAt: Date.now(), progress: 0.1, settleAt: Date.now(), checks: 1, wateredUntil: 0, ailments: [] }
})
boot()
r = await call('POST', '/harvest', { plot: 0 })
check('未熟时收获被拒', r.status === 400, `status=${r.status}`)
check('错误说明还要等', r.payload.error.includes('还没熟'), r.payload.error)

section('收获：背包满时如实报告')

// A pack at capacity must lose produce VISIBLY.
writeSave((save) => {
  save.pack = [{ item: 'shell', count: 20 }]
  save.farm.plots[0] = { crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
})
boot()
r = await call('GET', '/state')
check('测试前背包正好装满', r.payload.state.packUsed === r.payload.state.packSize, `${r.payload.state.packUsed}/${r.payload.state.packSize}`)
r = await call('POST', '/harvest', { plot: 0 })
check('满包时收获仍返回成功', r.status === 200, `status=${r.status}`)
check('一件都没进', r.payload.result.stored === 0, `${r.payload.result.stored}`)
check('损失被如实报告', r.payload.result.lost > 0, `${r.payload.result.lost}`)
check('背包没有超容', r.payload.state.packUsed <= r.payload.state.packSize)
check('收获计数只统计入库的', r.payload.state.farmHarvested === 0, `${r.payload.state.farmHarvested}`)

section('一键收获')

writeSave((save) => {
  save.farm.plots[0] = { crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
  save.farm.plots[1] = { crop: 'wheat', plantedAt: Date.now(), progress: 0.2, settleAt: Date.now(), checks: 1, wateredUntil: 0, ailments: [] }
  save.farm.plots[2] = { crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
})
boot()
r = await call('POST', '/harvest-all', {})
check('一键收获成功', r.status === 200, `status=${r.status}`)
check('收了 2 块（跳过未熟）', r.payload.result.harvested === 2, `${r.payload.result.harvested}`)
check('总入库数正确', r.payload.result.stored >= 4, `${r.payload.result.stored}`)
check('未熟的那块还在', readSave().farm.plots[1] !== null)
check('熟的两块被清空', readSave().farm.plots[0] === null && readSave().farm.plots[2] === null)

section('收获：卖出（用户要求）')

writeSave((save) => {
  save.pack = [{ item: 'lotus', count: 2 }]
})
boot()
r = await call('GET', '/state')
const lotus = r.payload.items.find((i) => i.id === 'lotus')
check('灵莲在物品表里', lotus !== undefined)
check('灵莲可卖', lotus.kind === 'sell' && lotus.sellValue !== null, JSON.stringify(lotus?.sellValue))
check('灵莲标为自家种的', lotus.grown === true)

const diamondBefore = r.payload.state.currencies.diamond
r = await call('POST', '/sell', { item: 'lotus', count: 2 })
check('卖出灵莲成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
const expectedDiamond = Math.max(1, Math.round(64 * 1)) * 2
check(`拿到钻石（${expectedDiamond}）`, r.payload.state.currencies.diamond === diamondBefore + expectedDiamond, `${r.payload.state.currencies.diamond - diamondBefore}`)

// EVERY crop's produce must be sellable — that is the point of the feature.
writeSave(() => {})
boot()
r = await call('GET', '/state')
const unsellable = r.payload.items.filter((i) => i.grown && (i.kind !== 'sell' || i.sellValue === null))
check('所有作物产出都可卖', unsellable.length === 0, unsellable.map((i) => i.id).join(','))

// ── pool separation ──────────────────────────────────────────────────────────

section('作物不会污染探险掉落')

const expeditionIds = new Set(ITEMS.map((i) => i.id))
const leaked = FARM_PRODUCE.filter((p) => expeditionIds.has(p.id)).map((p) => p.id)
check('作物产出不在探险物品表里', leaked.length === 0, leaked.join(','))
/**
 * The item union must contain every table that feeds it.
 *
 * Written as "every id from every source table resolves in the union" rather
 * than as an arithmetic sum, because the sum has to be edited every time a table
 * is added — and forgetting is silent: the count assertion breaks, someone bumps
 * the number, and the invariant that mattered (fish are sellable, crops are
 * sellable, ores are sellable) was never actually checked.
 */
const unionIds = new Set(ALL_ITEMS.map((item) => item.id))
const sources = { ITEMS, FARM_PRODUCE, ORES, FORAGE_EXTRA_ITEMS, FISH_ITEMS }
const missingFromUnion = Object.entries(sources).flatMap(([name, table]) =>
  table.filter((entry) => !unionIds.has(entry.id)).map((entry) => `${name}:${entry.id}`),
)
check('联合表包含全部来源表的每一项', missingFromUnion.length === 0, missingFromUnion.join(','))
check('联合表没有重复 id', unionIds.size === ALL_ITEMS.length, `${ALL_ITEMS.length - unionIds.size} duplicated`)
// Fish enter the union through a DERIVED table, so a broken derivation would
// leave every fish unsellable while the total count still looked plausible.
check(
  '鱼全部进了联合表且可卖',
  FISH_ITEMS.every((fish) => {
    const found = ALL_ITEMS.find((item) => item.id === fish.id)
    return found !== undefined && found.kind === 'sell'
  }),
  FISH_ITEMS.filter((fish) => !unionIds.has(fish.id)).map((f) => f.id).join(','),
)

// The snapshot's `items` is the union (so the pack can resolve a crop)…
r = await call('GET', '/state')
check('快照 items 是联合表', r.payload.items.length === ALL_ITEMS.length, `${r.payload.items.length}`)
// …but the codex tallies must not count a grown crop as a discovery.
check(
  '作物产出的 found 为 0（不是野外发现的）',
  r.payload.items.filter((i) => i.grown).every((i) => i.found === 0),
  JSON.stringify(r.payload.items.filter((i) => i.grown).map((i) => `${i.id}:${i.found}`)),
)

// Actually growing something must still leave the expedition codex untouched.
writeSave((save) => {
  save.farm.plots[0] = { crop: 'lotus', plantedAt: Date.now() - 86_400_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
})
boot()
await call('POST', '/harvest', { plot: 0 })
r = await call('GET', '/state')
check('收获后 codex 仍无作物记录', Object.keys(r.payload.state.expedition.found).length === 0, JSON.stringify(r.payload.state.expedition.found))
check('收获后最高品质未被作物抬高', r.payload.state.expedition.bestTier === null, `${r.payload.state.expedition.bestTier}`)

// ── expansion ────────────────────────────────────────────────────────────────

section('开垦新地')

writeSave(() => {})
boot()
r = await call('GET', '/state')
const firstCost = r.payload.farm.expandCost
check('给出开垦价格', firstCost > 0, `${firstCost}`)

r = await call('POST', '/expand', {})
check('开垦成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check('地块 +1', r.payload.farm.plots.length === FARM_PLOTS_BASE + 1, `${r.payload.farm.plots.length}`)
check('扣了金币', r.payload.state.currencies.gold === 100_000 - firstCost, `${r.payload.state.currencies.gold}`)
check('下一块更贵', r.payload.farm.expandCost > firstCost, `${firstCost} -> ${r.payload.farm.expandCost}`)

// Fill to the maximum and confirm it refuses past it.
writeSave((save) => {
  save.farm.plots = Array.from({ length: FARM_PLOTS_MAX }, () => null)
})
boot()
r = await call('POST', '/expand', {})
check('到达上限后拒绝', r.status === 400, `status=${r.status}`)
check('错误说明上限', r.payload.error.includes(String(FARM_PLOTS_MAX)), r.payload.error)
check('上限时没有开垦价格', (await call('GET', '/state')).payload.farm.expandCost === null)

writeSave((save) => {
  save.currencies.gold = 0
})
boot()
r = await call('POST', '/expand', {})
check('没钱开垦时被拒', r.status === 400, `status=${r.status}`)
check('错误说明费用不够', r.payload.error.includes('开垦费用不够'), r.payload.error)

// ── economics ────────────────────────────────────────────────────────────────

section('作物经济：长周期必须更值，且都能赚钱')

const valueOf = (map) =>
  Object.entries(map ?? {}).reduce((sum, [key, amount]) => sum + (VALUATION[key] ?? 0) * amount, 0)

const ratios = CROPS.map((crop) => {
  const produce = FARM_PRODUCE.find((p) => p.id === crop.yield.item)
  const seed = valueOf(crop.seed)
  const average = (crop.yield.min + crop.yield.max) / 2
  const income = valueOf(produce.sellFor) * average
  return { id: crop.id, label: crop.label, ratio: income / seed, seed, income, hours: crop.needMs / 3_600_000 }
})

check(
  '每个作物都能回本（ratio > 1）',
  ratios.every((entry) => entry.ratio > 1),
  ratios.map((e) => `${e.label}:${e.ratio.toFixed(2)}`).join(' '),
)
check(
  'ratio 随耗时单调上升（长周期不吃亏）',
  ratios.every((entry, i) => i === 0 || entry.ratio >= ratios[i - 1].ratio - 0.01),
  ratios.map((e) => `${e.label}:${e.ratio.toFixed(2)}`).join(' '),
)
check(
  '没有哪个作物的收益率被邻居完全碾压（相邻比 ≤ 2.5×）',
  ratios.every((entry, i) => i === 0 || entry.ratio / ratios[i - 1].ratio <= 2.5),
  ratios.map((e) => `${e.label}:${e.ratio.toFixed(2)}`).join(' '),
)

// ── persistence ──────────────────────────────────────────────────────────────

section('农场跨重启保留')

writeSave((save) => {
  save.farm.plots[0] = { crop: 'grape', plantedAt: Date.now() - 1000, progress: 0.42, settleAt: Date.now() - 500, checks: 1, wateredUntil: Date.now() + 60_000, ailments: ['weed'] }
  save.farm.harvested = 77
  save.farm.byCrop = { radish: 40, wheat: 37 }
  save.farm.tended = 12
})
boot()
r = await call('GET', '/state')
const kept = r.payload.farm.plots[0]
check('作物保留', kept.crop === 'grape', `${kept.crop}`)
check('病害保留', kept.ailments.length === 1 && kept.ailments[0].id === 'weed', JSON.stringify(kept.ailments))
check('浇水状态保留', kept.watered === true)
check('收获总数保留', r.payload.farm.harvested === 77, `${r.payload.farm.harvested}`)
check('按作物计数保留', r.payload.farm.byCrop.radish === 40, JSON.stringify(r.payload.farm.byCrop))
check('照看次数保留', r.payload.farm.tended === 12, `${r.payload.farm.tended}`)
check('进度没有被重置为 0', kept.percent >= 42, `${kept.percent}%`)

section('存档卫生：非法农场数据被清理')

writeSave((save) => {
  save.farm.plots = [
    { crop: 'not-a-crop', plantedAt: Date.now(), progress: 0.5, settleAt: Date.now(), checks: 0, wateredUntil: 0, ailments: [] },
    { crop: 'radish', plantedAt: Date.now(), progress: 99, settleAt: Date.now(), checks: -5, wateredUntil: -1, ailments: ['not-an-ailment', 'dry', 'dry'] },
    null,
    'garbage',
  ]
})
boot()
r = await call('GET', '/state')
const cleaned = readSave()
check('未知作物变成空地', cleaned.farm.plots[0] === null, JSON.stringify(cleaned.farm.plots[0]))
check('进度被夹到 ≤ 1', cleaned.farm.plots[1].progress <= 1, `${cleaned.farm.plots[1].progress}`)
check('负数 checks 被夹到 0', cleaned.farm.plots[1].checks >= 0, `${cleaned.farm.plots[1].checks}`)
check('负数 wateredUntil 被夹到 0', cleaned.farm.plots[1].wateredUntil >= 0, `${cleaned.farm.plots[1].wateredUntil}`)
check('未知病害被丢弃', !cleaned.farm.plots[1].ailments.includes('not-an-ailment'), JSON.stringify(cleaned.farm.plots[1].ailments))
check('重复病害被去重', cleaned.farm.plots[1].ailments.length <= 1, JSON.stringify(cleaned.farm.plots[1].ailments))
check('非对象的地块变成空地', cleaned.farm.plots[3] === null, JSON.stringify(cleaned.farm.plots[3]))

// Plot count must be clamped: a hand-edited save cannot grant itself land.
writeSave((save) => {
  save.farm.plots = Array.from({ length: 999 }, () => null)
})
boot()
r = await call('GET', '/state')
check('地块数被夹到上限', r.payload.farm.plots.length === FARM_PLOTS_MAX, `${r.payload.farm.plots.length}`)

writeSave((save) => {
  save.farm.plots = []
})
boot()
r = await call('GET', '/state')
check('空的地块数组补足到基础数量', r.payload.farm.plots.length === FARM_PLOTS_BASE, `${r.payload.farm.plots.length}`)

// ── migration ────────────────────────────────────────────────────────────────

section('v4 存档升级到 v5')

const v4 = {
  version: 4,
  bornAt: Date.now() - 1000,
  lastSeenAt: Date.now(),
  currencies: { xp: 500, coin: 50, gold: 10, diamond: 1, bar: 0, relic: 0, star: 2 },
  earned: { xp: 500, coin: 50, gold: 10, diamond: 1, bar: 0, relic: 0, star: 2 },
  periods: Object.fromEntries(PERIOD_KEYS.map((key) => [key, { lastAt: 0, lastKey: '', streak: 2, best: 5, total: 9 }])),
  achievements: { 'first-blood': Date.now() },
  stats: { luckyHits: 1, perfectDays: 2, bestCombo: 3, hours: [9], perfectKeys: [], counts: Object.fromEntries(PERIOD_KEYS.map((k) => [k, 9])) },
  upgrades: { minuteYield: 2 },
  chests: { opened: 5, byId: { wood: 5 } },
  offline: { pool: { coin: 3, gold: 1 }, accruedAt: Date.now(), collected: 2 },
  supplies: { current: 8, regenAt: Date.now() },
  pack: [{ item: 'shell', count: 4 }],
  expedition: { found: { shell: 4 }, sold: { ore: 2 }, runs: 3, bestTier: 'uncommon', byDestination: { forest: 3 }, used: 1 },
  trip: null,
  buffs: [],
  daily: { key: '', counters: {}, claimed: {}, allClaimed: false },
  questAllDays: 4,
  alchemy: { runs: 7, byRecipe: { grind: 7 } },
  rebirth: { count: 2, bestLevel: 80 },
  starUpgrades: { starYield: 3 },
  history: [{ id: 1, at: Date.now(), kind: 'claim', label: '每分钟', granted: { xp: 2 } }],
}
fs.mkdirSync(path.dirname(SAVE), { recursive: true })
fs.writeFileSync(SAVE, `${JSON.stringify(v4, null, 2)}\n`, 'utf8')
boot()
r = await call('GET', '/state')
check('旧存档能加载', r.status === 200)
check('旧数据保留（经验）', r.payload.state.currencies.xp === 500, `${r.payload.state.currencies.xp}`)
check('旧数据保留（星辰）', r.payload.state.currencies.star === 2, `${r.payload.state.currencies.star}`)
check('旧数据保留（转生次数）', r.payload.rebirth.count === 2, `${r.payload.rebirth.count}`)
check('旧数据保留（背包）', r.payload.state.pack.some((x) => x.item === 'shell'))
check('新字段补齐（农场）', r.payload.farm.plots.length === FARM_PLOTS_BASE)
check('新字段补齐（农场全空）', r.payload.farm.plots.every((p) => p.empty === true))
check('新字段补齐（作物目录）', r.payload.crops.length === CROPS.length)
check('存档版本升到 6', readSave().version === 6, `${readSave().version}`)

// ── achievements ─────────────────────────────────────────────────────────────

section('农场成就')

writeSave((save) => {
  save.farm.harvested = 6_000
  save.farm.tended = 600
  save.farm.byCrop = Object.fromEntries(CROPS.map((c) => [c.id, 10]))
  save.farm.plots = Array.from({ length: FARM_PLOTS_MAX }, (_, i) => ({
    crop: CROPS[i % CROPS.length].id,
    plantedAt: Date.now(),
    progress: i < 3 ? 1 : 0.2,
    settleAt: Date.now(),
    checks: 1,
    wateredUntil: 0,
    ailments: [],
  }))
})
boot()
r = await call('GET', '/state')
const ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
const has = (id) => ids.includes(id)
check('下地成就', has('farm-plant-1'), ids.join(','))
check('首次收成成就', has('farm-harvest-1'), ids.join(','))
check('收获 5000 成就', has('farm-harvest-5000'), ids.join(','))
check('照看 500 成就', has('farm-tend-500'), ids.join(','))
check('五谷丰登成就（6 种全种过）', has('farm-kinds-all'), ids.join(','))
check('良田千亩成就（18 块）', has('farm-plots-max'), ids.join(','))
check('没有空地成就', has('farm-full'), ids.join(','))
check('灵莲成就', has('farm-lotus'), ids.join(','))
check('同时 3 块熟成就', has('farm-ready-3'), ids.join(','))

// ── daily quests ─────────────────────────────────────────────────────────────

section('农场任务会被计入')

writeSave(() => {})
boot()
await call('POST', '/plant', { plot: 0, crop: 'radish' })
const counters = readSave().daily.counters
check('种植计入当天计数', (counters.planted ?? 0) === 1, JSON.stringify(counters))

writeSave((save) => {
  save.farm.plots[0] = { crop: 'radish', plantedAt: Date.now() - 3_600_000, progress: 1, settleAt: Date.now(), checks: 2, wateredUntil: 0, ailments: [] }
})
boot()
await call('POST', '/harvest', { plot: 0 })
check('收获计入当天计数', (readSave().daily.counters.harvest ?? 0) > 0, JSON.stringify(readSave().daily.counters))

writeSave((save) => {
  save.farm.plots[0] = { crop: 'radish', plantedAt: Date.now(), progress: 0.1, settleAt: Date.now(), checks: 1, wateredUntil: 0, ailments: [] }
})
boot()
await call('POST', '/tend', { plot: 0 })
check('照看计入当天计数', (readSave().daily.counters.tended ?? 0) === 1, JSON.stringify(readSave().daily.counters))

// The quest pool must actually contain farm quests, or none of the above matters.
const { QUEST_POOL } = await import('../index.js')
const farmQuests = QUEST_POOL.filter((q) => ['planted', 'harvest', 'tended'].includes(q.metric))
check('任务池含农场任务', farmQuests.length >= 3, `${farmQuests.length}`)

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
