/**
 * Host half of the 签到 (check-in) plugin.
 *
 * A check-in system only works if the clock is trustworthy. The browser cannot
 * be trusted with time: a page can be closed, a profile can be cleared, and
 * `Date.now()` inside a tab that was sleeping is not a schedule. So the host
 * owns the single durable save — one small JSON file under `$DSH_HOME/checkin`
 * — and every period's availability, streak and reward is computed here.
 *
 * The design goal is "something is always waiting": five periods of very
 * different lengths mean a minute check-in is ready almost whenever you look,
 * while the daily/weekly/monthly ones give the long arc. Streaks are what make
 * it worth returning to, so every reward scales with them.
 *
 * The host owns no UI. Everything visible is `client.js`; this half is the save
 * file, the clock, the economy, and the achievement rules.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The Loader row id. Must match `cordis.patch.yml` exactly — a mismatch here
 * mounts a second, differently-named row instead of the intended one.
 */
export const name = 'dsh-moyu'

/** The page needs the HTTP server; the save file is written directly. */
export const inject = []

/**
 * The save directory under `$DSH_HOME`.
 *
 * Deliberately NOT renamed with the package: existing players have their save in
 * `checkin/state.json`, and a rename would orphan every save on upgrade. The
 * directory name is an internal detail nobody outside this file sees.
 */
const DATA_DIR = 'checkin'
const SAVE_FILE = 'state.json'
/**
 * Settings live in their OWN file, not in the save.
 *
 * They are preferences, not progress: `reset` (and rebirth's currency wipe) must
 * not silently discard how the player wants the game to behave, and a settings
 * edit must not touch a save full of delicate timing state. Two files, two
 * lifetimes.
 */
const SETTINGS_FILE = 'settings.json'

/** Keep the event log short: it is a feed, not an audit trail. */
const HISTORY_LIMIT = 60

// ── version, changelog and self-update ──────────────────────────────────────

/**
 * The running plugin's version.
 *
 * Deliberately a literal, not a read of package.json: the browser half has no
 * filesystem access and the value must be available synchronously on the very
 * first snapshot. `package.json` carries the same number, and a test asserts
 * the two agree — because a version that only exists in one of them is exactly
 * the bug that makes an updater compare a stale value against a fresh one.
 */
export const VERSION = '1.4.0'

/**
 * Where updates are fetched from.
 *
 * A plain HTTPS base URL, configured rather than hard-coded as a repo path so a
 * fork only has to change one string. The updater expects this layout:
 *
 *   <base>/manifest.json   → { version, files: { "index.js": "<sha256>", ... } }
 *   <base>/index.js        → the file itself
 *   <base>/client.js
 *
 * Deliberately dumb: two files and a hash list, served from GitHub Pages or a
 * raw.githubusercontent.com tree. No archive extraction, no installer, no
 * dependency resolution — the whole plugin is two hand-written files, so
 * "update" means "replace those two files, if their hashes match".
 */
/**
 * Where the updater reads `manifest.json` and the files it names.
 *
 * The REPOSITORY ROOT, not a `dist/` folder. GitHub's web uploader flattens
 * directories, so `dist/` — and everything else that lived in a subfolder — was
 * published to the root. Rather than fight that, the root IS the release
 * location: it holds manifest.json, index.js, client.js and package.json side by
 * side, which is exactly the shape the updater expects.
 *
 * `tools/build-dist.mjs` still writes a local `dist/` folder for packaging; it
 * is simply not the URL that gets served.
 */
const UPDATE_BASE = 'https://raw.githubusercontent.com/yizhiyangyangqwq/dsh-moyu/main'

/** Files the updater is allowed to touch. Anything else is refused. */
const UPDATE_FILES = ['index.js', 'client.js', 'package.json']

/**
 * The changelog, newest first.
 *
 * It ships INSIDE the plugin rather than being read from the network: the
 * 「公告」 tab must have something to show the moment the panel opens, offline,
 * on a fresh install. A remote changelog would make the tab empty exactly when
 * there is no network — which is when a player is most likely to wonder what
 * changed.
 */
export const CHANGELOG = [
  {
    version: '1.4.0',
    date: '2026-10-18',
    title: '自动检查更新',
    notes: [
      '「允许联网检查更新」现在默认打开——但仍然只有你点按钮时才联网，不会自己发请求。',
      '新增「自动检查更新」开关（默认关闭）：打开后每隔几小时自己检查一次。',
      '自动检查发现新版本时会弹一条提示，可以关掉，不会反复出现同一个版本。',
      'Windows 下还会额外发一条系统通知，插件在后台也能看到。',
      '关掉「允许联网检查更新」会让自动检查一并失效——它的开关会自动置灰。',
      '关于页底部加了「去 GitHub 点个 Star」，点开就是仓库。',
    ],
  },
  {
    version: '1.3.1',
    date: '2026-10-17',
    title: '鱼竿改成永久解锁',
    notes: [
      '买过的鱼竿不再被新竿覆盖——所有买过的竿都留着，随时切换。',
      '买新竿会自动换上它；想用回旧的，在鱼竿列表里点「切换」即可。',
      '旧存档会自动迁移：原来的单根竿变成集合里的第一根。',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-10-17',
    title: '设置页也能签到',
    notes: [
      '新增第三个入口：DSH 设置页里多一行签到，直接显示可领数量，一键领完所有就绪的签到。',
      '不用打开插件面板也能签到——设置是你本来就会去的地方。',
      '这一行可以在插件设置里关掉（设置 → 界面 → 设置页里的签到），关掉不影响另外两个入口。',
      '点「打开签到」会先关掉设置再切到插件面板，不会出现"点了没反应"。',
    ],
  },
  {
    version: '1.2.1',
    date: '2026-10-17',
    title: '公告可折叠、路线可切换',
    notes: [
      '公告的更新记录现在可以逐条收起 / 展开，默认只展开最新一条；顶上有「全部展开 / 全部收起」。',
      '公告支持「标记全部已读」：读完之后标签上的圆点会消失，而且这个状态会记住，重启也在。',
      '开店的两条路线不再是死选定：之后可以花钻石换路线，第一次选仍然免费。',
      '换路线的价格会随次数上涨（12 → 22 → 39 钻石…），所以换一次是纠错，反复横跳是成本。',
      '换路线不退机器也不没收：已经买的机器会继续运转，攒的产出照常可以收。',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-17',
    title: '钓鱼与开店',
    notes: [
      '新增「钓鱼」标签页：下竿、等咬钩、在很短的窗口里收杆。抢早或慢了都会跑——这是唯一一个考验时机的玩法。',
      '10 种鱼、5 根鱼竿、4 个钓点，鱼类图鉴会隐藏还没钓到的种类。',
      '新增「开店」标签页：开局先选经营方式，二选一且不可更改。',
      '自动化：买机器替你干活，机器在你离开时照样运转，收的时候结算工资。',
      '工作化：没有机器，每单自己接，单次收益更高，愿意花时间的话产出超过自动化。',
      '新增 4 种商品、4 台机器、声望系统，商品按声望逐步解锁。',
      '新增 32 个成就（钓鱼 14 + 开店 18），成就总数达到 213，新增两个树状图分支。',
      '修复一个真实 bug：路由里 { ...snapshot(), result: action() } 的求值顺序会让响应带上操作前的快照，表现为「点了一下没反应」。',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-17',
    title: '公告板块与一键更新',
    notes: [
      '新增「公告」标签页：版本历史、更新说明，以及检查更新与直接更新的按钮。',
      '插件从此可以自己更新了——点两下就把 index.js / client.js 换成新版本，不用手动翻文件夹。',
      '新增两项设置：是否在打开面板时提示新版本、是否允许插件联网检查更新（默认关闭，因为它和「不联网」的承诺相关）。',
      '「关于」页补了两段话：它该放在创意栏，以及玩法本来就该由你自己调。',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-14',
    title: '两个入口，至少留一个',
    notes: [
      '左下角徽章和侧边栏入口可以分别关闭，但不能同时关闭——否则设置页自己也进不去了。',
      '铁锭换成了圆形符号 ◎，和硬币 ◉、金币 ● 组成一族。',
      '铁锭现在真的能拿到（周签、月签、宝箱、幸运掉落、采集）也能花掉（铁宝箱、铁骨行囊）。',
      '关于页上线，头像内联在插件里，不产生任何网络请求。',
      '新增铁骨行囊升级、铁宝箱，共 16 项商店升级、5 种宝箱。',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-10-05',
    title: '挖矿、营地与铁锭',
    notes: [
      '矿洞：20 层、10 种矿石，挥镐消耗体力，矿脉要凿几下才碎。',
      '四名矿工可以雇佣，工资在收取时结算——放置收入唯一说得通的记账方式。',
      '出门途中不再干等：可以睡觉（快进一半、补体力）、采集（免费捡东西）、返回（二次确认）。',
      '新增第八种货币「铁锭」，落在硬币和金币之间。',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-20',
    title: '农场',
    notes: [
      '仿 QQ 农场：种下去、走开、回来收。6 块地起步，最多 18 块。',
      '病害只减速不毁作物——离开一周回来不会看到枯死的庄稼。',
      '一键收获 / 一键照看，收成全部可以卖。',
    ],
  },
]

/** The newest version this build knows about, for the "you are current" line. */
export const LATEST_KNOWN_VERSION = CHANGELOG[0].version

/** Compare two dotted versions. Returns -1 / 0 / 1. */
export function compareVersions(a, b) {
  const parse = (text) =>
    String(text ?? '')
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

// ── the economy ─────────────────────────────────────────────────────────────

/**
 * The five currencies, in ascending rarity. `key` is the wire name, `label` is
 * what the user sees, and `token` is the theme alias used to paint it — the
 * client never invents a colour, so both halves agree on the palette.
 */
export const CURRENCIES = [
  { key: 'xp', label: '经验', token: '--dsw-alias-state-business-primary', symbol: '✦' },
  { key: 'coin', label: '硬币', token: '--dsw-alias-state-idle-primary', symbol: '◉' },
  // 铁锭 sits between 硬币 and 金币: worth more than a handful of coins but far
  // less than gold, so it fills the gap where copper is too small and gold too
  // large for small rewards. The symbol is round like the other metal discs —
  // 硬币 ◉ / 铁锭 ◎ / 金币 ● read as one family of coins by size.
  { key: 'iron', label: '铁锭', token: '--dsw-alias-label-secondary', symbol: '◎' },
  { key: 'gold', label: '金币', token: '--dsw-alias-state-warn-primary', symbol: '●' },
  { key: 'diamond', label: '钻石', token: '--dsw-alias-link', symbol: '◆' },
  { key: 'bar', label: '金条', token: '--dsw-alias-state-success-primary', symbol: '▮' },
  { key: 'relic', label: '遗物', token: '--dsw-alias-state-error-primary', symbol: '✧' },
  // 星辰 is the prestige currency: it is only earned by rebirthing and only spent
  // on 星盘 upgrades, neither of which ever resets.
  { key: 'star', label: '星辰', token: '--dsw-alias-brand-primary', symbol: '✶' },
]

const CURRENCY_KEYS = CURRENCIES.map((entry) => entry.key)

/**
 * The five periods.
 *
 * `intervalMs` periods are pure elapsed time and can be claimed from anywhere.
 * `calendar` periods reset on a local boundary, which is what makes a "day"
 * mean the user's day rather than 24 hours since their last click.
 */
export const PERIODS = [
  {
    key: 'minute',
    label: '每分钟',
    short: '分',
    intervalMs: 60_000,
    /** Rewards are the base drop; the streak multiplier is applied on top. */
    rewards: { xp: 2, coin: 1 },
    accent: '--dsw-alias-state-idle-primary',
  },
  {
    key: 'tenMin',
    label: '每十分钟',
    short: '十',
    intervalMs: 600_000,
    rewards: { xp: 4, coin: 3 },
    accent: '--dsw-alias-state-idle-primary',
  },
  {
    key: 'hour',
    label: '每小时',
    short: '时',
    intervalMs: 3_600_000,
    rewards: { xp: 8, gold: 5, coin: 2 },
    accent: '--dsw-alias-state-business-primary',
  },
  {
    key: 'sixHour',
    label: '每六小时',
    short: '六',
    intervalMs: 21_600_000,
    rewards: { xp: 45, gold: 30, coin: 8 },
    accent: '--dsw-alias-state-business-primary',
  },
  {
    key: 'day',
    label: '每日',
    short: '日',
    calendar: 'day',
    rewards: { xp: 30, gold: 40, coin: 10 },
    accent: '--dsw-alias-state-warn-primary',
  },
  {
    key: 'week',
    label: '每周',
    short: '周',
    calendar: 'week',
    // 周签 is the first place 铁锭 shows up as a salary: small, steady, and
    // tied to showing up — the currency's main sources are all "come back
    // tomorrow" systems by design.
    rewards: { xp: 150, gold: 300, coin: 60, iron: 8, diamond: 2 },
    accent: '--dsw-alias-link',
  },
  {
    key: 'month',
    label: '每月',
    short: '月',
    calendar: 'month',
    rewards: { xp: 600, gold: 1200, coin: 250, iron: 25, diamond: 8, bar: 1 },
    accent: '--dsw-alias-state-success-primary',
  },
  {
    key: 'quarter',
    label: '每季度',
    short: '季',
    calendar: 'quarter',
    rewards: { xp: 2600, gold: 5200, coin: 1100, diamond: 30, bar: 5 },
    accent: '--dsw-alias-state-success-primary',
  },
]

const PERIOD_KEYS = PERIODS.map((entry) => entry.key)
const PERIOD_BY_KEY = new Map(PERIODS.map((entry) => [entry.key, entry]))

/** A streak multiplies the drop, but it must not run away without bound. */
const STREAK_STEP = 0.05
const STREAK_CAP = 30

/** How often a claim also drops something extra, and what it can be. */
const LUCKY_CHANCE = 0.12
const LUCKY_DROPS = [
  { key: 'gold', min: 20, max: 90, label: '路边捡到一小袋金币' },
  { key: 'coin', min: 5, max: 25, label: '口袋里多出几枚硬币' },
  { key: 'iron', min: 1, max: 3, label: '路边捡到几块铁锭' },
  { key: 'diamond', min: 1, max: 1, label: '指尖一凉——是一颗钻石' },
  { key: 'xp', min: 15, max: 60, label: '忽然想通了一件事' },
]

// ── levels ──────────────────────────────────────────────────────────────────

/** XP needed to advance FROM `level` to the next one. Grows, but not steeply. */
function xpToAdvance(level) {
  return 50 + (level - 1) * 35
}

/** Resolve a cumulative XP total into `{ level, into, need, progress }`. */
function levelOf(totalXp) {
  let level = 1
  let remaining = Math.max(0, Math.floor(totalXp))
  while (remaining >= xpToAdvance(level) && level < 999) {
    remaining -= xpToAdvance(level)
    level += 1
  }
  const need = xpToAdvance(level)
  return { level, into: remaining, need, progress: need === 0 ? 0 : remaining / need }
}

// ── calendar helpers ────────────────────────────────────────────────────────

function pad(value) {
  return String(value).padStart(2, '0')
}

/** A local-time bucket key; two moments share it iff they are the same period. */
function bucketKey(kind, date) {
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  if (kind === 'day') return `${year}-${pad(month + 1)}-${pad(day)}`
  if (kind === 'month') return `${year}-${pad(month + 1)}`
  if (kind === 'quarter') {
    // Calendar quarters, not "90 days since the last claim" — the same reason
    // month is a calendar bucket.
    return `${year}-Q${Math.floor(month / 3) + 1}`
  }
  if (kind === 'week') {
    // ISO week: Monday starts the week, and the week belongs to the year of
    // its Thursday — the rule that keeps late-December weeks whole.
    const target = new Date(year, month, day)
    const dayNumber = (target.getDay() + 6) % 7
    target.setDate(target.getDate() - dayNumber + 3)
    const firstThursday = new Date(target.getFullYear(), 0, 4)
    const firstDayNumber = (firstThursday.getDay() + 6) % 7
    firstThursday.setDate(firstThursday.getDate() - firstDayNumber + 3)
    const week = 1 + Math.round((target - firstThursday) / (7 * 86_400_000))
    return `${target.getFullYear()}-W${pad(week)}`
  }
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

/** The bucket immediately before `key`'s, used to decide "did the streak hold". */
function previousBucket(kind, date) {
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (kind === 'day') shifted.setDate(shifted.getDate() - 1)
  else if (kind === 'week') shifted.setDate(shifted.getDate() - 7)
  else if (kind === 'month') shifted.setMonth(shifted.getMonth() - 1)
  else if (kind === 'quarter') shifted.setMonth(shifted.getMonth() - 3)
  return bucketKey(kind, shifted)
}

// ── achievements ────────────────────────────────────────────────────────────

/**
 * The achievement table.
 *
 * Each entry declares `test(view)`, evaluated against a derived snapshot after
 * every mutation. Keeping them declarative is what makes "超多成就" cheap to
 * extend: adding one is adding a row, not touching the engine.
 *
 * `tier` only drives presentation: bronze → silver → gold → legend.
 */
export const ACHIEVEMENTS = [
  // — first steps —
  { id: 'first-blood', label: '第一次签到', desc: '完成任意一次签到', tier: 'bronze', test: (v) => v.total >= 1 },
  { id: 'ten', label: '小有习惯', desc: '累计签到 10 次', tier: 'bronze', test: (v) => v.total >= 10 },
  { id: 'fifty', label: '渐入佳境', desc: '累计签到 50 次', tier: 'silver', test: (v) => v.total >= 50 },
  { id: 'two-hundred', label: '持之以恒', desc: '累计签到 200 次', tier: 'gold', test: (v) => v.total >= 200 },
  { id: 'thousand', label: '千锤百炼', desc: '累计签到 1000 次', tier: 'legend', test: (v) => v.total >= 1000 },

  // — streaks —
  { id: 'streak-3', label: '三天打鱼', desc: '每日连续签到 3 天', tier: 'bronze', test: (v) => v.best.day >= 3 },
  { id: 'streak-7', label: '一周不落', desc: '每日连续签到 7 天', tier: 'silver', test: (v) => v.best.day >= 7 },
  { id: 'streak-30', label: '月度全勤', desc: '每日连续签到 30 天', tier: 'gold', test: (v) => v.best.day >= 30 },
  { id: 'streak-100', label: '百日之约', desc: '每日连续签到 100 天', tier: 'legend', test: (v) => v.best.day >= 100 },
  { id: 'streak-365', label: '一年之期', desc: '每日连续签到 365 天', tier: 'legend', test: (v) => v.best.day >= 365 },
  { id: 'hour-24', label: '连点成线', desc: '每小时连续签到 24 次', tier: 'gold', test: (v) => v.best.hour >= 24 },
  { id: 'minute-60', label: '守着一分钟', desc: '每分钟连续签到 60 次', tier: 'gold', test: (v) => v.best.minute >= 60 },

  // — clock —
  { id: 'early-bird', label: '早起的鸟', desc: '在 5:00–7:00 之间签到', tier: 'bronze', test: (v) => v.hours.some((h) => h >= 5 && h < 7) },
  { id: 'night-owl', label: '夜猫子', desc: '在 0:00–4:00 之间签到', tier: 'bronze', test: (v) => v.hours.some((h) => h < 4) },
  { id: 'midday', label: '正午时刻', desc: '在 12:00–13:00 之间签到', tier: 'bronze', test: (v) => v.hours.some((h) => h === 12) },
  { id: 'all-day', label: '一整天', desc: '在 24 个不同小时里都签到过', tier: 'legend', test: (v) => v.hours.length >= 24 },

  // — economy —
  { id: 'gold-1k', label: '小小积蓄', desc: '持有 1000 金币', tier: 'bronze', test: (v) => v.currencies.gold >= 1000 },
  { id: 'gold-10k', label: '腰缠万贯', desc: '持有 10000 金币', tier: 'silver', test: (v) => v.currencies.gold >= 10_000 },
  { id: 'gold-100k', label: '富甲一方', desc: '持有 100000 金币', tier: 'gold', test: (v) => v.currencies.gold >= 100_000 },
  { id: 'coin-1k', label: '硬币收藏家', desc: '持有 1000 硬币', tier: 'silver', test: (v) => v.currencies.coin >= 1000 },
  { id: 'first-diamond', label: '第一颗钻石', desc: '获得第一颗钻石', tier: 'bronze', test: (v) => v.earned.diamond >= 1 },
  { id: 'diamond-50', label: '钻石之心', desc: '累计获得 50 颗钻石', tier: 'gold', test: (v) => v.earned.diamond >= 50 },
  { id: 'first-bar', label: '第一根金条', desc: '获得第一根金条', tier: 'silver', test: (v) => v.earned.bar >= 1 },
  { id: 'bar-20', label: '金库', desc: '累计获得 20 根金条', tier: 'legend', test: (v) => v.earned.bar >= 20 },
  { id: 'all-five', label: '五毒俱全', desc: '五种货币都持有过', tier: 'gold', test: (v) => CURRENCY_KEYS.every((key) => v.everHeld[key] === true) },

  // — levels —
  { id: 'level-5', label: '初出茅庐', desc: '达到 5 级', tier: 'bronze', test: (v) => v.level >= 5 },
  { id: 'level-10', label: '小有所成', desc: '达到 10 级', tier: 'silver', test: (v) => v.level >= 10 },
  { id: 'level-25', label: '登堂入室', desc: '达到 25 级', tier: 'gold', test: (v) => v.level >= 25 },
  { id: 'level-50', label: '一代宗师', desc: '达到 50 级', tier: 'legend', test: (v) => v.level >= 50 },

  // — behaviour —
  { id: 'perfect-day', label: '全勤日', desc: '同一天里五种周期各签到一次', tier: 'gold', test: (v) => v.perfectDays >= 1 },
  { id: 'perfect-7', label: '全勤一周', desc: '达成 7 个全勤日', tier: 'legend', test: (v) => v.perfectDays >= 7 },
  { id: 'lucky-10', label: '手气不错', desc: '触发 10 次额外掉落', tier: 'silver', test: (v) => v.luckyHits >= 10 },
  { id: 'lucky-50', label: '欧皇', desc: '触发 50 次额外掉落', tier: 'gold', test: (v) => v.luckyHits >= 50 },
  { id: 'combo-5', label: '一气呵成', desc: '一次连领 5 个周期', tier: 'silver', test: (v) => v.bestCombo >= 5 },
  { id: 'month-12', label: '月度常客', desc: '每月签到累计 12 次', tier: 'gold', test: (v) => v.counts.month >= 12 },
  { id: 'week-52', label: '周周不落', desc: '每周签到累计 52 次', tier: 'legend', test: (v) => v.counts.week >= 52 },

  // — the shop —
  { id: 'first-upgrade', label: '第一次升级', desc: '在商店买下任意一项升级', tier: 'bronze', test: (v) => v.upgradesOwned >= 1 },
  { id: 'ten-upgrades', label: '小小工程', desc: '累计买下 10 级升级', tier: 'silver', test: (v) => v.upgradesOwned >= 10 },
  { id: 'thirty-upgrades', label: '工业革命', desc: '累计买下 30 级升级', tier: 'gold', test: (v) => v.upgradesOwned >= 30 },
  { id: 'max-one', label: '圆满', desc: '把任意一项升级升到满级', tier: 'gold', test: (v) => v.maxedUpgrades >= 1 },
  { id: 'max-five', label: '全都要', desc: '把五项升级升到满级', tier: 'legend', test: (v) => v.maxedUpgrades >= 5 },

  // — chests —
  { id: 'first-chest', label: '开箱', desc: '打开第一个宝箱', tier: 'bronze', test: (v) => v.chestsOpened >= 1 },
  { id: 'chest-10', label: '手痒', desc: '累计打开 10 个宝箱', tier: 'bronze', test: (v) => v.chestsOpened >= 10 },
  { id: 'chest-50', label: '开箱成瘾', desc: '累计打开 50 个宝箱', tier: 'silver', test: (v) => v.chestsOpened >= 50 },
  { id: 'chest-200', label: '箱中之王', desc: '累计打开 200 个宝箱', tier: 'gold', test: (v) => v.chestsOpened >= 200 },
  { id: 'chest-1000', label: '开箱之神', desc: '累计打开 1000 个宝箱', tier: 'legend', test: (v) => v.chestsOpened >= 1000 },
  { id: 'chest-diamond', label: '钻石之匣', desc: '打开一个钻石宝箱', tier: 'gold', test: (v) => v.chestsOpenedById.diamond >= 1 },

  // — offline —
  { id: 'offline-1', label: '回来了', desc: '第一次领取离线收益', tier: 'bronze', test: (v) => v.offlineCollected >= 1 },
  { id: 'offline-10', label: '常回来看看', desc: '累计领取 10 次离线收益', tier: 'silver', test: (v) => v.offlineCollected >= 10 },
  { id: 'offline-100', label: '细水长流', desc: '累计领取 100 次离线收益', tier: 'legend', test: (v) => v.offlineCollected >= 100 },
  { id: 'offline-full', label: '满载而归', desc: '一次领满离线收益上限', tier: 'gold', test: (v) => v.offlinePoolFull === true },

  // — the finer-grained periods —
  { id: 'ten-min-30', label: '十分钟热度', desc: '每十分钟连续签到 30 次', tier: 'silver', test: (v) => v.best.tenMin >= 30 },
  { id: 'six-hour-8', label: '半日不落', desc: '每六小时连续签到 8 次', tier: 'silver', test: (v) => v.best.sixHour >= 8 },
  { id: 'quarter-1', label: '一个季度', desc: '完成第一次每季度签到', tier: 'gold', test: (v) => v.counts.quarter >= 1 },
  { id: 'quarter-4', label: '四季', desc: '每季度签到累计 4 次', tier: 'legend', test: (v) => v.counts.quarter >= 4 },
  { id: 'all-periods', label: '八面玲珑', desc: '八个周期各签到过至少一次', tier: 'gold', test: (v) => Object.values(v.counts).every((n) => n >= 1) },
  { id: 'all-periods-10', label: '样样精通', desc: '八个周期各签到过至少 10 次', tier: 'legend', test: (v) => Object.values(v.counts).every((n) => n >= 10) },

  // — expeditions —
  { id: 'first-trip', label: '出门', desc: '第一次出门寻宝', tier: 'bronze', test: (v) => v.expedition.runs >= 1 },
  { id: 'trip-10', label: '常客', desc: '完成 10 次行程', tier: 'bronze', test: (v) => v.expedition.runs >= 10 },
  { id: 'trip-50', label: '老练', desc: '完成 50 次行程', tier: 'silver', test: (v) => v.expedition.runs >= 50 },
  { id: 'trip-200', label: '探险家', desc: '完成 200 次行程', tier: 'gold', test: (v) => v.expedition.runs >= 200 },
  { id: 'trip-1000', label: '传奇旅人', desc: '完成 1000 次行程', tier: 'legend', test: (v) => v.expedition.runs >= 1000 },
  { id: 'abyss-1', label: '望向深渊', desc: '完成一次深渊行程', tier: 'gold', test: (v) => (v.expedition.byDestination.abyss ?? 0) >= 1 },
  { id: 'abyss-10', label: '深渊常客', desc: '完成 10 次深渊行程', tier: 'legend', test: (v) => (v.expedition.byDestination.abyss ?? 0) >= 10 },

  // — the pack —
  { id: 'pack-5', label: '有一点收获', desc: '背包里有 5 件东西', tier: 'bronze', test: (v) => v.packTotal >= 5 },
  { id: 'pack-20', label: '装不下了', desc: '背包里有 20 件东西', tier: 'silver', test: (v) => v.packTotal >= 20 },
  { id: 'pack-50', label: '囤积癖', desc: '背包里有 50 件东西', tier: 'gold', test: (v) => v.packTotal >= 50 },
  { id: 'unique-6', label: '收藏家', desc: '背包里凑齐 6 种不同的东西', tier: 'silver', test: (v) => v.packUnique >= 6 },
  { id: 'unique-10', label: '博物学家', desc: '累计找到 10 种不同的东西', tier: 'gold', test: (v) => v.expedition.uniqueFound >= 10 },
  { id: 'unique-all', label: '图鉴全满', desc: '累计找到全部 13 种东西', tier: 'legend', test: (v) => v.expedition.uniqueFound >= 13 },

  // — rarity —
  { id: 'rarity-uncommon', label: '不止是贝壳', desc: '找到一件少见品质的东西', tier: 'bronze', test: (v) => v.bestTierRank >= 1 },
  { id: 'rarity-rare', label: '运气不错', desc: '找到一件稀有品质的东西', tier: 'silver', test: (v) => v.bestTierRank >= 2 },
  { id: 'rarity-legendary', label: '传说中的东西', desc: '找到一件传说品质的东西', tier: 'legend', test: (v) => v.bestTierRank >= 3 },

  // — selling & supplies —
  { id: 'first-sell', label: '第一桶金', desc: '卖掉第一件东西', tier: 'bronze', test: (v) => v.soldTotal >= 1 },
  { id: 'sell-25', label: '小贩', desc: '累计卖出 25 件东西', tier: 'silver', test: (v) => v.soldTotal >= 25 },
  { id: 'sell-100', label: '当铺老板', desc: '累计卖出 100 件东西', tier: 'gold', test: (v) => v.soldTotal >= 100 },
  { id: 'relic-1', label: '第一件遗物', desc: '持有 1 个遗物', tier: 'gold', test: (v) => v.currencies.relic >= 1 },
  { id: 'relic-25', label: '遗物学者', desc: '持有 25 个遗物', tier: 'legend', test: (v) => v.currencies.relic >= 25 },
  { id: 'first-use', label: '物尽其用', desc: '使用一件补给或增益道具', tier: 'bronze', test: (v) => v.usedTotal >= 1 },
  { id: 'buff-active', label: '状态正好', desc: '同时拥有两个生效中的增益', tier: 'gold', test: (v) => v.activeBuffs >= 2 },
  { id: 'supply-full', label: '满装待发', desc: '出门之后把物资重新填满', tier: 'silver', test: (v) => v.suppliesFull === true && v.expedition.runs >= 1 },
  { id: 'supply-cap-40', label: '大行囊', desc: '物资上限达到 40', tier: 'gold', test: (v) => v.modifiers.supplyCap >= 40 },
  { id: 'pack-size-80', label: '超级背包', desc: '背包容量达到 80', tier: 'gold', test: (v) => v.modifiers.packSize >= 80 },

  // — long-haul milestones —
  { id: 'total-500', label: '五百次', desc: '累计签到 500 次', tier: 'gold', test: (v) => v.total >= 500 },
  { id: 'total-2000', label: '两千次', desc: '累计签到 2000 次', tier: 'legend', test: (v) => v.total >= 2000 },
  { id: 'day-30', label: '每日三十', desc: '每日签到累计 30 次', tier: 'silver', test: (v) => v.counts.day >= 30 },
  { id: 'day-365', label: '一年', desc: '每日签到累计 365 次', tier: 'legend', test: (v) => v.counts.day >= 365 },
  { id: 'hour-100', label: '整点人生', desc: '每小时签到累计 100 次', tier: 'gold', test: (v) => v.counts.hour >= 100 },
  { id: 'minute-500', label: '分秒必争', desc: '每分钟签到累计 500 次', tier: 'gold', test: (v) => v.counts.minute >= 500 },
  { id: 'level-75', label: '名宿', desc: '达到 75 级', tier: 'gold', test: (v) => v.level >= 75 },
  { id: 'level-100', label: '百级', desc: '达到 100 级', tier: 'legend', test: (v) => v.level >= 100 },

  // — wealth ceilings —
  { id: 'gold-1m', label: '百万富翁', desc: '持有 1000000 金币', tier: 'legend', test: (v) => v.currencies.gold >= 1_000_000 },
  { id: 'diamond-500', label: '钻石矿脉', desc: '累计获得 500 颗钻石', tier: 'legend', test: (v) => v.earned.diamond >= 500 },
  { id: 'bar-100', label: '黄金储备', desc: '累计获得 100 根金条', tier: 'legend', test: (v) => v.earned.bar >= 100 },
  { id: 'relic-100', label: '遗物库', desc: '持有 100 个遗物', tier: 'legend', test: (v) => v.currencies.relic >= 100 },

  // — expedition mastery —
  { id: 'trip-500', label: '行遍天下', desc: '完成 500 次行程', tier: 'legend', test: (v) => v.expedition.runs >= 500 },
  { id: 'all-destinations', label: '四处都去过', desc: '四个目的地各去过至少一次', tier: 'gold', test: (v) => v.expedition.visitedAll === true },
  { id: 'all-tiers', label: '四种品质', desc: '常见 / 少见 / 稀有 / 传说都找到过', tier: 'legend', test: (v) => v.expedition.foundTiers.length >= 4 },
  { id: 'unique-13', label: '博物全录', desc: '累计找到 13 种东西', tier: 'legend', test: (v) => v.expedition.uniqueFound >= 13 },

  // — hoarding & commerce —
  { id: 'sell-500', label: '商行', desc: '累计卖出 500 件东西', tier: 'legend', test: (v) => v.soldTotal >= 500 },
  { id: 'pack-200', label: '仓库', desc: '背包里有 200 件东西', tier: 'gold', test: (v) => v.packTotal >= 200 },
  { id: 'buff-3', label: '状态绝佳', desc: '同时拥有三个生效中的增益', tier: 'gold', test: (v) => v.activeBuffs >= 3 },
  { id: 'supply-cap-100', label: '后勤大师', desc: '物资上限达到 100', tier: 'legend', test: (v) => v.modifiers.supplyCap >= 100 },
  { id: 'pack-size-200', label: '移动仓库', desc: '背包容量达到 200', tier: 'legend', test: (v) => v.modifiers.packSize >= 200 },
  { id: 'chest-5000', label: '开箱永动机', desc: '累计打开 5000 个宝箱', tier: 'legend', test: (v) => v.chestsOpened >= 5000 },
  { id: 'offline-500', label: '岁月', desc: '累计领取 500 次离线收益', tier: 'legend', test: (v) => v.offlineCollected >= 500 },
  { id: 'perfect-30', label: '全勤之月', desc: '达成 30 个全勤日', tier: 'legend', test: (v) => v.perfectDays >= 30 },
  { id: 'max-all', label: '全部满级', desc: '把全部升级项升到满级', tier: 'legend', test: (v) => v.maxedUpgrades >= v.upgradeCount && v.upgradeCount > 0 },
  { id: 'streak-all', label: '全线连签', desc: '八个周期都达到过连签 2 次以上', tier: 'gold', test: (v) => Object.values(v.best).every((n) => n >= 2) },

  // — daily quests —
  { id: 'quest-1', label: '今日事今日毕', desc: '完成第一个每日任务', tier: 'bronze', test: (v) => v.questsClaimed >= 1 },
  { id: 'quest-all', label: '今日全清', desc: '一天内领完当日全部任务', tier: 'silver', test: (v) => v.dailyAllClaimed === true },
  { id: 'quest-all-10', label: '日复一日', desc: '累计领完 10 天的全部任务', tier: 'legend', test: (v) => v.questAllDays >= 10 },

  // — alchemy —
  { id: 'alchemy-1', label: '第一次炼金', desc: '完成一次炼金', tier: 'bronze', test: (v) => v.alchemyRuns >= 1 },
  { id: 'alchemy-10', label: '炼金学徒', desc: '完成 10 次炼金', tier: 'silver', test: (v) => v.alchemyRuns >= 10 },
  { id: 'alchemy-100', label: '炼金大师', desc: '完成 100 次炼金', tier: 'gold', test: (v) => v.alchemyRuns >= 100 },
  { id: 'alchemy-kinds', label: '配方通', desc: '把 8 种配方都用过', tier: 'legend', test: (v) => v.alchemyKinds >= 8 },

  // — rebirth —
  { id: 'rebirth-1', label: '轮回', desc: '完成第一次转生', tier: 'gold', test: (v) => v.rebirths >= 1 },
  { id: 'rebirth-5', label: '五次轮回', desc: '累计转生 5 次', tier: 'legend', test: (v) => v.rebirths >= 5 },
  { id: 'rebirth-20', label: '无数次', desc: '累计转生 20 次', tier: 'legend', test: (v) => v.rebirths >= 20 },
  { id: 'star-1', label: '第一颗星', desc: '购买一级星盘升级', tier: 'gold', test: (v) => v.starLevels >= 1 },
  { id: 'star-20', label: '星图初成', desc: '累计购买 20 级星盘升级', tier: 'legend', test: (v) => v.starLevels >= 20 },
  { id: 'level-100-rebirth', label: '百级轮回', desc: '以 100 级完成一次转生', tier: 'legend', test: (v) => v.rebirthBestLevel >= 100 },

  // — the farm —
  { id: 'farm-plant-1', label: '下地', desc: '种下第一株作物', tier: 'bronze', test: (v) => v.farmPlanted >= 1 },
  { id: 'farm-harvest-1', label: '第一次收成', desc: '完成第一次收获', tier: 'bronze', test: (v) => v.farmHarvested >= 1 },
  { id: 'farm-harvest-50', label: '小农', desc: '累计收获 50 份作物', tier: 'silver', test: (v) => v.farmHarvested >= 50 },
  { id: 'farm-harvest-500', label: '农场主', desc: '累计收获 500 份作物', tier: 'gold', test: (v) => v.farmHarvested >= 500 },
  { id: 'farm-harvest-5000', label: '庄园', desc: '累计收获 5000 份作物', tier: 'legend', test: (v) => v.farmHarvested >= 5000 },
  { id: 'farm-tend-1', label: '看一眼', desc: '第一次照看作物', tier: 'bronze', test: (v) => v.farmTended >= 1 },
  { id: 'farm-tend-50', label: '细心', desc: '累计照看 50 次', tier: 'silver', test: (v) => v.farmTended >= 50 },
  { id: 'farm-tend-500', label: '农人的手', desc: '累计照看 500 次', tier: 'legend', test: (v) => v.farmTended >= 500 },
  { id: 'farm-kinds-3', label: '不只种一样', desc: '种过 3 种不同的作物', tier: 'silver', test: (v) => v.farmKinds >= 3 },
  { id: 'farm-kinds-all', label: '五谷丰登', desc: '把 6 种作物都种过', tier: 'legend', test: (v) => v.farmKinds >= 6 },
  { id: 'farm-full', label: '没有空地', desc: '让每一块地都种上东西', tier: 'gold', test: (v) => v.farmPlots > 0 && v.farmPlanted >= v.farmPlots },
  { id: 'farm-plots-12', label: '开垦', desc: '拥有 12 块地', tier: 'gold', test: (v) => v.farmPlots >= 12 },
  { id: 'farm-plots-max', label: '良田千亩', desc: '把地开到上限 18 块', tier: 'legend', test: (v) => v.farmPlots >= 18 },
  { id: 'farm-lotus', label: '灵莲', desc: '种出并收获一株灵莲', tier: 'legend', test: (v) => (v.farmByCrop.lotus ?? 0) >= 1 },
  { id: 'farm-ready-3', label: '一起来', desc: '同时有 3 块地熟透等你收', tier: 'gold', test: (v) => v.farmReady >= 3 },

  // — deeper milestones on existing systems —
  { id: 'total-5000', label: '五千次', desc: '累计签到 5000 次', tier: 'legend', test: (v) => v.total >= 5000 },
  { id: 'streak-500', label: '五百日', desc: '每日连续签到 500 天', tier: 'legend', test: (v) => v.best.day >= 500 },
  { id: 'level-200', label: '两百级', desc: '达到 200 级', tier: 'legend', test: (v) => v.level >= 200 },
  { id: 'gold-10m', label: '千万', desc: '持有 10000000 金币', tier: 'legend', test: (v) => v.currencies.gold >= 10_000_000 },
  { id: 'chest-20000', label: '两万箱', desc: '累计打开 20000 个宝箱', tier: 'legend', test: (v) => v.chestsOpened >= 20_000 },
  { id: 'sell-2000', label: '商贾', desc: '累计卖出 2000 件东西', tier: 'legend', test: (v) => v.soldTotal >= 2000 },
  { id: 'trip-2000', label: '远行者', desc: '完成 2000 次行程', tier: 'legend', test: (v) => v.expedition.runs >= 2000 },
  { id: 'alchemy-500', label: '贤者之石', desc: '完成 500 次炼金', tier: 'legend', test: (v) => v.alchemyRuns >= 500 },
  { id: 'rebirth-50', label: '五十世', desc: '累计转生 50 次', tier: 'legend', test: (v) => v.rebirths >= 50 },
  { id: 'star-100', label: '满天星', desc: '累计购买 100 级星盘升级', tier: 'legend', test: (v) => v.starLevels >= 100 },
  { id: 'quest-all-50', label: '五十天全清', desc: '累计领完 50 天的全部任务', tier: 'legend', test: (v) => v.questAllDays >= 50 },
  { id: 'perfect-100', label: '百日全勤', desc: '达成 100 个全勤日', tier: 'legend', test: (v) => v.perfectDays >= 100 },
  { id: 'offline-1000', label: '漫长岁月', desc: '累计领取 1000 次离线收益', tier: 'legend', test: (v) => v.offlineCollected >= 1000 },
  { id: 'buff-5', label: '状态爆表', desc: '同时拥有五个生效中的增益', tier: 'legend', test: (v) => v.activeBuffs >= 5 },
  { id: 'pack-size-500', label: '无尽行囊', desc: '背包容量达到 500', tier: 'legend', test: (v) => v.modifiers.packSize >= 500 },
  { id: 'supply-cap-200', label: '补给线', desc: '物资上限达到 200', tier: 'legend', test: (v) => v.modifiers.supplyCap >= 200 },
  { id: 'farm-harvest-20000', label: '天下粮仓', desc: '累计收获 20000 份作物', tier: 'legend', test: (v) => v.farmHarvested >= 20_000 },
  { id: 'farm-tend-2000', label: '老农', desc: '累计照看 2000 次', tier: 'legend', test: (v) => v.farmTended >= 2000 },
  { id: 'farm-all-ready', label: '满园成熟', desc: '同时有 6 块地熟透', tier: 'legend', test: (v) => v.farmReady >= 6 },

  // — mastery across systems —
  { id: 'all-systems', label: '面面俱到', desc: '签到、开箱、卖货、出门、炼金、种地都做过', tier: 'gold', test: (v) => v.total >= 1 && v.chestsOpened >= 1 && v.soldTotal >= 1 && v.expedition.runs >= 1 && v.alchemyRuns >= 1 && v.farmHarvested >= 1 },
  { id: 'triple-mastery', label: '三绝', desc: '转生 10 次、炼金 100 次、收获 1000 份', tier: 'legend', test: (v) => v.rebirths >= 10 && v.alchemyRuns >= 100 && v.farmHarvested >= 1000 },
  { id: 'century', label: '百年', desc: '每日累计签到 1000 次且总签到过万', tier: 'legend', test: (v) => v.counts.day >= 1000 && v.total >= 10_000 },

  // — settings-aware —
  {
    id: 'tinkerer',
    label: '调校',
    desc: '改动过任意一项设置',
    tier: 'bronze',
    test: (v) => v.settingsTouched >= 1,
  },
  {
    id: 'to-eleven',
    label: '调到十一',
    desc: '把某项倍率类设置调到上限',
    tier: 'silver',
    test: (v) => v.settingsAtMax >= 1,
  },
  {
    id: 'minimalist',
    label: '极简主义',
    desc: '关掉至少三个系统的标签页',
    tier: 'silver',
    test: (v) => v.systemsHidden >= 3,
  },
  {
    id: 'unfiltered',
    label: '全都要',
    desc: '关掉过系统标签页之后，又把它们全部打开',
    tier: 'bronze',
    /**
     * Requires having used the switches, not merely leaving them alone.
     *
     * An earlier version tested `systemsHidden === 0`, which is TRUE on a fresh
     * save — so the achievement unlocked on install, for doing nothing at all.
     * Gating on `settingsTouched` makes it describe a choice the player actually
     * made: they hid something and then changed their mind back.
     */
    test: (v) => v.systemsHidden === 0 && v.settingsTouched >= 1 && v.hidSystemsBefore === true,
  },

  // — the mine —
  { id: 'mine-swing-1', label: '下镐', desc: '挥出第一镐', tier: 'bronze', test: (v) => v.mineSwings >= 1 },
  { id: 'mine-break-1', label: '第一块矿石', desc: '挖下第一块矿石', tier: 'bronze', test: (v) => v.mineOres >= 1 },
  { id: 'mine-deep-5', label: '往下去', desc: '下潜到第 5 层', tier: 'bronze', test: (v) => v.mineDeepest >= 5 },
  { id: 'mine-deep-10', label: '深入', desc: '下潜到第 10 层', tier: 'silver', test: (v) => v.mineDeepest >= 10 },
  { id: 'mine-deep-18', label: '渊底', desc: '下潜到第 18 层', tier: 'legend', test: (v) => v.mineDeepest >= 18 },
  { id: 'mine-ores-50', label: '小有收获', desc: '累计挖到 50 份矿石', tier: 'bronze', test: (v) => v.mineOres >= 50 },
  { id: 'mine-ores-500', label: '矿洞常客', desc: '累计挖到 500 份矿石', tier: 'silver', test: (v) => v.mineOres >= 500 },
  { id: 'mine-ores-5000', label: '矿脉之主', desc: '累计挖到 5000 份矿石', tier: 'legend', test: (v) => v.mineOres >= 5000 },
  { id: 'mine-swings-100', label: '挥镐百下', desc: '累计挥镐 100 次', tier: 'bronze', test: (v) => v.mineSwings >= 100 },
  { id: 'mine-swings-1000', label: '铁臂', desc: '累计挥镐 1000 次', tier: 'gold', test: (v) => v.mineSwings >= 1000 },
  { id: 'mine-veins-50', label: '见多识广', desc: '发现 50 条矿脉', tier: 'silver', test: (v) => v.mineVeins >= 50 },
  { id: 'mine-star-gem', label: '星石入袋', desc: '挖到一块星石', tier: 'legend', test: (v) => (v.mineByOre['star-gem'] ?? 0) >= 1 },
  { id: 'mine-all-ores', label: '矿石图鉴', desc: '10 种矿石都挖到过', tier: 'legend', test: (v) => v.mineOreKinds >= 10 },
  { id: 'mine-hire-1', label: '雇个人', desc: '雇下第一名矿工', tier: 'silver', test: (v) => v.mineMiners >= 1 },
  { id: 'mine-hire-4', label: '矿洞班子', desc: '四名矿工全在岗', tier: 'legend', test: (v) => v.mineMiners >= 4 },
  { id: 'mine-pickaxe-max', label: '传世铁镐', desc: '把铁镐升到满级', tier: 'legend', test: (v) => v.minePickaxeLevel >= 15 },
  { id: 'mine-stamina-max', label: '不知疲倦', desc: '体力上限提高到 50', tier: 'gold', test: (v) => v.mineStaminaCap >= 50 },
  { id: 'mine-empty-stamina', label: '硬撑', desc: '在体力只剩 0 时又挖到一块矿', tier: 'gold', test: (v) => v.mineLastStamina === 0 && v.mineSwings >= 50 },

  // — 钓鱼 —
  { id: 'fish-first', label: '第一竿', desc: '钓上第一条鱼', tier: 'bronze', test: (v) => v.fishCaught >= 1 },
  { id: 'fish-10', label: '有点耐心', desc: '累计钓上 10 条鱼', tier: 'bronze', test: (v) => v.fishCaught >= 10 },
  { id: 'fish-50', label: '水边常客', desc: '累计钓上 50 条鱼', tier: 'silver', test: (v) => v.fishCaught >= 50 },
  { id: 'fish-200', label: '钓鱼佬', desc: '累计钓上 200 条鱼', tier: 'gold', test: (v) => v.fishCaught >= 200 },
  { id: 'fish-1000', label: '海之主人', desc: '累计钓上 1000 条鱼', tier: 'legend', test: (v) => v.fishCaught >= 1000 },
  { id: 'fish-kinds-5', label: '认鱼了', desc: '钓到过 5 种不同的鱼', tier: 'bronze', test: (v) => v.fishKinds >= 5 },
  { id: 'fish-kinds-all', label: '鱼类图鉴', desc: '10 种鱼都钓到过', tier: 'legend', test: (v) => v.fishKinds >= 10 },
  { id: 'fish-rare', label: '锦鲤附体', desc: '钓到一条稀有鱼', tier: 'silver', test: (v) => v.fishBestRarity >= 2 },
  { id: 'fish-legend', label: '传说中的鱼', desc: '钓到一条传说鱼', tier: 'legend', test: (v) => v.fishBestRarity >= 3 },
  { id: 'fish-miss-10', label: '手抖', desc: '累计失手 10 次（抢早了或让它跑了）', tier: 'bronze', test: (v) => v.fishEscaped >= 10 },
  { id: 'fish-rod-3', label: '换了根好竿', desc: '把鱼竿升到玻璃钢竿', tier: 'silver', test: (v) => v.fishRodRank >= 2 },
  { id: 'fish-rod-max', label: '月影在手', desc: '拥有月影竿', tier: 'legend', test: (v) => v.fishRodRank >= 4 },
  { id: 'fish-spot-all', label: '走遍水边', desc: '四个钓点全部解开', tier: 'gold', test: (v) => v.fishSpotUnlocked >= 4 },
  { id: 'fish-sea', label: '出海', desc: '在海边钓上一条鱼', tier: 'gold', test: (v) => v.fishCaughtAtSea >= 1 },

  // — 开店 —
  { id: 'shop-pick', label: '开张', desc: '选好经营方式，把店开起来', tier: 'bronze', test: (v) => v.shopMode !== null },
  { id: 'shop-auto', label: '机器替人', desc: '选择自动化路线', tier: 'bronze', test: (v) => v.shopMode === 'auto' },
  { id: 'shop-manual', label: '亲手站柜台', desc: '选择工作化路线', tier: 'bronze', test: (v) => v.shopMode === 'manual' },
  { id: 'shop-sale-1', label: '第一单', desc: '卖出第一件商品', tier: 'bronze', test: (v) => v.shopSales >= 1 },
  { id: 'shop-sale-25', label: '生意不错', desc: '累计卖出 25 件', tier: 'silver', test: (v) => v.shopSales >= 25 },
  { id: 'shop-sale-100', label: '小有名气', desc: '累计卖出 100 件', tier: 'gold', test: (v) => v.shopSales >= 100 },
  { id: 'shop-sale-1000', label: '百年老店', desc: '累计卖出 1000 件', tier: 'legend', test: (v) => v.shopSales >= 1000 },
  { id: 'shop-rep-50', label: '口碑', desc: '声望达到 50', tier: 'bronze', test: (v) => v.shopReputation >= 50 },
  { id: 'shop-rep-200', label: '街坊都认', desc: '声望达到 200', tier: 'silver', test: (v) => v.shopReputation >= 200 },
  { id: 'shop-rep-800', label: '远近闻名', desc: '声望达到 800', tier: 'gold', test: (v) => v.shopReputation >= 800 },
  { id: 'shop-rep-3000', label: '金字招牌', desc: '声望达到 3000', tier: 'legend', test: (v) => v.shopReputation >= 3000 },
  { id: 'shop-all-products', label: '都有得卖', desc: '四种商品全部解锁', tier: 'gold', test: (v) => v.shopAllProducts === true },
  { id: 'shop-machine-1', label: '第一台机器', desc: '买下第一台机器', tier: 'silver', test: (v) => v.shopMachinesBought >= 1 },
  { id: 'shop-machine-all', label: '全自动', desc: '四台机器全买下', tier: 'legend', test: (v) => v.shopMachinesBought >= 4 },
  { id: 'shop-streak-10', label: '连单', desc: '连续卖出 10 单', tier: 'silver', test: (v) => v.shopBestStreak >= 10 },
  { id: 'shop-streak-40', label: '手不停', desc: '连续卖出 40 单', tier: 'legend', test: (v) => v.shopBestStreak >= 40 },
  { id: 'shop-manual-100', label: '全靠自己', desc: '手动卖出 100 件（只有工作化路线能做到）', tier: 'gold', test: (v) => v.shopManualSales >= 100 },
  { id: 'shop-auto-500', label: '躺着数钱', desc: '机器自动卖出 500 件（只有自动化路线能做到）', tier: 'legend', test: (v) => v.shopAutoSales >= 500 },
]

/** Every achievement id, for validating a layout table against the real list. */
const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map((entry) => entry.id))
const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((entry) => [entry.id, entry]))

// ── achievement tree layout ─────────────────────────────────────────────────

/**
 * Branches of the advancement tree.
 *
 * These are presentation only — the engine knows nothing about them. Grouping
 * lives in a table separate from the achievement definitions so that adding an
 * achievement is still one row of logic, and moving a node never touches a rule.
 */
export const ACHIEVEMENT_BRANCHES = [
  { id: 'start', label: '起点', accent: '--dsw-alias-state-idle-primary' },
  { id: 'streak', label: '连签', accent: '--dsw-alias-state-warn-primary' },
  { id: 'clock', label: '时钟', accent: '--dsw-alias-state-business-primary' },
  { id: 'wealth', label: '财富', accent: '--dsw-alias-state-warn-primary' },
  { id: 'explore', label: '探索', accent: '--dsw-alias-link' },
  { id: 'collect', label: '收集', accent: '--dsw-alias-state-success-primary' },
  { id: 'life', label: '生涯', accent: '--dsw-alias-label-secondary' },
  { id: 'quest', label: '任务', accent: '--dsw-alias-state-business-primary' },
  { id: 'alchemy', label: '炼金', accent: '--dsw-alias-state-success-primary' },
  { id: 'rebirth', label: '转生', accent: '--dsw-alias-brand-primary' },
  { id: 'farm', label: '农场', accent: '--dsw-alias-state-success-primary' },
  { id: 'mine', label: '矿洞', accent: '--dsw-alias-state-warn-primary' },
  { id: 'fishing', label: '钓鱼', accent: '--dsw-alias-link' },
  { id: 'shop', label: '开店', accent: '--dsw-alias-state-success-primary' },
  { id: 'settings', label: '设置', accent: '--dsw-alias-label-secondary' },
]

/**
 * Where each node sits in the tree.
 *
 * `x`/`y` are grid cells (the client multiplies by its own cell size, so the
 * layout is resolution-independent). `parent` draws the connecting line, which
 * is what makes the graph readable as a progression rather than a cloud.
 */
export const ACHIEVEMENT_LAYOUT = [
  // — 起点 —
  { id: 'first-blood', branch: 'start', x: 0, y: 0, parent: null },
  { id: 'ten', branch: 'start', x: 1, y: 0, parent: 'first-blood' },
  { id: 'fifty', branch: 'start', x: 2, y: 0, parent: 'ten' },
  { id: 'two-hundred', branch: 'start', x: 3, y: 0, parent: 'fifty' },
  { id: 'thousand', branch: 'start', x: 4, y: 0, parent: 'two-hundred' },
  { id: 'total-500', branch: 'start', x: 5, y: 0, parent: 'thousand' },
  { id: 'total-2000', branch: 'start', x: 6, y: 0, parent: 'total-500' },
  { id: 'level-5', branch: 'start', x: 1, y: 1, parent: 'ten' },
  { id: 'level-10', branch: 'start', x: 2, y: 1, parent: 'level-5' },
  { id: 'level-25', branch: 'start', x: 3, y: 1, parent: 'level-10' },
  { id: 'level-50', branch: 'start', x: 4, y: 1, parent: 'level-25' },
  { id: 'level-75', branch: 'start', x: 5, y: 1, parent: 'level-50' },
  { id: 'level-100', branch: 'start', x: 6, y: 1, parent: 'level-75' },

  // — 连签 —
  { id: 'streak-3', branch: 'streak', x: 0, y: 0, parent: null },
  { id: 'streak-7', branch: 'streak', x: 1, y: 0, parent: 'streak-3' },
  { id: 'streak-30', branch: 'streak', x: 2, y: 0, parent: 'streak-7' },
  { id: 'streak-100', branch: 'streak', x: 3, y: 0, parent: 'streak-30' },
  { id: 'streak-365', branch: 'streak', x: 4, y: 0, parent: 'streak-100' },
  { id: 'minute-60', branch: 'streak', x: 0, y: 1, parent: 'streak-3' },
  { id: 'minute-500', branch: 'streak', x: 0, y: 2, parent: 'minute-60' },
  { id: 'ten-min-30', branch: 'streak', x: 1, y: 1, parent: 'minute-60' },
  { id: 'hour-24', branch: 'streak', x: 2, y: 1, parent: 'ten-min-30' },
  { id: 'hour-100', branch: 'streak', x: 2, y: 2, parent: 'hour-24' },
  { id: 'six-hour-8', branch: 'streak', x: 3, y: 1, parent: 'hour-24' },
  { id: 'week-52', branch: 'streak', x: 4, y: 1, parent: 'six-hour-8' },
  { id: 'month-12', branch: 'streak', x: 5, y: 1, parent: 'week-52' },
  { id: 'day-30', branch: 'streak', x: 3, y: 3, parent: 'six-hour-8' },
  { id: 'day-365', branch: 'streak', x: 4, y: 3, parent: 'day-30' },
  { id: 'quarter-1', branch: 'streak', x: 4, y: 2, parent: 'six-hour-8' },
  { id: 'quarter-4', branch: 'streak', x: 5, y: 2, parent: 'quarter-1' },
  { id: 'streak-all', branch: 'streak', x: 6, y: 2, parent: 'quarter-4' },

  // — 时钟 —
  { id: 'early-bird', branch: 'clock', x: 0, y: 0, parent: null },
  { id: 'midday', branch: 'clock', x: 1, y: 0, parent: 'early-bird' },
  { id: 'night-owl', branch: 'clock', x: 2, y: 0, parent: 'midday' },
  { id: 'all-day', branch: 'clock', x: 1, y: 1, parent: 'midday' },
  { id: 'all-periods', branch: 'clock', x: 1, y: 2, parent: 'all-day' },
  { id: 'all-periods-10', branch: 'clock', x: 2, y: 2, parent: 'all-periods' },

  // — 财富 —
  { id: 'coin-1k', branch: 'wealth', x: 0, y: 0, parent: null },
  { id: 'gold-1k', branch: 'wealth', x: 1, y: 0, parent: 'coin-1k' },
  { id: 'gold-10k', branch: 'wealth', x: 2, y: 0, parent: 'gold-1k' },
  { id: 'gold-100k', branch: 'wealth', x: 3, y: 0, parent: 'gold-10k' },
  { id: 'gold-1m', branch: 'wealth', x: 4, y: 0, parent: 'gold-100k' },
  { id: 'first-diamond', branch: 'wealth', x: 1, y: 1, parent: 'coin-1k' },
  { id: 'diamond-50', branch: 'wealth', x: 2, y: 1, parent: 'first-diamond' },
  { id: 'diamond-500', branch: 'wealth', x: 3, y: 1, parent: 'diamond-50' },
  { id: 'first-bar', branch: 'wealth', x: 1, y: 2, parent: 'first-diamond' },
  { id: 'bar-20', branch: 'wealth', x: 2, y: 2, parent: 'first-bar' },
  { id: 'bar-100', branch: 'wealth', x: 3, y: 2, parent: 'bar-20' },
  { id: 'all-five', branch: 'wealth', x: 2, y: 3, parent: 'first-bar' },
  { id: 'relic-1', branch: 'wealth', x: 4, y: 3, parent: 'all-five' },
  { id: 'relic-25', branch: 'wealth', x: 5, y: 3, parent: 'relic-1' },
  { id: 'relic-100', branch: 'wealth', x: 6, y: 3, parent: 'relic-25' },

  // — 探索 —
  { id: 'first-trip', branch: 'explore', x: 0, y: 0, parent: null },
  { id: 'trip-10', branch: 'explore', x: 1, y: 0, parent: 'first-trip' },
  { id: 'trip-50', branch: 'explore', x: 2, y: 0, parent: 'trip-10' },
  { id: 'trip-200', branch: 'explore', x: 3, y: 0, parent: 'trip-50' },
  { id: 'trip-500', branch: 'explore', x: 4, y: 0, parent: 'trip-200' },
  { id: 'trip-1000', branch: 'explore', x: 5, y: 0, parent: 'trip-500' },
  { id: 'all-destinations', branch: 'explore', x: 1, y: 1, parent: 'trip-10' },
  { id: 'abyss-1', branch: 'explore', x: 2, y: 1, parent: 'all-destinations' },
  { id: 'abyss-10', branch: 'explore', x: 3, y: 1, parent: 'abyss-1' },
  { id: 'rarity-uncommon', branch: 'explore', x: 1, y: 2, parent: 'first-trip' },
  { id: 'rarity-rare', branch: 'explore', x: 2, y: 2, parent: 'rarity-uncommon' },
  { id: 'rarity-legendary', branch: 'explore', x: 3, y: 2, parent: 'rarity-rare' },
  { id: 'all-tiers', branch: 'explore', x: 4, y: 2, parent: 'rarity-legendary' },

  // — 收集 —
  { id: 'pack-5', branch: 'collect', x: 0, y: 0, parent: null },
  { id: 'pack-20', branch: 'collect', x: 1, y: 0, parent: 'pack-5' },
  { id: 'pack-50', branch: 'collect', x: 2, y: 0, parent: 'pack-20' },
  { id: 'pack-200', branch: 'collect', x: 3, y: 0, parent: 'pack-50' },
  { id: 'unique-6', branch: 'collect', x: 0, y: 1, parent: 'pack-5' },
  { id: 'unique-10', branch: 'collect', x: 1, y: 1, parent: 'unique-6' },
  { id: 'unique-all', branch: 'collect', x: 2, y: 1, parent: 'unique-10' },
  { id: 'unique-13', branch: 'collect', x: 3, y: 1, parent: 'unique-all' },
  { id: 'first-sell', branch: 'collect', x: 0, y: 2, parent: 'pack-5' },
  { id: 'sell-25', branch: 'collect', x: 1, y: 2, parent: 'first-sell' },
  { id: 'sell-100', branch: 'collect', x: 2, y: 2, parent: 'sell-25' },
  { id: 'sell-500', branch: 'collect', x: 3, y: 2, parent: 'sell-100' },
  { id: 'first-use', branch: 'collect', x: 0, y: 3, parent: 'pack-5' },
  { id: 'buff-active', branch: 'collect', x: 1, y: 3, parent: 'first-use' },
  { id: 'buff-3', branch: 'collect', x: 2, y: 3, parent: 'buff-active' },
  { id: 'supply-full', branch: 'collect', x: 0, y: 4, parent: 'first-use' },
  { id: 'supply-cap-40', branch: 'collect', x: 1, y: 4, parent: 'supply-full' },
  { id: 'supply-cap-100', branch: 'collect', x: 2, y: 4, parent: 'supply-cap-40' },
  { id: 'pack-size-80', branch: 'collect', x: 1, y: 5, parent: 'supply-full' },
  { id: 'pack-size-200', branch: 'collect', x: 2, y: 5, parent: 'pack-size-80' },

  // — 生涯 —
  { id: 'first-upgrade', branch: 'life', x: 0, y: 0, parent: null },
  { id: 'ten-upgrades', branch: 'life', x: 1, y: 0, parent: 'first-upgrade' },
  { id: 'thirty-upgrades', branch: 'life', x: 2, y: 0, parent: 'ten-upgrades' },
  { id: 'max-one', branch: 'life', x: 3, y: 0, parent: 'thirty-upgrades' },
  { id: 'max-five', branch: 'life', x: 4, y: 0, parent: 'max-one' },
  { id: 'max-all', branch: 'life', x: 5, y: 0, parent: 'max-five' },
  { id: 'first-chest', branch: 'life', x: 0, y: 1, parent: 'first-upgrade' },
  { id: 'chest-10', branch: 'life', x: 1, y: 1, parent: 'first-chest' },
  { id: 'chest-50', branch: 'life', x: 2, y: 1, parent: 'chest-10' },
  { id: 'chest-200', branch: 'life', x: 3, y: 1, parent: 'chest-50' },
  { id: 'chest-1000', branch: 'life', x: 4, y: 1, parent: 'chest-200' },
  { id: 'chest-5000', branch: 'life', x: 5, y: 1, parent: 'chest-1000' },
  { id: 'chest-diamond', branch: 'life', x: 2, y: 2, parent: 'chest-10' },
  { id: 'perfect-day', branch: 'life', x: 0, y: 2, parent: 'first-upgrade' },
  { id: 'perfect-7', branch: 'life', x: 1, y: 2, parent: 'perfect-day' },
  { id: 'perfect-30', branch: 'life', x: 2, y: 3, parent: 'perfect-7' },
  { id: 'lucky-10', branch: 'life', x: 0, y: 3, parent: 'perfect-day' },
  { id: 'lucky-50', branch: 'life', x: 1, y: 3, parent: 'lucky-10' },
  { id: 'combo-5', branch: 'life', x: 3, y: 3, parent: 'perfect-7' },
  { id: 'offline-1', branch: 'life', x: 0, y: 4, parent: 'lucky-10' },
  { id: 'offline-10', branch: 'life', x: 1, y: 4, parent: 'offline-1' },
  { id: 'offline-100', branch: 'life', x: 2, y: 4, parent: 'offline-10' },
  { id: 'offline-500', branch: 'life', x: 3, y: 4, parent: 'offline-100' },
  { id: 'offline-full', branch: 'life', x: 4, y: 4, parent: 'offline-100' },

  // — 每日任务 / 炼金 / 转生 (new branches) —
  { id: 'quest-1', branch: 'quest', x: 0, y: 0, parent: null },
  { id: 'quest-all', branch: 'quest', x: 1, y: 0, parent: 'quest-1' },
  { id: 'quest-all-10', branch: 'quest', x: 2, y: 0, parent: 'quest-all' },
  { id: 'alchemy-1', branch: 'alchemy', x: 0, y: 0, parent: null },
  { id: 'alchemy-10', branch: 'alchemy', x: 1, y: 0, parent: 'alchemy-1' },
  { id: 'alchemy-100', branch: 'alchemy', x: 2, y: 0, parent: 'alchemy-10' },
  { id: 'alchemy-kinds', branch: 'alchemy', x: 3, y: 0, parent: 'alchemy-100' },
  { id: 'rebirth-1', branch: 'rebirth', x: 0, y: 0, parent: null },
  { id: 'rebirth-5', branch: 'rebirth', x: 1, y: 0, parent: 'rebirth-1' },
  { id: 'rebirth-20', branch: 'rebirth', x: 2, y: 0, parent: 'rebirth-5' },
  { id: 'level-100-rebirth', branch: 'rebirth', x: 3, y: 0, parent: 'rebirth-20' },
  { id: 'star-1', branch: 'rebirth', x: 1, y: 1, parent: 'rebirth-1' },
  { id: 'star-20', branch: 'rebirth', x: 2, y: 1, parent: 'star-1' },

  // — 农场 —
  { id: 'farm-plant-1', branch: 'farm', x: 0, y: 0, parent: null },
  { id: 'farm-tend-1', branch: 'farm', x: 1, y: 0, parent: 'farm-plant-1' },
  { id: 'farm-harvest-1', branch: 'farm', x: 2, y: 0, parent: 'farm-tend-1' },
  { id: 'farm-harvest-50', branch: 'farm', x: 3, y: 0, parent: 'farm-harvest-1' },
  { id: 'farm-harvest-500', branch: 'farm', x: 4, y: 0, parent: 'farm-harvest-50' },
  { id: 'farm-harvest-5000', branch: 'farm', x: 5, y: 0, parent: 'farm-harvest-500' },
  { id: 'farm-tend-50', branch: 'farm', x: 1, y: 1, parent: 'farm-tend-1' },
  { id: 'farm-tend-500', branch: 'farm', x: 2, y: 1, parent: 'farm-tend-50' },
  { id: 'farm-ready-3', branch: 'farm', x: 1, y: 2, parent: 'farm-tend-50' },
  { id: 'farm-kinds-3', branch: 'farm', x: 0, y: 1, parent: 'farm-plant-1' },
  { id: 'farm-kinds-all', branch: 'farm', x: 0, y: 2, parent: 'farm-kinds-3' },
  { id: 'farm-lotus', branch: 'farm', x: 0, y: 3, parent: 'farm-kinds-all' },
  { id: 'farm-full', branch: 'farm', x: 3, y: 1, parent: 'farm-harvest-50' },
  { id: 'farm-plots-12', branch: 'farm', x: 4, y: 1, parent: 'farm-full' },
  { id: 'farm-plots-max', branch: 'farm', x: 5, y: 1, parent: 'farm-plots-12' },
  { id: 'farm-harvest-20000', branch: 'farm', x: 6, y: 0, parent: 'farm-harvest-5000' },
  { id: 'farm-tend-2000', branch: 'farm', x: 3, y: 2, parent: 'farm-tend-500' },
  { id: 'farm-all-ready', branch: 'farm', x: 2, y: 2, parent: 'farm-ready-3' },

  // — 深层里程碑（挂在各自分支的末端）—
  { id: 'total-5000', branch: 'start', x: 7, y: 0, parent: 'total-2000' },
  { id: 'level-200', branch: 'start', x: 7, y: 1, parent: 'level-100' },
  { id: 'streak-500', branch: 'streak', x: 5, y: 0, parent: 'streak-365' },
  { id: 'century', branch: 'start', x: 8, y: 0, parent: 'total-5000' },
  { id: 'gold-10m', branch: 'wealth', x: 5, y: 0, parent: 'gold-1m' },
  { id: 'chest-20000', branch: 'life', x: 6, y: 1, parent: 'chest-5000' },
  { id: 'sell-2000', branch: 'collect', x: 4, y: 2, parent: 'sell-500' },
  { id: 'trip-2000', branch: 'explore', x: 6, y: 0, parent: 'trip-1000' },
  { id: 'alchemy-500', branch: 'alchemy', x: 4, y: 0, parent: 'alchemy-kinds' },
  { id: 'rebirth-50', branch: 'rebirth', x: 4, y: 0, parent: 'rebirth-20' },
  { id: 'star-100', branch: 'rebirth', x: 3, y: 1, parent: 'star-20' },
  { id: 'quest-all-50', branch: 'quest', x: 3, y: 0, parent: 'quest-all-10' },
  { id: 'perfect-100', branch: 'life', x: 4, y: 3, parent: 'perfect-30' },
  { id: 'offline-1000', branch: 'life', x: 5, y: 4, parent: 'offline-500' },
  { id: 'buff-5', branch: 'collect', x: 3, y: 3, parent: 'buff-3' },
  { id: 'pack-size-500', branch: 'collect', x: 3, y: 5, parent: 'pack-size-200' },
  { id: 'supply-cap-200', branch: 'collect', x: 3, y: 4, parent: 'supply-cap-100' },
  { id: 'all-systems', branch: 'life', x: 6, y: 0, parent: 'max-all' },
  { id: 'triple-mastery', branch: 'life', x: 7, y: 0, parent: 'all-systems' },

  // — 设置 —
  { id: 'tinkerer', branch: 'settings', x: 0, y: 0, parent: null },
  { id: 'to-eleven', branch: 'settings', x: 1, y: 0, parent: 'tinkerer' },
  { id: 'minimalist', branch: 'settings', x: 1, y: 1, parent: 'tinkerer' },
  { id: 'unfiltered', branch: 'settings', x: 0, y: 1, parent: 'tinkerer' },

  // — 矿洞 —
  // Laid out as three horizontal chains on separate rows, so every parent sits
  // strictly LEFT of its child and no two nodes share a cell. An earlier pass
  // placed nodes by feel and produced two backwards arrows plus two collisions.
  { id: 'mine-swing-1', branch: 'mine', x: 0, y: 0, parent: null },
  { id: 'mine-break-1', branch: 'mine', x: 1, y: 0, parent: 'mine-swing-1' },
  { id: 'mine-ores-50', branch: 'mine', x: 2, y: 0, parent: 'mine-break-1' },
  { id: 'mine-ores-500', branch: 'mine', x: 3, y: 0, parent: 'mine-ores-50' },
  { id: 'mine-ores-5000', branch: 'mine', x: 4, y: 0, parent: 'mine-ores-500' },
  // Row 1: swinging.
  { id: 'mine-swings-100', branch: 'mine', x: 1, y: 1, parent: 'mine-swing-1' },
  { id: 'mine-swings-1000', branch: 'mine', x: 2, y: 1, parent: 'mine-swings-100' },
  { id: 'mine-stamina-max', branch: 'mine', x: 3, y: 1, parent: 'mine-swings-1000' },
  { id: 'mine-empty-stamina', branch: 'mine', x: 4, y: 1, parent: 'mine-stamina-max' },
  // Row 2: descending, the depth chain.
  { id: 'mine-deep-5', branch: 'mine', x: 1, y: 2, parent: 'mine-break-1' },
  { id: 'mine-deep-10', branch: 'mine', x: 2, y: 2, parent: 'mine-deep-5' },
  { id: 'mine-deep-18', branch: 'mine', x: 3, y: 2, parent: 'mine-deep-10' },
  { id: 'mine-veins-50', branch: 'mine', x: 4, y: 2, parent: 'mine-deep-18' },
  // Row 3: collecting — kinds, the rare find, and hiring.
  { id: 'mine-all-ores', branch: 'mine', x: 2, y: 3, parent: 'mine-deep-10' },
  { id: 'mine-star-gem', branch: 'mine', x: 3, y: 3, parent: 'mine-all-ores' },
  { id: 'mine-hire-1', branch: 'mine', x: 4, y: 3, parent: 'mine-star-gem' },
  { id: 'mine-hire-4', branch: 'mine', x: 5, y: 3, parent: 'mine-hire-1' },
  { id: 'mine-pickaxe-max', branch: 'mine', x: 6, y: 3, parent: 'mine-hire-4' },

  // — 钓鱼 —
  // Same rule as 矿洞: horizontal chains on separate rows, every parent strictly
  // left of its child, no two nodes in one cell.
  { id: 'fish-first', branch: 'fishing', x: 0, y: 0, parent: null },
  { id: 'fish-10', branch: 'fishing', x: 1, y: 0, parent: 'fish-first' },
  { id: 'fish-50', branch: 'fishing', x: 2, y: 0, parent: 'fish-10' },
  { id: 'fish-200', branch: 'fishing', x: 3, y: 0, parent: 'fish-50' },
  { id: 'fish-1000', branch: 'fishing', x: 4, y: 0, parent: 'fish-200' },
  { id: 'fish-kinds-5', branch: 'fishing', x: 1, y: 1, parent: 'fish-first' },
  { id: 'fish-kinds-all', branch: 'fishing', x: 2, y: 1, parent: 'fish-kinds-5' },
  { id: 'fish-rare', branch: 'fishing', x: 3, y: 1, parent: 'fish-kinds-all' },
  { id: 'fish-legend', branch: 'fishing', x: 4, y: 1, parent: 'fish-rare' },
  { id: 'fish-miss-10', branch: 'fishing', x: 0, y: 2, parent: 'fish-first' },
  { id: 'fish-rod-3', branch: 'fishing', x: 1, y: 2, parent: 'fish-miss-10' },
  { id: 'fish-rod-max', branch: 'fishing', x: 2, y: 2, parent: 'fish-rod-3' },
  { id: 'fish-spot-all', branch: 'fishing', x: 3, y: 2, parent: 'fish-rod-max' },
  { id: 'fish-sea', branch: 'fishing', x: 4, y: 2, parent: 'fish-spot-all' },

  // — 开店 —
  // The mode fork is the first row: both branches hang off 开张, the one node
  // every shop run passes through.
  { id: 'shop-pick', branch: 'shop', x: 0, y: 0, parent: null },
  { id: 'shop-auto', branch: 'shop', x: 0, y: 1, parent: 'shop-pick' },
  { id: 'shop-manual', branch: 'shop', x: 0, y: 2, parent: 'shop-pick' },
  { id: 'shop-machine-1', branch: 'shop', x: 1, y: 1, parent: 'shop-auto' },
  { id: 'shop-machine-all', branch: 'shop', x: 2, y: 1, parent: 'shop-machine-1' },
  { id: 'shop-auto-500', branch: 'shop', x: 3, y: 1, parent: 'shop-machine-all' },
  { id: 'shop-streak-10', branch: 'shop', x: 1, y: 2, parent: 'shop-manual' },
  { id: 'shop-streak-40', branch: 'shop', x: 2, y: 2, parent: 'shop-streak-10' },
  { id: 'shop-manual-100', branch: 'shop', x: 3, y: 2, parent: 'shop-streak-40' },
  { id: 'shop-sale-1', branch: 'shop', x: 1, y: 0, parent: 'shop-pick' },
  { id: 'shop-sale-25', branch: 'shop', x: 2, y: 0, parent: 'shop-sale-1' },
  { id: 'shop-sale-100', branch: 'shop', x: 3, y: 0, parent: 'shop-sale-25' },
  { id: 'shop-sale-1000', branch: 'shop', x: 4, y: 0, parent: 'shop-sale-100' },
  { id: 'shop-all-products', branch: 'shop', x: 5, y: 0, parent: 'shop-sale-1000' },
  { id: 'shop-rep-50', branch: 'shop', x: 4, y: 3, parent: 'shop-sale-100' },
  { id: 'shop-rep-200', branch: 'shop', x: 5, y: 3, parent: 'shop-rep-50' },
  { id: 'shop-rep-800', branch: 'shop', x: 6, y: 3, parent: 'shop-rep-200' },
  { id: 'shop-rep-3000', branch: 'shop', x: 7, y: 3, parent: 'shop-rep-800' },
]

const LAYOUT_BY_ID = new Map(ACHIEVEMENT_LAYOUT.map((entry) => [entry.id, entry]))

/**
 * Band offsets, so the seven branches occupy seven separate horizontal strips.
 *
 * This exists because of a bug that made the tree look broken: every branch was
 * authored with its own origin at `(0,0)`, but the client draws all branches in
 * ONE coordinate space. So all seven "first" nodes landed in the same cell, with
 * the last one drawn painted over the rest — the graph was an unreadable pile and
 * there was almost nothing to pan to.
 *
 * The layout table deliberately keeps BRANCH-LOCAL coordinates (each branch reads
 * as a small self-contained tree) and this table supplies the global offset, so
 * adding a node never requires touching an offset by hand.
 */
const BRANCH_GAP_Y = 2

const BRANCH_BANDS = (() => {
  let cursorY = 0
  let maxRight = 0
  const bands = new Map()
  for (const branch of ACHIEVEMENT_BRANCHES) {
    const nodes = ACHIEVEMENT_LAYOUT.filter((node) => node.branch === branch.id)
    if (nodes.length === 0) {
      bands.set(branch.id, { offsetX: 0, offsetY: cursorY, width: 0, height: 0 })
      continue
    }
    const right = Math.max(...nodes.map((node) => node.x)) + 1
    const bottom = Math.max(...nodes.map((node) => node.y)) + 1
    bands.set(branch.id, { offsetX: 0, offsetY: cursorY, width: right, height: bottom })
    maxRight = Math.max(maxRight, right)
    cursorY += bottom + BRANCH_GAP_Y
  }
  return { bands, width: maxRight, height: Math.max(0, cursorY - BRANCH_GAP_Y) }
})()

/** One layout node in GLOBAL canvas coordinates (band offset applied). */
function globalNode(node) {
  const band = BRANCH_BANDS.bands.get(node.branch) ?? { offsetX: 0, offsetY: 0 }
  return { ...node, x: node.x + band.offsetX, y: node.y + band.offsetY }
}

/** Every node in global coordinates. */
const GLOBAL_LAYOUT = ACHIEVEMENT_LAYOUT.map(globalNode)

/**
 * Band geometry and the global layout, exported for the test suite.
 *
 * The tree layout is hand-authored, and the failure mode when it is wrong is
 * SILENT: an achievement with no node, or two nodes in one cell, produces a graph
 * that merely looks odd. The tests are the only guard, so they need the same
 * numbers the snapshot serves.
 */
export { BRANCH_BANDS, GLOBAL_LAYOUT, globalNode }

// ── valuation ───────────────────────────────────────────────────────────────

/**
 * Gold-equivalent value of one unit of each currency.
 *
 * This is a **display heuristic for the codex**, not an exchange the game
 * performs — nothing can be converted. It exists so "which destination pays
 * best" can be answered with one number instead of five. The rates are anchored
 * to real prices in the shop and the chest table:
 *
 *   · the silver chest costs 400 gold and pays up to 380 gold per roll, so gold
 *     is the unit;
 *   · the iron chest costs 15 铁锭 and sits between the wood chest (150 coin)
 *     and the silver chest, which prices one ingot at roughly 5 gold;
 *   · the gold chest costs 1500 gold + 2 diamonds, which puts a diamond in the
 *     low hundreds;
 *   · the diamond chest costs 12 diamonds, which puts a bar in the thousands.
 */
export const VALUATION = {
  xp: 0.2,
  coin: 0.05,
  // 铁锭 anchors to the iron chest's price: 15 ingots buy a box positioned
  // halfway between the wood and silver chests, so ~5 gold per ingot.
  iron: 5,
  gold: 1,
  diamond: 300,
  bar: 3000,
  relic: 8000,
}

/** Convert a `{ currency: amount }` map into one gold-equivalent number. */
function valueInGold(map) {
  let total = 0
  for (const [key, amount] of Object.entries(map ?? {})) {
    total += (VALUATION[key] ?? 0) * amount
  }
  return total
}

/**
 * Nominal gold value of a non-sellable item.
 *
 * A buff is worth roughly what it would cost to buy its effect with chests, and
 * a supply restore is worth the trips it saves. These are deliberately round
 * numbers: they exist to make the codex's "best route" comparison include the
 * items that cannot be sold, not to imply a real exchange rate.
 */
const BUFF_VALUE = { charm: 220, seal: 900 }
const SUPPLY_VALUE_PER_POINT = 55

/** What one unit of an item is worth, in gold-equivalent, for the codex. */
function itemValue(item) {
  if (item.kind === 'sell') return valueInGold(item.sellFor)
  if (item.kind === 'supply') return (item.supply ?? 0) * SUPPLY_VALUE_PER_POINT
  return BUFF_VALUE[item.id] ?? 0
}

/**
 * Expected payout of one trip to a destination.
 *
 * Computed the same way the roll actually works — tier first, then item — so the
 * codex's numbers describe the real loot path rather than an average of the raw
 * table. The `shift` must be the same one `rollItem` would receive.
 */
function expectedTrip(destination, shift) {
  // Rebuild the tier weights exactly as rollItem does.
  const entries = []
  for (const tier of RARITY_ORDER) {
    const pool = ITEMS_BY_RARITY.get(tier)
    if (pool === undefined) continue
    const base = destination.table[tier] ?? 0
    const index = RARITY_ORDER.indexOf(tier)
    const factor = Math.max(0.05, 1 + shift * (index - 1) * 0.34)
    const weight = base * factor
    if (weight > 0) entries.push({ tier, weight })
  }
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0)

  const [minDrops, maxDrops] = destination.drops
  const expectedDrops = (minDrops + maxDrops) / 2

  // For each tier: its probability, and the mean value of an item inside it.
  const tiers = entries.map((entry) => {
    const pool = ITEMS_BY_RARITY.get(entry.tier)
    const meanValue = pool.reduce((sum, item) => sum + itemValue(item), 0) / pool.length
    return {
      tier: entry.tier,
      probability: totalWeight === 0 ? 0 : entry.weight / totalWeight,
      meanValue,
      itemCount: pool.length,
    }
  })

  const valuePerDrop = tiers.reduce((sum, entry) => sum + entry.probability * entry.meanValue, 0)
  const total = valuePerDrop * expectedDrops

  return {
    expectedDrops,
    expectedValue: total,
    tiers,
    /** Odds of at least one rare-or-better drop per trip. */
    rareChance: Math.max(
      0,
      1 - Math.pow(1 - tiers.filter((t) => t.tier === 'rare' || t.tier === 'legendary').reduce((s, t) => s + t.probability, 0), expectedDrops),
    ),
  }
}

// ── the shop ────────────────────────────────────────────────────────────────

/**
 * Permanent upgrades.
 *
 * A price is declared as `{ currency, base, growth }`, so the cost of any level
 * is a pure function: the client renders the next price without asking, and the
 * host charges exactly the number it showed.
 *
 * The set is built around one loop — yields make check-ins worth more, luck
 * makes chests worth opening, and the offline pair makes *leaving* worth
 * something. That last one is what turns a checklist into a game.
 */
export const UPGRADES = [
  {
    id: 'minuteYield',
    label: '分针齿轮',
    desc: '每分钟签到的奖励提高 12%',
    max: 20,
    cost: { currency: 'coin', base: 40, growth: 1.55 },
    effect: 'yield',
    period: 'minute',
    step: 0.12,
    accent: '--dsw-alias-state-idle-primary',
  },
  {
    id: 'hourYield',
    label: '时针发条',
    desc: '每小时签到的奖励提高 12%',
    max: 20,
    cost: { currency: 'gold', base: 80, growth: 1.55 },
    effect: 'yield',
    period: 'hour',
    step: 0.12,
    accent: '--dsw-alias-state-business-primary',
  },
  {
    id: 'dayYield',
    label: '日历刻痕',
    desc: '每日签到的奖励提高 12%',
    max: 20,
    cost: { currency: 'gold', base: 220, growth: 1.55 },
    effect: 'yield',
    period: 'day',
    step: 0.12,
    accent: '--dsw-alias-state-warn-primary',
  },
  {
    id: 'weekYield',
    label: '周而复始',
    desc: '每周签到的奖励提高 15%',
    max: 15,
    cost: { currency: 'diamond', base: 2, growth: 1.7 },
    effect: 'yield',
    period: 'week',
    step: 0.15,
    accent: '--dsw-alias-link',
  },
  {
    id: 'monthYield',
    label: '月相仪',
    desc: '每月签到的奖励提高 20%',
    max: 12,
    cost: { currency: 'diamond', base: 5, growth: 1.75 },
    effect: 'yield',
    period: 'month',
    step: 0.2,
    accent: '--dsw-alias-state-success-primary',
  },
  {
    id: 'luck',
    label: '幸运护符',
    desc: '签到额外掉落概率 +2%',
    max: 15,
    cost: { currency: 'gold', base: 300, growth: 1.65 },
    effect: 'luck',
    step: 0.02,
    accent: '--dsw-alias-state-warn-primary',
  },
  {
    id: 'streakGuard',
    label: '续签契约',
    desc: '间隔周期可多容忍 1 个错过的槽位',
    max: 3,
    cost: { currency: 'diamond', base: 8, growth: 2 },
    effect: 'grace',
    step: 1,
    accent: '--dsw-alias-state-business-primary',
  },
  {
    id: 'offlineRate',
    label: '静默引擎',
    desc: '离线收益速率 +25%',
    max: 20,
    cost: { currency: 'gold', base: 150, growth: 1.6 },
    effect: 'offlineRate',
    step: 0.25,
    accent: '--dsw-alias-link',
  },
  {
    id: 'offlineCap',
    label: '蓄水池',
    desc: '离线收益上限 +2 小时',
    max: 20,
    cost: { currency: 'gold', base: 200, growth: 1.6 },
    effect: 'offlineCap',
    step: 2,
    accent: '--dsw-alias-state-idle-primary',
  },
  // — expedition upgrades —
  {
    id: 'supplyCap',
    label: '行囊',
    desc: '物资上限 +4',
    max: 15,
    cost: { currency: 'gold', base: 260, growth: 1.6 },
    effect: 'supplyCap',
    step: 4,
    accent: '--dsw-alias-state-success-primary',
  },
  {
    id: 'packSize',
    label: '背包扩容',
    desc: '背包容量 +6 格',
    max: 12,
    cost: { currency: 'gold', base: 400, growth: 1.62 },
    effect: 'packSize',
    step: 6,
    accent: '--dsw-alias-state-business-primary',
  },
  // 铁骨行囊 is the second 铁锭 SINK, and the cheaper of the two: iron is what
  // a run accumulates by showing up, so spending it on capacity trades the
  // mid-game currency for headroom the trip economy immediately pays back.
  // Same effect as 背包扩容 — modifiers() adds both, so gold and iron both
  // widen the pack instead of competing for the same slot.
  {
    id: 'ironFrame',
    label: '铁骨行囊',
    desc: '背包容量 +8 格',
    max: 10,
    cost: { currency: 'iron', base: 10, growth: 1.55 },
    effect: 'packSize',
    step: 8,
    accent: '--dsw-alias-label-secondary',
  },
  {
    id: 'swift',
    label: '快靴',
    desc: '出门耗时 -6%',
    max: 10,
    cost: { currency: 'diamond', base: 4, growth: 1.7 },
    effect: 'swift',
    step: 0.06,
    accent: '--dsw-alias-link',
  },
  {
    id: 'fortune',
    label: '寻宝罗盘',
    desc: '寻宝品质提升（更容易出稀有）',
    max: 12,
    cost: { currency: 'diamond', base: 6, growth: 1.68 },
    effect: 'fortune',
    step: 1,
    accent: '--dsw-alias-state-error-primary',
  },
  {
    id: 'haggle',
    label: '议价术',
    desc: '卖出物品所得 +15%',
    max: 15,
    cost: { currency: 'gold', base: 500, growth: 1.6 },
    effect: 'haggle',
    step: 0.15,
    accent: '--dsw-alias-state-warn-primary',
  },
  {
    id: 'thrift',
    label: '节俭',
    desc: '出门消耗物资 -1（最少 1）',
    max: 4,
    cost: { currency: 'diamond', base: 12, growth: 1.8 },
    effect: 'thrift',
    step: 1,
    accent: '--dsw-alias-state-success-primary',
  },
]

const UPGRADE_BY_ID = new Map(UPGRADES.map((entry) => [entry.id, entry]))

// ── expeditions ─────────────────────────────────────────────────────────────

/**
 * Supplies: the consumable an expedition spends.
 *
 * Supplies exist so that going out has a cost that is not simply "wait". They
 * refill in two ways — slowly by themselves (so the game never dead-ends) and
 * quickly from certain items found while out — which is what makes the shop's
 * supply-capacity upgrade and the "补充物资" items both worth having.
 */
export const SUPPLY_MAX_BASE = 12
const SUPPLY_REGEN_MS = 20 * 60_000

/** Backpack slots before the 背包扩容 upgrade. */
const PACK_SIZE_BASE = 20

/**
 * Items: what an expedition can bring home.
 *
 * Three kinds, because they answer three different questions:
 *   · `sell`   — converts a find into a currency (the money path)
 *   · `supply` — restores supplies (the sustain path)
 *   · `buff`   — grants a timed bonus (the investment path)
 *
 * `sellFor` is the base price; the 议价 upgrade multiplies it. Keeping the price
 * on the item rather than on the destination means the same item is worth the
 * same everywhere.
 */
export const ITEMS = [
  // — sell: common finds —
  {
    id: 'shell',
    label: '海螺',
    desc: '普通的贝壳，海边随处可见。',
    kind: 'sell',
    rarity: 'common',
    sellFor: { coin: 60 },
    accent: '--dsw-alias-state-idle-primary',
    glyph: '◍',
  },
  {
    id: 'ore',
    label: '矿石',
    desc: '沉甸甸的一块，能换不少金币。',
    kind: 'sell',
    rarity: 'common',
    sellFor: { gold: 90 },
    accent: '--dsw-alias-state-business-primary',
    glyph: '▲',
  },
  {
    id: 'herb',
    label: '药草',
    desc: '气味清苦，嚼下去立刻精神起来。',
    kind: 'supply',
    rarity: 'common',
    supply: 4,
    accent: '--dsw-alias-state-success-primary',
    glyph: '❦',
  },
  {
    id: 'coin-pouch',
    label: '钱袋',
    desc: '不知是谁掉的，鼓鼓囊囊。',
    kind: 'sell',
    rarity: 'common',
    sellFor: { coin: 140 },
    accent: '--dsw-alias-state-idle-primary',
    glyph: '❍',
  },
  // — uncommon —
  {
    id: 'silver-figurine',
    label: '银像',
    desc: '做工精细的小雕像，收藏家会喜欢。',
    kind: 'sell',
    rarity: 'uncommon',
    sellFor: { gold: 320 },
    accent: '--dsw-alias-label-secondary',
    glyph: '♜',
  },
  {
    id: 'provision',
    label: '干粮',
    desc: '耐放的食物，能补一大截物资。',
    kind: 'supply',
    rarity: 'uncommon',
    supply: 8,
    accent: '--dsw-alias-state-success-primary',
    glyph: '▤',
  },
  {
    id: 'charm',
    label: '护身符',
    desc: '戴上后一段时间内运气特别好。',
    kind: 'buff',
    rarity: 'uncommon',
    buff: { id: 'luck', label: '好运', stat: 'luck', amount: 0.15, ms: 30 * 60_000 },
    accent: '--dsw-alias-state-warn-primary',
    glyph: '✚',
  },
  // — rare —
  {
    id: 'gold-idol',
    label: '金神像',
    desc: '沉得压手。卖掉能换一大笔。',
    kind: 'sell',
    rarity: 'rare',
    sellFor: { gold: 1500, diamond: 3 },
    accent: '--dsw-alias-state-warn-primary',
    glyph: '☗',
  },
  {
    id: 'relic-shard',
    label: '遗物碎片',
    desc: '来自某个更古老的时代。',
    kind: 'sell',
    rarity: 'rare',
    sellFor: { relic: 1 },
    accent: '--dsw-alias-state-error-primary',
    glyph: '✧',
  },
  {
    id: 'elixir',
    label: '灵药',
    desc: '一口下去，物资全满。',
    kind: 'supply',
    rarity: 'rare',
    supply: 99,
    accent: '--dsw-alias-state-success-primary',
    glyph: '❖',
  },
  {
    id: 'seal',
    label: '远征印记',
    desc: '一段时间内寻宝收获明显变好。',
    kind: 'buff',
    rarity: 'rare',
    buff: { id: 'fortune', label: '远征收成', stat: 'fortune', amount: 0.5, ms: 60 * 60_000 },
    accent: '--dsw-alias-link',
    glyph: '◈',
  },
  // — legendary —
  {
    id: 'crown',
    label: '古冠',
    desc: '传说中的东西。你居然找到了。',
    kind: 'sell',
    rarity: 'legendary',
    sellFor: { gold: 8000, diamond: 20, relic: 4 },
    accent: '--dsw-alias-state-error-primary',
    glyph: '♛',
  },
  {
    id: 'relic-core',
    label: '遗物核心',
    desc: '仍在微微发热。卖价极高。',
    kind: 'sell',
    rarity: 'legendary',
    sellFor: { relic: 10 },
    accent: '--dsw-alias-state-error-primary',
    glyph: '❂',
  },
]

// ── the farm ────────────────────────────────────────────────────────────────

/**
 * Crops you can plant.
 *
 * `seed` is the price of one planting, `needMs` is how long a well-tended plot
 * takes, and `yield` is what a harvest gives. `tier` drives presentation only.
 *
 * The economy is deliberately NOT a money printer: a harvest sells for a bit more
 * than the seed cost, so the profit comes from *time and attention* rather than
 * from the seed. Longer crops pay better per plant but worse per hour, which is
 * the honest trade — you are paying for not having to come back.
 */
export const CROPS = [
  {
    id: 'radish',
    label: '小萝卜',
    desc: '长得快，几乎不用管。适合刚开始种地。',
    seed: { coin: 20 },
    needMs: 5 * 60_000,
    yield: { item: 'radish', min: 2, max: 4 },
    tier: 'common',
    accent: '--dsw-alias-state-idle-primary',
    glyph: '❧',
  },
  {
    id: 'wheat',
    label: '小麦',
    desc: '磨成面粉能卖不少。',
    seed: { coin: 70 },
    needMs: 20 * 60_000,
    yield: { item: 'wheat', min: 2, max: 5 },
    tier: 'common',
    accent: '--dsw-alias-state-warn-primary',
    glyph: '⌇',
  },
  {
    id: 'pumpkin',
    label: '南瓜',
    desc: '占地方，但一个顶一堆。',
    seed: { gold: 45 },
    needMs: 60 * 60_000,
    yield: { item: 'pumpkin', min: 1, max: 3 },
    tier: 'uncommon',
    accent: '--dsw-alias-state-warn-primary',
    glyph: '◉',
  },
  {
    id: 'grape',
    label: '葡萄',
    desc: '成串地长，收一次很值。',
    seed: { gold: 160 },
    needMs: 3 * 3_600_000,
    yield: { item: 'grape', min: 2, max: 4 },
    tier: 'uncommon',
    accent: '--dsw-alias-link',
    glyph: '⁘',
  },
  {
    id: 'ginseng',
    label: '人参',
    desc: '长得很慢，但挖出来就是钱。',
    seed: { diamond: 4 },
    needMs: 8 * 3_600_000,
    yield: { item: 'ginseng', min: 1, max: 2 },
    tier: 'rare',
    accent: '--dsw-alias-state-success-primary',
    glyph: '⑂',
  },
  {
    id: 'lotus',
    label: '灵莲',
    desc: '传说中一夜开一次。有耐心的人才种得起。',
    seed: { diamond: 12 },
    needMs: 24 * 3_600_000,
    yield: { item: 'lotus', min: 1, max: 2 },
    tier: 'legendary',
    accent: '--dsw-alias-state-error-primary',
    glyph: '✿',
  },
]

const CROP_BY_ID = new Map(CROPS.map((entry) => [entry.id, entry]))

/**
 * What a harvest produces.
 *
 * Kept in a SEPARATE table from `ITEMS` on purpose: `ITEMS` is the expedition
 * loot pool, and `ITEMS_BY_RARITY` is built from it. Folding crops into `ITEMS`
 * would make 灵莲 turn up in the abyss and would inflate the expedition codex —
 * so the two pools stay apart and only the BACKPACK sees their union.
 *
 * PRICES ARE BALANCED AGAINST SEED COST, not picked for flavour. Each crop
 * returns roughly 1.5×-3× its seed in gold-equivalent per plant, and the
 * multiplier RISES with the crop's duration — never falls. An earlier pass had
 * 人参 at 1.5× and 灵莲 at 9.4×, which made 人参 strictly worse than everything
 * around it: a trap, not a choice. `test-farm.mjs` asserts the curve stays
 * monotonic so a future rebalance cannot reintroduce that.
 */
export const FARM_PRODUCE = [
  { id: 'radish', label: '萝卜', desc: '自己地里拔的，带着土。', kind: 'sell', rarity: 'common', sellFor: { coin: 13 }, accent: '--dsw-alias-state-idle-primary', glyph: '❧' },
  { id: 'wheat', label: '小麦', desc: '饱满的一把，能磨面。', kind: 'sell', rarity: 'common', sellFor: { coin: 52 }, accent: '--dsw-alias-state-warn-primary', glyph: '⌇' },
  { id: 'pumpkin', label: '南瓜', desc: '沉甸甸的，一个能顶一顿。', kind: 'sell', rarity: 'uncommon', sellFor: { gold: 74 }, accent: '--dsw-alias-state-warn-primary', glyph: '◉' },
  { id: 'grape', label: '葡萄', desc: '成串的，甜得发腻。', kind: 'sell', rarity: 'uncommon', sellFor: { gold: 235 }, accent: '--dsw-alias-link', glyph: '⁘' },
  { id: 'ginseng', label: '人参', desc: '须根完整，行家会出高价。', kind: 'sell', rarity: 'rare', sellFor: { diamond: 15 }, accent: '--dsw-alias-state-success-primary', glyph: '⑂' },
  { id: 'lotus', label: '灵莲', desc: '摘下来的时候还在发光。', kind: 'sell', rarity: 'legendary', sellFor: { diamond: 64, relic: 1 }, accent: '--dsw-alias-state-error-primary', glyph: '✿' },
]

/**
 * Everything that can sit in the backpack: expedition finds plus farm produce.
 *
 * `ITEMS` remains the expedition loot pool; this union is what the pack, the
 * seller and the codex use. Keeping them distinct is what stops a harvested
 * 萝卜 from being rolled as dungeon loot.
 */
export const ALL_ITEMS = [...ITEMS, ...FARM_PRODUCE]

const ALL_ITEM_BY_ID = new Map(ALL_ITEMS.map((entry) => [entry.id, entry]))

/**
 * Rebuild the item lookup from `ALL_ITEMS`.
 *
 * Needed because ores join the union LATER (declaration order forces it), and a
 * single shared map is what keeps every lookup — pack, sell, use, alchemy —
 * agreeing about which ids exist.
 */
function rebuildAllItems() {
  ALL_ITEM_BY_ID.clear()
  for (const entry of ALL_ITEMS) ALL_ITEM_BY_ID.set(entry.id, entry)
}

const PRODUCE_BY_ID = new Map(FARM_PRODUCE.map((entry) => [entry.id, entry]))

// ── mining ──────────────────────────────────────────────────────────────────

/**
 * Ores, mined by depth.
 * `depth` is the minimum layer that can yield them, so the deeper the shaft the
 * better the mix. Prices are ANCHORED to the expedition economy rather than
 * invented: a 钻石 goes for 1 each from the gold chest's guaranteed drop, and the
 * diamond chest costs 12 of them — so a few hundred gold for a stone that might
 * hold one is the right order of magnitude.
 *
 * `chance` is relative weight inside its own layer; `perSwing` is how much one
 * swing takes out of the rock, which is what makes a pickaxe upgrade matter.
 */
export const ORES = [
  { id: 'stone', label: '石头', desc: '普普通通，但总能卖点钱。', kind: 'sell', rarity: 'common', sellFor: { coin: 8 }, accent: '--dsw-alias-label-secondary', glyph: '▪', depth: 1, chance: 40, perSwing: 10 },
  { id: 'copper', label: '铜矿', desc: '发红的纹理。', kind: 'sell', rarity: 'common', sellFor: { coin: 26 }, accent: '--dsw-alias-state-warn-primary', glyph: '▫', depth: 1, chance: 26, perSwing: 9 },
  { id: 'coal', label: '煤矿', desc: '黑得发亮。', kind: 'sell', rarity: 'common', sellFor: { coin: 48 }, accent: '--dsw-alias-label-primary', glyph: '⬤', depth: 2, chance: 22, perSwing: 8 },
  { id: 'iron', label: '铁矿', desc: '一把锤子能解决的问题。', kind: 'sell', rarity: 'uncommon', sellFor: { gold: 40 }, accent: '--dsw-alias-state-idle-primary', glyph: '▬', depth: 3, chance: 18, perSwing: 7 },
  { id: 'silver', label: '银矿', desc: '月光一样的颜色。', kind: 'sell', rarity: 'uncommon', sellFor: { gold: 160 }, accent: '--dsw-alias-label-secondary', glyph: '▭', depth: 5, chance: 14, perSwing: 6 },
  { id: 'gold-ore', label: '金矿', desc: '沉甸甸的一块。', kind: 'sell', rarity: 'uncommon', sellFor: { gold: 420 }, accent: '--dsw-alias-state-warn-primary', glyph: '◆', depth: 7, chance: 12, perSwing: 5 },
  { id: 'crystal', label: '水晶', desc: '对着光会转出彩虹。', kind: 'sell', rarity: 'rare', sellFor: { diamond: 3 }, accent: '--dsw-alias-link', glyph: '◈', depth: 9, chance: 10, perSwing: 4 },
  { id: 'mithril', label: '秘银矿', desc: '传说是从星星上掉下来的。', kind: 'sell', rarity: 'rare', sellFor: { diamond: 12, gold: 900 }, accent: '--dsw-alias-link', glyph: '❖', depth: 12, chance: 8, perSwing: 3 },
  { id: 'dark-ore', label: '暗矿', desc: '光线到它就没了。', kind: 'sell', rarity: 'rare', sellFor: { diamond: 30 }, accent: '--dsw-alias-state-error-primary', glyph: '◉', depth: 15, chance: 7, perSwing: 2 },
  { id: 'star-gem', label: '星石', desc: '挖到它的时候整个矿洞都在响。', kind: 'sell', rarity: 'legendary', sellFor: { diamond: 80, relic: 2 }, accent: '--dsw-alias-state-error-primary', glyph: '✦', depth: 18, chance: 5, perSwing: 1 },
]

/** How deep the shaft goes, and the width of each label band. */
export const MINE_DEPTH_MAX = 20

/**
 * Depth bands, for display only.
 *
 * The engine works in whole layers; these names exist so the UI can say "你在第 9 层" instead of a bare number.
 */
export const MINE_BANDS = [
  { from: 1, to: 2, label: '表层', accent: '--dsw-alias-label-secondary' },
  { from: 3, to: 5, label: '浅层', accent: '--dsw-alias-state-idle-primary' },
  { from: 6, to: 9, label: '中层', accent: '--dsw-alias-state-business-primary' },
  { from: 10, to: 13, label: '深层', accent: '--dsw-alias-state-warn-primary' },
  { from: 14, to: 17, label: '岩核', accent: '--dsw-alias-link' },
  { from: 18, to: 20, label: '渊底', accent: '--dsw-alias-state-error-primary' },
]

/** Stamina: the resource that keeps mining a DECISION rather than a reflex. */
export const STAMINA_MAX_BASE = 20
const STAMINA_REGEN_MS = 6 * 60_000
/** Cost per swing, and the deepest layer that cost stays flat for. */
export const SWING_STAMINA = 1

/**
 * Miner upgrades, bought with 金币.
 *
 * `pickaxe` is the interesting one: it reduces the swings a rock needs, which is
 * the same as raising ore per unit stamina. Depth, capacity and auto-collect are
 * pure convenience.
 */
export const MINER_UPGRADES = [
  { id: 'pickaxe', label: '铁镐', desc: '每镐多凿下一点岩石（+2）', max: 15, cost: { gold: 90 }, growth: 1.5, effect: 'pickaxe', step: 2, accent: '--dsw-alias-state-idle-primary' },
  { id: 'depth', label: '凿岩机', desc: '可下潜 +1 层', max: 19, cost: { gold: 150 }, growth: 1.42, effect: 'depth', step: 1, accent: '--dsw-alias-state-warn-primary' },
  { id: 'packSize', label: '矿袋', desc: '矿石背包容量 +4', max: 10, cost: { gold: 120 }, growth: 1.55, effect: 'packSize', step: 4, accent: '--dsw-alias-state-success-primary' },
  { id: 'stamina', label: '强身', desc: '体力上限 +2', max: 15, cost: { gold: 110 }, growth: 1.5, effect: 'stamina', step: 2, accent: '--dsw-alias-state-business-primary' },
]

const MINER_UPGRADE_BY_ID = new Map(MINER_UPGRADES.map((entry) => [entry.id, entry]))

/** Ores grouped for the drop roll, mirroring how farm produce is registered. */
const ORE_BY_ID = new Map(ORES.map((entry) => [entry.id, entry]))

/**
 * 矿工 — the idle half of mining.
 *
 * A miner works while you are away and pours finds into a local buffer, capped by
 * 矿袋 capacity. The buffer is NOT the item pack: it holds raw ore sums, so a
 * night's mining cannot overflow the trade pack and push out harvested crops.
 *
 * `hireCost` and `wagePerHour` are both in 金币, and the wage is charged on
 * COLLECTION rather than continuously — so letting a miner run for a week and
 * never collecting costs nothing upfront, and the payment happens at the moment
 * of profit. That is the only order that makes idle income feel fair.
 */
export const MINERS = [
  { id: 'apprentice', label: '学徒矿工', desc: '手很生，但不要钱。', hireCost: { gold: 400 }, wagePerHour: { gold: 30 }, perHour: 1.2, depth: 1, accent: '--dsw-alias-state-idle-primary' },
  { id: 'hand', label: '老练矿工', desc: '一天能凿穿两层。', hireCost: { gold: 1_600 }, wagePerHour: { gold: 110 }, perHour: 2.0, depth: 4, accent: '--dsw-alias-state-business-primary' },
  { id: 'foreman', label: '矿工头', desc: '他带的人都能挤出油水。', hireCost: { gold: 6_000 }, wagePerHour: { gold: 380 }, perHour: 3.4, depth: 8, accent: '--dsw-alias-state-warn-primary' },
  { id: 'master', label: '矿脉大师', desc: '听得见石头在说什么。', hireCost: { diamond: 30 }, wagePerHour: { diamond: 2 }, perHour: 5.5, depth: 13, accent: '--dsw-alias-link' },
]

const MINER_BY_ID = new Map(MINERS.map((entry) => [entry.id, entry]))

// ── fishing ─────────────────────────────────────────────────────────────────

/**
 * 钓鱼 — the timing game.
 *
 * Every other system is either "wait" (签到/农场/出门) or "spend a resource"
 * (挖矿's stamina). 钓鱼 is the first one about TIMING: you cast, something bites
 * after a delay you cannot measure, and a short window opens. That makes it the
 * one activity that is more fun WITH attention rather than less, which is why it
 * earns its own tab.
 *
 * The three numbers that matter:
 *   · `biteMs`   — how long the float sits before a bite, randomised per cast so
 *                  the click cannot be pre-timed.
 *   · the window  — FISH_WINDOW_MS plus the rod's bonus. Short on purpose: the
 *                  strike must be ANTICIPATED, not merely reacted to.
 *   · `cooldown`  — after a cast resolves, landed or not.
 */
export const FISH = [
  { id: 'minnow', label: '小鲫鱼', desc: '巴掌大，钓上来还在蹦。', rarity: 'common', sellFor: { coin: 12 }, accent: '--dsw-alias-label-secondary', glyph: '◌', w: 34, biteMs: [900, 2000] },
  { id: 'carp', label: '鲤鱼', desc: '鳞片泛着金光。', rarity: 'common', sellFor: { coin: 34 }, accent: '--dsw-alias-state-warn-primary', glyph: '◍', w: 26, biteMs: [1100, 2400] },
  { id: 'catfish', label: '鲶鱼', desc: '有两根须，滑得很。', rarity: 'common', sellFor: { coin: 58 }, accent: '--dsw-alias-label-primary', glyph: '◑', w: 18, biteMs: [1400, 3000] },
  { id: 'bass', label: '鲈鱼', desc: '成群的时候最好钓。', rarity: 'uncommon', sellFor: { gold: 46 }, accent: '--dsw-alias-state-business-primary', glyph: '◒', w: 12, biteMs: [1600, 3200] },
  { id: 'eel', label: '鳗鱼', desc: '一整条拧成 S 形。', rarity: 'uncommon', sellFor: { gold: 120 }, accent: '--dsw-alias-state-idle-primary', glyph: '◔', w: 8, biteMs: [1800, 3600] },
  { id: 'puffer', label: '河豚', desc: '鼓成一团，看着像在生气。', rarity: 'uncommon', sellFor: { gold: 260 }, accent: '--dsw-alias-state-warn-primary', glyph: '◕', w: 5, biteMs: [2000, 4000] },
  { id: 'koi', label: '锦鲤', desc: '红白相间，钓到它算运气。', rarity: 'rare', sellFor: { diamond: 4 }, accent: '--dsw-alias-state-error-primary', glyph: '❁', w: 3, biteMs: [2200, 4400] },
  { id: 'sturgeon', label: '鲟鱼', desc: '活了很久了，比你还久。', rarity: 'rare', sellFor: { diamond: 12, gold: 600 }, accent: '--dsw-alias-link', glyph: '◈', w: 2, biteMs: [2400, 4800] },
  { id: 'moonfish', label: '月鱼', desc: '鳞上有月牙的光。', rarity: 'legendary', sellFor: { diamond: 40, relic: 1 }, accent: '--dsw-alias-brand-primary', glyph: '☾', w: 1, biteMs: [2600, 5200] },
  { id: 'dragonfish', label: '龙鱼', desc: '钓上来的时候整个水面都亮了。', rarity: 'legendary', sellFor: { diamond: 120, bar: 2 }, accent: '--dsw-alias-state-error-primary', glyph: '❂', w: 1, biteMs: [2800, 5600] },
]

const FISH_BY_ID = new Map(FISH.map((entry) => [entry.id, entry]))

/** Base strike window. Short on purpose — the rod lengthens it. */
export const FISH_WINDOW_MS = 700

/** Cooldown after a cast resolves, landed or not. */
export const FISH_COOLDOWN_MS = 2200

/**
 * 鱼竿 — a linear ladder, not a levelled upgrade.
 *
 * A better rod does two different things: a wider window makes the game
 * FORGIVING (the early tiers), a luck bonus makes it REWARDING (the late ones).
 * Splitting those curves is what keeps every purchase feelable.
 */
export const RODS = [
  { id: 'twig', label: '树枝', desc: '绑了根线，勉强算竿。', cost: { coin: 120 }, window: 0, luck: 0, accent: '--dsw-alias-label-secondary' },
  { id: 'bamboo', label: '竹竿', desc: '轻，但容易断。', cost: { coin: 900 }, window: 120, luck: 0.04, accent: '--dsw-alias-state-success-primary' },
  { id: 'glass', label: '玻璃钢竿', desc: '弹性好，手感清楚。', cost: { gold: 620 }, window: 240, luck: 0.09, accent: '--dsw-alias-state-business-primary' },
  { id: 'carbon', label: '碳素竿', desc: '专业钓手用的东西。', cost: { gold: 3_200 }, window: 360, luck: 0.16, accent: '--dsw-alias-link' },
  { id: 'moon', label: '月影竿', desc: '据说月圆之夜特别灵。', cost: { diamond: 18 }, window: 480, luck: 0.26, accent: '--dsw-alias-brand-primary' },
]

const ROD_BY_ID = new Map(RODS.map((entry) => [entry.id, entry]))

/**
 * 钓点 — where you fish.
 *
 * Each spot trades speed for quality: `biteShift` is ADDED to the bite delay
 * (so a bigger number means a slower bite) and `luck` biases the rarity roll.
 * The pond is where you fish often; the sea is where you fish rarely but well.
 */
export const FISHING_SPOTS = [
  { id: 'pond', label: '池塘', desc: '最普通的钓点，咬钩快。', biteShift: 0, luck: 0, reqRod: 0, accent: '--dsw-alias-state-idle-primary' },
  { id: 'river', label: '河流', desc: '水流动，鱼更活跃。', biteShift: 300, luck: 0.05, reqRod: 1, accent: '--dsw-alias-state-business-primary' },
  { id: 'lake', label: '湖泊', desc: '水深，有大鱼。', biteShift: 700, luck: 0.11, reqRod: 2, accent: '--dsw-alias-link' },
  { id: 'sea', label: '海边', desc: '浪大，上钩的都是硬货。', biteShift: 1_200, luck: 0.2, reqRod: 4, accent: '--dsw-alias-state-error-primary' },
]

const FISHING_SPOT_BY_ID = new Map(FISHING_SPOTS.map((entry) => [entry.id, entry]))

// ── the shop game ───────────────────────────────────────────────────────────

/**
 * 开店 — two ways to run the same shop.
 *
 * The one system where the player picks a PHILOSOPHY before playing, and the
 * choice changes what the next hour FEELS like rather than what the numbers are:
 *
 *   · 自动化 — buy machines. They work while you are away, so the loop is
 *     "come back, collect, reinvest". High efficiency, near-zero attention.
 *     Recommended for anyone without free time.
 *   · 手动 — serve customers yourself. Nothing runs in the background and the
 *     per-unit yield is lower, but there is no rate cap: an hour of clicking
 *     beats an hour of machines by a wide margin. For people who want to PLAY.
 *
 * Stored once in `save.shop.mode` and immutable afterwards — the two paths buy
 * different things, so a mid-run swap would either trivialise one or strand the
 * other's purchases. That is why the UI explains both in full BEFORE committing.
 */
export const SHOP_MODES = [
  {
    id: 'auto',
    label: '自动化',
    tagline: '买了机器，它们替你干活',
    points: [
      '后续可以买机器，机器在你离开时照样工作',
      '回来收一次就行，几乎不占你的时间',
      '单次收益略低，但从来不要求你在线',
      '没时间的话，建议先选这个',
    ],
    accent: '--dsw-alias-state-business-primary',
    glyph: '⚙',
  },
  {
    id: 'manual',
    label: '工作化',
    tagline: '你自己站柜台，一份力气一份钱',
    points: [
      '没有机器，每一单都要你自己接',
      '单次收益更高，而且没有后台收益',
      '愿意花时间盯着的话，产出比自动化高',
      '适合有时间、想真的玩一下的人',
    ],
    accent: '--dsw-alias-state-success-primary',
    glyph: '✋',
  },
]

const SHOP_MODE_BY_ID = new Map(SHOP_MODES.map((entry) => [entry.id, entry]))

/**
 * 换路线的代价，用钻石计。
 *
 * The opening choice is still a commitment — it is priced so that flipping back
 * and forth is a decision, not a reflex — but "permanent" was wrong for a
 * different reason: a player who picked 工作化 before realising they have no
 * time was stuck in a mode they could not play. Charging diamonds keeps the
 * weight of the choice without turning a misjudgement into a dead save.
 *
 * The price grows with how many times it has been swapped, so it stays a real
 * cost for someone shopping around while a single correction stays cheap.
 */
export const MODE_SWITCH_COST = { diamond: 12 }
export const MODE_SWITCH_GROWTH = 1.8

/** The 钻石 price of the next mode switch, as a pure function of swaps so far. */
export function modeSwitchCost(switches) {
  const n = Math.max(0, Math.round(num(switches, 0)))
  return { diamond: Math.max(1, Math.round(MODE_SWITCH_COST.diamond * Math.pow(MODE_SWITCH_GROWTH, n))) }
}

/**
 * What the shop sells.
 *
 * `cost` restocks one unit, `price` is what a sale pays. The margin is thin at
 * the low end and wider at the high end, so growing the PRODUCT MIX is what
 * actually grows the business — not selling more of the first item.
 */
export const SHOP_PRODUCTS = [
  { id: 'tea', label: '茶', desc: '一壶一壶地卖。', cost: { coin: 6 }, price: { coin: 14 }, accent: '--dsw-alias-state-success-primary', glyph: '🍵', unlockAt: 0 },
  { id: 'bread', label: '面包', desc: '刚出炉，路过的人都会买。', cost: { coin: 18 }, price: { coin: 46 }, accent: '--dsw-alias-state-warn-primary', glyph: '🥖', unlockAt: 8 },
  { id: 'cake', label: '蛋糕', desc: '要预定，但赚得多。', cost: { gold: 14 }, price: { gold: 38 }, accent: '--dsw-alias-link', glyph: '🍰', unlockAt: 40 },
  { id: 'feast', label: '宴席', desc: '一桌一桌地接，来钱最快。', cost: { gold: 120 }, price: { gold: 320, diamond: 1 }, accent: '--dsw-alias-state-error-primary', glyph: '🍲', unlockAt: 160 },
]

const SHOP_PRODUCT_BY_ID = new Map(SHOP_PRODUCTS.map((entry) => [entry.id, entry]))

/**
 * Machines, for the 自动化 path only.
 *
 * `perHour` is automatic units per hour and `wagePerHour` is charged when the
 * player COLLECTS — the same accounting as 矿工, for the same reason: letting a
 * machine run a week and never collecting should cost nothing upfront, with the
 * bill arriving at the moment of profit.
 */
export const SHOP_MACHINES = [
  { id: 'kettle', label: '自动茶炉', desc: '自己烧水，自己倒茶。', hireCost: { coin: 900 }, perHour: 8, wagePerHour: { coin: 30 }, accent: '--dsw-alias-state-success-primary' },
  { id: 'oven', label: '旋转烤炉', desc: '面包一直有新的。', hireCost: { gold: 1_400 }, perHour: 14, wagePerHour: { gold: 20 }, accent: '--dsw-alias-state-warn-primary' },
  { id: 'counter', label: '自助柜台', desc: '客人自己拿，自己付钱。', hireCost: { gold: 9_000 }, perHour: 26, wagePerHour: { gold: 140 }, accent: '--dsw-alias-state-business-primary' },
  { id: 'kitchen', label: '中央厨房', desc: '整条街的订单都往这里来。', hireCost: { diamond: 26 }, perHour: 48, wagePerHour: { diamond: 2 }, accent: '--dsw-alias-link' },
]

const SHOP_MACHINE_BY_ID = new Map(SHOP_MACHINES.map((entry) => [entry.id, entry]))

/** One manual sale pays this much more than the list price. */
export const MANUAL_SALE_BONUS = 1.35

/** Restocking costs this much more on the manual path (bulk discount is an auto perk). */
export const MANUAL_COST_PENALTY = 1.15

/** Reputation gained per unit sold, on both paths. */
export const REPUTATION_PER_SALE = 1

/**
 * Ores and foraged-only items join the item union HERE, not at `ALL_ITEMS`.
 *
 * `ALL_ITEMS` is declared alongside the farm produce, which sits above both the
 * ore and forage tables — referencing them there would be a
 * use-before-initialization crash. The split is dictated by declaration order;
 * the invariant (the pack sees every item) still holds, and `ALL_ITEM_BY_ID` is
 * rebuilt immediately after so every lookup shares one map.
 */

/** How many plots you start with, and the ceiling. */
export const FARM_PLOTS_BASE = 6
export const FARM_PLOTS_MAX = 18

/** The price of the next plot, as a pure function of how many you already have. */
const PLOT_COST_BASE = 260
const PLOT_COST_GROWTH = 1.78

function plotCost(owned) {
  return Math.max(1, Math.round(PLOT_COST_BASE * Math.pow(PLOT_COST_GROWTH, Math.max(0, owned - FARM_PLOTS_BASE))))
}

/**
 * The three things that can go wrong with a plot.
 *
 * Each one slows growth rather than destroying the crop. That balance is
 * deliberate: neglect should cost you SPEED (so tending is worth doing) without
 * ever costing you the crop (so coming back after a week is not a punishment).
 */
export const AILMENTS = [
  { id: 'dry', label: '缺水', desc: '土面发白了。', glyph: '☀', accent: '--dsw-alias-state-warn-primary' },
  { id: 'weed', label: '杂草', desc: '草比苗还高。', glyph: '⚘', accent: '--dsw-alias-state-success-primary' },
  { id: 'pest', label: '害虫', desc: '叶子上有洞。', glyph: '✖', accent: '--dsw-alias-state-error-primary' },
]

const AILMENT_BY_ID = new Map(AILMENTS.map((entry) => [entry.id, entry]))

/** Growth-rate penalty per active ailment, and the floor it can reach. */
const AILMENT_PENALTY = 0.3
const MIN_GROWTH_RATE = 0.1

/** Watering grants this much extra growth rate for this long. */
const WATER_BONUS = 0.4
const WATER_MS = 10 * 60_000

/** How far into growth each scripted ailment check happens. */
const AILMENT_CHECKS = [0.3, 0.68]

/** Probability (per mille) that a check actually spawns something. */
const AILMENT_CHANCE = 620


const RARITY_LABEL = {
  common: '常见',
  uncommon: '少见',
  rare: '稀有',
  legendary: '传说',
}

/**
 * Destinations.
 *
 * `hours` is nominal travel time; `rarityShift` biases the loot table (positive
 * favours rarer entries). Longer trips cost more supplies and pay better, which
 * is the whole risk/reward of going out.
 */
export const EXPEDITIONS = [
  {
    id: 'outskirts',
    label: '近郊',
    desc: '半天就能来回，收获平平但稳当。',
    hours: 1,
    supply: 2,
    rarityShift: -1,
    accent: '--dsw-alias-state-idle-primary',
    /** Relative weights per rarity, before the shift. */
    table: { common: 80, uncommon: 18, rare: 2, legendary: 0 },
    drops: [1, 2],
  },
  {
    id: 'forest',
    label: '幽林',
    desc: '树影很深，据说有人在那里见过银像。',
    hours: 3,
    supply: 4,
    rarityShift: 0,
    accent: '--dsw-alias-state-success-primary',
    table: { common: 58, uncommon: 32, rare: 9, legendary: 1 },
    drops: [1, 3],
  },
  {
    id: 'ruins',
    label: '遗迹',
    desc: '断墙下面埋着上个时代的东西。',
    hours: 6,
    supply: 6,
    rarityShift: 1,
    accent: '--dsw-alias-state-warn-primary',
    table: { common: 40, uncommon: 36, rare: 20, legendary: 4 },
    drops: [2, 3],
  },
  {
    id: 'abyss',
    label: '深渊',
    desc: '没人知道底下有什么。去的人很少空手回来。',
    hours: 12,
    supply: 10,
    rarityShift: 2,
    accent: '--dsw-alias-state-error-primary',
    table: { common: 22, uncommon: 34, rare: 32, legendary: 12 },
    drops: [2, 4],
  },
]

const EXPEDITION_BY_ID = new Map(EXPEDITIONS.map((entry) => [entry.id, entry]))

// ── mid-trip actions ────────────────────────────────────────────────────────

/**
 * What you can do while a trip is in progress.
 *
 * A trip used to be a dead wait: you departed, and until the timer expired the
 * only thing the panel offered was a countdown. That made the long destinations
 * (遗迹 6h, 深渊 12h) the most boring part of the game precisely when they should
 * be the most eventful — you set off, then went and did something else.
 *
 * So the trip is now a small camp you can interact with, and each action trades
 * one resource for another:
 *
 *   · 睡觉 trades TIME for RESOURCES (skips ahead, but consumes supplies)
 *   · 采集 trades NOTHING for small finds (free, but weak)
 *   · 返回 cuts the trip short, keeping whatever you already gathered
 *
 * `advance` caps how much one action can push the clock, so no single action can
 * complete the trip by itself — the scheduled return still matters, and "sleep
 * through the whole trip" is not a shortcut around waiting.
 */
export const TRIP_ACTIONS = [
  {
    id: 'sleep',
    label: '睡觉',
    desc: '睡过这段时间。省物资，回一点体力。',
    glyph: '☾',
    accent: '--dsw-alias-state-business-primary',
    /** How far it can push the clock, as a fraction of the remaining time. */
    advance: 0.5,
    /** Supplies burned per action, on top of the advance. */
    supplies: 2,
    /** Stamina restored. */
    stamina: 3,
  },
  {
    id: 'gather',
    label: '采集',
    desc: '在附近捡点东西。石头、木棍，偶尔有好货。',
    glyph: '✥',
    accent: '--dsw-alias-state-success-primary',
    /** Gathering has no cooldown; it is meant to be clicked repeatedly. */
    cooldownMs: 60_000,
  },
  {
    id: 'return',
    label: '返回',
    desc: '结束行程，把已经捡到的东西带回家。',
    glyph: '⌂',
    accent: '--dsw-alias-state-warn-primary',
    /** Going home early forfeits the trip's own loot roll entirely. */
    forfeits: true,
  },
]

const TRIP_ACTION_BY_ID = new Map(TRIP_ACTIONS.map((entry) => [entry.id, entry]))

/**
 * What 采集 can turn up.
 *
 * `w` is a relative weight. 石头 and 木棍 are near-certain filler; 铁锭 is the
 * bridge to the new currency and is uncommon; the rest are genuinely rare, which
 * is what makes the "偶尔有好货" line honest rather than decorative.
 *
 * Common ids deliberately REUSE expedition item ids so the existing seller, pack
 * and codex work with no new plumbing; `iron-ingot` is the only new item, and it
 * exists because nothing in the expedition pool yields 铁锭 yet.
 */
export const FORAGE = [
  { id: 'stone', label: '石头', kind: 'sell', rarity: 'common', sellFor: { coin: 6 }, accent: '--dsw-alias-label-secondary', glyph: '▪', w: 40 },
  { id: 'stick', label: '木棍', kind: 'sell', rarity: 'common', sellFor: { coin: 4 }, accent: '--dsw-alias-state-warn-primary', glyph: '⌇', w: 34 },
  { id: 'berry', label: '野果', kind: 'supply', rarity: 'common', supply: 2, sellFor: { coin: 10 }, accent: '--dsw-alias-state-success-primary', glyph: '❧', w: 26 },
  { id: 'herb', label: '药草', kind: 'supply', rarity: 'common', supply: 4, sellFor: { coin: 14 }, accent: '--dsw-alias-state-success-primary', glyph: '❦', w: 14 },
  { id: 'iron-ingot', label: '铁锭', kind: 'sell', rarity: 'uncommon', sellFor: { iron: 1 }, accent: '--dsw-alias-label-secondary', glyph: '◎', w: 16 },
  { id: 'coin-pouch', label: '钱袋', kind: 'sell', rarity: 'uncommon', sellFor: { coin: 140 }, accent: '--dsw-alias-state-idle-primary', glyph: '❍', w: 7 },
  { id: 'silver-figurine', label: '银像', kind: 'sell', rarity: 'uncommon', sellFor: { gold: 320 }, accent: '--dsw-alias-label-secondary', glyph: '♜', w: 3 },
  { id: 'relic-shard', label: '遗物碎片', kind: 'sell', rarity: 'rare', sellFor: { relic: 1 }, accent: '--dsw-alias-state-error-primary', glyph: '✧', w: 1 },
]

const FORAGE_BY_ID = new Map(FORAGE.map((entry) => [entry.id, entry]))

/** How many finds one 采集 can turn up. */
export const FORAGE_ROLLS = [1, 2]

/**
 * Foraged-only items, registered into the pack.
 *
 * `iron-ingot` / `stick` / `berry` are the genuinely new entries — the rest reuse
 * expedition ids so the seller, pack and codex keep working.
 *
 * Every id in the `FORAGE` table MUST resolve here (or in the expedition pool):
 * the client's `itemLabel` falls back to the raw id when a lookup misses, which is
 * exactly how 采集 results briefly showed English ("stick", "berry") — the finds
 * worked, the names simply had no Chinese to show.
 */
export const FORAGE_EXTRA_ITEMS = [
  { id: 'iron-ingot', label: '铁锭', desc: '一小块铁，比硬币值钱，远不如金币。', kind: 'sell', rarity: 'uncommon', sellFor: { iron: 1 }, accent: '--dsw-alias-label-secondary', glyph: '◎' },
  { id: 'stick', label: '木棍', desc: '捡来生火正合适。', kind: 'sell', rarity: 'common', sellFor: { coin: 4 }, accent: '--dsw-alias-state-warn-primary', glyph: '⌇' },
  { id: 'berry', label: '野果', desc: '酸甜的一把，能补点物资。', kind: 'supply', rarity: 'common', supply: 2, sellFor: { coin: 10 }, accent: '--dsw-alias-state-success-primary', glyph: '❧' },
]

// Register ores and foraged-only items into the pack's union, now that both
// tables exist. `ALL_ITEM_BY_ID` is rebuilt right after so every lookup — pack,
// sell, use, alchemy, forage — agrees about which ids exist.

/**
 * Fish, turned into pack items.
 *
 * Derived from `FISH` rather than written twice: the fishing table already
 * carries everything an item needs, and duplicating it would be two places to
 * forget when a species is added. `kind: 'sell'` is the only thing added —
 * you cannot eat a 龙鱼 in this game.
 */
export const FISH_ITEMS = FISH.map((entry) => ({
  id: entry.id,
  label: entry.label,
  desc: entry.desc,
  kind: 'sell',
  rarity: entry.rarity,
  sellFor: entry.sellFor,
  accent: entry.accent,
  glyph: entry.glyph,
}))

ALL_ITEMS.push(...ORES, ...FORAGE_EXTRA_ITEMS, ...FISH_ITEMS)
void PRODUCE_BY_ID
rebuildAllItems()

/** Items grouped by rarity, so the loot roll can pick a tier then an item. */
const ITEMS_BY_RARITY = ITEMS.reduce((map, item) => {
  const bucket = map.get(item.rarity) ?? []
  bucket.push(item)
  map.set(item.rarity, bucket)
  return map
}, new Map())

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'legendary']

// ── chests ──────────────────────────────────────────────────────────────────

/**
 * Loot boxes: the currency sink.
 *
 * Without a sink, a long-running save just accumulates numbers that mean
 * nothing. Each chest is priced in a different currency so every part of the
 * economy stays useful, and the tables improve as the price rises.
 *
 * `w` is a relative weight; `guaranteed` entries always drop once.
 */
export const CHESTS = [
  {
    id: 'wood',
    label: '木宝箱',
    desc: '便宜，偶尔能开出钻石',
    cost: { coin: 150 },
    accent: '--dsw-alias-state-idle-primary',
    loot: [
      { key: 'coin', min: 40, max: 130, w: 40 },
      { key: 'gold', min: 12, max: 45, w: 34 },
      { key: 'xp', min: 12, max: 40, w: 21 },
      { key: 'iron', min: 1, max: 3, w: 14 },
      { key: 'diamond', min: 1, max: 1, w: 5 },
    ],
  },
  {
    // 铁宝箱 is the 铁锭 SINK: the first chest priced in the mid currency, so
    // the ingots earned from 周签 / 采集 / lucky drops have somewhere to go.
    // Its own table pays a little iron back (never close to the 15 it costs),
    // which keeps opening it from draining the wallet to zero with nothing to
    // show for it.
    id: 'iron',
    label: '铁宝箱',
    desc: '铁皮打的，出金币和铁锭',
    cost: { iron: 15 },
    accent: '--dsw-alias-label-secondary',
    loot: [
      { key: 'gold', min: 40, max: 130, w: 42 },
      { key: 'iron', min: 4, max: 9, w: 26 },
      { key: 'xp', min: 30, max: 90, w: 24 },
      { key: 'diamond', min: 1, max: 1, w: 8 },
    ],
  },
  {
    id: 'silver',
    label: '银宝箱',
    desc: '稳定产出金币与经验',
    cost: { gold: 400 },
    accent: '--dsw-alias-label-secondary',
    loot: [
      { key: 'gold', min: 120, max: 380, w: 45 },
      { key: 'xp', min: 60, max: 160, w: 30 },
      { key: 'coin', min: 100, max: 300, w: 17 },
      { key: 'iron', min: 2, max: 6, w: 12 },
      { key: 'diamond', min: 1, max: 2, w: 8 },
    ],
  },
  {
    id: 'gold',
    label: '金宝箱',
    desc: '必出钻石，有机会出金条',
    cost: { gold: 1500, diamond: 2 },
    accent: '--dsw-alias-state-warn-primary',
    loot: [
      { key: 'gold', min: 500, max: 1400, w: 40 },
      { key: 'diamond', min: 2, max: 5, w: 30 },
      { key: 'xp', min: 200, max: 500, w: 22 },
      { key: 'bar', min: 1, max: 1, w: 8 },
    ],
  },
  {
    id: 'diamond',
    label: '钻石宝箱',
    desc: '必出金条，产出最丰厚',
    cost: { diamond: 12 },
    accent: '--dsw-alias-link',
    guaranteed: [{ key: 'bar', min: 1, max: 2 }],
    loot: [
      { key: 'diamond', min: 8, max: 22, w: 40 },
      { key: 'gold', min: 2000, max: 6000, w: 32 },
      { key: 'xp', min: 800, max: 2000, w: 20 },
      { key: 'bar', min: 1, max: 3, w: 8 },
    ],
  },
]

const CHEST_BY_ID = new Map(CHESTS.map((entry) => [entry.id, entry]))

/** How many chests the bulk button may open in one request. */
export const CHEST_BULK_MAX = 10

// ── daily quests ────────────────────────────────────────────────────────────

/**
 * The daily quest pool.
 *
 * `metric` names a per-day counter the engine bumps; `target` is how much is
 * needed. Three are drawn per day, deterministically from the date, so reloading
 * never rerolls the day and a player cannot fish for an easy draw.
 */
export const QUEST_POOL = [
  { id: 'q-claim-3', label: '勤勉', desc: '完成 3 次签到', metric: 'claims', target: 3, reward: { relic: 1 } },
  { id: 'q-claim-8', label: '不知疲倦', desc: '完成 8 次签到', metric: 'claims', target: 8, reward: { relic: 2, gold: 300 } },
  { id: 'q-day', label: '今日打卡', desc: '完成每日签到', metric: 'periodDay', target: 1, reward: { diamond: 2 } },
  { id: 'q-chest-1', label: '开一个箱子', desc: '打开 1 个宝箱', metric: 'chests', target: 1, reward: { coin: 200 } },
  { id: 'q-chest-3', label: '手气不错', desc: '打开 3 个宝箱', metric: 'chests', target: 3, reward: { gold: 400 } },
  { id: 'q-sell-3', label: '做点买卖', desc: '卖出 3 件东西', metric: 'sold', target: 3, reward: { gold: 250 } },
  { id: 'q-trip-1', label: '出门走走', desc: '完成 1 次行程', metric: 'trips', target: 1, reward: { relic: 1 } },
  { id: 'q-trip-3', label: '四处看看', desc: '完成 3 次行程', metric: 'trips', target: 3, reward: { diamond: 3 } },
  { id: 'q-use-1', label: '物尽其用', desc: '使用 1 件道具', metric: 'used', target: 1, reward: { coin: 150 } },
  { id: 'q-lucky-1', label: '今天运气好', desc: '触发 1 次额外掉落', metric: 'lucky', target: 1, reward: { diamond: 1 } },
  { id: 'q-spend-500', label: '该花就花', desc: '花掉 500 金币', metric: 'spent', target: 500, reward: { coin: 400 } },
  { id: 'q-alchemy-2', label: '炼金术士', desc: '完成 2 次炼金', metric: 'alchemy', target: 2, reward: { diamond: 2 } },
  { id: 'q-perfect-1', label: '今日全勤', desc: '达成一次全勤日', metric: 'perfect', target: 1, reward: { bar: 1 } },
  { id: 'q-buy-2', label: '投资自己', desc: '购买 2 级升级', metric: 'upgrades', target: 2, reward: { gold: 300 } },
  { id: 'q-plant-2', label: '播种', desc: '种下 2 株作物', metric: 'planted', target: 2, reward: { coin: 120 } },
  { id: 'q-harvest-3', label: '收成', desc: '收获 3 份作物', metric: 'harvest', target: 3, reward: { gold: 200 } },
  { id: 'q-tend-3', label: '照看', desc: '照看作物 3 次', metric: 'tended', target: 3, reward: { coin: 200 } },
  { id: 'q-mined-3', label: '挖矿去', desc: '挖到 3 份矿石', metric: 'mined', target: 3, reward: { coin: 260 } },
  { id: 'q-swing-30', label: '挥镐三十下', desc: '挥镐 30 次', metric: 'swings', target: 30, reward: { gold: 350 } },
  { id: 'q-descend-1', label: '往下看看', desc: '下潜到更深的一层', metric: 'descended', target: 2, reward: { diamond: 2 } },
]

const QUEST_BY_ID = new Map(QUEST_POOL.map((entry) => [entry.id, entry]))

/** How many quests a day offers. */
export const DAILY_QUEST_COUNT = 3

/** Bonus for clearing all of the day's quests. */
export const DAILY_ALL_BONUS = { diamond: 5, relic: 1 }

/** A small, stable string hash (FNV-1a), used to seed the daily draw. */
function hash32(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * The day's quests, derived from the date key.
 *
 * Deterministic on purpose: storing the draw would need a migration whenever the
 * pool changes, and rerolling on reload would let a player refresh until they
 * liked the selection.
 */
function questsForDay(dayKey) {
  const pool = [...QUEST_POOL]
  const picked = []
  let seed = hash32(dayKey)
  for (let i = 0; i < DAILY_QUEST_COUNT && pool.length > 0; i += 1) {
    // A tiny LCG step; adequate for choosing an index.
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    const index = seed % pool.length
    picked.push(pool[index])
    pool.splice(index, 1)
  }
  return picked
}

// ── alchemy ─────────────────────────────────────────────────────────────────

/**
 * Recipes: the second use for a duplicate.
 *
 * Selling is the money path and using is the sustain path; alchemy is the
 * upgrade path, and it is what makes a sixth 海螺 interesting instead of noise.
 * Every recipe consumes MORE raw value than the target item is worth, but turns
 * junk into something you want — the fee is what stops it being a money printer.
 */
export const RECIPES = [
  { id: 'grind', label: '研磨贝壳', desc: '把一堆贝壳磨成有用的矿料', inputs: { shell: 6 }, output: { ore: 1 }, fee: { coin: 80 }, accent: '--dsw-alias-state-idle-primary' },
  { id: 'melt', label: '熔铸钱袋', desc: '钱袋里的金属还能再用', inputs: { 'coin-pouch': 3 }, output: { ore: 2 }, fee: { coin: 120 }, accent: '--dsw-alias-state-idle-primary' },
  { id: 'brew', label: '炮制草药', desc: '把草药做成耐放的干粮', inputs: { herb: 3 }, output: { provision: 1 }, fee: { coin: 60 }, accent: '--dsw-alias-state-success-primary' },
  { id: 'refine', label: '精炼干粮', desc: '干粮浓缩成一瓶灵药', inputs: { provision: 2 }, output: { elixir: 1 }, fee: { gold: 250 }, accent: '--dsw-alias-state-success-primary' },
  { id: 'recast', label: '重铸银像', desc: '银像重铸成金像', inputs: { 'silver-figurine': 2 }, output: { 'gold-idol': 1 }, fee: { gold: 180 }, accent: '--dsw-alias-state-warn-primary' },
  { id: 'engrave', label: '铭刻护符', desc: '用遗物碎片强化护身符', inputs: { charm: 2, 'relic-shard': 1 }, output: { seal: 1 }, fee: { gold: 220 }, accent: '--dsw-alias-link' },
  { id: 'smelt', label: '熔炼金像', desc: '三座金像铸成一顶古冠', inputs: { 'gold-idol': 3 }, output: { crown: 1 }, fee: { diamond: 3 }, accent: '--dsw-alias-state-error-primary' },
  { id: 'fuse', label: '聚合碎片', desc: '碎片聚合成仍在发热的核心', inputs: { 'relic-shard': 3 }, output: { 'relic-core': 1 }, fee: { diamond: 4 }, accent: '--dsw-alias-state-error-primary' },
]

const RECIPE_BY_ID = new Map(RECIPES.map((entry) => [entry.id, entry]))

// ── rebirth ─────────────────────────────────────────────────────────────────

/** The level required before a rebirth is allowed. */
export const REBIRTH_LEVEL = 50

/** Stars granted by a rebirth: one per ten levels, floored. */
export function starsForLevel(level) {
  return Math.floor(level / 10)
}

/**
 * 星盘 — permanent upgrades bought with 星辰, which survive a rebirth.
 *
 * These are the reason to rebirth at all: they make every later run faster and
 * they never reset. `starCost` is a pure function of the level.
 */
export const STAR_UPGRADES = [
  { id: 'starYield', label: '星辉', desc: '所有签到奖励 +8%', max: 25, base: 1, growth: 1.5, effect: 'starYield', step: 0.08, accent: '--dsw-alias-state-warn-primary' },
  { id: 'starOffline', label: '长夜', desc: '离线收益速率 +20%', max: 15, base: 1, growth: 1.6, effect: 'starOffline', step: 0.2, accent: '--dsw-alias-state-idle-primary' },
  { id: 'starLuck', label: '吉星', desc: '签到额外掉落概率 +2%', max: 15, base: 2, growth: 1.55, effect: 'starLuck', step: 0.02, accent: '--dsw-alias-state-warn-primary' },
  { id: 'starFortune', label: '星图', desc: '寻宝品质 +1', max: 12, base: 3, growth: 1.6, effect: 'starFortune', step: 1, accent: '--dsw-alias-link' },
  { id: 'starStart', label: '启程', desc: '转生后额外获得 800 金币', max: 10, base: 2, growth: 1.5, effect: 'starStart', step: 800, accent: '--dsw-alias-state-success-primary' },
  { id: 'starPack', label: '星辰行囊', desc: '背包容量 +10 件', max: 12, base: 2, growth: 1.5, effect: 'starPack', step: 10, accent: '--dsw-alias-state-business-primary' },
]

const STAR_UPGRADE_BY_ID = new Map(STAR_UPGRADES.map((entry) => [entry.id, entry]))

/** The 星辰 price of the next level of a star upgrade, or null when maxed. */
function starCost(definition, level) {
  if (level >= definition.max) return null
  return Math.max(1, Math.round(definition.base * Math.pow(definition.growth, level)))
}

// ── offline earnings ────────────────────────────────────────────────────────

/**
 * Passive income, accrued by the host from wall-clock time.
 *
 * Base rates are per hour; both the rate and the cap are upgradeable, which is
 * what gives the shop its long-term pull. The pool is *stored* rather than
 * derived, so a restart in the middle of an absence cannot lose the accrual.
 */
const OFFLINE_BASE_PER_HOUR = { coin: 8, gold: 3 }
const OFFLINE_BASE_CAP_HOURS = 4

/** The price of the next level of an upgrade, or null when it is maxed. */
function upgradeCost(definition, level) {
  if (level >= definition.max) return null
  const raw = definition.cost.base * Math.pow(definition.cost.growth, level)
  return Math.max(1, Math.round(raw))
}

// ── save shape ──────────────────────────────────────────────────────────────

function emptyPeriod() {
  return {
    /** Elapsed-time anchor (interval periods). */
    lastAt: 0,
    /** Calendar bucket key of the last claim (calendar periods). */
    lastKey: '',
    streak: 0,
    best: 0,
    total: 0,
  }
}

/**
 * The save format version.
 *
 * One constant, read by both `defaultSave()` and `normalize()`, because the two
 * disagreeing is exactly how a "reset my save" bug hides: a fresh save would
 * carry the old number and a later migration would try to re-migrate it.
 *
 * 1 → 2: added upgrades, chests, offline pool
 * 2 → 3: added supplies, pack, expeditions, buffs, the `relic` currency
 * 3 → 4: added daily quests, alchemy, rebirth, the `star` currency
 * 4 → 5: added the farm (plots, crops, ailments)
 * 5 → 6: added the mine (depth, stamina, veins, ore pack, miners)
 */
const SAVE_VERSION = 6

function defaultSave() {
  return {
    version: SAVE_VERSION,
    bornAt: 0,
    lastSeenAt: 0,
    currencies: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0 },
    /** Lifetime totals, so spending (if ever added) cannot erase progress. */
    earned: { xp: 0, coin: 0, gold: 0, diamond: 0, bar: 0 },
    periods: Object.fromEntries(PERIOD_KEYS.map((key) => [key, emptyPeriod()])),
    achievements: {},
    stats: {
      luckyHits: 0,
      perfectDays: 0,
      bestCombo: 0,
      /** Local hours (0–23) at which a claim has ever happened. */
      hours: [],
      /** Bucket keys of days on which every period was claimed. */
      perfectKeys: [],
      /** Per-period lifetime counts, mirrored from `periods` for cheap reads. */
      counts: Object.fromEntries(PERIOD_KEYS.map((key) => [key, 0])),
    },
    /** Purchased upgrade levels, keyed by upgrade id. */
    upgrades: {},
    /** Lifetime chest counts, keyed by chest id. */
    chests: { opened: {}, byId: {} },
    /** Accrued-but-uncollected offline income. */
    offline: { pool: { coin: 0, gold: 0 }, accruedAt: 0, collected: 0 },
    /** Expedition supplies: the consumable, plus when it last regenerated. */
    supplies: { current: SUPPLY_MAX_BASE, regenAt: 0 },
    /** Backpack: one row per held item stack. */
    pack: [],
    /** Lifetime counts: items found, items sold, expeditions finished. */
    expedition: { found: {}, sold: {}, runs: 0, bestTier: null, byDestination: {}, used: 0 },
    /** The run currently in progress, or null when home. */
    trip: null,
    /** Active timed buffs from items. */
    buffs: [],
    /**
     * Today's quest progress.
     *
     * `key` is the local date; when it no longer matches, the counters and claims
     * reset. The quest list itself is derived from the key, never stored.
     */
    daily: { key: '', counters: {}, claimed: {}, allClaimed: false },
    /** How many distinct days had every quest claimed. */
    questAllDays: 0,
    /** Alchemy tallies. */
    alchemy: { runs: 0, byRecipe: {} },
    /** Rebirth state: how many times, and the permanent 星盘 levels. */
    rebirth: { count: 0, bestLevel: 1 },
    starUpgrades: {},
    /**
     * 钓鱼.
     *
     * `cast` holds the single cast in flight:
     *   { state: 'waiting'|'biting', biteAt, strikeDeadline, fish, spot }
     * Persisted so reloading mid-cast does not lose it — it either resumes still
     * waiting, or expires. `bySpot` is what the 出海 achievement reads.
     */
    fishing: {
      rods: ['twig'],
      activeRod: 'twig',
      spot: 'pond',
      cast: null,
      cooldownUntil: 0,
      caught: 0,
      escaped: 0,
      byFish: {},
      bySpot: {},
      bestRarity: -1,
    },
    /**
     * 开店.
     *
     * `mode` is null until the player answers the opening question, and is
     * IMMUTABLE afterwards — see SHOP_MODES. `stock` is per-product held units;
     * `machines` mirrors the miner roster, with `endsAt: 0` meaning "never bought".
     */
    shop: {
      mode: null,
      chosenAt: 0,
      /** How many times the mode has been swapped; drives the 钻石 price. */
      modeSwitches: 0,
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
    /**
     * The farm.
     *
     * `plots` is a fixed-length array (the purchased size), and a null slot is an
     * empty plot. Length is the source of truth for how many plots exist, so a
     * purchased plot cannot be lost by a rounding bug elsewhere.
     */
    farm: { plots: Array.from({ length: FARM_PLOTS_BASE }, () => null), harvested: 0, byCrop: {}, tended: 0 },
    /**
     * The mine.
     *
     * `staminaAt` is an absolute timestamp, so regen survives a restart without
     * double-crediting. `miners` is a roster keyed by id with `endsAt: 0` meaning
     * "never hired"; its `buffered` map holds raw ore sums that are paid for and
     * collected in one action.
     */
    mine: {
      depth: 1,
      stamina: STAMINA_MAX_BASE,
      staminaAt: 0,
      upgrades: {},
      /** The vein currently being worked, or null when the wall is bare. */
      vein: null,
      /** Ore waiting to be collected from your own swings, summed by id. */
      bufferedSwing: {},
      miners: Object.fromEntries(MINERS.map((miner) => [miner.id, { endsAt: 0, buffered: {} }])),
      stats: { swings: 0, veins: 0, collected: 0, oresMined: 0, deepest: 1, hiredTotal: 0, byOre: {}, lastStamina: -1 },
    },
    history: [],
  }
}

// ── io helpers ──────────────────────────────────────────────────────────────

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/** A stable, ascending id for one claim, used to key feed rows. */
let claimSeq = 0

// ── settings ────────────────────────────────────────────────────────────────

/**
 * The settings schema.
 *
 * This is a TABLE, not a hand-written form, so the client renders whatever it
 * contains and adding a knob never touches client code.
 *
 * Two honest notes about what these are:
 *
 *   · The numeric knobs (倍率/速度) are **self-imposed difficulty dials**, not
 *     balance. Turning 奖励倍率 to 5× makes the game trivial, and that is a
 *     legitimate thing to want — but the README says so rather than pretending
 *     these are neutral options.
 *   · Every numeric value is CLAMPED to its declared range on read, so a
 *     hand-edited `settings.json` cannot produce a nonsensical state (a zero
 *     growth rate would make `remainingMs` infinite; a negative reward would
 *     drain currency).
 *
 * `kind: 'toggle'` entries switch a SYSTEM's UI off. The underlying routes keep
 * working, so hiding a tab never breaks an existing save — it only declutters.
 */
export const SETTINGS_SCHEMA = [
  // — difficulty dials —
  {
    group: '收益',
    key: 'rewardMultiplier',
    label: '签到奖励倍率',
    desc: '所有签到奖励乘以这个数。调高就是自己给自己放水。',
    kind: 'number',
    min: 0.1,
    max: 10,
    step: 0.1,
    default: 1,
    /** Presentation hint only; the host does not act on it. */
    format: 'x',
  },
  {
    group: '收益',
    key: 'luckBonus',
    label: '额外幸运',
    desc: '在升级和增益之外，再额外加这么多随机掉落概率。',
    kind: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0,
    format: 'percent',
  },
  {
    group: '收益',
    key: 'lootQuality',
    label: '寻宝品质加成',
    desc: '额外提高寻宝的品质分布，会实时影响图鉴的路线估值。',
    kind: 'number',
    min: 0,
    max: 5,
    step: 1,
    default: 0,
    format: 'flat',
  },
  {
    group: '收益',
    key: 'offlineMultiplier',
    label: '离线收益倍率',
    desc: '离线收益累积的速度乘以这个数。',
    kind: 'number',
    min: 0.25,
    max: 8,
    step: 0.25,
    default: 1,
    format: 'x',
  },

  // — the farm —
  {
    group: '农场',
    key: 'cropSpeed',
    label: '作物生长速度',
    desc: '作物长得快多少倍。调慢可以当成"慢节奏农场"。',
    kind: 'number',
    min: 0.25,
    max: 8,
    step: 0.25,
    default: 1,
    format: 'x',
  },
  {
    group: '农场',
    key: 'ailmentRate',
    label: '病害频率',
    desc: '调到 0 就再也不会缺水、长草、生虫。',
    kind: 'number',
    min: 0,
    max: 2,
    step: 0.1,
    default: 1,
    format: 'x',
  },

  // — supplies —
  {
    group: '物资',
    key: 'supplyRegenMultiplier',
    label: '物资恢复速度',
    desc: '物资自动恢复快多少倍。',
    kind: 'number',
    min: 0.25,
    max: 8,
    step: 0.25,
    default: 1,
    format: 'x',
  },

  // — presentation —
  {
    group: '界面',
    key: 'hideSpoilers',
    label: '隐藏未解锁成就的名称',
    desc: '未解锁的成就只显示条件，不剧透名字。',
    kind: 'toggle',
    default: false,
  },
  {
    group: '界面',
    key: 'confirmRebirth',
    label: '转生需要二次确认',
    desc: '关掉之后点一下就会直接转生，请小心。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '界面',
    key: 'condensedTabs',
    label: '标签页只显示图标',
    desc: '标签页太多时，把文字藏起来只留图标。',
    kind: 'toggle',
    default: false,
  },
  // — entry points —
  // The plugin shows up in THREE places: the badge above the user's name at the
  // sidebar foot, the 签到 row in the panel list, and a sign-in row inside DSH's
  // own 设置 page. The first two are paired (never both off — an entry you
  // cannot open is an entry that no longer exists); the settings row is NOT part
  // of that pair, because turning it off leaves both other doors intact.
  // `pair` is the shared group id the rule and the UI both read.
  {
    group: '界面',
    key: 'showFooterBadge',
    label: '左下角签到徽章',
    desc: '用户名字上方那个带可领数量的徽章。关掉后仍可从面板列表进入。',
    kind: 'toggle',
    default: true,
    pair: 'entryPoints',
  },
  {
    group: '界面',
    key: 'showPanelEntry',
    label: '侧边栏签到入口',
    desc: '面板列表里的「签到」那一行。关掉后仍可从左下角徽章进入。',
    kind: 'toggle',
    default: true,
    pair: 'entryPoints',
  },
  {
    group: '界面',
    key: 'showSettingsRow',
    label: '设置页里的签到',
    desc: '在 DSH 设置页加一行，可以直接领签到、看可领数量，不用打开插件面板。',
    kind: 'toggle',
    default: true,
  },
  // — updates —
  // Two switches with different jobs, and the difference matters:
  //
  //   allowUpdateCheck  — "may this plugin ever touch the network?"
  //   autoCheckUpdate   — "and should it do so on its own?"
  //
  // The first defaults ON now, but on its own it still means MANUAL: nothing is
  // fetched until the player presses 检查更新. That keeps the About page's
  // promise literally true — the plugin does not reach out by itself — while no
  // longer making the player hunt for a switch before an obvious feature works.
  //
  // The second defaults OFF, because it is the one that actually phones home
  // without being asked. Turning the first off makes the second meaningless, so
  // the UI disables it and the host refuses the combination.
  {
    group: '更新',
    key: 'allowUpdateCheck',
    label: '允许联网检查更新',
    desc: '关掉时插件完全不联网。打开后也不会自己联网——只有你点「检查更新」时才发一次请求。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '更新',
    key: 'autoCheckUpdate',
    label: '自动检查更新',
    desc: '每隔几小时自己检查一次，发现新版本会弹窗提示（需要允许联网检查更新）。',
    kind: 'toggle',
    default: false,
  },
  {
    group: '更新',
    key: 'notifyNewVersion',
    label: '有新版本时提示',
    desc: '在「公告」标签上显示一个小圆点（需要允许联网检查更新）。',
    kind: 'toggle',
    default: true,
  },

  // — which systems to show —
  {
    group: '显示的系统',
    key: 'showFarm',
    label: '农场',
    desc: '关掉只是隐藏这个标签页，地里的作物照常生长。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '显示的系统',
    key: 'showAlchemy',
    label: '炼金',
    desc: '隐藏炼金标签页。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '显示的系统',
    key: 'showQuests',
    label: '每日任务',
    desc: '隐藏任务标签页。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '显示的系统',
    key: 'showTrip',
    label: '出门寻宝',
    desc: '隐藏出门标签页；进行中的行程不会中断。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '显示的系统',
    key: 'showChests',
    label: '宝箱',
    desc: '隐藏宝箱标签页。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '显示的系统',
    key: 'showStar',
    label: '星盘与转生',
    desc: '隐藏星盘标签页，也就无法转生。',
    kind: 'toggle',
    default: true,
  },
  {
    group: '显示的系统',
    key: 'showCodex',
    label: '图鉴',
    desc: '隐藏背包里的图鉴分区。',
    kind: 'toggle',
    default: true,
  },
]

const SETTINGS_BY_KEY = new Map(SETTINGS_SCHEMA.map((entry) => [entry.key, entry]))

/**
 * "At least one must stay on" groups, read off the schema's `pair` tags.
 *
 * The entry points (footer badge / panel row) are the two doors into the whole
 * game: a player who closes both can never get back in to reopen one — the
 * settings page itself lives behind those doors. So the pair is a hard
 * invariant, enforced in three places: the UI disables the last open toggle,
 * `updateSettings` rejects a patch that would close both, and `normalizeSettings`
 * repairs a hand-edited file that already has both closed.
 */
const PAIR_GROUPS = new Map()
for (const entry of SETTINGS_SCHEMA) {
  if (typeof entry.pair !== 'string') continue
  const keys = PAIR_GROUPS.get(entry.pair) ?? []
  keys.push(entry.key)
  PAIR_GROUPS.set(entry.pair, keys)
}
export { PAIR_GROUPS }

/**
 * The schema's numeric entries, exported for tests.
 *
 * Tests re-render the settings panel against this and count the controls, which
 * is how a knob that silently renders nothing gets caught.
 */
export const settingsSchema = SETTINGS_SCHEMA

/**
 * The settings that hide a whole system.
 *
 * Declared once and read by both the "how many are hidden" counter and the
 * "were they ever hidden" sticky flag. Two separate lists would drift, and the
 * symptom would be an achievement that silently stops counting a system.
 */
export const SYSTEM_TOGGLES = [
  'showFarm',
  'showAlchemy',
  'showQuests',
  'showTrip',
  'showChests',
  'showStar',
]

/** Defaults, derived from the schema so there is one source of truth. */
export const DEFAULT_SETTINGS = Object.fromEntries(
  SETTINGS_SCHEMA.map((entry) => [entry.key, entry.default]),
)

/**
 * Validate ONE setting value against its schema entry.
 *
 * Returns `undefined` when the value is not usable, which lets a caller
 * distinguish "ignore this" from "set it to the default" — a distinction that
 * matters: merging a raw patch and re-normalizing the whole object would let a
 * malformed value OVERRIDE the current one and then fall back to the DEFAULT,
 * silently resetting a knob the player had tuned.
 */
function coerceSetting(entry, value) {
  if (value === undefined || value === null) return undefined
  if (entry.kind === 'toggle') return typeof value === 'boolean' ? value : undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(entry.max, Math.max(entry.min, parsed))
}

/**
 * Coerce arbitrary input into a valid settings object.
 *
 * Any unknown key is dropped and every value is clamped or type-checked against
 * the schema. This runs on load, so neither a hand-edited file nor a malformed
 * request can put the game into an impossible configuration.
 */
export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS }
  if (raw === null || raw === undefined || typeof raw !== 'object') return out
  for (const entry of SETTINGS_SCHEMA) {
    const coerced = coerceSetting(entry, raw[entry.key])
    if (coerced !== undefined) out[entry.key] = coerced
  }
  // Repair a file that closed an entire pair: force the group's FIRST key back
  // on. This is load-time only — the runtime rejection lives in
  // `updateSettings`, where a refusal can be reported instead of rewritten.
  for (const keys of PAIR_GROUPS.values()) {
    if (keys.every((key) => out[key] === false)) out[keys[0]] = true
  }
  return out
}

/**
 * Apply a PATCH to current settings, keeping unchanged keys untouched.
 *
 * Iterates the patch rather than re-normalizing the merged object, so an invalid
 * value for one key leaves that key exactly as it was instead of resetting it.
 */
export function applySettingsPatch(current, patch) {
  const out = { ...DEFAULT_SETTINGS, ...current }
  if (patch === null || patch === undefined || typeof patch !== 'object') return out
  for (const entry of SETTINGS_SCHEMA) {
    if (!Object.prototype.hasOwnProperty.call(patch, entry.key)) continue
    const coerced = coerceSetting(entry, patch[entry.key])
    if (coerced !== undefined) out[entry.key] = coerced
  }
  return out
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const dataDir = path.join(resolveDshHome(), DATA_DIR)
  const savePath = path.join(dataDir, SAVE_FILE)
  const settingsPath = path.join(dataDir, SETTINGS_FILE)

  let save = normalize(readJsonSafe(savePath))
  if (save.bornAt === 0) save.bornAt = Date.now()
  save.lastSeenAt = Date.now()

  /** Preferences, loaded once and re-read on every write. */
  let settings = normalizeSettings(readJsonSafe(settingsPath))
  /**
   * How many times settings have been changed, ever.
   *
   * Kept beside the settings rather than in the save, because it describes the
   * player's relationship with the CONFIG, not their progress in the game — and
   * it must survive `/reset` for the same reason the settings do.
   */
  let settingsTouched = 0
  /**
   * Whether the player has EVER hidden a system tab.
   *
   * Sticky on purpose: the `unfiltered` achievement is about having used the
   * switches and come back, which cannot be read off the current values alone
   * (a fresh save and a restored save both show zero hidden).
   */
  let hidSystemsBefore = false
  /**
   * The newest version the player has marked as read.
   *
   * Stored beside the settings, not in the save: it describes what the player has
   * SEEN in the UI, not what they have achieved in the game, and it must survive
   * `/reset` for the same reason the settings do. Kept as a version string so a
   * build that adds a changelog entry lights the "unread" dot on its own — the
   * comparison is "is the newest entry newer than what you read", which needs no
   * migration when a release is appended.
   */
  let readsUpTo = null
  {
    const raw = readJsonSafe(settingsPath)
    if (raw !== null && raw !== undefined) {
      if (Number.isFinite(Number(raw.__touched))) {
        settingsTouched = Math.max(0, Math.round(Number(raw.__touched)))
      }
      hidSystemsBefore = raw.__hidSystems === true
      if (typeof raw.__readsUpTo === 'string' && raw.__readsUpTo !== '') readsUpTo = raw.__readsUpTo
    }
  }

  let disposed = false

  function persistSettings() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const temp = `${settingsPath}.tmp-${process.pid}`
      // The bookkeeping fields ride along in the same file, so one write keeps
      // values and their history in sync.
      const payload = {
        ...settings,
        __touched: settingsTouched,
        __hidSystems: hidSystemsBefore,
        __readsUpTo: readsUpTo,
      }
      fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, settingsPath)
      return true
    } catch (error) {
      logger.warn?.(`checkin: 设置无法写入：${messageOf(error)}`)
      return false
    }
  }

  /**
   * Update some settings and persist.
   *
   * Merges rather than replaces, so the client can send one changed knob without
   * having to echo the whole object back — which would make a stale tab able to
   * silently revert a setting changed elsewhere.
   */
  /** Whether a settings change touches the two switches that control the checker. */
  function changedUpdaterKeys(before, after) {
    return before.allowUpdateCheck !== after.allowUpdateCheck || before.autoCheckUpdate !== after.autoCheckUpdate
  }

  function updateSettings(patch, now = Date.now()) {    const before = { ...settings }
    // A PATCH, not a replace: an invalid value leaves its key untouched rather
    // than resetting it to the default.
    const next = applySettingsPatch(settings, patch)
    // A patch that would close an entire "at least one" pair is REJECTED, not
    // repaired: the UI disables the last open toggle already, so reaching here
    // means a stale tab or a hand-made request, and silently rewriting it would
    // honour an action the player can never see undone. The error names both
    // doors so the message is actionable wherever it surfaces.
    for (const keys of PAIR_GROUPS.values()) {
      if (keys.every((key) => next[key] === false)) {
        const labels = keys.map((key) => `「${SETTINGS_BY_KEY.get(key).label}」`).join('和')
        throw new Error(`${labels}不能同时关闭——两处入口都没了的话，就再也没有地方能把它们打开。至少留一处显示。`)
      }
    }
    settings = next

    /**
     * Turning "自动检查更新" on must actually start the checker NOW.
     *
     * Otherwise the switch would only take effect after a restart — a setting
     * that appears applied and does nothing is the kind of silent lie this
     * plugin's tests exist to prevent.
     */
    if (changedUpdaterKeys(before, settings)) syncAutoCheck()

    // Report exactly which keys changed, so the UI can confirm what took effect
    // instead of guessing from the whole object.
    const changed = Object.keys(settings).filter((key) => settings[key] !== before[key])
    if (changed.length > 0) {
      // Count a CHANGE, not a request: a no-op save should not inflate the tally.
      settingsTouched += 1
      // Remember that the switches were used at all, for `unfiltered`.
      if (SYSTEM_TOGGLES.some((key) => settings[key] === false)) hidSystemsBefore = true
      persistSettings()
      /**
       * Settings changes must reconcile achievements too.
       *
       * Every other mutation in this plugin does, and the settings-aware
       * achievements (调校 / 调到十一 / 极简主义 / 全都要) are only reachable
       * through this path. Without this call they were unreachable BY
       * CONSTRUCTION: the fields they read updated correctly, the UI showed the
       * change, and the achievement simply never fired.
       */
      const unlocked = reconcileAchievements(now)
      for (const entry of unlocked) {
        claimSeq += 1
        pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
      }
      if (unlocked.length > 0) persist()
      return { changed, settings: { ...settings }, unlocked }
    }
    return { changed, settings: { ...settings }, unlocked: [] }
  }

  /** The settings payload the client renders: schema plus current values. */
  function settingsView() {
    return {
      values: { ...settings },
      schema: SETTINGS_SCHEMA.map((entry) => ({ ...entry })),
      path: settingsPath,
    }
  }

  /** Coerce whatever is on disk into a valid save. Unknown fields are dropped. */
  function normalize(raw) {
    const base = defaultSave()
    if (raw === null) return base

    const periods = {}
    for (const key of PERIOD_KEYS) {
      const source = raw.periods !== undefined && raw.periods !== null ? raw.periods[key] : undefined
      const target = emptyPeriod()
      if (source !== undefined && source !== null && typeof source === 'object') {
        target.lastAt = Math.max(0, Math.round(num(source.lastAt, 0)))
        target.lastKey = typeof source.lastKey === 'string' ? source.lastKey : ''
        target.streak = Math.max(0, Math.round(num(source.streak, 0)))
        target.best = Math.max(0, Math.round(num(source.best, 0)))
        target.total = Math.max(0, Math.round(num(source.total, 0)))
      }
      periods[key] = target
    }

    const currencies = {}
    const earned = {}
    for (const key of CURRENCY_KEYS) {
      currencies[key] = Math.max(0, Math.floor(num(raw.currencies?.[key], 0)))
      earned[key] = Math.max(currencies[key], Math.floor(num(raw.earned?.[key], currencies[key])))
    }

    const achievements = {}
    if (raw.achievements !== null && typeof raw.achievements === 'object') {
      for (const [id, at] of Object.entries(raw.achievements)) {
        if (ACHIEVEMENT_IDS.has(id)) achievements[id] = Math.max(0, Math.round(num(at, 0)))
      }
    }

    const stats = base.stats
    const rawStats = raw.stats !== undefined && raw.stats !== null ? raw.stats : {}
    stats.luckyHits = Math.max(0, Math.round(num(rawStats.luckyHits, 0)))
    stats.perfectDays = Math.max(0, Math.round(num(rawStats.perfectDays, 0)))
    stats.bestCombo = Math.max(0, Math.round(num(rawStats.bestCombo, 0)))
    stats.hours = Array.isArray(rawStats.hours)
      ? [...new Set(rawStats.hours.map((h) => Math.round(num(h, -1))).filter((h) => h >= 0 && h <= 23))].sort((a, b) => a - b)
      : []
    stats.perfectKeys = Array.isArray(rawStats.perfectKeys)
      ? [...new Set(rawStats.perfectKeys.filter((k) => typeof k === 'string'))].slice(-400)
      : []
    stats.counts = {}
    for (const key of PERIOD_KEYS) {
      stats.counts[key] = Math.max(periods[key].total, Math.round(num(rawStats.counts?.[key], 0)))
    }

    // History is a display feed, so entries are accepted on their real shape
    // (id/at/kind/label) rather than an invented `text` field — the first cut
    // filtered on a field nothing ever wrote, which silently erased the feed on
    // every restart. Unknown kinds are still kept: the client renders the
    // default branch, and dropping them would lose rows for no reason.
    const history = Array.isArray(raw.history)
      ? raw.history
          .filter(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              typeof entry.kind === 'string' &&
              typeof entry.label === 'string',
          )
          .map((entry) => ({
            ...entry,
            id: Math.max(0, Math.round(num(entry.id, 0))),
            at: Math.max(0, Math.round(num(entry.at, 0))),
          }))
          .slice(-HISTORY_LIMIT)
      : []

    // Upgrade levels are clamped to each definition's max, so a hand-edited or
    // stale save can never hold an impossible level.
    const upgrades = {}
    const rawUpgrades = raw.upgrades !== undefined && raw.upgrades !== null ? raw.upgrades : {}
    for (const definition of UPGRADES) {
      const level = Math.max(0, Math.round(num(rawUpgrades[definition.id], 0)))
      upgrades[definition.id] = Math.min(level, definition.max)
    }

    // Chest tallies: only ids this build knows are kept.
    const rawChests = raw.chests !== undefined && raw.chests !== null ? raw.chests : {}
    const byId = {}
    let openedTotal = 0
    for (const chest of CHESTS) {
      const count = Math.max(0, Math.round(num(rawChests.byId?.[chest.id], 0)))
      byId[chest.id] = count
      openedTotal += count
    }
    const chests = {
      // `opened` is a lifetime total that may exceed the sum of known ids if a
      // chest was removed in a later build; keep the larger of the two.
      opened: Math.max(openedTotal, Math.max(0, Math.round(num(rawChests.opened, 0)))),
      byId,
    }

    const rawOffline = raw.offline !== undefined && raw.offline !== null ? raw.offline : {}
    const offline = {
      pool: {
        coin: Math.max(0, Math.floor(num(rawOffline.pool?.coin, 0))),
        gold: Math.max(0, Math.floor(num(rawOffline.pool?.gold, 0))),
      },
      // 0 means "never accrued"; the first accrual pass seeds it.
      accruedAt: Math.max(0, Math.round(num(rawOffline.accruedAt, 0))),
      collected: Math.max(0, Math.round(num(rawOffline.collected, 0))),
    }

    // Supplies: clamped to the base cap at load time. The upgrade-aware cap is
    // applied on the first read, because modifiers() needs `save` to exist.
    const rawSupplies = raw.supplies !== undefined && raw.supplies !== null ? raw.supplies : {}
    const supplies = {
      current: clamp(Math.floor(num(rawSupplies.current, SUPPLY_MAX_BASE)), 0, SUPPLY_MAX_BASE),
      regenAt: Math.max(0, Math.round(num(rawSupplies.regenAt, 0))),
    }

    // Backpack rows: unknown item ids are dropped, and each row keeps a sane
    // count. Rows are re-merged by id so a hand-edited save cannot hold two
    // stacks of the same item.
    const packCounts = new Map()
    if (Array.isArray(raw.pack)) {
      for (const row of raw.pack) {
        if (row === null || typeof row !== 'object') continue
        if (typeof row.item !== 'string' || !ALL_ITEM_BY_ID.has(row.item)) continue
        const count = Math.max(0, Math.floor(num(row.count, 0)))
        if (count === 0) continue
        packCounts.set(row.item, (packCounts.get(row.item) ?? 0) + count)
      }
    }
    const pack = [...packCounts.entries()].map(([item, count]) => ({ item, count }))

    const rawExpedition = raw.expedition !== undefined && raw.expedition !== null ? raw.expedition : {}
    const found = {}
    const sold = {}
    for (const item of ITEMS) {
      const f = Math.max(0, Math.round(num(rawExpedition.found?.[item.id], 0)))
      const s = Math.max(0, Math.round(num(rawExpedition.sold?.[item.id], 0)))
      if (f > 0) found[item.id] = f
      if (s > 0) sold[item.id] = s
    }
    const expedition = {
      found,
      sold,
      runs: Math.max(0, Math.round(num(rawExpedition.runs, 0))),
      bestTier: RARITY_ORDER.includes(rawExpedition.bestTier) ? rawExpedition.bestTier : null,
      byDestination: {},
      used: Math.max(0, Math.round(num(rawExpedition.used, 0))),
    }
    for (const destination of EXPEDITIONS) {
      const count = Math.max(0, Math.round(num(rawExpedition.byDestination?.[destination.id], 0)))
      if (count > 0) expedition.byDestination[destination.id] = count
    }

    // An in-flight trip is restored only if it still references a real
    // destination; a trip to a removed place simply ends.
    let trip = null
    if (raw.trip !== null && raw.trip !== undefined && typeof raw.trip === 'object') {
      const destination = EXPEDITION_BY_ID.get(raw.trip.destination)
      if (destination !== undefined) {
        // The gathered bag is sanitised like the pack: unknown ids dropped, counts
        // floored, negatives removed. A corrupt bag must not crash the trip.
        const gathered = {}
        if (raw.trip.gathered !== null && typeof raw.trip.gathered === 'object') {
          for (const [id, count] of Object.entries(raw.trip.gathered)) {
            const amount = Math.max(0, Math.floor(num(count, 0)))
            if (amount > 0 && ALL_ITEM_BY_ID.has(id)) gathered[id] = amount
          }
        }
        trip = {
          destination: destination.id,
          startedAt: Math.max(0, Math.round(num(raw.trip.startedAt, 0))),
          readyAt: Math.max(0, Math.round(num(raw.trip.readyAt, 0))),
          spent: Math.max(0, Math.round(num(raw.trip.spent, 0))),
          gathered,
          gatherReadyAt: Math.max(0, Math.round(num(raw.trip.gatherReadyAt, 0))),
        }
      }
    }

    const buffs = Array.isArray(raw.buffs)
      ? raw.buffs
          .filter(
            (buff) =>
              buff !== null &&
              typeof buff === 'object' &&
              typeof buff.id === 'string' &&
              ['luck', 'fortune', 'haggle'].includes(buff.stat) &&
              Number.isFinite(Number(buff.until)),
          )
          .map((buff) => ({
            id: buff.id,
            label: typeof buff.label === 'string' ? buff.label : buff.id,
            stat: buff.stat,
            amount: Math.max(0, num(buff.amount, 0)),
            until: Math.round(Number(buff.until)),
          }))
      : []

    // Today's quest state. The date key is validated by the caller (rollDaily);
    // here it is only coerced, because "is it still today" is a time question.
    const rawDaily = raw.daily !== undefined && raw.daily !== null ? raw.daily : {}
    const dailyCounters = {}
    if (rawDaily.counters !== null && typeof rawDaily.counters === 'object') {
      for (const [metric, value] of Object.entries(rawDaily.counters)) {
        const amount = Math.max(0, Math.round(num(value, 0)))
        if (amount > 0) dailyCounters[metric] = amount
      }
    }
    const dailyClaimed = {}
    if (rawDaily.claimed !== null && typeof rawDaily.claimed === 'object') {
      for (const [id, at] of Object.entries(rawDaily.claimed)) {
        if (QUEST_BY_ID.has(id)) dailyClaimed[id] = Math.max(0, Math.round(num(at, 0)))
      }
    }
    const daily = {
      key: typeof rawDaily.key === 'string' ? rawDaily.key : '',
      counters: dailyCounters,
      claimed: dailyClaimed,
      allClaimed: rawDaily.allClaimed === true,
    }
    // A lifetime count of fully-cleared quest days. Kept outside `daily` because
    // `daily` is replaced wholesale at every rollover.
    const questAllDays = Math.max(0, Math.round(num(raw.questAllDays, 0)))

    const rawAlchemy = raw.alchemy !== undefined && raw.alchemy !== null ? raw.alchemy : {}
    const alchemyByRecipe = {}
    for (const recipe of RECIPES) {
      const count = Math.max(0, Math.round(num(rawAlchemy.byRecipe?.[recipe.id], 0)))
      if (count > 0) alchemyByRecipe[recipe.id] = count
    }
    const alchemy = {
      runs: Math.max(0, Math.round(num(rawAlchemy.runs, 0))),
      byRecipe: alchemyByRecipe,
    }

    const rawRebirth = raw.rebirth !== undefined && raw.rebirth !== null ? raw.rebirth : {}
    const rebirth = {
      count: Math.max(0, Math.round(num(rawRebirth.count, 0))),
      bestLevel: Math.max(1, Math.round(num(rawRebirth.bestLevel, 1))),
    }

    // 星盘 levels are clamped to each definition's max, like the shop upgrades.
    const starUpgrades = {}
    const rawStar = raw.starUpgrades !== undefined && raw.starUpgrades !== null ? raw.starUpgrades : {}
    for (const definition of STAR_UPGRADES) {
      const level = Math.max(0, Math.round(num(rawStar[definition.id], 0)))
      starUpgrades[definition.id] = Math.min(level, definition.max)
    }

    /**
     * The farm.
     *
     * A plot on disk is trusted only as far as it can be checked: an unknown crop
     * or a malformed record becomes an empty plot rather than a crash, and the
     * plot COUNT is clamped to the legal range so a hand-edited save cannot grant
     * itself a hundred plots. Growth timing is re-derived from `plantedAt` on read
     * (see `plotState`), so a stalled clock cannot fake a harvest.
     */
    const rawFarm = raw.farm !== undefined && raw.farm !== null ? raw.farm : {}
    const rawPlots = Array.isArray(rawFarm.plots) ? rawFarm.plots : []
    const plots = []
    const plotCount = Math.min(FARM_PLOTS_MAX, Math.max(FARM_PLOTS_BASE, rawPlots.length))
    for (let i = 0; i < plotCount; i += 1) {
      const source = rawPlots[i]
      if (source === null || source === undefined || typeof source !== 'object') {
        plots.push(null)
        continue
      }
      const crop = CROP_BY_ID.get(source.crop)
      if (crop === undefined) {
        plots.push(null)
        continue
      }
      const ailments = Array.isArray(source.ailments)
        ? [...new Set(source.ailments.filter((id) => AILMENT_BY_ID.has(id)))]
        : []
      plots.push({
        crop: crop.id,
        plantedAt: Math.max(0, Math.round(num(source.plantedAt, 0))),
        /**
         * Growth banked so far, as a fraction of the crop's `needMs`.
         *
         * Materialized by `settlePlot` rather than derived purely from
         * `plantedAt`, because ailments and watering change the growth RATE over
         * time — the plot's history matters, not just its start time.
         */
        progress: Math.min(1, Math.max(0, num(source.progress, 0))),
        /** When `progress` was last materialized. */
        settleAt: Math.max(0, Math.round(num(source.settleAt, 0))),
        /** How many growth milestones have been rolled for an ailment. */
        checks: Math.max(0, Math.round(num(source.checks, 0))),
        wateredUntil: Math.max(0, Math.round(num(source.wateredUntil, 0))),
        ailments,
      })
    }
    const farmByCrop = {}
    for (const crop of CROPS) {
      const count = Math.max(0, Math.round(num(rawFarm.byCrop?.[crop.id], 0)))
      if (count > 0) farmByCrop[crop.id] = count
    }
    const farm = {
      plots,
      harvested: Math.max(0, Math.round(num(rawFarm.harvested, 0))),
      byCrop: farmByCrop,
      tended: Math.max(0, Math.round(num(rawFarm.tended, 0))),
    }

    /**
     * The mine.
     *
     * Depth is clamped to what the player has actually unlocked, since the
     * ingoing save may predate the upgrade that bought it. Stamina is clamped to
     * the CURRENT maximum (recomputed after `save` exists, because 强身 raises it).
     */
    const rawMine = raw.mine !== undefined && raw.mine !== null ? raw.mine : {}
    const mineUpgrades = {}
    const rawMineUpgrades = rawMine.upgrades !== undefined && rawMine.upgrades !== null ? rawMine.upgrades : {}
    for (const definition of MINER_UPGRADES) {
      const level = Math.max(0, Math.round(num(rawMineUpgrades[definition.id], 0)))
      mineUpgrades[definition.id] = Math.min(level, definition.max)
    }
    const unlockedDepth = 1 + (mineUpgrades.depth ?? 0)
    const staminaCap = STAMINA_MAX_BASE + (mineUpgrades.stamina ?? 0) * 2

    const swingBuffer = {}
    if (rawMine.bufferedSwing !== null && typeof rawMine.bufferedSwing === 'object') {
      for (const [id, value] of Object.entries(rawMine.bufferedSwing)) {
        const amount = Math.max(0, Math.floor(num(value, 0)))
        if (amount > 0 && ORE_BY_ID.has(id)) swingBuffer[id] = amount
      }
    }

    const miners = {}
    for (const definition of MINERS) {
      const rawEntry = rawMine.miners?.[definition.id]
      const heads = rawEntry !== null && rawEntry !== undefined && typeof rawEntry === 'object' ? rawEntry : {}
      const buffered = {}
      if (heads.buffered !== null && typeof heads.buffered === 'object') {
        for (const [id, value] of Object.entries(heads.buffered)) {
          const amount = Math.max(0, Math.floor(num(value, 0)))
          if (amount > 0 && ORE_BY_ID.has(id)) buffered[id] = amount
        }
      }
      miners[definition.id] = {
        // 0 means "not hired"; a negative or absurd value is clamped to 0 so a
        // corrupt save cannot leave a permanently-running miner.
        endsAt: Math.max(0, Math.round(num(heads.endsAt, 0))),
        buffered,
      }
    }

    const rawMineStats = rawMine.stats !== undefined && rawMine.stats !== null ? rawMine.stats : {}
    const mine = {
      depth: Math.min(MINE_DEPTH_MAX, Math.max(1, Math.round(num(rawMine.depth, 1)))),
      stamina: Math.min(staminaCap, Math.max(0, Math.round(num(rawMine.stamina, staminaCap)))),
      // 0 seeds the regen clock on first read, so an old save does not bank
      // stamina for every hour since its birth.
      staminaAt: Math.max(0, Math.round(num(rawMine.staminaAt, 0))),
      upgrades: mineUpgrades,
      // A vein referencing a removed id, or one that is already exhausted, is
      // dropped rather than resurfacing as an undoable block.
      vein:
        rawMine.vein !== null && rawMine.vein !== undefined && typeof rawMine.vein === 'object' && ORE_BY_ID.has(rawMine.vein.ore)
          ? {
              ore: rawMine.vein.ore,
              // Remaining is derived from `total` and `mined` so the two can
              // never disagree after a hand edit.
              total: Math.max(1, Math.round(num(rawMine.vein.total, 10))),
              mined: Math.max(0, Math.round(num(rawMine.vein.mined, 0))),
            }
          : null,
      bufferedSwing: swingBuffer,
      miners,
      stats: {
        swings: Math.max(0, Math.round(num(rawMineStats.swings, 0))),
        veins: Math.max(0, Math.round(num(rawMineStats.veins, 0))),
        collected: Math.max(0, Math.round(num(rawMineStats.collected, 0))),
        oresMined: Math.max(0, Math.round(num(rawMineStats.oresMined, 0))),
        deepest: Math.min(unlockedDepth, Math.max(1, Math.round(num(rawMineStats.deepest, 1)))),
        hiredTotal: Math.max(0, Math.round(num(rawMineStats.hiredTotal, 0))),
        /**
         * Per-ore lifetime counts, so the codex can distinguish "level 18 has
         * 星石 in its table" from "you have actually ever found one".
         */
        byOre: (() => {
          const out = {}
          const source = rawMineStats.byOre
          if (source !== null && typeof source === 'object') {
            for (const [id, count] of Object.entries(source)) {
              const amount = Math.max(0, Math.floor(num(count, 0)))
              if (amount > 0 && ORE_BY_ID.has(id)) out[id] = amount
            }
          }
          return out
        })(),
        lastStamina: Math.max(-1, Math.round(num(rawMineStats.lastStamina, -1))),
      },
    }
    // A depth beyond what was unlocked falls back to the deepest legal layer.
    if (mine.depth > unlockedDepth) mine.depth = unlockedDepth

    /**
     * 钓鱼.
     *
     * A cast on disk resumes only if it still makes sense: the spot and species
     * must exist and the deadlines must be finite. Anything else becomes null,
     * which reads as "nothing in the water" — the safe state, because a stale
     * cast would otherwise let a player strike a fish picked by a previous build.
     */
    const rawFishing = raw.fishing !== undefined && raw.fishing !== null ? raw.fishing : {}
    const fishingByFish = {}
    if (rawFishing.byFish !== null && typeof rawFishing.byFish === 'object') {
      for (const [id, count] of Object.entries(rawFishing.byFish)) {
        const amount = Math.max(0, Math.floor(num(count, 0)))
        if (amount > 0 && FISH_BY_ID.has(id)) fishingByFish[id] = amount
      }
    }
    const fishingBySpot = {}
    if (rawFishing.bySpot !== null && typeof rawFishing.bySpot === 'object') {
      for (const [id, count] of Object.entries(rawFishing.bySpot)) {
        const amount = Math.max(0, Math.floor(num(count, 0)))
        if (amount > 0 && FISHING_SPOT_BY_ID.has(id)) fishingBySpot[id] = amount
      }
    }
    const rawCast = rawFishing.cast
    const castOk =
      rawCast !== null &&
      rawCast !== undefined &&
      typeof rawCast === 'object' &&
      FISH_BY_ID.has(rawCast.fish) &&
      FISHING_SPOT_BY_ID.has(rawCast.spot) &&
      Number.isFinite(Number(rawCast.biteAt)) &&
      Number.isFinite(Number(rawCast.strikeDeadline))
    const fishing = {
      rods: (() => {
        if (Array.isArray(rawFishing.rods) && rawFishing.rods.some((id) => ROD_BY_ID.has(id))) {
          return rawFishing.rods.filter((id) => ROD_BY_ID.has(id))
        }
        const legacy = rawFishing.rod
        return ROD_BY_ID.has(legacy) ? [legacy] : ['twig']
      })(),
      activeRod: (() => {
        const candidate = rawFishing.activeRod ?? rawFishing.rod
        return ROD_BY_ID.has(candidate) ? candidate : 'twig'
      })(),
      spot: FISHING_SPOT_BY_ID.has(rawFishing.spot) ? rawFishing.spot : 'pond',
      cast: castOk
        ? {
            state: rawCast.state === 'biting' ? 'biting' : 'waiting',
            biteAt: Math.max(0, Math.round(num(rawCast.biteAt, 0))),
            strikeDeadline: Math.max(0, Math.round(num(rawCast.strikeDeadline, 0))),
            fish: rawCast.fish,
            spot: rawCast.spot,
          }
        : null,
      cooldownUntil: Math.max(0, Math.round(num(rawFishing.cooldownUntil, 0))),
      caught: Math.max(0, Math.round(num(rawFishing.caught, 0))),
      escaped: Math.max(0, Math.round(num(rawFishing.escaped, 0))),
      byFish: fishingByFish,
      bySpot: fishingBySpot,
      bestRarity: Math.max(-1, Math.min(3, Math.round(num(rawFishing.bestRarity, -1)))),
    }

    /**
     * 开店.
     *
     * `mode` must survive exactly: it is a permanent choice, so an unknown value
     * becomes null (unanswered) rather than being coerced to one side.
     */
    const rawShop = raw.shop !== undefined && raw.shop !== null ? raw.shop : {}
    const shopStock = {}
    for (const product of SHOP_PRODUCTS) {
      shopStock[product.id] = Math.max(0, Math.round(num(rawShop.stock?.[product.id], 0)))
    }
    const shopMachines = {}
    for (const machine of SHOP_MACHINES) {
      const source = rawShop.machines?.[machine.id]
      const buffered = {}
      if (source !== undefined && source !== null && typeof source.buffered === 'object' && source.buffered !== null) {
        for (const [id, count] of Object.entries(source.buffered)) {
          const amount = Math.max(0, Math.floor(num(count, 0)))
          if (amount > 0 && SHOP_PRODUCT_BY_ID.has(id)) buffered[id] = amount
        }
      }
      shopMachines[machine.id] = {
        endsAt: Math.max(0, Math.round(num(source?.endsAt, 0))),
        buffered,
      }
    }
    const shopByProduct = {}
    if (rawShop.byProduct !== null && typeof rawShop.byProduct === 'object') {
      for (const [id, count] of Object.entries(rawShop.byProduct)) {
        const amount = Math.max(0, Math.floor(num(count, 0)))
        if (amount > 0 && SHOP_PRODUCT_BY_ID.has(id)) shopByProduct[id] = amount
      }
    }
    const shop = {
      mode: SHOP_MODE_BY_ID.has(rawShop.mode) ? rawShop.mode : null,
      chosenAt: Math.max(0, Math.round(num(rawShop.chosenAt, 0))),
      modeSwitches: Math.max(0, Math.round(num(rawShop.modeSwitches, 0))),
      reputation: Math.max(0, Math.round(num(rawShop.reputation, 0))),
      stock: shopStock,
      machines: shopMachines,
      sales: Math.max(0, Math.round(num(rawShop.sales, 0))),
      revenue: {
        coin: Math.max(0, Math.round(num(rawShop.revenue?.coin, 0))),
        gold: Math.max(0, Math.round(num(rawShop.revenue?.gold, 0))),
      },
      manualSales: Math.max(0, Math.round(num(rawShop.manualSales, 0))),
      autoSales: Math.max(0, Math.round(num(rawShop.autoSales, 0))),
      machinesBought: Math.max(0, Math.round(num(rawShop.machinesBought, 0))),
      byProduct: shopByProduct,
      lastManualAt: Math.max(0, Math.round(num(rawShop.lastManualAt, 0))),
      streak: Math.max(0, Math.round(num(rawShop.streak, 0))),
      bestStreak: Math.max(0, Math.round(num(rawShop.bestStreak, 0))),
    }

    return {
      version: SAVE_VERSION,
      bornAt: Math.max(0, Math.round(num(raw.bornAt, 0))),
      lastSeenAt: Math.max(0, Math.round(num(raw.lastSeenAt, 0))),
      currencies,
      earned,
      periods,
      achievements,
      stats,
      upgrades,
      chests,
      offline,
      supplies,
      pack,
      expedition,
      trip,
      buffs,
      daily,
      questAllDays,
      alchemy,
      rebirth,
      starUpgrades,
      farm,
      mine,
      fishing,
      shop,
      history,
    }
  }

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      // Written through a temp file: a crash mid-write must not truncate a save
      // the user has been building for months.
      const temp = `${savePath}.tmp-${process.pid}`
      fs.writeFileSync(temp, `${JSON.stringify(save, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, savePath)
      return true
    } catch (error) {
      logger.warn?.(`checkin: 存档无法写入：${messageOf(error)}`)
      return false
    }
  }

  // ── availability ──────────────────────────────────────────────────────────

  /**
   * Whether a period can be claimed right now, plus when it opens again.
   *
   * Interval periods compare elapsed milliseconds; calendar periods compare
   * bucket keys, so a "day" ends at the user's local midnight rather than 24
   * hours after their previous click.
   */
  function availabilityOf(period, now) {
    const state = save.periods[period.key]
    if (period.intervalMs !== undefined) {
      const readyAt = state.lastAt === 0 ? 0 : state.lastAt + period.intervalMs
      const remaining = Math.max(0, readyAt - now)
      return { ready: remaining === 0, readyAt: readyAt || now, remaining }
    }
    const key = bucketKey(period.calendar, new Date(now))
    const ready = state.lastKey !== key
    // The next boundary is the start of the next bucket.
    const next = new Date(now)
    if (period.calendar === 'day') next.setHours(24, 0, 0, 0)
    else if (period.calendar === 'week') {
      const dayNumber = (next.getDay() + 6) % 7
      next.setDate(next.getDate() - dayNumber + 7)
      next.setHours(0, 0, 0, 0)
    } else if (period.calendar === 'quarter') {
      // First day of the next quarter.
      next.setMonth(Math.floor(next.getMonth() / 3) * 3 + 3, 1)
      next.setHours(0, 0, 0, 0)
    } else {
      next.setMonth(next.getMonth() + 1, 1)
      next.setHours(0, 0, 0, 0)
    }
    return { ready, readyAt: ready ? now : next.getTime(), remaining: ready ? 0 : next.getTime() - now }
  }

  // ── upgrade effects ───────────────────────────────────────────────────────

  /**
   * The multiplier an upgrade applies, derived from its purchased level.
   *
   * Read through this rather than touching `save.upgrades` directly, so the
   * effect of a level lives in exactly one place.
   */
  function upgradeLevel(id) {
    return save.upgrades[id] ?? 0
  }

  /** A purchased 星盘 level; these survive rebirth, unlike `save.upgrades`. */
  function starLevel(id) {
    return save.starUpgrades[id] ?? 0
  }

  /**
   * Modifiers, resolved once per call from the purchased levels.
   *
   * `yields` is per period: a claim's base reward is multiplied by both the
   * streak multiplier and its period's yield multiplier. `luck` shifts the
   * chance of a bonus drop. `grace` widens the missed-slot tolerance.
   */
  function modifiers() {
    const yields = {}
    let luck = 0
    let grace = 0
    let offlineRate = 1
    let offlineCapHours = OFFLINE_BASE_CAP_HOURS
    let supplyCap = SUPPLY_MAX_BASE
    let packSize = PACK_SIZE_BASE
    let swift = 0
    let fortune = 0
    let haggle = 1
    let thrift = 0

    for (const definition of UPGRADES) {
      const level = upgradeLevel(definition.id)
      if (level === 0) continue
      if (definition.effect === 'yield') {
        yields[definition.period] = (yields[definition.period] ?? 1) + level * definition.step
      } else if (definition.effect === 'luck') {
        luck += level * definition.step
      } else if (definition.effect === 'grace') {
        grace += level * definition.step
      } else if (definition.effect === 'offlineRate') {
        offlineRate += level * definition.step
      } else if (definition.effect === 'offlineCap') {
        offlineCapHours += level * definition.step
      } else if (definition.effect === 'supplyCap') {
        supplyCap += level * definition.step
      } else if (definition.effect === 'packSize') {
        packSize += level * definition.step
      } else if (definition.effect === 'swift') {
        swift += level * definition.step
      } else if (definition.effect === 'fortune') {
        fortune += level * definition.step
      } else if (definition.effect === 'haggle') {
        haggle += level * definition.step
      } else if (definition.effect === 'thrift') {
        thrift += level * definition.step
      }
    }

    // Active item buffs stack on top of the permanent upgrades. They are stored
    // with an expiry so a buff cannot outlive its stated duration across
    // restarts.
    const now = Date.now()
    for (const buff of save.buffs) {
      if (buff.until <= now) continue
      if (buff.stat === 'luck') luck += buff.amount
      else if (buff.stat === 'fortune') fortune += buff.amount
      else if (buff.stat === 'haggle') haggle += buff.amount
    }

    /**
     * 星盘 effects, applied LAST so they multiply the finished totals.
     *
     * `starYield` is kept separate from the per-period `yields` map rather than
     * folded into it: it applies to EVERY period, and multiplying at the end means
     * a future period added to the game inherits it automatically.
     */
    let starYield = 1
    let startGold = 0
    for (const definition of STAR_UPGRADES) {
      const level = starLevel(definition.id)
      if (level === 0) continue
      if (definition.effect === 'starYield') starYield += level * definition.step
      else if (definition.effect === 'starOffline') offlineRate += level * definition.step
      else if (definition.effect === 'starLuck') luck += level * definition.step
      else if (definition.effect === 'starFortune') fortune += level * definition.step
      else if (definition.effect === 'starStart') startGold += level * definition.step
      else if (definition.effect === 'starPack') packSize += level * definition.step
    }

    /**
     * Settings, folded in LAST so they read as "player overrides" on top of every
     * earned and purchased bonus. Keeping them additive/multiplicative here (and
     * not scattered through the reward code) is what makes a knob take effect
     * everywhere at once without touching each call site.
     */
    luck += settings.luckBonus
    fortune += settings.lootQuality
    offlineRate *= settings.offlineMultiplier
    starYield *= settings.rewardMultiplier

    return {
      yields,
      luck,
      grace,
      offlineRate,
      offlineCapHours,
      supplyCap,
      packSize,
      swift,
      fortune,
      haggle,
      thrift,
      starYield,
      startGold,
      /** Farm knobs, read by the growth and ailment code. */
      cropSpeed: settings.cropSpeed,
      ailmentRate: settings.ailmentRate,
      supplyRegenMultiplier: settings.supplyRegenMultiplier,
    }
  }

  /** Drop expired buffs. Called wherever buffs are read for display or effect. */
  function pruneBuffs(now = Date.now()) {
    const before = save.buffs.length
    save.buffs = save.buffs.filter((buff) => buff.until > now)
    return before !== save.buffs.length
  }

  // ── offline earnings ──────────────────────────────────────────────────────

  /**
   * Bring the offline pool up to the present.
   *
   * Called before every read and every mutation, and measured from an absolute
   * timestamp so time the process spent closed is accounted for exactly once —
   * the same discipline the pet plugin uses for decay. The pool stops growing at
   * the cap; it does not reset, so an over-long absence still pays the maximum.
   */
  function accrual(now = Date.now()) {
    const mods = modifiers()
    // First run, or a save from before this feature: start the clock here rather
    // than paying out for time that was never governed by these rates.
    if (save.offline.accruedAt === 0) {
      save.offline.accruedAt = now
      return { gained: { coin: 0, gold: 0 }, hours: 0, cappedAt: mods.offlineCapHours }
    }

    const elapsedHours = Math.max(0, (now - save.offline.accruedAt) / 3_600_000)
    if (elapsedHours <= 0) return { gained: { coin: 0, gold: 0 }, hours: 0, cappedAt: mods.offlineCapHours }

    // Effective hours are capped, but the clock always advances to `now`: an
    // absence longer than the cap simply wastes the remainder.
    const effectiveHours = Math.min(elapsedHours, mods.offlineCapHours)
    const gained = {}
    for (const [key, perHour] of Object.entries(OFFLINE_BASE_PER_HOUR)) {
      const value = Math.max(0, Math.floor(perHour * mods.offlineRate * effectiveHours))
      gained[key] = value
      // The cap applies to the POOL, not to a single accrual, so a pool that is
      // already full simply stops growing.
      const ceiling = Math.floor(
        OFFLINE_BASE_PER_HOUR[key] * mods.offlineRate * mods.offlineCapHours,
      )
      save.offline.pool[key] = Math.min(ceiling, save.offline.pool[key] + value)
    }

    save.offline.accruedAt = now
    return { gained, hours: effectiveHours, cappedAt: mods.offlineCapHours }
  }

  /** Collect the offline pool into held currency. */
  function collectOffline(now = Date.now()) {
    accrual(now)
    const granted = {}
    let any = false
    for (const [key, value] of Object.entries(save.offline.pool)) {
      if (value <= 0) continue
      granted[key] = value
      save.currencies[key] = (save.currencies[key] ?? 0) + value
      save.earned[key] = (save.earned[key] ?? 0) + value
      any = true
    }
    if (!any) throw new Error('还没有攒下离线收益')

    const total = Object.values(granted).reduce((sum, value) => sum + value, 0)
    save.offline.pool = { coin: 0, gold: 0 }
    save.offline.collected += 1
    save.offline.accruedAt = now

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'offline',
      label: '离线收益',
      granted,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { granted, total, unlocked }
  }

  // ── supplies ──────────────────────────────────────────────────────────────

  /**
   * Bring supplies up to the present.
   *
   * Regeneration is measured from an absolute timestamp and applied in whole
   * ticks, so time the process spent closed is credited exactly once — the same
   * discipline the offline pool uses. It also means supplies can never dead-end:
   * even with nothing to eat, waiting refills them.
   */
  function regenSupplies(now = Date.now()) {
    const mods = modifiers()
    const cap = mods.supplyCap
    if (save.supplies.regenAt === 0) save.supplies.regenAt = now
    if (save.supplies.current >= cap) {
      // Full: keep the clock current so the next spend starts a fresh tick.
      save.supplies.regenAt = now
      return 0
    }

    /**
     * The tick length shrinks as the player speeds regen up.
     *
     * Implemented by dividing the INTERVAL rather than by crediting multiple
     * ticks, because the save stores an absolute `regenAt` — scaling the interval
     * keeps that timestamp meaningful, whereas multiplying the gain would make the
     * stored clock imply a rate that no longer matches the setting.
     */
    const tickMs = Math.max(1_000, SUPPLY_REGEN_MS / Math.max(0.01, mods.supplyRegenMultiplier))
    const elapsed = now - save.supplies.regenAt
    if (elapsed < tickMs) return 0

    const ticks = Math.floor(elapsed / tickMs)
    const gained = Math.min(ticks, cap - save.supplies.current)
    save.supplies.current += gained
    // Advance by whole ticks only, so partial progress is never lost.
    save.supplies.regenAt += ticks * tickMs
    if (save.supplies.current >= cap) save.supplies.regenAt = now
    return gained
  }

  // ── backpack ──────────────────────────────────────────────────────────────

  /**
   * Add one item to the pack, merging into an existing stack.
   *
   * `wild` distinguishes something FOUND (an expedition haul) from something
   * PRODUCED (a harvest or an alchemy output). Only wild finds feed the
   * expedition codex, because "I grew this" is not evidence about what the abyss
   * contains — and letting a 萝卜 count as a discovered species would corrupt the
   * collection progress the codex exists to show.
   */
  function addToPack(itemId, count = 1, { wild = false } = {}) {
    const row = save.pack.find((entry) => entry.item === itemId)
    if (row === undefined) save.pack.push({ item: itemId, count })
    else row.count += count

    if (!wild) return
    save.expedition.found[itemId] = (save.expedition.found[itemId] ?? 0) + count
    const item = ALL_ITEM_BY_ID.get(itemId)
    if (item !== undefined) {
      const current = save.expedition.bestTier
      if (current === null || RARITY_ORDER.indexOf(item.rarity) > RARITY_ORDER.indexOf(current)) {
        save.expedition.bestTier = item.rarity
      }
    }
  }

  /**
   * How much of the backpack is in use.
   *
   * Measured in ITEMS, not in distinct stacks. Counting stacks would make the
   * cap unreachable — there are only 13 kinds of item, so a 20-slot pack could
   * never fill, `leftBehind` could never fire, and the 背包扩容 upgrade would buy
   * nothing. A backpack holds N things.
   */
  function packUsed() {
    return save.pack.reduce((sum, row) => sum + row.count, 0)
  }

  // ── expeditions ───────────────────────────────────────────────────────────

  /** The supply cost of a destination after the 节俭 discount (never below 1). */
  function tripCost(destination) {
    return Math.max(1, destination.supply - modifiers().thrift)
  }

  /**
   * Depart on a trip.
   *
   * Supplies are spent up front and the return time is stamped into the save, so
   * closing DSH mid-trip does not cancel it — the trip is durable, exactly like
   * the offline pool.
   */
  function depart(destinationId, now = Date.now()) {
    if (save.trip !== null) {
      const remaining = Math.max(0, save.trip.readyAt - now)
      throw new Error(`你还在外面（还有 ${formatDuration(Math.ceil(remaining / 1000))} 回来）`)
    }

    const destination = EXPEDITION_BY_ID.get(destinationId)
    if (destination === undefined) throw new Error(`没有这个地方：${destinationId}`)

    regenSupplies(now)
    const cost = tripCost(destination)
    if (save.supplies.current < cost) {
      const missing = cost - save.supplies.current
      // Tell the user how to proceed, not just that they failed.
      const waitMs = missing * SUPPLY_REGEN_MS
      throw new Error(
        `物资不够：需要 ${cost}，只有 ${save.supplies.current}。等待约 ${formatDuration(
          Math.ceil(waitMs / 1000),
        )}，或用「药草 / 干粮 / 灵药」补充`,
      )
    }

    const mods = modifiers()
    // The 快靴 upgrade shortens the trip; a floor keeps it from reaching zero.
    const hours = Math.max(0.05, destination.hours * (1 - mods.swift))
    save.supplies.current -= cost
    // A spend from a full bar must start a fresh regen tick.
    if (save.supplies.regenAt === 0) save.supplies.regenAt = now

    save.trip = {
      destination: destination.id,
      startedAt: now,
      readyAt: now + Math.round(hours * 3_600_000),
      spent: cost,
      // A trip-local bag: gathered finds live here until 返回 or the scheduled
      // return merges them into the pack.
      gathered: {},
      gatherReadyAt: 0,
    }

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'depart',
      label: destination.label,
      destination: destination.id,
      spent: cost,
      hours,
    })

    persist()
    return { destination: destination.id, label: destination.label, readyAt: save.trip.readyAt, spent: cost, hours }
  }

  /**
   * Pick a rarity tier, then an item of that tier.
   *
   * Two steps rather than one flat table: it lets an upgrade or a buff shift the
   * whole tier distribution (the `rarityShift` on a destination and the 寻宝罗盘
   * both act here) without touching each item's weight.
   */
  function rollItem(tierWeights, shift) {
    const entries = []
    for (const tier of RARITY_ORDER) {
      if (ITEMS_BY_RARITY.get(tier) === undefined) continue
      // Shift moves weight from common toward legendary. Each point of shift
      // multiplies the tier's distance from the middle.
      const base = tierWeights[tier] ?? 0
      const index = RARITY_ORDER.indexOf(tier)
      const factor = Math.max(0.05, 1 + shift * (index - 1) * 0.34)
      const weight = base * factor
      if (weight > 0) entries.push({ tier, weight })
    }

    const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
    let roll = Math.random() * total
    let chosen = entries[entries.length - 1]
    for (const entry of entries) {
      roll -= entry.weight
      if (roll <= 0) {
        chosen = entry
        break
      }
    }

    const pool = ITEMS_BY_RARITY.get(chosen.tier)
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /**
   * Collect a finished trip: roll the loot into the pack.
   *
   * Capacity is checked before each find, so a small backpack loses the overflow
   * rather than silently exceeding its limit — and the result reports what was
   * left behind, so the loss is visible instead of mysterious.
   */
  function collectTrip(now = Date.now()) {
    if (save.trip === null) throw new Error('你现在在家，没有进行中的行程')

    const remaining = save.trip.readyAt - now
    if (remaining > 0) {
      throw new Error(`还没回来，还要 ${formatDuration(Math.ceil(remaining / 1000))}`)
    }

    const destination = EXPEDITION_BY_ID.get(save.trip.destination)
    const mods = modifiers()
    const capacity = mods.packSize

    const [minDrops, maxDrops] = destination.drops
    const dropCount = minDrops + Math.floor(Math.random() * (maxDrops - minDrops + 1))
    // Destination bias and permanent fortune both nudge the tier distribution.
    const shift = destination.rarityShift + mods.fortune

    const found = []
    const leftBehind = []
    // Capacity counts items, so a stack that already exists can still grow into
    // room — only NEW items can be refused for lack of space.
    let used = packUsed()
    for (let i = 0; i < dropCount; i += 1) {
      const item = rollItem(destination.table, shift)
      if (used >= capacity) {
        leftBehind.push(item.id)
        continue
      }
      // `wild: true` — this IS an expedition haul, so it feeds the codex.
      addToPack(item.id, 1, { wild: true })
      found.push(item.id)
      used += 1
    }

    save.expedition.runs += 1
    const destinationId = save.trip.destination
    save.expedition.byDestination[destinationId] = (save.expedition.byDestination[destinationId] ?? 0) + 1
    save.trip = null
    bumpDaily('trips', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'return',
      label: destination.label,
      destination: destinationId,
      found,
      leftBehind,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { destination: destinationId, label: destination.label, found, leftBehind, unlocked }
  }

  // ── mid-trip actions ──────────────────────────────────────────────────────

  /** The trip payload, extended with what the camp can do right now. */
  function tripSnapshot(now = Date.now()) {
    if (save.trip === null) return null
    const destination = EXPEDITION_BY_ID.get(save.trip.destination)
    const remaining = Math.max(0, save.trip.readyAt - now)
    return {
      destination: save.trip.destination,
      label: destination?.label ?? save.trip.destination,
      startedAt: save.trip.startedAt,
      readyAt: save.trip.readyAt,
      spent: save.trip.spent,
      remainingMs: remaining,
      ready: remaining === 0,
      /** Anything already gathered on this trip, summed by id. */
      gathered: { ...(save.trip.gathered ?? {}) },
      gatheredTotal: Object.values(save.trip.gathered ?? {}).reduce((sum, n) => sum + n, 0),
      /** Whether 采集 is cooling down. */
      gatherReadyAt: save.trip.gatherReadyAt ?? 0,
      gatherReady: (save.trip.gatherReadyAt ?? 0) <= now,
      gatherIn: Math.max(0, Math.round(((save.trip.gatherReadyAt ?? 0) - now) / 1000)),
      /** Whether 睡觉 has supplies to spend. */
      sleepReady: save.supplies.current >= (TRIP_ACTION_BY_ID.get('sleep')?.supplies ?? 0),
    }
  }

  function requireTrip() {
    const trip = save.trip
    if (trip === null) throw new Error('你现在在家，没有进行中的行程')
    return trip
  }

  /**
   * 睡觉 — skip ahead through the trip.
   *
   * It advances `readyAt` by at most `advance` of the REMAINING time, so sleeping
   * repeatedly approaches the return without ever crossing it in one action. The
   * scheduled return therefore still matters, and there is no way to sleep your
   * way past the wait entirely — you pay supplies and get most of the way there.
   */
  function tripSleep(now = Date.now()) {
    const trip = requireTrip()
    const action = TRIP_ACTION_BY_ID.get('sleep')
    const remaining = Math.max(0, trip.readyAt - now)
    if (remaining === 0) throw new Error('已经回来了，去收取吧')

    regenSupplies(now)
    if (save.supplies.current < action.supplies) {
      throw new Error(`睡觉需要 ${action.supplies} 物资，现在只有 ${save.supplies.current}`)
    }
    save.supplies.current -= action.supplies
    if (save.supplies.regenAt === 0) save.supplies.regenAt = now

    // Never advances past the finish: the last stretch is always waited out.
    const skipped = Math.floor(remaining * action.advance)
    trip.readyAt = Math.max(now, trip.readyAt - skipped)

    regenStamina(now)
    const before = save.mine.stamina
    save.mine.stamina = Math.min(mineMods().staminaCap, save.mine.stamina + action.stamina)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'trip-sleep',
      label: '睡觉',
      skipped,
      supplies: action.supplies,
      stamina: save.mine.stamina - before,
    })

    persist()
    return { skipped, remaining: Math.max(0, trip.readyAt - now), stamina: save.mine.stamina, supplies: save.supplies.current }
  }

  /** Roll one foraged find by weight. */
  function rollForage() {
    const total = FORAGE.reduce((sum, entry) => sum + entry.w, 0)
    let roll = Math.random() * total
    for (const entry of FORAGE) {
      roll -= entry.w
      if (roll <= 0) return entry
    }
    return FORAGE[FORAGE.length - 1]
  }

  /**
   * 采集 — gather near the camp.
   *
   * Free (no stamina, no supplies) but weak by design: mostly 石头 and 木棍, with
   * 铁锭 uncommon and anything better rare. It gives the wait something to do
   * without making camping more profitable than arriving — the trip's own loot
   * roll remains the reason to let it finish.
   *
   * Finds go into a trip-local bag rather than the pack, so a full backpack cannot
   * silently swallow them; they enter the pack only on 返回 (or on the normal
   * return, which merges them in).
   */
  function tripGather(now = Date.now()) {
    const trip = requireTrip()
    const action = TRIP_ACTION_BY_ID.get('gather')
    if ((trip.gatherReadyAt ?? 0) > now) {
      const wait = Math.ceil(((trip.gatherReadyAt ?? 0) - now) / 1000)
      throw new Error(`刚采过，还要等 ${formatDuration(wait)}`)
    }

    const [min, max] = FORAGE_ROLLS
    const rolls = min + Math.floor(Math.random() * (max - min + 1))
    // The bag is bounded, so camping forever cannot hoard without bound.
    const bagCap = 40 + mineMods().packCap
    const used = Object.values(trip.gathered ?? {}).reduce((sum, n) => sum + n, 0)

    const found = {}
    let lost = 0
    for (let i = 0; i < rolls; i += 1) {
      if (used + Object.values(found).reduce((s, n) => s + n, 0) >= bagCap) {
        lost += 1
        continue
      }
      const entry = rollForage()
      found[entry.id] = (found[entry.id] ?? 0) + 1
    }
    trip.gathered = { ...(trip.gathered ?? {}) }
    for (const [id, count] of Object.entries(found)) {
      trip.gathered[id] = (trip.gathered[id] ?? 0) + count
    }
    trip.gatherReadyAt = now + (action.cooldownMs ?? 0)

    bumpDaily('gathered', Object.values(found).reduce((s, n) => s + n, 0), now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'trip-gather',
      label: '采集',
      found,
      lost,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { found, lost, gatheredTotal: Object.values(trip.gathered).reduce((s, n) => s + n, 0) }
  }

  /**
   * 返回 — cut the trip short and go home with what is in the bag.
   *
   * `confirm` must be true to actually fire; the UI arms it first. That is not
   * decoration: arriving early FORFEITS the destination's own loot roll, which is
   * the entire point of a long trip, and losing it to a misclick would be a real
   * loss with no way back.
   */
  function tripReturnHome(now = Date.now(), { confirm = false } = {}) {
    const trip = requireTrip()
    if (!confirm) {
      return {
        armed: true,
        warning: '提前返回会放弃这一趟行程的战利品（只带走已经采集到的东西），确定吗？',
      }
    }

    const destination = EXPEDITION_BY_ID.get(trip.destination)
    const gathered = { ...(trip.gathered ?? {}) }
    const destinationId = trip.destination

    // Anything gathered goes into the pack; the scheduled loot roll is skipped.
    const capacity = modifiers().packSize
    let used = packUsed()
    const stored = {}
    let lost = 0
    for (const [id, count] of Object.entries(gathered)) {
      for (let i = 0; i < count; i += 1) {
        if (used >= capacity) {
          lost += 1
          continue
        }
        addToPack(id, 1)
        used += 1
        stored[id] = (stored[id] ?? 0) + 1
      }
    }

    // The run is still recorded as a run — you went out and came back — but no
    // destination loot is rolled, and no codex entry is added for it.
    save.expedition.runs += 1
    save.expedition.byDestination[destinationId] = (save.expedition.byDestination[destinationId] ?? 0) + 1
    save.trip = null
    bumpDaily('trips', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'return-early',
      label: destination?.label ?? destinationId,
      destination: destinationId,
      stored,
      lost,
      forfeited: true,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { forfeited: true, stored, lost, unlocked }
  }

  /**
   * Sell one item from the pack.
   *
   * `haggle` multiplies the base price, and the multiplier is reported so the UI
   * can show what the upgrade is worth.
   */
  function sellItem(itemId, count = 1, now = Date.now()) {
    const item = ALL_ITEM_BY_ID.get(itemId)
    if (item === undefined) throw new Error(`没有这个物品：${itemId}`)
    if (item.kind !== 'sell') throw new Error(`「${item.label}」不是拿来卖的`)

    const row = save.pack.find((entry) => entry.item === itemId)
    if (row === undefined || row.count <= 0) throw new Error(`背包里没有「${item.label}」`)

    const amount = Math.max(1, Math.min(Math.floor(count), row.count))
    const mods = modifiers()

    // Per-unit rounding, then multiplied: selling 10 must equal ten sales.
    const unit = {}
    for (const [key, value] of Object.entries(item.sellFor)) {
      unit[key] = Math.max(1, Math.round(value * mods.haggle))
    }
    const gained = {}
    for (const [key, value] of Object.entries(unit)) gained[key] = value * amount

    row.count -= amount
    if (row.count <= 0) save.pack = save.pack.filter((entry) => entry.item !== itemId)

    for (const [key, value] of Object.entries(gained)) {
      save.currencies[key] = (save.currencies[key] ?? 0) + value
      save.earned[key] = (save.earned[key] ?? 0) + value
    }
    save.expedition.sold[itemId] = (save.expedition.sold[itemId] ?? 0) + amount
    bumpDaily('sold', amount, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'sell',
      label: item.label,
      item: itemId,
      count: amount,
      gained,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { item: itemId, label: item.label, count: amount, gained, multiplier: mods.haggle, unlocked }
  }

  /**
   * Use a supply item from the pack.
   *
   * A `supply` item refills the bar; a `buff` item starts a timed bonus. Both
   * consume one unit, and neither is sellable — that split is what keeps the
   * three item kinds from being interchangeable.
   */
  function useItem(itemId, now = Date.now()) {
    const item = ALL_ITEM_BY_ID.get(itemId)
    if (item === undefined) throw new Error(`没有这个物品：${itemId}`)
    if (item.kind === 'sell') throw new Error(`「${item.label}」是拿来卖的，不能在出门时使用`)

    const row = save.pack.find((entry) => entry.item === itemId)
    if (row === undefined || row.count <= 0) throw new Error(`背包里没有「${item.label}」`)

    const mods = modifiers()
    row.count -= 1
    if (row.count <= 0) save.pack = save.pack.filter((entry) => entry.item !== itemId)
    save.expedition.used += 1
    bumpDaily('used', 1, now)

    let detail = null
    if (item.kind === 'supply') {
      const before = save.supplies.current
      save.supplies.current = Math.min(mods.supplyCap, save.supplies.current + item.supply)
      detail = { kind: 'supply', restored: save.supplies.current - before, current: save.supplies.current }
    } else {
      // Re-using the same buff refreshes it rather than stacking, so the
      // duration is predictable and cannot be farmed into a permanent state.
      const until = now + item.buff.ms
      const existing = save.buffs.find((buff) => buff.id === item.buff.id)
      if (existing === undefined) {
        save.buffs.push({
          id: item.buff.id,
          label: item.buff.label,
          stat: item.buff.stat,
          amount: item.buff.amount,
          until,
        })
      } else {
        existing.until = Math.max(existing.until, until)
      }
      detail = { kind: 'buff', buff: item.buff, until }
    }

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'use',
      label: item.label,
      item: itemId,
      detail: detail.kind,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { item: itemId, label: item.label, detail, unlocked }
  }

  // ── the farm ──────────────────────────────────────────────────────────────

  /**
   * Bring a plot's banked growth up to the present.
   *
   * Growth is materialized in elapsed-time slices rather than derived from
   * `plantedAt`, because the RATE changes: watering speeds it up, each ailment
   * slows it down. A single elapsed-time subtraction could not express that, so
   * the plot carries `progress` plus the moment it was last settled, and this
   * function advances the pair.
   *
   * Called before every read and every farm mutation, so the numbers on screen
   * are always the numbers the next action will use.
   */
  function settlePlot(plot, now = Date.now()) {
    if (plot === null) return null
    const crop = CROP_BY_ID.get(plot.crop)
    if (crop === undefined) return null

    // A plot with no settle timestamp (an older save, or a fresh planting) starts
    // its clock now rather than being credited for time it did not spend growing.
    const from = plot.settleAt > 0 ? plot.settleAt : plot.plantedAt > 0 ? plot.plantedAt : now
    const elapsed = Math.max(0, now - from)
    if (elapsed > 0) {
      // `cropSpeed` is a player setting; `growthRate` is the plot's own state.
      const speed = modifiers().cropSpeed
      plot.progress = Math.min(1, plot.progress + (elapsed / crop.needMs) * growthRate(plot, from) * speed)
    }
    plot.settleAt = now

    // Roll for ailments at fixed growth milestones. Doing it here (rather than on
    // a timer) means the rolls happen exactly once per milestone no matter how
    // long the gap was, so an absence cannot stack up a pile of ailments.
    const milestones = Math.floor(plot.progress * 100)
    const ailmentRate = modifiers().ailmentRate
    for (let i = 0; i < AILMENT_CHECKS.length; i += 1) {
      const mark = Math.floor(AILMENT_CHECKS[i] * 100)
      if (plot.checks <= i && milestones >= mark && plot.progress < 1) {
        plot.checks = i + 1
        // One ailment at a time: two would make neglect feel punitive. The roll
        // is scaled by the player's 病害频率 setting, so 0 means never.
        if (plot.ailments.length === 0 && Math.random() * 1000 < AILMENT_CHANCE * ailmentRate) {
          const options = AILMENTS.filter((entry) => !plot.ailments.includes(entry.id))
          if (options.length > 0) {
            plot.ailments.push(options[Math.floor(Math.random() * options.length)].id)
          }
        }
      }
    }

    // Expire the watering bonus so the displayed rate stays honest.
    if (plot.wateredUntil > 0 && plot.wateredUntil <= now) plot.wateredUntil = 0
    return plot
  }

  /**
   * How fast a plot grows right now, as a multiplier of its base rate.
   *
   * Watering adds `WATER_BONUS`; every active ailment subtracts
   * `AILMENT_PENALTY`, floored so a neglected plot still creeps forward. Neglect
   * costs SPEED, never the crop — coming back after a week should not mean
   * finding dead plants.
   */
  function growthRate(plot, at = Date.now()) {
    let rate = 1
    if (plot.wateredUntil > at) rate += WATER_BONUS
    rate -= plot.ailments.length * AILMENT_PENALTY
    return Math.max(MIN_GROWTH_RATE, rate)
  }

  /** Settle every plot. Cheap enough to run on each read. */
  function settleFarm(now = Date.now()) {
    for (const plot of save.farm.plots) settlePlot(plot, now)
  }

  /** Everything the UI needs about one plot. */
  function plotView(plot, now = Date.now()) {
    if (plot === null) return { empty: true }
    const crop = CROP_BY_ID.get(plot.crop)
    if (crop === undefined) return { empty: true }
    const mods = modifiers()
    // The displayed ETA must include the player's speed setting, or the countdown
    // would disagree with how fast the plot actually fills.
    const effectiveRate = growthRate(plot, now) * mods.cropSpeed
    const remainingMs = Math.max(0, ((1 - plot.progress) * crop.needMs) / Math.max(0.01, effectiveRate))
    return {
      empty: false,
      crop: crop.id,
      label: crop.label,
      glyph: crop.glyph,
      accent: crop.accent,
      tier: crop.tier,
      progress: plot.progress,
      percent: Math.round(plot.progress * 100),
      ready: plot.progress >= 1,
      remainingMs,
      /** The plot's own rate, for the "×1.40" badge. */
      rate: growthRate(plot, now),
      /** Rate × the player's speed setting: what the ETA is based on. */
      effectiveRate,
      watered: plot.wateredUntil > now,
      wateredMs: Math.max(0, plot.wateredUntil - now),
      /** The full ailment records, not just ids, so the UI can render them. */
      ailments: plot.ailments.map((id) => AILMENT_BY_ID.get(id)).filter(Boolean),
      yield: crop.yield,
    }
  }

  /**
   * Plant a crop in an empty plot.
   *
   * The seed is charged before the plot is written, and the plot is left empty if
   * the charge fails — so there is no state where a crop exists unpaid for.
   */
  function plant(index, cropId, now = Date.now()) {
    settleFarm(now)
    const plot = save.farm.plots[index]
    if (plot === undefined) throw new Error(`没有第 ${index + 1} 块地`)

    const crop = CROP_BY_ID.get(cropId)
    if (crop === undefined) throw new Error(`没有这种作物：${cropId}`)

    if (plot !== null) {
      const existing = CROP_BY_ID.get(plot.crop)
      const state = plotView(plot, now)
      // Replanting a finished crop is the common case, so it is allowed; only a
      // crop still growing blocks the slot.
      if (!state.ready) {
        throw new Error(`这块地已经种着${existing === undefined ? '东西' : existing.label}了`)
      }
      throw new Error('这块地已经熟了，先收获再种')
    }

    if (!canAfford(crop.seed)) {
      throw new Error(`种子不够：${describeShortfall(crop.seed)}`)
    }
    for (const [key, value] of Object.entries(crop.seed)) save.currencies[key] -= value
    recordSpend(crop.seed, now)

    save.farm.plots[index] = {
      crop: crop.id,
      plantedAt: now,
      progress: 0,
      settleAt: now,
      checks: 0,
      wateredUntil: 0,
      ailments: [],
    }

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'plant',
      label: crop.label,
      crop: crop.id,
      plot: index,
      seed: crop.seed,
    })

    bumpDaily('planted', 1, now)

    persist()
    return { plot: index, crop: crop.id, label: crop.label, seed: crop.seed }
  }

  /**
   * Tend a plot: clear one ailment, or water it if there is nothing wrong.
   *
   * One action for both keeps the interaction simple ("看顾这块地"), and it means
   * tending is never a no-op that wastes a click.
   */
  function tend(index, now = Date.now()) {
    settleFarm(now)
    const plot = save.farm.plots[index]
    if (plot === undefined) throw new Error(`没有第 ${index + 1} 块地`)
    if (plot === null) throw new Error('这块地是空的')

    const crop = CROP_BY_ID.get(plot.crop)
    const state = plotView(plot, now)
    if (state.ready) throw new Error('已经熟了，直接收获吧')

    let action = null
    if (plot.ailments.length > 0) {
      // Clear the most recently added one, so a fully neglected plot recovers in
      // the order the problems appeared.
      const cleared = plot.ailments.pop()
      const ailment = AILMENT_BY_ID.get(cleared)
      action = { kind: 'cure', ailment: cleared, label: ailment === undefined ? cleared : ailment.label }
    } else {
      plot.wateredUntil = now + WATER_MS
      action = { kind: 'water', ms: WATER_MS }
    }

    // Re-derive the rate immediately so the ETA shown after tending reflects the
    // new state rather than the old one.
    settlePlot(plot, now)
    save.farm.tended += 1
    bumpDaily('tended', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'tend',
      label: crop === undefined ? plot.crop : crop.label,
      plot: index,
      action: action.kind,
    })

    persist()
    return { plot: index, action }
  }

  /**
   * Harvest a ready plot into the pack.
   *
   * Capacity is checked per unit and anything that will not fit is reported, so
   * overfilling a full backpack loses produce VISIBLY rather than silently.
   */
  function harvest(index, now = Date.now()) {
    settleFarm(now)
    const plot = save.farm.plots[index]
    if (plot === undefined) throw new Error(`没有第 ${index + 1} 块地`)
    if (plot === null) throw new Error('这块地是空的')

    const crop = CROP_BY_ID.get(plot.crop)
    if (crop === undefined) throw new Error('这块地里的作物已经不存在了')

    const state = plotView(plot, now)
    if (!state.ready) {
      throw new Error(`还没熟，还要等 ${formatDuration(Math.ceil(state.remainingMs / 1000))}`)
    }

    const [min, max] = [crop.yield.min, crop.yield.max]
    const amount = min + Math.floor(Math.random() * (max - min + 1))

    const capacity = modifiers().packSize
    let used = packUsed()
    let stored = 0
    let lost = 0
    for (let i = 0; i < amount; i += 1) {
      if (used >= capacity) {
        lost += 1
        continue
      }
      // Produced, not found: this must NOT feed the expedition codex.
      addToPack(crop.yield.item, 1)
      used += 1
      stored += 1
    }

    save.farm.plots[index] = null
    save.farm.harvested += stored
    save.farm.byCrop[crop.id] = (save.farm.byCrop[crop.id] ?? 0) + stored
    bumpDaily('harvest', stored, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'harvest',
      label: crop.label,
      crop: crop.id,
      plot: index,
      item: crop.yield.item,
      stored,
      lost,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return {
      plot: index,
      crop: crop.id,
      label: crop.label,
      item: crop.yield.item,
      stored,
      lost,
      unlocked,
    }
  }

  /** One action for the whole farm: tend everything that needs it. */
  function tendAll(now = Date.now()) {
    settleFarm(now)
    const results = []
    const failures = []
    for (let i = 0; i < save.farm.plots.length; i += 1) {
      const plot = save.farm.plots[i]
      if (plot === null) continue
      const state = plotView(plot, now)
      if (state.ready) continue
      // Only bother with plots that actually need attention; watering a healthy
      // plot in a bulk action would just waste the bonus on nothing.
      if (plot.ailments.length === 0 && plot.wateredUntil > now) continue
      try {
        results.push(tend(i, now))
      } catch (error) {
        failures.push({ plot: i, message: messageOf(error) })
      }
    }
    return { tended: results.length, failures }
  }

  /** Harvest every ready plot. */
  function harvestAll(now = Date.now()) {
    settleFarm(now)
    const results = []
    const failures = []
    for (let i = 0; i < save.farm.plots.length; i += 1) {
      const plot = save.farm.plots[i]
      if (plot === null) continue
      if (!plotView(plot, now).ready) continue
      try {
        results.push(harvest(i, now))
      } catch (error) {
        failures.push({ plot: i, message: messageOf(error) })
      }
    }
    const stored = results.reduce((sum, entry) => sum + entry.stored, 0)
    const lost = results.reduce((sum, entry) => sum + entry.lost, 0)
    return { harvested: results.length, stored, lost, failures }
  }

  /** Buy one more plot. */
  function expandFarm(now = Date.now()) {
    const owned = save.farm.plots.length
    if (owned >= FARM_PLOTS_MAX) throw new Error(`最多只能有 ${FARM_PLOTS_MAX} 块地`)

    const cost = plotCost(owned)
    const price = { gold: cost }
    if (!canAfford(price)) throw new Error(`开垦费用不够：${describeShortfall(price)}`)

    save.currencies.gold -= cost
    recordSpend(price, now)
    save.farm.plots.push(null)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'expand',
      label: '开垦新地',
      plots: save.farm.plots.length,
      paid: price,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { plots: save.farm.plots.length, paid: price, nextCost: plotCost(save.farm.plots.length), unlocked }
  }

  // ── mining ───────────────────────────────────────────────────────────────

  /** Which layer's ore is available, as relative weights. */
  function mineTable(depth) {
    const table = {}
    for (const ore of ORES) {
      if (ore.depth > depth) continue
      // Deeper ores get a mild relative boost so progressing is visible rather
      // than just increasing the depth number.
      table[ore.id] = ore.chance * (1 + (ore.depth - 1) * 0.06)
    }
    return table
  }

  /** The ore that rolls at this depth. */
  function rollOre(depth) {
    const table = mineTable(depth)
    const total = Object.values(table).reduce((sum, weight) => sum + weight, 0)
    let roll = Math.random() * total
    for (const [id, weight] of Object.entries(table)) {
      roll -= weight
      if (roll <= 0) return ORE_BY_ID.get(id)
    }
    // A depth below every ore's own depth falls back to the shallowest one.
    return ORE_BY_ID.get(ORES[0].id)
  }

  /**
   * Bring stamina up to the present.
   *
   * Absolute timestamp, whole ticks, and capped — the same shape as the supply and
   * offline regens, for the same reason: time spent closed is credited once.
   */
  function regenStamina(now = Date.now()) {
    const cap = mineMods().staminaCap
    if (save.mine.staminaAt === 0) save.mine.staminaAt = now
    if (save.mine.stamina >= cap) {
      save.mine.staminaAt = now
      return 0
    }
    const elapsed = now - save.mine.staminaAt
    if (elapsed < STAMINA_REGEN_MS) return 0
    const ticks = Math.floor(elapsed / STAMINA_REGEN_MS)
    const gained = Math.min(ticks, cap - save.mine.stamina)
    save.mine.stamina += gained
    save.mine.staminaAt += ticks * STAMINA_REGEN_MS
    if (save.mine.stamina >= cap) save.mine.staminaAt = now
    return gained
  }

  /** Modifiers derived from mining upgrades. */
  function mineMods() {
    let pickaxe = 1
    let depth = 1
    let packCap = 0
    let staminaCap = STAMINA_MAX_BASE
    for (const definition of MINER_UPGRADES) {
      const level = save.mine.upgrades[definition.id] ?? 0
      if (definition.effect === 'pickaxe') pickaxe += level * definition.step
      else if (definition.effect === 'depth') depth += level * definition.step
      else if (definition.effect === 'packSize') packCap += level * definition.step
      else if (definition.effect === 'stamina') staminaCap += level * definition.step
    }
    return { pickaxe, depth, packCap, staminaCap }
  }

  /**
   * Roll a fresh vein for the current depth.
   *
   * Called only when the wall is bare, so a player who stops mid-vein keeps
   * exactly what they were working on.
   */
  function spawnVein(depth = save.mine.depth) {
    const ore = rollOre(depth)
    if (ore === undefined) return null
    const vein = { ore: ore.id, total: ore.perSwing, mined: 0 }
    save.mine.vein = vein
    save.mine.stats.veins += 1
    return vein
  }

  /** One swing of the pickaxe. */
  function swing(now = Date.now()) {
    regenStamina(now)
    if (save.mine.stamina < SWING_STAMINA) {
      const waitMs = save.mine.staminaAt + STAMINA_REGEN_MS - now
      throw new Error(
        `体力不够了，还要等 ${formatDuration(Math.ceil(Math.max(0, waitMs) / 1000))}。升级「强身」可以提高上限，等着也行。`,
      )
    }

    if (save.mine.vein === null) {
      const spawned = spawnVein()
      if (spawned === null) throw new Error('这一层什么都没有')
    }

    save.mine.stamina -= SWING_STAMINA
    save.mine.stats.swings += 1
    // Remember the reserve the swing started from, so "hard-fought" style
    // achievements can be evaluated from it.
    save.mine.stats.lastStamina = save.mine.stamina + SWING_STAMINA
    bumpDaily('swings', 1, now)

    const vein = save.mine.vein
    vein.mined += mineMods().pickaxe

    if (vein.mined >= vein.total) {
      // The vein pays out ONCE, on the swing that breaks it — not per point of
      // damage, which would make a strong pickaxe yield duplicates.
      const ore = ORE_BY_ID.get(vein.ore)
      save.mine.vein = null
      const capacity = 8 + mineMods().packCap
      const used = Object.values(save.mine.bufferedSwing).reduce((sum, n) => sum + n, 0)
      if (used >= capacity) {
        pushHistory({
          id: ++claimSeq,
          at: now,
          kind: 'mine-full',
          label: ore.label,
          ore: ore.id,
        })
        throw new Error(`矿袋满了（${capacity}），先收取背包`)
      }
      save.mine.bufferedSwing[ore.id] = (save.mine.bufferedSwing[ore.id] ?? 0) + 1
      save.mine.stats.byOre[ore.id] = (save.mine.stats.byOre[ore.id] ?? 0) + 1
      save.mine.stats.oresMined += 1
      bumpDaily('mined', 1, now)

      claimSeq += 1
      pushHistory({
        id: claimSeq,
        at: now,
        kind: 'mine-break',
        label: ore.label,
        ore: ore.id,
      })

      const unlocked = reconcileAchievements(now)
      for (const entry of unlocked) {
        claimSeq += 1
        pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
      }
      persist()
      return { broke: true, ore: ore.id, label: ore.label, stamina: save.mine.stamina, vein: null, unlocked }
    }

    persist()
    return { broke: false, ore: vein.ore, stamina: save.mine.stamina, vein, unlocked: [] }
  }

  /** Descend (or ascend) within the unlocked depth. */
  function setDepth(depth, now = Date.now()) {
    const target = Math.round(num(depth, 0))
    const max = mineMods().depth
    if (target < 1 || target > max) throw new Error(`只能下潜到第 ${max} 层`)
    // Ascending always works; descending requires stamina, so a player cannot
    // tunnel down for free.
    if (target > save.mine.depth) {
      regenStamina(now)
      const cost = target - save.mine.depth
      if (save.mine.stamina < cost) {
        throw new Error(`下潜 ${cost} 层需要 ${cost} 点体力，现在只有 ${save.mine.stamina}`)
      }
      save.mine.stamina -= cost
    }
    save.mine.depth = target
    save.mine.stats.deepest = Math.max(save.mine.stats.deepest, target)
    bumpDaily('descended', save.mine.depth, now)
    // Leaving a half-cut vein behind is the honest consequence of walking away.
    save.mine.vein = null
    persist()
    return { depth: target, stamina: save.mine.stamina }
  }

  /** Buy one level of a mining upgrade. */
  function buyMinerUpgrade(id, now = Date.now()) {
    const definition = MINER_UPGRADE_BY_ID.get(id)
    if (definition === undefined) throw new Error(`没有这个升级：${id}`)

    const level = save.mine.upgrades[id] ?? 0
    if (level >= definition.max) throw new Error(`「${definition.label}」已经满级了`)

    const cost = Math.max(1, Math.round(definition.cost.gold * Math.pow(definition.growth, level)))
    if (save.currencies.gold < cost) {
      throw new Error(`金币不够：需要 ${cost}，只有 ${save.currencies.gold}`)
    }

    save.currencies.gold -= cost
    save.mine.upgrades[id] = level + 1
    // Capacity and stamina may have shrunk room; clamp so nothing overflows.
    const mods = mineMods()
    if (save.mine.stamina > mods.staminaCap) save.mine.stamina = mods.staminaCap
    bumpDaily('mineUpgrades', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'mine-upgrade',
      label: definition.label,
      level: level + 1,
      paid: cost,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id, label: definition.label, level: level + 1, paid: cost, nextCost: Math.max(1, Math.round(definition.cost.gold * Math.pow(definition.growth, level + 1))), unlocked }
  }

  /** Collect one's own mined ore into the pack. */
  function collectSwing(now = Date.now()) {
    const entries = Object.entries(save.mine.bufferedSwing)
    if (entries.length === 0) throw new Error('还没有挖到矿石')

    const capacity = modifiers().packSize
    let used = packUsed()
    const granted = {}
    for (const [id, count] of entries) {
      for (let i = 0; i < count; i += 1) {
        if (used >= capacity) break
        // Produced, not found: this must not feed the expedition codex.
        addToPack(id, 1)
        used += 1
        granted[id] = (granted[id] ?? 0) + 1
      }
    }
    save.mine.bufferedSwing = {}
    save.mine.stats.collected += Object.values(granted).reduce((sum, n) => sum + n, 0)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'mine-collect',
      label: '收取矿石',
      granted,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { granted }
  }

  /**
   * Accrue every hired miner's output up to the present.
   *
   * Each miner has its own rate and its own capped buffer, so a week away fills
   * the bag and STOPS — the wage keeps accruing conceptually but the yield does
   * not, which is what makes collecting worth doing on a schedule.
   */
  function accrueMiners(now = Date.now()) {
    let any = false
    for (const definition of MINERS) {
      const hire = save.mine.miners[definition.id]
      if (hire === undefined || hire.endsAt <= 0 || hire.endsAt <= now) continue
      const elapsedHours = Math.max(0, (now - (hire.lastAt ?? hire.endsAt)) / 3_600_000)
      if (elapsedHours <= 0) continue
      const units = elapsedHours * definition.perHour
      const capacity = 8 + mineMods().packCap
      const used = Object.values(hire.buffered).reduce((sum, n) => sum + n, 0)
      if (used >= capacity) continue
      let room = capacity - used
      while (units > 0.01 && room > 0) {
        const ore = rollOre(definition.depth)
        if (ore === undefined) break
        hire.buffered[ore.id] = (hire.buffered[ore.id] ?? 0) + 1
        room -= 1
        save.mine.stats.oresMined += 1
      }
      hire.lastAt = now
      any = true
    }
    return any
  }

  // ── daily quests ──────────────────────────────────────────────────────────

  /** Hire a miner. */
  function hireMiner(id, now = Date.now()) {
    const definition = MINER_BY_ID.get(id)
    if (definition === undefined) throw new Error(`没有这种矿工：${id}`)

    const hire = save.mine.miners[definition.id]
    if (hire !== undefined && hire.endsAt > now) throw new Error('这名矿工已经在岗了')

    if (!canAfford(definition.hireCost)) {
      throw new Error(`雇不起：${describeShortfall(definition.hireCost)}`)
    }
    for (const [key, value] of Object.entries(definition.hireCost)) save.currencies[key] -= value
    recordSpend(definition.hireCost, now)

    save.mine.miners[definition.id] = {
      endsAt: now + 90 * 24 * 3_600_000,
      buffered: {},
      lastAt: now,
    }
    save.mine.stats.hiredTotal += 1
    bumpDaily('hired', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'mine-hire',
      label: definition.label,
      miner: definition.id,
      paid: definition.hireCost,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id, label: definition.label }
  }

  /**
   * Collect a miner's buffer, paying their wage for the elapsed time.
   *
   * Wage is charged HERE, at the moment of profit, instead of continuously:
   * letting a miner run for a week without collecting then costs one week of
   * wages — which is exactly the risk the idle system should have.
   */
  function collectMiner(id, now = Date.now()) {
    const definition = MINER_BY_ID.get(id)
    if (definition === undefined) throw new Error(`没有这种矿工：${id}`)

    const hire = save.mine.miners[definition.id]
    if (hire === undefined || hire.endsAt <= 0 || hire.endsAt <= now) throw new Error('这名矿工不在岗')

    accrueMiners(now)

    // Wage accrues over the same window the ore did.
    const start = hire.lastAt ?? now
    const hours = Math.max(0, (now - start) / 3_600_000)
    const wage = {}
    for (const [key, perHour] of Object.entries(definition.wagePerHour)) {
      const due = Math.round(perHour * hours)
      if (due > 0) wage[key] = due
    }
    for (const [key, due] of Object.entries(wage)) {
      // A negative balance means the miner worked for free over that stretch;
      // currency never goes below zero, so the debt simply lapses.
      const paid = Math.min(due, save.currencies[key] ?? 0)
      save.currencies[key] = (save.currencies[key] ?? 0) - paid
    }

    const granted = {}
    let used = packUsed()
    const capacity = modifiers().packSize
    for (const [oreId, count] of Object.entries(hire.buffered)) {
      for (let i = 0; i < count; i += 1) {
        if (used >= capacity) break
        addToPack(oreId, 1)
        used += 1
        granted[oreId] = (granted[oreId] ?? 0) + 1
      }
    }
    hire.buffered = {}
    hire.lastAt = now
    save.mine.stats.collected += Object.values(granted).reduce((sum, n) => sum + n, 0)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'mine-collect',
      miner: definition.id,
      label: definition.label,
      granted,
      wage,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id, label: definition.label, granted, wage }
  }

  // ── daily quests ──────────────────────────────────────────────────────────

  /** The local date key that today's quests belong to. */
  // ── fishing ───────────────────────────────────────────────────────────────

  /** The rod currently owned, as a definition. */
  function currentRod() {
    return ROD_BY_ID.get(save.fishing.activeRod) ?? RODS[0]
  }

  /**
   * The strike window in ms: base plus the rod's bonus.
   *
   * A function, not a constant, because it is reported to the client which draws
   * the window as a shrinking bar — the bar's duration must be the number the
   * host enforces, or the player is aiming at a lie.
   */
  function strikeWindowMs() {
    return FISH_WINDOW_MS + currentRod().window
  }

  /** Index of the owned rod on the ladder. */
  function rodRank() {
    return Math.max(0, RODS.findIndex((entry) => entry.id === save.fishing.activeRod))
  }

  /** Roll one fish, biased by the spot's luck and the rod's. */
  function rollFish(spot, rod) {
    const luck = (spot?.luck ?? 0) + (rod?.luck ?? 0)
    const weightOf = (entry) => {
      const index = RARITY_ORDER.indexOf(entry.rarity)
      const factor = Math.max(0.05, 1 + luck * (index - 1) * 0.9)
      return entry.w * factor
    }
    const total = FISH.reduce((sum, entry) => sum + weightOf(entry), 0)
    let roll = Math.random() * total
    for (const entry of FISH) {
      roll -= weightOf(entry)
      if (roll <= 0) return entry
    }
    return FISH[FISH.length - 1]
  }

  /**
   * Cast the line.
   *
   * Returns the timing the client needs, so the UI animates without polling. The
   * fish is picked NOW and stored, not at strike time: the catch is decided by
   * the cast, so a client that reloads mid-wait cannot influence it.
   */
  function castLine(now = Date.now()) {
    if (save.fishing.cast !== null) throw new Error('已经在钓了，先收杆。')
    if (save.fishing.cooldownUntil > now) {
      const wait = Math.max(1, Math.ceil((save.fishing.cooldownUntil - now) / 1000))
      throw new Error(`刚钓完，歇一会儿（还要 ${wait} 秒）。`)
    }

    const rod = currentRod()
    const spot = FISHING_SPOT_BY_ID.get(save.fishing.spot) ?? FISHING_SPOTS[0]
    // A spot can be locked behind a rod tier; casting there is refused rather
    // than silently downgraded, so the requirement is learnable.
    if (rodRank() < spot.reqRod) {
      throw new Error(`「${spot.label}」需要更好的鱼竿（${RODS[spot.reqRod].label}）。`)
    }

    const fish = rollFish(spot, rod)
    const [min, max] = fish.biteMs
    const biteDelay = Math.max(300, min + Math.random() * (max - min) + spot.biteShift)
    const biteAt = now + Math.round(biteDelay)

    save.fishing.cast = {
      state: 'waiting',
      biteAt,
      // A conservative fallback, overwritten when the bite lands, so a host
      // restart mid-bite still leaves a usable window.
      strikeDeadline: biteAt + strikeWindowMs(),
      fish: fish.id,
      spot: spot.id,
    }

    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'fish-cast', label: fish.label, spot: spot.id })
    persist()

    // The species is deliberately NOT returned: the client must not know what is
    // on the line, or the strike becomes a formality.
    return { spot: spot.id, biteIn: biteDelay, windowMs: strikeWindowMs() }
  }

  /**
   * Advance a waiting cast to 'biting' when its time comes.
   *
   * Called from every read, so the state is right even if the client never polls:
   * time is the host's, not the browser's.
   */
  function tickCast(now) {
    const cast = save.fishing.cast
    if (cast === null) return
    if (cast.state === 'waiting' && now >= cast.biteAt) {
      cast.state = 'biting'
      cast.strikeDeadline = cast.biteAt + strikeWindowMs()
      persist()
    }
  }

  /**
   * Strike.
   *
   * Three outcomes, and the middle one is why this is a timing game:
   *   · struck before the bite → the fish spooks, cast lost
   *   · inside the window      → caught
   *   · after the window       → it got away, cast lost
   *
   * A miss costs only its cooldown: losing a fish costs TIME, never currency,
   * which is what keeps the mode playful instead of stressful.
   */
  function strike(now = Date.now()) {
    tickCast(now)
    const cast = save.fishing.cast
    if (cast === null) throw new Error('还没下竿。')

    const fish = FISH_BY_ID.get(cast.fish)
    save.fishing.cast = null
    save.fishing.cooldownUntil = now + FISH_COOLDOWN_MS

    if (cast.state === 'waiting') {
      // An early strike consumes the cast: otherwise a player could mash the
      // button until the window happened to be open.
      save.fishing.escaped += 1
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'fish-early', label: fish?.label ?? cast.fish })
      persist()
      return {
        result: 'early',
        fish: null,
        label: fish?.label ?? cast.fish,
        hint: '抢早了——它还没咬钩。',
        cooldownUntil: save.fishing.cooldownUntil,
        unlocked: [],
      }
    }

    if (now > cast.strikeDeadline) {
      save.fishing.escaped += 1
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'fish-escape', label: fish?.label ?? cast.fish })
      persist()
      return {
        result: 'escape',
        fish: null,
        label: fish?.label ?? cast.fish,
        hint: '慢了一步，它跑了。',
        cooldownUntil: save.fishing.cooldownUntil,
        unlocked: [],
      }
    }

    if (fish === undefined) throw new Error(`不认识的鱼：${cast.fish}`)
    save.fishing.caught += 1
    save.fishing.byFish[fish.id] = (save.fishing.byFish[fish.id] ?? 0) + 1
    save.fishing.bySpot[cast.spot] = (save.fishing.bySpot[cast.spot] ?? 0) + 1
    save.fishing.bestRarity = Math.max(save.fishing.bestRarity, RARITY_ORDER.indexOf(fish.rarity))

    const stored = addToPack(fish.id, 1, { wild: true })
    bumpDaily('fished', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'fish-catch',
      label: fish.label,
      fish: fish.id,
      stored,
      rarity: fish.rarity,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return {
      result: 'caught',
      fish: fish.id,
      label: fish.label,
      rarity: fish.rarity,
      accent: fish.accent,
      glyph: fish.glyph,
      stored,
      cooldownUntil: save.fishing.cooldownUntil,
      unlocked,
    }
  }

  /** Buy a rod — unlocks it permanently. */
  function buyRod(rodId, now = Date.now()) {
    const definition = ROD_BY_ID.get(rodId)
    if (definition === undefined) throw new Error(`没有这根鱼竿：${rodId}`)
    // 已经拥有
    if (save.fishing.rods.includes(rodId)) throw new Error(`已经拥有「${definition.label}」了。`)
    // 必须从已拥有竿的紧邻下一级开始买
    const targetIndex = RODS.findIndex((entry) => entry.id === rodId)
    if (targetIndex > 0 && !save.fishing.rods.includes(RODS[targetIndex - 1].id)) {
      throw new Error(`先买「${RODS[targetIndex - 1].label}」。`)
    }
    if (!canAfford(definition.cost)) throw new Error(`买不起「${definition.label}」：${describeShortfall(definition.cost)}`)

    for (const [key, amount] of Object.entries(definition.cost)) save.currencies[key] -= amount
    recordSpend(definition.cost, now)
    save.fishing.rods.push(rodId)
    // Buying a rod EQUIPS it: the player just chose to spend on the better one,
    // so making them switch afterwards would be a second, pointless step. The old
    // rod stays unlocked, so this is never a downgrade trap.
    save.fishing.activeRod = rodId

    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'rod', label: definition.label, paid: definition.cost })
    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }
    persist()
    return { rod: rodId, label: definition.label, paid: definition.cost, unlocked, rods: [...save.fishing.rods] }
  }

  /** Switch to an already-unlocked rod. */
  function switchRod(rodId) {
    if (!save.fishing.rods.includes(rodId)) throw new Error(`还没有「${ROD_BY_ID.get(rodId)?.label ?? rodId}」。`)
    if (save.fishing.cast !== null) throw new Error('先把这竿收了再换鱼竿。')
    save.fishing.activeRod = rodId
    persist()
    const rod = ROD_BY_ID.get(rodId)
    return { rod: rodId, label: rod?.label ?? rodId, rods: [...save.fishing.rods] }
  }

  /** Switch fishing spot. A locked spot is refused with its requirement named. */
  function setSpot(spotId) {
    const spot = FISHING_SPOT_BY_ID.get(spotId)
    if (spot === undefined) throw new Error(`没有这个钓点：${spotId}`)
    if (rodRank() < spot.reqRod) throw new Error(`「${spot.label}」需要 ${RODS[spot.reqRod].label}。`)
    if (save.fishing.cast !== null) throw new Error('先把这竿收了再换地方。')
    save.fishing.spot = spotId
    persist()
    return { spot: spotId, label: spot.label }
  }

  // ── the shop game ─────────────────────────────────────────────────────────

  function shopModeDefinition() {
    return save.shop.mode === null ? null : SHOP_MODE_BY_ID.get(save.shop.mode) ?? null
  }

  /**
   * Set the shop's mode — the first time free, afterwards for 钻石.
   *
   * The opening choice is a real commitment (the two paths buy different things,
   * so a free swap would let one side's purchases go to waste and the other's
   * arrive as a windfall), but it is not a trap: a 钻石 fee makes a correction
   * possible without making mode-shopping free. The fee grows with each swap.
   *
   * Swapping does NOT refund or convert anything: machines bought on the 自动化
   * path stay bought (and keep running) if the player moves to 工作化, and their
   * stock output is still collectable — it would be worse to confiscate
   * something the player paid for.
   */
  function chooseShopMode(modeId, now = Date.now()) {
    const definition = SHOP_MODE_BY_ID.get(modeId)
    if (definition === undefined) throw new Error(`没有这种经营方式：${modeId}`)

    const current = save.shop.mode
    if (current === modeId) throw new Error(`已经是「${definition.label}」了。`)

    let paid = null
    if (current !== null) {
      paid = modeSwitchCost(save.shop.modeSwitches)
      if (!canAfford(paid)) {
        throw new Error(`换路线要 ${paid.diamond} 钻石：${describeShortfall(paid)}`)
      }
      for (const [key, amount] of Object.entries(paid)) save.currencies[key] -= amount
      recordSpend(paid, now)
      save.shop.modeSwitches += 1
    }

    const previous = current
    save.shop.mode = modeId
    save.shop.chosenAt = now
    // A swap ends any manual burst: the streak belongs to one mode's rhythm.
    save.shop.streak = 0

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'shop-mode',
      label: definition.label,
      mode: modeId,
      previous,
      paid,
    })
    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }
    persist()
    return {
      mode: modeId,
      label: definition.label,
      previous,
      previousLabel: previous === null ? null : SHOP_MODE_BY_ID.get(previous).label,
      paid,
      paidLabel: paid === null ? null : `${paid.diamond} 钻石`,
      nextCost: modeSwitchCost(save.shop.modeSwitches),
      unlocked,
    }
  }

  /** A product unlocks once reputation reaches its threshold. */
  function productUnlocked(product) {
    return save.shop.reputation >= product.unlockAt
  }

  /** Restock cost for one unit, after the mode's penalty. */
  function restockCost(product) {
    const penalty = save.shop.mode === 'manual' ? MANUAL_COST_PENALTY : 1
    const out = {}
    for (const [key, amount] of Object.entries(product.cost)) {
      out[key] = Math.max(1, Math.round(amount * penalty))
    }
    return out
  }

  /** What one unit sells for, after the mode's bonus. */
  function salePrice(product) {
    const bonus = save.shop.mode === 'manual' ? MANUAL_SALE_BONUS : 1
    const out = {}
    for (const [key, amount] of Object.entries(product.price)) {
      out[key] = Math.max(1, Math.round(amount * bonus))
    }
    return out
  }

  /**
   * Buy stock.
   *
   * Restocking is the only thing that costs money and the only thing that limits
   * a manual burst, so it is deliberately a separate action from selling: a
   * player who wants "one more sale" has to have bought the goods first.
   */
  function restock(productId, count = 1, now = Date.now()) {
    if (save.shop.mode === null) throw new Error('还没选经营方式。')
    const product = SHOP_PRODUCT_BY_ID.get(productId)
    if (product === undefined) throw new Error(`没有这个商品：${productId}`)
    if (!productUnlocked(product)) throw new Error(`「${product.label}」还没解锁（需要声望 ${product.unlockAt}）。`)

    const amount = Math.max(1, Math.min(50, Math.floor(num(count, 1))))
    const unit = restockCost(product)
    const total = {}
    for (const [key, value] of Object.entries(unit)) total[key] = value * amount
    if (!canAfford(total)) throw new Error(`买不起这些货：${describeShortfall(total)}`)

    for (const [key, value] of Object.entries(total)) save.currencies[key] -= value
    recordSpend(total, now)
    save.shop.stock[productId] = (save.shop.stock[productId] ?? 0) + amount

    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'restock', label: product.label, count: amount, paid: total })
    persist()
    return { product: productId, label: product.label, count: amount, paid: total, stock: save.shop.stock[productId] }
  }

  /**
   * Serve one customer by hand — the 手动 path.
   *
   * `streak` counts consecutive sales with no long gap, which is what the burst
   * achievements measure. It is the manual path's own reward for sustained
   * attention, since that path has no background income at all.
   */
  function manualSale(productId, now = Date.now()) {
    if (save.shop.mode !== 'manual') {
      throw new Error(save.shop.mode === null ? '还没选经营方式。' : '自动化路线不自己站柜台——去收机器吧。')
    }
    const product = SHOP_PRODUCT_BY_ID.get(productId)
    if (product === undefined) throw new Error(`没有这个商品：${productId}`)
    if (!productUnlocked(product)) throw new Error(`「${product.label}」还没解锁（需要声望 ${product.unlockAt}）。`)
    if ((save.shop.stock[productId] ?? 0) <= 0) throw new Error(`「${product.label}」没货了，先补货。`)

    save.shop.stock[productId] -= 1
    const price = salePrice(product)
    for (const [key, value] of Object.entries(price)) {
      save.currencies[key] = (save.currencies[key] ?? 0) + value
      save.earned[key] = (save.earned[key] ?? 0) + value
      if (save.shop.revenue[key] !== undefined) save.shop.revenue[key] += value
    }
    save.shop.sales += 1
    save.shop.manualSales += 1
    save.shop.byProduct[productId] = (save.shop.byProduct[productId] ?? 0) + 1
    save.shop.reputation += REPUTATION_PER_SALE
    // A gap longer than the burst window resets the run.
    if (now - save.shop.lastManualAt <= 4000) save.shop.streak += 1
    else save.shop.streak = 1
    save.shop.lastManualAt = now
    save.shop.bestStreak = Math.max(save.shop.bestStreak, save.shop.streak)

    bumpDaily('shopSales', 1, now)
    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'shop-sale', label: product.label, price, streak: save.shop.streak })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }
    persist()
    return {
      product: productId,
      label: product.label,
      price,
      stock: save.shop.stock[productId],
      reputation: save.shop.reputation,
      streak: save.shop.streak,
      unlocked,
    }
  }

  /**
   * Buy a machine — the 自动化 path.
   *
   * `endsAt: 0` means "never bought". A bought machine accrues on read (see
   * `accrueMachines`) and is paid for on collection, exactly like 矿工.
   */
  function buyMachine(machineId, now = Date.now()) {
    if (save.shop.mode !== 'auto') {
      throw new Error(save.shop.mode === null ? '还没选经营方式。' : '手动路线没有机器——你自己站柜台。')
    }
    const definition = SHOP_MACHINE_BY_ID.get(machineId)
    if (definition === undefined) throw new Error(`没有这台机器：${machineId}`)
    const owned = save.shop.machines[machineId]
    if (owned !== undefined && owned.endsAt > 0) throw new Error(`「${definition.label}」已经在跑了。`)
    if (!canAfford(definition.hireCost)) throw new Error(`买不起「${definition.label}」：${describeShortfall(definition.hireCost)}`)

    for (const [key, value] of Object.entries(definition.hireCost)) save.currencies[key] -= value
    recordSpend(definition.hireCost, now)
    save.shop.machines[machineId] = { endsAt: now, buffered: {} }
    save.shop.machinesBought += 1

    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'shop-machine', label: definition.label, paid: definition.hireCost })
    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }
    persist()
    return { machine: machineId, label: definition.label, paid: definition.hireCost, unlocked }
  }

  /**
   * Accrue machine output up to now.
   *
   * Whole hours only, credited from `endsAt`, and the buffer is capped so a
   * month away cannot overflow the display. A partial hour is not banked — that
   * is why the panel says 整小时结算.
   */
  function accrueMachines(now = Date.now()) {
    let changed = false
    for (const machine of SHOP_MACHINES) {
      const owned = save.shop.machines[machine.id]
      if (owned === undefined || owned.endsAt <= 0) continue
      const elapsed = now - owned.endsAt
      if (elapsed < 3_600_000) continue
      const hours = Math.floor(elapsed / 3_600_000)
      // The cheapest unlocked product is what a generic machine makes, which
      // keeps machine income independent of what happens to be in stock.
      const product = SHOP_PRODUCTS.filter((entry) => productUnlocked(entry))[0] ?? SHOP_PRODUCTS[0]
      const produced = Math.floor(hours * machine.perHour)
      const already = Object.values(owned.buffered).reduce((sum, n) => sum + n, 0)
      const room = Math.max(0, 200 - already)
      const gain = Math.min(produced, room)
      if (gain > 0) {
        owned.buffered[product.id] = (owned.buffered[product.id] ?? 0) + gain
        changed = true
      }
      owned.endsAt += hours * 3_600_000
    }
    if (changed) persist()
  }

  /**
   * Collect a machine's output and pay its wage.
   *
   * The wage is charged HERE, not continuously, so letting a machine run a week
   * and never collecting costs nothing upfront and the bill arrives at the moment
   * of profit — the same accounting as 矿工, for the same reason.
   */
  function collectMachine(machineId, now = Date.now()) {
    const definition = SHOP_MACHINE_BY_ID.get(machineId)
    if (definition === undefined) throw new Error(`没有这台机器：${machineId}`)
    const owned = save.shop.machines[machineId]
    if (owned === undefined || owned.endsAt <= 0) throw new Error(`「${definition.label}」还没买。`)
    accrueMachines(now)

    const granted = {}
    for (const [productId, count] of Object.entries(owned.buffered)) {
      if (!SHOP_PRODUCT_BY_ID.has(productId)) continue
      granted[productId] = count
    }
    if (Object.keys(granted).length === 0) throw new Error('还没有产出，再等等。')

    const total = Object.values(granted).reduce((sum, n) => sum + n, 0)
    const hours = Math.max(1, Math.round(total / Math.max(1, definition.perHour)))
    const wage = {}
    for (const [key, amount] of Object.entries(definition.wagePerHour)) wage[key] = amount * hours
    if (!canAfford(wage)) throw new Error(`付不起工资：${describeShortfall(wage)}`)

    for (const [key, amount] of Object.entries(wage)) save.currencies[key] -= amount
    recordSpend(wage, now)

    // Machine output is STOCK, not items: it goes straight into the back room,
    // so a night of automation cannot overflow the item pack.
    for (const [productId, count] of Object.entries(granted)) {
      save.shop.stock[productId] = (save.shop.stock[productId] ?? 0) + count
      save.shop.byProduct[productId] = (save.shop.byProduct[productId] ?? 0) + count
    }
    owned.buffered = {}
    save.shop.autoSales += total
    save.shop.sales += total
    save.shop.reputation += total * REPUTATION_PER_SALE

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'shop-machine-collect',
      label: definition.label,
      granted,
      wage,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }
    persist()
    return {
      machine: machineId,
      label: definition.label,
      granted,
      wage,
      stock: { ...save.shop.stock },
      unlocked,
    }
  }
  function todayKey(now = Date.now()) {
    return bucketKey('day', new Date(now))
  }

  /**
   * Start a new quest day if the date has rolled over.
   *
   * Called from every metric bump and every read, so progress can never leak
   * across midnight — and so a session left open overnight starts the new day the
   * moment anything happens.
   */
  function rollDaily(now = Date.now()) {
    const key = todayKey(now)
    if (save.daily.key === key) return false
    save.daily = { key, counters: {}, claimed: {}, allClaimed: false }
    return true
  }

  /** Record progress toward today's quests. */
  function bumpDaily(metric, amount = 1, now = Date.now()) {
    if (amount === 0) return
    rollDaily(now)
    save.daily.counters[metric] = (save.daily.counters[metric] ?? 0) + amount
  }

  /** Track gold actually spent, for the "spend" quest. */
  function recordSpend(price, now = Date.now()) {
    const gold = price !== null && price !== undefined && typeof price.gold === 'number' ? price.gold : 0
    if (gold > 0) bumpDaily('spent', gold, now)
  }

  /** Today's three quests with live progress. */
  function dailyQuests(now = Date.now()) {
    rollDaily(now)
    return questsForDay(save.daily.key).map((quest) => {
      const raw = save.daily.counters[quest.metric] ?? 0
      const progress = Math.min(raw, quest.target)
      return {
        id: quest.id,
        label: quest.label,
        desc: quest.desc,
        metric: quest.metric,
        target: quest.target,
        progress,
        done: progress >= quest.target,
        claimed: save.daily.claimed[quest.id] !== undefined,
        reward: quest.reward,
      }
    })
  }

  /**
   * Cash in a completed quest.
   *
   * The id must be part of TODAY'S draw: without that check a stale id from a
   * previous day (or a hand-crafted request) could be redeemed against a counter
   * that no longer relates to it.
   */
  function claimQuest(id, now = Date.now()) {
    rollDaily(now)
    const quest = QUEST_BY_ID.get(id)
    if (quest === undefined) throw new Error(`没有这个任务：${id}`)
    if (!questsForDay(save.daily.key).some((entry) => entry.id === id)) {
      throw new Error('这个任务不在今天的列表里')
    }
    if (save.daily.claimed[id] !== undefined) throw new Error('这个任务已经领过了')

    const raw = save.daily.counters[quest.metric] ?? 0
    if (raw < quest.target) throw new Error(`还没完成：${raw} / ${quest.target}`)

    const granted = {}
    for (const [key, value] of Object.entries(quest.reward)) {
      granted[key] = value
      save.currencies[key] = (save.currencies[key] ?? 0) + value
      save.earned[key] = (save.earned[key] ?? 0) + value
    }
    save.daily.claimed[id] = now

    // Clearing the whole board pays a bonus, once.
    let bonus = null
    const today = questsForDay(save.daily.key)
    if (!save.daily.allClaimed && today.every((entry) => save.daily.claimed[entry.id] !== undefined)) {
      save.daily.allClaimed = true
      save.questAllDays += 1
      bonus = {}
      for (const [key, value] of Object.entries(DAILY_ALL_BONUS)) {
        bonus[key] = value
        save.currencies[key] = (save.currencies[key] ?? 0) + value
        save.earned[key] = (save.earned[key] ?? 0) + value
      }
    }

    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'quest', label: quest.label, granted, bonus })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id, label: quest.label, granted, bonus, unlocked }
  }

  // ── alchemy ───────────────────────────────────────────────────────────────

  /** Whether the pack holds every input of a recipe. Reports what is missing. */
  function recipeShortfall(recipe) {
    const missing = []
    for (const [itemId, need] of Object.entries(recipe.inputs)) {
      const row = save.pack.find((entry) => entry.item === itemId)
      const have = row === undefined ? 0 : row.count
      if (have < need) {
        const item = ALL_ITEM_BY_ID.get(itemId)
        missing.push(`${item === undefined ? itemId : item.label} ${have}/${need}`)
      }
    }
    return missing
  }

  /**
   * Run one recipe: consume the inputs and fee, produce the output.
   *
   * Every check happens before any mutation, so a rejected craft cannot leave the
   * pack half-consumed.
   */
  function alchemy(recipeId, now = Date.now()) {
    const recipe = RECIPE_BY_ID.get(recipeId)
    if (recipe === undefined) throw new Error(`没有这个配方：${recipeId}`)

    const missing = recipeShortfall(recipe)
    if (missing.length > 0) throw new Error(`材料不够：${missing.join('，')}`)
    if (!canAfford(recipe.fee)) throw new Error(`费用不够：${describeShortfall(recipe.fee)}`)

    for (const [itemId, need] of Object.entries(recipe.inputs)) {
      const row = save.pack.find((entry) => entry.item === itemId)
      row.count -= need
      if (row.count <= 0) save.pack = save.pack.filter((entry) => entry.item !== itemId)
    }
    for (const [key, value] of Object.entries(recipe.fee)) {
      save.currencies[key] -= value
    }
    recordSpend(recipe.fee, now)

    const produced = {}
    for (const [itemId, count] of Object.entries(recipe.output)) {
      addToPack(itemId, count)
      produced[itemId] = count
    }

    save.alchemy.runs += 1
    save.alchemy.byRecipe[recipeId] = (save.alchemy.byRecipe[recipeId] ?? 0) + 1
    bumpDaily('alchemy', 1, now)

    claimSeq += 1
    pushHistory({ id: claimSeq, at: now, kind: 'alchemy', label: recipe.label, produced })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id: recipeId, label: recipe.label, produced, runs: save.alchemy.runs, unlocked }
  }

  // ── rebirth ───────────────────────────────────────────────────────────────

  /** What a rebirth would do right now, without doing it. */
  function rebirthPreview(now = Date.now()) {
    const level = levelOf(save.currencies.xp).level
    return {
      level,
      required: REBIRTH_LEVEL,
      eligible: level >= REBIRTH_LEVEL,
      stars: level >= REBIRTH_LEVEL ? starsForLevel(level) : 0,
      missing: Math.max(0, REBIRTH_LEVEL - level),
      count: save.rebirth.count,
      bestLevel: save.rebirth.bestLevel,
      keeps: ['成就', '图鉴与统计', '背包物品', '星盘升级', '星辰'],
      resets: ['等级与经验', '全部货币（星辰除外）', '商店升级', '连签', '今日任务'],
    }
  }

  /**
   * Rebirth: trade the current run for 星辰.
   *
   * The split is deliberate. What resets is everything that is *bought with a
   * run* — level, currencies, shop upgrades, streaks — so the next run is a real
   * climb. What survives is everything that represents *knowledge or collection*:
   * achievements, the codex, the pack, lifetime statistics, and the 星盘. Losing
   * achievements on prestige is the fastest way to make players stop playing.
   */
  function rebirth(now = Date.now()) {
    const level = levelOf(save.currencies.xp).level
    if (level < REBIRTH_LEVEL) {
      throw new Error(`需要达到 ${REBIRTH_LEVEL} 级才能转生（现在是 ${level} 级）`)
    }

    const gained = starsForLevel(level)
    const mods = modifiers()
    const startGold = mods.startGold
    const previousBest = save.rebirth.bestLevel

    for (const key of CURRENCY_KEYS) {
      if (key === 'star') continue
      save.currencies[key] = 0
    }
    save.currencies.star += gained
    save.earned.star += gained

    save.upgrades = {}
    for (const key of PERIOD_KEYS) {
      const state = save.periods[key]
      state.lastAt = 0
      state.lastKey = ''
      state.streak = 0
      // `best` and `total` are lifetime records and deliberately survive.
    }

    save.supplies.current = Math.min(save.supplies.current, SUPPLY_MAX_BASE)
    save.supplies.regenAt = now
    save.trip = null
    save.buffs = []
    save.offline.pool = { coin: 0, gold: 0 }
    save.offline.accruedAt = now
    save.daily = { key: '', counters: {}, claimed: {}, allClaimed: false }

    // 启程 grants a starting purse, so a rebirth is not a cold start.
    if (startGold > 0) {
      save.currencies.gold += startGold
      save.earned.gold += startGold
    }

    save.rebirth.count += 1
    save.rebirth.bestLevel = Math.max(previousBest, level)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'rebirth',
      label: `第 ${save.rebirth.count} 次转生`,
      level,
      stars: gained,
      startGold,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { level, stars: gained, startGold, count: save.rebirth.count, unlocked }
  }

  /** Buy one 星盘 level with 星辰. */
  function buyStarUpgrade(id, now = Date.now()) {
    const definition = STAR_UPGRADE_BY_ID.get(id)
    if (definition === undefined) throw new Error(`没有这个星盘项：${id}`)

    const level = starLevel(id)
    if (level >= definition.max) throw new Error(`「${definition.label}」已经满级了`)

    const cost = starCost(definition, level)
    if (save.currencies.star < cost) {
      throw new Error(`星辰不够：需要 ${cost}，只有 ${save.currencies.star}`)
    }

    save.currencies.star -= cost
    save.starUpgrades[id] = level + 1

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'star',
      label: definition.label,
      level: level + 1,
      paid: { star: cost },
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id, label: definition.label, level: level + 1, paid: cost, unlocked }
  }

  /** The derived view every rule and every render reads. */
  function view(now = Date.now()) {
    const level = levelOf(save.currencies.xp)
    const mods = modifiers()
    const periods = PERIODS.map((period) => {
      const state = save.periods[period.key]
      const availability = availabilityOf(period, now)
      // Both multipliers, because the number shown must be the number paid: the
      // period's own shop yield and the global 星盘 yield.
      const yieldMultiplier = (mods.yields[period.key] ?? 1) * mods.starYield
      // The rewards reported are the rewards actually paid: base × yield. The
      // streak multiplier is applied at claim time because it changes then.
      const rewards = {}
      for (const [key, amount] of Object.entries(period.rewards)) {
        rewards[key] = Math.max(1, Math.round(amount * yieldMultiplier))
      }
      return {
        key: period.key,
        label: period.label,
        short: period.short,
        accent: period.accent,
        ready: availability.ready,
        readyAt: availability.readyAt,
        remaining: availability.remaining,
        streak: state.streak,
        best: state.best,
        total: state.total,
        rewards,
        baseRewards: period.rewards,
        yieldMultiplier,
      }
    })

    const everHeld = {}
    for (const key of CURRENCY_KEYS) everHeld[key] = save.earned[key] > 0

    return {
      total: PERIOD_KEYS.reduce((sum, key) => sum + save.periods[key].total, 0),
      counts: { ...save.stats.counts },
      best: Object.fromEntries(PERIOD_KEYS.map((key) => [key, save.periods[key].best])),
      hours: save.stats.hours,
      luckyHits: save.stats.luckyHits,
      perfectDays: save.stats.perfectDays,
      bestCombo: save.stats.bestCombo,
      chestsOpened: save.chests.opened,
      chestsOpenedById: { ...save.chests.byId },
      offlineCollected: save.offline.collected,
      upgradesOwned: Object.values(save.upgrades).reduce((sum, level) => sum + level, 0),
      maxedUpgrades: UPGRADES.filter((definition) => upgradeLevel(definition.id) >= definition.max).length,
      /**
       * Whether the offline pool is at its ceiling.
       *
       * Compared against the ceiling for the CURRENT rate and cap, so the flag
       * tracks what the player can actually see, not a fixed constant.
       */
      offlinePoolFull: CURRENCY_KEYS.some((key) => OFFLINE_BASE_PER_HOUR[key] !== undefined) &&
        Object.entries(OFFLINE_BASE_PER_HOUR).every(([key, perHour]) => {
          const ceiling = Math.floor(perHour * mods.offlineRate * mods.offlineCapHours)
          return ceiling > 0 && save.offline.pool[key] >= ceiling
        }),
      currencies: save.currencies,
      earned: save.earned,
      everHeld,
      level: level.level,
      levelInto: level.into,
      levelNeed: level.need,
      levelProgress: level.progress,
      periods,
      readyCount: periods.filter((entry) => entry.ready).length,
      /** Live modifiers, so the UI can show what the shop is buying. */
      modifiers: {
        luck: mods.luck,
        grace: mods.grace,
        offlineRate: mods.offlineRate,
        offlineCapHours: mods.offlineCapHours,
        supplyCap: mods.supplyCap,
        packSize: mods.packSize,
        swift: mods.swift,
        fortune: mods.fortune,
        haggle: mods.haggle,
        thrift: mods.thrift,
      },
      offline: {
        pool: { ...save.offline.pool },
        total: save.offline.pool.coin + save.offline.pool.gold,
        collected: save.offline.collected,
      },
      supplies: {
        current: save.supplies.current,
        cap: mods.supplyCap,
        regenAt: save.supplies.regenAt,
        // Seconds until the next unit, so the UI can count down locally.
        nextIn: Math.max(0, Math.round((save.supplies.regenAt + SUPPLY_REGEN_MS - now) / 1000)),
      },
      pack: save.pack.map((row) => ({ item: row.item, count: row.count })),
      packUsed: packUsed(),
      packSize: mods.packSize,
      // Extended trip state: gathered bag, gather cooldown and sleep readiness,
      // so the panel can render the camp's three actions.
      trip: tripSnapshot(now),
      /** The actions themselves, so the UI is driven by this table. */
      tripActions: TRIP_ACTIONS.map((entry) => ({ ...entry })),
      /** What 采集 can turn up, for the panel's hint text. */
      forage: FORAGE.map((entry) => ({
        id: entry.id,
        label: entry.label,
        rarity: entry.rarity,
        kind: entry.kind,
        accent: entry.accent,
        glyph: entry.glyph,
        chance: entry.w,
      })),
      buffs: save.buffs.map((buff) => ({ ...buff, remainingMs: Math.max(0, buff.until - now) })),
      expedition: {
        runs: save.expedition.runs,
        found: { ...save.expedition.found },
        sold: { ...save.expedition.sold },
        bestTier: save.expedition.bestTier,
        uniqueFound: Object.keys(save.expedition.found).length,
        byDestination: { ...save.expedition.byDestination },
        used: save.expedition.used,
        /** Whether every destination has been visited at least once. */
        visitedAll: EXPEDITIONS.every((destination) => (save.expedition.byDestination[destination.id] ?? 0) > 0),
        /** Which rarity tiers have ever been found, in ascending order. */
        foundTiers: RARITY_ORDER.filter((tier) =>
          ITEMS.some((item) => item.rarity === tier && (save.expedition.found[item.id] ?? 0) > 0),
        ),
      },
      /** How many upgrade definitions exist, so "all maxed" is checkable. */
      upgradeCount: UPGRADES.length,
      /** Alchemy tallies, for the codex and the achievements. */
      alchemyRuns: save.alchemy.runs,
      alchemyKinds: Object.keys(save.alchemy.byRecipe).length,
      /**
       * Farm standing.
       *
       * `harvested` counts produce actually STORED, not the raw roll, so a
       * harvest that overflowed a full backpack does not inflate the totals.
       */
      farmHarvested: save.farm.harvested,
      farmKinds: Object.keys(save.farm.byCrop).length,
      /**
       * Per-crop harvest counts.
       *
       * Exposed as a whole map because achievements need to ask about a SPECIFIC
       * crop ("did you ever harvest a 灵莲"). Without it the achievement read
       * `v.farmByCrop.lotus` off an undefined field, threw, and was silently
       * swallowed by the achievement engine's try/catch — so it could never
       * unlock and nothing anywhere said so.
       */
      farmByCrop: { ...save.farm.byCrop },
      farmTended: save.farm.tended,
      farmPlots: save.farm.plots.length,
      farmPlanted: save.farm.plots.filter((plot) => plot !== null).length,
      farmReady: save.farm.plots.filter((plot) => plot !== null && plotView(plot, now).ready).length,

      /**
       * Mine standing.
       *
       * `bufferedSwing` is shown raw so the panel can say "挖到 3 份还没收", and
       * the ore totals count what actually left the rock, not what was rolled —
       * the same convention the farm harvest uses.
       */
      mineDepth: save.mine.depth,
      mineDeepest: save.mine.stats.deepest,
      mineStamina: save.mine.stamina,
      mineStaminaCap: mineMods().staminaCap,
      mineSwings: save.mine.stats.swings,
      mineVeins: save.mine.stats.veins,
      mineOres: save.mine.stats.oresMined,
      /** Distinct ore kinds ever collected, for the codex achievement. */
      mineOreKinds:
        new Set([
          ...Object.keys(save.mine.stats.byOre ?? {}),
        ]).size,
      /** Ore ids ever seen, for 星石 — read from the live ore tallies. */
      mineByOre: { ...(save.mine.stats.byOre ?? {}), ...Object.fromEntries(Object.entries(save.mine.bufferedSwing).map(([k]) => [k, 1])) },
      minePickaxeLevel: save.mine.upgrades.pickaxe ?? 0,
      /** Whether the last swing was made from an empty reserve. */
      mineLastStamina: save.mine.stats.lastStamina ?? -1,
      mineMiners: MINERS.filter((definition) => {
        const hire = save.mine.miners[definition.id]
        return hire !== undefined && hire.endsAt > now
      }).length,
      mineBuffered: Object.values(save.mine.bufferedSwing).reduce((sum, n) => sum + n, 0),

      /**
       * 钓鱼 standing.
       *
       * `fishCast` is shaped for the UI's timer: `biteIn` counts down to the bite
       * and `windowMs` is how long the strike stays open. Both are computed here
       * rather than in the browser, because the browser is not a clock.
       */
      fishRod: save.fishing.activeRod,
      fishRods: [...save.fishing.rods],
      fishSpot: save.fishing.spot,
      fishCaught: save.fishing.caught,
      fishEscaped: save.fishing.escaped,
      fishKinds: Object.keys(save.fishing.byFish).length,
      fishByFish: { ...save.fishing.byFish },
      fishBestRarity: save.fishing.bestRarity,
      /** Index of the owned rod on the ladder, so "which tier" is one compare. */
      fishRodRank: rodRank(),
      /** How many spots the current rod has opened up. */
      fishSpotUnlocked: FISHING_SPOTS.filter((spot) => rodRank() >= spot.reqRod).length,
      /** Catches made at the sea specifically, for the 出海 achievement. */
      fishCaughtAtSea: save.fishing.bySpot.sea ?? 0,
      fishWindowMs: strikeWindowMs(),
      fishCooldownUntil: save.fishing.cooldownUntil,
      fishCast:
        save.fishing.cast === null
          ? null
          : {
              state: save.fishing.cast.state,
              spot: save.fishing.cast.spot,
              biteIn: Math.max(0, save.fishing.cast.biteAt - now),
              strikeIn: Math.max(0, save.fishing.cast.strikeDeadline - now),
            },

      /**
       * 开店 standing.
       *
       * `shopMode` is null until answered, and the UI uses exactly that to decide
       * between the picker and the shop floor.
       */
      shopMode: save.shop.mode,
      shopChosenAt: save.shop.chosenAt,
      shopReputation: save.shop.reputation,
      shopSales: save.shop.sales,
      shopManualSales: save.shop.manualSales,
      shopAutoSales: save.shop.autoSales,
      shopMachinesBought: save.shop.machinesBought,
      shopModeSwitches: save.shop.modeSwitches,
      shopBestStreak: save.shop.bestStreak,
      shopStreak: save.shop.streak,
      shopByProduct: { ...save.shop.byProduct },
      shopRevenue: { ...save.shop.revenue },
      shopAllProducts: SHOP_PRODUCTS.every((product) => productUnlocked(product)),
      shopUnlockedProducts: SHOP_PRODUCTS.filter((product) => productUnlocked(product)).length,
      shopStock: { ...save.shop.stock },
      shopMachinesRunning: SHOP_MACHINES.filter((machine) => {
        const owned = save.shop.machines[machine.id]
        return owned !== undefined && owned.endsAt > 0
      }).length,

      /**
       * Settings-derived counters the achievements read.
       *
       * `settingsAtMax` counts numeric knobs sitting at their declared maximum —
       * derived from the schema rather than hardcoded, so adding a knob
       * automatically makes it eligible.
       */
      settingsTouched,
      settingsAtMax: SETTINGS_SCHEMA.filter(
        (entry) => entry.kind === 'number' && settings[entry.key] >= entry.max,
      ).length,
      systemsHidden: SYSTEM_TOGGLES.filter((key) => settings[key] === false).length,
      /** Whether a system tab was ever hidden, for the `unfiltered` achievement. */
      hidSystemsBefore,
      /** Rebirth standing. */
      rebirths: save.rebirth.count,
      rebirthBestLevel: save.rebirth.bestLevel,
      starLevels: Object.values(save.starUpgrades).reduce((sum, level) => sum + level, 0),
      /** Today's quest standing. */
      questsDone: dailyQuests(now).filter((quest) => quest.done).length,
      questsClaimed: dailyQuests(now).filter((quest) => quest.claimed).length,
      dailyAllClaimed: save.daily.allClaimed,
      questAllDays: save.questAllDays,
      /**
       * Flattened counters the achievement table reads.
       *
       * achievements are declared as `test(view)`, so every number they need has
       * to exist on this object; keeping them flat here is what lets the table
       * stay a list of one-liners.
       */
      packTotal: save.pack.reduce((sum, row) => sum + row.count, 0),
      packUnique: save.pack.length,
      soldTotal: Object.values(save.expedition.sold).reduce((sum, n) => sum + n, 0),
      usedTotal: save.expedition.used,
      activeBuffs: save.buffs.length,
      bestTierRank:
        save.expedition.bestTier === null ? -1 : RARITY_ORDER.indexOf(save.expedition.bestTier),
      suppliesFull: save.supplies.current >= mods.supplyCap && mods.supplyCap > 0,
    }
  }

  /** Unlock every achievement whose condition now holds. Returns the new ones. */
  function reconcileAchievements(now) {
    const snapshot = view(now)
    const unlocked = []
    for (const entry of ACHIEVEMENTS) {
      if (save.achievements[entry.id] !== undefined) continue
      let holds = false
      try {
        holds = entry.test(snapshot) === true
      } catch (error) {
        logger.warn?.(`checkin: 成就 ${entry.id} 判定失败：${messageOf(error)}`)
      }
      if (holds) {
        save.achievements[entry.id] = now
        unlocked.push(entry)
      }
    }
    return unlocked
  }

  function pushHistory(entry) {
    save.history.push(entry)
    if (save.history.length > HISTORY_LIMIT) save.history = save.history.slice(-HISTORY_LIMIT)
  }

  // ── claiming ──────────────────────────────────────────────────────────────

  /**
   * Advance a period's streak and return the new value.
   *
   * For interval periods the streak survives a short overshoot; the base
   * tolerance is two missed slots, and the 续签契约 upgrade widens it. For
   * calendar periods the streak survives only if the previous bucket was
   * claimed, which is exactly what makes a daily streak mean something.
   */
  function advanceStreak(period, now) {
    const state = save.periods[period.key]
    if (period.intervalMs !== undefined) {
      const missed = state.lastAt === 0 ? Infinity : (now - state.lastAt) / period.intervalMs
      // `missed <= 1` means "the very next slot", so a tolerance of N allows
      // N-1 skipped slots. Base 3 → two skips; each grace level adds one.
      const tolerance = 3 + modifiers().grace
      state.streak = missed <= tolerance ? state.streak + 1 : 1
    } else {
      const expected = previousBucket(period.calendar, new Date(now))
      state.streak = state.lastKey === expected ? state.streak + 1 : 1
    }
    state.best = Math.max(state.best, state.streak)
    return state.streak
  }

  /** One claim: rewards, streak, luck, history, achievements. */
  function claim(periodKey, now = Date.now()) {
    const period = PERIOD_BY_KEY.get(periodKey)
    if (period === undefined) throw new Error(`没有这个周期：${periodKey}`)

    const availability = availabilityOf(period, now)
    if (!availability.ready) {
      const seconds = Math.ceil(availability.remaining / 1000)
      throw new Error(`「${period.label}」还没到时间，还要等 ${formatDuration(seconds)}`)
    }

    const state = save.periods[period.key]
    const streak = advanceStreak(period, now)
    const mods = modifiers()

    // Three multipliers stack: the streak (loyalty), the period's shop yield
    // (investment), and the global 星盘 yield (prestige).
    const streakMultiplier = 1 + Math.min(streak - 1, STREAK_CAP) * STREAK_STEP
    const yieldMultiplier = (mods.yields[period.key] ?? 1) * mods.starYield
    const multiplier = streakMultiplier * yieldMultiplier

    const granted = {}
    for (const [key, amount] of Object.entries(period.rewards)) {
      const value = Math.max(1, Math.round(amount * multiplier))
      granted[key] = value
      save.currencies[key] = (save.currencies[key] ?? 0) + value
      save.earned[key] = (save.earned[key] ?? 0) + value
    }

    // A little unpredictability is what makes a claim worth watching; the luck
    // upgrade makes it more likely.
    let lucky = null
    if (Math.random() < LUCKY_CHANCE + mods.luck) {
      const drop = LUCKY_DROPS[Math.floor(Math.random() * LUCKY_DROPS.length)]
      const value = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1))
      granted[drop.key] = (granted[drop.key] ?? 0) + value
      save.currencies[drop.key] += value
      save.earned[drop.key] += value
      save.stats.luckyHits += 1
      lucky = { key: drop.key, value, label: drop.label }
    }

    // Commit the period.
    state.lastAt = now
    state.total += 1
    state.lastKey = period.calendar === undefined ? state.lastKey : bucketKey(period.calendar, new Date(now))
    save.stats.counts[period.key] = state.total
    save.lastSeenAt = now

    if (!save.stats.hours.includes(new Date(now).getHours())) {
      save.stats.hours = [...save.stats.hours, new Date(now).getHours()].sort((a, b) => a - b)
    }

    // A perfect day is one where every period was claimed inside the same day.
    const dayKey = bucketKey('day', new Date(now))
    const claimedToday = PERIOD_KEYS.every((key) => {
      const entry = save.periods[key]
      if (entry.lastAt === 0) return false
      return bucketKey('day', new Date(entry.lastAt)) === dayKey
    })
    if (claimedToday && !save.stats.perfectKeys.includes(dayKey)) {
      save.stats.perfectKeys.push(dayKey)
      save.stats.perfectDays += 1
      bumpDaily('perfect', 1, now)
    }

    // Daily-quest progress. Bumped here rather than in the route so every path
    // that awards a claim counts, including `claim-all`.
    bumpDaily('claims', 1, now)
    if (period.key === 'day') bumpDaily('periodDay', 1, now)
    if (lucky !== null) bumpDaily('lucky', 1, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'claim',
      period: period.key,
      label: period.label,
      granted,
      lucky,
      streak,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()

    return {
      period: period.key,
      label: period.label,
      granted,
      lucky,
      streak,
      multiplier,
      unlocked,
    }
  }

  /** Claim every ready period at once; the combo feeds one achievement. */
  function claimAll(now = Date.now()) {
    const results = []
    const failures = []
    for (const period of PERIODS) {
      if (!availabilityOf(period, now).ready) continue
      try {
        results.push(claim(period.key, now))
      } catch (error) {
        failures.push({ period: period.key, message: messageOf(error) })
      }
    }
    if (results.length > save.stats.bestCombo) save.stats.bestCombo = results.length
    if (results.length > 0) {
      reconcileAchievements(now)
      persist()
    }
    return { claimed: results.length, outcomes: results, failures }
  }

  // ── shop ──────────────────────────────────────────────────────────────────

  /** Whether the player can currently afford a price map. */
  function canAfford(price) {
    for (const [key, amount] of Object.entries(price)) {
      if ((save.currencies[key] ?? 0) < amount) return false
    }
    return true
  }

  function describeShortfall(price) {
    const missing = []
    for (const [key, amount] of Object.entries(price)) {
      const have = save.currencies[key] ?? 0
      if (have < amount) {
        const currency = CURRENCIES.find((entry) => entry.key === key)
        missing.push(`${currency === undefined ? key : currency.label} 还差 ${amount - have}`)
      }
    }
    return missing.join('，')
  }

  /**
   * Buy one level of an upgrade.
   *
   * Charging and leveling happen together, and the price comes from the same
   * pure function the client renders, so a displayed price is always the price
   * paid — there is no window where a stale price could be honoured.
   */
  function buyUpgrade(id, now = Date.now()) {
    const definition = UPGRADE_BY_ID.get(id)
    if (definition === undefined) throw new Error(`没有这个升级项：${id}`)

    const level = upgradeLevel(id)
    if (level >= definition.max) throw new Error(`「${definition.label}」已经满级了`)

    const price = { [definition.cost.currency]: upgradeCost(definition, level) }
    if (!canAfford(price)) {
      throw new Error(`买不起「${definition.label}」：${describeShortfall(price)}`)
    }

    for (const [key, amount] of Object.entries(price)) {
      save.currencies[key] -= amount
    }
    save.upgrades[id] = level + 1
    bumpDaily('upgrades', 1, now)
    recordSpend(price, now)

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'upgrade',
      label: definition.label,
      level: level + 1,
      paid: price,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { id, label: definition.label, level: level + 1, paid: price, unlocked }
  }

  // ── chests ────────────────────────────────────────────────────────────────

  /** Pick one loot entry by relative weight. */
  function rollLoot(table) {
    const total = table.reduce((sum, entry) => sum + entry.w, 0)
    let roll = Math.random() * total
    for (const entry of table) {
      roll -= entry.w
      if (roll <= 0) return entry
    }
    return table[table.length - 1]
  }

  function rollAmount(entry) {
    return entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1))
  }

  /**
   * Open a chest: the currency sink.
   *
   * A chest pays several rolls rather than one, so even a bad chest feels like
   * something happened. `guaranteed` entries land before the weighted rolls.
   */
  function openChest(id, now = Date.now()) {
    const chest = CHEST_BY_ID.get(id)
    if (chest === undefined) throw new Error(`没有这个宝箱：${id}`)

    if (!canAfford(chest.cost)) {
      throw new Error(`买不起「${chest.label}」：${describeShortfall(chest.cost)}`)
    }
    for (const [key, amount] of Object.entries(chest.cost)) {
      save.currencies[key] -= amount
    }

    const granted = {}
    const drops = []

    for (const entry of chest.guaranteed ?? []) {
      const value = rollAmount(entry)
      granted[entry.key] = (granted[entry.key] ?? 0) + value
      drops.push({ key: entry.key, value, guaranteed: true })
    }

    // Three weighted rolls: enough variety to feel like a chest, few enough
    // that the numbers stay readable.
    for (let roll = 0; roll < 3; roll += 1) {
      const entry = rollLoot(chest.loot)
      const value = rollAmount(entry)
      granted[entry.key] = (granted[entry.key] ?? 0) + value
      drops.push({ key: entry.key, value, guaranteed: false })
    }

    for (const [key, value] of Object.entries(granted)) {
      save.currencies[key] = (save.currencies[key] ?? 0) + value
      save.earned[key] = (save.earned[key] ?? 0) + value
    }

    save.chests.opened += 1
    bumpDaily('chests', 1, now)
    recordSpend(chest.cost, now)
    save.chests.byId[chest.id] = (save.chests.byId[chest.id] ?? 0) + 1

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: now,
      kind: 'chest',
      chest: chest.id,
      label: chest.label,
      granted,
      drops,
    })

    const unlocked = reconcileAchievements(now)
    for (const entry of unlocked) {
      claimSeq += 1
      pushHistory({ id: claimSeq, at: now, kind: 'achievement', achievement: entry.id, label: entry.label })
    }

    persist()
    return { chest: chest.id, label: chest.label, granted, drops, unlocked }
  }

  function snapshot(now = Date.now()) {
    // Bring every time-based system up to date before reporting it, so the panel
    // shows what has accrued since the last read rather than the last write.
    accrual(now)
    regenSupplies(now)
    settleFarm(now)
    regenStamina(now)
    accrueMiners(now)
    // Both new systems are time-driven, so they are brought up to date on every
    // read — otherwise the panel would report a bite that already happened, or
    // machine hours that were never credited.
    tickCast(now)
    accrueMachines(now)
    if (pruneBuffs(now)) persist()
    const current = view(now)
    const mods = modifiers()
    return {
      state: {
        ...current,
        bornAt: save.bornAt,
        savePath,
        history: save.history.slice(-40).reverse(),
      },
      currencies: CURRENCIES,
      periods: PERIODS.map(({ key, label, short, accent }) => ({ key, label, short, accent })),
      achievements: ACHIEVEMENTS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        desc: entry.desc,
        tier: entry.tier,
        unlockedAt: save.achievements[entry.id] ?? null,
      })),
      shop: UPGRADES.map((definition) => {
        const level = upgradeLevel(definition.id)
        const nextCost = upgradeCost(definition, level)
        const price = nextCost === null ? null : { [definition.cost.currency]: nextCost }
        return {
          id: definition.id,
          label: definition.label,
          desc: definition.desc,
          accent: definition.accent,
          level,
          max: definition.max,
          maxed: nextCost === null,
          costCurrency: definition.cost.currency,
          nextCost,
          affordable: price === null ? false : canAfford(price),
        }
      }),
      chests: CHESTS.map((chest) => ({
        id: chest.id,
        label: chest.label,
        desc: chest.desc,
        accent: chest.accent,
        cost: chest.cost,
        affordable: canAfford(chest.cost),
        opened: save.chests.byId[chest.id] ?? 0,
      })),
      /**
       * Every item the backpack can hold: expedition finds PLUS farm produce.
       *
       * The client looks up pack rows here, so this must be the union. `found` and
       * `sold` stay keyed to the expedition tallies, which is why a crop shows
       * `found: 0` — it was grown, not discovered, and the codex counts only wild
       * finds.
       */
      items: ALL_ITEMS.map((item) => ({
        id: item.id,
        label: item.label,
        desc: item.desc,
        kind: item.kind,
        rarity: item.rarity,
        rarityLabel: RARITY_LABEL[item.rarity],
        accent: item.accent,
        glyph: item.glyph,
        sellFor: item.sellFor ?? null,
        // The price the player would actually receive right now, so the pack
        // shows the haggle multiplier's value rather than the base price.
        sellValue:
          item.sellFor === undefined
            ? null
            : Object.fromEntries(
                Object.entries(item.sellFor).map(([key, value]) => [
                  key,
                  Math.max(1, Math.round(value * mods.haggle)),
                ]),
              ),
        supply: item.supply ?? null,
        buff: item.buff === undefined ? null : { ...item.buff },
        found: save.expedition.found[item.id] ?? 0,
        sold: save.expedition.sold[item.id] ?? 0,
        /** True for farm produce, so the codex can label it as grown. */
        grown: PRODUCE_BY_ID.has(item.id),
      })),
      /** Crops available to plant, with a live affordability flag. */
      crops: CROPS.map((crop) => ({
        id: crop.id,
        label: crop.label,
        desc: crop.desc,
        tier: crop.tier,
        accent: crop.accent,
        glyph: crop.glyph,
        seed: crop.seed,
        needMs: crop.needMs,
        yield: crop.yield,
        yieldLabel: (ALL_ITEM_BY_ID.get(crop.yield.item) ?? { label: crop.yield.item }).label,
        affordable: canAfford(crop.seed),
        grown: save.farm.byCrop[crop.id] ?? 0,
      })),
      /** The farm itself: plot state, prices, and the ailment dictionary. */
      /**
       * The mine: what the panel needs to draw a depth, a stamina bar, the
       * current vein and the ore bag.
       */
      mine: (() => {
        const mods = mineMods()
        const cap = mods.staminaCap
        const toMine = STAMINA_REGEN_MS - Math.max(0, now - save.mine.staminaAt)
        const vein = save.mine.vein
        return {
          depth: save.mine.depth,
          maxDepth: mods.depth,
          depthMax: MINE_DEPTH_MAX,
          stamina: save.mine.stamina,
          staminaCap: cap,
          /** Seconds until the next point of stamina, or null when full. */
          staminaIn: save.mine.stamina >= cap ? null : Math.round(Math.max(0, toMine) / 1000),
          upgrades: Object.fromEntries(MINER_UPGRADES.map((definition) => [definition.id, save.mine.upgrades[definition.id] ?? 0])),
          upgradeList: MINER_UPGRADES.map((definition) => {
            const level = save.mine.upgrades[definition.id] ?? 0
            const nextCost = Math.max(1, Math.round(definition.cost.gold * Math.pow(definition.growth, level)))
            return {
              id: definition.id,
              label: definition.label,
              desc: definition.desc,
              accent: definition.accent,
              level,
              max: definition.max,
              maxed: level >= definition.max,
              nextCost,
              affordable: level < definition.max && save.currencies.gold >= nextCost,
            }
          }),
          vein:
            vein === null
              ? null
              : {
                  ore: vein.ore,
                  label: ORE_BY_ID.get(vein.ore)?.label ?? vein.ore,
                  glyph: ORE_BY_ID.get(vein.ore)?.glyph ?? '▪',
                  accent: ORE_BY_ID.get(vein.ore)?.accent ?? '--dsw-alias-label-secondary',
                  mined: Math.min(vein.total, vein.mined),
                  total: vein.total,
                  percent: Math.round((Math.min(vein.total, vein.mined) / vein.total) * 100),
                },
          veinCapacity: 8 + mods.packCap,
          bufferedSwing: { ...save.mine.bufferedSwing },
          bufferedTotal: Object.values(save.mine.bufferedSwing).reduce((sum, n) => sum + n, 0),
          stats: { ...save.mine.stats },
          bands: MINE_BANDS,
          minDepth: 1,
          /** What descending one lower would cost in stamina. */
          descendCost: 1,
          /** Stamina required to reach the bottom directly. */
          descendAllCost: Math.max(0, mods.depth - save.mine.depth),
          miners: MINERS.map((definition) => {
            const hire = save.mine.miners[definition.id]
            const active = hire !== undefined && hire.endsAt > now
            const buffered = active ? { ...hire.buffered } : {}
            const bufferedTotal = Object.values(buffered).reduce((sum, n) => sum + n, 0)
            return {
              id: definition.id,
              label: definition.label,
              desc: definition.desc,
              accent: definition.accent,
              depth: definition.depth,
              perHour: definition.perHour,
              hireCost: definition.hireCost,
              hireable: canAfford(definition.hireCost),
              wagePerHour: definition.wagePerHour,
              active,
              buffered,
              bufferedTotal,
              full: bufferedTotal >= 8 + mods.packCap,
              /** Ore ids this miner has ever brought in, for the codex view. */
              oreKinds: Object.keys(hire === undefined ? {} : hire.buffered),
            }
          }),
        }
      })(),
      /** 钓鱼: the rod ladder, the spots, and what is on the line right now. */
      fishing: {
        rod: save.fishing.rod,
        spot: save.fishing.spot,
        windowMs: strikeWindowMs(),
        cooldownUntil: save.fishing.cooldownUntil,
        cooldownIn: Math.max(0, save.fishing.cooldownUntil - now),
        cast:
          save.fishing.cast === null
            ? null
            : {
                state: save.fishing.cast.state,
                spot: save.fishing.cast.spot,
                biteIn: Math.max(0, save.fishing.cast.biteAt - now),
                strikeIn: Math.max(0, save.fishing.cast.strikeDeadline - now),
              },
        rods: RODS.map((definition, index) => ({
          id: definition.id,
          label: definition.label,
          desc: definition.desc,
          cost: definition.cost,
          window: definition.window,
          luck: definition.luck,
          accent: definition.accent,
          owned: save.fishing.rods.includes(definition.id),
          /** 正在用的那一根。 */
          active: definition.id === save.fishing.activeRod,
          /** Only the NEXT rung up is purchasable, so the ladder stays ordered. */
          /** 未拥有、且上一级已拥有时可买。 */
          next: !save.fishing.rods.includes(definition.id) && (index === 0 || save.fishing.rods.includes(RODS[index - 1].id)),
          affordable: canAfford(definition.cost),
        })),
        spots: FISHING_SPOTS.map((definition) => ({
          id: definition.id,
          label: definition.label,
          desc: definition.desc,
          accent: definition.accent,
          reqRod: definition.reqRod,
          reqRodLabel: RODS[definition.reqRod]?.label ?? null,
          unlocked: rodRank() >= definition.reqRod,
          active: definition.id === save.fishing.spot,
        })),
        /** The species table with per-fish tallies, for the codex. */
        species: FISH.map((entry) => ({
          id: entry.id,
          label: entry.label,
          desc: entry.desc,
          rarity: entry.rarity,
          rarityLabel: RARITY_LABEL[entry.rarity],
          accent: entry.accent,
          glyph: entry.glyph,
          sellFor: entry.sellFor,
          caught: save.fishing.byFish[entry.id] ?? 0,
        })),
      },

      /** 开店: the chosen mode, the catalog, and the machines on the floor. */
      shopGame: {
        mode: save.shop.mode,
        modeLabel: shopModeDefinition()?.label ?? null,
        modeTagline: shopModeDefinition()?.tagline ?? null,
        chosenAt: save.shop.chosenAt,
        modeSwitches: save.shop.modeSwitches,
        /** What a swap would cost right now, and whether it is affordable. */
        switchCost: modeSwitchCost(save.shop.modeSwitches),
        switchAffordable: canAfford(modeSwitchCost(save.shop.modeSwitches)),
        reputation: save.shop.reputation,
        sales: save.shop.sales,
        manualSales: save.shop.manualSales,
        autoSales: save.shop.autoSales,
        machinesBought: save.shop.machinesBought,
        streak: save.shop.streak,
        bestStreak: save.shop.bestStreak,
        byProduct: { ...save.shop.byProduct },
        revenue: { ...save.shop.revenue },
        /** The picker's two options, with the full explanation, for the dialog. */
        modes: SHOP_MODES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          tagline: entry.tagline,
          points: [...entry.points],
          accent: entry.accent,
          glyph: entry.glyph,
        })),
        products: SHOP_PRODUCTS.map((product) => ({
          id: product.id,
          label: product.label,
          desc: product.desc,
          accent: product.accent,
          glyph: product.glyph,
          unlockAt: product.unlockAt,
          unlocked: productUnlocked(product),
          /** The price actually charged/paid at the current mode. */
          restockCost: restockCost(product),
          salePrice: salePrice(product),
          stock: save.shop.stock[product.id] ?? 0,
          sold: save.shop.byProduct[product.id] ?? 0,
        })),
        machines: SHOP_MACHINES.map((machine) => {
          const owned = save.shop.machines[machine.id]
          const active = owned !== undefined && owned.endsAt > 0
          const buffered = active ? { ...owned.buffered } : {}
          const bufferedTotal = Object.values(buffered).reduce((sum, n) => sum + n, 0)
          return {
            id: machine.id,
            label: machine.label,
            desc: machine.desc,
            accent: machine.accent,
            perHour: machine.perHour,
            hireCost: machine.hireCost,
            wagePerHour: machine.wagePerHour,
            affordable: canAfford(machine.hireCost),
            active,
            buffered,
            bufferedTotal,
            /**
             * Hours' worth of output waiting in the buffer.
             *
             * Derived from the BUFFER, not from `now - endsAt`: `accrueMachines`
             * advances `endsAt` to the present whenever it credits anything, so
             * the timestamp difference is ~0 on a machine that has been running
             * for days. The buffer is what the player is about to collect, so
             * that is what this describes.
             */
            hours: active ? Math.floor(bufferedTotal / Math.max(1, machine.perHour)) : 0,
          }
        }),
      },

      farm: {
        plots: save.farm.plots.map((plot, index) => ({ index, ...plotView(plot, now) })),
        plotsOwned: save.farm.plots.length,
        plotsMax: FARM_PLOTS_MAX,
        expandCost: save.farm.plots.length >= FARM_PLOTS_MAX ? null : plotCost(save.farm.plots.length),
        canExpand: save.farm.plots.length < FARM_PLOTS_MAX && canAfford({ gold: plotCost(save.farm.plots.length) }),
        harvested: save.farm.harvested,
        tended: save.farm.tended,
        byCrop: { ...save.farm.byCrop },
        ailments: AILMENTS.map((entry) => ({ ...entry })),
      },
      destinations: EXPEDITIONS.map((destination) => {
        const cost = tripCost(destination)
        const hours = Math.max(0.05, destination.hours * (1 - mods.swift))
        // The codex comparison uses the SAME shift the real roll would get, so
        // "expected value" reflects the player's current 寻宝罗盘 level.
        const expected = expectedTrip(destination, destination.rarityShift + mods.fortune)
        return {
          id: destination.id,
          label: destination.label,
          desc: destination.desc,
          accent: destination.accent,
          hours: destination.hours,
          effectiveHours: hours,
          supply: cost,
          baseSupply: destination.supply,
          affordable: save.supplies.current >= cost,
          runs: save.expedition.byDestination[destination.id] ?? 0,
          expectedDrops: expected.expectedDrops,
          expectedValue: expected.expectedValue,
          rareChance: expected.rareChance,
          tiers: expected.tiers,
          /** Gold-equivalent per hour of travel; the codex's ranking number. */
          valuePerHour: expected.expectedValue / Math.max(0.05, hours),
          /** Gold-equivalent per unit of supply spent. */
          valuePerSupply: expected.expectedValue / Math.max(1, cost),
        }
      }),
      /** The tree view's branch and node layout, validated against the table. */
      tree: {
        branches: ACHIEVEMENT_BRANCHES.map((branch) => {
          const band = BRANCH_BANDS.bands.get(branch.id) ?? { offsetX: 0, offsetY: 0, width: 0, height: 0 }
          const nodes = ACHIEVEMENT_LAYOUT.filter((node) => node.branch === branch.id)
          return {
            ...branch,
            // Band geometry, so the client can label or frame each strip.
            offsetX: band.offsetX,
            offsetY: band.offsetY,
            bandWidth: band.width,
            bandHeight: band.height,
            // GLOBAL coordinates: the client draws one canvas, so branch-local
            // values would stack every branch on top of every other.
            nodes: nodes.map((node) => {
              const g = globalNode(node)
              return {
                id: g.id,
                x: g.x,
                y: g.y,
                parent: g.parent,
                unlocked: save.achievements[node.id] !== undefined,
              }
            }),
            unlocked: nodes.filter((node) => save.achievements[node.id] !== undefined).length,
            total: nodes.length,
          }
        }),
        /** Grid bounds in GLOBAL cells, so the client can size its canvas. */
        width: BRANCH_BANDS.width,
        height: BRANCH_BANDS.height,
      },
      valuation: { ...VALUATION },
      /**
       * Current settings VALUES on every snapshot, because the client needs them
       * to decide which tabs exist.
       *
       * The SCHEMA is deliberately not here: it is static and would be re-sent on
       * every 5-second poll for no reason. The client fetches it once from
       * `GET /settings` when the settings tab opens.
       */
      settings: { ...settings },
      /** Version, changelog and update preferences — the 「公告」 tab's data. */
      notice: noticeView(),
      /** Today's quests, with live progress and claim state. */
      quests: dailyQuests(now),
      /** Alchemy recipes, each annotated with what the player can do right now. */
      recipes: RECIPES.map((recipe) => {
        const missing = recipeShortfall(recipe)
        const feeOk = canAfford(recipe.fee)
        return {
          id: recipe.id,
          label: recipe.label,
          desc: recipe.desc,
          accent: recipe.accent,
          inputs: recipe.inputs,
          output: recipe.output,
          fee: recipe.fee,
          /** What is missing for the CRAFT, not just the fee. */
          missing,
          feeOk,
          craftable: missing.length === 0 && feeOk,
          made: save.alchemy.byRecipe[recipe.id] ?? 0,
        }
      }),
      /** Rebirth standing and what a rebirth would do right now. */
      rebirth: rebirthPreview(now),
      /** 星盘 upgrades with live prices. */
      starShop: STAR_UPGRADES.map((definition) => {
        const level = starLevel(definition.id)
        const next = starCost(definition, level)
        return {
          id: definition.id,
          label: definition.label,
          desc: definition.desc,
          accent: definition.accent,
          level,
          max: definition.max,
          maxed: next === null,
          nextCost: next,
          affordable: next !== null && save.currencies.star >= next,
        }
      }),
      modifiers: mods,
    }
  }

  /**
   * What the 「公告」 tab renders.
   *
   * Static changelog plus the version facts — no network, so the tab is never
   * empty and never waits on a request. `checkForUpdate` is a separate call the
   * player triggers explicitly.
   */
  /**
   * Mark every shipped changelog entry as read.
   *
   * Deliberately writes the LATEST KNOWN version rather than "the newest entry":
   * those are the same thing today, and pinning it to the changelog's own first
   * row means appending a release automatically makes the tab unread again
   * without touching this function.
   */
  function markNoticeRead(now = Date.now()) {
    const target = CHANGELOG[0]?.version ?? VERSION
    const before = readsUpTo
    readsUpTo = target
    persistSettings()
    void now
    return { readUpTo: readsUpTo, changed: before !== target }
  }

  /** Whether the newest changelog entry is newer than what the player has read. */
  function noticeUnread() {
    const newest = CHANGELOG[0]?.version
    if (typeof newest !== 'string') return false
    if (readsUpTo === null) return true
    return compareVersions(newest, readsUpTo) > 0
  }

  function noticeView() {
    return {
      version: installedVersion() ?? VERSION,
      /** The manifest-literal version, useful when package.json is unreadable. */
      buildVersion: VERSION,
      latestKnown: LATEST_KNOWN_VERSION,
      changelog: CHANGELOG.map((entry) => ({ ...entry, notes: [...entry.notes] })),
      allowUpdateCheck: settings.allowUpdateCheck === true,
      notifyNewVersion: settings.notifyNewVersion === true,
      autoCheckUpdate: settings.autoCheckUpdate === true,
      /** The last automatic check, so the panel can announce what it found. */
      autoCheck: autoUpdateState,
      endpoint: UPDATE_BASE,
      /** The version the player has marked read, or null if never. */
      readUpTo: readsUpTo,
      /** Whether the newest entry is newer than that — drives the tab dot. */
      unread: noticeUnread(),
    }
  }

  function reset() {
    let backupPath = null
    try {
      if (fs.existsSync(savePath)) {
        backupPath = `${savePath}.retired-${Date.now()}`
        fs.copyFileSync(savePath, backupPath)
      }
    } catch {
      backupPath = null
    }
    save = defaultSave()
    save.bornAt = Date.now()
    save.lastSeenAt = Date.now()
    // Seed the time-based clocks, or a fresh save would immediately treat all
    // the time since the epoch as an absence / a full regen period.
    save.offline.accruedAt = Date.now()
    save.supplies.regenAt = Date.now()
    persist()
    return { backupPath }
  }

  // ── self-update ───────────────────────────────────────────────────────────
  //
  // The only code in this plugin that touches the network, and it is entirely
  // player-initiated: nothing here runs unless the player clicks 检查更新, and
  // nothing downloads unless they click 更新 and then confirm.
  //
  // The danger profile is unusual — this code REPLACES ITS OWN SOURCE — so the
  // whole design is "verify first, then swap atomically, and be able to undo":
  //
  //   1. fetch manifest.json, learn the published version and each file's hash
  //   2. fetch every file into memory; verify each hash BEFORE touching disk
  //   3. copy the current files to <file>.backup-<version>
  //   4. write each new file to a temp path, then rename over the real one
  //   5. if ANY step 3–4 fails, restore every backup
  //
  // A half-updated plugin would not merely be broken: the two halves must agree
  // on the wire format, so a new index.js beside an old client.js can fail in
  // ways neither half expects. That is why every file is downloaded and verified
  // before the first write, and why all writes are rolled back together.

  /** The directory this plugin was loaded from, resolved from this module's URL. */
  function pluginDir() {
    try {
      return path.dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  }

  /** The version recorded in package.json, or null when it cannot be read. */
  function installedVersion() {
    try {
      const raw = fs.readFileSync(path.join(pluginDir(), 'package.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
      return null
    }
  }

  /**
   * Fetch with a hard timeout and a size cap.
   *
   * The cap is not paranoia: an update endpoint that started streaming a
   * multi-gigabyte response would otherwise be read into memory until the
   * process dies, and the plugin would take the whole DSH host with it.
   */
  async function fetchText(url, { timeoutMs = 15_000, maxBytes = 4 * 1024 * 1024 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': `dsh-checkin/${VERSION}` },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) throw new Error('响应过大')
      return buffer
    } finally {
      clearTimeout(timer)
    }
  }

  const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

  /**
   * Ask the update source what it has, and compare.
   *
   * Returns a plain report rather than throwing on "no update available": a
   * player pressing 检查更新 on an up-to-date build got a correct answer, not an
   * error, and the UI needs to distinguish those.
   */
  async function checkForUpdate() {
    if (settings.allowUpdateCheck !== true) {
      return {
        ok: false,
        reason: 'disabled',
        message: '检查更新已被关闭（设置 → 更新 → 允许联网检查更新）。',
        current: installedVersion() ?? VERSION,
      }
    }

    const current = installedVersion() ?? VERSION
    try {
      const buffer = await fetchText(`${UPDATE_BASE}/manifest.json`, { maxBytes: 256 * 1024 })
      let manifest
      try {
        manifest = JSON.parse(buffer.toString('utf8'))
      } catch {
        return { ok: false, reason: 'bad-manifest', message: '更新源返回的 manifest.json 不是合法 JSON。', current }
      }
      const latest = typeof manifest?.version === 'string' ? manifest.version : null
      if (latest === null) {
        return { ok: false, reason: 'bad-manifest', message: 'manifest.json 里没有 version 字段。', current }
      }
      const compare = compareVersions(latest, current)
      return {
        ok: true,
        current,
        latest,
        // "newer" is the only state that offers the update button. A published
        // version OLDER than the installed one means the player is ahead of the
        // release branch (a local build, or a rollback) — offering a downgrade
        // there would be surprising, so it is reported and not acted on.
        state: compare > 0 ? 'newer' : compare === 0 ? 'current' : 'ahead',
        notes: Array.isArray(manifest?.notes) ? manifest.notes.filter((n) => typeof n === 'string') : [],
        files: manifest?.files !== null && typeof manifest?.files === 'object' ? manifest.files : {},
        size: Object.keys(manifest?.files ?? {}).length,
      }
    } catch (error) {
      const message = messageOf(error)
      const hint =
        message.includes('abort') || message.includes('Abort')
          ? '请求超时——网络不通，或者更新地址不可达。'
          : message.startsWith('HTTP 404')
            ? `更新地址不存在：${UPDATE_BASE}/manifest.json`
            : message
      return { ok: false, reason: 'network', message: `检查更新失败：${hint}`, current }
    }
  }

  /**
   * The result of the most recent automatic check, for the panel to show.
   *
   * Kept separate from `checkForUpdate`'s return value: a manual check reports
   * back to whoever pressed the button, while this is what the panel asks for on
   * mount so a version found while nobody was looking still gets announced.
   */
  let autoUpdateState = null

  /** How often the automatic check runs. */
  const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

  let autoCheckTimer = null
  let autoCheckKick = null
  let lastAutoCheckAt = 0

  /**
   * Announce a discovered version to the desktop.
   *
   * On Windows this is a real toast through PowerShell's toast API; elsewhere it
   * falls back to a console line, because there is no cross-platform notifier in
   * the dependency-free part of Node and inventing one would mean bundling a
   * native module into a plugin that is otherwise two text files.
   *
   * Failure is logged and swallowed. A desktop that refuses notifications must
   * not make the update check itself fail — the in-app popup is the primary
   * channel, this is the one you see when the app is behind another window.
   */
  function notifyDesktop(title, body) {
    if (process.platform !== 'win32') {
      logger.info?.(`[dsh-moyu] ${title}: ${body}`)
      return
    }
    try {
      // Single-quoted PowerShell string; the message is escaped for it. The
      // script is passed as -Command so no temp files are involved.
      const quote = (text) => `'${String(text).replace(/'/g, "''")}'`
      const script = [
        `$t = ${quote(title)}`,
        `$b = ${quote(body)}`,
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
        "$n = $tpl.GetElementsByTagName('text')",
        '$n.Item(0).AppendChild($tpl.CreateTextNode($t)) | Out-Null',
        '$n.Item(1).AppendChild($tpl.CreateTextNode($b)) | Out-Null',
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)',
        "try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH').Show($toast) } catch { }",
      ].join('; ')
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
    } catch (error) {
      logger.warn?.(`[dsh-moyu] 无法发送系统通知：${messageOf(error)}`)
    }
  }

  /**
   * One automatic check.
   *
   * Runs only when BOTH switches are on. The first switch alone means "manual
   * only", so this must not be reachable from it — that distinction is the whole
   * reason there are two switches.
   */
  async function runAutoCheck(now = Date.now()) {
    if (settings.allowUpdateCheck !== true || settings.autoCheckUpdate !== true) return null
    lastAutoCheckAt = now

    const report = await checkForUpdate()
    const found = report.ok === true && report.state === 'newer'
    autoUpdateState = {
      at: now,
      checked: true,
      found,
      latest: report.ok === true ? report.latest : null,
      current: report.ok === true ? report.current : (installedVersion() ?? VERSION),
      /** Only set when a version was actually found, so the popup is dismissible-once. */
      announceAt: found ? now : null,
      error: report.ok === true ? null : report.message,
    }

    if (found) {
      notifyDesktop('DSH 摸鱼插件有新版本', `${report.latest} 可以更新了（当前 ${report.current}）`)
    } else {
      logger.info?.(
        `[dsh-moyu] 自动检查更新：${report.ok === true ? report.state : report.message}`,
      )
    }
    return autoUpdateState
  }

  /** Start the automatic checker, if the player has asked for it. */
  function syncAutoCheck() {
    const wanted = settings.allowUpdateCheck === true && settings.autoCheckUpdate === true
    if (!wanted) {
      if (autoCheckKick !== null) {
        clearTimeout(autoCheckKick)
        autoCheckKick = null
      }
      if (autoCheckTimer !== null) {
        clearInterval(autoCheckTimer)
        autoCheckTimer = null
      }
      return
    }
    if (autoCheckTimer !== null || autoCheckKick !== null) return

    // First run respects any check that already happened, so a restart loop
    // cannot hammer the update source, then settles into the interval.
    const since = Date.now() - lastAutoCheckAt
    const delay = Math.max(5_000, Math.min(AUTO_CHECK_INTERVAL_MS, AUTO_CHECK_INTERVAL_MS - since))
    autoCheckKick = setTimeout(() => {
      autoCheckKick = null
      void runAutoCheck()
      autoCheckTimer = setInterval(() => void runAutoCheck(), AUTO_CHECK_INTERVAL_MS)
      if (typeof autoCheckTimer?.unref === 'function') autoCheckTimer.unref()
    }, delay)
    if (typeof autoCheckKick?.unref === 'function') autoCheckKick.unref()
  }

  /** Mark the automatic popup as seen, so it does not come back. */
  function dismissAutoUpdate() {
    if (autoUpdateState === null) return { dismissed: false }
    autoUpdateState = { ...autoUpdateState, announceAt: null }
    return { dismissed: true }
  }

  /**
   * Download, verify, and install an update.
   *
   * `confirm` must be true. Not decoration: this overwrites the running plugin
   * and requires a DSH restart to take effect, so a misclick is expensive and
   * cannot be undone from the UI.
   */
  async function applyUpdate({ confirm = false } = {}) {
    if (confirm !== true) {
      return {
        armed: true,
        warning: '更新会覆盖插件自己的 index.js 和 client.js，并且需要重启 DSH 才会生效。确定吗？',
      }
    }
    if (settings.allowUpdateCheck !== true) {
      throw new Error('更新已被关闭（设置 → 更新 → 允许联网检查更新）。')
    }

    const dir = pluginDir()
    const current = installedVersion() ?? VERSION

    // ① Manifest.
    const manifestBuffer = await fetchText(`${UPDATE_BASE}/manifest.json`, { maxBytes: 256 * 1024 })
    const manifest = JSON.parse(manifestBuffer.toString('utf8'))
    const latest = typeof manifest?.version === 'string' ? manifest.version : null
    if (latest === null) throw new Error('manifest.json 里没有 version 字段。')
    if (compareVersions(latest, current) <= 0) {
      return { upToDate: true, current, latest, message: `已经是最新的（${current}）。` }
    }

    const declared = manifest?.files
    if (declared === null || typeof declared !== 'object') {
      throw new Error('manifest.json 里没有 files 清单，不知道该下载哪些文件。')
    }
    /**
     * The file list is intersected with the allow-list, never taken verbatim.
     *
     * An update source that could name any path — `../../.dsh/.credentials.yaml`
     * — would turn "update" into arbitrary file write, driven by whoever controls
     * that URL. Only the plugin's own three files are ever written.
     */
    const targets = UPDATE_FILES.filter((name) => typeof declared[name] === 'string')
    if (targets.length === 0) throw new Error('manifest.json 里没有列出任何可更新的文件。')

    // ② Download and verify EVERYTHING before the first disk write.
    const downloads = []
    for (const name of targets) {
      const expected = String(declared[name]).toLowerCase()
      const buffer = await fetchText(`${UPDATE_BASE}/${name}`, { maxBytes: 4 * 1024 * 1024 })
      const actual = sha256(buffer)
      if (actual !== expected) {
        throw new Error(
          `${name} 的校验不通过（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）——已中止，什么都没改。`,
        )
      }
      downloads.push({ name, buffer, path: path.join(dir, name) })
    }

    // ③ Back up, then ④ write-then-rename each file.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backups = []
    const written = []
    try {
      for (const item of downloads) {
        if (fs.existsSync(item.path)) {
          const backupPath = `${item.path}.backup-${stamp}`
          fs.copyFileSync(item.path, backupPath)
          backups.push({ from: item.path, to: backupPath })
        }
      }
      for (const item of downloads) {
        const temp = `${item.path}.tmp-${process.pid}`
        fs.writeFileSync(temp, item.buffer)
        fs.renameSync(temp, item.path)
        written.push(item.path)
      }
    } catch (error) {
      // Roll every file back, not just the one that failed: a partial update is
      // the one state the two halves cannot survive.
      const restored = []
      for (const backup of backups) {
        try {
          fs.copyFileSync(backup.to, backup.from)
          restored.push(path.basename(backup.from))
        } catch {
          // Best effort; the error below still reports the failure.
        }
      }
      throw new Error(
        `更新失败：${messageOf(error)}${restored.length > 0 ? `（已还原：${restored.join('、')}）` : '（未能还原，请手动从 .backup 文件恢复）'}`,
      )
    }

    claimSeq += 1
    pushHistory({
      id: claimSeq,
      at: Date.now(),
      kind: 'update',
      label: `v${current} → v${latest}`,
      version: latest,
      files: downloads.map((d) => d.name),
    })
    persist()

    return {
      updated: true,
      current,
      latest,
      files: downloads.map((d) => d.name),
      backups: backups.map((b) => path.basename(b.to)),
      // The one thing the UI must say loudly: nothing changes until a restart,
      // because the running code is already loaded into memory.
      restartRequired: true,
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  function rejectionFor(req) {
    const connection = ctx.get('connection')
    if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
      return connection.requestRejection({ headers: req.headers })
    }
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      try {
        const host = req.headers?.host
        if (typeof host === 'string' && host !== '' && new URL(origin).host !== host) return 403
      } catch {
        return 403
      }
    }
    return undefined
  }

  async function readJson(req, cap = 64 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > cap) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw === '') return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  // Unlock anything the imported save already satisfies, so a save written by an
  // older build gains its achievements on first load rather than on next claim.
  // Seed the offline clock on a first-ever save so the initial read does not
  // treat all time since the epoch as an absence.
  if (save.offline.accruedAt === 0) save.offline.accruedAt = Date.now()
  if (save.supplies.regenAt === 0) save.supplies.regenAt = Date.now()
  reconcileAchievements(Date.now())
  persist()

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const routePath = url.pathname.replace(/^\/api\/checkin/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      const send = (status, payload) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      }

      const rejection = rejectionFor(req)
      if (rejection !== undefined) {
        return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      }

      try {
        // Every successful response carries the complete snapshot plus the
        // operation's own outcome under `result`, so the client never has to
        // merge a partial payload into its state.
        if (method === 'GET' && (routePath === '/' || routePath === '/state')) {
          return send(200, { ...snapshot(), result: null })
        }

        if (method === 'POST' && routePath === '/claim') {
          const body = await readJson(req)
          const key = typeof body.period === 'string' ? body.period : ''
          const result = claim(key)
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/claim-all') {
          const result = claimAll()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/buy') {
          const body = await readJson(req)
          const result = buyUpgrade(typeof body.upgrade === 'string' ? body.upgrade : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/open') {
          const body = await readJson(req)
          const result = openChest(typeof body.chest === 'string' ? body.chest : '')
          return send(200, { ...snapshot(), result })
        }
        /**
         * Bulk-open, up to `CHEST_BULK_MAX` at once.
         *
         * The loop stops at the point the player can no longer afford another, so
         * "buy 10" with money for 4 opens 4 and reports `requested`/`opened` —
         * it never silently opens fewer and never goes into debt.
         */
        if (method === 'POST' && routePath === '/open-bulk') {
          const body = await readJson(req)
          const id = typeof body.chest === 'string' ? body.chest : ''
          const requested = Math.min(CHEST_BULK_MAX, Math.max(1, Math.round(num(body.count, 1))))
          const opened = []
          let failure = null
          for (let i = 0; i < requested; i += 1) {
            try {
              opened.push(openChest(id))
            } catch (error) {
              failure = messageOf(error)
              break
            }
          }
          const result = { chest: id, requested, openedCount: opened.length, failure, opened }
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/collect-offline') {
          const result = collectOffline()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/depart') {
          const body = await readJson(req)
          const result = depart(typeof body.destination === 'string' ? body.destination : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/collect-trip') {
          const result = collectTrip()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/sell') {
          const body = await readJson(req)
          const result = sellItem(
            typeof body.item === 'string' ? body.item : '',
            body.count === undefined ? 1 : num(body.count, 1),
          )
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/quest') {
          const body = await readJson(req)
          const result = claimQuest(typeof body.id === 'string' ? body.id : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/alchemy') {
          const body = await readJson(req)
          const result = alchemy(typeof body.recipe === 'string' ? body.recipe : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'GET' && routePath === '/settings') {
          return send(200, { ...snapshot(), result: settingsView() })
        }
        if (method === 'POST' && routePath === '/settings') {
          const body = await readJson(req)
          // The whole body is the patch; `normalizeSettings` drops anything that
          // is not in the schema, so a stale or hostile client cannot invent keys.
          const patch = body !== null && typeof body === 'object' ? body : {}
          const result = updateSettings(patch)
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/settings-reset') {
          const result = updateSettings(DEFAULT_SETTINGS)
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/update-check') {
          const result = await checkForUpdate()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/update-auto-check') {
          // Runs ONE automatic check on demand. Refused unless both switches are
          // on, so pressing it cannot be used to bypass the manual-only posture
          // the first switch promises on its own.
          if (settings.allowUpdateCheck !== true || settings.autoCheckUpdate !== true) {
            return send(400, { error: '自动检查更新没有打开。' })
          }
          const result = await runAutoCheck()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/update-dismiss') {
          // Clearing the popup is a UI acknowledgement, not a game action: it
          // answers 200 even when there was nothing to dismiss.
          const result = dismissAutoUpdate()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/update-apply') {
          const body = await readJson(req)
          // Two-step in one route, mirroring return/rebirth: the first call arms
          // and explains, the second (with confirm) actually runs.
          const result = await applyUpdate({ confirm: body?.confirm === true })
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/trip-sleep') {
          const result = tripSleep()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/trip-gather') {
          const result = tripGather()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/trip-return') {
          const body = await readJson(req)
          const result = tripReturnHome(undefined, { confirm: body?.confirm === true })
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/mine-swing') {
          const result = swing()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/mine-depth') {
          const body = await readJson(req)
          const result = setDepth(num(body.depth, 0))
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/mine-collect') {
          const result = collectSwing()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/mine-upgrade') {
          const body = await readJson(req)
          const result = buyMinerUpgrade(typeof body.upgrade === 'string' ? body.upgrade : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/mine-hire') {
          const body = await readJson(req)
          const result = hireMiner(typeof body.miner === 'string' ? body.miner : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/mine-collect-miner') {
          const body = await readJson(req)
          const result = collectMiner(typeof body.miner === 'string' ? body.miner : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/fish-cast') {
          // Run the effect FIRST, then snapshot. Written the other way round,
          // `{ ...snapshot(), result: castLine() }` evaluates snapshot() first and
          // reports the world before the cast — so the new cast was invisible
          // until the next poll, and the three strike outcomes could never see it.
          const result = castLine()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/fish-strike') {
          const result = strike()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/fish-rod') {
          const body = await readJson(req)
          const result = buyRod(typeof body.rod === 'string' ? body.rod : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/fish-spot') {
          const body = await readJson(req)
          const result = setSpot(typeof body.spot === 'string' ? body.spot : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/fish-switch-rod') {
          const body = await readJson(req)
          const result = switchRod(typeof body.rod === 'string' ? body.rod : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/shop-mode') {
          const body = await readJson(req)
          const result = chooseShopMode(typeof body.mode === 'string' ? body.mode : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/notice-read') {
          const result = markNoticeRead()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/shop-restock') {
          const body = await readJson(req)
          const result = restock(
            typeof body.product === 'string' ? body.product : '',
            body.count === undefined ? 1 : num(body.count, 1),
          )
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/shop-sell') {
          const body = await readJson(req)
          const result = manualSale(typeof body.product === 'string' ? body.product : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/shop-machine') {
          const body = await readJson(req)
          const result = buyMachine(typeof body.machine === 'string' ? body.machine : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/shop-collect') {
          const body = await readJson(req)
          const result = collectMachine(typeof body.machine === 'string' ? body.machine : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/plant') {
          const body = await readJson(req)
          const result = plant(num(body.plot, -1), typeof body.crop === 'string' ? body.crop : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/tend') {
          const body = await readJson(req)
          const result = tend(num(body.plot, -1))
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/tend-all') {
          const result = tendAll()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/harvest') {
          const body = await readJson(req)
          const result = harvest(num(body.plot, -1))
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/harvest-all') {
          const result = harvestAll()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/expand') {
          const result = expandFarm()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/rebirth') {
          const result = rebirth()
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/star') {
          const body = await readJson(req)
          const result = buyStarUpgrade(typeof body.upgrade === 'string' ? body.upgrade : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/use') {
          const body = await readJson(req)
          const result = useItem(typeof body.item === 'string' ? body.item : '')
          return send(200, { ...snapshot(), result })
        }
        if (method === 'POST' && routePath === '/reset') {
          const result = reset()
          return send(200, { ...snapshot(), result })
        }
        return send(404, { error: 'not found' })
      } catch (error) {
        if (!disposed) logger.warn?.(`checkin: ${messageOf(error)}`)
        return send(400, { error: messageOf(error) })
      }
    }

    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/api/checkin', handler }),
      'checkin: api routes',
    )
    logger.info?.(`checkin: API mounted at /api/checkin（存档：${savePath}）`)
  })

  ctx.effect(
    () => () => {
      disposed = true
      // Stop the automatic checker on teardown, or a reloaded plugin would leave
      // an interval running that phones home forever.
      if (autoCheckKick !== null) {
        clearTimeout(autoCheckKick)
        autoCheckKick = null
      }
      if (autoCheckTimer !== null) {
        clearInterval(autoCheckTimer)
        autoCheckTimer = null
      }
      save.lastSeenAt = Date.now()
      persist()
    },
    'checkin: lifecycle',
  )

  // Honour a saved "自动检查更新" from the previous session.
  syncAutoCheck()
}

/** A short human duration, used in refusal messages. */
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}
