/**
 * Tests for the settings panel.
 *
 * Settings are the one system where a bug does not show up as an error — it shows
 * up as the game quietly behaving differently from what the panel says. So the
 * assertions here are mostly about AGREEMENT:
 *
 *   · a knob's value is what the game actually uses (reward ×3 really triples)
 *   · a clamped value reports the clamp (9999 becomes the declared max)
 *   · settings survive `/reset` and rebirth, which is why they live in their own
 *     file rather than inside the save
 *   · a no-op write does not inflate the "you changed something" counter
 *   · the schema the client renders can actually drive every knob it declares
 *
 *   node tools/test-settings.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-settings-'))
process.env.DSH_HOME = tmpHome

const { apply, SETTINGS_SCHEMA, DEFAULT_SETTINGS, normalizeSettings } = await import('../index.js')

const SETTINGS = path.join(tmpHome, 'checkin', 'settings.json')
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
const readSettings = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))

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
    farm: { plots: [null, null, null, null, null, null], harvested: 0, byCrop: {}, tended: 0 },
    history: [],
  }
  mutate(save)
  fs.mkdirSync(path.dirname(SAVE), { recursive: true })
  fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
}

function clearSettings() {
  try {
    fs.rmSync(SETTINGS, { force: true })
  } catch {
    // Not present is the desired state.
  }
}

// ── schema sanity ────────────────────────────────────────────────────────────

section('设置表本身是健全的')

check('schema 非空', SETTINGS_SCHEMA.length > 0, `${SETTINGS_SCHEMA.length}`)
check('每个 key 唯一', new Set(SETTINGS_SCHEMA.map((e) => e.key)).size === SETTINGS_SCHEMA.length)
check('每个 key 都有默认值', SETTINGS_SCHEMA.every((e) => e.default !== undefined))
check('每个项都有分组与说明', SETTINGS_SCHEMA.every((e) => typeof e.group === 'string' && typeof e.label === 'string' && typeof e.desc === 'string'))
check(
  'number 项的 min/max/step 合法',
  SETTINGS_SCHEMA.filter((e) => e.kind === 'number').every((e) => e.min < e.max && e.step > 0),
  JSON.stringify(SETTINGS_SCHEMA.filter((e) => e.kind === 'number' && !(e.min < e.max && e.step > 0)).map((e) => e.key)),
)
check(
  'number 项的 default 在范围内',
  SETTINGS_SCHEMA.filter((e) => e.kind === 'number').every((e) => e.default >= e.min && e.default <= e.max),
  JSON.stringify(SETTINGS_SCHEMA.filter((e) => e.kind === 'number' && !(e.default >= e.min && e.default <= e.max)).map((e) => e.key)),
)
check(
  'kind 只取 number / toggle',
  SETTINGS_SCHEMA.every((e) => e.kind === 'number' || e.kind === 'toggle'),
  [...new Set(SETTINGS_SCHEMA.map((e) => e.kind))].join(','),
)
check('DEFAULT_SETTINGS 覆盖全部 key', Object.keys(DEFAULT_SETTINGS).length === SETTINGS_SCHEMA.length)

section('normalizeSettings：清洗输入')

check('null 返回默认值', JSON.stringify(normalizeSettings(null)) === JSON.stringify(DEFAULT_SETTINGS))
check('undefined 返回默认值', JSON.stringify(normalizeSettings(undefined)) === JSON.stringify(DEFAULT_SETTINGS))
check('字符串返回默认值', JSON.stringify(normalizeSettings('nonsense')) === JSON.stringify(DEFAULT_SETTINGS))

const clamped = normalizeSettings({ rewardMultiplier: 9999, luckBonus: -50, cropSpeed: 0.0001 })
const rewardEntry = SETTINGS_SCHEMA.find((e) => e.key === 'rewardMultiplier')
const luckEntry = SETTINGS_SCHEMA.find((e) => e.key === 'luckBonus')
const cropEntry = SETTINGS_SCHEMA.find((e) => e.key === 'cropSpeed')
check('过大的数值被夹到 max', clamped.rewardMultiplier === rewardEntry.max, `${clamped.rewardMultiplier}`)
check('负数被夹到 min', clamped.luckBonus === luckEntry.min, `${clamped.luckBonus}`)
check('过小的数值被夹到 min', clamped.cropSpeed === cropEntry.min, `${clamped.cropSpeed}`)

const sanitized = normalizeSettings({ unknownKey: 1, rewardMultiplier: 2, showFarm: 'yes' })
check('未知 key 被丢弃', !('unknownKey' in sanitized))
check('合法数值被保留', sanitized.rewardMultiplier === 2, `${sanitized.rewardMultiplier}`)
check('toggle 只接受布尔值', sanitized.showFarm === DEFAULT_SETTINGS.showFarm, `${sanitized.showFarm}`)

check('NaN 被忽略', normalizeSettings({ rewardMultiplier: Number.NaN }).rewardMultiplier === DEFAULT_SETTINGS.rewardMultiplier)
check(
  '非布尔 toggle 被忽略',
  normalizeSettings({ confirmRebirth: 1 }).confirmRebirth === DEFAULT_SETTINGS.confirmRebirth,
)

// ── defaults & loading ───────────────────────────────────────────────────────

section('默认值与加载')

clearSettings()
writeSave(() => {})
boot()
let r = await call('GET', '/state')
check('没有设置文件时用默认值', r.payload.settings.rewardMultiplier === 1, `${r.payload.settings.rewardMultiplier}`)
check('快照里带有全部设置 key', Object.keys(r.payload.settings).length === SETTINGS_SCHEMA.length, `${Object.keys(r.payload.settings).length}`)

r = await call('GET', '/settings')
check('GET /settings 返回 schema', Array.isArray(r.payload.result.schema) && r.payload.result.schema.length === SETTINGS_SCHEMA.length)
check('GET /settings 返回 values', r.payload.result.values.rewardMultiplier === 1)
check('GET /settings 返回文件路径', typeof r.payload.result.path === 'string' && r.payload.result.path.includes('settings.json'), r.payload.result.path)
check(
  'schema 自带 current 值所需的全部字段',
  r.payload.result.schema.every((e) => 'key' in e && 'kind' in e && 'default' in e && 'group' in e),
)

// ── writing ──────────────────────────────────────────────────────────────────

section('写入设置')

writeSave(() => {})
clearSettings()
boot()
r = await call('POST', '/settings', { rewardMultiplier: 2.5 })
check('写入成功', r.status === 200, `status=${r.status}`)
check('返回变更的 key', JSON.stringify(r.payload.result.changed) === '["rewardMultiplier"]', JSON.stringify(r.payload.result.changed))
check('值已更新', r.payload.result.settings.rewardMultiplier === 2.5, `${r.payload.result.settings.rewardMultiplier}`)
check('文件已落盘', fs.existsSync(SETTINGS))
check('文件内容正确', readSettings().rewardMultiplier === 2.5, `${readSettings().rewardMultiplier}`)

// A merge, not a replace: sending one key must not reset the others.
r = await call('POST', '/settings', { luckBonus: 0.2 })
check('局部更新不会清掉其他设置', r.payload.result.settings.rewardMultiplier === 2.5, `${r.payload.result.settings.rewardMultiplier}`)
check('新值也生效了', r.payload.result.settings.luckBonus === 0.2, `${r.payload.result.settings.luckBonus}`)

// A no-op should report no change and must not bump the touched counter.
boot()
const beforeTouched = readSettings().__touched ?? 0
r = await call('POST', '/settings', { rewardMultiplier: 2.5 })
check('无变化时 changed 为空', r.payload.result.changed.length === 0, JSON.stringify(r.payload.result.changed))
check('无变化时不增加改动计数', (readSettings().__touched ?? 0) === beforeTouched, `${readSettings().__touched} vs ${beforeTouched}`)

boot()
r = await call('POST', '/settings', { rewardMultiplier: 3 })
check('真实改动会增加计数', (readSettings().__touched ?? 0) === beforeTouched + 1, `${readSettings().__touched}`)

section('写入：夹紧与丢弃')

boot()
r = await call('POST', '/settings', { rewardMultiplier: 1e9 })
check('超限值被夹到 max', r.payload.result.settings.rewardMultiplier === rewardEntry.max, `${r.payload.result.settings.rewardMultiplier}`)
r = await call('POST', '/settings', { unknownThing: 'x' })
check('未知 key 不写入', !('unknownThing' in r.payload.result.settings))
check('未知 key 不进文件', !('unknownThing' in readSettings()))
r = await call('POST', '/settings', { rewardMultiplier: 'not-a-number' })
check('非法数值被忽略（保持原值）', r.payload.result.settings.rewardMultiplier === rewardEntry.max, `${r.payload.result.settings.rewardMultiplier}`)

section('恢复默认')

boot()
r = await call('POST', '/settings-reset')
check('恢复默认成功', r.status === 200, `status=${r.status}`)
check('全部回到默认值', JSON.stringify(r.payload.result.settings) === JSON.stringify(DEFAULT_SETTINGS), JSON.stringify(r.payload.result.settings))

// ── the entry-point pair ─────────────────────────────────────────────────────

section('入口开关：成对且至少留一个')

const badgeEntry = SETTINGS_SCHEMA.find((e) => e.key === 'showFooterBadge')
const panelEntry = SETTINGS_SCHEMA.find((e) => e.key === 'showPanelEntry')
const settingsRowEntry = SETTINGS_SCHEMA.find((e) => e.key === 'showSettingsRow')
check('两个入口开关都在 schema 里', badgeEntry !== undefined && panelEntry !== undefined)
check('默认都是开', badgeEntry.default === true && panelEntry.default === true)
check('共享同一个 pair 组', typeof badgeEntry.pair === 'string' && badgeEntry.pair === panelEntry.pair)

/**
 * The third door is deliberately NOT in the pair.
 *
 * The pair exists because closing BOTH sidebar doors leaves no way back into the
 * plugin. The settings row is a shortcut, not a way back, so turning it off must
 * stay allowed regardless of the other two — if it joined `entryPoints`, closing
 * it alongside one sidebar entry would be rejected for no reason and the group's
 * rule would protect the wrong thing.
 */
