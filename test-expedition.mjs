/**
 * Expedition, backpack and supply tests.
 *
 * The expedition system is the most stateful thing in the plugin: a trip spans
 * wall-clock time, spends a consumable, produces randomized loot, and must
 * survive a restart in the middle. The bugs it invites are all timing or
 * boundary bugs — a trip that never becomes ready, supplies that go negative, a
 * backpack that exceeds its capacity, a buff that outlives its duration.
 *
 *   node tools/test-expedition.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-exp-'))
process.env.DSH_HOME = tmpHome

const { apply, ITEMS, EXPEDITIONS, UPGRADES, RECIPES, CROPS, ORES, SUPPLY_MAX_BASE } = await import('../index.js')

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

/** A complete save, so sections cannot contaminate each other. */
function writeSave(mutate) {
  const save = {
    version: 3,
    bornAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now(),
    currencies: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0, relic: 0 },
    earned: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0, relic: 0 },
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
    supplies: { current: SUPPLY_MAX_BASE, regenAt: Date.now() },
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

function readSave() {
  return JSON.parse(fs.readFileSync(SAVE, 'utf8'))
}

function writeRaw(save) {
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

// ── departing ────────────────────────────────────────────────────────────────

section('出发：扣物资、定时、落存档')

writeSave(() => {})
boot()
let r = await call('GET', '/state')
const outskirts = r.payload.destinations.find((d) => d.id === 'outskirts')
check('初始物资等于基础上限', r.payload.state.supplies.current === SUPPLY_MAX_BASE, `${r.payload.state.supplies.current}`)
check('目的地列表与 EXPEDITIONS 一致', r.payload.destinations.length === EXPEDITIONS.length)

const before = r.payload.state.supplies.current
r = await call('POST', '/depart', { destination: 'outskirts' })
check('出发成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
check(
  `扣掉 ${outskirts.supply} 点物资`,
  r.payload.state.supplies.current === before - outskirts.supply,
  `${before} → ${r.payload.state.supplies.current}`,
)
check('state.trip 已记录', r.payload.state.trip !== null)
check('trip.destination 正确', r.payload.state.trip.destination === 'outskirts')
check('trip 未就绪', r.payload.state.trip.ready === false)
check('trip 剩余时间为正', r.payload.state.trip.remainingMs > 0)
check('trip 已落盘', readSave().trip !== null)

section('出发：重复出发被拒')

r = await call('POST', '/depart', { destination: 'forest' })
check('已在外时再次出发返回 400', r.status === 400, `status=${r.status}`)
check('错误说明你还在外面', r.payload.error.includes('还在外面'), r.payload.error)

section('出发：物资不足被拒')

writeSave((save) => {
  save.supplies.current = 0
})
boot()
r = await call('POST', '/depart', { destination: 'abyss' })
check('物资不足返回 400', r.status === 400, `status=${r.status}`)
check('错误说明需要多少', r.payload.error.includes('物资不够'), r.payload.error)
check('错误给出替代方案', r.payload.error.includes('药草') || r.payload.error.includes('等待'), r.payload.error)
check('失败时没有出发', (await call('GET', '/state')).payload.state.trip === null)

section('出发：未知地点被拒')

writeSave(() => {})
boot()
r = await call('POST', '/depart', { destination: 'atlantis' })
check('未知地点返回 400', r.status === 400)
check('错误说明没有这个地方', r.payload.error.includes('没有这个地方'), r.payload.error)

// ── collecting ───────────────────────────────────────────────────────────────

section('收取：未到时间被拒')

writeSave(() => {})
boot()
await call('POST', '/depart', { destination: 'forest' })
r = await call('POST', '/collect-trip', {})
check('未到时间收取返回 400', r.status === 400, `status=${r.status}`)
check('错误说明还要等', r.payload.error.includes('还没回来'), r.payload.error)

section('收取：到时间后拿到东西')

const save = readSave()
save.trip.readyAt = Date.now() - 1000
writeRaw(save)
boot()

r = await call('POST', '/collect-trip', {})
check('收取成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
check('找到至少一件东西', r.payload.result.found.length >= 1, JSON.stringify(r.payload.result.found))
check('东西都进了背包', r.payload.state.packTotal >= 1, `${r.payload.state.packTotal}`)
check('trip 归 null', r.payload.state.trip === null)
check('行程计数 +1', r.payload.state.expedition.runs === 1)
check('按地点计数 +1', (r.payload.state.expedition.byDestination.forest ?? 0) === 1)
check(
  '找到的东西都是真实物品',
  r.payload.result.found.every((id) => ITEMS.some((item) => item.id === id)),
  r.payload.result.found.join(','),
)
check('背包条目都有 item/count', r.payload.state.pack.every((row) => typeof row.item === 'string' && row.count > 0))
check('history 记了这次行程', r.payload.state.history.some((e) => e.kind === 'return'))

section('收取：没出发时被拒')

writeSave(() => {})
boot()
r = await call('POST', '/collect-trip', {})
check('在家时收取返回 400', r.status === 400, `status=${r.status}`)
check('错误说明你现在在家', r.payload.error.includes('在家'), r.payload.error)

section('行程跨重启保留')

writeSave(() => {})
boot()
await call('POST', '/depart', { destination: 'ruins' })
const savedTrip = readSave().trip
check('出发后立即落盘', savedTrip !== null && savedTrip.destination === 'ruins')

// Reload: the trip must still be there and still become collectable.
boot()
r = await call('GET', '/state')
check('重载后行程仍在', r.payload.state.trip !== null, JSON.stringify(r.payload.state.trip))
check('重载后仍是同一个地点', r.payload.state.trip.destination === 'ruins')

const aged = readSave()
aged.trip.readyAt = Date.now() - 1000
writeRaw(aged)
boot()
r = await call('POST', '/collect-trip', {})
check('重载后仍能收取', r.status === 200, JSON.stringify(r.payload).slice(0, 160))

section('掉落品质：地点越远越好')

// Sample each destination many times and compare rarity distribution.
function sampleRarity(destinationId, iterations) {
  const counts = { common: 0, uncommon: 0, rare: 0, legendary: 0 }
  let total = 0
  for (let i = 0; i < iterations; i += 1) {
    writeSave((save) => {
      save.supplies.current = 999
      save.trip = {
        destination: destinationId,
        startedAt: Date.now() - 1000,
        readyAt: Date.now() - 1,
        spent: 1,
      }
    })
    boot()
    // The collect is synchronous through the route, so drive it directly.
    const result = route.handler(
      {
        method: 'POST',
        url: '/api/checkin/collect-trip',
        headers: {},
        async *[Symbol.asyncIterator]() {},
      },
      { writeHead() {}, end() {} },
    )
    void result
    const after = readSave()
    for (const id of Object.keys(after.expedition.found)) {
      const item = ITEMS.find((entry) => entry.id === id)
      if (item === undefined) continue
      counts[item.rarity] = (counts[item.rarity] ?? 0) + after.expedition.found[id]
      total += after.expedition.found[id]
    }
  }
  return { counts, total }
}

const nearSample = sampleRarity('outskirts', 40)
const deepSample = sampleRarity('abyss', 40)
const nearRareRate = (nearSample.counts.rare + nearSample.counts.legendary) / Math.max(1, nearSample.total)
const deepRareRate = (deepSample.counts.rare + deepSample.counts.legendary) / Math.max(1, deepSample.total)
check(
  '深渊的稀有率高于近郊',
  deepRareRate > nearRareRate,
  `近郊=${(nearRareRate * 100).toFixed(1)}% 深渊=${(deepRareRate * 100).toFixed(1)}%`,
)
check('近郊样本有产出', nearSample.total > 0, `${nearSample.total}`)
check('深渊样本有产出', deepSample.total > 0, `${deepSample.total}`)

section('背包容量')

// Capacity is measured in ITEMS. Fill to exactly the cap with distinct items,
// then trip and confirm the overflow is reported instead of silently exceeding.
const packSize = 20
writeSave((save) => {
  // 20 items spread across the known kinds, filling the pack exactly.
  save.pack = ITEMS.slice(0, 10).map((item, index) => ({ item: item.id, count: index < 10 ? 2 : 1 }))
  save.supplies.current = 99
  save.trip = { destination: 'abyss', startedAt: Date.now() - 1000, readyAt: Date.now() - 1, spent: 1 }
})
boot()
r = await call('GET', '/state')
check('测试前背包正好装满', r.payload.state.packUsed === packSize, `used=${r.payload.state.packUsed}`)

r = await call('POST', '/collect-trip', {})
check('背包满时收取仍然成功', r.status === 200, JSON.stringify(r.payload).slice(0, 160))
check(
  '背包没有超过容量',
  r.payload.state.packUsed <= r.payload.state.packSize,
  `used=${r.payload.state.packUsed} size=${r.payload.state.packSize}`,
)
check(
  '被丢弃的东西有报告',
  r.payload.result.leftBehind.length > 0,
  JSON.stringify(r.payload.result),
)
check('满包时一件都没进', r.payload.result.found.length === 0, JSON.stringify(r.payload.result.found))

// A non-full pack must accept items even when they are new kinds.
writeSave((save) => {
  save.pack = [{ item: 'shell', count: 5 }]
  save.supplies.current = 99
  save.trip = { destination: 'outskirts', startedAt: Date.now() - 1000, readyAt: Date.now() - 1, spent: 1 }
})
boot()
r = await call('POST', '/collect-trip', {})
check('有空间时能装下', r.payload.result.found.length >= 1, JSON.stringify(r.payload.result.found))
check('堆叠仍在', r.payload.state.pack.some((row) => row.item === 'shell'), JSON.stringify(r.payload.state.pack))
check('总量增加了', r.payload.state.packUsed > 5, `${r.payload.state.packUsed}`)

// ── supplies ─────────────────────────────────────────────────────────────────

section('物资：自然恢复')

writeSave((save) => {
  save.supplies.current = 0
  // 3 regen periods (20 min each) in the past.
  save.supplies.regenAt = Date.now() - 3 * 20 * 60_000
})
boot()
r = await call('GET', '/state')
check('物资随离线时间恢复', r.payload.state.supplies.current === 3, `${r.payload.state.supplies.current}`)
check('恢复不会超过上限', r.payload.state.supplies.current <= r.payload.state.supplies.cap)

writeSave((save) => {
  save.supplies.current = 0
  save.supplies.regenAt = Date.now() - 100 * 20 * 60_000
})
boot()
r = await call('GET', '/state')
check('超长离线恢复到上限即止', r.payload.state.supplies.current === r.payload.state.supplies.cap, `${r.payload.state.supplies.current}`)

writeSave((save) => {
  save.supplies.current = SUPPLY_MAX_BASE
  save.supplies.regenAt = Date.now() - 500 * 20 * 60_000
})
boot()
r = await call('GET', '/state')
check('满物资时不会溢出', r.payload.state.supplies.current === r.payload.state.supplies.cap, `${r.payload.state.supplies.current}`)

section('物资：上限升级')

writeSave((save) => {
  save.upgrades.supplyCap = 5
  save.supplies.current = 0
  save.supplies.regenAt = Date.now() - 100 * 20 * 60_000
})
boot()
r = await call('GET', '/state')
const expectedCap = SUPPLY_MAX_BASE + 5 * 4
check(`上限 = ${SUPPLY_MAX_BASE} + 5×4 = ${expectedCap}`, r.payload.state.supplies.cap === expectedCap, `${r.payload.state.supplies.cap}`)
check('恢复到新上限', r.payload.state.supplies.current === expectedCap, `${r.payload.state.supplies.current}`)

// ── selling ──────────────────────────────────────────────────────────────────

section('卖东西')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 3 }]
})
boot()
r = await call('GET', '/state')
const shellRow = r.payload.items.find((i) => i.id === 'shell')
check('shell 是可卖品', shellRow.kind === 'sell')
check('sellValue 是映射', shellRow.sellValue !== null, JSON.stringify(shellRow.sellValue))

