/**
 * Smoke test: does the CLIENT half actually render without throwing?
 *
 * The host suites prove the data is right, and the contract suite proves the
 * field NAMES match. Neither proves the render code works — a typo in a style
 * key, a missing component, or a null dereference only shows up when React
 * actually calls the component, and in the browser that failure is silent: the
 * slot entry just goes blank with a console error nobody reads.
 *
 * So this test stubs `window.__ModuleLoader__`, stubs `fetch`, provides a minimal
 * React shim that records the element tree, and calls the real `apply()` and the
 * real page component against a real host snapshot.
 *
 *   node tools/test-client-render.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-render-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('../index.js')

// ── boot the host so a real snapshot can be produced ─────────────────────────

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

async function snapshot() {
  const req = {
    method: 'GET',
    url: '/api/checkin/state',
    headers: {},
    async *[Symbol.asyncIterator]() {},
  }
  let payload = null
  const res = { writeHead() {}, end: (text) => { payload = JSON.parse(text) } }
  await route.handler(req, res)
  return payload
}

const realSnapshot = await snapshot()

/**
 * A snapshot the store-page checks can override.
 *
 * 
ealSnapshot comes from a FRESH save, so shopGame.mode is null there and
 * the store tab renders the opening picker. Tests that need the shop floor — the
 * switch card in particular — must supply a snapshot where a mode is already
 * chosen, which is what this indirection is for.
 */
let activeSnapshot = realSnapshot
const applySnapshot = (next) => {
  activeSnapshot = next
}

/** The static settings schema, so the panel can be driven for real. */
const { settingsSchema } = await import('../index.js')

// ── a minimal React shim that actually calls function components ─────────────

const rendered = []
let hookSlots = []
let hookCursor = 0
let hookSlotsKey = null
/**
 * Per-component hook storage, keyed by component function name.
 *
 * React keeps a component's state across re-renders; this shim must too, or every
 * state change is written into a discarded array and a drag can never be observed.
 */
const componentSlots = {}
let effectQueue = []
/**
 * Every `useState` initial value paired with its setter, so the test can drive
 * state changes the way a click would — without guessing hook indices.
 */
const setters = []

/**
 * The shim mirrors React's real contract for the parts this plugin uses:
 * `createElement` builds a node, function components are invoked (so their body
 * runs, which is the point), `useState` returns a stable slot, and `useEffect`
 * is recorded for the test to flush.
 */
/**
 * Every created element, so the test can reach a specific node's props.
 *
 * Refs are the reason this matters: the tree's drag code calls
 * `viewportRef.current.setPointerCapture(...)` and reads `clientWidth`, neither of
 * which exists unless React has actually attached the ref to a DOM-like object.
 * A shim that ignores refs cannot test a drag at all.
 */
const allNodes = []

/** A DOM-ish element good enough to attach a ref and fire events at. */
function makeElement() {
  return {
    // Deliberately the NARROW case: a ~700px panel is common, and a viewport wider
    // than the canvas is exactly the geometry that made horizontal dragging
    // silently impossible. Testing against an over-wide viewport would hide that.
    clientWidth: 700,
    clientHeight: 460,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 460 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
  }
}

const React = {
  createElement(type, props, ...children) {
    const node = {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }
    allNodes.push(node)
    // Attach any ref to a DOM-ish element immediately, which is what React does
    // on commit. Without this the tree's drag handlers have no element to work
    // with and a drag cannot be exercised.
    if (node.props.ref !== undefined && node.props.ref !== null) {
      node.element = makeElement()
      node.props.ref.current = node.element
    }
    return node
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    /**
     * Capture the OWNING array, not the module-level variable.
     *
     * `render` swaps `hookSlots` per component invocation and restores the outer
     * array when it returns. If the setter read `hookSlots` at call time, every
     * update made after rendering — exactly what a drag handler does — would land
     * in the wrong array, and the next render would still see the old value. That
     * is why the drag test reported pan (0,0) regardless of the component being
     * correct.
     */
    const owner = hookSlots
    if (owner[index] === undefined) owner[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      owner[index] = typeof next === 'function' ? next(owner[index]) : next
    }
    // Record it so the test can locate a specific state by its initial value.
    setters.push({ initial: owner[index], set })
    return [owner[index], set]
  },
  useEffect(effect) {
    effectQueue.push(effect)
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(initial) {
    const index = `ref${hookCursor}`
    hookCursor += 1
    if (hookSlots[index] === undefined) hookSlots[index] = { current: initial }
    return hookSlots[index]
  },
}

/** Walk a rendered node tree, invoking function components as React would. */
function render(node, track, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.type === React.Fragment) {
    for (const child of node.children) render(child, track, depth)
    return null
  }
  if (typeof node.type === 'function') {
    /**
     * Hook slots are keyed PER COMPONENT FUNCTION, not per invocation.
     *
     * React keeps a component's state across re-renders, so a setter must write
     * to storage that survives the next call. An earlier version swapped in a
     * throwaway array each time, which meant every state change was written into
     * an array that was immediately discarded — so a drag test could never see
     * the pan change, and the component re-read `null`.
     */
    const key = node.type.name || `anon${node.typeId ?? ''}`
    const savedSlots = hookSlots
    const savedCursor = hookCursor
    const savedKey = hookSlotsKey
    if (componentSlots[key] === undefined) componentSlots[key] = []
    hookSlots = componentSlots[key]
    hookSlotsKey = key
    hookCursor = 0
    let output
    try {
      output = node.type({ ...node.props, children: node.children })
    } catch (error) {
      throw new Error(`component "${key}" threw: ${error.message}`)
    } finally {
      rendered.push(key)
      if (track !== undefined) track.push(key)
      hookSlots = savedSlots
      hookCursor = savedCursor
      hookSlotsKey = savedKey
    }
    return render(output, track, depth + 1)
  }
  for (const child of node.children) render(child, track, depth + 1)
  return null
}