check('设置行开关在 schema 里', settingsRowEntry !== undefined)
check('设置行默认是开', settingsRowEntry?.default === true)
check('设置行不属于 entryPoints 配对组', settingsRowEntry?.pair === undefined, `pair=${settingsRowEntry?.pair}`)

// Closing ONE is always fine.
clearSettings()
boot()
r = await call('POST', '/settings', { showFooterBadge: false })
check('关掉一个入口成功', r.status === 200 && r.payload.result.settings.showFooterBadge === false, `status=${r.status}`)
check('另一个保持打开', r.payload.result.settings.showPanelEntry === true)

/**
 * The settings row must be closable at ANY time, including while a sidebar door
 * is already shut.
 *
 * This is the assertion that proves it stayed out of the pair: if it had been
 * tagged `pair: 'entryPoints'`, this exact patch would come back 400 with "至少留
 * 一处" — protecting a shortcut as if it were a door.
 */
r = await call('POST', '/settings', { showSettingsRow: false })
check(
  '一扇侧边门已关时，仍能关掉设置行（它不在配对组里）',
  r.status === 200 && r.payload.result.settings.showSettingsRow === false,
  `status=${r.status} ${r.payload.error ?? ''}`,
)
check('关设置行不影响侧边两扇门', r.payload.result.settings.showFooterBadge === false && r.payload.result.settings.showPanelEntry === true)