r = await call('POST', '/sell', { item: 'shell', count: 3 })
check('卖出成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
check('背包清空该物品', r.payload.state.pack.every((row) => row.item !== 'shell'), JSON.stringify(r.payload.state.pack))
const shellCurrency = Object.keys(shellRow.sellValue)[0]
check(
  `拿到 ${shellCurrency}`,
  r.payload.state.currencies[shellCurrency] === shellRow.sellValue[shellCurrency] * 3,
  `${r.payload.state.currencies[shellCurrency]}`,
)
check('卖出计数记录了 3', r.payload.state.expedition.sold.shell === 3, `${r.payload.state.expedition.sold.shell}`)

section('卖东西：边界')

writeSave((save) => {
  save.pack = [{ item: 'ore', count: 2 }]
})
boot()
r = await call('POST', '/sell', { item: 'ore', count: 99 })
check('超量卖出被夹到实际数量', r.status === 200 && r.payload.result.count === 2, JSON.stringify(r.payload.result))

writeSave(() => {})
boot()
r = await call('POST', '/sell', { item: 'shell', count: 1 })
check('没有的东西卖不掉', r.status === 400, `status=${r.status}`)
check('错误说明背包里没有', r.payload.error.includes('背包里没有'), r.payload.error)

writeSave((save) => {
  save.pack = [{ item: 'herb', count: 1 }]
})
boot()
r = await call('POST', '/sell', { item: 'herb', count: 1 })
check('补给品不能卖', r.status === 400, `status=${r.status}`)
check('错误说明它不是拿来卖的', r.payload.error.includes('不是拿来卖的'), r.payload.error)

section('卖价受议价术影响')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 1 }]
  save.upgrades.haggle = 4
})
boot()
r = await call('GET', '/state')
const base = ITEMS.find((i) => i.id === 'shell').sellFor.coin
const expected = Math.max(1, Math.round(base * (1 + 4 * 0.15)))
check(`议价 4 级后单价 = ${expected}`, r.payload.items.find((i) => i.id === 'shell').sellValue.coin === expected, `${r.payload.items.find((i) => i.id === 'shell').sellValue.coin}`)
r = await call('POST', '/sell', { item: 'shell', count: 1 })
check('实际到手与显示一致', r.payload.result.gained.coin === expected, `${r.payload.result.gained.coin}`)
check('返回了倍率', Math.abs(r.payload.result.multiplier - 1.6) < 1e-9, `${r.payload.result.multiplier}`)