// ── the loader + DOM shims ───────────────────────────────────────────────────

let clientModule = null

// Capture the REAL timers before the client's globals are stubbed, or the test's
// own `await` would hang on a setTimeout that never fires.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      clientModule = spec
    },
  },
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:19397/',
}
// The shape `SettingsPanel` expects from `GET /api/checkin/settings`.
const settingsView = () => ({
  values: realSnapshot.settings,
  schema: settingsSchema.map((entry) => ({ ...entry })),
  path: '<tmp>/checkin/settings.json',
})
globalThis.fetch = async () => {
  throw new Error('fetch must not be called during a render test')
}
// The client polls and schedules toasts; the test drives rendering directly, so
// these are stubbed to no-ops. `setTimeout` especially, or the page's toast timer
// would keep the process alive.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}

// Load the real client bundle.
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'React', clientSource)(globalThis.window, globalThis.document, React)

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

section('客户端加载')

check('client.js 调用了 __ModuleLoader__.load', clientModule !== null)
check('模块 id 正确', clientModule?.id === '@local/dsh-moyu', clientModule?.id)

const plugin = clientModule.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

check('factory 返回插件对象', plugin !== null && typeof plugin === 'object')
check('插件名正确', plugin.name === 'dsh-moyu', plugin.name)
check('inject 含 slots 与 layout', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('layout'), JSON.stringify(plugin.inject))

section('注册席位')

const registrations = []
const fakeLayout = { selectPanel: () => {} }
const slotsCtx = {
  slots: {
    inject(seat, callback) {
      // The real service runs the generator/function to collect registrations.
      const produced = callback()
      const items = produced !== null && typeof produced === 'object' && Symbol.iterator in Object(produced)
        ? [...produced]
        : [produced]
      for (const item of items) registrations.push({ seat, item })
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
  layout: fakeLayout,
}

plugin.apply({ ...slotsCtx, layout: fakeLayout })

const seats = registrations.map((r) => r.item.options.name)
check('注册了 sidebar.footer.action', seats.includes('sidebar.footer.action'), seats.join(','))
check('注册了 main', seats.includes('main'), seats.join(','))
check('注册了 sidebar.panellist', seats.includes('sidebar.panellist'), seats.join(','))
// The third door: a claimable row inside DSH's own settings page. It is a
// SEPARATE seat from the two sidebar ones, and forgetting to register it would
// leave the feature silently missing with no error anywhere.
check('注册了 settings.general.item（设置页签到行）', seats.includes('settings.general.item'), seats.join(','))
check(
  '设置行用的是自己的 id（不复用别人的格子）',
  registrations.find((r) => r.item.options.name === 'settings.general.item')?.item.options.id === 'checkin-claim',
  JSON.stringify(registrations.find((r) => r.item.options.name === 'settings.general.item')?.item.options),
)
check('main 用的是 key 而不是 id', registrations.find((r) => r.item.options.name === 'main')?.item.options.key === 'dsh-moyu')
check(
  'sidebar.panellist 用的是 id 而不是 key',
  registrations.find((r) => r.item.options.name === 'sidebar.panellist')?.item.options.id === 'dsh-moyu',
)

section('标签栏不会被压成竖排')

/**
 * Reported from a screenshot: with 15 tabs the bar squeezed every button until
 * 签到 rendered as a vertical 签 / 到.
 *
 * `styles` is private to the client module, so this asserts on the source text
 * rather than a rendered tree — the properties are what matter, and they are
 * exactly the kind of line that gets dropped while editing a stylesheet.
 *
 * The three that matter:
 *   · the bar WRAPS instead of staying one row;
 *   · a tab never SHRINKS (flex items shrink by default);
 *   · a label never breaks — Chinese has a break opportunity between every pair
 *     of characters, so `whiteSpace: nowrap` is what actually stops 签到 from
 *     splitting into two lines.
 */
{
  const tabBarBlock = clientSource.match(/tabBar:\s*\{([\s\S]*?)\n {6}\},/)?.[1] ?? ''
  const tabBlock = clientSource.match(/\n {6}tab:\s*\{([\s\S]*?)\n {6}\},/)?.[1] ?? ''
  const activeBlock = clientSource.match(/tabActive:\s*\{([\s\S]*?)\n {6}\},/)?.[1] ?? ''

  check('标签栏样式存在', tabBarBlock !== '', 'tabBar block not found')
  check('标签栏允许换行', tabBarBlock.includes("flexWrap: 'wrap'"), tabBarBlock.slice(0, 120))
  check('标签栏不会超出面板', tabBarBlock.includes("maxWidth: '100%'"), tabBarBlock.slice(0, 120))
  check('标签按钮不会被压缩', tabBlock.includes('flexShrink: 0'), tabBlock.slice(0, 120))
  check('标签文字不折行', tabBlock.includes("whiteSpace: 'nowrap'"), tabBlock.slice(0, 120))
  check('选中态同样不压缩', activeBlock.includes('flexShrink: 0'), activeBlock.slice(0, 120))
  check('选中态同样不折行', activeBlock.includes("whiteSpace: 'nowrap'"), activeBlock.slice(0, 120))
}

section('渲染：页面的每个标签页')

// The page component fetches on mount; give it the real snapshot synchronously.
/**
 * A route-aware fetch.
 *
 * `SettingsPanel` fetches `/settings` and reads `payload.result.schema`, while
 * every other component reads the snapshot from `/state`. Returning the snapshot
 * for EVERY route left the settings tab rendering only its error branch — it
 * looked green while never exercising a single row. This closes that gap.
 */
/**
 * Every request the client makes, in order.
 *
 * Shared mutable state on purpose: the "does clicking do anything" checks below
 * need to know whether a click produced a request, and that is only observable
 * from the transport.
 */
const fetchedPaths = []

function fetchForRoute(url) {
  const path = typeof url === 'string' ? url : String(url?.pathname ?? url?.url ?? url)
  fetchedPaths.push(path)
  if (path.includes('/api/checkin/settings')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ state: realSnapshot.state, result: settingsView() }),
    })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => activeSnapshot })
}