// Closing the SECOND one must be refused — both doors shut means the settings
// page itself becomes unreachable, and there is no way back.
r = await call('POST', '/settings', { showPanelEntry: false })
check('再关最后一个被拒绝', r.status === 400, `status=${r.status}`)
check('拒绝信息说明原因', r.payload.error.includes('至少留一处'), r.payload.error)
r = await call('GET', '/state')
check('被拒绝后第一个仍是关', r.payload.settings.showFooterBadge === false)
check('被拒绝后第二个仍是开', r.payload.settings.showPanelEntry === true)
check('被拒绝不写入文件', readSettings().showPanelEntry === true, JSON.stringify(readSettings()).slice(0, 200))
check('设置行也还是关的（那次改动成功了）', r.payload.settings.showSettingsRow === false)

// A single patch closing BOTH is refused too (the stale-tab race the UI cannot
// always prevent), and the order does not matter: reopen one, close the other.
r = await call('POST', '/settings', { showFooterBadge: false, showPanelEntry: false })
check('一次请求同时关两个被拒绝', r.status === 400, `status=${r.status}`)
r = await call('POST', '/settings', { showFooterBadge: true, showPanelEntry: false })
check('先开回一个，再关另一个成功', r.status === 200 && r.payload.result.settings.showFooterBadge === true && r.payload.result.settings.showPanelEntry === false)