section('大量卖出的整数性')

// Selling N must equal N single sales — a per-unit rounding bug would show here.
writeSave((save) => {
  save.pack = [{ item: 'coin-pouch', count: 7 }]
})
boot()
r = await call('POST', '/sell', { item: 'coin-pouch', count: 7 })
const bulk = r.payload.result.gained.coin

writeSave((save) => {
  save.pack = [{ item: 'coin-pouch', count: 7 }]
})
boot()
let singles = 0
for (let i = 0; i < 7; i += 1) {
  const res = await call('POST', '/sell', { item: 'coin-pouch', count: 1 })
  singles += res.payload.result.gained.coin
}
check('一次卖 7 个 = 分 7 次卖', bulk === singles, `bulk=${bulk} singles=${singles}`)

// ── using items ──────────────────────────────────────────────────────────────

section('用道具：补给')

writeSave((save) => {
  save.pack = [{ item: 'herb', count: 2 }]
  save.supplies.current = 0
})
boot()
r = await call('POST', '/use', { item: 'herb' })
check('用药草成功', r.status === 200, JSON.stringify(r.payload).slice(0, 180))
check('detail.kind 为 supply', r.payload.result.detail.kind === 'supply')
check('物资被补充', r.payload.result.detail.restored === 4, `${r.payload.result.detail.restored}`)
check('堆叠减一', r.payload.state.pack.find((row) => row.item === 'herb').count === 1)

section('用道具：使用计数与上限')

writeSave((save) => {
  save.pack = [{ item: 'elixir', count: 1 }]
  save.supplies.current = 2
})
boot()
r = await call('POST', '/use', { item: 'elixir' })
check('灵药补满', r.payload.state.supplies.current === r.payload.state.supplies.cap, `${r.payload.state.supplies.current}`)
check('不会超过上限', r.payload.state.supplies.current <= r.payload.state.supplies.cap)
check('使用计数 +1', r.payload.state.usedTotal === 1, `${r.payload.state.usedTotal}`)
check('用完后从背包移除', r.payload.state.pack.every((row) => row.item !== 'elixir'))