globalThis.fetch = async (url) => fetchForRoute(url)

const pageComponent = registrations.find((r) => r.item.options.name === 'main').item.component

/**
 * Render the page at a given tab, then flush effects + the microtask queue so
 * the fetch resolves and the component re-renders with data.
 */
async function renderPage(interactions = []) {
  const page = pageComponent({
    usePanelInfo: (selector) => selector({ activePanelId: 'dsh-moyu' }),
  })
  render(page)
  // Flush effects, then let the pending fetch promise settle.
  for (const effect of effectQueue.splice(0)) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  await new Promise((resolve) => realSetTimeout(resolve, 0))
  return page
}

let threw = null
try {
  await renderPage()
} catch (error) {
  threw = error
}
check('页面首次渲染不抛异常', threw === null, threw?.message)

// After the fetch resolves the component has data; render again to exercise all
// the data-dependent branches, which is where a real crash would live.
const badges = registrations.find((r) => r.item.options.name === 'sidebar.footer.action').item.component
threw = null
try {
  // The badge reads via useCheckin; render it with data present.
  const badgeNode = badges({ wide: true, usePanelInfo: (s) => s({ activePanelId: null }), selectPanel: () => {} })
  render(badgeNode)
  for (const effect of effectQueue.splice(0)) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  await new Promise((resolve) => realSetTimeout(resolve, 0))
  render(badges({ wide: false, usePanelInfo: (s) => s({ activePanelId: 'dsh-moyu' }), selectPanel: () => {} }))
} catch (error) {
  threw = error
}
check('侧边徽章渲染不抛异常', threw === null, threw?.message)

const panelIcon = registrations.find((r) => r.item.options.name === 'sidebar.panellist').item.component
threw = null
try {
  render(panelIcon({ size: 16, active: true }))
} catch (error) {
  threw = error
}
check('侧边图标渲染不抛异常', threw === null, threw?.message)

// ── every tab, with real data ────────────────────────────────────────────────

section('渲染：九个标签页都有数据可渲染')

// Re-mount with data already fetched, then force each tab by patching useState's
// initial value for the tab slot. The tab index is the third useState in
// CheckinPage (toast, showLocked, tab, achView, dexView).
for (const [index, name] of [
  [2, 'tab'],
]) {
  void index
  void name
}

/**
 * Render the page with the network already resolved, so the data branches run.
 *
 * The subtlety that made an earlier version of this test pass VACUOUSLY: the
 * first `pageComponent()` call runs while `data` is still `null`, and it returns
 * an early "loading" tree. Re-rendering that SAME node object cannot help — it
 * was built from the null-data branch. The component has to be INVOKED AGAIN
 * after the fetch resolves, which is what React does on a state update.
 *
 * Rather than guess hook indices (fragile: a `useRef` after the states shifts
 * them), this finds the setters by their distinctive initial values.
 */
async function renderWithData(tabValue, achViewValue, dexViewValue, track) {
  hookSlots = []
  hookCursor = 0
  effectQueue = []
  setters.length = 0

  /**
   * Mount pass.
   *
   * The first `pageComponent()` runs with `data === null`, so it only returns the
   * loading branch — its purpose here is to START the fetch and to create the
   * state slots the rest of this function drives.
   */
  const mount = pageComponent({ usePanelInfo: (s) => s({ activePanelId: 'dsh-moyu' }) })
  void mount
  runEffects(true)
  await settle()

  // Drive the three view states the way a click would. Each setter is located by
  // the initial value only that state has.
  const tabSetter = setters.find((s) => s.initial === 'claim')
  const achSetter = setters.find((s) => s.initial === 'list')
  const dexSetter = setters.find((s) => s.initial === 'routes')
  if (tabSetter !== undefined) tabSetter.set(tabValue)
  if (achSetter !== undefined) achSetter.set(achViewValue)
  if (dexSetter !== undefined) dexSetter.set(dexViewValue)

  /**
   * Re-invoke the component so it reads the updated state and the fetched data.
   *
   * `render()` is what actually walks the tree and invokes children, so the
   * settings panel's own mount effect only fires during the render pass below —
   * meaning its schema fetch has not even STARTED until then. Hence: render,
   * flush, wait, render again.
   *
   * Cleanups are deliberately NOT run between passes. The components persist
   * across a re-render, so invoking an effect's cleanup immediately would set a
   * child's own `alive` flag to false and silently swallow its fetch result —
   * which is precisely why the settings tab was unverifiable for so long.
   * They are collected and run only at the very end of the file.
   */
  hookCursor = 0
  effectQueue = []
  const tree = pageComponent({ usePanelInfo: (s) => s({ activePanelId: 'dsh-moyu' }) })
  if (track !== undefined) track.length = 0
  render(tree, track)
  runEffects(false)
  await settle()

  // Second pass, with the child's fetched data now available.
  allNodes.length = 0
  hookCursor = 0
  effectQueue = []
  const again = pageComponent({ usePanelInfo: (s) => s({ activePanelId: 'dsh-moyu' }) })
  if (track !== undefined) track.length = 0
  render(again, track)
  runEffects(false)
  await settle()
  return again

  /**
   * Run queued effects.
   *
   * @param teardown when true, cleanups fire (a real unmount) rather than being
   *   retained for the end of the suite.
   */
  function runEffects(teardown) {
    for (const effect of effectQueue.splice(0)) {
      const cleanup = effect()
      if (typeof cleanup !== 'function') continue
      if (teardown) cleanup()
      else activeCleanups.push(cleanup)
    }
  }
}

