/**
 * Guard: every foraged find must have a display name.
 *
 * The client resolves an item id to its Chinese label through the item union. An
 * id that exists in the `FORAGE` table but not in that union still WORKS — the
 * find enters the pack, it sells for the right price — but every UI surface that
 * names it silently falls back to the raw English id ("stick", "berry").
 *
 * This exact bug shipped: two forage finds were functional but nameless. The fix
 * was two table rows; the guard keeps a third one from shipping the same way.
 *
 *   node tools/test-forage-names.mjs
 */
const { FORAGE, ALL_ITEMS } = await import('../index.js')

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

const unionIds = new Set(ALL_ITEMS.map((item) => item.id))

check('采集表非空', FORAGE.length > 0, `${FORAGE.length}`)

const missing = FORAGE.filter((entry) => !unionIds.has(entry.id))
check(
  '每种采集物都能解析出中文名（都在物品联合表里）',
  missing.length === 0,
  missing.length === 0 ? undefined : missing.map((entry) => `${entry.id}（${entry.label}）`).join(', '),
)

check(
  '每种采集物都带中文 label（表内自身不缺名）',
  FORAGE.every((entry) => typeof entry.label === 'string' && entry.label.length > 0),
)

check(
  '每种采集物都带 glyph 和 accent（面板能画出来）',
  FORAGE.every((entry) => typeof entry.glyph === 'string' && typeof entry.accent === 'string'),
)

// Supply-kind finds must be usable (they restore supplies through the normal
// `use` route), so they need a positive `supply` amount.
check(
  '补给类采集物带正的 supply 数值',
  FORAGE.filter((entry) => entry.kind === 'supply').every((entry) => (entry.supply ?? 0) > 0),
  JSON.stringify(FORAGE.filter((entry) => entry.kind === 'supply' && !((entry.supply ?? 0) > 0)).map((e) => e.id)),
)

// Sell-kind finds must have a price, or the seller refuses them.
check(
  '可卖采集物带非空 sellFor',
  FORAGE.filter((entry) => entry.kind === 'sell').every(
    (entry) => entry.sellFor !== null && typeof entry.sellFor === 'object' && Object.keys(entry.sellFor ?? {}).length > 0,
  ),
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