section('用道具：增益')

writeSave((save) => {
  save.pack = [{ item: 'charm', count: 1 }]
})
boot()
r = await call('GET', '/state')
const luckBefore = r.payload.state.modifiers.luck
r = await call('POST', '/use', { item: 'charm' })
check('用护身符成功', r.status === 200)
check('detail.kind 为 buff', r.payload.result.detail.kind === 'buff')
check('出现一个生效中的增益', r.payload.state.buffs.length === 1, `${r.payload.state.buffs.length}`)
check('幸运提高了', r.payload.state.modifiers.luck > luckBefore, `${luckBefore} → ${r.payload.state.modifiers.luck}`)
check(
  '增益量等于护身符声明值',
  Math.abs(r.payload.state.modifiers.luck - (luckBefore + 0.15)) < 1e-9,
  `${r.payload.state.modifiers.luck}`,
)

section('增益：过期后失效')

writeSave((save) => {
  save.buffs = [
    { id: 'luck', label: '好运', stat: 'luck', amount: 0.15, until: Date.now() - 1000 },
  ]
})
boot()
r = await call('GET', '/state')
check('过期增益被清掉', r.payload.state.buffs.length === 0, `${r.payload.state.buffs.length}`)
check('幸运回到基线', Math.abs(r.payload.state.modifiers.luck) < 1e-9, `${r.payload.state.modifiers.luck}`)

section('增益：重复使用是刷新而不是叠加')

writeSave((save) => {
  save.pack = [
    { item: 'charm', count: 3 },
  ]
})
boot()
await call('POST', '/use', { item: 'charm' })
r = await call('GET', '/state')
const first = r.payload.state.buffs[0].until
await call('POST', '/use', { item: 'charm' })
r = await call('GET', '/state')
check('仍然只有一个增益', r.payload.state.buffs.length === 1, `${r.payload.state.buffs.length}`)
check('幸运没有叠加', Math.abs(r.payload.state.modifiers.luck - 0.15) < 1e-9, `${r.payload.state.modifiers.luck}`)
check('时间被刷新', r.payload.state.buffs[0].until >= first, `${first} → ${r.payload.state.buffs[0].until}`)

section('用道具：边界')

writeSave((save) => {
  save.pack = [{ item: 'shell', count: 1 }]
})
boot()
r = await call('POST', '/use', { item: 'shell' })
check('卖品不能用', r.status === 400, `status=${r.status}`)
check('错误说明它是拿来卖的', r.payload.error.includes('拿来卖的'), r.payload.error)

writeSave(() => {})
boot()
r = await call('POST', '/use', { item: 'herb' })
check('没有的东西用不了', r.status === 400, `status=${r.status}`)

r = await call('POST', '/use', { item: 'nonexistent' })
check('未知物品返回 400', r.status === 400)
check('错误说明没有这个物品', r.payload.error.includes('没有这个物品'), r.payload.error)

// ── upgrades ─────────────────────────────────────────────────────────────────

section('出行类升级')

writeSave((save) => {
  save.upgrades.swift = 10
  save.upgrades.thrift = 4
})
boot()
r = await call('GET', '/state')
const forest = r.payload.destinations.find((d) => d.id === 'forest')
check('快靴缩短耗时', forest.effectiveHours < forest.hours, `${forest.effectiveHours} vs ${forest.hours}`)
check('节俭降低物资消耗', forest.supply < forest.baseSupply, `${forest.supply} vs ${forest.baseSupply}`)

const abyssDef = EXPEDITIONS.find((d) => d.id === 'abyss')
const abyss = r.payload.destinations.find((d) => d.id === 'abyss')
check('消耗不会低于 1', abyss.supply >= 1, `${abyss.supply}`)
check(
  '过度节俭被夹在 1',
  abyssDef.supply - 4 <= 1 ? abyss.supply === 1 : true,
  `${abyss.supply}`,
)

section('寻宝罗盘提高品质')

// With a large fortune bonus, rare tiers must dominate over a big sample.
writeSave((save) => {
  save.upgrades.fortune = 12
  save.supplies.current = 999
})
let rareWithCompass = 0
let totalWithCompass = 0
for (let i = 0; i < 30; i += 1) {
  writeSave((save) => {
    save.upgrades.fortune = 12
    save.supplies.current = 999
    save.trip = { destination: 'forest', startedAt: Date.now() - 1000, readyAt: Date.now() - 1, spent: 1 }
  })
  boot()
  route.handler(
    {
      method: 'POST',
      url: '/api/checkin/collect-trip',
      headers: {},
      async *[Symbol.asyncIterator]() {},
    },
    { writeHead() {}, end() {} },
  )
  const after = readSave()
  for (const id of Object.keys(after.expedition.found)) {
    const item = ITEMS.find((entry) => entry.id === id)
    if (item === undefined) continue
    totalWithCompass += after.expedition.found[id]
    if (item.rarity === 'rare' || item.rarity === 'legendary') {
      rareWithCompass += after.expedition.found[id]
    }
  }
}
// Forest's base rare rate is 10/100; +12 fortune must lift it clearly.
check(
  '罗盘显著提高稀有率',
  totalWithCompass > 0 && rareWithCompass / totalWithCompass > 0.2,
  `${((rareWithCompass / Math.max(1, totalWithCompass)) * 100).toFixed(1)}%`,
)