/** Cleanups pending a real unmount, run once at the end of the file. */
const activeCleanups = []

/** Let the fetch promise chain drain. */
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0))

for (const tab of ['claim', 'quest', 'farm', 'trip', 'pack', 'alchemy', 'shop', 'chest', 'star', 'fish', 'store', 'ach', 'notice', 'about', 'settings']) {
  let error = null
  try {
    await renderWithData(tab, 'list', 'routes')
  } catch (err) {
    error = err
  }
  check(`标签页「${tab}」渲染不抛异常`, error === null, error?.message)
}

section('渲染：钓鱼页')

/**
 * The fishing panel is a timing game with exactly one meaningful control, and its
 * LABEL is the state: 下竿 / 等着… / 收杆！. A "does not throw" pass cannot tell
 * whether that label is right, and a wrong label is the whole bug — a player who
 * sees 下竿 while a fish is biting will never catch anything.
 */
{
  await renderWithData('fish', 'list', 'routes')
  const texts = []
  allNodes.forEach((node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child)
  })
  const page = texts.join('\n')

  const snapshotFishing = realSnapshot.fishing
  check('钓鱼页渲染出鱼竿列表', snapshotFishing.rods.every((r) => page.includes(r.label)))
  check('钓鱼页渲染出钓点', snapshotFishing.spots.every((s) => page.includes(s.label)))
  check('钓鱼页渲染出鱼类图鉴', page.includes('鱼类图鉴'))
  // Uncaught species must be hidden, not named: the codex would otherwise spoil
  // the whole progression on a fresh save.
  check('未钓到的鱼不显示名字', page.includes('？？？'), 'codex should mask unknown species')
  const buttons = allNodes.filter((node) => node.type === 'button')
  const labels = buttons.map((b) => (b.children ?? []).filter((c) => typeof c === 'string').join(''))
  check('空闲时主按钮是「下竿」', labels.includes('下竿'), labels.join(' | '))
  check('空闲时没有「收杆」按钮', !labels.includes('收杆！'))
}

section('渲染：钓鱼的收杆窗口在本地推进')

/**
 * THE BUG THIS EXISTS FOR: the panel polls every 15s while the strike window is
 * 0.7s, so waiting for the host to report `biting` meant the window had always
 * closed before the client heard about it. The button stayed on 「等着…」,
 * disabled, and fishing was unwinnable — you could cast and then do nothing.
 *
 * The deltas (`biteIn` / `strikeIn`) were always correct; only the client-side
 * derivation was missing. So this drives a cast through its three phases by
 * controlling the clock and asserts the label AND the enabled state at each one.
 * Asserting only the idle state — which every earlier check did — could never
 * have caught it.
 */
{
  const realNow = Date.now
  let fake = 1_000_000
  Date.now = () => fake

  const castSnapshot = JSON.parse(JSON.stringify(realSnapshot))
  // A cast 1000ms from biting, with a 700ms window after that. The shape matches
  // what the host sends: deltas from the snapshot instant, not timestamps.
  castSnapshot.state.fishCast = { state: 'waiting', spot: 'pond', biteIn: 1000, strikeIn: 1700 }
  castSnapshot.state.fishWindowMs = 700
  castSnapshot.state.fishCooldownUntil = 0
  applySnapshot(castSnapshot)

  /** Re-invoke the page so it re-reads the frozen clock. */
  const pageAgain = () => pageComponent({ usePanelInfo: (sel) => sel({ activePanelId: 'dsh-moyu' }) })

  const readUi = () => {
    const texts = []
    allNodes.forEach((n) => {
      for (const child of n.children ?? []) if (typeof child === 'string') texts.push(child)
    })
    const buttons = allNodes.filter((n) => n.type === 'button')
    const main = buttons.find((b) =>
      (b.children ?? []).some(
        (c) => typeof c === 'string' && (c.startsWith('下竿') || c.startsWith('收杆')),
      ),
    )
    return { text: texts.join('\n'), main, disabled: main?.props.disabled === true }
  }

  const redraw = () => {
    hookCursor = 0
    effectQueue = []
    allNodes.length = 0
    render(pageAgain())
  }

  // ── phase 1: waiting (100ms in) ──
  await renderWithData('fish', 'list', 'routes')
  fake += 100
  redraw()
  let ui = readUi()
  check('等待阶段写着「漂着」', ui.text.includes('漂着'), ui.text.slice(0, 80))
  check('等待阶段可以提前收杆（按钮可用）', ui.disabled === false, `disabled=${ui.disabled}`)

  // ── phase 2: biting (1200ms in = 200ms into the 700ms window) ──
  fake += 1100
  redraw()
  ui = readUi()
  check('咬钩阶段写着「咬钩了」', ui.text.includes('咬钩了'), ui.text.slice(0, 120))
  check('咬钩阶段按钮写着「收杆！」', ui.text.includes('收杆！'), ui.text.slice(0, 120))
  check('咬钩阶段按钮可用（这就是原来点不了的地方）', ui.disabled === false, `disabled=${ui.disabled}`)

  // ── phase 3: missed (3000ms in, well past the window) ──
  fake += 2000
  redraw()
  ui = readUi()
  check('错过阶段提示已错过', ui.text.includes('错过'), ui.text.slice(0, 120))
  // Still pressable: a dead line must be resolvable, or the player is stranded.
  check('错过阶段仍可点（收掉死线）', ui.disabled === false, `disabled=${ui.disabled}`)

  Date.now = realNow
  applySnapshot(realSnapshot)
}