// The repair path: a hand-edited file with both closed must come back with the
// group's first key forced on — normalizeSettings runs on load, where a thrown
// error would brick the whole plugin.
clearSettings()
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
fs.writeFileSync(
  SETTINGS,
  JSON.stringify({
    ...DEFAULT_SETTINGS,
    showFooterBadge: false,
    showPanelEntry: false,
    // A tuned knob, to prove the repair is surgical and does not flatten the
    // file back to defaults on the way.
    rewardMultiplier: 4,
  }),
  'utf8',
)
boot()
r = await call('GET', '/state')
check('手改的双关文件被修复（第一个强制开）', r.payload.settings.showFooterBadge === true, JSON.stringify(r.payload.settings))
check('修复只动这一组（调好的旋钮保留）', r.payload.settings.rewardMultiplier === 4, `${r.payload.settings.rewardMultiplier}`)

// settings-reset must restore BOTH doors, never leave a pair half-shut.
r = await call('POST', '/settings-reset')
check('恢复默认后两个入口都回来了', r.payload.result.settings.showFooterBadge === true && r.payload.result.settings.showPanelEntry === true)

clearSettings()

// ── the knobs actually do something ──────────────────────────────────────────

section('设置真的生效：奖励倍率')

writeSave(() => {})
clearSettings()
boot()
await call('POST', '/settings', { rewardMultiplier: 3 })
r = await call('GET', '/state')
const minute = r.payload.state.periods.find((p) => p.key === 'minute')
check('展示的奖励被乘以 3（xp 2→6）', minute.rewards.xp === 6, `${minute.rewards.xp}`)

r = await call('POST', '/claim', { period: 'minute' })
const luckyXp = r.payload.result.lucky !== null && r.payload.result.lucky.key === 'xp' ? r.payload.result.lucky.value : 0
check(
  '实际支付与展示一致（含幸运）',
  r.payload.result.granted.xp === 6 + luckyXp,
  `paid=${r.payload.result.granted.xp} lucky=${luckyXp}`,
)

section('设置真的生效：寻宝品质')

writeSave(() => {})
clearSettings()
boot()
const base = (await call('GET', '/state')).payload.destinations.find((d) => d.id === 'forest')
await call('POST', '/settings', { lootQuality: 4 })
r = await call('GET', '/state')
const boosted = r.payload.destinations.find((d) => d.id === 'forest')
check('品质加成进入了 modifiers', r.payload.state.modifiers.fortune >= 4, `${r.payload.state.modifiers.fortune}`)
check('稀有率随之上升', boosted.rareChance > base.rareChance, `${base.rareChance} -> ${boosted.rareChance}`)

section('设置真的生效：离线收益倍率')