section('背包扩容')

writeSave((save) => {
  save.upgrades.packSize = 5
})
boot()
r = await call('GET', '/state')
check('背包容量 = 20 + 5×6 = 50', r.payload.state.packSize === 50, `${r.payload.state.packSize}`)

// ── achievements ─────────────────────────────────────────────────────────────

section('出行与背包成就')

writeSave((save) => {
  save.expedition.runs = 60
  save.expedition.byDestination = { outskirts: 10, forest: 20, ruins: 20, abyss: 10 }
  save.expedition.found = Object.fromEntries(ITEMS.map((item) => [item.id, 1]))
  save.expedition.sold = { shell: 30, ore: 40, 'coin-pouch': 35 }
  save.expedition.used = 5
  save.expedition.bestTier = 'legendary'
  // 20 items so the pack-20 achievement is genuinely satisfied (capacity is
  // counted in items, not stacks).
  save.pack = ITEMS.slice(0, 8).map((item) => ({ item: item.id, count: 3 }))
  save.buffs = [
    { id: 'luck', label: '好运', stat: 'luck', amount: 0.15, until: Date.now() + 60_000 },
    { id: 'fortune', label: '远征收成', stat: 'fortune', amount: 0.5, until: Date.now() + 60_000 },
  ]
  save.currencies.relic = 30
  save.earned.relic = 30
  save.supplies.current = 12
})
boot()
r = await call('GET', '/state')
const ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
const has = (id) => ids.includes(id)

check('第一次出门成就', has('first-trip'), ids.join(','))
check('50 次行程成就', has('trip-50'), ids.join(','))
check('深渊成就', has('abyss-1'), ids.join(','))
check('图鉴全满成就', has('unique-all'), ids.join(','))
check('传说品质成就', has('rarity-legendary'), ids.join(','))
check('卖出 100 件成就', has('sell-100'), ids.join(','))
check('遗物 25 成就', has('relic-25'), ids.join(','))
check('使用道具成就', has('first-use'), ids.join(','))
check('两个增益成就', has('buff-active'), ids.join(','))
check('背包 20 件成就', has('pack-20'), ids.join(','))
check('未达标的 1000 次行程仍锁着', !has('trip-1000'), ids.join(','))
check('未达标的 200 次行程仍锁着', !has('trip-200'), ids.join(','))
check('已达标但需 7 个全勤日的成就仍锁着', !has('perfect-7'), ids.join(','))

section('新周期成就')

writeSave((save) => {
  save.periods.tenMin.best = 35
  save.periods.sixHour.best = 9
  save.stats.counts.quarter = 4
  save.stats.counts.tenMin = 35
  save.stats.counts.sixHour = 9
})
boot()
r = await call('GET', '/state')
const ids2 = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('十分钟连签 30 成就', ids2.includes('ten-min-30'), ids2.join(','))
check('六小时连签 8 成就', ids2.includes('six-hour-8'), ids2.join(','))
check('四季成就', ids2.includes('quarter-4'), ids2.join(','))

// ── persistence ──────────────────────────────────────────────────────────────

section('背包与出行跨重启保留')

writeSave((save) => {
  save.pack = [
    { item: 'crown', count: 2 },
    { item: 'herb', count: 7 },
  ]
  save.expedition.found = { crown: 5, herb: 12 }
  save.expedition.runs = 9
  save.expedition.bestTier = 'legendary'
  save.buffs = [{ id: 'luck', label: '好运', stat: 'luck', amount: 0.15, until: Date.now() + 600_000 }]
})
boot()
r = await call('GET', '/state')
check('重载后背包保留', r.payload.state.pack.length === 2, `${r.payload.state.pack.length}`)
check('重载后堆叠数量保留', r.payload.state.pack.find((x) => x.item === 'herb').count === 7)
check('重载后累计找到保留', r.payload.state.expedition.found.crown === 5)
check('重载后行程数保留', r.payload.state.expedition.runs === 9)
check('重载后最高品质保留', r.payload.state.expedition.bestTier === 'legendary')
check('重载后增益保留', r.payload.state.buffs.length === 1)
check('重载后增益仍生效', r.payload.state.modifiers.luck > 0, `${r.payload.state.modifiers.luck}`)

section('成就树布局完整性')