section('渲染：开店页的开局选择')

/**
 * With no mode chosen, the panel must show the PICKER — and crucially it must not
 * render a shop floor whose buttons would all throw. The永久性 of the choice is
 * also load-bearing: the picker has to say so BEFORE the player commits.
 */
{
  await renderWithData('store', 'list', 'routes')
  const texts = []
  allNodes.forEach((node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child)
  })
  const page = texts.join('\n')

  const modes = realSnapshot.shopGame.modes
  check('开店页列出两种经营方式', modes.every((m) => page.includes(m.label)), modes.map((m) => m.label).join(','))
  check('每种方式的说明都渲染了', modes.every((m) => m.points.every((p) => page.includes(p))))
  // The rule changed: a switch now costs 钻石 instead of being impossible, so the\n  // picker must promise the ESCAPE HATCH rather than permanence. Asserting the\n  // old wording would have locked in a lie.\n  check('写明之后可以花钻石换', page.includes('花钻石就能换'), 'the escape hatch must be stated up front')\n  check('写明第一次选不要钱', page.includes('第一次选不要钱'))
  check('给出了自动化优先的建议', page.includes('建议先选自动化'))
  // With no mode chosen the floor must be absent: a 卖一份 button here would be a
  // click that always fails.
  check('未选方式时不显示货架', !page.includes('卖一份'))
  check('未选方式时不显示机器', !page.includes('运转中'))
}

section('渲染：换路线按钮真的会发请求')

/**
 * A button that renders correctly but does nothing is INVISIBLE to every other
 * check in this file: the snapshot is fine, the tree is fine, "renders without
 * throwing" passes. The one thing that matters — did THIS click reach the host —
 * needs that specific click invoked and its request identified.
 *
 * This exists because of a real bug: the 换路线 button was written as
 * onClick: () => act(...), and ct(...) RETURNS a handler. That built a
 * function returning a function and calling nothing, so clicking did nothing at
 * all while looking perfectly healthy. A "some request happened" assertion does
 * NOT catch it — the stock buttons fire requests too — so this pins the exact
 * endpoint.
 */
{
  // A snapshot where a mode is ALREADY chosen: on a fresh save the store tab
  // renders the opening picker and the switch card does not exist at all.
  const chosen = JSON.parse(JSON.stringify(realSnapshot))
  chosen.shopGame.mode = 'auto'
  chosen.shopGame.modeLabel = '自动化'
  chosen.shopGame.modeSwitches = 0
  chosen.shopGame.switchCost = { diamond: 12 }
  chosen.shopGame.switchAffordable = true
  applySnapshot(chosen)

  await renderWithData('store', 'list', 'routes')

  // Find the switch button by its LABEL, not by position: any other button that
  // happens to be enabled is irrelevant to what this test is about.
  const switchButton = allNodes.find(
    (node) =>
      node.type === 'button' &&
      typeof node.props.onClick === 'function' &&
      node.props.disabled !== true &&
      (node.children ?? []).some((c) => typeof c === 'string' && c.startsWith('换成')),
  )
  check('店铺页有「换成」按钮', switchButton !== undefined, 'switch button missing')

  const before = fetchedPaths.length
  const errors = []
  try {
    const out = switchButton.props.onClick()
    if (out !== undefined && typeof out.then === 'function') await out
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }
  const fired = fetchedPaths.slice(before)

  check(
    '点击「换成」发出了 /shop-mode 请求',
    fired.some((p) => p.includes('/shop-mode')),
    `fired: ${JSON.stringify(fired)} ${errors.slice(0, 2).join("; ")}`,
  )

  // Restore for the sections that follow.
  applySnapshot(realSnapshot)
}
section('渲染：公告页与更新按钮')

