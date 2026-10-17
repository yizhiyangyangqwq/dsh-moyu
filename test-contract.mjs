/**
 * Contract test: does the client read fields the host actually sends?
 *
 * A host/client field mismatch is the worst kind of bug in this plugin: nothing
 * throws, nothing logs, and a section of the UI just silently renders nothing.
 * `data.shop` vs `data.upgrades`, `state.offline.total` vs `state.offline.pool`
 * — both look fine in isolation.
 *
 * So this test boots the REAL host, takes a REAL snapshot, and asserts every
 * field path the client code references exists with the expected shape. The
 * field list is transcribed from client.js, and a check fails if a path is
 * missing.
 *
 *   node tools/test-contract.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-contract-'))
process.env.DSH_HOME = tmpHome

const { apply, CURRENCIES, UPGRADES, CHESTS, ITEMS, ALL_ITEMS, EXPEDITIONS } = await import('../index.js')

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

apply(fakeCtx, {})

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

/** Follow a dotted path; returns undefined when any link is missing. */
function at(object, dotted) {
  let current = object
  for (const part of dotted.split('.')) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

/** Assert a set of paths all resolve to a defined value. */
function expectPaths(label, object, paths) {
  const missing = paths.filter((p) => at(object, p) === undefined)
  check(label, missing.length === 0, missing.length === 0 ? undefined : `missing: ${missing.join(', ')}`)
}

const r = await call('GET', '/state')
const payload = r.payload
const state = payload.state

// ── top-level payload: transcribed from client.js reads ─────────────────────

section('响应顶层字段（client.js 读取的）')

expectPaths('顶层字段齐全', payload, [
  'state',
  'currencies',
  'periods',
  'achievements',
  'shop',
  'chests',
  'items',
  'destinations',
  'modifiers',
])

expectPaths('state 字段齐全', state, [
  'readyCount',
  'total',
  'level',
  'levelInto',
  'levelNeed',
  'levelProgress',
  'currencies',
  'earned',
  'periods',
  'history',
  'savePath',
  'chestsOpened',
  'modifiers.luck',
  'modifiers.grace',
  'modifiers.offlineRate',
  'modifiers.offlineCapHours',
  'modifiers.supplyCap',
  'modifiers.packSize',
  'offline.pool',
  'offline.total',
  'offline.collected',
  'supplies.current',
  'supplies.cap',
  'supplies.nextIn',
  'pack',
  'packUsed',
  'packSize',
  'trip',
  'buffs',
  'expedition.runs',
  'expedition.uniqueFound',
  'expedition.byDestination',
  'packTotal',
  'packUnique',
  'soldTotal',
  'usedTotal',
  'activeBuffs',
  'bestTierRank',
  'suppliesFull',
])

section('货币与周期条目形状')

const currency = payload.currencies[0]
expectPaths('货币条目含 key/label/token/symbol', currency, ['key', 'label', 'token', 'symbol'])
check('货币数量与导出表一致', payload.currencies.length === CURRENCIES.length, `${payload.currencies.length} vs ${CURRENCIES.length}`)

const period = state.periods[0]
expectPaths('周期条目字段齐全', period, [
  'key',
  'label',
  'accent',
  'ready',
  'readyAt',
  'remaining',
  'streak',
  'best',
  'total',
  'rewards',
  'yieldMultiplier',
])
check('周期 rewards 是数字映射', Object.values(period.rewards).every((v) => typeof v === 'number'))

section('商店条目形状')

const shopItem = payload.shop[0]
expectPaths('商店条目字段齐全', shopItem, [
  'id',
  'label',
  'desc',
  'accent',
  'level',
  'max',
  'maxed',
  'costCurrency',
  'nextCost',
  'affordable',
])
check('nextCost 为数字（未满级）', typeof shopItem.nextCost === 'number', `${shopItem.nextCost}`)
check('costCurrency 是已知货币', payload.currencies.some((c) => c.key === shopItem.costCurrency))
check('商店项数量与 UPGRADES 一致', payload.shop.length === UPGRADES.length, `${payload.shop.length} vs ${UPGRADES.length}`)

section('宝箱条目形状')

const chest = payload.chests[0]
expectPaths('宝箱条目字段齐全', chest, ['id', 'label', 'desc', 'accent', 'cost', 'affordable', 'opened'])
check('cost 是非空映射', Object.keys(chest.cost).length > 0, JSON.stringify(chest.cost))
check(
  'cost 的键都是已知货币',
  Object.keys(chest.cost).every((key) => payload.currencies.some((c) => c.key === key)),
  Object.keys(chest.cost).join(','),
)
check('宝箱数量与 CHESTS 一致', payload.chests.length === CHESTS.length, `${payload.chests.length} vs ${CHESTS.length}`)

section('物品条目形状')

const item = payload.items[0]
expectPaths('物品条目字段齐全', item, [
  'id',
  'label',
  'desc',
  'kind',
  'rarity',
  'rarityLabel',
  'accent',
  'glyph',
  'sellFor',
  'sellValue',
  'supply',
  'buff',
  'found',
  'sold',
])
check('物品数量与 ALL_ITEMS 一致', payload.items.length === ALL_ITEMS.length, `${payload.items.length} vs ${ALL_ITEMS.length}`)
check(
  'kind 只取三种已知值',
  payload.items.every((i) => ['sell', 'supply', 'buff'].includes(i.kind)),
  [...new Set(payload.items.map((i) => i.kind))].join(','),
)
check(
  'rarity 只取四种已知值',
  payload.items.every((i) => ['common', 'uncommon', 'rare', 'legendary'].includes(i.rarity)),
  [...new Set(payload.items.map((i) => i.rarity))].join(','),
)
check(
  'sell 类物品有 sellFor 和 sellValue',
  payload.items.filter((i) => i.kind === 'sell').every((i) => i.sellFor !== null && i.sellValue !== null),
)
check(
  'supply 类物品有 supply 数量',
  payload.items.filter((i) => i.kind === 'supply').every((i) => typeof i.supply === 'number' && i.supply > 0),
)
check(
  'buff 类物品有 buff 描述',
  payload.items.filter((i) => i.kind === 'buff').every((i) => i.buff !== null && typeof i.buff.ms === 'number'),
)
check(
  'sellValue 的键都是已知货币',
  payload.items
    .filter((i) => i.sellValue !== null)
    .every((i) => Object.keys(i.sellValue).every((key) => payload.currencies.some((c) => c.key === key))),
)

section('目的地条目形状')

const destination = payload.destinations[0]
expectPaths('目的地条目字段齐全', destination, [
  'id',
  'label',
  'desc',
  'accent',
  'hours',
  'effectiveHours',
  'supply',
  'baseSupply',
  'affordable',
  'runs',
])
check(
  '目的地数量与 EXPEDITIONS 一致',
  payload.destinations.length === EXPEDITIONS.length,
  `${payload.destinations.length} vs ${EXPEDITIONS.length}`,
)
check('effectiveHours 不超过名义 hours', payload.destinations.every((d) => d.effectiveHours <= d.hours + 1e-9))
check('supply 消耗至少为 1', payload.destinations.every((d) => d.supply >= 1), JSON.stringify(payload.destinations.map((d) => d.supply)))

section('成就条目形状')

const ach = payload.achievements[0]
expectPaths('成就条目字段齐全', ach, ['id', 'label', 'desc', 'tier', 'unlockedAt'])
check(
  'tier 只取四种已知值',
  payload.achievements.every((a) => ['bronze', 'silver', 'gold', 'legend'].includes(a.tier)),
  [...new Set(payload.achievements.map((a) => a.tier))].join(','),
)
check('achievements 每条都带 unlockedAt', payload.achievements.every((a) => 'unlockedAt' in a))
check('成就数量 > 75', payload.achievements.length > 75, `${payload.achievements.length}`)

section('操作返回 result 且形状一致')

// Every POST must return the same envelope: full snapshot + result.
const coinBefore = state.currencies.coin
let res = await call('POST', '/claim', { period: 'minute' })
expectPaths('claim 响应含 state 与 result', res.payload, ['state', 'result'])
expectPaths('claim result 字段（client 读取的）', res.payload.result, [
  'label',
  'granted',
  'streak',
  'multiplier',
])
check('claim 后 state 是完整快照', res.payload.state.periods.length === 8)

res = await call('POST', '/claim-all', {})
expectPaths('claim-all result 字段（client 读取的）', res.payload.result, ['claimed'])

// Give currency so the buy/open paths can actually run.
const savePath = path.join(tmpHome, 'checkin', 'state.json')
const seed = JSON.parse(fs.readFileSync(savePath, 'utf8'))
seed.currencies.gold = 100_000
seed.earned.gold = 100_000
seed.currencies.coin = 100_000
seed.earned.coin = 100_000
seed.supplies.current = 99
fs.writeFileSync(savePath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')
route = null
apply(fakeCtx, {})

res = await call('POST', '/buy', { upgrade: 'minuteYield' })
expectPaths('buy 响应字段齐全', res.payload, ['state', 'result'])
expectPaths('buy result 字段（client 读取的）', res.payload.result, ['label', 'level', 'paid'])
check('buy result.paid 是映射', typeof res.payload.result.paid === 'object')
check(
  'paid 的键是已知货币',
  Object.keys(res.payload.result.paid).every((key) => payload.currencies.some((c) => c.key === key)),
  Object.keys(res.payload.result.paid).join(','),
)

res = await call('POST', '/open', { chest: 'wood' })
expectPaths('open 响应字段齐全', res.payload, ['state', 'result'])
expectPaths('open result 字段（client 读取的）', res.payload.result, ['label', 'granted'])

section('出行：depart / collect-trip 的形状')

res = await call('POST', '/depart', { destination: 'outskirts' })
check('depart 成功', res.status === 200, JSON.stringify(res.payload).slice(0, 180))
expectPaths('depart result 字段（client 读取的）', res.payload.result, [
  'label',
  'readyAt',
  'spent',
  'hours',
])
check('depart 后 state.trip 有内容', res.payload.state.trip !== null)
expectPaths('state.trip 字段（client 读取的）', res.payload.state.trip, [
  'label',
  'readyAt',
  'remainingMs',
  'ready',
])
check('刚出发时 trip.ready 为 false', res.payload.state.trip.ready === false)

// Age the trip so it is ready, then collect.
const seed3 = JSON.parse(fs.readFileSync(savePath, 'utf8'))
seed3.trip.readyAt = Date.now() - 1000
fs.writeFileSync(savePath, `${JSON.stringify(seed3, null, 2)}\n`, 'utf8')
route = null
apply(fakeCtx, {})

res = await call('POST', '/collect-trip', {})
check('collect-trip 成功', res.status === 200, JSON.stringify(res.payload).slice(0, 180))
expectPaths('collect-trip result 字段（client 读取的）', res.payload.result, [
  'label',
  'found',
  'leftBehind',
])
check('收取后 trip 归 null', res.payload.state.trip === null)

section('背包：sell / use 的形状')

// Put a sellable and a usable item in the pack directly.
const seed4 = JSON.parse(fs.readFileSync(savePath, 'utf8'))
seed4.pack = [
  { item: 'shell', count: 3 },
  { item: 'herb', count: 2 },
  { item: 'charm', count: 1 },
]
seed4.supplies.current = 0
fs.writeFileSync(savePath, `${JSON.stringify(seed4, null, 2)}\n`, 'utf8')
route = null
apply(fakeCtx, {})

res = await call('POST', '/sell', { item: 'shell', count: 2 })
check('sell 成功', res.status === 200, JSON.stringify(res.payload).slice(0, 180))
expectPaths('sell result 字段（client 读取的）', res.payload.result, [
  'label',
  'count',
  'gained',
  'multiplier',
])
check('卖掉 2 个后剩 1 个', res.payload.state.pack.find((r) => r.item === 'shell').count === 1)

res = await call('POST', '/use', { item: 'herb' })
check('use 补给成功', res.status === 200, JSON.stringify(res.payload).slice(0, 180))
expectPaths('use result 字段（client 读取的）', res.payload.result, ['label', 'detail'])
check('use detail.kind 为 supply', res.payload.result.detail.kind === 'supply')
check('物资确实被补充', res.payload.state.supplies.current > 0)

res = await call('POST', '/use', { item: 'charm' })
check('use 增益成功', res.status === 200)
check('use detail.kind 为 buff', res.payload.result.detail.kind === 'buff')
check('state.buffs 有内容', res.payload.state.buffs.length >= 1)
expectPaths('state.buffs 条目字段（client 读取的）', res.payload.state.buffs[0], [
  'id',
  'label',
  'stat',
  'amount',
  'until',
  'remainingMs',
])

// A sellable item must not be usable, and vice versa.
res = await call('POST', '/use', { item: 'shell' })
check('卖品不能当道具用', res.status === 400, `status=${res.status}`)
res = await call('POST', '/sell', { item: 'herb' })
check('补给品不能卖', res.status === 400, `status=${res.status}`)

section('离线：collect-offline')

// Offline: seed an absence so there is something to collect.
const seed2 = JSON.parse(fs.readFileSync(savePath, 'utf8'))
seed2.offline.accruedAt = Date.now() - 3 * 3_600_000
fs.writeFileSync(savePath, `${JSON.stringify(seed2, null, 2)}\n`, 'utf8')
route = null
apply(fakeCtx, {})

res = await call('POST', '/collect-offline', {})
expectPaths('collect-offline 响应字段齐全', res.payload, ['state', 'result'])
expectPaths('collect-offline result 字段（client 读取的）', res.payload.result, ['granted'])

section('client 读取的 history 条目字段')

const historyState = (await call('GET', '/state')).payload.state
check('history 非空', historyState.history.length > 0, `${historyState.history.length}`)
const kinds = new Set(historyState.history.map((e) => e.kind))
check('history 覆盖多种事件类型', kinds.size >= 3, [...kinds].join(','))
check(
  '每条 history 都有 id/at/kind/label',
  historyState.history.every(
    (e) => typeof e.id === 'number' && typeof e.at === 'number' && typeof e.kind === 'string' && typeof e.label === 'string',
  ),
  JSON.stringify(historyState.history[0]),
)
const offlineEntry = historyState.history.find((e) => e.kind === 'offline')
check('offline 条目带 granted', offlineEntry !== undefined && typeof offlineEntry.granted === 'object')
const upgradeEntry = historyState.history.find((e) => e.kind === 'upgrade')
check('upgrade 条目带 level', upgradeEntry !== undefined && typeof upgradeEntry.level === 'number')
const chestEntry = historyState.history.find((e) => e.kind === 'chest')
check('chest 条目带 granted', chestEntry !== undefined && typeof chestEntry.granted === 'object')

section('错误响应形状')

res = await call('POST', '/buy', { upgrade: 'nope' })
check('错误响应带 error 字符串', typeof res.payload.error === 'string', JSON.stringify(res.payload))
check('错误响应不含 state（client 不会误用）', res.payload.state === undefined)

section('client.js 未引用不存在的顶层字段')

/**
 * Check every `data.<field>` / `state.<field>` reference against the real
 * payload, so a rename on one side cannot land silently.
 *
 * This uses a deliberately STRICT `\bstate\.` scan. An earlier version of the
 * tree view named a local drag variable `state`, which shadowed the server
 * snapshot; the strict scan reported its fields as missing and the fix was to
 * rename the LOCAL, not to loosen the check. Keep it strict — a laxer regex
 * would have hidden a genuinely confusing shadow.
 */
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const dataRefs = new Set([...clientSource.matchAll(/\bdata\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]))
const stateRefs = new Set([...clientSource.matchAll(/\bstate\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]))

const unknownData = [...dataRefs].filter((f) => !(f in payload))
const unknownState = [...stateRefs].filter((f) => !(f in state))

check(
  `data.* 引用全部存在（检查了 ${dataRefs.size} 个）`,
  unknownData.length === 0,
  unknownData.join(','),
)
check(
  `state.* 引用全部存在（检查了 ${stateRefs.size} 个）`,
  unknownState.length === 0,
  unknownState.join(','),
)

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