// The tree view is driven by a hand-written layout table. An achievement with no
// layout node is simply INVISIBLE in that view — no error, no warning — so this
// check is the only thing standing between "added an achievement" and "added an
// achievement nobody can see".
{
  const { ACHIEVEMENT_LAYOUT, ACHIEVEMENT_BRANCHES } = await import('../index.js')
  const achIds = new Set((await import('../index.js')).ACHIEVEMENTS.map((a) => a.id))
  const layoutIds = ACHIEVEMENT_LAYOUT.map((n) => n.id)
  const layoutSet = new Set(layoutIds)

  const missing = [...achIds].filter((id) => !layoutSet.has(id))
  const extra = [...layoutSet].filter((id) => !achIds.has(id))
  const dupes = layoutIds.filter((id, i) => layoutIds.indexOf(id) !== i)

  check('每个成就都有布局节点', missing.length === 0, `missing: ${missing.join(',')}`)
  check('布局里没有多余的节点', extra.length === 0, `extra: ${extra.join(',')}`)
  check('布局里没有重复节点', dupes.length === 0, `dupes: ${dupes.join(',')}`)

  const branchIds = new Set(ACHIEVEMENT_BRANCHES.map((b) => b.id))
  check(
    '每个节点都指向真实分支',
    ACHIEVEMENT_LAYOUT.every((n) => branchIds.has(n.branch)),
    ACHIEVEMENT_LAYOUT.filter((n) => !branchIds.has(n.branch)).map((n) => n.id).join(','),
  )
  check(
    '每个 parent 都指向真实节点',
    ACHIEVEMENT_LAYOUT.every((n) => n.parent === null || layoutSet.has(n.parent)),
    ACHIEVEMENT_LAYOUT.filter((n) => n.parent !== null && !layoutSet.has(n.parent))
      .map((n) => `${n.id}->${n.parent}`)
      .join(','),
  )

  // Two nodes in one cell would render on top of each other. This MUST be checked
  // in GLOBAL coordinates, because the client draws every branch on ONE canvas.
  // An earlier version of this check only compared nodes WITHIN a branch, and so
  // missed the real bug: all seven branches were authored from (0,0), which put
  // seven nodes in the same cell and turned the graph into an unreadable pile —
  // while this test passed. The check was wrong, not the feature.
  {
    const { BRANCH_BANDS, ACHIEVEMENT_BRANCHES: BRANCHES } = await import('../index.js')
    const global = ACHIEVEMENT_LAYOUT.map((node) => {
      const band = BRANCH_BANDS.bands.get(node.branch) ?? { offsetX: 0, offsetY: 0 }
      return { ...node, x: node.x + band.offsetX, y: node.y + band.offsetY }
    })

    const cells = new Map()
    for (const node of global) {
      const key = `${node.x},${node.y}`
      cells.set(key, [...(cells.get(key) ?? []), node.id])
    }
    const collisions = [...cells.entries()].filter(([, ids]) => ids.length > 1)
    check(
      '全局坐标下没有格子重叠',
      collisions.length === 0,
      collisions.map(([key, ids]) => `${key}=${ids.join('+')}`).join(' | '),
    )

    // Distinct vertical ranges per branch is what makes "bands" real rather than
    // decorative; overlapping ranges would mean the stack did nothing.
    const ranges = BRANCHES.map((branch) => {
      const ys = global.filter((node) => node.branch === branch.id).map((node) => node.y)
      return ys.length === 0 ? null : { branch: branch.id, min: Math.min(...ys), max: Math.max(...ys) }
    }).filter((entry) => entry !== null)
    const overlapping = []
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        if (ranges[i].min <= ranges[j].max && ranges[j].min <= ranges[i].max) {
          overlapping.push(`${ranges[i].branch}~${ranges[j].branch}`)
        }
      }
    }
    check('各分支的纵向区间互不重叠', overlapping.length === 0, overlapping.join(','))

    // The canvas must be genuinely bigger than the viewport on BOTH axes, or
    // panning in that direction has nothing to reveal and the panel feels stuck.
    // The client's cell size must match what this checks: 150x96, viewport 460px
    // tall and a panel typically ~900px wide.
    const CELL_X = 150
    const CELL_Y = 96
    const canvasWidth = 32 * 2 + BRANCH_BANDS.width * CELL_X
    const canvasHeight = 30 * 2 + BRANCH_BANDS.height * CELL_Y
    check(
      '画布横向明显大于视口',
      canvasWidth > 900,
      `${canvasWidth}px (panel is ~900px)`,
    )
    check(
      '画布纵向明显大于视口',
      canvasHeight > 460 * 1.5,
      `${canvasHeight}px (viewport is 460px)`,
    )
  }

  check('每个分支至少有一个节点', ACHIEVEMENT_BRANCHES.every((b) => ACHIEVEMENT_LAYOUT.some((n) => n.branch === b.id)))
  check(
    'parent 一定在更靠左或同列的格子',
    ACHIEVEMENT_LAYOUT.every((n) => {
      if (n.parent === null) return true
      const parent = ACHIEVEMENT_LAYOUT.find((p) => p.id === n.parent)
      return parent !== undefined && parent.x <= n.x
    }),
  )
}

section('图鉴估值')

{
  const r2 = await call('GET', '/state')
  const dests = r2.payload.destinations
  check('每个目的地都有期望收益', dests.every((d) => typeof d.expectedValue === 'number' && d.expectedValue > 0), JSON.stringify(dests.map((d) => d.expectedValue)))
  check('每个目的地都有稀有率', dests.every((d) => d.rareChance >= 0 && d.rareChance <= 1))
  check('每个目的地都有每小时收益', dests.every((d) => d.valuePerHour > 0))
  check('每个目的地都有每物资收益', dests.every((d) => d.valuePerSupply > 0))
  check('每个目的地都有品质分布', dests.every((d) => Array.isArray(d.tiers) && d.tiers.length > 0))
  check(
    '品质概率之和约为 1',
    dests.every((d) => Math.abs(d.tiers.reduce((s, t) => s + t.probability, 0) - 1) < 1e-9),
    JSON.stringify(dests.map((d) => d.tiers.reduce((s, t) => s + t.probability, 0))),
  )
  check('估值表存在且各货币都有', Object.keys(r2.payload.valuation).length >= 6, Object.keys(r2.payload.valuation).join(','))

  // The deeper destinations must actually be worth more per trip.
  const byId = Object.fromEntries(dests.map((d) => [d.id, d]))
  check('深渊单次期望高于近郊', byId.abyss.expectedValue > byId.outskirts.expectedValue, `${byId.abyss.expectedValue} vs ${byId.outskirts.expectedValue}`)
  check('深渊稀有率高于近郊', byId.abyss.rareChance > byId.outskirts.rareChance, `${byId.abyss.rareChance} vs ${byId.outskirts.rareChance}`)

  // Per-supply efficiency need NOT increase with distance (that is the tradeoff),
  // but it must be positive and finite for every destination.
  check('每物资收益都是有限正数', dests.every((d) => Number.isFinite(d.valuePerSupply) && d.valuePerSupply > 0))
}