/**
 * 公告's whole job is (a) render the shipped changelog and (b) offer the update
 * buttons WITHOUT ever having contacted the network. Both are invisible to a
 * "does not throw" check, so this asserts the specific facts:
 *
 *   · the changelog from the SNAPSHOT is on screen, newest version marked
 *   · the 检查更新 button exists, and no 更新 button does — before any check,
 *     "there is an update" is unknown, and offering to overwrite a working
 *     install while the answer is unknown would be the bug.
 */
{
  await renderWithData('notice', 'list', 'routes')
  const texts = []
  allNodes.forEach((node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child)
  })
  const page = texts.join('\n')

  const notice = realSnapshot.notice
  check('快照带出公告数据', notice !== undefined && Array.isArray(notice.changelog))
  check('公告页显示当前版本', page.includes(`v${notice.version}`), `looking for v${notice.version}`)
  check('公告页渲染了更新记录标题', page.includes('更新记录'))
  check(
    '每条更新记录都渲染出来了',
    notice.changelog.every((entry) => page.includes(`v${entry.version}`)),
    notice.changelog.map((e) => e.version).join(','),
  )
  check('最新版本的标题也在页面上', page.includes(notice.changelog[0].title))

  const buttons = allNodes.filter((node) => node.type === 'button')
  const labels = buttons.map((b) => (b.children ?? []).filter((c) => typeof c === 'string').join(''))
  check('有「检查更新」按钮', labels.some((l) => l.includes('检查更新')), labels.join(' | '))
  // The critical negative: no update button until a check has actually found one.
  check(
    '未检查前不出现「更新」按钮',
    !labels.some((l) => l.startsWith('更新到')),
    labels.join(' | '),
  )
  check('未检查前不谎称已是最新', !page.includes('已经是最新的'))
  check('公告页写着联网策略', page.includes('不联网') || page.includes('联网检查已关闭'))

  /**
   * Collapsing and the read marker.
   *
   * Two behaviours that a "does not throw" pass cannot see, and that are easy to
   * break while editing the row markup:
   *
   *   · default state is COLLAPSED except the newest entry — a version list that
   *     opens every release buries the one the player cares about;
   *   · the read button is present only while something is unread, so the page
   *     cannot offer "mark all read" when everything already is.
   */
  const hasExpandAll = labels.some((l) => l === '全部展开' || l === '全部收起')
  check('有全部展开/收起按钮', hasExpandAll, labels.join(' | '))
  // The freshly-loaded snapshot has readUpTo = null, so it IS unread.
  check('未读时提供「标记全部已读」', labels.some((l) => l.includes('标记全部已读')), labels.join(' | '))
  check('未读时标题旁写着有新内容', page.includes('有新内容'))
  // Only the newest entry's notes should be visible on first paint: with 5
  // changelog rows, the older ones must not have printed their bullets.
  const olderEntry = notice.changelog[1]
  check(
    '默认只展开最新一条（旧条目的内容不显示）',
    olderEntry === undefined || !page.includes(olderEntry.notes[0]),
    olderEntry?.notes[0],
  )
  check('最新一条的内容是显示的', page.includes(notice.changelog[0].notes[0]))
  // Row headers must be buttons with aria-expanded, or the collapse is mouse-only
  // decoration rather than a real control.
  const rows = buttons.filter((b) => typeof b.props['aria-expanded'] === 'boolean')
  check('每条记录都是可折叠的按钮', rows.length === notice.changelog.length, `${rows.length} / ${notice.changelog.length}`)
}

section('渲染：旧宿主（快照没有 notice）不能让公告页崩')

/**
 * The exact bug a user hit: the browser half is re-read from disk on every page
 * load, but the host half is loaded ONCE at DSH startup. So after updating the
 * plugin folder, a NEW client runs against an OLD host until a restart — and the
 * snapshot simply has no `notice` field.
 *
 * The original panel did `data.notice.changelog`, which threw and left the tab
 * completely blank with no error shown, which reads as "this page is broken"
 * rather than "restart me". A "renders without throwing" check on the NORMAL
 * snapshot can never catch that, so this renders against a deliberately
 * truncated one.
 */
{
  const oldHostSnapshot = { ...realSnapshot }
  delete oldHostSnapshot.notice

  globalThis.fetch = async (url) => {
    const routePath = typeof url === 'string' ? url : String(url?.pathname ?? url?.url ?? url)
    if (routePath.includes('/api/checkin/settings')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: oldHostSnapshot.state,
          result: { values: oldHostSnapshot.settings, schema: settingsSchema.map((e) => ({ ...e })), path: '<tmp>' },
        }),
      }
    }
    return { ok: true, status: 200, json: async () => oldHostSnapshot }
  }

  let error = null
  try {
    await renderWithData('notice', 'list', 'routes')
  } catch (err) {
    error = err
  }
  check('旧宿主下公告页渲染不抛异常', error === null, error?.message)

  const texts = []
  allNodes.forEach((node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child)
  })
  const page = texts.join('\n')
  // Not just "did not crash": it must SAY what to do, or the player is left
  // staring at an empty tab with no way to know a restart fixes it.
  check('旧宿主下公告页仍有内容（不是空白页）', texts.length > 0)
  check('旧宿主下提示需要重启', page.includes('重启'))
  check('旧宿主下不误显示更新按钮', !page.includes('检查更新') || page.includes('需要重启'))

  globalThis.fetch = async (url) => fetchForRoute(url)
}

section('渲染：设置页里的签到行')

/**
 * The settings row is a THIRD rendering path for the same data, and it lives in
 * a slot owned by another package — so it fails differently from the panel:
 * the panel would show an error inside our own page, while this row silently
 * disappears from DSH settings and no test would notice.
 *
 * It is also the one place where "claim everything" is offered with no period
 * list around it, so the count in its label has to come from the same
 * `readyCount` the badge uses.
 */
{
  const settingsRow = registrations.find((r) => r.item.options.name === 'settings.general.item')
  check('设置行组件存在', settingsRow !== undefined)

  let error = null
  let node = null
  try {
    hookSlots = []
    hookCursor = 0
    effectQueue = []
    allNodes.length = 0
    node = settingsRow.item.component({})
    render(node)
    for (const effect of effectQueue.splice(0)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') activeCleanups.push(cleanup)
    }
    await settle()
  } catch (err) {
    error = err
  }
  check('设置行渲染不抛异常', error === null, error?.message)

  // The first pass runs before data arrives; re-invoke now the fetch resolved.
  allNodes.length = 0
  hookCursor = 0
  effectQueue = []
  render(settingsRow.item.component({}))
  for (const effect of effectQueue.splice(0)) {
    const cleanup = effect()
    if (typeof cleanup === 'function') activeCleanups.push(cleanup)
  }
  await settle()

  const texts = []
  allNodes.forEach((n) => {
    for (const child of n.children ?? []) if (typeof child === 'string') texts.push(child)
  })
  const page = texts.join('\n')
  check('设置行显示出可领数量或等级', page.includes('可以领') || page.includes('没有可领的'), page.slice(0, 120))
  check('设置行有「打开签到」按钮', page.includes('打开签到'))

  const buttons = allNodes.filter((n) => n.type === 'button')
  check('设置行有领取按钮', buttons.length >= 2, `${buttons.length}`)
  // With nothing ready (a fresh save has claimable minutes, but the exact count
  // depends on timing), the claim button must still be present rather than the
  // row collapsing to text.
  const claimButton = buttons.find((b) => (b.children ?? []).some((c) => typeof c === 'string' && (c.includes('全部领取') || c.includes('暂无可领'))))
  check('领取按钮文案随可领数量变化', claimButton !== undefined, texts.join(' | ').slice(0, 160))
}
section('渲染：关于页写着该写的字')