writeSave((save) => {
  save.offline.accruedAt = Date.now() - 2 * 3_600_000
})
clearSettings()
boot()
const plainOffline = (await call('GET', '/state')).payload.state.offline.pool.coin
writeSave((save) => {
  save.offline.accruedAt = Date.now() - 2 * 3_600_000
  save.offline.pool = { coin: 0, gold: 0 }
})
boot()
await call('POST', '/settings', { offlineMultiplier: 4 })
r = await call('GET', '/state')
const fastOffline = r.payload.state.offline.pool.coin
check('离线收益随倍率提高', fastOffline > plainOffline, `${plainOffline} -> ${fastOffline}`)
check('约为 4 倍', fastOffline >= plainOffline * 3.5, `${plainOffline} -> ${fastOffline}`)

section('设置真的生效：作物生长速度')

clearSettings()
boot()
// Plant, then compare growth over a fixed window at 1x and 4x.
writeSave(() => {})
boot()
await call('POST', '/settings', { cropSpeed: 1 })
await call('POST', '/plant', { plot: 0, crop: 'wheat' })
let save = readSave()
save.farm.plots[0].plantedAt -= 60_000
save.farm.plots[0].settleAt -= 60_000
fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
boot()
const slow = (await call('GET', '/state')).payload.farm.plots[0].percent

writeSave(() => {})
boot()
await call('POST', '/settings', { cropSpeed: 4 })
await call('POST', '/plant', { plot: 0, crop: 'wheat' })
save = readSave()
save.farm.plots[0].plantedAt -= 60_000
save.farm.plots[0].settleAt -= 60_000
fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
boot()
const fast = (await call('GET', '/state')).payload.farm.plots[0].percent

check('生长速度设置生效', fast > slow, `1x=${slow}% 4x=${fast}%`)
check('约为 4 倍', fast >= slow * 3.5, `1x=${slow}% 4x=${fast}%`)

section('设置真的生效：病害频率为 0')