section('成就树与图鉴的接口形状')

{
  // Start from a pristine save: earlier sections deliberately unlock things, and
  // "initially all locked" is only meaningful on a fresh state.
  writeSave(() => {})
  boot()
  const r3 = await call('GET', '/state')
  const tree = r3.payload.tree
  check('tree.branches 是数组', Array.isArray(tree.branches))
  check('tree 有宽高', tree.width > 0 && tree.height > 0, `${tree.width}x${tree.height}`)
  check('每个分支都带 nodes/unlocked/total', tree.branches.every((b) => Array.isArray(b.nodes) && typeof b.unlocked === 'number' && typeof b.total === 'number'))
  // The tree must account for EVERY achievement, or some are invisible in that
  // view. Compared against the real layout length rather than a hardcoded number,
  // so adding an achievement cannot quietly break this.
  const layoutLength = (await import('../index.js')).ACHIEVEMENT_LAYOUT.length
  check(
    '分支节点数之和等于布局节点数',
    tree.branches.reduce((s, b) => s + b.total, 0) === layoutLength,
    `${tree.branches.reduce((s, b) => s + b.total, 0)} vs ${layoutLength}`,
  )
  check('初始全部未解锁', tree.branches.every((b) => b.unlocked === 0), JSON.stringify(tree.branches.map((b) => b.unlocked)))
  check(
    '节点都带 x/y/parent/unlocked',
    tree.branches.every((b) => b.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number' && 'parent' in n && typeof n.unlocked === 'boolean')),
  )
}

section('新成就可达性')

{
  // Every new achievement must actually be reachable from a real save state —
  // a `test` that can never be true is a dead row.
  const { ACHIEVEMENTS } = await import('../index.js')
  const unreachable = []
  // Evaluate against an absurdly advanced snapshot: if a condition cannot hold
  // even then, the row is dead. Two variants are needed because some
  // achievements are mutually exclusive by construction (see below).
  const baseMaxed = {
      total: 1e9,
      counts: { minute: 1e9, tenMin: 1e9, hour: 1e9, sixHour: 1e9, day: 1e9, week: 1e9, month: 1e9, quarter: 1e9 },
      best: { minute: 1e9, tenMin: 1e9, hour: 1e9, sixHour: 1e9, day: 1e9, week: 1e9, month: 1e9, quarter: 1e9 },
      hours: Array.from({ length: 24 }, (_, i) => i),
      luckyHits: 1e9,
      perfectDays: 1e9,
      bestCombo: 1e9,
      chestsOpened: 1e9,
      chestsOpenedById: { wood: 1e9, silver: 1e9, gold: 1e9, diamond: 1e9 },
      offlineCollected: 1e9,
      offlinePoolFull: true,
      upgradesOwned: 1e9,
      maxedUpgrades: 1e9,
      upgradeCount: 1,
      currencies: { xp: 1e9, coin: 1e9, gold: 1e9, diamond: 1e9, bar: 1e9, relic: 1e9, star: 1e9 },
      earned: { xp: 1e9, coin: 1e9, gold: 1e9, diamond: 1e9, bar: 1e9, relic: 1e9, star: 1e9 },
      // Must list EVERY currency: `all-five` iterates CURRENCY_KEYS, so a new
      // currency without an entry here silently makes it unreachable.
      everHeld: { xp: true, coin: true, iron: true, gold: true, diamond: true, bar: true, relic: true, star: true },
      level: 1e9,
      packTotal: 1e9,
      packUnique: 1e9,
      soldTotal: 1e9,
      usedTotal: 1e9,
      activeBuffs: 1e9,
      bestTierRank: 3,
      suppliesFull: true,
      expedition: {
        runs: 1e9,
        found: Object.fromEntries(ITEMS.map((i) => [i.id, 1e9])),
        sold: Object.fromEntries(ITEMS.map((i) => [i.id, 1e9])),
        bestTier: 'legendary',
        uniqueFound: ITEMS.length,
        byDestination: Object.fromEntries(EXPEDITIONS.map((d) => [d.id, 1e9])),
        used: 1e9,
        visitedAll: true,
        foundTiers: ['common', 'uncommon', 'rare', 'legendary'],
      },
      modifiers: { luck: 1, grace: 3, offlineRate: 9, offlineCapHours: 99, supplyCap: 1e9, packSize: 1e9, swift: 0, fortune: 9, haggle: 9, thrift: 4 },
      // Daily-quest, alchemy and rebirth counters. These are what the newest
      // achievements read; a missing one makes the achievement UNREACHABLE and
      // this test's whole point is to catch that.
      questsClaimed: 1e9,
      questsDone: 1e9,
      dailyAllClaimed: true,
      questAllDays: 1e9,
      alchemyRuns: 1e9,
      alchemyKinds: RECIPES.length,
      rebirths: 1e9,
      rebirthBestLevel: 1e9,
      starLevels: 1e9,
      // Farm counters. `farmByCrop` must be an OBJECT with every crop key, because
      // an achievement asks about a specific one — and a missing field here would
      // make that achievement unreachable, which is exactly what this test exists
      // to detect.
      farmPlanted: 1e9,
      farmHarvested: 1e9,
      farmKinds: 1e9,
      farmTended: 1e9,
      farmPlots: 1e9,
      farmReady: 1e9,
      farmByCrop: Object.fromEntries(CROPS.map((crop) => [crop.id, 1e9])),
      // Settings-derived counters.
      settingsTouched: 1e9,
      settingsAtMax: 1e9,
      hidSystemsBefore: true,
      /**
       * Mine counters.
       *
       * `mineByOre` must be an OBJECT with every ore key, because an achievement
       * asks about a specific one (星石) — a missing field makes it throw, which is
       * precisely what this check exists to detect.
       */
      mineDepth: 1e9,
      mineDeepest: 1e9,
      mineStamina: 1e9,
      mineStaminaCap: 1e9,
      mineSwings: 1e9,
      mineVeins: 1e9,
      mineOres: 1e9,
      mineMiners: 1e9,
      mineBuffered: 1e9,
      mineOreKinds: 1e9,
      mineByOre: Object.fromEntries(ORES.map((ore) => [ore.id, 1e9])),
      minePickaxeLevel: 1e9,
      mineLastStamina: 0,
      /**
       * 钓鱼 counters.
       *
       * The species/rarity thresholds matter here: `bestRarity` is a RARITY
       * INDEX (0–3), not a count, so a fixture that left it at 0 would report
       * 锦鲤附体 and 传说中的鱼 as unreachable — which is the exact class of
       * bug this fixture is meant to catch, not cause.
       */
      fishCaught: 1e9,
      fishEscaped: 1e9,
      fishKinds: 1e9,
      fishBestRarity: 3,
      fishRodRank: 4,
      fishSpotUnlocked: 4,
      fishCaughtAtSea: 1e9,
      /**
       * 开店 counters.
       *
       * `shopMode` must be a REAL mode id, because two achievements assert on it
       * by value (`shop-auto` / `shop-manual`) and are mutually exclusive — hence
       * the mode variants below rather than one fixture.
       */
      shopMode: 'auto',
      shopReputation: 1e9,
      shopSales: 1e9,
      shopManualSales: 1e9,
      shopAutoSales: 1e9,
      shopMachinesBought: 1e9,
      shopBestStreak: 1e9,
      shopAllProducts: true,
    }

  for (const entry of ACHIEVEMENTS) {
    /**
     * Reachability across TWO "maxed" worlds.
     *
     * Some achievements are mutually exclusive by construction: `unfiltered`
     * requires every system tab shown, `minimalist` requires three hidden. No
     * single fixture can satisfy both, so one fixture would always report one of
     * them dead. Requiring each achievement to pass in AT LEAST one variant keeps
     * the check strict — a row that passes in neither is still caught — without
     * forcing the two into a state that cannot exist.
     */
    const variants = [
      { systemsHidden: 0, hidSystemsBefore: true },
      { systemsHidden: 1e9, hidSystemsBefore: true },
      /**
       * The shop-mode fork is the same kind of mutual exclusion: `shop-auto` and
       * `shop-manual` assert on one value each, and no save can be both. Listing
       * the two modes as separate variants keeps the check honest — an
       * achievement that passed in NEITHER mode would still be reported dead.
       */
      { systemsHidden: 0, hidSystemsBefore: true, shopMode: 'auto' },
      { systemsHidden: 0, hidSystemsBefore: true, shopMode: 'manual' },
    ]

    let ok = false
    let threw = false
    for (const variant of variants) {
      try {
        if (entry.test({ ...baseMaxed, ...variant }) === true) {
          ok = true
          break
        }
      } catch (error) {
        // A throw means the achievement reads a field the view does not provide —
        // exactly the bug class this check exists to catch.
        threw = true
        unreachable.push(`${entry.id}(throws: ${error.message})`)
        break
      }
    }
    if (!ok && !threw) unreachable.push(entry.id)
  }
  check('所有成就在满级存档下都能达成', unreachable.length === 0, unreachable.join(','))
}

section('存档卫生：非法数据被清理')

writeSave((save) => {
  // Unknown item ids, duplicates, zero counts and a bogus trip must all be
  // normalized rather than trusted.
  save.pack = [
    { item: 'shell', count: 2 },
    { item: 'shell', count: 3 },
    { item: 'not-a-real-item', count: 5 },
    { item: 'ore', count: 0 },
  ]
  save.trip = { destination: 'atlantis', startedAt: 1, readyAt: 2, spent: 1 }
})
boot()
r = await call('GET', '/state')
check('重复堆叠被合并', r.payload.state.pack.filter((x) => x.item === 'shell').length === 1)
check('合并后数量正确', r.payload.state.pack.find((x) => x.item === 'shell').count === 5)
check('未知物品被丢弃', r.payload.state.pack.every((x) => ITEMS.some((i) => i.id === x.item)))
check('零数量堆叠被丢弃', r.payload.state.pack.every((x) => x.count > 0))
check('指向未知地点的行程被丢弃', r.payload.state.trip === null)

writeSave((save) => {
  save.supplies.current = -50
  save.buffs = [{ id: 'x', label: 'x', stat: 'bogus', amount: 1, until: Date.now() + 1000 }]
})
boot()
r = await call('GET', '/state')
check('负物资被夹到 0', r.payload.state.supplies.current === 0, `${r.payload.state.supplies.current}`)
check('非法增益被丢弃', r.payload.state.buffs.length === 0, `${r.payload.state.buffs.length}`)

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