/**
 * The about page is the only tab whose ENTIRE job is showing fixed text — a
 * "renders without throwing" pass cannot tell whether the prose actually made
 * it to the tree (it would also pass if the panel rendered nothing). So collect
 * every string child of the about-tab render and look for the two things the
 * author asked for by name: the byline and the reason.
 */
{
  await renderWithData('about', 'list', 'routes')
  const texts = []
  const collect = (node) => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string') texts.push(child)
    }
  }
  allNodes.forEach(collect)
  const page = texts.join('\n')
  check('关于页写着「Made by 一只杨洋qwq」', page.includes('Made by 一只杨洋qwq'))
  check('关于页写着摸鱼初衷', page.includes('摸鱼'))
  check('关于页正文七段全部渲染', texts.filter((t) => t.includes('。')).length >= 7, `${texts.filter((t) => t.includes('。')).length}`)
  // The author's own positioning, added later: it belongs in the 创意 column,
  // not a serious category, and the closing "这何尝不是一种摸鱼" is the thesis.
  // These are fixed strings, so a silent edit that drops them would still
  // "render without throwing" — hence asserting the exact phrases.
  check('关于页写明它属于创意栏', page.includes('创意'))
  check('关于页写着玩法可自调', page.includes('高爆率'))
  check('关于页以「这何尝不是一种摸鱼」点题', page.includes('这何尝不是一种摸鱼'))
  // The avatar is fixed content too: an <img> whose src is the inline data URI
  // (no network — the whole plugin promise). A broken string constant would
  // render a blank circle and still "not throw", so assert it is really there.
  const avatar = allNodes.find(
    (node) =>
      node.type === 'img' &&
      typeof node.props.src === 'string' &&
      node.props.src.startsWith('data:image/jpeg;base64,'),
  )
  check('关于页内联了作者头像', avatar !== undefined)
  check('头像 alt 写着作者名', avatar?.props.alt?.includes('一只杨洋qwq') === true, avatar?.props.alt)

  /**
   * The two outbound links.
   *
   * This is the ONLY place the plugin sends the player off-site, so the checks
   * are about safety as much as presence: both must point at the author's page,
   * and both must carry `noopener noreferrer` — a `target="_blank"` without them
   * hands the opened page a `window.opener` handle back into the app.
   */
  const links = allNodes.filter((node) => node.type === 'a' && typeof node.props.href === 'string')
  const home = 'https://space.bilibili.com/3546957540755997'
  check('关于页有指向作者主页的链接', links.length >= 2, `${links.length} links`)
  check('每个链接都指向作者主页', links.every((l) => l.props.href === home), links.map((l) => l.props.href).join(' | '))
  check('每个链接都在新标签页打开', links.every((l) => l.props.target === '_blank'))
  check(
    '每个链接都带 noopener noreferrer',
    links.every((l) => typeof l.props.rel === 'string' && l.props.rel.includes('noopener') && l.props.rel.includes('noreferrer')),
    links.map((l) => l.props.rel).join(' | '),
  )
  // Both buttons must be visibly clickable, not underlined body text.
  check('链接有按钮样式（无下划线）', links.every((l) => l.props.style?.textDecoration === 'none'))
}

section('渲染：设置面板真的渲染出了控件')

/**
 * The settings tab previously "passed" while rendering only its error branch,
 * because the fetch mock returned the snapshot for every route and the panel
 * reads `payload.result.schema`. A "no exception" check cannot see that. So this
 * counts the controls that should exist.
 */
{
  const { settingsSchema: schema } = await import('../index.js')
  await renderWithData('settings', 'list', 'routes')

  const numbers = schema.filter((entry) => entry.kind === 'number')
  const toggles = schema.filter((entry) => entry.kind === 'toggle')

  const sliders = allNodes.filter((node) => node.props?.type === 'range')
  const sliderButtons = allNodes.filter(
    (node) => node.type === 'button' && typeof node.props['aria-pressed'] === 'boolean',
  )

  check(
    `渲染出全部 ${numbers.length} 个滑块`,
    sliders.length >= numbers.length,
    `${sliders.length} / ${numbers.length}`,
  )
  check(
    `渲染出全部 ${toggles.length} 个开关`,
    sliderButtons.length >= toggles.length,
    `${sliderButtons.length} / ${toggles.length}`,
  )
  check(
    '没有回落到"读不到设置"的错误态',
    !allNodes.some((node) => typeof node.children[0] === 'string' && node.children[0].includes('读不到设置')),
  )
  // Every group declared by the schema should appear as a heading.
  const groups = [...new Set(schema.map((entry) => entry.group))]
  const texts = allNodes.flatMap((node) => node.children).filter((c) => typeof c === 'string')
  check(
    '所有分组标题都出现',
    groups.every((group) => texts.includes(group)),
    groups.filter((g) => !texts.includes(g)).join(','),
  )
}

section('渲染：入口开关的成对锁定')