writeSave((save) => {
  save.farm.plots[0] = {
    crop: 'wheat', plantedAt: Date.now() - 3_600_000, progress: 0, settleAt: Date.now() - 3_600_000,
    checks: 0, wateredUntil: 0, ailments: [],
  }
})
clearSettings()
boot()
await call('POST', '/settings', { ailmentRate: 0 })
// Advance past both milestone marks; with rate 0 nothing may spawn.
save = readSave()
save.farm.plots[0].settleAt = Date.now() - 3_600_000
save.farm.plots[0].progress = 0
fs.writeFileSync(SAVE, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
boot()
// Samples make the assertion meaningful: at rate 1 a single run could pass by luck.
let everAiled = false
for (let i = 0; i < 20; i += 1) {
  const s = readSave()
  s.farm.plots[0].progress = 0
  s.farm.plots[0].checks = 0
  s.farm.plots[0].ailments = []
  s.farm.plots[0].settleAt = Date.now() - 3_600_000
  fs.writeFileSync(SAVE, `${JSON.stringify(s, null, 2)}\n`, 'utf8')
  boot()
  const state = (await call('GET', '/state')).payload.farm.plots[0]
  if (state.ailments.length > 0) everAiled = true
}
check('病害频率为 0 时 20 次都不生病', everAiled === false, 'something spawned')

section('设置真的生效：物资恢复速度')

writeSave((save) => {
  save.supplies.current = 0
  save.supplies.regenAt = Date.now() - 20 * 60_000
})
clearSettings()
boot()
const plainSupply = (await call('GET', '/state')).payload.state.supplies.current
writeSave((save) => {
  save.supplies.current = 0
  save.supplies.regenAt = Date.now() - 20 * 60_000
})
boot()
await call('POST', '/settings', { supplyRegenMultiplier: 4 })
r = await call('GET', '/state')
const fastSupply = r.payload.state.supplies.current
check('物资恢复随倍率提高', fastSupply > plainSupply, `${plainSupply} -> ${fastSupply}`)

// ── persistence ──────────────────────────────────────────────────────────────

section('设置不随存档重置')

writeSave(() => {})
clearSettings()
boot()
await call('POST', '/settings', { showFarm: false, rewardMultiplier: 5 })
check('设置已写入', readSettings().showFarm === false)

await call('POST', '/reset', {})
r = await call('GET', '/state')
check('/reset 后设置仍在', r.payload.settings.showFarm === false, `${r.payload.settings.showFarm}`)
check('/reset 后倍率仍在', r.payload.settings.rewardMultiplier === 5, `${r.payload.settings.rewardMultiplier}`)
check('存档确实被重置了', r.payload.state.total === 0, `${r.payload.state.total}`)

// Rebirth must also leave them alone.
writeSave((save) => {
  save.currencies.xp = 500_000
})
boot()
await call('POST', '/rebirth', {})
r = await call('GET', '/state')
check('转生后设置仍在', r.payload.settings.showFarm === false, `${r.payload.settings.showFarm}`)

section('设置跨重启保留')

clearSettings()
writeSave(() => {})
boot()
await call('POST', '/settings', { cropSpeed: 2.25, hideSpoilers: true, condensedTabs: true })
boot() // restart
r = await call('GET', '/state')
check('重载后数值保留', r.payload.settings.cropSpeed === 2.25, `${r.payload.settings.cropSpeed}`)
check('重载后开关保留', r.payload.settings.hideSpoilers === true)
check('重载后第二个开关保留', r.payload.settings.condensedTabs === true)

section('手改设置文件也会被夹紧')

fs.writeFileSync(SETTINGS, JSON.stringify({ rewardMultiplier: -100, cropSpeed: 'huge', showFarm: 'maybe', evil: 1 }), 'utf8')
boot()
r = await call('GET', '/state')
check('负数被夹到 min', r.payload.settings.rewardMultiplier === rewardEntry.min, `${r.payload.settings.rewardMultiplier}`)
check('非数值回落到默认', r.payload.settings.cropSpeed === DEFAULT_SETTINGS.cropSpeed, `${r.payload.settings.cropSpeed}`)
check('非布尔回落到默认', r.payload.settings.showFarm === DEFAULT_SETTINGS.showFarm, `${r.payload.settings.showFarm}`)

// A corrupt file must not crash the plugin.
fs.writeFileSync(SETTINGS, '{ not json at all', 'utf8')
boot()
r = await call('GET', '/state')
check('损坏的设置文件不会崩溃', r.status === 200, `status=${r.status}`)
check('损坏时回落到默认值', r.payload.settings.rewardMultiplier === DEFAULT_SETTINGS.rewardMultiplier)

// ── achievements ─────────────────────────────────────────────────────────────

section('设置相关成就')

writeSave(() => {})
clearSettings()
boot()
/**
 * `unfiltered` must NOT unlock on a fresh install.
 *
 * An earlier version tested `systemsHidden === 0`, which is true with no settings
 * file at all — so the achievement fired for doing nothing. It now also requires
 * having hidden something at some point.
 */
r = await call('GET', '/state')
let ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('全新存档不会白送「全都要」', !ids.includes('unfiltered'), ids.join(','))

// Hide systems, then re-show them: now `unfiltered` describes a real choice.
await call('POST', '/settings', { showFarm: false, showAlchemy: false, showQuests: false })
r = await call('GET', '/state')
ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('极简主义（关掉 3 个系统）', ids.includes('minimalist'), ids.join(','))
check('调校（改动过设置）', ids.includes('tinkerer'), ids.join(','))
check('还没全部打开，全都要仍未解锁', !ids.includes('unfiltered'), ids.join(','))

// Restore them all: now it fires, and it means something.
await call('POST', '/settings', { showFarm: true, showAlchemy: true, showQuests: true })
r = await call('GET', '/state')
ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('全部打开后解锁「全都要」', ids.includes('unfiltered'), ids.join(','))

await call('POST', '/settings', { rewardMultiplier: rewardEntry.max })
r = await call('GET', '/state')
ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('调到十一（某项到上限）', ids.includes('to-eleven'), ids.join(','))

// Restoring defaults must not UN-unlock anything.
await call('POST', '/settings-reset')
r = await call('GET', '/state')
ids = r.payload.achievements.filter((a) => a.unlockedAt !== null).map((a) => a.id)
check('恢复默认后成就仍然解锁', ids.includes('to-eleven') && ids.includes('minimalist'), ids.join(','))

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
