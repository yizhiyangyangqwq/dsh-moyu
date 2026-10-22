/**
 * Browser half of the 签到 (check-in) plugin.
 *
 * Two seats, on purpose:
 *
 *   · `sidebar.footer.action` — a small badge beside Settings that is ALWAYS
 *     visible and shows how many periods are ready. This is the whole point of
 *     the plugin: you should never have to *remember* to check in. The badge
 *     tells you, and it is the one seat that is on screen no matter which panel
 *     is open.
 *
 *   · `main` (keyed `checkin`) + `sidebar.panellist` — the full page, with the
 *     five periods, the five currencies, the level bar and the achievement wall.
 *
 * All time comes from the host: the client only counts down locally between
 * polls, so a sleeping tab cannot fake a claim. Every colour is a
 * `--dsw-alias-*` token; no Harness Client package is imported and there is no
 * build step.
 */
window.__ModuleLoader__.load({
  // Must match the package name in package.json / cordis.patch.yml: the browser
  // half binds to the row whose name is the bare package name.
  id: '@local/dsh-moyu',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /**
     * The panel's key, used by `main`, `sidebar.panellist` and `layout.selectPanel`.
     *
     * Renamed with the package so the row id and the panel key agree; a stale key
     * would leave the sidebar icon selecting a panel that no longer exists.
     */
    const PANEL_ID = 'dsh-moyu'
    const PANEL_LABEL = '签到'

    /** How many chests the bulk button asks for; the host clamps to its own max. */
    const CHEST_BULK_MAX = 10

    /**
     * Poll rates.
     *
     * The panel was 15s, which was fine for its original job — check-ins become
     * available on the scale of minutes — but it made 钓鱼 FEEL broken even after
     * the strike window started advancing locally: the line was still drawn from
     * the last snapshot, so a fresh cast could take up to 15s to appear.
     *
     * 5s is the shortest interval that is not wasteful: the request is one small
     * JSON read, and the host does no work beyond bringing its clocks forward.
     */
    const BADGE_POLL_MS = 5_000
    const PANEL_POLL_MS = 5_000

    const API = (() => {
      try {
        return new URL('api/checkin', document.baseURI).pathname
      } catch {
        return '/api/checkin'
      }
    })()

    async function api(path, options, timeout = 12_000) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...options, signal: controller.signal })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok) {
          const message =
            payload !== null && typeof payload.error === 'string'
              ? payload.error
              : `请求失败（HTTP ${response.status}）`
          throw new Error(message)
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body) =>
      api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    // ── formatting ───────────────────────────────────────────────────────────

    /** A compact countdown: 59s · 12分 · 3小时 · 2天. */
    function formatRemaining(ms) {
      const seconds = Math.max(0, Math.ceil(ms / 1000))
      if (seconds < 60) return `${seconds}秒`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}分`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}小时`
      return `${Math.floor(hours / 24)}天`
    }

    function formatNumber(value) {
      const n = Number(value) || 0
      if (n < 10_000) return String(n)
      if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
      return `${(n / 1_000_000).toFixed(1)}M`
    }

    /** A duration in hours, rendered the way a person would say it. */
    function formatHours(hours) {
      if (hours < 1 / 60) return '不到一分钟'
      if (hours < 1) return `${Math.round(hours * 60)} 分钟`
      if (hours < 24) return `${Number(hours.toFixed(1))} 小时`
      return `${Number((hours / 24).toFixed(1))} 天`
    }

    /** A live "剩 3 小时 12 分"-style countdown for the trip banner. */
    function formatCountdown(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
      return `${seconds} 秒`
    }

    /** The five tiers, painted with real state tokens. */
    const TIER_TOKEN = {
      bronze: '--dsw-alias-state-warn-primary',
      silver: '--dsw-alias-label-secondary',
      gold: '--dsw-alias-state-warn-primary',
      legend: '--dsw-alias-state-business-primary',
    }

    const TIER_LABEL = { bronze: '铜', silver: '银', gold: '金', legend: '传说' }

    /** Rarity names in Chinese, shared by the pack, the codex and the forage list. */
    const RARITY_CN = {
      common: '常见',
      uncommon: '少见',
      rare: '稀有',
      legendary: '传说',
    }

    // ── shared data hook ─────────────────────────────────────────────────────

    /**
     * One poller per mounted component. The host is the only clock that matters,
     * so a claim always re-reads state rather than patching it locally.
     */
    function useCheckin(pollMs, heartbeat = true) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [tick, setTick] = React.useState(0)

      const load = React.useCallback(async () => {
        try {
          const next = await api('/state')
          setData(next)
          setError(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const run = () => {
          if (alive) load()
        }
        run()
        const timer = setInterval(run, pollMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load, pollMs])

      /**
       * A local 1s heartbeat, but only where a countdown is actually drawn.
       *
       * It used to run on every tab, which meant the achievements wall — 213
       * cards — was rebuilt once a second while you were scrolling it. That was
       * the reported jank. The caller decides, because only the page knows which
       * tab is showing.
       */
      React.useEffect(() => {
        if (!heartbeat) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [heartbeat])

      const claim = React.useCallback(
        async (period) => {
          setBusy(true)
          try {
            // Every successful response is a complete snapshot plus `result`,
            // so one assignment keeps the whole page honest.
            const next = await post('/claim', { period })
            setData(next)
            setError(null)
            return next.result
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            setError(message)
            throw err
          } finally {
            setBusy(false)
          }
        },
        [],
      )

      const claimAll = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/claim-all')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Buy one shop level. The host charges what the last read quoted. */
      const buy = React.useCallback(async (upgrade) => {
        setBusy(true)
        try {
          const next = await post('/buy', { upgrade })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Open one chest; the host rolls the loot. */
      const openChest = React.useCallback(async (chest) => {
        setBusy(true)
        try {
          const next = await post('/open', { chest })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Open up to `count` chests in one request.
       *
       * The host stops at the first unaffordable one and reports what it managed,
       * so a short wallet never goes into debt and the toast can say exactly what
       * happened.
       */
      const openChestBulk = React.useCallback(async (chest, count) => {
        setBusy(true)
        try {
          const next = await post('/open-bulk', { chest, count })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Collect whatever accrued while the process was not running. */
      const collectOffline = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/collect-offline')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Send the character out; the host stamps the return time. */
      const departTrip = React.useCallback(async (destination) => {
        setBusy(true)
        try {
          const next = await post('/depart', { destination })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Bring a finished trip's loot home. */
      const collectTrip = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/collect-trip')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** 睡觉 — skip ahead through the trip. */
      const tripSleep = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/trip-sleep')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** 采集 — gather near the camp. */
      const tripGather = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/trip-gather')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** 返回 — the client always sends confirm; the arm happens in the UI. */
      const tripReturnHome = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/trip-return', { confirm: true })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Sell `count` of an item from the pack. */
      const sell = React.useCallback(async (item, count = 1) => {
        setBusy(true)
        try {
          const next = await post('/sell', { item, count })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Consume one supply or buff item. */
      const use = React.useCallback(async (item) => {
        setBusy(true)
        try {
          const next = await post('/use', { item })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Claim one completed daily quest. */
      const claimQuest = React.useCallback(async (id) => {
        setBusy(true)
        try {
          const next = await post('/quest', { id })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Run one alchemy recipe. */
      const craft = React.useCallback(async (recipe) => {
        setBusy(true)
        try {
          const next = await post('/alchemy', { recipe })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Buy one 星盘 level with 星辰. */
      const buyStar = React.useCallback(async (upgrade) => {
        setBusy(true)
        try {
          const next = await post('/star', { upgrade })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Plant a crop in one plot. */
      const plant = React.useCallback(async (plot, crop) => {
        setBusy(true)
        try {
          const next = await post('/plant', { plot, crop })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Tend one plot (cure an ailment, or water it). */
      const tend = React.useCallback(async (plot) => {
        setBusy(true)
        try {
          const next = await post('/tend', { plot })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Harvest one ready plot. */
      const harvest = React.useCallback(async (plot) => {
        setBusy(true)
        try {
          const next = await post('/harvest', { plot })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Harvest every ready plot at once. */
      const harvestAll = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/harvest-all')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Tend every plot that needs it. */
      const tendAll = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/tend-all')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Buy one more plot. */
      const expandFarm = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/expand')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Patch one or more settings.
       *
       * The host MERGES, so sending a single changed knob is enough — the client
       * never has to echo the whole object back, which is what would let a stale
       * tab silently revert a setting changed elsewhere.
       */
      const saveSettings = React.useCallback(async (patch) => {
        setBusy(true)
        try {
          const next = await post('/settings', patch)
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Restore every setting to its default. */
      const resetSettings = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/settings-reset')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Rebirth.
       *
       * Deliberately NOT optimistic and never auto-retried: the host rejects an
       * ineligible rebirth, and the caller is responsible for confirming first.
       */
      const rebirth = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/rebirth')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Ask the host whether a newer version exists.
       *
       * The host holds the network permission flag, so this is safe to call
       * unconditionally: with the setting off it returns a plain `disabled`
       * report instead of making a request. That keeps the "does this plugin
       * phone home?" question answerable in ONE place (the host).
       */
      /** Mark the whole changelog read, so the tab's dot clears. */
      const markNoticeRead = React.useCallback(async () => {
        try {
          const next = await post('/notice-read')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        }
      }, [])

      /** Clear the automatic-update banner for this version. */
      const dismissAutoUpdate = React.useCallback(async () => {
        try {
          const next = await post('/update-dismiss')
          setData(next)
          return next.result
        } catch {
          // Purely an acknowledgement; a failure must not surface as an error.
          return null
        }
      }, [])

      const checkUpdate = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/update-check')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Download and install. Two-step on the host as well, so `confirm` is what
       * actually moves — the armed call only returns the warning text.
       */
      const applyUpdate = React.useCallback(async (confirm = false) => {
        setBusy(true)
        try {
          const next = await post('/update-apply', { confirm })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * 钓鱼 & 开店 actions.
       *
       * All of them follow the one rule the rest of this hook follows: the
       * response is a COMPLETE snapshot, so assigning it keeps the whole page
       * honest, and the caller reads the result for the thing that just happened.
       */
      /**
       * 挖矿 actions.
       *
       * All six follow the same contract as everything else in this hook: the
       * response is a COMPLETE snapshot, so one assignment keeps the whole page
       * honest, and the caller reads `result` for what just happened.
       */
      const mineSwing = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/mine-swing')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const mineDescend = React.useCallback(async (depth) => {
        setBusy(true)
        try {
          const next = await post('/mine-depth', { depth })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const mineCollect = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/mine-collect')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const mineUpgrade = React.useCallback(async (upgrade) => {
        setBusy(true)
        try {
          const next = await post('/mine-upgrade', { upgrade })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const mineHire = React.useCallback(async (miner) => {
        setBusy(true)
        try {
          const next = await post('/mine-hire', { miner })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const mineCollectMiner = React.useCallback(async (miner) => {
        setBusy(true)
        try {
          const next = await post('/mine-collect-miner', { miner })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Buy a snack from 小卖部. */
      const buySnack = React.useCallback(async (snack) => {
        setBusy(true)
        try {
          const next = await post('/snack', { snack })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const fishCast = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/fish-cast')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const fishStrike = React.useCallback(async () => {
        setBusy(true)
        try {
          const next = await post('/fish-strike')
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const buyRod = React.useCallback(async (rod) => {
        setBusy(true)
        try {
          const next = await post('/fish-rod', { rod })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const setSpot = React.useCallback(async (spot) => {
        setBusy(true)
        try {
          const next = await post('/fish-spot', { spot })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      /** Switch to a rod that is already unlocked (no purchase). */
      const switchRod = React.useCallback(async (rod) => {
        setBusy(true)
        try {
          const next = await post('/fish-switch-rod', { rod })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const chooseShopMode = React.useCallback(async (mode) => {
        setBusy(true)
        try {
          const next = await post('/shop-mode', { mode })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const restock = React.useCallback(async (product, count = 1) => {
        setBusy(true)
        try {
          const next = await post('/shop-restock', { product, count })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const sellGoods = React.useCallback(async (product) => {
        setBusy(true)
        try {
          const next = await post('/shop-sell', { product })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const buyMachine = React.useCallback(async (machine) => {
        setBusy(true)
        try {
          const next = await post('/shop-machine', { machine })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      const collectMachine = React.useCallback(async (machine) => {
        setBusy(true)
        try {
          const next = await post('/shop-collect', { machine })
          setData(next)
          setError(null)
          return next.result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          throw err
        } finally {
          setBusy(false)
        }
      }, [])

      return {
        data,
        error,
        busy,
        claim,
        claimAll,
        buy,
        openChest,
        openChestBulk,
        collectOffline,
        departTrip,
        collectTrip,
        tripSleep,
        tripGather,
        tripReturnHome,
        sell,
        use,
        claimQuest,
        craft,
        buyStar,
        plant,
        tend,
        harvest,
        harvestAll,
        tendAll,
        expandFarm,
        saveSettings,
        resetSettings,
        rebirth,
        checkUpdate,
        applyUpdate,
        markNoticeRead,
        dismissAutoUpdate,
        buySnack,
        mineSwing,
        mineDescend,
        mineCollect,
        mineUpgrade,
        mineHire,
        mineCollectMiner,
        fishCast,
        fishStrike,
        buyRod,
        setSpot,
        switchRod,
        chooseShopMode,
        restock,
        sellGoods,
        buyMachine,
        collectMachine,
        reload: load,
        tick,
      }
    }

    // ── the settings row ─────────────────────────────────────────────────────

    /**
     * The 摸鱼 section inside DSH's settings page.
     *
     * A SECTION, not a row. It used to be one line in 通用, squeezed between the
     * performance picker and an unrelated toggle — which read as noise rather
     * than as a feature. A section gets its own entry in the settings navigation
     * and room to show what is actually claimable.
     *
     * One click claims everything ready. Per-period detail stays in the panel,
     * which this links to; duplicating the whole check-in UI here would be a
     * second implementation of the same screen to keep in sync.
     */
    function SettingsCheckinSection({ onOpenPanel }) {
      const { data, error, busy, claimAll, reload } = useCheckin(BADGE_POLL_MS)
      const [note, setNote] = React.useState(null)

      if (data === null) {
        return h(
          'div',
          { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' } },
          error === null ? '正在读取签到…' : `读不到签到数据：${error}`,
        )
      }

      const state = data.state
      const ready = state.readyCount
      const level = state.level
      /**
       * The period rows live on `state.periods`.
       *
       * The snapshot's TOP-LEVEL `periods` is the static catalogue
       * (key/label/short/accent) with no readiness on it — reading that one would
       * render a list of labels that never shows anything as claimable. Each entry
       * here carries `ready` and `readyAt`.
       */
      const periods = state.periods ?? []

      const handleClaim = async () => {
        setNote(null)
        try {
          const result = await claimAll()
          const claimed = result?.claimed ?? 0
          if (claimed === 0) setNote({ kind: 'idle', text: '没有可以领的了。' })
          else setNote({ kind: 'ok', text: `领了 ${claimed} 项。` })
          await reload()
        } catch (err) {
          setNote({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
        }
      }

      /** A countdown for the next period that is not ready yet. */
      const untilReady = (readyAt) => {
        const left = Math.max(0, (readyAt ?? 0) - Date.now())
        if (left <= 0) return '可领'
        return formatCountdown(left)
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },

        // ── heading ──
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '摸鱼'),
          h(
            'div',
            { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
            '每日签到与缓慢养成。不用打开插件面板，这里也能领。',
          ),
        ),

        // ── the claim card ──
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '14px 16px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h(
              'div',
              { style: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' } },
              h(
                'div',
                { style: { fontSize: '14px', fontWeight: 500 } },
                ready > 0 ? `${ready} 项可以领` : '暂时没有可领的',
              ),
              h(
                'div',
                { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
                `Lv.${level}　·　签到会随时间长出来`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: handleClaim,
                disabled: busy || ready === 0,
                style: {
                  flex: 'none',
                  height: '30px',
                  padding: '0 14px',
                  borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
                  border: ready === 0 ? '1px solid var(--dsw-alias-border-l2)' : 'none',
                  background: ready === 0 ? 'transparent' : 'var(--moyu-accent, var(--dsw-alias-brand-primary))',
                  color:
                    ready === 0
                      ? 'var(--dsw-alias-label-tertiary)'
                      : 'var(--dsw-alias-label-primary-inverted)',
                  fontFamily: 'inherit',
                  fontSize: '12.5px',
                  cursor: busy || ready === 0 ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                },
              },
              busy ? '处理中…' : ready > 0 ? `全部领取（${ready}）` : '暂无可领',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: onOpenPanel,
                style: {
                  flex: 'none',
                  height: '30px',
                  padding: '0 12px',
                  borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontFamily: 'inherit',
                  fontSize: '12.5px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                },
              },
              '打开完整面板',
            ),
          ),
          note === null
            ? null
            : h(
                'div',
                {
                  style: {
                    fontSize: '12px',
                    color:
                      note.kind === 'bad'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : note.kind === 'ok'
                          ? 'var(--dsw-alias-state-success-primary)'
                          : 'var(--dsw-alias-label-tertiary)',
                  },
                },
                note.text,
              ),
        ),

        // ── the periods, so this page is not just a button ──
        periods.length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              h(
                'div',
                {
                  style: {
                    fontSize: '11px',
                    letterSpacing: '.14em',
                    color: 'var(--dsw-alias-label-quaternary)',
                    marginBottom: '4px',
                  },
                },
                '签到周期',
              ),
              periods.map((entry) =>
                h(
                  'div',
                  {
                    key: entry.key,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '9px 2px',
                      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
                    },
                  },
                  h(
                    'div',
                    { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: '8px' } },
                    h('span', { style: { fontSize: '13px' } }, entry.label),
                    h(
                      'span',
                      { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-quaternary)' } },
                      entry.short ?? '',
                    ),
                  ),
                  h(
                    'div',
                    {
                      style: {
                        flex: 'none',
                        fontSize: '12px',
                        fontWeight: entry.ready ? 600 : 400,
                        color: entry.ready
                          ? 'var(--dsw-alias-state-success-primary)'
                          : 'var(--dsw-alias-label-quaternary)',
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      },
                    },
                    entry.ready ? '可领' : untilReady(entry.readyAt),
                  ),
                ),
              ),
            ),
      )
    }
    // ── the always-visible badge ─────────────────────────────────────────────

    /**
     * The footer badge: a compact ready-count that opens the panel.
     *
     * It renders nothing at all when the host has not answered yet, so a broken
     * or absent host leaves the sidebar exactly as it was rather than showing a
     * dead control.
     *
     * It also renders nothing when `showFooterBadge` is off — but the poller
     * above that early return keeps running, because the same data is what
     * tells the plugin whether the OTHER door (the panel row) should exist.
     * `syncPanelEntry` is the hook that keeps that row in step with settings
     * even while the page itself is closed.
     */
    function CheckinBadge({ wide, usePanelInfo, selectPanel, syncPanelEntry, syncSettingsRow }) {
      const { data } = useCheckin(BADGE_POLL_MS)
      const active = usePanelInfo((info) => info.activePanelId === PANEL_ID)

      React.useEffect(() => {
        if (data?.settings && typeof syncPanelEntry === 'function') {
          syncPanelEntry(data.settings.showPanelEntry !== false)
        }
        if (data?.settings && typeof syncSettingsRow === 'function') {
          syncSettingsRow(data.settings.showSettingsRow !== false)
        }
      }, [data])

      if (data === null) return null
      if (data.settings?.showFooterBadge === false) return null

      const ready = data.state.readyCount
      const level = data.state.level

      return h(
        'button',
        {
          type: 'button',
          onClick: () => selectPanel(PANEL_ID),
          title: ready > 0 ? `签到：${ready} 项可以领了` : `签到：暂无（Lv.${level}）`,
          'aria-label': ready > 0 ? `打开签到，有 ${ready} 项可以领取` : '打开签到',
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            width: wide ? 'auto' : '32px',
            height: '32px',
            padding: wide ? '0 8px' : '0',
            border: 'none',
            borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
            background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: ready > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            fontFamily: 'inherit',
            fontSize: '12px',
            lineHeight: '16px',
            cursor: 'pointer',
          },
        },
        h(CalendarIcon, { size: 16, ready: ready > 0 }),
        wide === true && ready > 0 ? h('span', null, `${ready} 项可领`) : null,
        ready > 0
          ? h(
              'span',
              {
                style: {
                  position: 'absolute',
                  top: '1px',
                  right: '1px',
                  minWidth: '14px',
                  height: '14px',
                  padding: '0 3px',
                  borderRadius: '999px',
                  background: 'var(--dsw-alias-state-error-primary)',
                  color: 'var(--dsw-alias-label-primary-inverted)',
                  fontSize: '9px',
                  lineHeight: '14px',
                  fontWeight: 600,
                  textAlign: 'center',
                },
              },
              String(ready),
            )
          : null,
      )
    }

    /** A calendar glyph; a dot appears when something is claimable. */
    function CalendarIcon({ size = 16, ready = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', {
          x: 2.2,
          y: 3.2,
          width: 11.6,
          height: 10.6,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', { d: 'M2.2 6.4h11.6', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M5.4 2.2v2.2M10.6 2.2v2.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        ready
          ? h('circle', { cx: 8, cy: 9.9, r: 2.1, fill: 'var(--dsw-alias-state-error-primary)' })
          : h('path', { d: 'M5.6 10.2l1.7 1.7 3.2-3.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** The panel's own sidebar icon. */
    function CheckinPanelIcon({ size = 16, active = false }) {
      return h(CalendarIcon, { size, ready: false, active })
    }

    /** A chest glyph for the shop's loot boxes, tinted per chest. */
    function ChestIcon({ accent, size = 32 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 32 32',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
          style: { color: `var(${accent})`, flex: 'none' },
        },
        // Body.
        h('rect', {
          x: 4.5,
          y: 13,
          width: 23,
          height: 14,
          rx: 2.5,
          stroke: 'currentColor',
          strokeWidth: 1.8,
        }),
        // Lid.
        h('path', {
          d: 'M3.6 13c0-3.4 2.6-5.6 6-5.6h12.8c3.4 0 6 2.2 6 5.6',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
        // Lock.
        h('rect', {
          x: 13.6,
          y: 17.4,
          width: 4.8,
          height: 5.4,
          rx: 1.2,
          fill: 'currentColor',
          opacity: 0.9,
        }),
        // Highlight on the lid, so the chest reads as three-dimensional.
        h('path', {
          d: 'M6.5 12.4c0-2.4 1.9-4 4.4-4h10.2',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          opacity: 0.4,
        }),
      )
    }

    /**
     * A per-tab glyph, for the condensed tab mode.
     *
     * One lookup table rather than a component per tab: the icons carry no
     * meaning beyond "which tab is this", so a shape map is the whole job.
     */
    /**
     * Tabs whose contents do not change with the clock.
     *
     * The page heartbeat exists to move countdowns; on these tabs there is
     * nothing to move, so it is skipped entirely. 成就 matters most: it renders
     * one card per achievement (200+) and was being rebuilt every second.
     */
    const STATIC_TABS = new Set(['ach', 'about', 'settings', 'notice'])

    const TAB_GLYPHS = {
      claim: '◷',
      quest: '☑',
      farm: '❧',
      mine: '⛏',
      trip: '✦',
      pack: '▤',
      alchemy: '⚗',
      shop: '⌂',
      chest: '▣',
      fish: '🐟',
      store: '🏪',
      star: '✶',
      ach: '★',
      notice: '✉',
      about: '☺',
      settings: '⚙',
    }

    /**
     * The 关于 page's prose — the author's own words, lightly polished.
     *
     * This is the only place in the plugin that says WHY it exists. Everything
     * else is systems, prices and drop tables; this page is one person explaining
     * that it started as a slip-of-thinking 摸鱼 idea and never stopped being
     * one. Deliberately plain, first person, no marketing: the plainness IS the
     * message, so polishing it into ad copy would break the thing it describes.
     */
    const ABOUT_PROSE = [
      '这个插件的初衷只是摸鱼。当初随便一想——要不给自己做个签到玩？——连我自己都没想到，最后真的一点点把它做了出来。',
      '它很简陋，看起来也没什么意义：没有画面，没有玩法，攒下的数字也变不成任何真的东西。但它就是用来摸鱼的。看着东西一件件收进背包，看着自己一点点壮大，看着这么多东西堆在那里。',
      '它该放在创意那一栏，而不是任何正经分类。闲得没事种个菜、占个矿洞，谁会正事不干专门来搞它？它本来就是个摸鱼工具：随便点两下，然后一直等，时间到了再点两下。',
      '想摸鱼的时候，它就很好玩，你会真的投入进去；不想玩的时候，点一下立刻退出来干你的事，过十几个小时再来签个到——每天都能签，没人限制你。玩法也能自己调：想要高爆率就调高爆率，想要长得快就调快。这何尝不是一种摸鱼。',
      '有没有想起过从前？我过去光是两个文字，都能玩得很快乐，现在却不是了。',
      '所以我想把这份快乐传递给很多人。不用花钱，不用下载，摸鱼的时候打开点两下就够了。',
      '如果你正是在摸鱼时翻到这一页——祝你今天愉快。',
    ]

    function TabIcon({ name, size = 15 }) {
      return h(
        'span',
        {
          style: {
            fontSize: `${size}px`,
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: `${size}px`,
          },
          'aria-hidden': true,
        },
        TAB_GLYPHS[name] ?? '•',
      )
    }

    /** A small compass glyph for the 出门 tab icon. */
    function CompassIcon({ size = 16 }) {      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('circle', { cx: 8, cy: 8, r: 6.1, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M10.6 5.4L9.1 9.1 5.4 10.6 6.9 6.9z',
          fill: 'currentColor',
          opacity: 0.85,
        }),
      )
    }

    /** A backpack glyph for the 背包 tab icon. */
    function PackIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', {
          x: 3,
          y: 5.4,
          width: 10,
          height: 8.2,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M5.8 5.4V4.3a2.2 2.2 0 0 1 4.4 0v1.1',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        h('path', { d: 'M3 8.6h10', stroke: 'currentColor', strokeWidth: 1, opacity: 0.5 }),
      )
    }

    // ── the advancement tree ─────────────────────────────────────────────────

    /**
     * Grid geometry, in CSS pixels.
     *
     * Sized so the canvas is comfortably LARGER than the viewport on both axes.
     * That matters for feel as much as looks: at the original 108×86 the canvas
     * came out 820px wide, narrower than a typical ~900px panel, so there was
     * nothing to pan horizontally and the panel felt stuck even after the drag
     * handling was fixed.
     */
    const TREE = {
      cellX: 150,
      cellY: 96,
      nodeSize: 44,
      padX: 32,
      padY: 30,
      /** Zoom limits for the wheel, and the step per notch. */
      zoomMin: 0.45,
      zoomMax: 1.6,
      zoomStep: 1.12,
    }

    /**
     * The tree view: a Minecraft-style advancement panel.
     *
     * Three things make it feel like the real thing rather than a static chart:
     *
     *   · it is **pannable by dragging** anywhere on the surface;
     *   · it **auto-centres on the newest unlock** when it opens, so you see your
     *     progress instead of the beginning of the graph;
     *   · locked nodes are **dimmed rather than hidden**, which is what turns the
     *     graph into a to-do list.
     *
     * The branch chips above the canvas jump the viewport, which is the only
     * practical way to navigate 109 nodes.
     */
    function AchievementTree({ tree, achievements }) {
      const viewportRef = React.useRef(null)
      const [pan, setPan] = React.useState({ x: 0, y: 0 })
      const [zoom, setZoom] = React.useState(1)
      const [dragging, setDragging] = React.useState(false)
      const [hover, setHover] = React.useState(null)
      const dragState = React.useRef(null)
      /**
       * Set when a gesture moved far enough to count as a pan.
       *
       * Without this, releasing a drag over a node would fire that node's `click`
       * and pop its detail card — so every pan would end by opening whatever
       * square the pointer happened to stop on.
       */
      const suppressClick = React.useRef(false)
      /** How far the pointer must move before a gesture is a pan, not a click. */
      const DRAG_THRESHOLD = 4

      const byId = React.useMemo(
        () => Object.fromEntries(achievements.map((entry) => [entry.id, entry])),
        [achievements],
      )

      /** Node centres, in canvas coordinates (before zoom). */
      const positions = React.useMemo(() => {
        const map = new Map()
        for (const branch of tree.branches) {
          for (const node of branch.nodes) {
            map.set(node.id, {
              cx: TREE.padX + node.x * TREE.cellX + TREE.nodeSize / 2,
              cy: TREE.padY + node.y * TREE.cellY + TREE.nodeSize / 2,
            })
          }
        }
        return map
      }, [tree])

      const canvasWidth = TREE.padX * 2 + tree.width * TREE.cellX
      const canvasHeight = TREE.padY * 2 + tree.height * TREE.cellY

      /**
       * Clamp the pan so the canvas can never be dragged fully out of sight.
       *
       * Crucially, this does NOT recentre on every call. An earlier version did:
       * "if the scaled canvas is smaller than the viewport on an axis, centre it"
       * ran inside the drag handler, and since the canvas is 820px wide against a
       * ~900px viewport, EVERY horizontal drag was immediately overwritten with
       * the centred value — so the graph could be dragged vertically but never
       * horizontally. Centring is a layout concern (`centreOn`/`resetView`); this
       * function only bounds.
       */
      const clampPan = React.useCallback(
        (next, zoomLevel) => {
          const viewport = viewportRef.current
          if (viewport === null) return next
          const w = viewport.clientWidth
          const h = viewport.clientHeight
          const scaledW = canvasWidth * zoomLevel
          const scaledH = canvasHeight * zoomLevel
          // Slack allowed outside the viewport, so the edge of the graph is still
          // reachable rather than pinned flush.
          const margin = 80

          const bound = (value, view, scaled) => {
            // When the scaled canvas is smaller than the viewport there is nothing
            // to scroll: the allowed range collapses to the single centred value.
            if (scaled <= view) return (view - scaled) / 2
            return Math.min(margin, Math.max(view - scaled - margin, value))
          }

          return { x: bound(next.x, w, scaledW), y: bound(next.y, h, scaledH) }
        },
        [canvasWidth, canvasHeight],
      )

      /** Centre the viewport on one node, honouring the current zoom. */
      const centreOn = React.useCallback(
        (nodeId) => {
          const viewport = viewportRef.current
          const position = positions.get(nodeId)
          if (viewport === null || position === undefined) return
          setPan(
            clampPan(
              {
                x: viewport.clientWidth / 2 - position.cx * zoom,
                y: viewport.clientHeight / 2 - position.cy * zoom,
              },
              zoom,
            ),
          )
        },
        [positions, zoom, clampPan],
      )

      /** The most recently unlocked node, which is what we open on. */
      const latest = React.useMemo(() => {
        const unlocked = achievements.filter((entry) => entry.unlockedAt !== null)
        if (unlocked.length === 0) return null
        return unlocked.reduce((best, entry) => (entry.unlockedAt > best.unlockedAt ? entry : best)).id
      }, [achievements])

      // Centre once on mount, and whenever the viewport first gets a size.
      const centred = React.useRef(false)
      React.useEffect(() => {
        if (centred.current) return
        const viewport = viewportRef.current
        if (viewport === null || viewport.clientWidth === 0) return
        centred.current = true
        const target = latest ?? tree.branches[0]?.nodes[0]?.id ?? 'first-blood'
        const position = positions.get(target)
        if (position === undefined) return
        // Recompute here rather than via centreOn, so this uses the CURRENT zoom
        // without re-running when zoom changes (which would fight the user).
        setPan(
          clampPan(
            {
              x: viewport.clientWidth / 2 - position.cx,
              y: viewport.clientHeight / 2 - position.cy,
            },
            1,
          ),
        )
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [latest, positions, tree])

      /**
       * Begin a drag.
       *
       * Capture is set on the viewport element obtained from the REF, not on
       * `event.currentTarget`. Nodes call `stopPropagation` so a click on one does
       * not start a pan, which means `currentTarget` at the canvas handler is the
       * canvas — but the ref is unambiguous, and capture is what keeps move events
       * arriving when the pointer leaves the viewport.
       */
      const onPointerDown = (event) => {
        if (event.button !== 0) return
        dragState.current = {
          startX: event.clientX,
          startY: event.clientY,
          panX: pan.x,
          panY: pan.y,
          /** Whether this gesture has already crossed the drag threshold. */
          moved: false,
        }
        setDragging(true)
        viewportRef.current?.setPointerCapture?.(event.pointerId)
      }

      const onPointerMove = (event) => {
        const origin = dragState.current
        if (origin === null) return
        const dx = event.clientX - origin.startX
        const dy = event.clientY - origin.startY
        // Only commit to a pan once the pointer has actually moved, so a click
        // that jitters by a pixel still registers as a click.
        if (!origin.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        origin.moved = true
        setPan(clampPan({ x: origin.panX + dx, y: origin.panY + dy }, zoom))
      }

      const endDrag = (event) => {
        const origin = dragState.current
        if (origin === null) return
        dragState.current = null
        setDragging(false)
        // Arm the click suppressor only for a real pan, and only long enough for
        // the click event that follows this pointerup to be ignored.
        if (origin.moved) {
          suppressClick.current = true
          // The click fires after pointerup; clear the flag on the next tick so a
          // later genuine click is never swallowed.
          setTimeout(() => {
            suppressClick.current = false
          }, 0)
        }
        try {
          viewportRef.current?.releasePointerCapture?.(event.pointerId)
        } catch {
          // Releasing a capture that was never taken (or already lost) throws in
          // some browsers; it is not an error worth surfacing.
        }
      }

      /**
       * Wheel zoom, anchored at the cursor.
       *
       * Anchoring matters: zooming from a fixed origin makes the thing you were
       * looking at slide away, which is the single most annoying trait a pan-zoom
       * view can have.
       *
       * This is attached as a NATIVE listener with `{ passive: false }` rather than
       * through React's `onWheel`. React dispatches wheel events from the root
       * container with passive semantics on some versions, so `preventDefault()`
       * is ignored — and the page scrolls while you are trying to zoom the graph.
       */
      const panRef = React.useRef(pan)
      const zoomRef = React.useRef(zoom)
      panRef.current = pan
      zoomRef.current = zoom
      const clampRef = React.useRef(clampPan)
      clampRef.current = clampPan

      React.useEffect(() => {
        const viewport = viewportRef.current
        if (viewport === null) return undefined

        const handleWheel = (event) => {
          event.preventDefault()
          const rect = viewport.getBoundingClientRect()
          const pointerX = event.clientX - rect.left
          const pointerY = event.clientY - rect.top
          const currentZoom = zoomRef.current
          const currentPan = panRef.current
          const factor = event.deltaY < 0 ? TREE.zoomStep : 1 / TREE.zoomStep
          const nextZoom = Math.min(TREE.zoomMax, Math.max(TREE.zoomMin, currentZoom * factor))
          if (nextZoom === currentZoom) return
          // Keep the canvas point under the cursor fixed: solve for the pan that
          // leaves (pointer - pan) / zoom unchanged.
          const canvasX = (pointerX - currentPan.x) / currentZoom
          const canvasY = (pointerY - currentPan.y) / currentZoom
          setZoom(nextZoom)
          setPan(
            clampRef.current(
              { x: pointerX - canvasX * nextZoom, y: pointerY - canvasY * nextZoom },
              nextZoom,
            ),
          )
        }

        viewport.addEventListener('wheel', handleWheel, { passive: false })
        return () => viewport.removeEventListener('wheel', handleWheel)
      }, [])

      /** Reset to 100% and re-centre on the latest unlock. */
      const resetView = () => {
        setZoom(1)
        const target = latest ?? tree.branches[0]?.nodes[0]?.id ?? 'first-blood'
        const position = positions.get(target)
        const viewport = viewportRef.current
        if (position === undefined || viewport === null) return
        setPan(
          clampPan(
            {
              x: viewport.clientWidth / 2 - position.cx,
              y: viewport.clientHeight / 2 - position.cy,
            },
            1,
          ),
        )
      }

      const hoverEntry = hover === null ? null : byId[hover]

      return h(
        React.Fragment,
        null,
        // Branch jump chips.
        h(
          'div',
          { style: styles.branchRow },
          tree.branches.map((branch) =>
            h(
              'button',
              {
                key: branch.id,
                type: 'button',
                onClick: () => centreOn(branch.nodes[0]?.id ?? 'first-blood'),
                style: styles.branchChip,
                title: `跳到「${branch.label}」`,
              },
              h('span', {
                style: { ...styles.branchDot, background: `var(${branch.accent})` },
              }),
              branch.label,
              h(
                'span',
                { style: styles.branchCount },
                `${branch.unlocked}/${branch.total}`,
              ),
            ),
          ),
          // Zoom + reset controls. The wheel works, but a control that is visible
          // is what makes the feature discoverable.
          h(
            'div',
            { style: styles.zoomGroup },
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  const next = Math.max(TREE.zoomMin, zoom / TREE.zoomStep)
                  setZoom(next)
                  setPan((current) => clampPan(current, next))
                },
                style: styles.zoomButton,
                title: '缩小',
                'aria-label': '缩小',
              },
              '−',
            ),
            h(
              'span',
              { style: styles.zoomValue },
              `${Math.round(zoom * 100)}%`,
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  const next = Math.min(TREE.zoomMax, zoom * TREE.zoomStep)
                  setZoom(next)
                  setPan((current) => clampPan(current, next))
                },
                style: styles.zoomButton,
                title: '放大',
                'aria-label': '放大',
              },
              '+',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: resetView,
                style: styles.zoomButton,
                title: '回到最近解锁的成就',
                'aria-label': '重置视图',
              },
              '⟲',
            ),
          ),
        ),

        // The canvas.
        h(
          'div',
          {
            ref: viewportRef,
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            // No `onWheel` here: the zoom listener is attached natively in an
            // effect, because React's wheel dispatch cannot reliably
            // `preventDefault()` and the page would scroll instead.
            style: {
              ...styles.treeViewport,
              cursor: dragging ? 'grabbing' : 'grab',
            },
          },
          h(
            'div',
            {
              style: {
                position: 'absolute',
                left: 0,
                top: 0,
                width: `${canvasWidth}px`,
                height: `${canvasHeight}px`,
                // Order matters: translate then scale, with the origin at the
                // top-left so the pan/zoom maths stays a simple affine map.
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                // No transition while dragging, or the canvas lags the pointer.
                transition: dragging ? 'none' : 'transform .22s ease-out',
              },
            },
            // Connector lines first, so nodes paint over them.
            h(
              'svg',
              {
                width: canvasWidth,
                height: canvasHeight,
                style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' },
                'aria-hidden': true,
              },
              tree.branches.flatMap((branch) =>
                branch.nodes
                  .filter((node) => node.parent !== null)
                  .map((node) => {
                    const from = positions.get(node.parent)
                    const to = positions.get(node.id)
                    if (from === undefined || to === undefined) return null
                    // A step-then-across elbow reads as a tree branch; a straight
                    // diagonal reads as a spiderweb at this density.
                    const midX = (from.cx + to.cx) / 2
                    const unlocked = node.unlocked && (byId[node.parent]?.unlockedAt !== null)
                    const path = `M ${from.cx} ${from.cy} H ${midX} V ${to.cy} H ${to.cx}`
                    return h('path', {
                      key: `${node.parent}->${node.id}`,
                      d: path,
                      fill: 'none',
                      stroke: unlocked
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-border-l3)',
                      strokeWidth: unlocked ? 2 : 1.4,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                      opacity: unlocked ? 0.85 : 0.55,
                    })
                  }),
              ),
            ),

            // Branch band labels: with seven stacked strips, the canvas needs to
            // say which strip is which — the chips above only jump, they do not
            // label what you are looking at.
            tree.branches.map((branch) =>
              branch.bandHeight === 0
                ? null
                : h(
                    'div',
                    {
                      key: `band-${branch.id}`,
                      style: {
                        position: 'absolute',
                        left: `${TREE.padX + 2}px`,
                        top: `${TREE.padY + branch.offsetY * TREE.cellY + (branch.bandHeight * TREE.cellY) / 2 - 34}px`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        pointerEvents: 'none',
                        userSelect: 'none',
                      },
                    },
                    h('span', {
                      style: { ...styles.branchDot, background: `var(${branch.accent})` },
                    }),
                    h(
                      'span',
                      {
                        style: {
                          fontSize: '12px',
                          fontWeight: 600,
                          color: 'var(--dsw-alias-label-secondary)',
                          whiteSpace: 'nowrap',
                        },
                      },
                      branch.label,
                    ),
                    h(
                      'span',
                      {
                        style: {
                          fontSize: '10px',
                          color: 'var(--dsw-alias-label-quaternary)',
                          fontVariantNumeric: 'tabular-nums',
                        },
                      },
                      `${branch.unlocked}/${branch.total}`,
                    ),
                  ),
            ),

            // Nodes.
            tree.branches.flatMap((branch) =>
              branch.nodes.map((node) => {
                const position = positions.get(node.id)
                const entry = byId[node.id]
                if (position === undefined || entry === undefined) return null
                const unlocked = entry.unlockedAt !== null
                const tierColor = TIER_TOKEN[entry.tier] ?? '--dsw-alias-label-primary'
                return h(
                  'button',
                  {
                    key: node.id,
                    type: 'button',
                    // NOTE: no `stopPropagation` here. Nodes cover most of the
                    // canvas, so swallowing pointerdown on them meant a drag could
                    // only start in the gaps between squares — which is why the
                    // panel felt immovable. The pointerdown bubbles to the canvas,
                    // a drag begins, and `suppressClick` decides afterwards whether
                    // this was a click or a pan.
                    onClick: () => {
                      if (suppressClick.current) {
                        suppressClick.current = false
                        return
                      }
                      setHover(node.id === hover ? null : node.id)
                    },
                    onMouseEnter: () => setHover(node.id),
                    onMouseLeave: () => setHover((current) => (current === node.id ? null : current)),
                    title: `${entry.label} — ${entry.desc}`,
                    'aria-label': `${entry.label}：${entry.desc}${unlocked ? '（已解锁）' : '（未解锁）'}`,
                    style: {
                      position: 'absolute',
                      left: `${position.cx - TREE.nodeSize / 2}px`,
                      top: `${position.cy - TREE.nodeSize / 2}px`,
                      width: `${TREE.nodeSize}px`,
                      height: `${TREE.nodeSize}px`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
                      border: `2px solid ${
                        unlocked
                          ? `var(${tierColor})`
                          : 'var(--dsw-alias-border-l3)'
                      }`,
                      background: unlocked
                        ? `color-mix(in srgb, var(${tierColor}) 26%, var(--dsw-alias-bg-base))`
                        : 'var(--dsw-alias-bg-layer-2)',
                      // Locked nodes stay visible but recede: the graph is a map of
                      // what is left, not just what is done.
                      opacity: unlocked ? 1 : 0.55,
                      color: unlocked ? `var(${tierColor})` : 'var(--dsw-alias-label-quaternary)',
                      fontFamily: 'inherit',
                      fontSize: '17px',
                      lineHeight: 1,
                      cursor: 'pointer',
                      boxShadow:
                        hover === node.id
                          ? 'var(--dsw-elevation-prominent)'
                          : unlocked
                            ? 'var(--dsw-elevation-soft)'
                            : 'none',
                      transform: hover === node.id ? 'scale(1.12)' : 'scale(1)',
                      transition: 'transform .12s ease, box-shadow .12s ease',
                      zIndex: hover === node.id ? 2 : 1,
                    },
                  },
                  unlocked ? '★' : '·',
                )
              }),
            ),
          ),

          // The hover card, pinned to a corner so it never sits under the cursor.
          hoverEntry === null
            ? null
            : h(
                'div',
                { style: styles.treeCard },
                h(
                  'div',
                  { style: styles.treeCardHead },
                  h(
                    'span',
                    {
                      style: {
                        ...styles.treeCardMark,
                        color:
                          hoverEntry.unlockedAt === null
                            ? 'var(--dsw-alias-label-quaternary)'
                            : `var(${TIER_TOKEN[hoverEntry.tier] ?? '--dsw-alias-label-primary'})`,
                      },
                    },
                    hoverEntry.unlockedAt === null ? '·' : '★',
                  ),
                  h('span', { style: styles.treeCardTitle }, hoverEntry.label),
                  h(
                    'span',
                    { style: styles.treeCardTier },
                    TIER_LABEL[hoverEntry.tier] ?? hoverEntry.tier,
                  ),
                ),
                h('div', { style: styles.treeCardDesc }, hoverEntry.desc),
                h(
                  'div',
                  { style: styles.treeCardStatus },
                  hoverEntry.unlockedAt === null
                    ? '尚未解锁'
                    : `已于 ${new Date(hoverEntry.unlockedAt).toLocaleDateString()} 解锁`,
                ),
              ),
        ),

        h(
          'div',
          { style: styles.treeHint },
          '拖动可平移，滚轮或 +/− 缩放，点方块看详情。',
          latest === null ? '' : '　已自动定位到最近解锁的成就。',
        ),
      )
    }

    // ── route codex ──────────────────────────────────────────────────────────

    /**
     * Which destination actually pays best.
     *
     * Every number here comes from the host, computed with the same tier-first
     * roll the real expedition uses and under the player's CURRENT bonuses — so
     * the ranking changes as the 寻宝罗盘 levels up, which is the point.
     *
     * The one editorial choice is *which* axis gets the bar: `valuePerHour` is
     * what a player actually trades away (wall-clock time), so that is the
     * ranking, with per-supply shown as context rather than as the headline.
     */
    function RouteCodex({ destinations, valuation, currencyToken, currencyLabel }) {
      const [metric, setMetric] = React.useState('perHour')

      const ranked = React.useMemo(() => {
        const key = metric === 'perHour' ? 'valuePerHour' : 'valuePerSupply'
        const sorted = [...destinations].sort((a, b) => b[key] - a[key])
        const best = sorted.length === 0 ? 0 : sorted[0][key]
        return sorted.map((destination, index) => ({
          ...destination,
          rank: index + 1,
          // Share of the best value, so the bar reads as "how close to optimal".
          share: best === 0 ? 0 : destination[key] / best,
          shown: destination[key],
        }))
      }, [destinations, metric])

      const unit = metric === 'perHour' ? '每小时' : '每物资'
      const winner = ranked[0]

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: styles.codexNote },
          '预估基于当前加成，按「' + unit + '」排序。数值是换算成金币的等效价值，仅供比较。',
          winner === undefined
            ? ''
            : ` 目前最划算：${winner.label}。`,
        ),

        h(
          'div',
          { style: styles.viewSwitch, marginLeft: 0 },
          [
            { key: 'perHour', label: '按时间' },
            { key: 'perSupply', label: '按物资' },
          ].map((option) =>
            h(
              'button',
              {
                key: option.key,
                type: 'button',
                onClick: () => setMetric(option.key),
                style: metric === option.key ? styles.viewSwitchActive : styles.viewSwitchItem,
              },
              option.label,
            ),
          ),
        ),

        h(
          'div',
          { style: styles.codexList },
          ranked.map((destination) =>
            h(
              'div',
              { key: destination.id, style: styles.codexRow },
              h(
                'div',
                { style: styles.codexRank },
                destination.rank === 1 ? '★' : String(destination.rank),
              ),
              h(
                'div',
                { style: styles.codexMain },
                h(
                  'div',
                  { style: styles.periodTitleRow },
                  h('span', { style: styles.periodLabel }, destination.label),
                  h(
                    'span',
                    { style: styles.levelChip },
                    `${formatHours(destination.effectiveHours)}　◈${destination.supply}`,
                  ),
                  destination.runs > 0
                    ? h('span', { style: styles.bestChip }, `去过 ${destination.runs} 次`)
                    : null,
                ),
                // The bar: value relative to the best route on this metric.
                h(
                  'div',
                  { style: styles.codexTrack },
                  h('div', {
                    style: {
                      ...styles.codexFill,
                      width: `${Math.max(2, Math.round(destination.share * 100))}%`,
                      background: `var(${destination.accent})`,
                    },
                  }),
                ),
                h(
                  'div',
                  { style: styles.codexStats },
                  h(
                    'span',
                    null,
                    `期望 ${formatNumber(Math.round(destination.expectedValue))} 金币/次`,
                  ),
                  h(
                    'span',
                    null,
                    `约 ${formatNumber(Math.round(destination.shown))} / ${unit}`,
                  ),
                  h('span', null, `稀有+ ${Math.round(destination.rareChance * 100)}%`),
                  h('span', null, `平均 ${destination.expectedDrops.toFixed(1)} 件`),
                ),
                // Tier breakdown: a stacked strip is the fastest way to read
                // "what kind of loot does this place actually give".
                h(
                  'div',
                  { style: styles.tierStrip },
                  destination.tiers.map((tier) =>
                    h('div', {
                      key: tier.tier,
                      title: `${RARITY_LABEL_CN[tier.tier] ?? tier.tier}：${Math.round(tier.probability * 100)}%，均值 ${Math.round(tier.meanValue)} 金币`,
                      style: {
                        width: `${Math.max(0.5, tier.probability * 100)}%`,
                        background: `var(${RARITY_TOKEN_FALLBACK[tier.tier] ?? '--dsw-alias-label-tertiary'})`,
                        opacity: 0.85,
                      },
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),

        // The valuation table, shown so the numbers above are not magic.
        h(
          'div',
          { style: styles.sectionTitle },
          '估值基准',
          h('span', { style: styles.sectionHint }, '1 单位等于多少金币'),
        ),
        h(
          'div',
          { style: styles.modRow },
          Object.entries(valuation).map(([key, value]) =>
            h(
              'span',
              { key, style: { color: currencyToken(key) } },
              `${currencyLabel(key)} = ${value}`,
            ),
          ),
        ),
      )
    }

    /** Rarity → token, for the tier strip. */
    const RARITY_TOKEN_FALLBACK = {
      common: '--dsw-alias-state-idle-primary',
      uncommon: '--dsw-alias-label-secondary',
      rare: '--dsw-alias-state-warn-primary',
      legendary: '--dsw-alias-state-error-primary',
    }

    const RARITY_LABEL_CN = {
      common: '常见',
      uncommon: '少见',
      rare: '稀有',
      legendary: '传说',
    }

    // ── settings panel ───────────────────────────────────────────────────────

    /** How a numeric value is shown, given the schema's `format` hint. */
    function formatSettingValue(entry, value) {
      if (entry.format === 'percent') return `${Math.round(value * 100)}%`
      if (entry.format === 'x') return `×${Number(value.toFixed(2))}`
      return String(Number(value.toFixed(2)))
    }

    /**
     * The settings panel.
     *
     * Rendered entirely from the host's SCHEMA — this component knows nothing
     * about any individual knob, so adding one on the host makes it appear here
     * with no client change. That is the whole reason the schema exists.
     *
     * The schema is fetched once when the panel first mounts, NOT on every poll:
     * it is static, and re-sending it every few seconds would be pure waste.
     */
    function SettingsPanel({ values, busy, onSave, onReset, showToast }) {
      const [schema, setSchema] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [armed, setArmed] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const payload = await api('/settings')
            if (alive) setSchema(payload.result.schema)
          } catch (err) {
            if (alive) setLoadError(err instanceof Error ? err.message : String(err))
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      if (schema === null) {
        return h(
          'div',
          { style: styles.page },
          h('div', { style: styles.empty }, loadError === null ? '正在读取设置…' : `读不到设置：${loadError}`),
        )
      }

      // Group preserving the schema's declared order.
      const groups = []
      for (const entry of schema) {
        const found = groups.find((g) => g.name === entry.group)
        if (found === undefined) groups.push({ name: entry.group, entries: [entry] })
        else found.entries.push(entry)
      }

      const isDefault = (entry) =>
        entry.kind === 'toggle' ? values[entry.key] === entry.default : Number(values[entry.key]) === Number(entry.default)

      const changedCount = schema.filter((entry) => !isDefault(entry)).length

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: styles.sectionTitle },
          '设置',
          h(
            'span',
            { style: styles.sectionHint },
            changedCount === 0 ? '全部为默认值' : `${changedCount} 项已改动`,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: async () => {
                if (!armed) {
                  setArmed(true)
                  showToast('再点一次确认恢复全部默认设置')
                  return
                }
                setArmed(false)
                try {
                  await onReset()
                  showToast('已恢复默认设置')
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err))
                }
              },
              disabled: busy || changedCount === 0,
              style: changedCount === 0 || busy ? styles.buyButtonDisabled : styles.ghostButton,
            },
            armed ? '确认恢复默认' : '恢复默认',
          ),
        ),

        h(
          'div',
          { style: styles.codexNote },
          '这些是**你自己给自己定的难度**，不是平衡性设定。奖励倍率调到 10× 会让游戏变得很简单——那也是一种正当的玩法，只是别以为是官方数值。设置存在单独的文件里，不会被「重置」清掉。',
        ),

        groups.map((group) =>
          h(
            React.Fragment,
            { key: group.name },
            h('div', { style: styles.sectionTitle }, group.name),
            h(
              'div',
              { style: styles.settingList },
              group.entries.map((entry) => {
                const value = values[entry.key]
                const changed = !isDefault(entry)
                // Pair rule, mirrored in the UI: turning the LAST open member of
                // a `pair` group off would leave no way back (the host rejects
                // it too, but a disabled control explains itself better than a
                // thrown error).
                //
                // Generic over group SIZE, because the entry points are THREE
                // doors, not two: the footer badge, the sidebar row, and the
                // 摸鱼 section inside DSH's own settings page. Closing any one
                // or two is fine; the third stays locked.
                const pairLocked =
                  entry.pair !== undefined &&
                  value === true &&
                  schema
                    .filter((s) => s.pair === entry.pair && s.key !== entry.key)
                    .every((s) => values[s.key] === false)
                return h(
                  'div',
                  { key: entry.key, style: changed ? styles.settingRowChanged : styles.settingRow },
                  h(
                    'div',
                    { style: styles.settingMain },
                    h(
                      'div',
                      { style: styles.periodTitleRow },
                      h('span', { style: styles.periodLabel }, entry.label),
                      changed ? h('span', { style: styles.questReadyChip }, '已改动') : null,
                    ),
                    h('div', { style: styles.shopDesc }, entry.desc),
                    pairLocked
                      ? h(
                          'div',
                          { style: { ...styles.shopDesc, color: 'var(--dsw-alias-state-warn-primary)' } },
                          // Wording covers the general case: with three doors, the
                          // locked one is the last of its group, and "the others
                          // are already off" is what makes it unclosable.
                          '另外几处入口都关了——这一处得留着，不然就没有地方能再把它们打开。',
                        )
                      : null,
                  ),

                  /**
                   * A fixed-choice setting.
                   *
                   * Rendered as a row of pill buttons, or as COLOUR SWATCHES when
                   * the options carry a `swatch` — a palette is easier to pick from
                   * as colours than as six identical labels, and it shows exactly
                   * what you are about to get.
                   */
                  entry.kind === 'choice'
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                        (entry.options ?? []).map((option) =>
                          h(
                            'button',
                            {
                              key: option.value,
                              type: 'button',
                              onClick: () =>
                                onSave({ [entry.key]: option.value }).catch((err) => {
                                  showToast(err instanceof Error ? err.message : String(err))
                                }),
                              disabled: busy,
                              'aria-pressed': value === option.value,
                              title: option.label,
                              style: {
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                height: '26px',
                                padding: option.swatch ? '0 9px 0 7px' : '0 11px',
                                borderRadius: '999px',
                                border:
                                  value === option.value
                                    ? '1px solid var(--moyu-accent, var(--moyu-accent, var(--dsw-alias-brand-primary)))'
                                    : '1px solid var(--dsw-alias-border-l2)',
                                background:
                                  value === option.value
                                    ? 'color-mix(in srgb, var(--moyu-accent, var(--moyu-accent, var(--dsw-alias-brand-primary))) 16%, transparent)'
                                    : 'transparent',
                                color:
                                  value === option.value
                                    ? 'var(--dsw-alias-label-primary)'
                                    : 'var(--dsw-alias-label-tertiary)',
                                fontFamily: 'inherit',
                                fontSize: '12px',
                                cursor: busy ? 'not-allowed' : 'pointer',
                                opacity: busy ? 0.6 : 1,
                              },
                            },
                            option.swatch
                              ? h('span', {
                                  style: {
                                    width: '12px',
                                    height: '12px',
                                    borderRadius: '50%',
                                    background: option.swatch,
                                    flex: 'none',
                                  },
                                  'aria-hidden': true,
                                })
                              : null,
                            option.label,
                          ),
                        ),
                      )
                    : entry.kind === 'toggle'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          onClick: () =>
                            onSave({ [entry.key]: !value }).catch((err) => {
                              // A rejected patch (usually a stale tab racing the
                              // pair rule) must not vanish silently: the toggle
                              // snaps back, and the toast says why.
                              showToast(err instanceof Error ? err.message : String(err))
                            }),
                          disabled: busy || pairLocked,
                          // The LOOK stays the value's (on = knob right); only the
                          // interaction is locked. A disabled control that also
                          // flips its face reads as "off", which is a lie.
                          style: value ? styles.toggleOn : styles.toggleOff,
                          'aria-pressed': value === true,
                          title: pairLocked
                            ? '至少保留一处入口'
                            : value
                              ? '点击关闭'
                              : '点击开启',
                        },
                        h('span', { style: value ? styles.toggleKnobOn : styles.toggleKnob }),
                      )
                    : h(
                        'div',
                        { style: styles.settingControl },
                        h('input', {
                          type: 'range',
                          min: entry.min,
                          max: entry.max,
                          step: entry.step,
                          value: Number(value),
                          disabled: busy,
                          // Committed on release, not on every pixel of drag: each
                          // change is a round trip AND a disk write.
                          onChange: (event) => {
                            const next = Number(event.target.value)
                            onSave({ [entry.key]: next }).catch(() => {})
                          },
                          style: styles.slider,
                          'aria-label': entry.label,
                        }),
                        h('span', { style: styles.settingValue }, formatSettingValue(entry, value)),
                      ),
                )
              }),
            ),
          ),
        ),

        h(
          'div',
          { style: styles.footNote },
          '设置文件：settings.json（与存档分开存放）',
        ),
      )
    }

    // ── the automatic update popup ───────────────────────────────────────────

    /**
     * A one-line banner announcing a version found by the AUTOMATIC checker.
     *
     * It is separate from the 公告 page on purpose: an automatic check runs while
     * the player is doing something else, and a discovery that only shows up
     * after navigating to a tab nobody opened is not an announcement at all.
     *
     * Dismissal is explicit and one-way for this particular discovery:
     * `announceAt` is cleared on the host, so reopening the panel does not bring
     * the same version back. A NEWER version found later sets it again.
     */
    function AutoUpdateBanner({ notice, onDismiss, onOpen }) {
      const auto = notice?.autoCheck
      if (auto === null || auto === undefined) return null
      if (auto.found !== true || auto.announceAt === null) return null

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '11px 14px',
            borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        },
        h(
          'span',
          { style: { flex: 'none', fontSize: '15px' }, 'aria-hidden': true },
          '✦',
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' } },
          h(
            'div',
            { style: { fontSize: '13px' } },
            `发现新版本 ${auto.latest}（当前 ${auto.current}）`,
          ),
          h(
            'div',
            { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
            '自动检查发现的。去「公告」看看改了什么。',
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onOpen,
            style: {
              flex: 'none',
              height: '28px',
              padding: '0 12px',
              borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
              border: 'none',
              background: 'var(--moyu-accent, var(--dsw-alias-brand-primary))',
              color: 'var(--dsw-alias-label-primary-inverted)',
              fontFamily: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          '去看',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onDismiss,
            title: '不再提示这个版本',
            style: {
              flex: 'none',
              width: '28px',
              height: '28px',
              borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary)',
              fontFamily: 'inherit',
              fontSize: '14px',
              lineHeight: 1,
              cursor: 'pointer',
            },
            'aria-label': '关闭提示',
          },
          '×',
        ),
      )
    }

    /** The settings row for 自动检查更新, disabled while the master switch is off. */
    // ── the panel ────────────────────────────────────────────────────────────

    function CheckinPage() {
      /**
       * Declared BEFORE the data hook, because the hook needs to know whether this
       * tab draws a countdown. 成就 / 关于 / 设置 / 公告 do not, so their 1s
       * heartbeat is never installed — that is the scroll-jank fix.
       */
      const [tab, setTab] = React.useState('claim')

      const {
        data,
        error,
        busy,
        claim,
        claimAll,
        buy,
        openChest,
        openChestBulk,
        collectOffline,
        departTrip,
        collectTrip,
        tripSleep,
        tripGather,
        tripReturnHome,
        sell,
        use,
        claimQuest,
        craft,
        buyStar,
        plant,
        tend,
        harvest,
        harvestAll,
        tendAll,
        expandFarm,
        saveSettings,
        resetSettings,
        rebirth,
        checkUpdate,
        applyUpdate,
        markNoticeRead,
        dismissAutoUpdate,
        buySnack,
        mineSwing,
        mineDescend,
        mineCollect,
        mineUpgrade,
        mineHire,
        mineCollectMiner,
        fishCast,
        fishStrike,
        buyRod,
        setSpot,
        switchRod,
        chooseShopMode,
        restock,
        sellGoods,
        buyMachine,
        collectMachine,
        reload,
        tick,
      } = useCheckin(PANEL_POLL_MS, !STATIC_TABS.has(tab))
      const [toast, setToast] = React.useState(null)
      const [showLocked, setShowLocked] = React.useState(false)
      /** 'list' is the original flat wall; 'tree' is the pan-and-drag graph. */
      const [achView, setAchView] = React.useState('list')
      /** Which codex tab is showing inside 背包. */
      const [dexView, setDexView] = React.useState('routes')
      /** Rebirth destroys progress, so it takes two deliberate clicks. */
      const [rebirthArmed, setRebirthArmed] = React.useState(false)
      /**
       * Update flow state, kept out of the snapshot on purpose.
       *
       * "Is there a newer version?" is a fact about NOW, not about the player's
       * progress, so it is never persisted and never polled: the page starts
       * knowing nothing (`idle`), and only an explicit 检查更新 moves it.
       */
      const [updateState, setUpdateState] = React.useState({ state: 'idle' })
      const [updating, setUpdating] = React.useState(false)
      /**
       * Whether 返回 (early return) has been armed.
       *
       * The host also requires `confirm`, but the UI must show the same two-step
       * intent — arriving early forfeits the trip's loot roll, so a single click
       * would be a real, unrecoverable loss.
       */
      const [tripReturnArmed, setTripReturnArmed] = React.useState(false)
      /**
       * Which plot the seed picker is open for.
       *
       * One picker at a time, keyed by plot index, so the crop list never renders
       * in more than one place.
       */
      const [plantTarget, setPlantTarget] = React.useState(null)

      const toastTimer = React.useRef(null)
      const showToast = React.useCallback((message) => {
        setToast(message)
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }, [])
      React.useEffect(
        () => () => {
          if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        },
        [],
      )

      /**
       * The personalisation palette, resolved into CSS variables.
       *
       * `choice` values are stored as names, not hexes, so the palette lives here
       * and the saved value stays readable ("gold" rather than "#e3b341"). Every
       * setter below feeds a variable that the stylesheet already reads, which is
       * why changing a colour needs no re-render of anything but this wrapper.
       *
       * Declared before the empty-state return because hooks must run in the same
       * order on every render, including the one that shows the loading text.
       */
      const themeVars = React.useMemo(() => {
        const chosen = data?.settings ?? {}
        const ACCENTS = {
          blue: '#4d6bfe',
          green: '#3fb950',
          gold: '#e3b341',
          purple: '#a371f7',
          cyan: '#39c5cf',
          red: '#f85149',
        }
        const corner = chosen.cornerStyle ?? 'default'
        const radiusLg = corner === 'soft' ? '16px' : corner === 'square' ? '4px' : '10px'
        const radiusMd = corner === 'soft' ? '12px' : corner === 'square' ? '3px' : '8px'
        const density = chosen.wallDensity ?? 'cozy'
        const cardMin = density === 'dense' ? '150px' : density === 'compact' ? '190px' : '230px'
        return {
          '--moyu-accent': ACCENTS[chosen.accentColor] ?? ACCENTS.blue,
          '--moyu-radius-lg': radiusLg,
          '--moyu-radius-md': radiusMd,
          '--moyu-card-min': cardMin,
        }
      }, [data?.settings?.accentColor, data?.settings?.cornerStyle, data?.settings?.wallDensity])

      if (data === null) {
        return h(
          'div',
          { style: { ...styles.page, ...themeVars } },
          h('div', { style: styles.empty }, error === null ? '正在读取存档…' : `读不到存档：${error}`),
        )
      }

      const state = data.state
      const achievements = data.achievements
      const unlockedCount = achievements.filter((entry) => entry.unlockedAt !== null).length
      /** Quests that are done but unclaimed — the only thing worth badging. */
      const questsClaimable = data.quests.filter((quest) => quest.done && !quest.claimed).length
      /** Recipes the player could run right now. */
      const craftableCount = data.recipes.filter((recipe) => recipe.craftable).length

      const onClaim = async (key) => {
        try {
          const result = await claim(key)
          const parts = Object.entries(result.granted).map(([currency, value]) => `${currencyLabel(currency)} +${value}`)
          const lucky = result.lucky === null ? '' : `　✦ ${result.lucky.label}`
          showToast(`${result.label}签到成功：${parts.join('　')}${lucky}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onClaimAll = async () => {
        try {
          const result = await claimAll()
          if (result.claimed === 0) showToast('暂时没有可以领取的项目')
          else showToast(`一次领了 ${result.claimed} 项`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onBuy = async (upgrade) => {
        try {
          const result = await buy(upgrade)
          const paid = Object.entries(result.paid)
            .map(([key, value]) => `${currencyLabel(key)} -${value}`)
            .join('　')
          showToast(`买下「${result.label}」Lv.${result.level}　花费 ${paid}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onOpenChest = async (chest) => {
        try {
          const result = await openChest(chest)
          const parts = Object.entries(result.granted).map(
            ([key, value]) => `${currencyLabel(key)} +${value}`,
          )
          showToast(`打开「${result.label}」：${parts.join('　')}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onOpenChestBulk = async (chest, count) => {
        try {
          const result = await openChestBulk(chest, count)
          if (result.openedCount === 0) {
            showToast(result.failure ?? '一个都没开出来')
            return
          }
          // Totals across every chest, so the toast reads one line, not ten.
          const totals = {}
          for (const chest of result.opened) {
            for (const [key, value] of Object.entries(chest.granted)) {
              totals[key] = (totals[key] ?? 0) + value
            }
          }
          const parts = Object.entries(totals)
            .map(([key, value]) => `${currencyLabel(key)} +${value}`)
            .join('　')
          const stopped =
            result.failure !== null && result.openedCount < result.requested
              ? `　（钱只够 ${result.openedCount} 个）`
              : ''
          showToast(`连开 ${result.openedCount} 个「${result.opened[0]?.label ?? ''}」：${parts}${stopped}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onCollectOffline = async () => {
        try {
          const result = await collectOffline()
          const parts = Object.entries(result.granted).map(
            ([key, value]) => `${currencyLabel(key)} +${value}`,
          )
          showToast(`离线收益到账：${parts.join('　')}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onDepart = async (destination) => {
        try {
          const result = await departTrip(destination)
          showToast(`出发去${result.label}，约 ${formatHours(result.hours)} 后回来`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onCollectTrip = async () => {
        try {
          const result = await collectTrip()
          if (result.found.length === 0) {
            showToast('什么都没找到——背包可能满了')
            return
          }
          const names = result.found.map((id) => itemLabel(id)).join('、')
          const left = result.leftBehind.length > 0 ? `（背包满了，落下 ${result.leftBehind.length} 件）` : ''
          showToast(`从${result.label}带回了：${names}${left}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onTripSleep = async () => {
        try {
          const result = await tripSleep()
          showToast(`睡了一觉：跳过 ${formatCountdown(result.skipped)}，体力 ${result.stamina}，物资剩 ${result.supplies}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onTripGather = async () => {
        try {
          const result = await tripGather()
          const names = Object.entries(result.found)
            .map(([id, count]) => `${itemLabel(id)}×${count}`)
            .join('　')
          const lost = result.lost > 0 ? `（装不下，丢了 ${result.lost} 件）` : ''
          showToast(`采集到：${names || '什么都没有'}${lost}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      /**
       * Early return, behind a two-step arm.
       *
       * The first click arms the button and surfaces the consequence; the second
       * sends `confirm: true`. The host refuses without it, so this is not merely
       * UI politeness — the loot roll really is forfeited.
       */
      const onTripReturn = async () => {
        if (!tripReturnArmed) {
          setTripReturnArmed(true)
          showToast('提前返回会放弃这一趟的战利品，再点一次确认')
          return
        }
        setTripReturnArmed(false)
        try {
          const result = await tripReturnHome()
          const names = Object.entries(result.stored)
            .map(([id, count]) => `${itemLabel(id)}×${count}`)
            .join('　')
          showToast(`回到家：${names || '两手空空'}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onSell = async (item, count) => {
        try {
          const result = await sell(item, count)
          const gained = Object.entries(result.gained)
            .map(([key, value]) => `${currencyLabel(key)} +${value}`)
            .join('　')
          showToast(`卖掉 ${result.count} 个「${result.label}」：${gained}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onUse = async (item) => {
        try {
          const result = await use(item)
          if (result.detail.kind === 'supply') {
            showToast(`使用「${result.label}」，物资 +${result.detail.restored}（现在 ${result.detail.current}）`)
          } else if (result.detail.kind === 'stamina') {
            showToast(`使用「${result.label}」，体力 +${result.detail.restored}（现在 ${result.detail.current} / ${result.detail.cap}）`)
          } else {
            showToast(`使用「${result.label}」，${result.detail.buff.label}生效 ${formatHours(result.detail.buff.ms / 3_600_000)}`)
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onClaimQuest = async (quest) => {
        try {
          const result = await claimQuest(quest.id)
          const parts = Object.entries(result.granted).map(([key, value]) => `${currencyLabel(key)} +${value}`)
          const bonus =
            result.bonus === null
              ? ''
              : `　✦ 全清奖励：${Object.entries(result.bonus)
                  .map(([key, value]) => `${currencyLabel(key)} +${value}`)
                  .join('　')}`
          showToast(`完成「${result.label}」：${parts.join('　')}${bonus}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onCraft = async (recipe) => {
        try {
          const result = await craft(recipe.id)
          const made = Object.entries(result.produced)
            .map(([id, count]) => `${itemLabel(id)} ×${count}`)
            .join('　')
          showToast(`炼金「${result.label}」→ ${made}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onBuyStar = async (upgrade) => {
        try {
          const result = await buyStar(upgrade)
          showToast(`点亮「${result.label}」Lv.${result.level}　花费 星辰 -${result.paid}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onPlant = async (plot, crop) => {
        setPlantTarget(null)
        try {
          const result = await plant(plot, crop)
          showToast(`在第 ${plot + 1} 块地种下${result.label}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onTend = async (plot) => {
        try {
          const result = await tend(plot)
          const text =
            result.action.kind === 'water'
              ? `给第 ${plot + 1} 块地浇了水`
              : `清除了第 ${plot + 1} 块地的${result.action.label}`
          showToast(text)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onHarvest = async (plot) => {
        try {
          const result = await harvest(plot)
          const lost = result.lost > 0 ? `　背包满了，落下 ${result.lost} 份` : ''
          showToast(`收获${result.label} ×${result.stored}${lost}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onHarvestAll = async () => {
        try {
          const result = await harvestAll()
          if (result.harvested === 0) {
            showToast('暂时没有成熟的地')
            return
          }
          const lost = result.lost > 0 ? `　背包满了，落下 ${result.lost} 份` : ''
          showToast(`收了 ${result.harvested} 块地，共 ${result.stored} 份${lost}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      /** Buy one snack from 小卖部; it lands in the pack, not in your stomach. */
      const onBuySnack = async (snack) => {
        try {
          const result = await buySnack(snack)
          showToast(`买了「${result.label}」，已经放进背包`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onTendAll = async () => {
        try {
          const result = await tendAll()
          showToast(result.tended === 0 ? '所有作物都很好' : `照看了 ${result.tended} 块地`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const onExpand = async () => {
        try {
          const result = await expandFarm()
          showToast(`开垦成功，现在有 ${result.plots} 块地`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      /**
       * Rebirth, behind a two-step confirmation.
       *
       * The first click only arms the button; the second commits. An accidental
       * click here would erase hours of progress, so the friction is the point.
       */
      const onRebirth = async () => {
        // The confirmation is skippable by setting, but the DEFAULT is on: an
        // accidental rebirth erases hours of progress.
        if (data.settings.confirmRebirth === true && !rebirthArmed) {
          setRebirthArmed(true)
          showToast('再点一次确认转生——等级、货币与商店升级会清零')
          return
        }
        setRebirthArmed(false)
        try {
          const result = await rebirth()
          const start = result.startGold > 0 ? `　启程 +${result.startGold} 金币` : ''
          showToast(`转生完成：等级 ${result.level} → 星辰 +${result.stars}${start}`)
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }

      const currencyLabel = (key) => {
        const found = data.currencies.find((entry) => entry.key === key)
        return found === undefined ? key : found.label
      }

      const currencyToken = (key) => {
        const found = data.currencies.find((entry) => entry.key === key)
        return found === undefined ? 'var(--dsw-alias-label-primary)' : `var(${found.token})`
      }

      const currencySymbol = (key) => {
        const found = data.currencies.find((entry) => entry.key === key)
        return found === undefined ? '•' : found.symbol
      }

      /**
       * A currency bundle as one line: `●300 + ◆2`.
       *
       * Negative amounts are shown with a leading minus and the whole line keeps
       * its sign visible, because the shop's net figure can legitimately be
       * negative (a machine that owes more wage than it sold) and hiding that
       * would misreport the payout.
       */
      const describeBundle = (bundle, symbol = currencySymbol) => {
        const entries = Object.entries(bundle ?? {}).filter(([, amount]) => amount !== 0)
        if (entries.length === 0) return '0'
        return entries.map(([key, amount]) => `${symbol(key)}${formatNumber(amount)}`).join(' + ')
      }

      /** The display name of an item id, falling back to the raw id. */
      const itemLabel = (id) => {
        const found = data.items.find((entry) => entry.id === id)
        return found === undefined ? id : found.label
      }

      const itemMeta = (id) => data.items.find((entry) => entry.id === id) ?? null

      return h(
        'div',
        { style: styles.page },
        // ── header ──
        h(
          'div',
          { style: styles.head },
          h(
            'div',
            null,
            h('h2', { style: styles.title }, '签到'),
            h(
              'p',
              { style: styles.intro },
              state.readyCount > 0
                ? `现在有 ${state.readyCount} 项可以领取`
                : '暂时都领完了，过一会儿再来',
              '　·　',
              `累计 ${formatNumber(state.total)} 次`,
            ),
          ),
          h(
            'div',
            { style: styles.headActions },
            h(
              'button',
              {
                type: 'button',
                onClick: reload,
                disabled: busy,
                style: styles.ghostButton,
                title: '重新读取存档',
              },
              '刷新',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: onClaimAll,
                disabled: busy || state.readyCount === 0,
                style:
                  state.readyCount === 0 || busy
                    ? styles.primaryButtonDisabled
                    : styles.primaryButton,
              },
              state.readyCount > 0 ? `全部领取（${state.readyCount}）` : '全部领取',
            ),
          ),
        ),

        // ── level bar ──
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.levelRow },
            h('span', { style: styles.levelBadge }, `Lv.${state.level}`),
            h(
              'div',
              { style: styles.levelTrack },
              h('div', {
                style: {
                  ...styles.levelFill,
                  width: `${Math.round(Math.min(1, state.levelProgress) * 100)}%`,
                },
              }),
            ),
            h(
              'span',
              { style: styles.levelText },
              `${formatNumber(state.levelInto)} / ${formatNumber(state.levelNeed)}`,
            ),
          ),
          h(
            'div',
            { style: styles.modRow },
            h('span', null, `幸运 +${Math.round(state.modifiers.luck * 100)}%`),
            h('span', null, `宽限 +${state.modifiers.grace}`),
            h('span', null, `离线速率 ×${state.modifiers.offlineRate.toFixed(2)}`),
            h('span', null, `离线上限 ${state.modifiers.offlineCapHours}h`),
            h('span', null, `议价 ×${state.modifiers.haggle.toFixed(2)}`),
            h('span', null, `寻宝 +${state.modifiers.fortune}`),
          ),
          // Supplies get their own row because they gate the whole 出门 loop:
          // an empty bar is the one thing that stops you playing.
          h(
            'div',
            { style: styles.supplyRow },
            h('span', { style: styles.supplyLabel }, '物资'),
            h(
              'div',
              { style: styles.supplyTrack },
              h('div', {
                style: {
                  ...styles.supplyFill,
                  width: `${Math.round((state.supplies.current / Math.max(1, state.supplies.cap)) * 100)}%`,
                },
              }),
            ),
            h(
              'span',
              { style: styles.supplyText },
              `${state.supplies.current} / ${state.supplies.cap}`,
              state.supplies.current < state.supplies.cap
                ? `　+1 于 ${formatCountdown(state.supplies.nextIn * 1000)}`
                : '',
            ),
          ),
        ),

        // ── active buffs ──
        state.buffs.length > 0
          ? h(
              'div',
              { style: styles.buffRow },
              state.buffs.map((buff) =>
                h(
                  'span',
                  { key: buff.id, style: styles.buffChip },
                  `${buff.label} +${Math.round(buff.amount * 100)}%　剩 ${formatCountdown(buff.remainingMs)}`,
                ),
              ),
            )
          : null,

        // ── offline earnings ──
        // Shown only when there is something to collect, so an idle panel does
        // not grow a row that says "0".
        state.offline.total > 0
          ? h(
              'div',
              { style: styles.offlineCard },
              h(
                'div',
                { style: styles.offlineBody },
                h('div', { style: styles.offlineTitle }, '离线收益'),
                h(
                  'div',
                  { style: styles.offlineDetail },
                  Object.entries(state.offline.pool)
                    .filter(([, value]) => value > 0)
                    .map(([key, value]) => `${currencyLabel(key)} +${formatNumber(value)}`)
                    .join('　'),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: onCollectOffline,
                  disabled: busy,
                  style: busy ? styles.claimButtonDisabled : styles.claimButton,
                },
                '领取',
              ),
            )
          : null,

        // ── currencies ──
        h(
          'div',
          { style: styles.currencyGrid },
          data.currencies.map((currency) =>
            h(
              'div',
              { key: currency.key, style: styles.currencyCard },
              h(
                'div',
                { style: { ...styles.currencySymbol, color: `var(${currency.token})` } },
                currency.symbol,
              ),
              h(
                'div',
                { style: styles.currencyBody },
                h('div', { style: styles.currencyLabel }, currency.label),
                h(
                  'div',
                  { style: styles.currencyValue },
                  formatNumber(state.currencies[currency.key]),
                ),
                h(
                  'div',
                  { style: styles.currencyEarned },
                  `累计 ${formatNumber(state.earned[currency.key])}`,
                ),
              ),
            ),
          ),
        ),

        // ── automatic update announcement ──
        // Above the tabs so it is the first thing seen when the panel opens. It
        // renders nothing at all when no automatic check has found anything.
        h(AutoUpdateBanner, {
          notice: data.notice,
          onOpen: () => setTab('notice'),
          onDismiss: () => {
            dismissAutoUpdate().catch(() => {})
          },
        }),

        // ── tabs ──
        // Only the claim tab carries a count, and only while something is
        // actually ready. The achievements tab deliberately shows NO badge: a
        // permanent "51" reads as an unread-notification alert that can never be
        // cleared, which is noise rather than information. The unlocked total
        // lives in the section header instead, as a plain "12 / 83".
        h(
          'div',
          { style: styles.tabBar },
          [
            { key: 'claim', label: '签到', badge: state.readyCount },
            // The quest tab badges unclaimed-but-complete quests: that is the one
            // signal worth interrupting for, because the reward is sitting there.
            { key: 'quest', label: '任务', badge: questsClaimable, show: data.settings.showQuests },
            // Badge the farm for EITHER reason to come look: something is ripe, or
            // something is sick. Ailments only slow growth, so a neglected plot
            // still finishes — which is precisely why the player forgets it, and
            // why a silent debuff is the wrong default.
            { key: 'farm', label: '农场', badge: Math.max(state.farmReady, state.farmAiling ?? 0), show: data.settings.showFarm },
            // Badge mining only when there is actually something to do with the
            // stamina you have: a full bag waiting to be collected, or enough
            // stamina for a swing. Otherwise the dot would be permanent noise.
            {
              key: 'mine',
              label: '挖矿',
              badge:
                (state.mineBuffered ?? 0) > 0 || (state.mineStamina ?? 0) >= 1 ? 1 : 0,
              show: data.settings.showMine,
            },
            {
              key: 'trip',
              label: '出门',
              badge: state.trip !== null && state.trip.ready ? 1 : 0,
              show: data.settings.showTrip,
            },
            { key: 'pack', label: '背包', badge: 0 },
            { key: 'alchemy', label: '炼金', badge: 0, show: data.settings.showAlchemy },
            { key: 'shop', label: '商店', badge: 0 },
            // 钓鱼 and 开店 are their own tabs. The key is `store` rather than
            // `shop` because 商店 (the upgrade shop) already owns that one — and a
            // duplicate key in this list would render two buttons that look
            // identical and select different state.
            // The badge means "a line is out", NOT "a fish is biting".
            //
            // It used to test `fishCast.state === 'biting'`, which is a sub-second
            // window sampled by a 5s poll: it would light up roughly never. The
            // honest signal at this poll rate is "you have a cast in the water" —
            // which is also the thing worth reminding yourself about, since a cast
            // left alone just times out.
            { key: 'fish', label: '钓鱼', badge: state.fishCast !== null ? 1 : 0 },
            { key: 'store', label: '开店', badge: 0 },
            { key: 'chest', label: '宝箱', badge: 0, show: data.settings.showChests },
            { key: 'star', label: '星盘', badge: 0, show: data.settings.showStar },
            { key: 'ach', label: '成就', badge: 0 },
            // 公告 badges only when a NEWER version is known to exist AND the
            // player asked to be told. It is a dot, not a count, and it can be
            // cleared by turning the notification off — unlike the achievements
            // tab, where a permanent number would just be noise.
            {
              key: 'notice',
              label: '公告',
              badge: data.settings.notifyNewVersion === true && updateState.state === 'newer' ? 1 : 0,
            },
            // 关于 sits next to the achievements: it is a page you visit once, on
            // purpose, and it is a DESTINATION by nature. So unlike every system
            // tab it is never hideable — if the settings page could turn it off,
            // there would be nothing left saying who made this and why.
            { key: 'about', label: '关于', badge: 0 },
            // Settings is always last and never hideable: turning off every system
            // must not leave a way to turn them back on.
            { key: 'settings', label: '设置', badge: 0 },
          ]
            .filter((entry) => entry.show !== false)
            .map((entry) =>
              h(
                'button',
                {
                  key: entry.key,
                  type: 'button',
                  onClick: () => setTab(entry.key),
                  style: tab === entry.key ? styles.tabActive : styles.tab,
                  title: entry.label,
                },
                // Condensed mode keeps the tab BAR but drops the words, which is
                // what lets 11 tabs fit a narrow window.
                data.settings.condensedTabs
                  ? h(TabIcon, { name: entry.key, size: 15 })
                  : entry.label,
                entry.badge > 0 ? h('span', { style: styles.tabBadge }, String(entry.badge)) : null,
              ),
            ),
        ),

        // ── periods (claim tab) ──
        tab !== 'claim'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '签到周期',
                state.readyCount > 0
                  ? h('span', { style: styles.sectionHint }, `${state.readyCount} 项可领`)
                  : null,
              ),
              h(
                'div',
                { style: styles.periodList },
                data.state.periods.map((period) => {
                  // The countdown is recomputed every second from the host's
                  // readyAt, so it stays honest between polls.
                  const remaining = period.ready ? 0 : Math.max(0, period.readyAt - Date.now())
                  const ready = period.ready || remaining === 0
                  return h(
                    'div',
                    { key: period.key, style: ready ? styles.periodRowReady : styles.periodRow },
                    h('div', {
                      style: {
                        ...styles.periodDot,
                        background: `var(${period.accent})`,
                        opacity: ready ? 1 : 0.35,
                      },
                    }),
                    h(
                      'div',
                      { style: styles.periodMain },
                      h(
                        'div',
                        { style: styles.periodTitleRow },
                        h('span', { style: styles.periodLabel }, period.label),
                        period.streak > 1
                          ? h('span', { style: styles.streakChip }, `连签 ${period.streak}`)
                          : null,
                        period.best > 0
                          ? h('span', { style: styles.bestChip }, `最高 ${period.best}`)
                          : null,
                        period.yieldMultiplier > 1
                          ? h(
                              'span',
                              { style: styles.yieldChip },
                              `产出 ×${period.yieldMultiplier.toFixed(2)}`,
                            )
                          : null,
                      ),
                      h(
                        'div',
                        { style: styles.rewardRow },
                        Object.entries(period.rewards).map(([key, value]) =>
                          h(
                            'span',
                            { key, style: { ...styles.rewardChip, color: currencyToken(key) } },
                            `${currencySymbol(key)} ${value}`,
                          ),
                        ),
                        h('span', { style: styles.rewardTotal }, `共 ${period.total} 次`),
                      ),
                    ),
                    ready
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => onClaim(period.key),
                            disabled: busy,
                            style: busy ? styles.claimButtonDisabled : styles.claimButton,
                          },
                          '签到',
                        )
                      : h('span', { style: styles.countdown }, formatRemaining(remaining)),
                  )
                }),
              ),
            ),

        // ── trip tab ──
        tab !== 'trip'
          ? null
          : h(
              React.Fragment,
              null,
              // A trip in progress becomes a small CAMP: three things you can do,
              // each trading one resource for another. Previously this was a bare
              // countdown, which made the long destinations (6h / 12h) the most
              // boring part of the game exactly when they should be eventful —
              // you set off, then went and did something else.
              state.trip !== null
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { style: state.trip.ready ? styles.tripCardReady : styles.tripCard },
                      h(CompassIcon, { size: 26 }),
                      h(
                        'div',
                        { style: styles.tripBody },
                        h('div', { style: styles.tripTitle }, `正在${state.trip.label}`),
                        h(
                          'div',
                          { style: styles.tripDetail },
                          state.trip.ready
                            ? '已经回来了，去收取'
                            : `还要 ${formatCountdown(state.trip.remainingMs)}`,
                          `　·　出发时用了 ${state.trip.spent} 物资`,
                        ),
                        // What has been gathered so far, while away.
                        state.trip.gatheredTotal > 0
                          ? h(
                              'div',
                              { style: styles.tripDetail },
                              `已采到 ${state.trip.gatheredTotal} 件：${Object.entries(state.trip.gathered)
                                .map(([id, count]) => `${itemLabel(id)}×${count}`)
                                .join('　')}`,
                            )
                          : null,
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: onCollectTrip,
                          disabled: busy || !state.trip.ready,
                          style:
                            busy || !state.trip.ready ? styles.buyButtonDisabled : styles.claimButton,
                        },
                        state.trip.ready ? '收取' : '在路上',
                      ),
                    ),

                    // The three camp actions, rendered from the host's table.
                    state.trip.ready
                      ? null
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { style: styles.sectionTitle },
                            '在营地',
                            h('span', { style: styles.sectionHint }, '动作来自宿主的表，不用改客户端'),
                          ),
                          h(
                            'div',
                            { style: styles.campGrid },
                            state.tripActions.map((action) => {
                              if (action.id === 'return') {
                                return h(
                                  'button',
                                  {
                                    key: action.id,
                                    type: 'button',
                                    onClick: onTripReturn,
                                    disabled: busy,
                                    style: tripReturnArmed ? styles.campDanger : styles.campAction,
                                  },
                                  h(
                                    'span',
                                    { style: { ...styles.campGlyph, color: `var(${action.accent})` } },
                                    action.glyph,
                                  ),
                                  h(
                                    'span',
                                    { style: styles.campBody },
                                    h(
                                      'span',
                                      { style: styles.campLabel },
                                      tripReturnArmed ? '确认返回' : action.label,
                                    ),
                                    h(
                                      'span',
                                      { style: styles.campDesc },
                                      tripReturnArmed
                                        ? '会放弃这一趟的战利品，只带走已采集的'
                                        : action.desc,
                                    ),
                                  ),
                                )
                              }
                              const gatherBlocked = action.id === 'gather' && !state.trip.gatherReady
                              const sleepBlocked = action.id === 'sleep' && !state.trip.sleepReady
                              const blocked = gatherBlocked || sleepBlocked
                              return h(
                                'button',
                                {
                                  key: action.id,
                                  type: 'button',
                                  onClick: () => {
                                    if (action.id === 'sleep') onTripSleep()
                                    else if (action.id === 'gather') onTripGather()
                                  },
                                  disabled: busy || blocked,
                                  style: blocked ? styles.campActionDisabled : styles.campAction,
                                  title: blocked
                                    ? gatherBlocked
                                      ? `冷却中，还要 ${formatCountdown(state.trip.gatherIn * 1000)}`
                                      : '物资不够睡觉'
                                    : action.desc,
                                },
                                h(
                                  'span',
                                  { style: { ...styles.campGlyph, color: `var(${action.accent})` } },
                                  action.glyph,
                                ),
                                h(
                                  'span',
                                  { style: styles.campBody },
                                  h('span', { style: styles.campLabel }, action.label),
                                  h('span', { style: styles.campDesc }, action.desc),
                                ),
                              )
                            }),
                          ),
                        ),

                    // What 采集 can turn up, so the "偶尔有好货" line is honest.
                    state.trip.ready || state.forage === undefined
                      ? null
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { style: styles.sectionTitle },
                            '采集可能得到',
                            h('span', { style: styles.sectionHint }, '重量越大越常见'),
                          ),
                          h(
                            'div',
                            { style: styles.dexGrid },
                            // Sorted so the rarest shows last, matching the claim
                            // that good finds are uncommon.
                            [...state.forage]
                              .sort((a, b) => b.chance - a.chance)
                              .map((entry) =>
                                h(
                                  'div',
                                  { key: entry.id, style: styles.dexCard },
                                  h(
                                    'div',
                                    { style: { ...styles.plantGlyph, color: `var(${entry.accent})` } },
                                    entry.glyph,
                                  ),
                                  h(
                                    'div',
                                    { style: styles.dexBody },
                                    h('div', { style: styles.achLabel }, entry.label),
                                    h(
                                      'div',
                                      { style: styles.achDesc },
                                      `${RARITY_CN[entry.rarity] ?? entry.rarity}　重量 ${entry.chance}`,
                                    ),
                                  ),
                                ),
                              ),
                          ),
                        ),
                  )
                : h(
                    'div',
                    { style: styles.empty },
                    '选一个地方出门。越远耗时越久、消耗物资越多，但带回来的东西越好。',
                  ),

              state.trip === null
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { style: styles.sectionTitle },
                      '目的地',
                      h('span', { style: styles.sectionHint }, '消耗物资，按真实时间返回'),
                    ),
                    h(
                      'div',
                      { style: styles.destList },
                      data.destinations.map((destination) =>
                        h(
                          'div',
                          { key: destination.id, style: styles.destRow },
                          h('div', {
                            style: {
                              ...styles.periodDot,
                              background: `var(${destination.accent})`,
                            },
                          }),
                          h(
                            'div',
                            { style: styles.destMain },
                            h(
                              'div',
                              { style: styles.periodTitleRow },
                              h('span', { style: styles.periodLabel }, destination.label),
                              h(
                                'span',
                                { style: styles.levelChip },
                                `约 ${formatHours(destination.effectiveHours)}`,
                              ),
                              destination.runs > 0
                                ? h('span', { style: styles.bestChip }, `去过 ${destination.runs} 次`)
                                : null,
                            ),
                            h('div', { style: styles.shopDesc }, destination.desc),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => onDepart(destination.id),
                              disabled: busy || !destination.affordable,
                              style:
                                busy || !destination.affordable
                                  ? styles.buyButtonDisabled
                                  : styles.buyButton,
                              title:
                                destination.affordable
                                  ? `消耗 ${destination.supply} 物资`
                                  : `物资不足（需要 ${destination.supply}）`,
                            },
                            destination.affordable
                              ? `出发 ◈${destination.supply}`
                              : `缺物资 ◈${destination.supply}`,
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
            ),

        // ── pack tab ──
        tab !== 'pack'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '背包',
                h(
                  'span',
                  { style: styles.sectionHint },
                  `${state.packUsed} / ${state.packSize} 件　·　行程 ${state.expedition.runs} 次　·　已找到 ${state.expedition.uniqueFound}/${data.items.length} 种`,
                ),
              ),
              state.pack.length === 0
                ? h('div', { style: styles.empty }, '背包是空的。去「出门」走一趟吧。')
                : h(
                    'div',
                    { style: styles.packList },
                    // Sellable items first: they are what you actually came back
                    // to do, and the list is otherwise unsorted.
                    [...state.pack]
                      .sort((a, b) => {
                        const ma = itemMeta(a.item)
                        const mb = itemMeta(b.item)
                        const rank = (m) => (m === null ? 9 : m.kind === 'sell' ? 0 : 1)
                        return rank(ma) - rank(mb)
                      })
                      .map((row) => {
                        const meta = itemMeta(row.item)
                        if (meta === null) return null
                        const sellable = meta.kind === 'sell' && meta.sellValue !== null
                        const usable = meta.kind !== 'sell'
                        return h(
                          'div',
                          { key: row.item, style: styles.packRow },
                          h(
                            'div',
                            { style: { ...styles.packGlyph, color: `var(${meta.accent})` } },
                            meta.glyph,
                          ),
                          h(
                            'div',
                            { style: styles.packMain },
                            h(
                              'div',
                              { style: styles.periodTitleRow },
                              h('span', { style: styles.periodLabel }, `${meta.label} ×${row.count}`),
                              h(
                                'span',
                                {
                                  style: {
                                    ...styles.rarityChip,
                                    color:
                                      meta.rarity === 'legendary' || meta.rarity === 'rare'
                                        ? `var(${meta.accent})`
                                        : 'var(--dsw-alias-label-tertiary)',
                                  },
                                },
                                meta.rarityLabel,
                              ),
                            ),
                            h('div', { style: styles.shopDesc }, meta.desc),
                            sellable
                              ? h(
                                  'div',
                                  { style: styles.sellValueRow },
                                  h('span', { style: styles.sellValueLabel }, '卖价'),
                                  Object.entries(meta.sellValue).map(([key, value]) =>
                                    h(
                                      'span',
                                      { key, style: { ...styles.rewardChip, color: currencyToken(key) } },
                                      `${currencySymbol(key)} ${formatNumber(value)}`,
                                    ),
                                  ),
                                )
                              : null,
                          ),
                          h(
                            'div',
                            { style: styles.packActions },
                            sellable
                              ? h(
                                  React.Fragment,
                                  null,
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      onClick: () => onSell(row.item, 1),
                                      disabled: busy,
                                      style: busy ? styles.buyButtonDisabled : styles.buyButton,
                                    },
                                    '卖 1',
                                  ),
                                  row.count > 1
                                    ? h(
                                        'button',
                                        {
                                          type: 'button',
                                          onClick: () => onSell(row.item, row.count),
                                          disabled: busy,
                                          style: busy ? styles.buyButtonDisabled : styles.buyButton,
                                        },
                                        `全卖`,
                                      )
                                    : null,
                                )
                              : null,
                            usable
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    onClick: () => onUse(row.item),
                                    disabled: busy,
                                    style: busy ? styles.buyButtonDisabled : styles.buyButton,
                                  },
                                  '使用',
                                )
                              : null,
                          ),
                        )
                      }),
                  ),
              // The codex: two readings of the same collection — what the routes
              // pay, and what has been found. Hidden entirely when the player
              // turns it off; the tab keeps working, only this section goes.
              data.settings.showCodex === false
                ? null
                : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { style: styles.sectionTitle },
                  '图鉴',
                  h(
                    'span',
                    { style: styles.sectionHint },
                    dexView === 'routes'
                      ? '按当前加成估算'
                      : `${state.expedition.uniqueFound} / ${data.items.length} 种`,
                  ),
                  h(
                    'div',
                    { style: styles.viewSwitch },
                    [
                      { key: 'routes', label: '路线估值' },
                      { key: 'items', label: '收藏' },
                    ].map((option) =>
                      h(
                        'button',
                        {
                          key: option.key,
                          type: 'button',
                          onClick: () => setDexView(option.key),
                          style: dexView === option.key ? styles.viewSwitchActive : styles.viewSwitchItem,
                        },
                        option.label,
                      ),
                    ),
                  ),
                ),
                dexView === 'routes'
                  ? h(RouteCodex, {
                      destinations: data.destinations,
                      valuation: data.valuation,
                      currencyToken,
                      currencyLabel,
                    })
                  : h(
                      'div',
                      { style: styles.dexGrid },
                      data.items.map((item) =>
                        h(
                          'div',
                          {
                            key: item.id,
                            style: item.found > 0 ? styles.dexCard : styles.dexCardLocked,
                            title: item.desc,
                          },
                          h(
                            'div',
                            {
                              style: {
                                ...styles.packGlyph,
                                color: item.found > 0 ? `var(${item.accent})` : 'var(--dsw-alias-label-quaternary)',
                              },
                            },
                            item.found > 0 ? item.glyph : '?',
                          ),
                          h(
                            'div',
                            { style: styles.dexBody },
                            h('div', { style: styles.achLabel }, item.found > 0 ? item.label : '未发现'),
                            h(
                              'div',
                              { style: styles.achDesc },
                              item.found > 0
                                ? `找到 ${item.found}　卖出 ${item.sold}`
                                : `${item.rarityLabel}　${item.kind === 'sell' ? '可卖' : item.kind === 'supply' ? '补给' : '增益'}`,
                            ),
                          ),
                        ),
                      ),
                    ),
              ),
            ),

        // ── shop tab ──
        tab !== 'shop'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '商店',
                h('span', { style: styles.sectionHint }, '永久升级，价格逐级上涨'),
              ),
              h(
                'div',
                { style: styles.shopList },
                data.shop.map((item) =>
                  h(
                    'div',
                    { key: item.id, style: styles.shopRow },
                    h('div', {
                      style: { ...styles.periodDot, background: `var(${item.accent})` },
                    }),
                    h(
                      'div',
                      { style: styles.shopMain },
                      h(
                        'div',
                        { style: styles.periodTitleRow },
                        h('span', { style: styles.periodLabel }, item.label),
                        h('span', { style: styles.levelChip }, `Lv.${item.level}/${item.max}`),
                      ),
                      h('div', { style: styles.shopDesc }, item.desc),
                      // A small progress bar makes the leveling feel tangible.
                      h(
                        'div',
                        { style: styles.upgradeTrack },
                        h('div', {
                          style: {
                            ...styles.upgradeFill,
                            width: `${Math.round((item.level / item.max) * 100)}%`,
                            background: `var(${item.accent})`,
                          },
                        }),
                      ),
                    ),
                    item.maxed
                      ? h('span', { style: styles.maxedTag }, '已满级')
                      : h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => onBuy(item.id),
                            disabled: busy || !item.affordable,
                            style:
                              busy || !item.affordable
                                ? styles.buyButtonDisabled
                                : styles.buyButton,
                            title: item.affordable ? '购买一级' : '货币不足',
                          },
                          `${currencySymbol(item.costCurrency)} ${formatNumber(item.nextCost)}`,
                        ),
                  ),
                ),
              ),
            ),

        // ── chest tab ──
        tab !== 'chest'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '宝箱',
                h('span', { style: styles.sectionHint }, `已开 ${state.chestsOpened} 个`),
              ),
              h(
                'div',
                { style: styles.chestGrid },
                data.chests.map((chest) =>
                  h(
                    'div',
                    { key: chest.id, style: styles.chestCard },
                    h(ChestIcon, { accent: chest.accent, size: 34 }),
                    h('div', { style: styles.chestLabel }, chest.label),
                    h('div', { style: styles.chestDesc }, chest.desc),
                    h(
                      'div',
                      { style: styles.chestCost },
                      Object.entries(chest.cost)
                        .map(([key, value]) => `${currencySymbol(key)} ${formatNumber(value)}`)
                        .join('　'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => onOpenChest(chest.id),
                        disabled: busy || !chest.affordable,
                        style:
                          busy || !chest.affordable
                            ? styles.buyButtonDisabled
                            : styles.buyButton,
                      },
                      chest.affordable ? '打开' : '货币不足',
                    ),
                    // Bulk: right-click equivalent, exposed as an explicit second
                    // button. It opens up to 10 and stops at the first failure, so
                    // a short wallet never goes into debt.
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => onOpenChestBulk(chest.id, CHEST_BULK_MAX),
                        disabled: busy || !chest.affordable,
                        style:
                          busy || !chest.affordable
                            ? styles.buyButtonDisabled
                            : styles.buyButton,
                        title: `最多开 ${CHEST_BULK_MAX} 个，钱不够就停`,
                      },
                      `连开 ×${CHEST_BULK_MAX}`,
                    ),
                    chest.opened > 0
                      ? h('div', { style: styles.chestCount }, `已开 ${chest.opened}`)
                      : null,
                  ),
                ),
              ),
            ),

        // ── farm tab ──
        tab !== 'farm'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '农场',
                h(
                  'span',
                  { style: styles.sectionHint },
                  `${data.farm.plotsOwned} 块地　·　已收 ${formatNumber(data.farm.harvested)} 份　·　照看 ${formatNumber(data.farm.tended)} 次`,
                ),
              ),

              /**
               * The ailment reminder.
               *
               * A request from a player who kept forgetting the farm: a debuff only
               * slows growth and never kills the crop, so nothing ever forces you
               * to look. This names the affected plots and what is wrong with them,
               * then points at the one button that fixes it.
               */
              (state.farmAiling ?? 0) === 0
                ? null
                : h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        flexWrap: 'wrap',
                        padding: '11px 14px',
                        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
                        border: '1px solid var(--dsw-alias-border-l2)',
                        background: 'var(--dsw-alias-bg-layer-2)',
                      },
                    },
                    h('span', { style: { flex: 'none', fontSize: '15px' }, 'aria-hidden': true }, '⚠'),
                    h(
                      'div',
                      { style: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' } },
                      h(
                        'div',
                        { style: { fontSize: '13px' } },
                        `${state.farmAiling} 块地状态不好`,
                      ),
                      h(
                        'div',
                        { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
                        `${(data.farm.plots ?? [])
                          .filter((plot) => (plot.ailments ?? []).length > 0)
                          .map((plot) => `第 ${plot.index + 1} 块：${plot.ailments.map((a) => a.label).join('、')}`)
                          .join('　·　')}　—— 只是长得慢，不会死，但值得看一眼。`,
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: onTendAll,
                        disabled: busy,
                        style: busy ? styles.buyButtonDisabled : styles.claimButton,
                      },
                      '一键照看',
                    ),
                  ),

              // Bulk actions first: the common visit is "collect and go".
              h(
                'div',
                { style: styles.headActions },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: onHarvestAll,
                    disabled: busy || state.farmReady === 0,
                    style: busy || state.farmReady === 0 ? styles.buyButtonDisabled : styles.claimButton,
                  },
                  state.farmReady > 0 ? `一键收获（${state.farmReady}）` : '一键收获',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: onTendAll,
                    disabled: busy || state.farmPlanted === 0,
                    style: busy || state.farmPlanted === 0 ? styles.buyButtonDisabled : styles.buyButton,
                  },
                  '一键照看',
                ),
                data.farm.expandCost === null
                  ? h('span', { style: styles.maxedTag }, '已是最大规模')
                  : h(
                      'button',
                      {
                        type: 'button',
                        onClick: onExpand,
                        disabled: busy || !data.farm.canExpand,
                        style: busy || !data.farm.canExpand ? styles.buyButtonDisabled : styles.buyButton,
                        title: `花 ${formatNumber(data.farm.expandCost)} 金币开一块新地`,
                      },
                      `开垦新地 ◉${formatNumber(data.farm.expandCost)}`,
                    ),
              ),

              // The plots themselves: a grid, because a farm reads as a field.
              h(
                'div',
                { style: styles.plotGrid },
                data.farm.plots.map((plot) =>
                  h(
                    'div',
                    {
                      key: plot.index,
                      style: plot.empty
                        ? styles.plotEmpty
                        : plot.ready
                          ? styles.plotReady
                          : styles.plot,
                    },
                    // Header: the plot number and, when growing, the crop.
                    h(
                      'div',
                      { style: styles.plotHead },
                      h('span', { style: styles.plotIndex }, `#${plot.index + 1}`),
                      plot.empty
                        ? null
                        : h(
                            'span',
                            {
                              style: {
                                ...styles.plantGlyph,
                                color: `var(${plot.accent})`,
                                opacity: plot.ready ? 1 : 0.75,
                              },
                            },
                            plot.glyph,
                          ),
                    ),

                    plot.empty
                      ? // Empty plot: either a seed picker, or a button to open one.
                        plantTarget === plot.index
                        ? h(
                            'div',
                            { style: styles.seedList },
                            data.crops.map((crop) =>
                              h(
                                'button',
                                {
                                  key: crop.id,
                                  type: 'button',
                                  onClick: () => onPlant(plot.index, crop.id),
                                  disabled: busy || !crop.affordable,
                                  style: crop.affordable ? styles.seedRow : styles.seedRowDisabled,
                                  title: crop.desc,
                                },
                                h('span', {
                                  style: { ...styles.plantGlyph, color: `var(${crop.accent})` },
                                  },
                                  crop.glyph,
                                ),
                                h(
                                  'span',
                                  { style: styles.seedBody },
                                  h('span', { style: styles.seedLabel }, crop.label),
                                  h(
                                    'span',
                                    { style: styles.seedMeta },
                                    `${formatHours(crop.needMs / 3_600_000)}　产 ${crop.yieldLabel}×${crop.yield.min}-${crop.yield.max}`,
                                  ),
                                ),
                                h(
                                  'span',
                                  { style: styles.seedCost },
                                  Object.entries(crop.seed)
                                    .map(([key, value]) => `${currencySymbol(key)}${formatNumber(value)}`)
                                    .join(' '),
                                ),
                              ),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                onClick: () => setPlantTarget(null),
                                style: styles.seedCancel,
                              },
                              '取消',
                            ),
                          )
                        : h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => setPlantTarget(plot.index),
                              disabled: busy,
                              style: styles.plantButton,
                            },
                            '＋ 种植',
                          )
                      : h(
                          React.Fragment,
                          null,
                          h('div', { style: styles.plotCropName }, `${plot.label}　${plot.percent}%`),
                          // A progress bar, not just a number: the point of the
                          // farm is seeing growth at a glance.
                          h(
                            'div',
                            { style: styles.plotTrack },
                            h('div', {
                              style: {
                                ...styles.plotFill,
                                width: `${plot.percent}%`,
                                background: plot.ready
                                  ? 'var(--dsw-alias-state-success-primary)'
                                  : `var(${plot.accent})`,
                              },
                            }),
                          ),
                          h(
                            'div',
                            { style: styles.plotMeta },
                            plot.ready
                              ? '已成熟'
                              : `${formatCountdown(plot.remainingMs)}　×${plot.rate.toFixed(2)}`,
                          ),
                          // Ailments, with the reason tending matters.
                          plot.ailments.length > 0
                            ? h(
                                'div',
                                { style: styles.ailmentRow },
                                plot.ailments.map((ailment) =>
                                  h(
                                    'span',
                                    {
                                      key: ailment.id,
                                      style: { ...styles.ailmentChip, color: `var(${ailment.accent})` },
                                      title: `${ailment.desc}（生长变慢）`,
                                    },
                                    `${ailment.glyph} ${ailment.label}`,
                                  ),
                                ),
                              )
                            : null,
                          plot.watered
                            ? h('div', { style: styles.wateredChip }, `☀ 已浇水（还剩 ${formatCountdown(plot.wateredMs)}）`)
                            : null,
                          h(
                            'div',
                            { style: styles.plotActions },
                            plot.ready
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    onClick: () => onHarvest(plot.index),
                                    disabled: busy,
                                    style: busy ? styles.buyButtonDisabled : styles.claimButton,
                                  },
                                  '收获',
                                )
                              : h(
                                  'button',
                                  {
                                    type: 'button',
                                    onClick: () => onTend(plot.index),
                                    disabled: busy,
                                    style: busy ? styles.buyButtonDisabled : styles.buyButton,
                                  },
                                  plot.ailments.length > 0 ? '除害' : '浇水',
                                ),
                          ),
                        ),
                  ),
                ),
              ),

              h(
                'div',
                { style: styles.codexNote },
                '作物会随真实时间生长，离开 DSH 也在长。缺水、杂草、害虫只会让它们长慢一点——不会死。',
              ),

              // Harvest totals per crop, so a player can see what they grow.
              Object.keys(data.farm.byCrop).length > 0
                ? h(
                    React.Fragment,
                    null,
                    h('div', { style: styles.sectionTitle }, '收成统计'),
                    h(
                      'div',
                      { style: styles.dexGrid },
                      data.crops
                        .filter((crop) => (data.farm.byCrop[crop.id] ?? 0) > 0)
                        .map((crop) =>
                          h(
                            'div',
                            { key: crop.id, style: styles.dexCard },
                            h(
                              'div',
                              { style: { ...styles.plantGlyph, color: `var(${crop.accent})` } },
                              crop.glyph,
                            ),
                            h(
                              'div',
                              { style: styles.dexBody },
                              h('div', { style: styles.achLabel }, crop.label),
                              h(
                                'div',
                                { style: styles.achDesc },
                                `已收 ${formatNumber(data.farm.byCrop[crop.id])} 份`,
                              ),
                            ),
                          ),
                        ),
                    ),
                  )
                : null,
            ),

              // ── 小卖部 ──
              /**
               * The tuck shop lives at the BOTTOM of 农场 on purpose.
               *
               * It is not a system of its own — it sells snacks that restore the
               * two resources you have to wait for, and the farm is the page you
               * open when you are waiting anyway. Putting it here means "while I
               * am in the garden, I can grab something for the road."
               */
              h(
                'div',
                { style: styles.sectionTitle },
                '小卖部',
                h('span', { style: styles.sectionHint }, '买点喝的，带出门或者下矿'),
              ),
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' } },
                (data.snacks ?? []).map((snack) =>
                  h(
                    'div',
                    {
                      key: snack.id,
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        padding: '13px 15px',
                        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
                        border: '0.5px solid var(--dsw-alias-border-l2)',
                        background: 'var(--dsw-alias-bg-layer-2)',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                      h('span', { style: { fontSize: '17px', color: `var(${snack.accent})` }, 'aria-hidden': true }, snack.glyph),
                      h('span', { style: { fontSize: '14px', fontWeight: 500 } }, snack.label),
                    ),
                    h(
                      'div',
                      { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '1.5' } },
                      snack.desc,
                    ),
                    h(
                      'div',
                      { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-quaternary)' } },
                      snack.kind === 'stamina' ? `体力 +${snack.amount}` : `物资 +${snack.amount}`,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => onBuySnack(snack.id),
                        disabled: busy || !snack.affordable || !snack.packRoom,
                        title: !snack.packRoom ? '背包满了' : !snack.affordable ? '钱不够' : '',
                        style: busy || !snack.affordable || !snack.packRoom
                          ? styles.buyButtonDisabled
                          : styles.claimButton,
                      },
                      !snack.packRoom
                        ? '背包满了'
                        : `买一个　${Object.entries(snack.cost)
                            .map(([k, v]) => `${currencySymbol(k)} ${formatNumber(v)}`)
                            .join(' ')}`,
                    ),
                  ),
                ),
              ),

        // ── mine tab ──
        tab !== 'mine'
          ? null
          : h(MinePanel, {
              data,
              state,
              busy,
              onSwing: mineSwing,
              onDescend: mineDescend,
              onCollect: mineCollect,
              onUpgrade: mineUpgrade,
              onHire: mineHire,
              onCollectMiner: mineCollectMiner,
              currencySymbol,
            }),

        // ── fishing tab ──
        tab !== 'fish'
          ? null
          : h(FishingPanel, {
              data,
              state,
              busy,
              onCast: fishCast,
              onStrike: fishStrike,
              onBuyRod: buyRod,
              onSetSpot: setSpot,
              onSwitchRod: switchRod,
              currencySymbol,
              currencySymbol,
            }),

        // ── store tab ──
        // The picker REPLACES the shop until a mode is chosen: showing a shop
        // floor you cannot operate would only invite clicking buttons that throw.
        tab !== 'store'
          ? null
          : data.shopGame.mode === null
            ? h(ShopModePicker, {
                modes: data.shopGame.modes,
                busy,
                onChoose: (mode) => {
                  chooseShopMode(mode)
                    .then((result) => showToast(`开张了：${result.label}`))
                    .catch((err) => showToast(err instanceof Error ? err.message : String(err)))
                },
              })
            : h(StorePanel, {
                data,
                state,
                busy,
                onRestock: (product, count) => restock(product, count),
                onSell: (product) => sellGoods(product),
                onBuyMachine: (machine) => buyMachine(machine),
                onCollect: (machine) => collectMachine(machine),
                onSwitchMode: (mode) => chooseShopMode(mode),
                currencySymbol,
                currencySymbol,
              }),

        // ── notice tab ──
        tab !== 'notice'
          ? null
          : h(NoticePanel, {
              data,
              state,
              updateState,
              updating,
              onMarkRead: () => {
                markNoticeRead()
                  .then(() => showToast('公告已标记为已读'))
                  .catch((err) => showToast(err instanceof Error ? err.message : String(err)))
              },
              onCheck: async () => {
                setUpdateState({ state: 'checking' })
                try {
                  const result = await checkUpdate()
                  if (result.ok !== true) {
                    setUpdateState({ state: result.reason === 'disabled' ? 'disabled' : 'error', result })
                  } else {
                    setUpdateState({ state: result.state, result })
                  }
                } catch (err) {
                  setUpdateState({
                    state: 'error',
                    result: { message: err instanceof Error ? err.message : String(err) },
                  })
                }
              },
              onApply: async () => {
                setUpdating(true)
                try {
                  const result = await applyUpdate(true)
                  if (result.updated === true) {
                    setUpdateState({ state: 'updated', result })
                    showToast('更新完成，重启 DSH 后生效')
                  } else {
                    setUpdateState({ state: 'error', result: { message: result.message ?? '没有可更新的内容。' } })
                  }
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  setUpdateState({ state: 'error', result: { message } })
                  showToast(message)
                } finally {
                  setUpdating(false)
                }
              },
            }),

        // ── about tab ──
        tab !== 'about'
          ? null
          : h(AboutPanel, { data, state }),

        // ── settings tab ──
        tab !== 'settings'
          ? null
          : h(SettingsPanel, {
              values: data.settings,
              busy,
              onSave: saveSettings,
              onReset: resetSettings,
              showToast,
              currencySymbol,
              currencyLabel,
            }),

        // ── quest tab ──
        tab !== 'quest'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '每日任务',
                h(
                  'span',
                  { style: styles.sectionHint },
                  state.dailyAllClaimed
                    ? '今天已全清'
                    : `${state.questsClaimed} / ${data.quests.length} 已领取　·　每天 0 点重置`,
                ),
              ),
              // Already-claimed quests sort last: what is left to do comes first.
              h(
                'div',
                { style: styles.questList },
                [...data.quests]
                  .sort((a, b) => Number(a.claimed) - Number(b.claimed) || Number(b.done) - Number(a.done))
                  .map((quest) =>
                    h(
                      'div',
                      {
                        key: quest.id,
                        style: quest.claimed
                          ? styles.questRowDone
                          : quest.done
                            ? styles.questRowReady
                            : styles.questRow,
                      },
                      h(
                        'div',
                        { style: styles.questMain },
                        h(
                          'div',
                          { style: styles.periodTitleRow },
                          h('span', { style: styles.periodLabel }, quest.label),
                          quest.claimed
                            ? h('span', { style: styles.questDoneChip }, '已领取')
                            : quest.done
                              ? h('span', { style: styles.questReadyChip }, '可领取')
                              : null,
                        ),
                        h('div', { style: styles.shopDesc }, quest.desc),
                        h(
                          'div',
                          { style: styles.questProgressRow },
                          h(
                            'div',
                            { style: styles.questTrack },
                            h('div', {
                              style: {
                                ...styles.questFill,
                                width: `${Math.round((quest.progress / quest.target) * 100)}%`,
                                background: quest.done
                                  ? 'var(--dsw-alias-state-success-primary)'
                                  : 'var(--dsw-alias-state-business-primary)',
                              },
                            }),
                          ),
                          h(
                            'span',
                            { style: styles.questCount },
                            `${formatNumber(quest.progress)} / ${formatNumber(quest.target)}`,
                          ),
                        ),
                        h(
                          'div',
                          { style: styles.rewardRow },
                          h('span', { style: styles.sellValueLabel }, '奖励'),
                          Object.entries(quest.reward).map(([key, value]) =>
                            h(
                              'span',
                              { key, style: { ...styles.rewardChip, color: currencyToken(key) } },
                              `${currencySymbol(key)} ${value}`,
                            ),
                          ),
                        ),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => onClaimQuest(quest),
                          disabled: busy || quest.claimed || !quest.done,
                          style:
                            busy || quest.claimed || !quest.done
                              ? styles.buyButtonDisabled
                              : styles.claimButton,
                        },
                        quest.claimed ? '已领' : quest.done ? '领取' : '进行中',
                      ),
                    ),
                  ),
              ),
            ),

        // ── alchemy tab ──
        tab !== 'alchemy'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '炼金',
                h(
                  'span',
                  { style: styles.sectionHint },
                  `已完成 ${formatNumber(state.alchemyRuns)} 次　·　现在可做 ${craftableCount} 个配方`,
                ),
              ),
              h(
                'div',
                { style: styles.codexNote },
                '把多余的物品合成更有用的东西。卖钱是一条路，炼金是另一条——重复的物品终于不只是噪音。',
              ),
              h(
                'div',
                { style: styles.recipeList },
                data.recipes.map((recipe) =>
                  h(
                    'div',
                    { key: recipe.id, style: recipe.craftable ? styles.recipeRowReady : styles.recipeRow },
                    h('div', { style: { ...styles.periodDot, background: `var(${recipe.accent})` } }),
                    h(
                      'div',
                      { style: styles.recipeMain },
                      h(
                        'div',
                        { style: styles.periodTitleRow },
                        h('span', { style: styles.periodLabel }, recipe.label),
                        recipe.made > 0
                          ? h('span', { style: styles.bestChip }, `做过 ${recipe.made} 次`)
                          : null,
                      ),
                      h('div', { style: styles.shopDesc }, recipe.desc),
                      // Inputs → output, so the trade is readable at a glance.
                      h(
                        'div',
                        { style: styles.recipeFlow },
                        Object.entries(recipe.inputs).map(([id, count]) => {
                          const row = state.pack.find((entry) => entry.item === id)
                          const have = row === undefined ? 0 : row.count
                          const enough = have >= count
                          return h(
                            'span',
                            {
                              key: id,
                              style: {
                                ...styles.recipeChip,
                                color: enough
                                  ? 'var(--dsw-alias-label-secondary)'
                                  : 'var(--dsw-alias-state-error-primary)',
                              },
                            },
                            `${itemLabel(id)} ${have}/${count}`,
                          )
                        }),
                        h('span', { style: styles.recipeArrow }, '→'),
                        Object.entries(recipe.output).map(([id, count]) =>
                          h(
                            'span',
                            { key: id, style: { ...styles.recipeChip, color: currencyToken('relic') } },
                            `${itemLabel(id)} ×${count}`,
                          ),
                        ),
                        h(
                          'span',
                          { style: styles.recipeFee },
                          `费用 ${Object.entries(recipe.fee)
                            .map(([key, value]) => `${currencySymbol(key)} ${formatNumber(value)}`)
                            .join('　')}`,
                        ),
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => onCraft(recipe),
                        disabled: busy || !recipe.craftable,
                        style:
                          busy || !recipe.craftable ? styles.buyButtonDisabled : styles.buyButton,
                        title: recipe.craftable
                          ? '开始炼金'
                          : recipe.missing.length > 0
                            ? `缺：${recipe.missing.join('，')}`
                            : '费用不足',
                      },
                      recipe.craftable ? '炼金' : '缺材料',
                    ),
                  ),
                ),
              ),
            ),

        // ── star tab (星盘 + 转生) ──
        tab !== 'star'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '星盘',
                h(
                  'span',
                  { style: styles.sectionHint },
                  `星辰 ${formatNumber(state.currencies.star)}　·　转生 ${state.rebirths} 次`,
                ),
              ),
              h(
                'div',
                { style: styles.codexNote },
                '星辰只能靠转生获得，星盘升级永远不会重置——这是每一次重来的回报。',
              ),
              h(
                'div',
                { style: styles.shopList },
                data.starShop.map((item) =>
                  h(
                    'div',
                    { key: item.id, style: styles.shopRow },
                    h('div', { style: { ...styles.periodDot, background: `var(${item.accent})` } }),
                    h(
                      'div',
                      { style: styles.shopMain },
                      h(
                        'div',
                        { style: styles.periodTitleRow },
                        h('span', { style: styles.periodLabel }, item.label),
                        h('span', { style: styles.levelChip }, `Lv.${item.level}/${item.max}`),
                      ),
                      h('div', { style: styles.shopDesc }, item.desc),
                      h(
                        'div',
                        { style: styles.upgradeTrack },
                        h('div', {
                          style: {
                            ...styles.upgradeFill,
                            width: `${Math.round((item.level / item.max) * 100)}%`,
                            background: `var(${item.accent})`,
                          },
                        }),
                      ),
                    ),
                    item.maxed
                      ? h('span', { style: styles.maxedTag }, '已满级')
                      : h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => onBuyStar(item.id),
                            disabled: busy || !item.affordable,
                            style:
                              busy || !item.affordable ? styles.buyButtonDisabled : styles.buyButton,
                            title: item.affordable ? '点亮一级' : '星辰不足',
                          },
                          `✶ ${formatNumber(item.nextCost)}`,
                        ),
                  ),
                ),
              ),

              // The rebirth block, kept visually separate because it is
              // destructive rather than additive.
              h(
                'div',
                { style: styles.sectionTitle },
                '转生',
                h(
                  'span',
                  { style: styles.sectionHint },
                  data.rebirth.eligible ? '现在可以转生' : `还差 ${data.rebirth.missing} 级`,
                ),
              ),
              h(
                'div',
                { style: data.rebirth.eligible ? styles.rebirthCardReady : styles.rebirthCard },
                h(
                  'div',
                  { style: styles.rebirthHead },
                  h('span', { style: styles.rebirthLevel }, `Lv.${state.level}`),
                  h('span', { style: styles.rebirthArrow }, '→'),
                  h(
                    'span',
                    { style: styles.rebirthStars },
                    `✶ ${data.rebirth.stars > 0 ? data.rebirth.stars : '?'}`,
                  ),
                  h(
                    'span',
                    { style: styles.sectionHint },
                    data.rebirth.eligible
                      ? `需要 ${data.rebirth.required} 级　·　达成`
                      : `需要 ${data.rebirth.required} 级`,
                  ),
                ),
                // Naming both halves explicitly is the whole point of a prestige
                // screen: the player must know what they lose before they commit.
                h(
                  'div',
                  { style: styles.rebirthSplit },
                  h(
                    'div',
                    { style: styles.rebirthColumn },
                    h('div', { style: styles.rebirthColumnTitle }, '会保留'),
                    data.rebirth.keeps.map((entry) => h('div', { key: entry, style: styles.rebirthItemKeep }, entry)),
                  ),
                  h(
                    'div',
                    { style: styles.rebirthColumn },
                    h('div', { style: styles.rebirthColumnTitle }, '会重置'),
                    data.rebirth.resets.map((entry) => h('div', { key: entry, style: styles.rebirthItemReset }, entry)),
                  ),
                ),
                data.rebirth.bestLevel > 1
                  ? h(
                      'div',
                      { style: styles.sectionHint },
                      `历史最高等级：${data.rebirth.bestLevel}`,
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: onRebirth,
                    disabled: busy || !data.rebirth.eligible,
                    style:
                      busy || !data.rebirth.eligible
                        ? styles.buyButtonDisabled
                        : rebirthArmed
                          ? styles.rebirthDangerButton
                          : styles.primaryButton,
                  },
                  !data.rebirth.eligible
                    ? `需要 ${data.rebirth.required} 级`
                    : rebirthArmed
                      ? '确认转生（不可撤销）'
                      : `转生并获得 ✶ ${data.rebirth.stars}`,
                ),
              ),
            ),

        // ── achievements tab ──
        tab !== 'ach'
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '成就',
                h('span', { style: styles.sectionHint }, `${unlockedCount} / ${achievements.length}`),
                // The view switch. Two ways to read the same table: the wall for
                // browsing everything at once, the tree for seeing what leads
                // where.
                h(
                  'div',
                  { style: styles.viewSwitch },
                  [
                    { key: 'list', label: '清单' },
                    { key: 'tree', label: '树状图' },
                  ].map((option) =>
                    h(
                      'button',
                      {
                        key: option.key,
                        type: 'button',
                        onClick: () => setAchView(option.key),
                        style: achView === option.key ? styles.viewSwitchActive : styles.viewSwitchItem,
                      },
                      option.label,
                    ),
                  ),
                ),
              ),

              achView === 'tree'
                ? h(AchievementTree, {
                    tree: data.tree,
                    achievements,
                  })
                : h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { style: styles.sectionTitle },
                      h('span', { style: { flex: 1 } }),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => setShowLocked((value) => !value),
                          style: styles.linkButton,
                        },
                        showLocked ? '只看已解锁' : '显示未解锁',
                      ),
                    ),
                    h(
                      'div',
                      { style: styles.achGrid },
                      achievements
                        .filter((entry) => showLocked || entry.unlockedAt !== null)
                        .map((entry) =>
                          h(
                            'div',
                            {
                              key: entry.id,
                              style: entry.unlockedAt === null ? styles.achCardLocked : styles.achCard,
                              title: entry.desc,
                            },
                            h(
                              'div',
                              {
                                style: {
                                  ...styles.achTier,
                                  color:
                                    entry.unlockedAt === null
                                      ? 'var(--dsw-alias-label-quaternary)'
                                      : `var(${TIER_TOKEN[entry.tier] ?? '--dsw-alias-label-primary'})`,
                                },
                              },
                              entry.unlockedAt === null ? '·' : '★',
                            ),
                            h(
                              'div',
                              { style: styles.achBody },
                              // `hideSpoilers` blanks the NAME of a locked
                              // achievement while still showing its condition, so
                              // the wall reads as a set of goals rather than a
                              // list of things you have not done.
                              h(
                                'div',
                                { style: styles.achLabel },
                                entry.unlockedAt === null && data.settings.hideSpoilers === true
                                  ? '？？？'
                                  : entry.label,
                              ),
                              h('div', { style: styles.achDesc }, entry.desc),
                            ),
                            h('span', { style: styles.achTierLabel }, TIER_LABEL[entry.tier] ?? entry.tier),
                          ),
                        ),
                      achievements.filter((entry) => showLocked || entry.unlockedAt !== null).length === 0
                        ? h('div', { style: styles.empty }, '还没有解锁任何成就，去签到吧。')
                        : null,
                    ),
                  ),
            ),

        // ── feed ──
        state.history.length > 0
          ? h(
              React.Fragment,
              null,
              h('div', { style: styles.sectionTitle }, '最近'),
              h(
                'div',
                { style: styles.feed },
                state.history.slice(0, 12).map((entry) =>
                  h(
                    'div',
                    { key: entry.id, style: styles.feedRow },
                    h('span', { style: styles.feedTime }, formatTime(entry.at)),
                    h(
                      'span',
                      { style: FEED_STYLE[entry.kind] === undefined ? styles.feedText : FEED_STYLE[entry.kind](styles) },
                      describeFeedEntry(entry, currencyLabel),
                    ),
                  ),
                ),
              ),
            )
          : null,

        h('div', { style: styles.footNote }, `存档：${state.savePath}`),
        toast === null ? null : h('div', { style: styles.toast }, toast),
        error === null ? null : h('div', { style: styles.errorBar }, error),
      )
    }

    function formatTime(at) {
      const date = new Date(at)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** Per-kind feed colours, resolved lazily so `styles` can stay below. */
    const FEED_STYLE = {
      achievement: (s) => s.feedAchievement,
      chest: (s) => s.feedChest,
      upgrade: (s) => s.feedUpgrade,
      offline: (s) => s.feedOffline,
      depart: (s) => s.feedTrip,
      return: (s) => s.feedTrip,
      sell: (s) => s.feedSell,
      use: (s) => s.feedUse,
    }

    /**
     * The author's avatar, inlined as a data URI.
     *
     * A 96px JPEG thumbnail (2.4 KB) baked into the bundle rather than loaded
     * from a file: the plugin promises no network and no build step, and an
     * inline image keeps both true — it renders instantly, offline, and travels
     * with the plugin folder. The source picture belongs to the author.
     */
    const AUTHOR_AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUEBAQEAwUEBAQGBQUGCA0ICAcHCBALDAkNExAUExIQEhIUFx0ZFBYcFhISGiMaHB4fISEhFBkkJyQgJh0gISD/2wBDAQUGBggHCA8ICA8gFRIVICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICD/wAARCABgAGADASIAAhEBAxEB/8QAHAAAAQQDAQAAAAAAAAAAAAAAAAIDBQYBBAcI/8QAOxAAAgEDAQUFBQUGBwAAAAAAAQIDAAQRBQYSEyExIkFRYZIHMlOBkRQVQlKhFkNicXKxJESCorLB4f/EABgBAAMBAQAAAAAAAAAAAAAAAAABAgQD/8QAHxEAAgIDAQADAQAAAAAAAAAAAAECEQMhMRITMkFx/9oADAMBAAIRAxEAPwD2NwIfhJ6RRwIfhJ6RTlFADfAh+EnpFHAh+EnpFE80VvA88zBI4wWZj3AU1aXtvfQCa3feXJByMFSOoIPMHyNADvAh+EnpFHAh+EnpFOUUANcCH4SekU05skcq4iVgN7BA6VtVDX+nzzXKyBhJk7oGPcHjVRSbps45ZSirgrJNIrd1DLGhUjIO6OdK4EPwk9IpNvG8UCxu++VGN7GM09UnVc2N8CH4SekUcCH4SekU5RQMKKKKAIPaRnawt7ZHK/aLmNGwPwjLH/jWh/iLKK31e1VpGEarcQr1mTHUfxju8eY7xh7ay4a0isLhUDlZmAUtugsY2xk1iG54uzETca3jlNqryO5PDiBHvHy64GedRJPp0Uo+fP6TNvqdhcael9Hdxm3b94zboB8DnoR3g8xWBq+mkEreRsB3rkj9KqdnptuLx7uCxjeeQhpNQvk3ncgYysfIJ4dx8c1JRpqU2FOsXKK+d10SNcY8Bu+PdRZFE5b6pp1225bX0Er/AJFcb3060ob73pYgrGi4Ge8nqarVwZpgbfaDTbTU0HaEkERDr5hSSfS2fCmF025tYTf6TreoXunSdsxG6aVoh38MnJIH5TzGOvdT9CcbLrmioWO0RoFlXUby4VgCrmcjI8ezikcS5tLy1hivZJOPJu8Kch+zgliD1GAP5UeivOrJ6isDpWaokKKKKAK3trEjbLXFw8TTJaFbho0951HJgPPBOKr+yVjJNp1tDcOTaWo3gG/zE2ecp/hXGEHTkD4YlvaFqEdjsfNGxPFu5Y7eJF6uxccvoOflTcEzQaJqF0CA0YMa46cgBy+ZqW/waN6YJLeWw3sRglkjHRt0E5P6Y8807cSJbxW8vMIoxy8x/wCVCieRNqtPgEqcC3R0nBIy8rx7wA/pVR9aztLc3VtsmbiyjE1xBMiqh/GQ2N35ioLomWeNrnfDBtxFlRh0ZG6/r/etW5kXSL97+1Q8OUhrqBejg/vVH5xjB/MMd+Kg9F1S0upTBaXImjtW4XPIZYpO0gIPgGH0re1O4c6dpd0TgtIbaXzyOX+5RTE4s3tSntbUxbsjMlwyiBI8kSs3QDu5+PTvqV0zS1tS1xOqvdSDtOOij8q+X9zVN0x5rzTLjSb3PH0+6Mcbg4ZUPaiceakD6Yq+afcm8063umXdMsYcgdxI51SSE2+GzWaKKokKKKKAOZe1NUii0/XLnJtNDnjupVH8T4LH+QU/U1I208X7KlpmHDFzGHPiCUbNL9oFvJdbHbRW67gZ1tlHE6MOIuQfI8x86o9xGL/2eX+hxahcaQhvXtjOMcWJI3CcieQOAO1zxmlVsLo6HbRx/cERJX7ymYXZBU5aQ9oKTj8pC1BWetLruiW8sCNE41G340L8miKTAMD/ADxyPeMVwqP2c69M+o2upX959qe4U6ZcpcmaZUEn42c5PYwRud4516PtNmGaxtDdlor9RHLPcQkDfkGC2R0IYjJHjkjFVlxfGk207HGcZNpHMdqNo9H2M2rudQgv4fu+eNluIuKm/Fg5xu5zyySB4Ar4Vdoby21fYuG4t7mK5hku4SksTh1O8eWCOXfXPNrPZ5artZqS3aPcSbTajAqTZDGFQ+WSNQRgcPkcggYzmpa/ttL2U2G19NBsINNA1KOYJbABQRKuAO7ODu5xTeOK+srKll1tUWWxkkj0jX9onlBMkyrAign3uGqfV+f+quk2VuLSwt7UHPBjVM+OBiqjo9jBa6JfWjDdjguraLdJzgosPL1Zq7VzRLCiiiqEFFFFAEPr+lnUtFv7eIAyzQ7oB6MQd5f1rkM1yb59pUgTsXMrXlqcZLowKAnzLwt9RXcLmBLq2ktpC25IN1t04JHeMiqltJsrx0bUdEt7eO/ithbrGV3VkRWBCcvnirg0ns45VJq49WytbN6oNH0+CyuIw8Ece+XVt1hyz090ggdVwOR5ZqyQbd7O3upR2gN3HPllTfjIVioyRkEg8udVHSbq5+/f2L1Wwa6tbW2Jb7UgLW46DcdQN5WDKAM568+WKkrfYyP7zjng1BJRECkTb5DQKQAewR2mIA7R6Y6Gs3hQbo1qfyNOfCC2o1641vUXOmpPaFGaFRbMGuZEwS7g/uxhcZyfe7qj9AkSLQtJt3iBF1qWUWd94cpGdd5j5Jkn51Ydo7Rtltnrq20XT0jW9cNfXiq00rAnnlicsx54UDHkKc2I2fbW447nWLFRBpd0yRQ3EeC8gTDOV6Yy3LyrviqEWzPmuUopcJzTLhdTWLT7AveRLdC4vL9UKwO4YO24x9/mAoxnz6VfKSqqqhVUBQMAAchRnnipSosVRWKzTAKKKKAMEZPWsEculKrB/wC6VAc/0aSO62p2p1ea3CpFcC2VjzDxqAu96gfpVtjiiaP7NcRrIB242I6jqOfiKp+xVpdS6bf3dyiG1vEcht7LMxdywI7sVZrAmTSIYZJGMkA4fE7wV6H5jH1qZdFFOjR2weAaBJlhGx91u8NyC488nl503eaxbbN3Tqy5F1bxG3jzgySg7m79CpJ8ATSdotLvdbWKys5Y4po4nmJf3Sxwq55Hl7x+VaO0tnELnQTcKHls5FjVgeW80LqevXpVRSdCdq/4b7SahMpa41OaSOTDGOPCKOXQEDOPnWobS3zvBWjKnIdHKlfPIOaYge7kkks9KUXE6+8pPYi/qP4eucdfKrVZaDbxIj35F7cAdpnGEz5J0A+prTNxjpGXGpt2xGz15cXcE4lmaeKF+HHM3V8e8D44PLPfU5SVREUKihVAwABgClVnNh//2Q=='

    // ── 钓鱼 ────────────────────────────────────────────────────────────────

    /**
     * 钓鱼 — the timing game.
     *
     * The whole interaction is one button whose MEANING changes with the cast's
     * state, and that is deliberate: there is nothing else to click, so the
     * player's attention goes to the float and the window rather than to a row
     * of controls.
     *
     * The countdowns tick on a local 100ms timer reading the snapshot's
     * millisecond deltas (`biteIn` / `strikeIn`), which the host recomputes on
     * every poll. The client never does clock arithmetic against `Date.now()`
     * across the wire — the host is the clock.
     */
// ── the mine ─────────────────────────────────────────────────────────────

    /**
     * 挖矿 — the one system that spends a resource you have to WAIT for.
     *
     * Every other subsystem either accrues on its own (farm, offline) or costs
     * currency. Mining costs 体力, which only comes back at one point per six
     * minutes, so this panel's job is to make the cost visible before the click:
     * the bar, the number, and the exact price on every button.
     */
    function MinePanel({
      data,
      state,
      onSwing,
      onDescend,
      onCollect,
      onUpgrade,
      onHire,
      onCollectMiner,
      busy,
      currencySymbol,
    }) {
      const mine = data.mine
      const [last, setLast] = React.useState(null)

      /**
       * A snapshot from an older host has no `mine` at all.
       *
       * The browser half is re-read from disk on every page load while the host
       * half only loads at DSH startup, so a plugin updated in place can briefly
       * run new client code against an old snapshot. Saying so beats a blank tab.
       */
      if (mine === undefined || mine === null) {
        return h(
          'div',
          { style: styles.codexNote },
          '这个版本的宿主还没有挖矿数据 —— 重启 DSH 之后就能看到。',
        )
      }

      const band = (mine.bands ?? []).find((b) => mine.depth >= b.from && mine.depth <= b.to)
      const staminaPct =
        mine.staminaCap <= 0 ? 0 : Math.round((mine.stamina / mine.staminaCap) * 100)
      const bag = Object.entries(mine.bufferedSwing ?? {})
      const noStamina = mine.stamina < 1

      /**
       * Ore ids → labels, from the shared item catalogue.
       *
       * Ores are ordinary `kind: 'sell'` items, so they are already in
       * `data.items` — this panel does not need its own copy of the ore table,
       * and reading the raw id ("iron_ore ×2") is not something to show a player.
       */
      const itemById = new Map((data.items ?? []).map((item) => [item.id, item]))
      const oreLabel = (id) => itemById.get(id)?.label ?? id

      /** Run an action and surface whatever it refuses with. */
      const run = (fn) => async () => {
        setLast(null)
        try {
          await fn()
        } catch (err) {
          setLast({ bad: true, text: err instanceof Error ? err.message : String(err) })
        }
      }

      const bar = (pct, color) =>
        h(
          'div',
          {
            style: {
              height: '8px',
              borderRadius: '999px',
              background: 'var(--dsw-alias-bg-layer-3)',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${Math.max(0, Math.min(100, pct))}%`,
              height: '100%',
              borderRadius: '999px',
              background: color,
              transition: 'width 200ms',
            },
          }),
        )

      const card = {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
      }

      const btn = (enabled, primary) => ({
        flex: 'none',
        height: '30px',
        padding: '0 14px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: enabled && !primary ? '1px solid var(--dsw-alias-border-l2)' : 'none',
        background: !enabled
          ? 'transparent'
          : primary
            ? 'var(--moyu-accent, var(--dsw-alias-brand-primary))'
            : 'transparent',
        color: !enabled
          ? 'var(--dsw-alias-label-tertiary)'
          : primary
            ? 'var(--dsw-alias-label-primary-inverted)'
            : 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '12.5px',
        cursor: enabled ? 'pointer' : 'not-allowed',
        whiteSpace: 'nowrap',
      })

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },

        // ── heading ──
        h(
          'div',
          { style: styles.sectionTitle },
          '挖矿',
          h(
            'span',
            { style: styles.sectionHint },
            `第 ${mine.depth} 层${band ? `（${band.label}）` : ''}　·　最深 ${mine.stats?.deepest ?? mine.depth} 层　·　挥镐 ${formatNumber(mine.stats?.swings ?? 0)} 次　·　出矿 ${formatNumber(mine.stats?.oresMined ?? 0)} 块`,
          ),
        ),

        h(
          'div',
          { style: styles.codexNote },
          '每挥一镐花 1 点体力，体力 6 分钟回 1 点。所以它是「想动手的时候有地方去」，不是无限刷。',
        ),

        // ── stamina ──
        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '14px', fontWeight: 500 } }, `体力 ${mine.stamina} / ${mine.staminaCap}`),
            h(
              'div',
              { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
              mine.staminaIn === null
                ? '已经满了'
                : `下一点还要 ${formatCountdown((mine.staminaIn ?? 0) * 1000)}`,
            ),
          ),
          bar(staminaPct, 'var(--dsw-alias-state-success-primary)'),
        ),

        // ── the wall ──
        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            mine.vein === null
              ? h(
                  'div',
                  { style: { flex: '1 1 220px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } },
                  '这一层的岩壁还是空的 —— 挥一镐看看能凿出什么。',
                )
              : h(
                  'div',
                  { style: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' } },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                    h(
                      'span',
                      { style: { fontSize: '17px', color: `var(${mine.vein.accent})` } },
                      mine.vein.glyph,
                    ),
                    h('span', { style: { fontSize: '14px', fontWeight: 500 } }, mine.vein.label),
                    h(
                      'span',
                      { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-quaternary)' } },
                      `${mine.vein.mined} / ${mine.vein.total} 凿`,
                    ),
                  ),
                  bar(
                    mine.vein.percent,
                    `var(${mine.vein.accent}, var(--dsw-alias-label-secondary))`,
                  ),
                ),
            h(
              'button',
              {
                type: 'button',
                onClick: run(onSwing),
                disabled: busy || noStamina,
                style: btn(!busy && !noStamina, true),
                title: noStamina ? '体力不够了' : '消耗 1 点体力',
              },
              noStamina ? '体力不够' : '挥一镐（-1 体力）',
            ),
          ),
        ),

        // ── the bag ──
        bag.length === 0 && mine.bufferedTotal === 0
          ? null
          : h(
              'div',
              { style: card },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
                h(
                  'div',
                  { style: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' } },
                  h('div', { style: { fontSize: '14px', fontWeight: 500 } }, `矿袋里有 ${mine.bufferedTotal} 块`),
                  h(
                    'div',
                    { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
                    bag.map(([id, count]) => `${oreLabel(id)} ×${count}`).join('　·　'),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: run(onCollect),
                    disabled: busy || mine.bufferedTotal === 0,
                    style: btn(!busy && mine.bufferedTotal > 0, true),
                  },
                  '收进背包',
                ),
              ),
            ),

        // ── descend ──
        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' } },
              h('div', { style: { fontSize: '14px', fontWeight: 500 } }, `下潜到第 ${mine.depth} 层`),
              h(
                'div',
                { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
                `已解锁到第 ${mine.maxDepth} 层（矿洞共 ${mine.depthMax} 层）　·　向上免费，向下每层 1 点体力　·　换层会丢掉凿到一半的矿脉`,
              ),
            ),
            h('button', {
              type: 'button',
              onClick: run(() => onDescend(mine.depth - 1)),
              disabled: busy || mine.depth <= mine.minDepth,
              style: btn(!busy && mine.depth > mine.minDepth, false),
            }, '上一层'),
            h('button', {
              type: 'button',
              onClick: run(() => onDescend(mine.depth + 1)),
              disabled: busy || mine.depth >= mine.maxDepth || mine.stamina < 1,
              style: btn(!busy && mine.depth < mine.maxDepth && mine.stamina >= 1, false),
            }, '下一层'),
            mine.maxDepth > mine.depth
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: run(() => onDescend(mine.maxDepth)),
                    disabled: busy || mine.stamina < mine.descendAllCost,
                    style: btn(!busy && mine.stamina >= mine.descendAllCost, false),
                    title: `一路下到第 ${mine.maxDepth} 层，花 ${mine.descendAllCost} 点体力`,
                  },
                  `直达第 ${mine.maxDepth} 层（-${mine.descendAllCost}）`,
                )
              : null,
          ),
        ),

        // ── upgrades ──
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h(
            'div',
            { style: { fontSize: '11px', letterSpacing: '.14em', color: 'var(--dsw-alias-label-quaternary)' } },
            '矿洞升级',
          ),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' } },
            (mine.upgradeList ?? []).map((entry) =>
              h(
                'div',
                { key: entry.id, style: { ...card, gap: '8px' } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: '13.5px', fontWeight: 500 } }, entry.label),
                  h(
                    'span',
                    { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-quaternary)' } },
                    `Lv.${entry.level} / ${entry.max}`,
                  ),
                ),
                h(
                  'div',
                  { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '1.5' } },
                  entry.desc,
                ),
                entry.maxed
                  ? h('div', { style: { ...styles.rarityChip, alignSelf: 'flex-start', color: 'var(--dsw-alias-state-success-primary)' } }, '已满级')
                  : h(
                      'button',
                      {
                        type: 'button',
                        onClick: run(() => onUpgrade(entry.id)),
                        disabled: busy || !entry.affordable,
                        style: { ...btn(!busy && entry.affordable, true), alignSelf: 'flex-start' },
                      },
                      `升级　${currencySymbol('gold')} ${formatNumber(entry.nextCost)}`,
                    ),
              ),
            ),
          ),
        ),

        // ── miners ──
        (mine.miners ?? []).length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h(
                'div',
                { style: { fontSize: '11px', letterSpacing: '.14em', color: 'var(--dsw-alias-label-quaternary)' } },
                '矿工',
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                mine.miners.map((entry) =>
                  h(
                    'div',
                    { key: entry.id, style: { ...card, gap: '8px' } },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
                      h(
                        'div',
                        { style: { flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' } },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                          h('span', { style: { fontSize: '13.5px', fontWeight: 500 } }, entry.label),
                          h(
                            'span',
                            { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-quaternary)' } },
                            `第 ${entry.depth} 层 · ${entry.perHour}/小时`,
                          ),
                          entry.active
                            ? h('span', { style: styles.questReadyChip }, '干活中')
                            : null,
                        ),
                        h(
                          'div',
                          { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '1.5' } },
                          entry.active
                            ? `攒了 ${entry.bufferedTotal} 块　·　收的时候结算工资 ${currencySymbol('gold')} ${formatNumber(entry.wagePerHour)}/小时${entry.full ? '　·　背包快满了' : ''}`
                            : entry.desc,
                        ),
                      ),
                      entry.active
                        ? h(
                            'button',
                            {
                              type: 'button',
                              onClick: run(() => onCollectMiner(entry.id)),
                              disabled: busy || entry.bufferedTotal === 0,
                              style: btn(!busy && entry.bufferedTotal > 0, true),
                            },
                            '收取并付工资',
                          )
                        : h(
                            'button',
                            {
                              type: 'button',
                              onClick: run(() => onHire(entry.id)),
                              disabled: busy || !entry.hireable,
                              style: btn(!busy && entry.hireable, true),
                            },
                            `雇他　${currencySymbol('gold')} ${formatNumber(entry.hireCost)}`,
                          ),
                    ),
                  ),
                ),
              ),
            ),

        // ── last outcome ──
        last === null
          ? null
          : h(
              'div',
              {
                style: {
                  padding: '10px 14px',
                  borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
                  fontSize: '12.5px',
                  lineHeight: '1.6',
                  background: last.bad
                    ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
                    : 'var(--dsw-alias-bg-layer-2)',
                  color: last.bad
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-label-secondary)',
                },
              },
              last.text,
            ),
      )
    }

    function FishingPanel({ data, state, onCast, onStrike, onBuyRod, onSetSpot, onSwitchRod, busy, currencySymbol }) {
      const fishing = data.fishing
      const rawCast = state.fishCast
      const [last, setLast] = React.useState(null)

      /**
       * When the current snapshot arrived.
       *
       * The cast's timing arrives as DELTAS (`biteIn` / `strikeIn`), measured from
       * the instant the host built the snapshot. Stamping the arrival here lets the
       * panel count forward on its own clock, so the bite becomes visible within
       * ~100ms instead of waiting for the next poll.
       *
       * This is not a second source of truth: the host still decides every strike
       * (early / caught / escape). What is derived locally is only what to SHOW and
       * whether pressing is worth anything.
       */
      const [syncedAt, setSyncedAt] = React.useState(() => Date.now())
      React.useEffect(() => {
        setSyncedAt(Date.now())
      }, [data])

      // A 100ms heartbeat drives the countdown; the phase below is recomputed from
      // elapsed time on every tick, never read off `cast.state`.
      const [, setTick] = React.useState(0)
      /**
       * 10Hz only while a line is actually out.
       *
       * The float animation and the shrinking window need the resolution; an idle
       * fishing tab needs none of it, and 10 renders a second of a panel that has
       * not changed is pure heat.
       */
      const castActive = rawCast !== null
      React.useEffect(() => {
        if (!castActive) return undefined
        const timer = setInterval(() => setTick((n) => n + 1), 100)
        return () => clearInterval(timer)
      }, [castActive])

      const elapsed = Math.max(0, Date.now() - syncedAt)

      /**
       * Which phase the cast is in, derived from elapsed time.
       *
       * WHY THIS EXISTS — it was a real bug, not a refinement. The panel polls
       * every 15s while the strike window is under a second, so waiting for the
       * host to report "biting" meant the window had ALWAYS closed before the
       * client heard about it. The button stayed stuck on 「等着…」, disabled, and
       * the game was unwinnable: you could cast and then never do anything.
       *
       * The deltas themselves were always correct; only the polling rate was
       * wrong. So the fix is to count locally from a trustworthy starting point.
       */
      const phase =
        rawCast === null
          ? 'idle'
          : elapsed < rawCast.biteIn
            ? 'waiting'
            : elapsed < rawCast.strikeIn
              ? 'biting'
              : 'missed'

      const cast = rawCast === null ? null : { ...rawCast, phase }

      const cooldownLeft = Math.max(0, (state.fishCooldownUntil ?? 0) - Date.now())
      const canCast = phase === 'idle' && cooldownLeft <= 0 && !busy
      /**
       * Pressing is ALWAYS allowed while a cast exists.
       *
       * In `waiting` that press is an early strike — a real risk the player takes,
       * which is the timing game. In `missed` it clears a dead line. Disabling the
       * button in either phase would strand the player with a line in the water
       * they cannot resolve, which is exactly the symptom this fix removes.
       */
      const canStrike = cast !== null && !busy

      /** Fraction of the strike window still open, for the shrinking bar. */
      const windowLeft =
        cast === null ? 0 : Math.max(0, Math.min(1, (cast.strikeIn - elapsed) / Math.max(1, state.fishWindowMs)))
      const spot = fishing.spots.find((entry) => entry.active)

      const handleCast = async () => {
        setLast(null)
        try {
          await onCast()
        } catch (err) {
          setLast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        }
      }

      const handleStrike = async () => {
        try {
          const result = await onStrike()
          if (result?.result === 'caught') setLast({ kind: 'caught', ...result })
          else if (result?.result === 'early') setLast({ kind: 'early', text: result.hint ?? '抢早了。' })
          else if (result?.result === 'escape') setLast({ kind: 'escape', text: result.hint ?? '跑了。' })
        } catch (err) {
          setLast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },

        h(
          'div',
          { style: styles.sectionTitle },
          '钓鱼',
          h(
            'span',
            { style: styles.sectionHint },
            `已钓 ${formatNumber(state.fishCaught)} 条　·　失手 ${formatNumber(state.fishEscaped)} 次　·　${state.fishKinds}/${fishing.species.length} 种`,
          ),
        ),

        h(
          'div',
          { style: styles.codexNote },
          '等它咬钩，然后在很短的时间里收杆。抢早了它会跑，慢了它也会跑——这是这个玩法唯一的要求：手要跟得上眼睛。',
        ),

        // ── the water ──
        h(
          'div',
          {
            style: {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              minHeight: '160px',
              padding: '20px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background:
                phase === 'biting'
                  ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-2))'
                  : 'var(--dsw-alias-bg-layer-2)',
              transition: 'background 120ms',
            },
          },

          h(
            'div',
            {
              style: {
                fontSize: '34px',
                lineHeight: 1,
                // A bite makes the float bob. Decorative only — the colour and
                // the text below also change, so nothing is lost when a browser
                // has motion disabled.
                animation: phase === 'biting' ? 'dsh-bob 320ms ease-in-out infinite alternate' : 'none',
              },
              'aria-hidden': true,
            },
            phase === 'idle' ? '🎣' : phase === 'biting' ? '❗' : '🌊',
          ),

          h(
            'div',
            { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } },
            phase === 'idle'
              ? cooldownLeft > 0
                ? `歇一会儿… ${formatCountdown(cooldownLeft)}`
                : `在${spot?.label ?? '水边'}下竿吧`
              : phase === 'waiting'
                ? '漂着…等它咬钩'
                : phase === 'biting'
                  ? '咬钩了！现在收杆'
                  : '错过了——点一下收杆重来',
          ),

          phase === 'biting'
            ? h(
                'div',
                {
                  style: {
                    width: 'min(320px, 80%)',
                    height: '6px',
                    borderRadius: '999px',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    overflow: 'hidden',
                  },
                },
                h('div', {
                  style: {
                    width: `${Math.round(windowLeft * 100)}%`,
                    height: '100%',
                    borderRadius: '999px',
                    background: 'var(--dsw-alias-state-error-primary)',
                    transition: 'width 100ms linear',
                  },
                }),
              )
            : null,

          h(
            'button',
            {
              type: 'button',
              // One control that means "cast" or "strike" depending on whether a
              // line is out. It is never disabled while a cast exists: pressing
              // during `waiting` is an early strike (a real risk the player
              // chooses), and pressing during `missed` clears a dead line.
              // Disabling it in those phases stranded the player with a line they
              // could not resolve — the exact bug that made fishing unwinnable.
              onClick: cast === null ? handleCast : handleStrike,
              disabled: cast === null ? !canCast : !canStrike,
              style: (canCast || canStrike) ? styles.claimButton : styles.claimButtonDisabled,
            },
            phase === 'idle'
              ? '下竿'
              : phase === 'biting'
                ? '收杆！'
                : phase === 'missed'
                  ? '收杆（错过了）'
                  : '收杆（还早）',
          ),
        ),

        // The last outcome, so a miss explains itself instead of just vanishing.
        last === null
          ? null
          : h(
              'div',
              {
                style: {
                  padding: '10px 14px',
                  borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
                  fontSize: '12.5px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  color:
                    last.kind === 'caught'
                      ? 'var(--dsw-alias-state-success-primary)'
                      : last.kind === 'error'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-label-secondary)',
                },
              },
              last.kind === 'caught'
                ? `钓到「${last.label}」！${last.stored > 0 ? '已放进背包。' : '但背包满了，只能放它走。'}`
                : last.text,
            ),

        // ── the rod ──
        h('div', { style: styles.sectionTitle }, '鱼竿'),
        h(
          'div',
          { style: styles.settingList },
          fishing.rods.map((entry) =>
            h(
              'div',
              { key: entry.id, style: entry.owned ? styles.settingRowChanged : styles.settingRow },
              h(
                'div',
                { style: styles.settingMain },
                h(
                  'div',
                  { style: styles.periodTitleRow },
                  h('span', { style: styles.periodLabel }, entry.label),
                  entry.active ? h('span', { style: styles.questReadyChip }, '在用') : null,
                ),
                h('div', { style: styles.shopDesc }, entry.desc),
                h(
                  'div',
                  { style: { ...styles.shopDesc, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '10.5px' } },
                  `窗口 +${entry.window}ms　·　幸运 +${Math.round(entry.luck * 100)}%`,
                ),
              ),
              entry.active
                ? h('span', { style: { ...styles.rarityChip, color: 'var(--dsw-alias-state-success-primary)' } }, '在用')
                : entry.owned
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () =>
                          onSwitchRod(entry.id).catch((err) =>
                            setLast({ kind: 'error', text: String(err.message ?? err) }),
                          ),
                        disabled: busy,
                        style: busy ? styles.buyButtonDisabled : styles.buyButton,
                      },
                      '切换',
                    )
                  : entry.next
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () =>
                          onBuyRod(entry.id).catch((err) =>
                            setLast({ kind: 'error', text: String(err.message ?? err) }),
                          ),
                        disabled: busy || !entry.affordable,
                        style: busy || !entry.affordable ? styles.buyButtonDisabled : styles.buyButton,
                      },
                      Object.entries(entry.cost)
                        .map(([k, v]) => `${currencySymbol(k)} ${formatNumber(v)}`)
                        .join(' '),
                    )
                  : h(
                      'span',
                      { style: { ...styles.rarityChip, color: 'var(--dsw-alias-label-quaternary)' } },
                      '还没到',
                    ),
            ),
          ),
        ),

        // ── the spots ──
        h('div', { style: styles.sectionTitle }, '钓点'),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          fishing.spots.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                onClick: () =>
                  onSetSpot(entry.id).catch((err) =>
                    setLast({ kind: 'error', text: String(err.message ?? err) }),
                  ),
                disabled: busy || !entry.unlocked || entry.active,
                title: entry.unlocked ? entry.desc : `需要 ${entry.reqRodLabel}`,
                style: entry.active
                  ? { ...styles.viewSwitchActive, cursor: 'default' }
                  : entry.unlocked
                    ? styles.viewSwitchItem
                    : { ...styles.viewSwitchItem, opacity: 0.45, cursor: 'not-allowed' },
              },
              entry.label,
              entry.unlocked ? null : h('span', { style: { fontSize: '10px', opacity: 0.7 } }, ` 🔒${entry.reqRodLabel}`),
            ),
          ),
        ),

        // ── the codex ──
        h(
          'div',
          { style: styles.sectionTitle },
          '鱼类图鉴',
          h('span', { style: styles.sectionHint }, `${state.fishKinds} / ${fishing.species.length} 种已钓到`),
        ),
        h(
          'div',
          { style: styles.achGrid },
          fishing.species.map((entry) =>
            h(
              'div',
              {
                key: entry.id,
                style: {
                  ...styles.dexCard,
                  opacity: entry.caught > 0 ? 1 : 0.45,
                  borderColor: entry.caught > 0 ? `var(${entry.accent})` : 'var(--dsw-alias-border-l1)',
                },
              },
              h('div', { style: { ...styles.dexGlyph, color: `var(${entry.accent})` } }, entry.caught > 0 ? entry.glyph : '?'),
              h(
                'div',
                { style: styles.dexBody },
                h('div', { style: styles.achLabel }, entry.caught > 0 ? entry.label : '？？？'),
                h(
                  'div',
                  { style: styles.achDesc },
                  entry.caught > 0 ? `${entry.rarityLabel}　×${entry.caught}` : entry.rarityLabel,
                ),
              ),
            ),
          ),
        ),
      )
    }

    // ── 开店 ────────────────────────────────────────────────────────────────

    /**
     * The opening question.
     *
     * Shown INSTEAD of the shop when `mode === null`, and it is a full card
     * rather than a two-button prompt because the decision is permanent: the two
     * paths buy different things, so the player needs the consequences in front
     * of them before clicking, not in a tooltip afterwards.
     */
    function ShopModePicker({ modes, busy, onChoose }) {
      const [armed, setArmed] = React.useState(null)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px' } },
        h(
          'div',
          { style: styles.sectionTitle },
          '开店',
          h('span', { style: styles.sectionHint }, '先决定你怎么经营'),
        ),
        h(
          'div',
          { style: styles.codexNote },
          '两条路线买的是不同的东西：自动化买机器，工作化靠你自己。没有时间的话，建议先选自动化。选错了也能改——之后花钻石就能换，第一次选不要钱。',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          modes.map((mode) =>
            h(
              'div',
              {
                key: mode.id,
                style: {
                  flex: '1 1 280px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  padding: '16px',
                  borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
                  border: `1px solid ${armed === mode.id ? `var(${mode.accent})` : 'var(--dsw-alias-border-l2)'}`,
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { style: { fontSize: '22px', color: `var(${mode.accent})` } }, mode.glyph),
                h('div', { style: { fontSize: '15px', fontWeight: 500 } }, mode.label),
              ),
              h('div', { style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' } }, mode.tagline),
              h(
                'ul',
                { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '5px' } },
                mode.points.map((point, i) =>
                  h(
                    'li',
                    { key: i, style: { fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' } },
                    point,
                  ),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    // Two clicks, like every other irreversible action here.
                    if (armed !== mode.id) {
                      setArmed(mode.id)
                      return
                    }
                    onChoose(mode.id)
                  },
                  disabled: busy,
                  style: busy ? styles.buyButtonDisabled : armed === mode.id ? styles.claimButton : styles.buyButton,
                },
                armed === mode.id ? '再点一次确认' : `选${mode.label}`,
              ),
            ),
          ),
        ),
      )
    }

    /**
     * 开店 — the shop floor.
     *
     * One panel, two shapes: the machine roster on the 自动化 path and the
     * counter on the 工作化 path. Both share the product list and the reputation
     * header, because those parts really are the same business.
     */
    function StorePanel({ data, state, onRestock, onSell, onBuyMachine, onCollect, onSwitchMode, busy, currencySymbol }) {
      const store = data.shopGame
      const [note, setNote] = React.useState(null)
      const automated = store.mode === 'auto'

      /**
       * A currency bundle as one line: `●300 + ◆2`.
       *
       * Local to this panel because the machine cards report a NET figure — takings
       * minus wage — which can legitimately be negative; hiding the sign would
       * misreport what collecting actually pays.
       */
      const describeBundle = (bundle) => {
        const entries = Object.entries(bundle ?? {}).filter(([, amount]) => amount !== 0)
        if (entries.length === 0) return '0'
        return entries.map(([key, amount]) => `${currencySymbol(key)}${formatNumber(amount)}`).join(' + ')
      }

      const act = (fn, success) => async () => {
        try {
          const result = await fn()
          setNote({ kind: 'ok', text: success(result) })
        } catch (err) {
          setNote({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },

        h(
          'div',
          { style: styles.sectionTitle },
          '开店',
          h(
            'span',
            { style: styles.sectionHint },
            `${store.modeLabel}　·　声望 ${formatNumber(store.reputation)}　·　已卖 ${formatNumber(store.sales)} 件`,
          ),
        ),

        // The mode is a commitment with a price, so it is stated plainly rather
        // than hidden in a settings row.
        h(
          'div',
          { style: styles.codexNote },
          automated
            ? '自动化路线：机器替你干活，你回来收就行。收的时候结算工资。'
            : '工作化路线：没有机器，每一单都要你自己接。单次收益更高，愿意花时间的话产出超过自动化。',
        ),

        // ── switching routes ──
        // Shown as its own card rather than a settings toggle: changing route is
        // a real decision with a 钻石 price, and the machines you already bought
        // are NOT refunded — the player has to see that before paying.
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '12px 14px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '13px', fontWeight: 500 } }, '换一条路线'),
            h(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-quaternary)' } },
              `换过 ${store.modeSwitches} 次　·　这次要 ${store.switchCost.diamond} 钻石`,
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
            '换路线不退机器、也不没收已经买的：机器会继续运转到你去收。声望和库存都保留。价钱每次都会涨一点。',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            store.modes.map((mode) =>
              mode.id === store.mode
                ? null
                : h(
                    'button',
                    {
                      key: mode.id,
                      type: 'button',
                      // NOTE: `act(...)` RETURNS the handler to bind — writing
                      // `onClick: () => act(...)` builds a function that returns a
                      // function and calls nothing, so the click became a no-op.
                      // Every other button in this panel uses this exact form.
                      onClick: act(
                        () => onSwitchMode(mode.id),
                        (r) => `换成「${r.label}」了，花了 ${r.paidLabel ?? '0'}。`,
                      ),
                      disabled: busy || !store.switchAffordable,
                      title: store.switchAffordable
                        ? `花 ${store.switchCost.diamond} 钻石换成${mode.label}`
                        : `需要 ${store.switchCost.diamond} 钻石`,
                      style: busy || !store.switchAffordable ? styles.buyButtonDisabled : styles.buyButton,
                    },
                    `换成${mode.label}（${store.switchCost.diamond} 钻石）`,
                  ),
            ),
          ),
          store.switchAffordable
            ? null
            : h(
                'div',
                { style: { fontSize: '11.5px', color: 'var(--dsw-alias-state-warn-primary)' } },
                `钻石不够——换路线要 ${store.switchCost.diamond} 颗。`,
              ),
        ),

        note === null
          ? null
          : h(
              'div',
              {
                style: {
                  padding: '8px 12px',
                  borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
                  fontSize: '12px',
                  border: '0.5px solid',
                  borderColor:
                    note.kind === 'bad'
                      ? 'var(--dsw-alias-state-error-primary)'
                      : 'var(--dsw-alias-state-success-primary)',
                  color: note.kind === 'bad' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
                },
              },
              note.text,
            ),

        // ── products ──
        h('div', { style: styles.sectionTitle }, '货架'),
        h(
          'div',
          { style: styles.settingList },
          store.products.map((product) =>
            h(
              'div',
              { key: product.id, style: product.unlocked ? styles.settingRow : styles.settingRowDisabled },
              h(
                'div',
                { style: { ...styles.dexGlyph, color: `var(${product.accent})`, fontSize: '20px', width: '32px' } },
                product.unlocked ? product.glyph : '🔒',
              ),
              h(
                'div',
                { style: styles.settingMain },
                h(
                  'div',
                  { style: styles.periodTitleRow },
                  h('span', { style: styles.periodLabel }, product.label),
                  h(
                    'span',
                    { style: { ...styles.rarityChip, color: 'var(--dsw-alias-label-tertiary)' } },
                    `库存 ${product.stock}`,
                  ),
                ),
                h('div', { style: styles.shopDesc }, product.desc),
                h(
                  'div',
                  { style: { ...styles.shopDesc, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '10.5px' } },
                  product.unlocked
                    ? `进 ${Object.entries(product.restockCost)
                        .map(([k, v]) => `${currencySymbol(k)}${v}`)
                        .join('+')}　卖 ${Object.entries(product.salePrice)
                        .map(([k, v]) => `${currencySymbol(k)}${v}`)
                        .join('+')}`
                    : `需要声望 ${product.unlockAt}`,
                ),
              ),
              product.unlocked
                ? h(
                    'div',
                    { style: styles.packActions },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: act(
                          () => onRestock(product.id, 5),
                          (r) => `补了 ${r.count} 份「${r.label}」，库存 ${r.stock}。`,
                        ),
                        disabled: busy,
                        style: busy ? styles.buyButtonDisabled : styles.buyButton,
                      },
                      '补 5',
                    ),
                    automated
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            onClick: act(
                              () => onSell(product.id),
                              (r) =>
                                `卖出「${r.label}」${Object.entries(r.price)
                                  .map(([k, v]) => `${currencySymbol(k)}+${v}`)
                                  .join(' ')}${r.streak > 1 ? `（连单 ${r.streak}）` : ''}`,
                            ),
                            disabled: busy || product.stock <= 0,
                            style: busy || product.stock <= 0 ? styles.buyButtonDisabled : styles.claimButton,
                          },
                          '卖一份',
                        ),
                  )
                : null,
            ),
          ),
        ),

        // ── machines, on the automated path only ──
        automated
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.sectionTitle },
                '机器',
                h(
                  'span',
                  { style: styles.sectionHint },
                  `已买 ${store.machinesBought} 台　·　整小时结算，收的时候付工资`,
                ),
              ),
              h(
                'div',
                { style: styles.settingList },
                store.machines.map((machine) =>
                  h(
                    'div',
                    { key: machine.id, style: machine.active ? styles.settingRowChanged : styles.settingRow },
                    h(
                      'div',
                      { style: styles.settingMain },
                      h(
                        'div',
                        { style: styles.periodTitleRow },
                        h('span', { style: styles.periodLabel }, machine.label),
                        machine.active
                          ? h(
                              'span',
                              { style: { ...styles.rarityChip, color: 'var(--dsw-alias-state-success-primary)' } },
                              machine.starved ? '缺货，先补货' : `卖出 ${formatNumber(machine.soldTotal)} 份`,
                            )
                          : null,
                      ),
                      h('div', { style: styles.shopDesc }, machine.desc),
                      h(
                        'div',
                        { style: { ...styles.shopDesc, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '10.5px' } },
                        `每小时卖 ${machine.perHour} 份　·　工资 ${Object.entries(machine.wagePerHour)
                          .map(([k, v]) => `${currencySymbol(k)}${v}`)
                          .join('+')}/小时`,
                      ),
                    ),
                    machine.active
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: act(
                              () => onCollect(machine.id),
                              (r) =>
                                `卖了 ${formatNumber(r.sold)} 份，净得 ${describeBundle(r.net, currencySymbol)}，工资 ${Object.entries(
                                  r.wage,
                                )
                                  .map(([k, v]) => `${currencySymbol(k)}${v}`)
                                  .join(' ')}`,
                            ),
                            disabled: busy || machine.soldTotal <= 0,
                            style: busy || machine.soldTotal <= 0 ? styles.buyButtonDisabled : styles.claimButton,
                          },
                          machine.soldTotal > 0 ? `收钱 ${describeBundle(machine.net, currencySymbol)}` : '还没卖出去',
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            onClick: act(
                              () => onBuyMachine(machine.id),
                              (r) => `买下「${r.label}」，开始运转。`,
                            ),
                            disabled: busy || !machine.affordable,
                            style: busy || !machine.affordable ? styles.buyButtonDisabled : styles.buyButton,
                          },
                          Object.entries(machine.hireCost)
                            .map(([k, v]) => `${currencySymbol(k)} ${formatNumber(v)}`)
                            .join(' '),
                        ),
                  ),
                ),
              ),
            )
          : null,

        // ── the shared record ──
        h('div', { style: styles.sectionTitle }, '经营记录'),
        h(
          'div',
          { style: { ...styles.codexStats, fontSize: '12px' } },
          `声望 ${formatNumber(store.reputation)}`,
          h('span', null, `手动 ${formatNumber(store.manualSales)} 单`),
          h('span', null, `自动 ${formatNumber(store.autoSales)} 件`),
          h('span', null, `最高连单 ${formatNumber(store.bestStreak)}`),
        ),
      )
    }

    /**
     * 公告 — release notes, plus the two update buttons.
     *
     * Three things share this page because they answer one question ("what is
     * this build, and is there a better one?"): the running version, the
     * changelog, and the update controls.
     *
     * The changelog comes from the SNAPSHOT (shipped inside the plugin), so the
     * page is never empty and never waits on the network. Only the update
     * controls reach out, and only when clicked — `updateState.state === 'idle'`
     * means "we have not asked", which is deliberately different from "there is
     * nothing new". Showing "已是最新" before anyone asked would be a lie.
     *
     * DEGRADES when the host predates this feature.
     *
     * This is not hypothetical: the browser half is re-read from disk on every
     * page load, while the host half is loaded once at DSH startup. So a plugin
     * folder that was just updated on disk serves a NEW client against an OLD
     * host until the process restarts — and then `data.notice` is simply
     * undefined. The first version of this panel did `data.notice.changelog`
     * and threw, blanking the whole tab with no message. Every field read below
     * is therefore guarded, and the missing-field case renders an explanation
     * instead of a crash.
     */
    function NoticePanel({ data, state, updateState, updating, onCheck, onApply, onMarkRead }) {
      const notice = data.notice
      const [armed, setArmed] = React.useState(false)
      /**
       * Which changelog rows are open.
       *
       * A Set rather than an array of booleans, because the "expand all" button
       * has to be able to fill it in one pass and the rows are keyed by version
       * (which survives a changelog being appended). Default: only the newest
       * entry is expanded — a version list is a reference, and opening five
       * releases' worth of bullet points on every visit buries the one the
       * player actually cares about.
       */
      const [openVersions, setOpenVersions] = React.useState(() => new Set())

      if (notice === undefined || notice === null) {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' } },
          h(
            'div',
            { style: styles.sectionTitle },
            '公告',
            h('span', { style: styles.sectionHint }, '需要重启'),
          ),
          h(
            'div',
            { style: styles.codexNote },
            '这个版本的界面比宿主新——插件文件已经更新了，但 DSH 还在跑启动时加载的那份宿主代码，所以读不到公告数据。',
          ),
          h(
            'div',
            { style: { fontSize: '12.5px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } },
            '重启 DSH 就好。存档、设置和成就都在磁盘上，重启不会丢。',
          ),
        )
      }

      const changelog = Array.isArray(notice.changelog) ? notice.changelog : []
      const running = typeof notice.version === 'string' ? notice.version : '未知'

      /** The small status line under the buttons, driven by the last answer. */
      const status = (() => {
        if (updateState.state === 'idle') return null
        if (updateState.state === 'checking') return { tone: 'idle', text: '正在检查…' }
        if (updateState.state === 'disabled') return { tone: 'warn', text: updateState.result?.message ?? '检查更新已关闭。' }
        if (updateState.state === 'error') return { tone: 'error', text: updateState.result?.message ?? '检查失败。' }
        if (updateState.state === 'newer') {
          return { tone: 'new', text: `发现新版本 v${updateState.result.latest}（当前 v${updateState.result.current}）。` }
        }
        if (updateState.state === 'current') return { tone: 'ok', text: `已经是最新的（v${updateState.result.current}）。` }
        if (updateState.state === 'ahead') {
          return { tone: 'ok', text: `本地版本 v${updateState.result.current} 比已发布的 v${updateState.result.latest} 还新。` }
        }
        if (updateState.state === 'updated') return { tone: 'ok', text: '更新完成，重启 DSH 后生效。' }
        return null
      })()

      const toneColor = (tone) =>
        tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : tone === 'new'
              ? 'var(--dsw-alias-state-business-primary)'
              : tone === 'ok'
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-tertiary)'

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' } },
        h(
          'div',
          { style: styles.sectionTitle },
          '公告',
          h('span', { style: styles.sectionHint }, `当前版本 v${running}`),
        ),

        // ── update card ──
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '14px 16px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '14px', fontWeight: 500 } }, `签到 v${running}`),
            notice.allowUpdateCheck
              ? null
              : h(
                  'span',
                  { style: { ...styles.rarityChip, color: 'var(--dsw-alias-label-tertiary)' } },
                  '联网检查已关闭',
                ),
          ),

          h(
            'div',
            { style: styles.shopDesc },
            notice.allowUpdateCheck
              ? '插件只在你点下面这两个按钮时才联网。检查更新会读取远端 manifest.json，更新会下载并校验文件。'
              : '设置 → 更新 → 允许联网检查更新，打开后才能检查。在此之前插件完全不联网。',
          ),

          status === null
            ? null
            : h('div', { style: { fontSize: '12px', color: toneColor(status.tone) } }, status.text),

          // The buttons. 更新 stays hidden unless a newer version was actually
          // found — an update button with nothing to update is just a way to
          // overwrite a working install by accident.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                onClick: onCheck,
                disabled: updating || updateState.state === 'checking',
                style: updating || updateState.state === 'checking' ? styles.buyButtonDisabled : styles.ghostButton,
              },
              updateState.state === 'checking' ? '检查中…' : '检查更新',
            ),
            updateState.state === 'newer' || armed
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: async () => {
                      if (!armed) {
                        setArmed(true)
                        return
                      }
                      setArmed(false)
                      await onApply()
                    },
                    disabled: updating,
                    style: updating ? styles.buyButtonDisabled : styles.claimButton,
                  },
                  updating
                    ? '更新中…'
                    : armed
                      ? '确认更新（会覆盖文件）'
                      : `更新到 v${updateState.result?.latest ?? '新版本'}`,
                )
              : null,
          ),

          armed
            ? h(
                'div',
                { style: { fontSize: '11.5px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: '18px' } },
                '更新会覆盖 index.js 和 client.js（旧文件会留一份 .backup 备份），需要重启 DSH 才会生效。再点一次确认。',
              )
            : null,
        ),

        // ── changelog ──
        h(
          'div',
          { style: styles.sectionTitle },
          '更新记录',
          h(
            'span',
            { style: styles.sectionHint },
            // An unread marker next to the header is the honest signal: it is
            // about what the player has SEEN, not about what exists.
            notice.unread ? '有新内容' : `共 ${changelog.length} 条`,
          ),
          // Expand / collapse all, and the one-click read marker.
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginLeft: 'auto', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  const allOpen = changelog.every((entry) => openVersions.has(entry.version))
                  setOpenVersions(allOpen ? new Set() : new Set(changelog.map((entry) => entry.version)))
                },
                style: styles.linkButton,
              },
              changelog.every((entry) => openVersions.has(entry.version)) ? '全部收起' : '全部展开',
            ),
            notice.unread
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: onMarkRead,
                    style: styles.linkButton,
                  },
                  '标记全部已读',
                )
              : h('span', { style: { ...styles.linkButton, cursor: 'default', opacity: 0.6 } }, '已全部读过'),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          changelog.map((entry, index) =>
            h(
              'div',
              {
                key: entry.version,
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '12px 14px',
                  borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  // The running version's own entry is tinted, so "what am I
                  // on" is answerable by eye without reading version numbers.
                  background: index === 0 && entry.version === running ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                },
              },
              (() => {
                // The newest entry opens by default; the rest start collapsed.
                const isOpen = openVersions.size === 0 ? index === 0 : openVersions.has(entry.version)
                return h(
                  React.Fragment,
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () =>
                        setOpenVersions((previous) => {
                          // An empty set MEANS "default state" (newest open), so
                          // the first click seeds it from that default rather
                          // than from nothing — otherwise clicking a collapsed
                          // row would open everything.
                          const current = previous.size === 0 ? new Set([changelog[0]?.version]) : new Set(previous)
                          if (current.has(entry.version)) current.delete(entry.version)
                          else current.add(entry.version)
                          return current
                        }),
                      'aria-expanded': isOpen,
                      style: {
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: '8px',
                        flexWrap: 'wrap',
                        width: '100%',
                        padding: 0,
                        border: 'none',
                        background: 'transparent',
                        color: 'inherit',
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        cursor: 'pointer',
                      },
                    },
                    h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-quaternary)', flex: 'none' } }, isOpen ? '▾' : '▸'),
                    h('span', { style: { fontSize: '13px', fontWeight: 500 } }, `v${entry.version}`),
                    h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, entry.title),
                    entry.version === running ? h('span', { style: styles.questReadyChip }, '当前版本') : null,
                    h(
                      'span',
                      { style: { marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-quaternary)' } },
                      `${entry.notes.length} 条　${entry.date}`,
                    ),
                  ),
                  isOpen
                    ? h(
                        'ul',
                        { style: { margin: '6px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' } },
                        entry.notes.map((note, i) =>
                          h(
                            'li',
                            {
                              key: i,
                              style: { fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
                            },
                            note,
                          ),
                        ),
                      )
                    : null,
                )
              })(),
            ),
          ),
        ),

        h(
          'div',
          { style: styles.footNote },
          `更新源：${notice.endpoint}`,
        ),
      )
    }

    /**
     * The author's home page.
     *
     * The only outbound link in the plugin. Kept as one constant so the byline
     * button and the footer button cannot drift to two different URLs, and so a
     * fork has exactly one string to change.
     */
    const AUTHOR_HOME = 'https://space.bilibili.com/3546957540755997'

    /**
     * The repository, and the one place a fork has to change it.
     *
     * Same reasoning as `AUTHOR_HOME`: the 关于页的 Star 按钮 and any install
     * hint must not drift to two different URLs.
     */
    const REPO_URL = 'https://github.com/yizhiyangyangqwq/dsh-moyu'

    /**
     * 关于 — the one page that is pure talk.
     *
     * It shows the author, why the plugin exists, and (in a small print) how
     * long it has been keeping the player company. Every number is read
     * straight from the snapshot — this page computes nothing, so there is no
     * second source of truth for its own sentimentality.
     */
    function AboutPanel({ data, state }) {
      const pad = (n) => String(n).padStart(2, '0')
      const born = new Date(state.bornAt)
      const bornText = Number.isFinite(born.getTime()) && state.bornAt > 0
        ? `${born.getFullYear()}-${pad(born.getMonth() + 1)}-${pad(born.getDate())}`
        : '今天'
      const unlockedAch = data.achievements.filter((a) => a.unlockedAt !== null).length

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' } },
        h(
          'div',
          { style: styles.sectionTitle },
          '关于',
          h('span', { style: styles.sectionHint }, '为什么会有这个东西'),
        ),

        // The byline leads: it is the answer to "who made this", and the rest
        // of the page is the answer to "why".
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '14px 16px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
            },
          },
          h('img', {
            src: AUTHOR_AVATAR,
            alt: '一只杨洋qwq 的头像',
            // The circle is the shape; objectFit keeps the square crop centred
            // instead of stretching it. The thin ring separates a white-background
            // avatar from the card behind it.
            style: {
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              objectFit: 'cover',
              flex: 'none',
              border: '1px solid var(--dsw-alias-border-l3)',
            },
          }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
            h(
              'div',
              { style: { fontSize: '14px', fontWeight: 500 } },
              'Made by 一只杨洋qwq',
            ),
            h(
              'div',
              { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
              '签到 — DSH 摸鱼养成插件',
            ),
          ),
          // The author's page, linked from the byline itself: the name is what a
          // reader wants to click after reading "Made by".
          h(
            'a',
            {
              href: AUTHOR_HOME,
              target: '_blank',
              // noreferrer as well as noopener: this is the one outbound link in
              // the plugin, and the target page has no business knowing where it
              // was clicked from.
              rel: 'noopener noreferrer',
              style: styles.outboundLinkCompact,
              title: AUTHOR_HOME,
            },
            h('span', { 'aria-hidden': true }, '▸'),
            'B 站主页',
          ),
        ),

        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '16px 18px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
            },
          },
          ABOUT_PROSE.map((paragraph, index) =>
            h(
              'p',
              {
                key: index,
                style: {
                  margin: 0,
                  fontSize: '13px',
                  lineHeight: '21px',
                  color:
                    index === ABOUT_PROSE.length - 1
                      ? 'var(--dsw-alias-label-secondary)'
                      : 'var(--dsw-alias-label-primary)',
                },
              },
              paragraph,
            ),
          ),
        ),

        // The call to action, below the essay rather than on top of it: the text
        // asks to be read first, and a link above it would turn a personal note
        // into a shill.
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h(
            'a',
            {
              href: AUTHOR_HOME,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: styles.outboundLinkPrimary,
              title: AUTHOR_HOME,
            },
            '去 B 站看看作者',
          ),
          h(
            'span',
            { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-quaternary)' } },
            '点开会新开一个标签页，插件本身对外只连这一个地址。',
          ),
        ),

        // Small print: the company it keeps, from the snapshot alone.
        h(
          'div',
          {
            style: {
              fontSize: '11.5px',
              lineHeight: '18px',
              color: 'var(--dsw-alias-label-tertiary)',
              padding: '0 2px',
            },
          },
          `从 ${bornText} 开始：签到 ${formatNumber(state.total)} 次　·　开箱 ${formatNumber(state.chestsOpened)} 个　·　背包里 ${formatNumber(state.packUsed)} 件东西　·　解锁 ${unlockedAch} / ${data.achievements.length} 个成就`,
          h(
            'div',
            { style: { marginTop: '4px', color: 'var(--dsw-alias-label-quaternary)' } },
            // Kept honest now that 公告 can download updates: the promise is
            // "never on its own", not "never". Saying the stronger thing would
            // be a lie the moment someone pressed 检查更新.
            '所有进度都存在你自己机器的本地文件里，不上传。插件不会自己联网——只有你在「公告」里点检查和更新时才会。',
          ),
        ),

        // ── 点个 Star ──
        //
        // Last thing on the page, deliberately: someone who has read this far has
        // seen the whole thing and knows what it is, which is exactly when a
        // request like this is reasonable rather than pushy.
        //
        // An anchor, not a button with a click handler: it is a real link, so
        // middle-click and "open in new tab" work, and the address is visible on
        // hover. The reason is stated next to it instead of being assumed.
        h(
          'a',
          {
            href: REPO_URL,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '14px 16px',
              borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              textDecoration: 'none',
              color: 'inherit',
            },
            title: REPO_URL,
          },
          h(
            'span',
            {
              style: {
                flex: 'none',
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: 'var(--dsw-alias-bg-base)',
                border: '1px solid var(--dsw-alias-border-l2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              },
              'aria-hidden': true,
            },
            '★',
          ),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
            h('span', { style: { fontSize: '13.5px', fontWeight: 500 } }, '去 GitHub 点个 Star'),
            h(
              'span',
              { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
              '这就是我做下去的理由',
            ),
          ),
          h(
            'span',
            { style: { ...styles.outboundLinkCompact, flex: 'none' }, 'aria-hidden': true },
            '↗',
          ),
        ),
      )
    }

    /**
     * One history row as text.
     *
     * The host writes nine kinds of entry. Rendering only some of them (as an
     * earlier cut did) silently swallowed every shop, chest and expedition event,
     * which made the feed lie by omission — so each kind gets a branch, and the
     * default covers a claim.
     */
    function describeFeedEntry(entry, currencyLabel) {
      const granted = Object.entries(entry.granted ?? {})
        .map(([key, value]) => `${currencyLabel(key)} +${value}`)
        .join('　')
      switch (entry.kind) {
        case 'achievement':
          return `解锁成就「${entry.label}」`
        case 'chest':
          return `打开${entry.label}　${granted}`
        case 'upgrade':
          return `升级「${entry.label}」到 Lv.${entry.level}`
        case 'offline':
          return `领取离线收益　${granted}`
        case 'depart':
          return `出发去${entry.label}（用掉 ${entry.spent} 物资）`
        case 'return': {
          const names = (entry.found ?? []).length
          const left = (entry.leftBehind ?? []).length
          if (names === 0) return `从${entry.label}空手而归${left > 0 ? '（背包满了）' : ''}`
          return `从${entry.label}带回 ${names} 件东西${left > 0 ? `，落下 ${left} 件` : ''}`
        }
        case 'sell':
          return `卖出「${entry.label}」×${entry.count}　${granted}`
        case 'use':
          return `使用「${entry.label}」`
        default: {
          const lucky =
            entry.lucky === null || entry.lucky === undefined ? '' : `　✦ ${entry.lucky.label}`
          return `${entry.label}签到　${granted}${lucky}`
        }
      }
    }

    // ── styles ───────────────────────────────────────────────────────────────

    const styles = {
      page: {
        boxSizing: 'border-box',
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '0 clamp(16px, 4vw, 40px) 48px',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
      },
      head: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '16px',
        paddingTop: '28px',
      },
      title: { margin: 0, fontSize: '20px', fontWeight: 500, lineHeight: '28px' },
      intro: {
        margin: '4px 0 0',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      headActions: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' },
      ghostButton: {
        height: '32px',
        padding: '0 12px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      /**
       * A compact anchor that looks like a ghost button.
       *
       * `a` elements need the button look spelled out (they do not inherit
       * button defaults), and `textDecoration: none` plus `inline-flex` is what
       * stops a link from rendering as underlined body text inside the byline.
       *
       * Named `outboundLink*` rather than `linkButton`, which already exists
       * further down as an inline text-button for the achievements header —
       * two different looks must not share one key.
       */
      outboundLinkCompact: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        flex: 'none',
        height: '28px',
        padding: '0 10px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '12px',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      /** The primary call-to-action: filled, because it is the page's one action. */
      outboundLinkPrimary: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '32px',
        padding: '0 16px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--moyu-accent, var(--dsw-alias-brand-primary))',
        color: 'var(--dsw-alias-label-primary-inverted)',
        fontFamily: 'inherit',
        fontSize: '13px',
        fontWeight: 500,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      primaryButton: {
        height: '32px',
        padding: '0 14px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--moyu-accent, var(--dsw-alias-brand-primary))',
        color: 'var(--dsw-alias-label-primary-inverted)',
        fontFamily: 'inherit',
        fontSize: '13px',
        fontWeight: 500,
        cursor: 'pointer',
      },
      primaryButtonDisabled: {
        height: '32px',
        padding: '0 14px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-quaternary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        cursor: 'default',
      },
      card: {
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        background: 'var(--dsw-alias-settings-card-fill)',
        padding: '12px 16px',
      },
      levelRow: { display: 'flex', alignItems: 'center', gap: '12px' },
      levelBadge: {
        flex: 'none',
        minWidth: '52px',
        fontSize: '14px',
        fontWeight: 600,
        color: 'var(--dsw-alias-state-business-primary)',
      },
      levelTrack: {
        flex: 1,
        height: '8px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      levelFill: {
        height: '100%',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-business-primary)',
        transition: 'width .3s ease',
      },
      levelText: {
        flex: 'none',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      currencyGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '10px',
      },
      currencyCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        background: 'var(--dsw-alias-settings-card-fill)',
        padding: '10px 12px',
      },
      currencySymbol: { fontSize: '18px', lineHeight: '20px', flex: 'none' },
      currencyBody: { minWidth: 0, display: 'flex', flexDirection: 'column' },
      currencyLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      currencyValue: {
        fontSize: '16px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: '22px',
      },
      currencyEarned: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' },
      sectionTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '6px',
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
      },
      sectionHint: { fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-quaternary)' },
      linkButton: {
        marginLeft: 'auto',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-link)',
        fontFamily: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
        padding: 0,
      },
      periodList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      periodRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      periodRowReady: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      periodDot: { width: '8px', height: '8px', borderRadius: '999px', flex: 'none' },
      periodMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
      periodTitleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      periodLabel: { fontSize: '13px', fontWeight: 500 },
      streakChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-warn-tertiary)',
        color: 'var(--dsw-alias-state-warn-label)',
      },
      bestChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      rewardRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      rewardChip: { fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
      rewardTotal: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' },
      claimButton: {
        flex: 'none',
        height: '28px',
        padding: '0 14px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--moyu-accent, var(--dsw-alias-brand-primary))',
        color: 'var(--dsw-alias-label-primary-inverted)',
        fontFamily: 'inherit',
        fontSize: '12px',
        fontWeight: 500,
        cursor: 'pointer',
      },
      claimButtonDisabled: {
        flex: 'none',
        height: '28px',
        padding: '0 14px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-quaternary)',
        fontFamily: 'inherit',
        fontSize: '12px',
        cursor: 'default',
      },
      countdown: {
        flex: 'none',
        minWidth: '56px',
        textAlign: 'right',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      achGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(var(--moyu-card-min, 230px), 1fr))',
        gap: '8px',
      },
      /**
       * Achievement cards opt out of rendering while off-screen.
       *
       * `contentVisibility: 'auto'` lets the browser skip layout, paint and hit
       * testing for cards outside the viewport — the wall is 200+ of them, and
       * scrolling it was the reported slowdown. `containIntrinsicSize` supplies
       * the placeholder height so the scrollbar does not jump as they come in.
       */
      achCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 38px',
      },
      achCardLocked: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        opacity: 0.62,
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 38px',
      },
      achTier: { fontSize: '14px', flex: 'none', width: '16px', textAlign: 'center' },
      achBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      achLabel: { fontSize: '12px', fontWeight: 500 },
      achDesc: {
        fontSize: '10px',
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      achTierLabel: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)', flex: 'none' },
      feed: { display: 'flex', flexDirection: 'column', gap: '4px' },
      feedRow: { display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: '11.5px' },
      feedTime: {
        flex: 'none',
        color: 'var(--dsw-alias-label-quaternary)',
        fontVariantNumeric: 'tabular-nums',
      },
      feedText: { color: 'var(--dsw-alias-label-secondary)' },
      feedAchievement: { color: 'var(--dsw-alias-state-warn-primary)' },
      feedChest: { color: 'var(--dsw-alias-link)' },
      feedUpgrade: { color: 'var(--dsw-alias-state-business-primary)' },
      feedOffline: { color: 'var(--dsw-alias-state-success-primary)' },
      feedTrip: { color: 'var(--dsw-alias-label-secondary)' },
      feedSell: { color: 'var(--dsw-alias-state-warn-primary)' },
      feedUse: { color: 'var(--dsw-alias-state-success-primary)' },
      empty: {
        padding: '24px 0',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      footNote: { marginTop: '8px', fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' },

      // ── tabs ──
      tabBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        background: 'var(--dsw-alias-bg-layer-2)',
        alignSelf: 'flex-start',
        /**
         * Wrap instead of crushing.
         *
         * 15 tabs do not fit a narrow panel, and without wrapping the bar stayed a
         * single row that squeezed every button until its label broke into one
         * character per line ("签/到"). Wrapping lets the bar grow to two or three
         * rows and keeps every label horizontal and readable.
         */
        flexWrap: 'wrap',
        /**
         * Never wider than the panel.
         *
         * `alignSelf: flex-start` sizes the bar to its content, so a long row of
         * tabs could overflow the panel and get clipped. `maxWidth` caps it at the
         * parent's width, and wrapping then does the rest.
         */
        maxWidth: '100%',
      },
      tab: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '28px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '12.5px',
        cursor: 'pointer',
        /**
         * A tab never shrinks and its label never breaks.
         *
         * These two lines are the actual fix for the one-character-per-line
         * symptom: a flex item shrinks by default, and Chinese text has a line
         * break opportunity between every pair of characters, so a squeezed
         * button turns 签到 into a vertical 签 / 到.
         */
        flexShrink: 0,
        whiteSpace: 'nowrap',
      },
      tabActive: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '28px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '12.5px',
        fontWeight: 500,
        cursor: 'pointer',
        boxShadow: 'var(--dsw-elevation-soft)',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      },
      tabBadge: {
        minWidth: '15px',
        height: '15px',
        padding: '0 4px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-label-primary-inverted)',
        fontSize: '9px',
        lineHeight: '15px',
        fontWeight: 600,
        textAlign: 'center',
      },

      // ── offline card ──
      offlineCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-state-success-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)',
      },
      offlineBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      offlineTitle: { fontSize: '12.5px', fontWeight: 600 },
      offlineDetail: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },

      // ── modifiers row ──
      modRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        flexWrap: 'wrap',
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
      },

      // ── shop ──
      shopList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      shopRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      shopMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      shopDesc: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      levelChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      upgradeTrack: {
        height: '4px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      upgradeFill: { height: '100%', borderRadius: '999px', transition: 'width .3s ease' },
      buyButton: {
        flex: 'none',
        minWidth: '72px',
        height: '28px',
        padding: '0 12px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--moyu-accent, var(--dsw-alias-brand-primary))',
        color: 'var(--dsw-alias-label-primary-inverted)',
        fontFamily: 'inherit',
        fontSize: '12px',
        fontWeight: 500,
        cursor: 'pointer',
        fontVariantNumeric: 'tabular-nums',
      },
      buyButtonDisabled: {
        flex: 'none',
        minWidth: '72px',
        height: '28px',
        padding: '0 12px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-quaternary)',
        fontFamily: 'inherit',
        fontSize: '12px',
        cursor: 'default',
        fontVariantNumeric: 'tabular-nums',
      },
      maxedTag: {
        flex: 'none',
        fontSize: '11px',
        color: 'var(--dsw-alias-state-success-primary)',
        fontWeight: 500,
      },
      yieldChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-label-primary-inverted)',
      },

      // ── chests ──
      chestGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: '10px',
      },
      chestCard: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        padding: '16px 12px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        textAlign: 'center',
      },
      chestLabel: { fontSize: '13px', fontWeight: 600 },
      chestDesc: { fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary)', minHeight: '28px' },
      chestCost: {
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      chestCount: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' },

      // ── supplies & buffs ──
      supplyRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      },
      supplyLabel: { flex: 'none', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
      supplyTrack: {
        flex: 1,
        height: '6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      supplyFill: {
        height: '100%',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-success-primary)',
        transition: 'width .3s ease',
      },
      supplyText: {
        flex: 'none',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      buffRow: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      buffChip: {
        fontSize: '11px',
        padding: '3px 9px',
        borderRadius: '999px',
        border: '0.5px solid var(--dsw-alias-link)',
        background: 'color-mix(in srgb, var(--dsw-alias-link) 10%, transparent)',
        color: 'var(--dsw-alias-link)',
        fontVariantNumeric: 'tabular-nums',
      },

      // ── trip ──
      tripCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      tripCardReady: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-state-success-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      tripBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
      tripTitle: { fontSize: '13.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      tripDetail: {
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      // ── camp (mid-trip actions) ──
      campGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '8px',
      },
      campAction: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      campActionDisabled: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-quaternary)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'default',
        opacity: 0.65,
      },
      campDanger: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      campGlyph: { fontSize: '18px', lineHeight: '20px', flex: 'none' },
      campBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
      campLabel: { fontSize: '12.5px', fontWeight: 600 },
      campDesc: { fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary)' },
      destList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      destRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      destMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },

      // ── backpack ──
      packList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      packRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      packGlyph: { fontSize: '18px', lineHeight: '20px', flex: 'none', width: '20px', textAlign: 'center' },
      packMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
      packActions: { display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' },
      rarityChip: { fontSize: '10px', padding: '1px 6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-3)' },
      sellValueRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      sellValueLabel: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' },

      // ── collection ──
      dexGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: '8px',
      },
      dexCard: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      dexCardLocked: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        opacity: 0.6,
      },
      dexBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },

      // ── settings ──
      settingList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      settingRowChanged: {
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      settingMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      settingControl: { display: 'flex', alignItems: 'center', gap: '10px', flex: 'none', width: '190px' },
      slider: { flex: 1, minWidth: 0, accentColor: 'var(--moyu-accent, var(--dsw-alias-brand-primary))', cursor: 'pointer' },
      settingValue: {
        flex: 'none',
        minWidth: '46px',
        textAlign: 'right',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      toggleOn: {
        flex: 'none',
        width: '42px',
        height: '24px',
        padding: '2px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        borderRadius: '999px',
        border: 'none',
        background: 'var(--dsw-alias-state-success-primary)',
        cursor: 'pointer',
      },
      toggleOff: {
        flex: 'none',
        width: '42px',
        height: '24px',
        padding: '2px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        borderRadius: '999px',
        border: 'none',
        background: 'var(--dsw-alias-bg-layer-3)',
        cursor: 'pointer',
      },
      toggleKnob: {
        width: '20px',
        height: '20px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-label-primary-inverted)',
        transition: 'all .15s ease',
      },
      toggleKnobOn: {
        width: '20px',
        height: '20px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-label-primary-inverted)',
        transition: 'all .15s ease',
      },

      // ── farm ──
      plotGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: '10px',
      },
      plot: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-settings-card-fill)',
        minHeight: '132px',
      },
      plotReady: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-state-success-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent)',
        minHeight: '132px',
      },
      plotEmpty: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px dashed var(--dsw-alias-border-l2)',
        background: 'transparent',
        minHeight: '132px',
      },
      plotHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
      plotIndex: {
        fontSize: '10px',
        color: 'var(--dsw-alias-label-quaternary)',
        fontVariantNumeric: 'tabular-nums',
      },
      plantGlyph: { fontSize: '16px', lineHeight: '18px' },
      plotCropName: { fontSize: '12.5px', fontWeight: 500 },
      plotTrack: {
        height: '6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      plotFill: { height: '100%', borderRadius: '999px', transition: 'width .4s ease' },
      plotMeta: {
        fontSize: '10.5px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      plotActions: { display: 'flex', gap: '6px', marginTop: 'auto' },
      ailmentRow: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      ailmentChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      wateredChip: { fontSize: '10px', color: 'var(--dsw-alias-link)' },
      plantButton: {
        marginTop: 'auto',
        height: '26px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '11.5px',
        cursor: 'pointer',
      },
      // The seed picker replaces the plot body, so it scrolls internally rather
      // than stretching every tile to the height of the crop list.
      seedList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        maxHeight: '190px',
        overflowY: 'auto',
      },
      seedRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: '4px 6px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      seedRowDisabled: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: '4px 6px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-quaternary)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'default',
        opacity: 0.6,
      },
      seedBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      seedLabel: { fontSize: '11.5px' },
      seedMeta: { fontSize: '9.5px', color: 'var(--dsw-alias-label-quaternary)' },
      seedCost: {
        fontSize: '10.5px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        flex: 'none',
      },
      seedCancel: {
        marginTop: '3px',
        height: '20px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-quaternary)',
        fontFamily: 'inherit',
        fontSize: '10.5px',
        cursor: 'pointer',
      },

      // ── daily quests ──
      questList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      questRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      questRowReady: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-state-success-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)',
      },
      questRowDone: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        opacity: 0.55,
      },
      questMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      questProgressRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      questTrack: {
        flex: 1,
        height: '5px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      questFill: { height: '100%', borderRadius: '999px', transition: 'width .3s ease' },
      questCount: {
        flex: 'none',
        fontSize: '10.5px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      questDoneChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-quaternary)',
      },
      questReadyChip: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-label-primary-inverted)',
      },

      // ── alchemy ──
      recipeList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      recipeRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      recipeRowReady: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      recipeMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      recipeFlow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      recipeChip: { fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
      recipeArrow: { fontSize: '11px', color: 'var(--dsw-alias-label-quaternary)' },
      recipeFee: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)', fontVariantNumeric: 'tabular-nums' },

      // ── rebirth ──
      rebirthCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      rebirthCardReady: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--moyu-accent, var(--dsw-alias-brand-primary))',
        background: 'color-mix(in srgb, var(--moyu-accent, var(--dsw-alias-brand-primary)) 6%, transparent)',
      },
      rebirthHead: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      rebirthLevel: { fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      rebirthArrow: { fontSize: '13px', color: 'var(--dsw-alias-label-quaternary)' },
      rebirthStars: {
        fontSize: '16px',
        fontWeight: 600,
        color: 'var(--dsw-alias-state-warn-primary)',
        fontVariantNumeric: 'tabular-nums',
      },
      rebirthSplit: { display: 'flex', gap: '20px', flexWrap: 'wrap' },
      rebirthColumn: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '130px' },
      rebirthColumnTitle: { fontSize: '10.5px', color: 'var(--dsw-alias-label-quaternary)', marginBottom: '3px' },
      rebirthItemKeep: { fontSize: '11.5px', color: 'var(--dsw-alias-state-success-primary)' },
      rebirthItemReset: { fontSize: '11.5px', color: 'var(--dsw-alias-state-error-primary)' },
      rebirthDangerButton: {
        alignSelf: 'flex-start',
        height: '32px',
        padding: '0 16px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: 'none',
        background: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-label-primary-inverted)',
        fontFamily: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      },

      // ── view switch (shared by 成就 and 图鉴) ──
      viewSwitch: {
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        marginLeft: 'auto',
        padding: '2px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        background: 'var(--dsw-alias-bg-layer-2)',
        flex: 'none',
      },
      viewSwitchItem: {
        height: '22px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
      },
      viewSwitchActive: {
        height: '22px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '11px',
        fontWeight: 500,
        cursor: 'pointer',
        boxShadow: 'var(--dsw-elevation-soft)',
      },

      // ── advancement tree ──
      branchRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        marginBottom: '8px',
      },
      branchChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '24px',
        padding: '0 9px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '999px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
      },
      branchDot: { width: '7px', height: '7px', borderRadius: '999px', flex: 'none' },
      branchCount: {
        fontSize: '10px',
        color: 'var(--dsw-alias-label-quaternary)',
        fontVariantNumeric: 'tabular-nums',
      },
      zoomGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        marginLeft: 'auto',
        padding: '2px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      zoomButton: {
        width: '22px',
        height: '22px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1,
        cursor: 'pointer',
      },
      zoomValue: {
        minWidth: '34px',
        textAlign: 'center',
        fontSize: '10.5px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      treeViewport: {
        position: 'relative',
        /**
         * `flexShrink: 0` is load-bearing, and its absence was a real bug.
         *
         * The page is a flex COLUMN and a flex child shrinks by default. With a
         * fixed 460px height, a short window made the flex algorithm compress this
         * element — eventually to nothing — so the whole tree disappeared with no
         * error at all. A fixed-height child of a flex column must opt out.
         */
        flexShrink: 0,
        /**
         * Height follows the window, so a short window shows a *smaller but
         * visible* canvas and the panel scrolls, rather than collapsing it.
         */
        height: 'clamp(260px, 52vh, 460px)',
        minHeight: '220px',
        overflow: 'hidden',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        // A faint dot grid, like the advancement screen's paper. Declared as
        // `backgroundImage` + `backgroundColor` (never the `background`
        // shorthand, which would wipe the image) and over a solid layer colour,
        // because `--dsw-alias-bg-overlay` is an OPAQUE grey meant for scrims.
        backgroundColor: 'var(--dsw-alias-bg-layer-2)',
        backgroundImage: 'radial-gradient(var(--dsw-alias-border-l1) 1px, transparent 1px)',
        backgroundSize: '18px 18px',
        userSelect: 'none',
        touchAction: 'none',
      },
      treeCard: {
        position: 'absolute',
        right: '10px',
        bottom: '10px',
        width: 'min(260px, 60%)',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '10px 12px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        // A solid layer, not the overlay token: the hover card floats over the
        // canvas and must be readable, not translucent.
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        // The card must not swallow drags meant for the canvas behind it.
        pointerEvents: 'none',
      },
      treeCardHead: { display: 'flex', alignItems: 'center', gap: '6px' },
      treeCardMark: { fontSize: '13px', flex: 'none' },
      treeCardTitle: { flex: 1, fontSize: '12.5px', fontWeight: 600 },
      treeCardTier: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)', flex: 'none' },
      treeCardDesc: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      treeCardStatus: { fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' },
      treeHint: { marginTop: '6px', fontSize: '10.5px', color: 'var(--dsw-alias-label-quaternary)' },

      // ── route codex ──
      codexNote: {
        fontSize: '11.5px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        marginBottom: '8px',
      },
      codexList: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' },
      codexRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      codexRank: {
        flex: 'none',
        width: '18px',
        textAlign: 'center',
        fontSize: '12px',
        color: 'var(--dsw-alias-state-warn-primary)',
        paddingTop: '2px',
      },
      codexMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' },
      codexTrack: {
        height: '7px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
      },
      codexFill: { height: '100%', borderRadius: '999px', transition: 'width .3s ease' },
      codexStats: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        fontSize: '10.5px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      tierStrip: {
        display: 'flex',
        height: '4px',
        borderRadius: '999px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-3)',
      },
      toast: {
        position: 'fixed',
        left: '50%',
        bottom: '48px',
        transform: 'translateX(-50%)',
        maxWidth: 'min(520px, 80vw)',
        padding: '8px 14px',
        borderRadius: 'var(--moyu-radius-lg, var(--dsw-radius-lg))',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        fontSize: '12.5px',
        zIndex: 60,
      },
      errorBar: {
        padding: '8px 12px',
        borderRadius: 'var(--moyu-radius-md, var(--dsw-radius-md))',
        border: '0.5px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: '12px',
      },
    }

    // ── registration ─────────────────────────────────────────────────────────

    return {
      name: PANEL_ID,
      inject: ['slots', 'layout'],
      apply(ctx) {
        /**
         * The one piece of global CSS this plugin needs.
         *
         * `dsh-bob` is referenced by the fishing panel's float animation, and
         * inline styles cannot declare keyframes — so it is injected once here.
         * Without it the float simply does not move, which is a silent failure:
         * the animation property is valid and nothing gets reported.
         *
         * Guarded by id so a hot reload cannot stack duplicate <style> tags.
         */
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          try {
            const existing = typeof document.getElementById === 'function' ? document.getElementById('dsh-moyu-keyframes') : null
            if (existing === null) {
              const style = document.createElement('style')
              style.id = 'dsh-moyu-keyframes'
              style.textContent = '@keyframes dsh-bob{from{transform:translateY(0)}to{transform:translateY(-5px)}}'
              document.head?.appendChild(style)
            }
          } catch {
            // Purely decorative: the float simply will not bob. Never let a
            // missing <style> stop the panel from mounting.
          }
        }

        // ── the panel-list row, toggled by settings ──
        //
        // The badge can just return `null` — the shell renders whatever the
        // component gives it. The panel row is different: the shell builds its
        // list from the slot ENTRIES (`entriesOfSlot`), not from what the icon
        // component renders, so a null component would leave a blank, clickable
        // row. Hiding it means REMOVING the injection, which is exactly what the
        // disposer returned by `slots.inject` is for.
        //
        // The badge's poller drives this via `syncPanelEntry`, and it starts
        // SHOWN: the default is on, and the first poll (immediate on mount)
        // corrects it if the saved setting says otherwise.
        /**
         * The 设置 row, toggled by `showSettingsRow`.
         *
         * Same mechanism as the panel row and for the same reason: DSH builds the
         * General section from slot ENTRIES, so hiding this means removing the
         * injection, not returning null from the component.
         */
        let stopSettingsRow = null
        const syncSettingsRow = (visible) => {
          if (visible && stopSettingsRow === null) {
            stopSettingsRow = ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: 'dsh-moyu', order: 60, label: '摸鱼' },
                () =>
                  h(SettingsCheckinSection, {
                    onOpenPanel: () => {
                      // Leave settings first, then select the panel: selecting a
                      // panel behind the settings modal looks like nothing happened.
                      ctx.layout.closeSettings?.()
                      ctx.layout.selectPanel(PANEL_ID)
                    },
                  }),
              ),
            )
          } else if (!visible && stopSettingsRow !== null) {
            const stop = stopSettingsRow
            stopSettingsRow = null
            stop()
          }
        }
        syncSettingsRow(true)


        let stopPanelEntry = null
        const syncPanelEntry = (visible) => {
          if (visible && stopPanelEntry === null) {
            stopPanelEntry = ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: PANEL_LABEL },
                CheckinPanelIcon,
              ),
            )
          } else if (!visible && stopPanelEntry !== null) {
            const stop = stopPanelEntry
            stopPanelEntry = null
            stop()
          }
        }
        syncPanelEntry(true)

        // The always-visible badge, beside Settings at the sidebar foot.
        // (It is also the heartbeat that keeps the panel row in step.)
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: PANEL_ID, order: 20, label: PANEL_LABEL },
            (props) =>
              h(CheckinBadge, {
                wide: props.wide,
                usePanelInfo: props.usePanelInfo,
                selectPanel: (id) => ctx.layout.selectPanel(id),
                syncPanelEntry,
                syncSettingsRow,
              }),
          ),
        )

        // The full page: a keyed `main` entry. The panellist icon for it is
        // registered above, through the toggleable `syncPanelEntry` — but the
        // page itself stays mounted either way: the badge opens it too, and an
        // active panel whose `main` vanished mid-session is worse than an
        // unreachable-but-alive one.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, CheckinPage),
        )
      },
    }
  },
})