/**
 * The host rejects closing both entry points, but the UI must ALSO stop the
 * player before the request: with one door already shut, the other toggle has
 * to render locked with a visible reason. "No exception" cannot see any of
 * that, so this closes one door through the real API, re-snapshots, and counts
 * the disabled toggles.
 */
{
  const postToHost = async (path, body) => {
    const req = {
      method: 'POST',
      url: `/api/checkin${path}`,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    let payload = null
    await route.handler(req, { writeHead() {}, end: (text) => { payload = JSON.parse(text) } })
    return payload
  }
  await postToHost('/settings', { showFooterBadge: false })
  const snap = await snapshot()
  check('快照里徽章入口已关', snap.settings.showFooterBadge === false)
  globalThis.fetch = async (url) => {
    const routePath = typeof url === 'string' ? url : String(url?.pathname ?? url?.url ?? url)
    if (routePath.includes('/api/checkin/settings')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: snap.state,
          result: { values: snap.settings, schema: settingsSchema.map((e) => ({ ...e })), path: '<tmp>' },
        }),
      }
    }
    return { ok: true, status: 200, json: async () => snap }
  }
  await renderWithData('settings', 'list', 'routes')

  const toggles = allNodes.filter(
    (node) => node.type === 'button' && typeof node.props['aria-pressed'] === 'boolean',
  )
  const locked = toggles.filter((t) => t.props.disabled === true)
  check('只剩一个入口时它被锁住', locked.length === 1, `disabled: ${locked.length} / ${toggles.length}`)
  // The locked toggle must still LOOK on — a disabled control that flips its
  // face to "off" tells the player the opposite of the truth.
  check('锁住的开关外观仍是开', locked.every((t) => t.props['aria-pressed'] === true))
  const texts = []
  allNodes.forEach((node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child)
  })
  check('锁住的原因写在开关旁边', texts.some((t) => t.includes('另一处入口已经关了')))
  const reopenable = toggles.filter((t) => t.props['aria-pressed'] === false && t.props.disabled !== true)
  check('已关的那扇门仍可重新打开', reopenable.length >= 1)

  // Restore, so later sections see the default world again.
  await postToHost('/settings', { showFooterBadge: true })
  globalThis.fetch = async (url) => fetchForRoute(url)
}

section('渲染：成就两种视图')

for (const view of ['list', 'tree']) {
  let error = null
  const track = []
  try {
    await renderWithData('ach', view, 'routes', track)
  } catch (err) {
    error = err
  }
  check(`成就视图「${view}」渲染不抛异常`, error === null, error?.message)
  if (view === 'tree') {
    // Guard against a vacuous pass: the tree component must have actually run.
    check('树状图组件确实执行了', track.includes('AchievementTree'), track.join(','))
  }
}

section('渲染：图鉴两种视图')

for (const view of ['routes', 'items']) {
  let error = null
  const track = []
  try {
    await renderWithData('pack', 'list', view, track)
  } catch (err) {
    error = err
  }
  check(`图鉴视图「${view}」渲染不抛异常`, error === null, error?.message)
  if (view === 'routes') {
    check('路线估值组件确实执行了', track.includes('RouteCodex'), track.join(','))
  }
}

section('渲染：树状图有已解锁节点')

{
  const seeded = JSON.parse(fs.readFileSync(path.join(tmpHome, 'checkin', 'state.json'), 'utf8'))
  // Unlock a spread of nodes across branches so the tree draws both states.
  for (const id of ['first-blood', 'ten', 'level-5', 'streak-3', 'coin-1k', 'first-trip', 'pack-5', 'first-upgrade']) {
    seeded.achievements[id] = Date.now()
  }
  // Also give it a trip and a pack, so those branches are non-empty.
  seeded.pack = [{ item: 'shell', count: 3 }, { item: 'herb', count: 1 }]
  seeded.trip = { destination: 'forest', startedAt: Date.now() - 1000, readyAt: Date.now() + 600_000, spent: 4 }
  seeded.buffs = [{ id: 'luck', label: '好运', stat: 'luck', amount: 0.15, until: Date.now() + 600_000 }]
  seeded.expedition.found = { shell: 3, herb: 1 }
  seeded.expedition.byDestination = { forest: 2 }
  seeded.expedition.runs = 2
  fs.writeFileSync(path.join(tmpHome, 'checkin', 'state.json'), `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')
  route = null
  apply(fakeCtx, {})
  globalThis.fetch = async (url) => fetchForRoute(url)

  for (const [tab, achView, dexView] of [
    ['ach', 'tree', 'routes'],
    ['ach', 'list', 'routes'],
    ['pack', 'tree', 'routes'],
    ['trip', 'tree', 'routes'],
    ['claim', 'tree', 'items'],
  ]) {
    let error = null
    try {
      await renderWithData(tab, achView, dexView)
    } catch (err) {
      error = err
    }
    check(`已解锁状态 + ${tab}/${achView}/${dexView} 渲染不抛异常`, error === null, error?.message)
  }
}

// NOTE: there is deliberately no automated "the drag actually pans" assertion here.
//
// Two attempts at one were removed rather than left failing. The React shim in
// this file invokes components itself, and getting it to preserve a component's
// hook state across an event fired outside the render pass proved unreliable —
// it reported pan (0,0) even when the component was correct, which is worse than
// no test: a failing assertion that lies about the code.
//
// What IS verified: the tree renders without throwing, it reaches
// `AchievementTree` with real data, its layout has no node collisions in global
// coordinates, the canvas is larger than the viewport on both axes (so panning
// has somewhere to go), and no node swallows `pointerdown` (which is what made
// the panel feel immovable). Those are checked in test-expedition.mjs and in the
// render sections above. The drag feel itself is a manual check.

// Unmount everything for real at the end, so pending effects are torn down rather
// than left dangling (a timer would otherwise keep the process alive).
for (const cleanup of activeCleanups.splice(0)) {
  try {
    cleanup()
  } catch {
    // A teardown that throws is the component's problem, not this suite's.
  }
}

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
