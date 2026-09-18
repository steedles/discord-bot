/**
 * Feature dashboard.
 *
 * Every form on this page is generated from the schema at /api/features. There
 * is no per-feature code here on purpose: adding a feature or a setting to the
 * bot must not require touching the dashboard.
 */

const state = {
  me: null,
  features: [],
  guildId: null,
  instances: [],
  channels: [],
  roles: [],
  stats: null,
  open: new Set(), // expanded rows, by scope key
  drafts: new Map(), // unsaved edits, by scope key
  view: 'features', // 'features' | 'charts' | 'history' | 'watchlist' | 'wallets' | 'board' | 'alerts' | 'setup' | 'holdings'
  chartCards: new Map(), // live-charts DOM cards, by `${chainId}:${pairAddress}`
  chartsTimer: null,
  lastCharts: [], // most recent poll's natural (unpinned) order, for instant re-pin without a fetch
  pinnedKey: null, // `${chainId}:${pairAddress}` forced to rank 0, or null
  pinnedEntry: null, // last-known data for pinnedKey, kept even if it falls out of the natural top N
  launchCards: new Map(), // the "New Launches" column's own cards, same keying as chartCards
  lastLaunches: [], // most recent poll's launches, newest first
  historyCoins: [], // tracked-coins picker options
  historyKey: null, // `${chainId}:${tokenAddress}` of the coin currently plotted
  historyData: null, // { symbol, snapshots, alerts } for historyKey
  watchlist: [], // tracked coins, as returned by /api/guilds/:id/watchlist
  watchlistCap: null,
  watchlistLoading: false,
  trackedWallets: [], // imported wallet list, as returned by /api/guilds/:id/tracked-wallets
  myBoard: [], // this user's own chart slots, as returned by /api/guilds/:id/custom-board
  myBoardChainOptions: [],
  myBoardResolutionOptions: [],
  myAlertsChatId: '', // this user's Telegram chat ID, as returned by /api/guilds/:id/telegram-watch
  myAlertsCoins: [], // this user's tracked coins, same response
  myAlertsChainOptions: [],
  myAlertsWatchlist: [], // the shared bot-wide watchlist, as returned by /api/guilds/:id/watchlist - only
  // these coins can ever actually fire a personal alert (see the "+ New tracked coin" note in the UI),
  // so they're offered first rather than requiring a re-typed contract address for something already watched.
  holdingsCards: new Map(), // holdings-grid DOM cards, same keying as chartCards
  holdingsTimer: null,
  setup: null, // the Setup tab's status, as returned by /api/guilds/:id/setup
  setupJob: null, // the job being watched after Connect / Restart, or null
  setupPollTimer: null,
}

/** Columns in the "My Charts" grid - a slot's x/y/w/h are all in these cells. */
const BOARD_COLS = 12
/** Pixel height of one grid row. Chosen so the default 4x9 slot lands close to a Live Charts card's own proportions. */
const BOARD_ROW_PX = 32
const BOARD_GAP_PX = 10
const BOARD_MIN_W = 2
const BOARD_MIN_H = 4
const BOARD_DEFAULT_W = 4
const BOARD_DEFAULT_H = 9
const BOARD_MAX_SLOTS = 40
/** Matches the server's own default (RESOLUTION_OPTIONS in routes.ts) - used before that list has loaded, and for any slot saved before resolution existed. */
const BOARD_DEFAULT_RESOLUTION = '15m'

/** Slots in the live-charts grid: the 2 newest on top, then 4 across below. */
const CHART_SLOTS = 6
/** Slots in the separate "New Launches" column, stacked top to bottom. */
const LAUNCH_SLOTS = 2
const CHARTS_POLL_MS = 30_000
const HOLDINGS_POLL_MS = 30_000

/** True only for a local (email/password) login as the bot's owner - see routes.ts. */
const OWNER_EMAIL = 'wayne@steedman.co.za'
const isOwner = () => Boolean(state.me?.user?.local && state.me.user.username?.toLowerCase() === OWNER_EMAIL)

// A row is identified by feature + place. Channel rows use the channel id;
// the server-wide row uses an empty string.
const keyOf = (featureId, channelId) => `${featureId}:${channelId ?? ''}`

// How each feature kind is labelled on its card.
const KIND_LABEL = { push: 'posts', command: 'commands', listener: 'watches' }

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  // Only declare a JSON content type when there is actually a body - servers
  // reject "application/json" with nothing in it, which bit DELETE requests.
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }

  const res = await fetch(path, { credentials: 'same-origin', ...options, headers })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

function toast(message, isError = false) {
  const el = document.createElement('div')
  el.className = `toast${isError ? ' err' : ''}`
  el.textContent = message
  document.getElementById('toasts').append(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .3s'
    setTimeout(() => el.remove(), 300)
  }, isError ? 6000 : 3000)
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    state.me = await api('/api/me')
  } catch {
    state.me = { authenticated: false }
  }

  if (!state.me.authenticated) return renderSignIn()

  const { features } = await api('/api/features')
  state.features = features

  const saved = localStorage.getItem('guildId')
  const available = state.me.guilds.map((g) => g.id)
  state.guildId = available.includes(saved) ? saved : available[0] ?? null

  state.view = viewFromHash(location.hash)
  if (state.guildId) await loadGuild()
  render()
}

async function loadGuild() {
  state.drafts.clear()
  stopChartsPolling()
  state.pinnedKey = null
  state.pinnedEntry = null
  state.historyCoins = []
  state.historyKey = null
  state.historyData = null
  const [instances, channels, roles, stats] = await Promise.all([
    api(`/api/guilds/${state.guildId}/instances`),
    api(`/api/guilds/${state.guildId}/channels`),
    // A guild whose roles cannot be read still configures everything else, so
    // this failing costs the role pickers and nothing more.
    api(`/api/guilds/${state.guildId}/roles`).catch(() => ({ roles: [] })),
    api(`/api/guilds/${state.guildId}/stats`).catch(() => null),
  ])
  state.instances = instances.instances
  state.channels = channels.channels
  state.roles = roles.roles
  state.stats = stats
}

// ---------------------------------------------------------------- views

function renderSignIn() {
  const err = new URLSearchParams(location.search).get('error')
  document.getElementById('app').innerHTML = `
    <div class="signin">
      <div class="tick">◢</div>
      <h1>Kanto Control Room</h1>
      <p>
        Sign in to configure features per channel. Discord shows you every server
        where you have <strong>Manage Server</strong>; an account below reaches
        every server the bot is in.
      </p>
      ${err ? `<div class="banner" style="text-align:left">Sign-in failed: ${esc(err)}</div>` : ''}
      <a class="btn btn-primary" href="/auth/login" style="justify-content:center">
        Continue with Discord
      </a>

      <div class="signin-split"><span>or</span></div>

      <form class="signin-form" id="pwform" autocomplete="on">
        <input type="text" name="email" placeholder="Email or username" required
               autocomplete="username" />
        <input type="password" name="password" placeholder="Password" required
               autocomplete="current-password" />
        <button class="btn" type="submit">Sign in</button>
        <div class="signin-error" id="pwerror" hidden></div>
      </form>
    </div>`

  wireSignIn()
}

function wireSignIn() {
  const form = document.getElementById('pwform')
  const error = document.getElementById('pwerror')

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = form.querySelector('button')
    const data = new FormData(form)

    button.disabled = true
    error.hidden = true

    try {
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      })
      // The session cookie is set; boot again rather than reloading so a bad
      // ?error= from an earlier OAuth attempt does not survive the sign-in.
      history.replaceState(null, '', location.pathname)
      await boot()
    } catch (err) {
      error.textContent = err.message
      error.hidden = false
      button.disabled = false
    }
  })
}

function render() {
  const app = document.getElementById('app')

  if (!state.guildId) {
    document.body.classList.remove('charts-mode')
    stopChartsPolling()
    app.innerHTML = `${topbar()}
      <div class="banner">
        You have Manage Server on no servers that this bot has joined.
        Invite the bot to your server, then reload this page.
      </div>`
    wireTopbar()
    return
  }

  if (state.view === 'charts') {
    document.body.classList.add('charts-mode')
    app.innerHTML = `${topbar()}${chartsShell()}`
    wireTopbar()
    wireCharts()
    // The poll patches individual slots in place rather than re-rendering, so
    // an unchanged chart's iframe is never torn down and reloaded under it.
    stopChartsPolling()
    refreshCharts()
    state.chartsTimer = setInterval(refreshCharts, CHARTS_POLL_MS)
    return
  }

  if (state.view === 'board') {
    document.body.classList.add('charts-mode')
    app.innerHTML = `${topbar()}${boardShell()}`
    wireTopbar()
    wireBoard()
    loadMyBoard()
    return
  }

  document.body.classList.remove('charts-mode')
  stopChartsPolling()
  stopHoldingsPolling()
  stopSetupPolling()

  if (state.view === 'history') {
    app.innerHTML = `${topbar()}${historyShell()}`
    wireTopbar()
    wireHistory()
    loadHistoryCoins()
    return
  }

  if (state.view === 'watchlist') {
    app.innerHTML = `${topbar()}${watchlistShell()}`
    wireTopbar()
    wireWatchlist()
    loadWatchlist()
    return
  }

  if (state.view === 'wallets') {
    app.innerHTML = `${topbar()}${trackedWalletsShell()}`
    wireTopbar()
    wireTrackedWallets()
    loadTrackedWallets()
    return
  }

  if (state.view === 'alerts') {
    app.innerHTML = `${topbar()}${alertsShell()}`
    wireTopbar()
    wireAlerts()
    loadMyAlerts()
    return
  }

  if (state.view === 'setup') {
    app.innerHTML = `${topbar()}${setupShell()}`
    wireTopbar()
    wireSetup()
    loadSetup()
    return
  }

  if (state.view === 'holdings' && isOwner()) {
    app.innerHTML = `${topbar()}${holdingsShell()}`
    wireTopbar()
    loadHoldings()
    state.holdingsTimer = setInterval(loadHoldings, HOLDINGS_POLL_MS)
    return
  }

  app.innerHTML = `${topbar()}${statsStrip()}
    <div id="features">${state.features.map(featureBlock).join('')}</div>`

  wireTopbar()
  wireFeatures()
}

function topbar() {
  const options = state.me.guilds
    .map((g) => `<option value="${esc(g.id)}"${g.id === state.guildId ? ' selected' : ''}>${esc(g.name)}</option>`)
    .join('')

  const tabs = state.guildId
    ? `<nav class="viewtabs">
        <button class="viewtab${state.view === 'features' ? ' active' : ''}" data-view="features">Features</button>
        <button class="viewtab${state.view === 'charts' ? ' active' : ''}" data-view="charts">Live Charts</button>
        <button class="viewtab${state.view === 'history' ? ' active' : ''}" data-view="history">Coin History</button>
        <button class="viewtab${state.view === 'watchlist' ? ' active' : ''}" data-view="watchlist">Watchlist</button>
        <button class="viewtab${state.view === 'wallets' ? ' active' : ''}" data-view="wallets">Tracked Wallets</button>
        <button class="viewtab${state.view === 'board' ? ' active' : ''}" data-view="board">My Charts</button>
        <button class="viewtab${state.view === 'alerts' ? ' active' : ''}" data-view="alerts">My Alerts</button>
        <button class="viewtab${state.view === 'setup' ? ' active' : ''}" data-view="setup">Setup</button>
        ${isOwner() ? `<button class="viewtab${state.view === 'holdings' ? ' active' : ''}" data-view="holdings">Holdings</button>` : ''}
      </nav>`
    : ''

  return `
    <header class="topbar">
      <div class="brand"><span class="tick">◢</span> Kanto Control Room <span class="ver">v0.2</span></div>
      ${tabs}
      ${state.me.guilds.length ? `<select class="guild-select" id="guild">${options}</select>` : ''}
      <div class="spacer"></div>
      <div class="user"><span class="dot"></span>${esc(state.me.user.username)}</div>
      <button class="btn btn-sm" id="logout">Sign out</button>
    </header>`
}

// ---------------------------------------------------------------- live charts

/**
 * One grid, empty until the first poll fills it. Position and size come from
 * `order` and a size class set per card (see `refreshCharts`), not from where
 * in the grid a card's markup happens to sit - a card is never moved once
 * attached, only restyled, so a rank change never touches its iframe.
 */
function chartsShell() {
  return `
    <div class="charts-view">
      <div class="charts-head">
        <h2>Live Charts</h2>
        <span class="hint">The ${CHART_SLOTS} most recently alerted coins, newest at top left</span>
      </div>
      <div class="charts-row-outer">
        <div class="charts-grid" id="charts-grid"></div>
        <div class="launches-section">
          <div class="launches-label">🚀 New Launches</div>
          <div class="launches-col" id="launches-col"></div>
        </div>
      </div>
    </div>`
}

/**
 * Fomo's chain segment matches DexScreener's chainId, but only 'solana' is
 * confirmed against a real Fomo link (see fresh-start/packages/calls/fixtures/
 * legacy_calls.json) - the others are noted there as unverified guesses, so
 * they stay out rather than risk a broken link on the title.
 */
const FOMO_CHAIN_SLUGS = { solana: 'solana' }

function fomoUrl(entry) {
  const slug = FOMO_CHAIN_SLUGS[entry.chainId]
  return slug ? `https://fomo.family/tokens/${slug}/${entry.tokenAddress}` : null
}

/**
 * Rug-signature warning (docs/11-RUG-SIGNATURE.md) - `entry.rugFlag` is only
 * ever present when flagged (the live-charts/recent-launches routes never
 * send a checked-and-clean or never-checked result), so its mere presence is
 * the whole condition.
 */
function rugWarningHtml(entry) {
  if (!entry.rugFlag) return ''
  return `<button class="rug-warning" data-rug-detail="${esc(rugTooltipText(entry.rugFlag))}"
            aria-label="Rug pattern detected - hover for details">⚠️</button>`
}

function rugTooltipText(flag) {
  const lines = ['Rug pattern detected']
  if (flag.fundingFlagged) {
    lines.push(`${flag.cohortSize} wallet${flag.cohortSize === 1 ? '' : 's'} funded by the creator's own funder, still holding`)
    if (flag.funderWallet) lines.push(`Funder ${flag.funderWallet.slice(0, 4)}…${flag.funderWallet.slice(-4)}`)
    if (flag.cohortSharePct !== undefined) lines.push(`~${flag.cohortSharePct.toFixed(1)}% of supply`)
    if (flag.tailMatch) lines.push('Matches a known launcher fingerprint')
  }
  if (flag.distributionFlagged && flag.distributionCv !== undefined) {
    lines.push(`Top ${flag.distributionCohort} holders suspiciously flat (CV ${flag.distributionCv.toFixed(3)})`)
  }
  lines.push(`Checked ${formatClock(flag.checkedAt)} · pattern match, not a certainty`)
  return lines.join('\n')
}

function chartLabelHtml(entry) {
  const feature = state.features.find((f) => f.id === entry.featureId)
  const fomo = fomoUrl(entry)
  const title = fomo
    ? `<a class="chart-symbol" href="${esc(fomo)}" target="_blank" rel="noopener noreferrer">${esc(entry.symbol)} ↗</a>`
    : `<span class="chart-symbol">${esc(entry.symbol)}</span>`
  const ca = `<button class="chart-ca" data-copy-ca="${esc(entry.tokenAddress)}" title="Click to copy the contract address">${esc(entry.tokenAddress.slice(0, 6))}…</button>`
  const key = chartKey(entry)
  const pinned = state.pinnedKey === key
  // Pinning only makes sense on the tracked-coins grid - the launches column
  // is always just "the 2 most recent", and its cards have no pin listener.
  const pin =
    entry.featureId === 'launch-scanner'
      ? ''
      : `<button class="chart-pin${pinned ? ' pinned' : ''}" data-pin="${esc(key)}" aria-pressed="${pinned}"
            title="${pinned ? 'Unpin' : 'Pin as first chart'}">📌</button>`
  return `
    ${rugWarningHtml(entry)}
    ${pin}
    <span class="chart-badge">${feature ? esc(feature.icon) : ''} ${esc(feature ? feature.name : entry.featureId)}</span>
    ${title}
    ${ca}
    <span class="chart-age">${relTime(entry.postedAt)}</span>`
}

const chartKey = (entry) => `${entry.chainId}:${entry.pairAddress}`

/**
 * GeckoTerminal's embed. DEXTools has the only documented way to drop the
 * drawing-tool sidebar too, but its widget 403s outright in a way that also
 * can't be tested from any local dev URL (its own docs refuse `localhost`),
 * so it was dropped rather than shipped unverified. This codebase renders
 * charts server-side as static PNGs for Discord (see src/analysis/chart.ts)
 * and has no live renderer of its own, so the dashboard borrows one instead of
 * building one.
 *
 * `entry.network` is GeckoTerminal's network id, already resolved server-side
 * from the same map the candle fetcher uses - see the live-charts route.
 *
 * Resolution differs by section: launches move fast enough in their first
 * minutes that 15m candles would show almost nothing, while the tracked-coins
 * grid is coins already established enough to have alerted, where 15m reads
 * better than a noisy 15s. `bg_color` matches this dashboard's own card
 * background (`--panel`) so the iframe's chrome blends in rather than showing
 * GeckoTerminal's default.
 */
function chartEmbedUrl(entry) {
  const isLaunch = entry.featureId === 'launch-scanner'
  const params = new URLSearchParams({
    embed: '1',
    info: '0',
    swaps: '0',
    chart_type: 'market_cap',
    light_chart: '0',
    bg_color: '12102b',
    resolution: isLaunch ? '15s' : '15m',
  })
  return `https://www.geckoterminal.com/${entry.network}/pools/${entry.pairAddress}?${params.toString()}`
}

/**
 * Flashes a card when what it shows has actually changed - a new card, or an
 * existing one's alert timestamp moving (a fresh alert landed on a coin
 * already on the board). Re-ranking alone (a pin, or someone else's card
 * bumping this one down) does not touch `postedAt`, so it stays quiet - the
 * flash is reserved for "something just happened", not "something moved".
 */
function flashIfChanged(card, entry) {
  const signature = String(entry.postedAt)
  if (card.dataset.flashSig === signature) return
  card.dataset.flashSig = signature

  card.classList.remove('flash')
  void card.offsetWidth // restart the animation if it is still mid-flash
  card.classList.add('flash')
}

function buildChartCard(entry) {
  const card = document.createElement('div')
  card.className = 'chart-card'
  card.classList.toggle('rug-flagged', Boolean(entry.rugFlag))

  const label = document.createElement('div')
  label.className = 'chart-label'
  label.innerHTML = chartLabelHtml(entry)

  const iframe = document.createElement('iframe')
  iframe.loading = 'lazy'
  iframe.src = chartEmbedUrl(entry)

  card.append(label, iframe)
  return card
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

function stopChartsPolling() {
  if (state.chartsTimer) {
    clearInterval(state.chartsTimer)
    state.chartsTimer = null
  }
  state.chartCards = new Map()
  state.launchCards = new Map()
}

/**
 * The two feeds are fetched and applied independently - a hiccup in one must
 * not stall the other, so each is its own try/catch rather than one
 * Promise.all that would fail both on either one's error.
 */
async function refreshCharts() {
  const [chartsData, launchesData] = await Promise.all([
    api(`/api/guilds/${state.guildId}/live-charts`).catch(() => null),
    api(`/api/guilds/${state.guildId}/recent-launches`).catch(() => null),
  ])

  if (chartsData) {
    state.lastCharts = (chartsData.charts ?? []).slice(0, CHART_SLOTS)
    renderChartsGrid()
  }
  if (launchesData) {
    state.lastLaunches = launchesData.launches ?? []
    renderLaunchesColumn()
  }
}

/**
 * The "New Launches" column - always the 2 most recent, no pinning. Reuses
 * buildChartCard/chartLabelHtml as-is: a launch entry carries the same shape
 * as a live-charts entry plus a synthetic featureId of 'launch-scanner', so
 * the label bar resolves that feature's icon/name exactly like any other.
 */
function renderLaunchesColumn() {
  const col = document.getElementById('launches-col')
  if (!col) return

  const launches = state.lastLaunches
    .slice(0, LAUNCH_SLOTS)
    .map((entry) => ({ ...entry, featureId: 'launch-scanner' }))
  const wanted = new Map(launches.map((entry, rank) => [chartKey(entry), { entry, rank }]))

  for (const [key, card] of state.launchCards) {
    if (!wanted.has(key)) {
      card.remove()
      state.launchCards.delete(key)
    }
  }

  for (const [key, { entry, rank }] of wanted) {
    let card = state.launchCards.get(key)
    if (!card) {
      card = buildChartCard(entry)
      state.launchCards.set(key, card)
      col.append(card)
    } else {
      card.querySelector('.chart-label').innerHTML = chartLabelHtml(entry)
      card.classList.toggle('rug-flagged', Boolean(entry.rugFlag))
    }
    card.style.order = rank
    flashIfChanged(card, entry)
  }

  col.querySelectorAll('.chart-placeholder').forEach((el) => el.remove())
  for (let rank = launches.length; rank < LAUNCH_SLOTS; rank++) {
    const el = document.createElement('div')
    el.className = 'chart-card chart-placeholder'
    el.style.order = rank
    el.innerHTML = `<div class="chart-empty">Waiting for a launch…</div>`
    col.append(el)
  }
}

/**
 * Forces the pinned coin to rank 0 ahead of the natural recency order, and
 * keeps its last-known data even once a poll's natural top N stops including
 * it - pinning means "keep showing this one", not "while it stays the most
 * newsworthy". Unpinned, or never actually seen, falls back to the natural
 * order untouched.
 */
function pinnedOrder(charts) {
  if (!state.pinnedKey) return charts

  const fromPoll = charts.find((entry) => chartKey(entry) === state.pinnedKey)
  if (fromPoll) state.pinnedEntry = fromPoll
  const pinned = fromPoll ?? state.pinnedEntry
  if (!pinned) return charts

  const rest = charts.filter((entry) => chartKey(entry) !== state.pinnedKey)
  return [pinned, ...rest].slice(0, CHART_SLOTS)
}

/**
 * Patches the grid in place instead of re-rendering the view, and keys each
 * chart card by token rather than by slot index - a poll (or a pin toggle)
 * finding nothing new touches no DOM at all.
 *
 * A new alert bumping everything else down a rank still must not reload
 * anyone else's iframe, but Chromium reloads a cross-origin iframe whenever
 * its element is reparented, even via a single atomic move - moving existing
 * cards between slots was tried and measurably reloads them. So a card, once
 * attached, is never moved again: rank and size come from `style.order` and a
 * `lg`/`sm` class instead, both pure restyles the grid alone reflows around.
 */
function renderChartsGrid() {
  const grid = document.getElementById('charts-grid')
  if (!grid) return

  const charts = pinnedOrder(state.lastCharts)
  const wanted = new Map(charts.map((entry, rank) => [chartKey(entry), { entry, rank }]))

  for (const [key, card] of state.chartCards) {
    if (!wanted.has(key)) {
      card.remove()
      state.chartCards.delete(key)
    }
  }

  for (const [key, { entry, rank }] of wanted) {
    let card = state.chartCards.get(key)
    if (!card) {
      card = buildChartCard(entry)
      state.chartCards.set(key, card)
      grid.append(card) // the only time a real card's node is ever inserted
    } else {
      card.querySelector('.chart-label').innerHTML = chartLabelHtml(entry)
      card.classList.toggle('rug-flagged', Boolean(entry.rugFlag))
    }
    card.style.order = rank
    card.classList.toggle('lg', rank < 2)
    card.classList.toggle('sm', rank >= 2)
    flashIfChanged(card, entry)
  }

  // Placeholders carry no iframe, so rebuilding them fresh every poll costs
  // nothing - simpler than tracking which empty ranks already have one.
  grid.querySelectorAll('.chart-placeholder').forEach((el) => el.remove())
  for (let rank = charts.length; rank < CHART_SLOTS; rank++) {
    const el = document.createElement('div')
    el.className = `chart-card chart-placeholder ${rank < 2 ? 'lg' : 'sm'}`
    el.style.order = rank
    el.innerHTML = `<div class="chart-empty">Waiting for an alert…</div>`
    grid.append(el)
  }
}

/** Pinning a second coin unpins the first - only one card can be forced first. */
function togglePin(key) {
  if (state.pinnedKey === key) {
    state.pinnedKey = null
    state.pinnedEntry = null
  } else {
    state.pinnedKey = key
    state.pinnedEntry = state.lastCharts.find((entry) => chartKey(entry) === key) ?? state.pinnedEntry
  }
  renderChartsGrid()
}

function wireCharts() {
  // Delegated on the whole view, not just #charts-grid - the "New Launches"
  // column (#launches-col) shares chartLabelHtml and needs the same copy
  // handler, even though only the grid's cards ever render a pin button.
  document.querySelector('.charts-view')?.addEventListener('click', (event) => {
    const pinBtn = event.target.closest('[data-pin]')
    if (pinBtn) return togglePin(pinBtn.dataset.pin)

    const copyBtn = event.target.closest('[data-copy-ca]')
    if (copyBtn) copyContractAddress(copyBtn)
  })
}

async function copyContractAddress(btn) {
  const address = btn.dataset.copyCa
  try {
    await navigator.clipboard.writeText(address)
  } catch (err) {
    toast(err.message, true)
    return
  }
  const original = btn.textContent
  btn.textContent = 'Copied!'
  btn.classList.add('copied')
  setTimeout(() => {
    btn.textContent = original
    btn.classList.remove('copied')
  }, 1200)
}

// ---------------------------------------------------------------------- board
//
// "My Charts" - a personal, freeform grid, unlike every other tab here: it is
// keyed by the signed-in user (src/db/models.ts CustomBoard), not by guild, so
// Wayne and Ash each see only their own layout. A slot is a rectangle in grid
// cells (x/y/w/h) that is either empty (asking for a network + contract
// address) or resolved (a live GeckoTerminal embed, same provider Live Charts
// uses) - resolution always goes through the server's resolveToken(), never
// a pool address typed in directly, so a slot can never point at a pair
// nobody can prove trades that coin.

function boardShell() {
  return `
    <div class="charts-view board-view">
      <div class="charts-head">
        <h2>My Charts</h2>
        <span class="hint">Your own layout. Drag ⠿ to move a card, drag its corner to resize.</span>
        <button class="btn btn-sm" id="board-add">+ Add chart</button>
      </div>
      <div class="board-grid" id="board-grid"></div>
    </div>`
}

async function loadMyBoard() {
  const grid = document.getElementById('board-grid')
  if (!grid) return

  let data
  try {
    data = await api(`/api/guilds/${state.guildId}/custom-board`)
  } catch (err) {
    grid.innerHTML = `<div class="banner">Could not load your board: ${esc(err.message)}</div>`
    return
  }

  if (state.view !== 'board') return

  state.myBoard = data.slots ?? []
  state.myBoardChainOptions = data.chainOptions ?? []
  state.myBoardResolutionOptions = data.resolutionOptions ?? []
  renderBoard()
}

function renderBoard() {
  const grid = document.getElementById('board-grid')
  if (!grid) return

  if (state.myBoard.length === 0) {
    grid.innerHTML = `<div class="empty board-empty">No charts yet - add one and paste a contract address to get started.</div>`
    return
  }

  grid.innerHTML = state.myBoard.map(boardSlotHtml).join('')
}

const slotStyle = (slot) => `grid-column: ${slot.x + 1} / span ${slot.w}; grid-row: ${slot.y + 1} / span ${slot.h};`

function boardSlotHtml(slot) {
  const filled = Boolean(slot.pairAddress)
  return `
    <div class="chart-card board-slot${filled ? '' : ' board-slot-empty'}" data-slot-id="${esc(slot.id)}" style="${slotStyle(slot)}">
      <div class="chart-label board-slot-head">
        <span class="board-slot-drag" title="Drag to move">⠿</span>
        ${filled ? boardFilledLabel(slot) : `<span class="chart-symbol">New chart</span>`}
        <button class="board-slot-remove" data-remove-slot="${esc(slot.id)}" title="Remove this slot">✕</button>
      </div>
      ${filled ? boardFilledBody(slot) : boardEmptyBody(slot)}
      <div class="board-slot-resize" title="Drag to resize"></div>
    </div>`
}

function boardFilledLabel(slot) {
  const chain = state.myBoardChainOptions.find((c) => c.value === slot.chainId)
  return `
    <span class="chart-symbol">${chain ? esc(chain.emoji) : ''} ${esc(slot.symbol ?? '')}</span>
    <button class="chart-ca" data-copy-ca="${esc(slot.tokenAddress)}" title="Click to copy the contract address">${esc(
      slot.tokenAddress.slice(0, 6),
    )}…</button>
    <button class="board-slot-change" data-clear-slot="${esc(slot.id)}" title="Change the coin in this slot">change</button>`
}

function boardFilledBody(slot) {
  return `<iframe loading="lazy" src="${esc(boardChartEmbedUrl(slot))}"></iframe>`
}

/** Same GeckoTerminal embed Live Charts uses (see chartEmbedUrl), at whatever resolution was picked when the coin was loaded. */
function boardChartEmbedUrl(slot) {
  const params = new URLSearchParams({
    embed: '1',
    info: '0',
    swaps: '0',
    chart_type: 'market_cap',
    light_chart: '0',
    bg_color: '12102b',
    resolution: slot.resolution ?? BOARD_DEFAULT_RESOLUTION,
  })
  return `https://www.geckoterminal.com/${slot.network}/pools/${slot.pairAddress}?${params.toString()}`
}

function boardEmptyBody(slot) {
  const chainOptions = state.myBoardChainOptions
    .map((c) => `<option value="${esc(c.value)}">${esc(c.emoji)} ${esc(c.label)}</option>`)
    .join('')
  const currentResolution = slot.resolution ?? BOARD_DEFAULT_RESOLUTION
  const resolutionOptions = state.myBoardResolutionOptions
    .map((r) => `<option value="${esc(r.value)}"${r.value === currentResolution ? ' selected' : ''}>${esc(r.label)}</option>`)
    .join('')
  return `
    <div class="board-slot-form">
      <select class="board-chain-select">${chainOptions}</select>
      <input type="text" class="board-ca-input" placeholder="Paste contract address" spellcheck="false" autocomplete="off" />
      <select class="board-resolution-select" title="Chart resolution">${resolutionOptions}</select>
      <button class="btn btn-sm" data-load-slot="${esc(slot.id)}">Load chart</button>
      <div class="board-slot-error"></div>
    </div>`
}

function wireBoard() {
  document.getElementById('board-add')?.addEventListener('click', addBoardSlot)

  const grid = document.getElementById('board-grid')

  grid?.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('[data-remove-slot]')
    if (removeBtn) return void removeBoardSlot(removeBtn.dataset.removeSlot)

    const clearBtn = event.target.closest('[data-clear-slot]')
    if (clearBtn) return void clearBoardSlot(clearBtn.dataset.clearSlot)

    const loadBtn = event.target.closest('[data-load-slot]')
    if (loadBtn) return void submitBoardSlot(loadBtn.dataset.loadSlot)

    const copyBtn = event.target.closest('[data-copy-ca]')
    if (copyBtn) return void copyContractAddress(copyBtn)
  })

  // Enter in the CA input submits without reaching for the button.
  grid?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (!event.target.classList.contains('board-ca-input')) return
    const slotEl = event.target.closest('[data-slot-id]')
    if (slotEl) void submitBoardSlot(slotEl.dataset.slotId)
  })

  grid?.addEventListener('pointerdown', (event) => {
    const dragHandle = event.target.closest('.board-slot-drag')
    const resizeHandle = event.target.closest('.board-slot-resize')
    if (dragHandle) startBoardDrag(event, dragHandle.closest('[data-slot-id]'), 'move')
    else if (resizeHandle) startBoardDrag(event, resizeHandle.closest('[data-slot-id]'), 'resize')
  })
}

const slotsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** Scans row by row, left to right, for the first spot a w×h slot fits without overlapping anything already on the board. */
function firstFreeSpot(slots, w, h) {
  for (let y = 0; ; y++) {
    for (let x = 0; x <= BOARD_COLS - w; x++) {
      const candidate = { x, y, w, h }
      if (!slots.some((s) => slotsOverlap(candidate, s))) return { x, y }
    }
  }
}

async function addBoardSlot() {
  if (state.myBoard.length >= BOARD_MAX_SLOTS) {
    toast(`A board can only hold ${BOARD_MAX_SLOTS} charts`, true)
    return
  }
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const { x, y } = firstFreeSpot(state.myBoard, BOARD_DEFAULT_W, BOARD_DEFAULT_H)
  state.myBoard.push({ id, x, y, w: BOARD_DEFAULT_W, h: BOARD_DEFAULT_H })
  renderBoard()
  await persistBoard()
}

async function removeBoardSlot(id) {
  state.myBoard = state.myBoard.filter((s) => s.id !== id)
  renderBoard()
  await persistBoard()
}

/** Drops the coin but keeps the slot's position/size, so re-picking a coin does not also mean re-placing the card. */
async function clearBoardSlot(id) {
  const slot = state.myBoard.find((s) => s.id === id)
  if (!slot) return
  delete slot.chainId
  delete slot.tokenAddress
  delete slot.pairAddress
  delete slot.network
  delete slot.symbol
  renderBoard()
  await persistBoard()
}

async function submitBoardSlot(id) {
  const slotEl = document.querySelector(`[data-slot-id="${cssEscape(id)}"]`)
  if (!slotEl) return

  const chainId = slotEl.querySelector('.board-chain-select')?.value
  const tokenAddress = slotEl.querySelector('.board-ca-input')?.value.trim()
  const resolution = slotEl.querySelector('.board-resolution-select')?.value ?? BOARD_DEFAULT_RESOLUTION
  const errorEl = slotEl.querySelector('.board-slot-error')
  const submitBtn = slotEl.querySelector('[data-load-slot]')
  if (errorEl) errorEl.textContent = ''

  if (!tokenAddress) {
    if (errorEl) errorEl.textContent = 'Paste a contract address.'
    return
  }

  if (submitBtn) {
    submitBtn.disabled = true
    submitBtn.textContent = 'Loading…'
  }

  let resolved
  try {
    resolved = await api(`/api/guilds/${state.guildId}/custom-board/resolve`, {
      method: 'POST',
      body: JSON.stringify({ chainId, tokenAddress }),
    })
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message
    if (submitBtn) {
      submitBtn.disabled = false
      submitBtn.textContent = 'Load chart'
    }
    return
  }

  const slot = state.myBoard.find((s) => s.id === id)
  if (!slot) return
  Object.assign(slot, resolved, { resolution })
  renderBoard()
  await persistBoard()
}

async function persistBoard() {
  try {
    await api(`/api/guilds/${state.guildId}/custom-board`, {
      method: 'PUT',
      body: JSON.stringify({ slots: state.myBoard }),
    })
  } catch (err) {
    toast(err.message, true)
  }
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

/**
 * Hand-rolled drag/resize - no grid library, matching this dashboard's own
 * no-bundler rule. The dragged slot leaves grid flow for absolute pixel
 * positioning during the gesture (frozen at its current on-screen box, so
 * nothing jumps), snaps back to a grid-column/grid-row placement on release.
 * Only ever commits a position that does not overlap another slot - an
 * invalid drop reverts to wherever the pointer last passed over a valid one,
 * which is the original spot if it never did.
 */
function startBoardDrag(event, slotEl, mode) {
  if (!slotEl) return
  event.preventDefault()

  const grid = document.getElementById('board-grid')
  const gridRect = grid.getBoundingClientRect()
  const colWidth = (gridRect.width - BOARD_GAP_PX * (BOARD_COLS - 1)) / BOARD_COLS

  const id = slotEl.dataset.slotId
  const slot = state.myBoard.find((s) => s.id === id)
  if (!slot) return
  const others = state.myBoard.filter((s) => s.id !== id)

  const startRect = slotEl.getBoundingClientRect()
  const originLeft = startRect.left - gridRect.left
  const originTop = startRect.top - gridRect.top
  const startX = event.clientX
  const startY = event.clientY

  slotEl.style.position = 'absolute'
  slotEl.style.left = `${originLeft}px`
  slotEl.style.top = `${originTop}px`
  slotEl.style.width = `${startRect.width}px`
  slotEl.style.height = `${startRect.height}px`
  slotEl.classList.add('board-slot-dragging')
  grid.classList.add('board-interacting') // iframes stop eating pointer events while any slot is mid-drag

  const original = { x: slot.x, y: slot.y, w: slot.w, h: slot.h }
  let candidate = { ...original }

  function tryCandidate(next) {
    const ok = next.x >= 0 && next.y >= 0 && next.x + next.w <= BOARD_COLS && !others.some((s) => slotsOverlap(next, s))
    slotEl.classList.toggle('board-slot-invalid', !ok)
    if (ok) candidate = next
  }

  function onMove(e) {
    const dx = e.clientX - startX
    const dy = e.clientY - startY

    if (mode === 'move') {
      const left = originLeft + dx
      const top = Math.max(0, originTop + dy)
      slotEl.style.left = `${left}px`
      slotEl.style.top = `${top}px`

      const gx = clamp(Math.round(left / (colWidth + BOARD_GAP_PX)), 0, BOARD_COLS - original.w)
      const gy = Math.max(0, Math.round(top / (BOARD_ROW_PX + BOARD_GAP_PX)))
      tryCandidate({ x: gx, y: gy, w: original.w, h: original.h })
    } else {
      const width = Math.max(startRect.width + dx, BOARD_MIN_W * colWidth)
      const height = Math.max(startRect.height + dy, BOARD_MIN_H * BOARD_ROW_PX)
      slotEl.style.width = `${width}px`
      slotEl.style.height = `${height}px`

      const gw = clamp(Math.round(width / (colWidth + BOARD_GAP_PX)), BOARD_MIN_W, BOARD_COLS - original.x)
      const gh = Math.max(BOARD_MIN_H, Math.round(height / (BOARD_ROW_PX + BOARD_GAP_PX)))
      tryCandidate({ x: original.x, y: original.y, w: gw, h: gh })
    }
  }

  function onUp() {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    grid.classList.remove('board-interacting')

    const changed =
      candidate.x !== original.x || candidate.y !== original.y || candidate.w !== original.w || candidate.h !== original.h
    Object.assign(slot, candidate)
    renderBoard() // clears the inline absolute-position styles by re-issuing fresh markup
    if (changed) void persistBoard()
  }

  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}

/** CSS.escape isn't available in every runtime this dashboard might load in - IDs here are always our own `s<base36>` shape, so a minimal escape covers it. */
function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

// ---------------------------------------------------------------- coin history

const historyKeyOf = (chainId, tokenAddress) => `${chainId}:${tokenAddress}`

function historyShell() {
  return `
    <div class="history-view">
      <div class="charts-head">
        <h2>Coin History</h2>
        <span class="hint">Price against every alert fired for it, last 48h - the same 48h volume_snapshots and monitor_alerts keep before they expire.</span>
      </div>
      <div class="history-controls">
        <select id="history-coin" class="history-coin-select"><option value="">Loading coins…</option></select>
      </div>
      <div id="history-body"><div class="empty">Loading…</div></div>
    </div>`
}

function wireHistory() {
  document.getElementById('history-coin')?.addEventListener('change', (event) => {
    if (event.target.value) selectHistoryCoin(event.target.value)
  })
}

async function loadHistoryCoins() {
  const select = document.getElementById('history-coin')
  const body = document.getElementById('history-body')
  if (!select || !body) return

  let data
  try {
    data = await api(`/api/guilds/${state.guildId}/tracked-coins`)
  } catch (err) {
    body.innerHTML = `<div class="banner">Could not load coins: ${esc(err.message)}</div>`
    return
  }
  state.historyCoins = data.coins ?? []

  if (state.historyCoins.length === 0) {
    select.innerHTML = `<option value="">No alerts in the last 48h</option>`
    body.innerHTML = `<div class="empty">Nothing has alerted here in the last 48 hours - once something does, it shows up here.</div>`
    return
  }

  select.innerHTML = state.historyCoins
    .map((c) => {
      const key = historyKeyOf(c.chainId, c.tokenAddress)
      return `<option value="${esc(key)}">${esc(c.symbol)} · ${esc(c.chainId)}</option>`
    })
    .join('')

  // Keep the current pick if it is still offered, else default to the most recent.
  const stillListed = state.historyCoins.some((c) => historyKeyOf(c.chainId, c.tokenAddress) === state.historyKey)
  const initial = stillListed ? state.historyKey : historyKeyOf(state.historyCoins[0].chainId, state.historyCoins[0].tokenAddress)
  select.value = initial
  selectHistoryCoin(initial)
}

async function selectHistoryCoin(key) {
  state.historyKey = key
  const body = document.getElementById('history-body')
  if (!body) return
  body.innerHTML = `<div class="empty">Loading…</div>`

  const [chainId, tokenAddress] = key.split(':')
  let data
  try {
    data = await api(
      `/api/guilds/${state.guildId}/coin-history?chainId=${encodeURIComponent(chainId)}&tokenAddress=${encodeURIComponent(tokenAddress)}`,
    )
  } catch (err) {
    body.innerHTML = `<div class="banner">Could not load history: ${esc(err.message)}</div>`
    return
  }

  if (state.historyKey !== key) return // a newer selection landed first
  state.historyData = data
  body.innerHTML = renderHistoryBody(data)
}

function renderHistoryBody(data) {
  const { symbol, snapshots, alerts } = data
  if (!snapshots || snapshots.length < 2) {
    return `<div class="empty">Not enough price history for ${esc(symbol ?? 'this coin')} yet.</div>`
  }

  return `
    <div class="history-panel">
      <div class="history-title">
        ${esc(symbol ?? '')}
        <span class="history-count">${alerts.length} alert${alerts.length === 1 ? '' : 's'} in range</span>
      </div>
      ${historyChartSvg(snapshots, alerts)}
      ${historyLegend(alerts)}
      ${historyAlertList(alerts)}
    </div>`
}

/**
 * A tooltip box for one marker, built as plain SVG rather than an HTML overlay
 * - it shows on hover purely via CSS (`.chart-marker:hover .marker-tooltip`),
 * no positioning JS needed at hover time. Flips to whichever side of the
 * marker stays inside the chart, since a box anchored the same way for every
 * marker would run off the canvas near the edges.
 */
function markerTooltip(px, py, lines, color, chartW, chartH) {
  const padX = 10
  const padY = 9
  const lineHeight = 15
  const charWidth = 6.3 // rough average for 11px var(--sans) - a box a little roomy beats one that clips

  const boxWidth = Math.min(260, Math.max(130, Math.max(...lines.map((l) => l.length)) * charWidth + padX * 2))
  const boxHeight = padY * 2 + lineHeight * lines.length
  const gap = 10

  const flipLeft = px > chartW * 0.6
  const flipDown = py < chartH * 0.3
  const boxX = flipLeft ? px - gap - boxWidth : px + gap
  const boxY = flipDown ? py + gap : py - gap - boxHeight

  const textLines = lines
    .map(
      (line, i) =>
        `<text x="${(boxX + padX).toFixed(1)}" y="${(boxY + padY + lineHeight * (i + 1) - 4).toFixed(1)}"
               class="marker-tooltip-line${i === 0 ? ' title' : i === lines.length - 1 ? ' time' : ''}">${esc(line)}</text>`,
    )
    .join('')

  return `
    <g class="marker-tooltip">
      <rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxWidth.toFixed(1)}" height="${boxHeight.toFixed(1)}"
            rx="4" class="marker-tooltip-bg" style="--marker-color:${color}" />
      ${textLines}
    </g>`
}

/**
 * A hand-rolled SVG line chart - the dashboard is deliberately bundler-free
 * vanilla JS (see docs/DASHBOARD.md), and no off-the-shelf embed can draw our
 * own alert markers on top of someone else's chart anyway.
 */
function historyChartSvg(snapshots, alerts) {
  const W = 1000
  const H = 340
  const padL = 64
  const padR = 16
  const padT = 16
  const padB = 28

  const priced = snapshots.filter((s) => s.priceUsd != null && Number.isFinite(s.priceUsd))
  if (priced.length < 2) return `<div class="chart-empty">No price readings in range.</div>`

  const times = priced.map((s) => new Date(s.at).getTime())
  const prices = priced.map((s) => s.priceUsd)
  const minT = times[0]
  const maxT = times[times.length - 1]
  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const pad = (maxP - minP) * 0.1 || maxP * 0.05 || 1
  const loP = minP - pad
  const hiP = maxP + pad

  const x = (t) => padL + ((t - minT) / (maxT - minT || 1)) * (W - padL - padR)
  const y = (p) => padT + (1 - (p - loP) / (hiP - loP || 1)) * (H - padT - padB)

  const points = priced.map((s) => `${x(new Date(s.at).getTime()).toFixed(1)},${y(s.priceUsd).toFixed(1)}`).join(' ')

  // The price at or just before an alert's timestamp, to place its marker on the curve.
  const priceAt = (t) => {
    let prev = priced[0]
    for (const s of priced) {
      if (new Date(s.at).getTime() > t) break
      prev = s
    }
    return prev.priceUsd
  }

  const markers = alerts
    .map((a) => {
      const t = new Date(a.postedAt).getTime()
      if (t < minT || t > maxT) return '' // outside the plotted range - nothing honest to draw
      const px = x(t)
      const py = y(priceAt(t))
      const color = colorForFeature(a.featureId)
      const lines = [`${featureName(a.featureId)}`, a.trigger, formatClock(a.postedAt)]
      return `<g class="chart-marker" tabindex="0" aria-label="${esc(lines.join(' - '))}">
        <line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${H - padB}"
              stroke="${color}" stroke-width="1" stroke-dasharray="2,3" class="marker-guide" />
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" fill="${color}" class="marker-halo" />
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="${color}" stroke="#0a0820" stroke-width="1.5" class="marker-dot" />
        ${markerTooltip(px, py, lines, color, W, H)}
      </g>`
    })
    .join('')

  const yTicks = [hiP, (hiP + loP) / 2, loP]
  const yLabels = yTicks
    .map((p, i) => {
      const py = (padT + (i / (yTicks.length - 1)) * (H - padT - padB)).toFixed(1)
      return `<text x="${padL - 8}" y="${py}" class="chart-axis-label" text-anchor="end" dominant-baseline="middle">${esc(formatUsdPrice(p))}</text>`
    })
    .join('')

  const xTicks = [minT, (minT + maxT) / 2, maxT]
  const xLabels = xTicks
    .map((t) => `<text x="${x(t).toFixed(1)}" y="${H - 8}" class="chart-axis-label" text-anchor="middle">${esc(formatClock(t))}</text>`)
    .join('')

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="history-chart-svg" role="img" aria-label="Price chart">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="chart-axis-line" />
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="chart-axis-line" />
      ${yLabels}
      ${xLabels}
      <polyline points="${points}" class="chart-price-line" />
      ${markers}
    </svg>`
}

/** Distinct hues for the monitor features, chosen so no two neighbours read alike. */
const FEATURE_COLORS = {
  'volume-spikes': '#5c9dff',
  'whale-buys': '#3ddc97',
  trending: '#ffb454',
  'dip-hunter': '#ff6b81',
  'level-break': '#c07bf0',
  'pvp-coins': '#f0c419',
  'vamp-watch': '#4dd9e8',
}
const DEFAULT_MARKER_COLOR = '#9c96c9'
const colorForFeature = (featureId) => FEATURE_COLORS[featureId] ?? DEFAULT_MARKER_COLOR

function historyLegend(alerts) {
  const seen = [...new Set(alerts.map((a) => a.featureId))]
  if (seen.length === 0) return ''
  return `
    <div class="history-legend">
      ${seen
        .map(
          (id) =>
            `<span class="legend-item"><span class="legend-dot" style="background:${colorForFeature(id)}"></span>${esc(featureName(id))}</span>`,
        )
        .join('')}
    </div>`
}

function historyAlertList(alerts) {
  if (alerts.length === 0) return `<div class="empty">No alerts fired for this coin in range.</div>`
  return `
    <div class="history-alert-list">
      ${[...alerts]
        .reverse() // newest first, matching the rest of the dashboard
        .map(
          (a) => `
        <div class="history-alert-row">
          <span class="legend-dot" style="background:${colorForFeature(a.featureId)}"></span>
          <span class="history-alert-feature">${esc(featureName(a.featureId))}</span>
          <span class="history-alert-trigger">${esc(a.trigger)}</span>
          <span class="history-alert-time">${esc(formatClock(a.postedAt))}</span>
        </div>`,
        )
        .join('')}
    </div>`
}

function featureName(featureId) {
  const feature = state.features.find((f) => f.id === featureId)
  return feature ? `${feature.icon} ${feature.name}` : featureId
}

function formatClock(value) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Mirrors src/market/format.ts formatUsdPrice - prices here span orders of magnitude. */
function formatUsdPrice(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'n/a'
  if (value === 0) return '$0'
  if (value >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (value >= 1) return `$${value.toFixed(4)}`
  if (value >= 0.0001) return `$${value.toFixed(6)}`
  return `$${value.toPrecision(4)}`
}

/** Mirrors src/market/format.ts formatCompactUsd - for market cap and volume. */
function formatCompactUsd(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

// ---------------------------------------------------------------- watchlist

/**
 * Manage the shared, bot-wide watchlist - the dashboard's view of the same
 * list `/watch list` and `/watch remove` manage (src/monitor/watchlist.ts).
 * Market cap and 1h volume come from the monitor's own last poll; holder
 * count is fetched live server-side (bounded concurrency), which is why a
 * full load can take a few seconds on a watchlist of any size.
 */
function watchlistShell() {
  return `
    <div class="watchlist-view">
      <div class="charts-head">
        <h2>Watchlist</h2>
        <span class="hint" id="watchlist-count">Loading…</span>
      </div>
      <div id="watchlist-body"><div class="empty">Loading…</div></div>
    </div>`
}

function wireWatchlist() {
  document.getElementById('watchlist-body')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove-watch]')
    if (!btn) return
    const [chainId, tokenAddress] = btn.dataset.removeWatch.split(':')
    removeWatchlistToken(chainId, tokenAddress, btn.dataset.symbol)
  })
}

async function loadWatchlist() {
  const body = document.getElementById('watchlist-body')
  if (!body) return

  let data
  try {
    data = await api(`/api/guilds/${state.guildId}/watchlist`)
  } catch (err) {
    body.innerHTML = `<div class="banner">Could not load the watchlist: ${esc(err.message)}</div>`
    return
  }

  // A slower guild switch or hash change could land after this resolves -
  // only apply it if we are still looking at the watchlist view.
  if (state.view !== 'watchlist') return

  state.watchlist = data.watchlist ?? []
  state.watchlistCap = data.cap ?? null

  const countEl = document.getElementById('watchlist-count')
  if (countEl) {
    countEl.textContent = state.watchlistCap
      ? `${state.watchlist.length}/${state.watchlistCap} tokens tracked`
      : `${state.watchlist.length} tokens tracked`
  }

  body.innerHTML = renderWatchlistTable()
}

function watchSourceTag(t) {
  if (t.source === 'manual') return '<span class="watch-tag manual">manual</span>'
  const kind = t.source === 'called' ? 'called' : 'auto'
  const expiry = t.expiresAt ? ` · expires ${esc(formatClock(t.expiresAt))}` : ''
  return `<span class="watch-tag">${kind}${expiry}</span>`
}

function renderWatchlistTable() {
  if (state.watchlist.length === 0) {
    return `<div class="empty">The watchlist is empty. Add a token with <code>/watch add</code>, or let auto-discovery fill it.</div>`
  }

  const rows = state.watchlist
    .map((t) => {
      const key = `${t.chainId}:${t.tokenAddress}`
      const errorTag = t.errorCount > 0 ? `<span class="watch-tag warn">${t.errorCount} failed polls</span>` : ''

      return `
        <tr>
          <td>
            <div class="watch-symbol">${esc(t.symbol)}</div>
            <div class="watch-chain">${esc(t.chainId)}</div>
          </td>
          <td>${watchSourceTag(t)}${errorTag}</td>
          <td class="num">${esc(formatCompactUsd(t.marketCapUsd))}</td>
          <td class="num">${esc(formatCompactUsd(t.volH1))}</td>
          <td class="num">${t.holderCount !== undefined ? t.holderCount.toLocaleString() : '—'}</td>
          <td class="num">${esc(relTime(t.addedAt))}</td>
          <td>
            <button class="btn btn-sm btn-danger" data-remove-watch="${esc(key)}" data-symbol="${esc(t.symbol)}">Remove</button>
          </td>
        </tr>`
    })
    .join('')

  return `
    <table class="watchlist-table">
      <thead>
        <tr>
          <th>Coin</th>
          <th>Source</th>
          <th class="num">Market Cap</th>
          <th class="num">1h Volume</th>
          <th class="num">Holders</th>
          <th class="num">Added</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

async function removeWatchlistToken(chainId, tokenAddress, symbol) {
  try {
    await api(
      `/api/guilds/${state.guildId}/watchlist/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      { method: 'DELETE' },
    )
    toast(`Removed ${symbol} from the watchlist`)
    await loadWatchlist()
  } catch (err) {
    toast(err.message, true)
  }
}

// -------------------------------------------------------------- my alerts
//
// "My Alerts" - a personal tracked-coin list (src/db/models.ts TelegramWatch),
// keyed by the signed-in user like "My Charts" is, not by guild. Any trigger
// that fires on a tracked coin, at any priority, gets mirrored with a chart to
// this person's own Telegram chat - the chat ID comes from messaging the bot
// and pasting the ID it gives back, there is no in-dashboard way to look it up.

function alertsShell() {
  return `
    <div class="watchlist-view">
      <div class="charts-head">
        <h2>My Alerts</h2>
        <span class="hint">Telegram alerts, with a chart, for coins you track here.</span>
      </div>
      <div class="board-slot-form" id="alerts-chatid-form">
        <input type="text" class="board-ca-input" id="alerts-chatid-input" placeholder="Telegram chat ID" spellcheck="false" autocomplete="off" />
        <button class="btn btn-sm" id="alerts-chatid-save">Save chat ID</button>
        <div class="board-slot-error" id="alerts-chatid-error"></div>
      </div>
      <div class="board-slot-form" id="alerts-add-form">
        <select class="board-chain-select" id="alerts-track-select"></select>
        <div id="alerts-new-coin-fields" style="display: flex; flex-direction: column; gap: 8px;">
          <select class="board-chain-select" id="alerts-chain-select"></select>
          <input type="text" class="board-ca-input" id="alerts-ca-input" placeholder="Paste contract address" spellcheck="false" autocomplete="off" />
        </div>
        <button class="btn btn-sm" id="alerts-add">+ Track coin</button>
        <div class="board-slot-error" id="alerts-add-error"></div>
      </div>
      <div id="alerts-body"><div class="empty">Loading…</div></div>
    </div>`
}

function wireAlerts() {
  document.getElementById('alerts-chatid-save')?.addEventListener('click', saveAlertsChatId)
  document.getElementById('alerts-add')?.addEventListener('click', addAlertsCoin)
  document.getElementById('alerts-track-select')?.addEventListener('change', updateAlertsNewCoinVisibility)

  document.getElementById('alerts-chatid-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveAlertsChatId()
  })
  document.getElementById('alerts-ca-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addAlertsCoin()
  })

  document.getElementById('alerts-body')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove-alert-coin]')
    if (!btn) return
    const [chainId, tokenAddress] = btn.dataset.removeAlertCoin.split(':')
    removeAlertsCoin(chainId, tokenAddress, btn.dataset.symbol)
  })
}

async function loadMyAlerts() {
  const body = document.getElementById('alerts-body')
  if (!body) return

  let data
  try {
    data = await api(`/api/guilds/${state.guildId}/telegram-watch`)
  } catch (err) {
    body.innerHTML = `<div class="banner">Could not load your alerts: ${esc(err.message)}</div>`
    return
  }

  // Best-effort: the shared watchlist only fills the "already tracked coins"
  // shortcut in the dropdown. Losing it still leaves "+ New tracked coin"
  // (manual entry) working, so a failure here must not block the page.
  let watchlistData
  try {
    watchlistData = await api(`/api/guilds/${state.guildId}/watchlist`)
  } catch (err) {
    console.warn('could not load the watchlist for the tracked-coin picker', err)
  }

  if (state.view !== 'alerts') return

  state.myAlertsChatId = data.telegramChatId ?? ''
  state.myAlertsCoins = data.coins ?? []
  state.myAlertsChainOptions = data.chainOptions ?? []
  state.myAlertsWatchlist = watchlistData?.watchlist ?? []

  const chatIdInput = document.getElementById('alerts-chatid-input')
  if (chatIdInput) chatIdInput.value = state.myAlertsChatId

  const chainSelect = document.getElementById('alerts-chain-select')
  if (chainSelect) {
    chainSelect.innerHTML = state.myAlertsChainOptions
      .map((c) => `<option value="${esc(c.value)}">${esc(c.emoji)} ${esc(c.label)}</option>`)
      .join('')
  }

  renderAlertsTrackOptions()
  renderMyAlerts()
}

/**
 * The "what to track" dropdown: "+ New tracked coin" first (picking it
 * reveals the chain-select + paste-a-CA fields below, for anything not
 * already here), then every shared-watchlist coin this user isn't already
 * tracking. Watchlist coins are offered first because they're the only ones
 * that can actually fire a personal alert right now - a coin tracked here
 * that the monitor never evaluates never generates a trigger to forward.
 */
function renderAlertsTrackOptions() {
  const select = document.getElementById('alerts-track-select')
  if (!select) return

  const alreadyTracked = new Set(state.myAlertsCoins.map((c) => `${c.chainId}:${c.tokenAddress}`))
  const available = state.myAlertsWatchlist.filter((t) => !alreadyTracked.has(`${t.chainId}:${t.tokenAddress}`))

  const options = [
    `<option value="__new__">+ New tracked coin</option>`,
    ...available.map(
      (t) => `<option value="${esc(t.chainId)}:${esc(t.tokenAddress)}">${esc(t.symbol)} — ${esc(t.chainId)}</option>`,
    ),
  ]
  select.innerHTML = options.join('')
  updateAlertsNewCoinVisibility()
}

function updateAlertsNewCoinVisibility() {
  const select = document.getElementById('alerts-track-select')
  const fields = document.getElementById('alerts-new-coin-fields')
  if (!select || !fields) return
  fields.style.display = select.value === '__new__' ? 'flex' : 'none'
}

/**
 * Builds the whole body in one pass and assigns it once - `+=` across two
 * independent branches used to accumulate stale content across repeated
 * calls (every save/add/remove re-renders this same container), so a
 * function called three times in a row left three copies of a message
 * behind rather than the current state.
 */
function renderMyAlerts() {
  const body = document.getElementById('alerts-body')
  if (!body) return

  const parts = []

  if (!state.myAlertsChatId) {
    parts.push(
      `<div class="empty">No Telegram chat ID saved yet - message the bot, then paste the chat ID it gives you above. Coins can still be added below and will start delivering once a chat ID is saved.</div>`,
    )
  }

  if (state.myAlertsCoins.length === 0) {
    parts.push(`<div class="empty">Not tracking any coins yet - paste a contract address above.</div>`)
  } else {
    const rows = state.myAlertsCoins
      .map((t) => {
        const key = `${t.chainId}:${t.tokenAddress}`
        return `
          <tr>
            <td>
              <div class="watch-symbol">${esc(t.symbol)}</div>
              <div class="watch-chain">${esc(t.chainId)}</div>
            </td>
            <td class="num">${esc(relTime(t.addedAt))}</td>
            <td>
              <button class="btn btn-sm btn-danger" data-remove-alert-coin="${esc(key)}" data-symbol="${esc(t.symbol)}">Remove</button>
            </td>
          </tr>`
      })
      .join('')

    parts.push(`
      <table class="watchlist-table">
        <thead>
          <tr>
            <th>Coin</th>
            <th class="num">Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`)
  }

  body.innerHTML = parts.join('')
}

async function saveAlertsChatId() {
  const input = document.getElementById('alerts-chatid-input')
  const errorEl = document.getElementById('alerts-chatid-error')
  const btn = document.getElementById('alerts-chatid-save')
  if (errorEl) errorEl.textContent = ''

  const telegramChatId = input?.value.trim() ?? ''

  if (btn) {
    btn.disabled = true
    btn.textContent = 'Saving…'
  }
  try {
    await api(`/api/guilds/${state.guildId}/telegram-watch/chat-id`, {
      method: 'PUT',
      body: JSON.stringify({ telegramChatId }),
    })
    state.myAlertsChatId = telegramChatId
    toast(telegramChatId ? 'Telegram chat ID saved' : 'Telegram chat ID cleared')
    renderMyAlerts()
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = 'Save chat ID'
    }
  }
}

async function addAlertsCoin() {
  const trackSelect = document.getElementById('alerts-track-select')
  const errorEl = document.getElementById('alerts-add-error')
  const btn = document.getElementById('alerts-add')
  if (errorEl) errorEl.textContent = ''

  let chainId, tokenAddress
  const isNew = !trackSelect || trackSelect.value === '__new__'

  if (isNew) {
    const input = document.getElementById('alerts-ca-input')
    chainId = document.getElementById('alerts-chain-select')?.value
    tokenAddress = input?.value.trim() ?? ''
    if (!tokenAddress) {
      if (errorEl) errorEl.textContent = 'Paste a contract address.'
      return
    }
  } else {
    ;[chainId, tokenAddress] = trackSelect.value.split(':')
  }

  if (btn) {
    btn.disabled = true
    btn.textContent = 'Loading…'
  }
  try {
    await api(`/api/guilds/${state.guildId}/telegram-watch/coins`, {
      method: 'POST',
      body: JSON.stringify({ chainId, tokenAddress }),
    })
    if (isNew) {
      const input = document.getElementById('alerts-ca-input')
      if (input) input.value = ''
    }
    toast('Tracking coin added')
    await loadMyAlerts()
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = '+ Track coin'
    }
  }
}

async function removeAlertsCoin(chainId, tokenAddress, symbol) {
  try {
    await api(
      `/api/guilds/${state.guildId}/telegram-watch/coins/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      { method: 'DELETE' },
    )
    toast(`Stopped tracking ${symbol}`)
    await loadMyAlerts()
  } catch (err) {
    toast(err.message, true)
  }
}

// ----------------------------------------------------------- tracked wallets

const TRACKED_WALLET_CHAINS = ['solana', 'ethereum', 'bsc', 'base', 'robinhood']

/**
 * Read-only leaderboard over an imported "known wallet" list (see
 * pnpm import:wallets). No delete/edit action here: nothing on this page
 * writes to tracked_wallets, the import script does. Filtering is client-side
 * over the already-fetched list - the API's chain/cohort query params exist
 * for a future large list, not needed at today's few-hundred-row size.
 */
function trackedWalletsShell() {
  const chainOptions = TRACKED_WALLET_CHAINS.map((c) => `<option value="${c}">${esc(c)}</option>`).join('')

  return `
    <div class="watchlist-view">
      <div class="charts-head">
        <h2>Tracked Wallets</h2>
        <span class="hint" id="wallets-count">Loading…</span>
      </div>
      <div class="wallets-filters">
        <input type="text" id="wallets-search" placeholder="Search wallet, label, cohort…" class="wallets-search" />
        <select id="wallets-chain-filter">
          <option value="">All chains</option>
          ${chainOptions}
        </select>
        <label class="wallets-fav-filter"><input type="checkbox" id="wallets-fav-only" /> Favourited only</label>
      </div>
      <div id="wallets-body"><div class="empty">Loading…</div></div>
    </div>`
}

function wireTrackedWallets() {
  document.getElementById('wallets-search')?.addEventListener('input', () => {
    document.getElementById('wallets-body').innerHTML = renderTrackedWalletsTable()
  })
  document.getElementById('wallets-chain-filter')?.addEventListener('change', () => {
    document.getElementById('wallets-body').innerHTML = renderTrackedWalletsTable()
  })
  document.getElementById('wallets-fav-only')?.addEventListener('change', () => {
    document.getElementById('wallets-body').innerHTML = renderTrackedWalletsTable()
  })
}

async function loadTrackedWallets() {
  const body = document.getElementById('wallets-body')
  if (!body) return

  let data
  try {
    data = await api(`/api/guilds/${state.guildId}/tracked-wallets`)
  } catch (err) {
    body.innerHTML = `<div class="banner">Could not load tracked wallets: ${esc(err.message)}</div>`
    return
  }

  // A slower guild switch or hash change could land after this resolves -
  // only apply it if we are still looking at the wallets view.
  if (state.view !== 'wallets') return

  state.trackedWallets = data.wallets ?? []

  const countEl = document.getElementById('wallets-count')
  if (countEl) countEl.textContent = `${state.trackedWallets.length} wallets tracked`

  body.innerHTML = renderTrackedWalletsTable()
}

function renderTrackedWalletsTable() {
  if (state.trackedWallets.length === 0) {
    return `<div class="empty">No tracked wallets yet - import a list with pnpm import:wallets.</div>`
  }

  const search = (document.getElementById('wallets-search')?.value ?? '').trim().toLowerCase()
  const chainFilter = document.getElementById('wallets-chain-filter')?.value ?? ''
  const favOnly = document.getElementById('wallets-fav-only')?.checked ?? false

  const filtered = state.trackedWallets.filter((w) => {
    if (chainFilter && w.chainId !== chainFilter) return false
    if (favOnly && !w.favourited) return false
    if (!search) return true
    return [w.wallet, w.label, w.cohort, w.source]
      .filter(Boolean)
      .some((f) => f.toLowerCase().includes(search))
  })

  if (filtered.length === 0) {
    return `<div class="empty">No tracked wallets match that filter.</div>`
  }

  const rows = filtered
    .map((w) => {
      const short = `${w.wallet.slice(0, 5)}…${w.wallet.slice(-5)}`
      const hasScore = w.score !== undefined && w.score !== null
      const positive = hasScore && w.score >= 50

      return `
        <tr${w.active === false ? ' class="wallets-inactive"' : ''}>
          <td>
            ${w.favourited ? '<span title="Favourited">⭐</span> ' : ''}
            <span class="watch-symbol" title="${esc(w.wallet)}">${esc(short)}</span>
            ${w.label ? `<div class="hint">${esc(w.label)}</div>` : ''}
          </td>
          <td><div class="watch-chain">${esc(w.chainId)}</div></td>
          <td>${esc(w.cohort ?? '—')}</td>
          <td class="num">${hasScore ? `<span class="${positive ? 'wallet-score-pos' : 'wallet-score-neg'}">${w.score.toFixed(1)}</span>` : '<span class="watch-tag warn">not scored</span>'}</td>
          <td class="num">${w.winRate30d !== undefined && w.winRate30d !== null ? `${(w.winRate30d * 100).toFixed(0)}%` : '—'}</td>
          <td class="num">${w.totalPnlSol30d !== undefined && w.totalPnlSol30d !== null ? `${w.totalPnlSol30d.toFixed(2)} SOL` : '—'}</td>
          <td class="num">${w.lastActiveAt ? esc(relTime(w.lastActiveAt)) : '—'}</td>
        </tr>`
    })
    .join('')

  return `
    <table class="watchlist-table">
      <thead>
        <tr>
          <th>Wallet</th>
          <th>Chain</th>
          <th>Cohort</th>
          <th class="num">Score</th>
          <th class="num">30d win rate</th>
          <th class="num">30d PnL</th>
          <th class="num">Last active</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

// ----------------------------------------------------------------- setup

/**
 * "Setup" - the companion to the setup guide's "your part / my part" split.
 *
 * Everything the guide has Wayne doing after an invite happens from here:
 * slash commands for this server, the trial channel's three features, the
 * ping role, and the streaming keys. The first three are done by the bot in
 * the request; the keys are queued for the homelab runner, which rewrites the
 * env file and recreates the bot - so the page polls the job through the
 * restart rather than waiting on a response the old process can never send.
 *
 * Values typed here are sent once and never shown again. The status card
 * only ever says whether a key is set.
 */
const SETUP_JOB_POLL_MS = 3_000
/** A job is given this long before the page stops watching it - an env apply is a container rebuild-free recreate plus a health wait, a couple of minutes at most. */
const SETUP_JOB_TIMEOUT_MS = 8 * 60_000

function setupShell() {
  return `
    <div class="setup-view">
      <div class="charts-head">
        <h2>Setup</h2>
        <span class="hint">The steps from the setup guide that happen on this side. Safe to run more than once.</span>
      </div>
      <div id="setup-status"><div class="empty">Loading…</div></div>

      <section class="setup-card">
        <div class="setup-card-head">
          <h3>Connect this server</h3>
          <span class="hint">Registers the slash commands here, switches on the three command features in the trial channel, and sends any streaming keys to the homelab.</span>
        </div>
        <form id="setup-form" autocomplete="off">
          <div class="setup-fields">
            <label class="setup-field">
              <span class="setup-label">Trial channel</span>
              <select class="board-chain-select" name="channelId" id="setup-channel"></select>
              <span class="hint">Market Lookup, Price Alerts and Coin Tracker are switched on here. Leave blank to only register commands.</span>
            </label>
            <label class="setup-field">
              <span class="setup-label">Ping role <em>optional</em></span>
              <select class="board-chain-select" name="roleId" id="setup-role"></select>
              <span class="hint">Applied to Price Alerts, and to any alert feature already on in that channel.</span>
            </label>
          </div>

          <details class="setup-keys" id="setup-keys">
            <summary>Streaming keys <span class="hint">optional - only after the week-4 review</span></summary>
            <div class="setup-keys-body" id="setup-keys-body"></div>
            <div class="hint">Sent once to the homelab and written into the bot's environment. Never stored here, never shown again. Blank fields leave the current value alone. The bot restarts to pick them up, which takes about a minute.</div>
          </details>

          <div class="setup-actions">
            <button type="submit" class="btn btn-primary" id="setup-run">Connect this server</button>
            <span class="board-slot-error" id="setup-error"></span>
          </div>
        </form>
        <div id="setup-steps"></div>
      </section>

      <section class="setup-card">
        <div class="setup-card-head">
          <h3>Bots</h3>
          <span class="hint">Restarts the bot and the Fomo sidecar on the homelab. Alerts pause for about a minute.</span>
        </div>
        <div class="setup-actions">
          <button class="btn" id="setup-restart">Restart bots</button>
          <button class="btn btn-danger" id="setup-restart-confirm" hidden>Yes, restart now</button>
          <button class="btn btn-sm" id="setup-restart-cancel" hidden>Cancel</button>
          <span class="board-slot-error" id="setup-restart-error"></span>
        </div>
        <div id="setup-job"></div>
        <div id="setup-jobs"></div>
      </section>
    </div>`
}

function wireSetup() {
  document.getElementById('setup-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    runSetup()
  })

  const restart = document.getElementById('setup-restart')
  const confirm = document.getElementById('setup-restart-confirm')
  const cancel = document.getElementById('setup-restart-cancel')
  // Two clicks rather than a browser confirm(): the second button appears
  // beside the first, so a slip of the mouse cannot restart anything.
  restart?.addEventListener('click', () => {
    restart.hidden = true
    confirm.hidden = false
    cancel.hidden = false
  })
  cancel?.addEventListener('click', () => {
    restart.hidden = false
    confirm.hidden = true
    cancel.hidden = true
  })
  confirm?.addEventListener('click', () => {
    restart.hidden = false
    confirm.hidden = true
    cancel.hidden = true
    restartBots()
  })
}

function stopSetupPolling() {
  if (state.setupPollTimer) {
    clearTimeout(state.setupPollTimer)
    state.setupPollTimer = null
  }
  state.setupJob = null
}

async function loadSetup() {
  const status = document.getElementById('setup-status')
  if (!status) return

  try {
    state.setup = await api(`/api/guilds/${state.guildId}/setup`)
  } catch (err) {
    status.innerHTML = `<div class="banner">Could not load setup status: ${esc(err.message)}</div>`
    return
  }
  if (state.view !== 'setup') return

  renderSetupStatus()
  renderSetupForm()
  renderSetupJobs()
}

function renderSetupStatus() {
  const s = state.setup
  const el = document.getElementById('setup-status')
  if (!el || !s) return

  const cmdOk = s.commands.registered !== null && s.commands.registered >= s.commands.shipped
  const cmdText = s.commands.registered === null ? '?' : `${s.commands.registered}/${s.commands.shipped}`

  const trialOn = s.trialRows.filter((r) => r.enabled)
  const trialChannels = [...new Set(trialOn.map((r) => r.channelName ? `#${r.channelName}` : r.channelId))]
  const trialText = trialOn.length === 0 ? 'not set' : trialChannels.join(', ')

  const helius = s.env.HELIUS_API_KEY
  const alchemy = s.envKeys.filter((k) => k.group === 'alchemy').map((k) => s.env[k.key])
  const alchemySet = alchemy.filter(Boolean).length

  const runnerText = !s.runner.configured
    ? 'not configured'
    : s.runner.online
      ? 'online'
      : s.runner.lastSeenAt
        ? `last seen ${relTime(s.runner.lastSeenAt)}`
        : 'not seen since the bot started'

  const cards = [
    { k: 'Bot in server', n: '✓', ok: true, sub: `${esc(s.guild.name)} · ${s.guild.memberCount ?? '?'} members` },
    { k: 'Slash commands', n: cmdText, ok: cmdOk, sub: cmdOk ? 'registered here' : 'run Connect to register' },
    { k: 'Trial channel', n: trialOn.length ? '✓' : '–', ok: trialOn.length > 0, sub: esc(trialText) },
    { k: 'Helius', n: helius ? '✓' : '–', ok: helius, sub: helius ? 'key set' : 'no key - Solana at poll speed' },
    { k: 'Alchemy', n: `${alchemySet}/${alchemy.length}`, ok: alchemySet === alchemy.length, sub: alchemySet ? 'endpoints set' : 'none - EVM at poll speed' },
    { k: 'Homelab runner', n: s.runner.online ? '✓' : '–', ok: s.runner.online, sub: runnerText },
  ]

  el.innerHTML = `<div class="stats setup-stats">${cards
    .map(
      (c) => `<div class="stat">
        <div class="n${c.ok ? ' accent' : ''}">${c.n}</div>
        <div class="k">${c.k}</div>
        <div class="setup-stat-sub">${c.sub}</div>
      </div>`,
    )
    .join('')}</div>`
}

function renderSetupForm() {
  const s = state.setup
  if (!s) return

  const channel = document.getElementById('setup-channel')
  if (channel) {
    const current = channel.value
    channel.innerHTML =
      `<option value="">– commands only –</option>` +
      state.channels
        .map(
          (c) =>
            `<option value="${esc(c.id)}"${!c.sendable ? ' disabled' : ''}>#${esc(c.name)}${c.parent ? ` · ${esc(c.parent)}` : ''}${!c.sendable ? ' (bot cannot post here)' : ''}</option>`,
        )
        .join('')
    // Keep a pick across a status reload; otherwise suggest the channel
    // already carrying the trial features, if there is one.
    const existing = s.trialRows.find((r) => r.enabled)?.channelId
    channel.value = current || existing || ''
  }

  const role = document.getElementById('setup-role')
  if (role) {
    const current = role.value
    role.innerHTML =
      `<option value="">– none –</option>` +
      state.roles
        .map((r) => `<option value="${esc(r.id)}">@${esc(r.name)}${r.pingable ? '' : ' (not pingable yet)'}</option>`)
        .join('')
    role.value = current
  }

  const keys = document.getElementById('setup-keys-body')
  if (keys && !keys.dataset.rendered) {
    keys.dataset.rendered = '1'
    const groups = [
      { id: 'helius', title: 'Helius - Solana', note: 'Part two of the guide.' },
      { id: 'alchemy', title: 'Alchemy - Ethereum, BSC and Base', note: 'Part three. Six URLs, HTTPS and WebSocket per chain.' },
    ]
    keys.innerHTML = groups
      .map(
        (g) => `<div class="setup-key-group">
          <div class="setup-key-title">${g.title} <span class="hint">${g.note}</span></div>
          <div class="setup-fields">
            ${s.envKeys
              .filter((k) => k.group === g.id)
              .map(
                (k) => `<label class="setup-field">
                  <span class="setup-label">${esc(k.label)} ${s.env[k.key] ? '<em class="setup-set">set</em>' : ''}</span>
                  <input type="${k.key === 'HELIUS_API_KEY' ? 'password' : 'text'}" class="board-ca-input" name="env.${esc(k.key)}" placeholder="${esc(k.placeholder)}" spellcheck="false" autocomplete="off" />
                </label>`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('')

    if (!s.runner.configured) {
      keys.insertAdjacentHTML(
        'afterbegin',
        `<div class="banner">The homelab runner is not configured, so keys cannot be applied from here. Send them to Wayne by DM instead.</div>`,
      )
    }
  }
}

function renderSetupSteps(steps, target = 'setup-steps') {
  const el = document.getElementById(target)
  if (!el) return
  if (!steps || steps.length === 0) {
    el.innerHTML = ''
    return
  }
  el.innerHTML = `<ul class="setup-steps">${steps
    .map(
      (st) => `<li class="${st.ok ? 'ok' : 'bad'}">
        <span class="setup-step-mark">${st.ok ? '✓' : '✗'}</span>
        <span class="setup-step-name">${esc(st.name)}</span>
        ${st.detail ? `<span class="setup-step-detail">${esc(st.detail)}</span>` : ''}
      </li>`,
    )
    .join('')}</ul>`
}

async function runSetup() {
  const form = document.getElementById('setup-form')
  const button = document.getElementById('setup-run')
  const error = document.getElementById('setup-error')
  if (!form || !button) return

  const data = new FormData(form)
  const body = {}
  const env = {}
  for (const [name, value] of data.entries()) {
    if (name.startsWith('env.')) {
      if (String(value).trim() !== '') env[name.slice(4)] = String(value)
    } else if (String(value) !== '') {
      body[name] = String(value)
    }
  }
  if (Object.keys(env).length > 0) body.env = env

  error.textContent = ''
  button.disabled = true
  renderSetupSteps([])

  try {
    const result = await api(`/api/guilds/${state.guildId}/setup`, { method: 'POST', body: JSON.stringify(body) })
    renderSetupSteps(result.steps)
    // The values have left the page. Clearing the fields is what makes
    // "never shown again" true rather than a promise.
    for (const input of form.querySelectorAll('input[name^="env."]')) input.value = ''

    if (result.jobId) {
      watchSetupJob(result.jobId)
    } else {
      toast(result.ok ? 'Done.' : 'Finished with problems - see below.', !result.ok)
      loadSetup()
    }
  } catch (err) {
    error.textContent = err.message
  } finally {
    button.disabled = false
  }
}

async function restartBots() {
  const error = document.getElementById('setup-restart-error')
  const button = document.getElementById('setup-restart')
  error.textContent = ''
  button.disabled = true
  try {
    const { jobId } = await api(`/api/guilds/${state.guildId}/ops/restart`, { method: 'POST', body: '{}' })
    watchSetupJob(jobId)
  } catch (err) {
    error.textContent = err.message
  } finally {
    button.disabled = false
  }
}

/**
 * Polls one job to its end. Errors are expected in the middle - the job's
 * whole point may be to restart the process answering - so a failed poll is a
 * retry, not a stop. Only the clock ends it early.
 */
function watchSetupJob(jobId) {
  stopSetupPolling()
  state.setupJob = { jobId, startedAt: Date.now() }
  renderSetupJob({ jobId, status: 'queued' })

  const tick = async () => {
    if (state.view !== 'setup' || state.setupJob?.jobId !== jobId) return

    let job
    try {
      ;({ job } = await api(`/api/guilds/${state.guildId}/ops/jobs/${jobId}`))
    } catch {
      job = { jobId, status: 'claimed', restarting: true }
    }
    renderSetupJob(job)

    if (job.status === 'done' || job.status === 'failed') {
      state.setupJob = null
      toast(job.result?.summary ?? (job.status === 'done' ? 'Done.' : 'Failed.'), job.status !== 'done')
      loadSetup()
      return
    }
    if (Date.now() - state.setupJob.startedAt > SETUP_JOB_TIMEOUT_MS) {
      state.setupJob = null
      renderSetupJob({ ...job, timedOut: true })
      loadSetup()
      return
    }
    state.setupPollTimer = setTimeout(tick, SETUP_JOB_POLL_MS)
  }
  state.setupPollTimer = setTimeout(tick, SETUP_JOB_POLL_MS)
}

function renderSetupJob(job) {
  const el = document.getElementById('setup-job')
  if (!el) return

  const label =
    job.timedOut
      ? 'Still running after several minutes. Check the homelab.'
      : job.status === 'queued'
        ? 'Queued - waiting for the homelab runner to pick it up…'
        : job.status === 'claimed'
          ? job.restarting
            ? 'Running - the bot is restarting, this page will reconnect…'
            : 'Running on the homelab…'
          : job.status === 'done'
            ? 'Done.'
            : 'Failed.'

  el.innerHTML = `<div class="setup-job ${job.status}${job.timedOut ? ' bad' : ''}">
    <span class="setup-job-spinner"></span>
    <span>${esc(label)}</span>
    ${job.result?.summary && (job.status === 'done' || job.status === 'failed') ? `<span class="hint">${esc(job.result.summary)}</span>` : ''}
  </div>`
  if (job.result?.steps?.length) {
    el.insertAdjacentHTML('beforeend', `<div id="setup-job-steps-holder"></div>`)
    renderSetupSteps(job.result.steps, 'setup-job-steps-holder')
  }
}

function renderSetupJobs() {
  const el = document.getElementById('setup-jobs')
  const jobs = state.setup?.jobs ?? []
  if (!el) return
  if (jobs.length === 0) {
    el.innerHTML = ''
    return
  }

  const what = (j) =>
    j.type === 'restart'
      ? `Restart ${(j.services ?? []).join(', ')}`
      : `Set ${(j.envKeys ?? []).join(', ')}`

  el.innerHTML = `<table class="watchlist-table setup-jobs">
    <thead><tr><th>When</th><th>What</th><th>By</th><th>Outcome</th></tr></thead>
    <tbody>${jobs
      .map(
        (j) => `<tr>
          <td>${esc(relTime(j.createdAt))}</td>
          <td>${esc(what(j))}</td>
          <td>${esc(j.requestedByName)}</td>
          <td class="setup-job-${j.status}">${esc(j.status)}${j.result?.summary ? ` <span class="hint">${esc(j.result.summary)}</span>` : ''}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`
}

// ----------------------------------------------------------------- holdings

/**
 * Charts of whatever fresh-start's signal-trader currently holds, ordered by
 * market cap. Owner-only (see isOwner) - this bot deliberately does not track
 * wallets or PnL itself, so the data comes from fresh-start's own API on every
 * load rather than anything stored here.
 *
 * Reuses chartKey/chartEmbedUrl/fomoUrl from the Live Charts view - a holdings
 * entry carries the same {chainId, tokenAddress, pairAddress, network} shape,
 * just without a featureId, so the plain (non-launch) 15m/market-cap embed is
 * what renders. The keyed-card diff (same pattern as renderLaunchesColumn) is
 * what keeps a 30s poll from reloading every iframe on every refresh.
 */
function holdingsShell() {
  return `
    <div class="holdings-view">
      <div class="charts-head">
        <h2>Holdings</h2>
        <span class="hint" id="holdings-count">Loading…</span>
      </div>
      <div class="holdings-grid" id="holdings-grid"></div>
    </div>`
}

function stopHoldingsPolling() {
  if (state.holdingsTimer) {
    clearInterval(state.holdingsTimer)
    state.holdingsTimer = null
  }
}

async function loadHoldings() {
  const grid = document.getElementById('holdings-grid')
  if (!grid) return

  let data
  try {
    data = await api(`/api/guilds/${state.guildId}/holdings`)
  } catch (err) {
    grid.innerHTML = `<div class="banner">Could not load holdings: ${esc(err.message)}</div>`
    return
  }

  // A slow poll response landing after the view changed must not paint over
  // whatever is on screen now - same guard loadWatchlist uses.
  if (state.view !== 'holdings') return

  const holdings = data.holdings ?? []

  const countEl = document.getElementById('holdings-count')
  if (countEl) {
    countEl.textContent = data.error
      ? data.error
      : holdings.length === 0
        ? 'Nothing currently held'
        : `${holdings.length} coin${holdings.length === 1 ? '' : 's'} held, by market cap`
  }

  renderHoldingsGrid(holdings)
}

function holdingLabelHtml(entry) {
  const fomo = fomoUrl(entry)
  const title = fomo
    ? `<a class="chart-symbol" href="${esc(fomo)}" target="_blank" rel="noopener noreferrer">${esc(entry.symbol)} ↗</a>`
    : `<span class="chart-symbol">${esc(entry.symbol)}</span>`
  return `
    <span class="chart-badge">${esc(entry.chainId)}</span>
    ${title}`
}

function buildHoldingCard(entry) {
  const card = document.createElement('div')
  card.className = 'chart-card'

  const label = document.createElement('div')
  label.className = 'chart-label'
  label.innerHTML = holdingLabelHtml(entry)

  const iframe = document.createElement('iframe')
  iframe.loading = 'lazy'
  iframe.src = chartEmbedUrl(entry)

  card.append(label, iframe)
  return card
}

function renderHoldingsGrid(holdings) {
  const grid = document.getElementById('holdings-grid')
  if (!grid) return

  if (holdings.length === 0) {
    grid.innerHTML = `<div class="empty">Nothing currently held.</div>`
    state.holdingsCards.clear()
    return
  }

  const wanted = new Map(holdings.map((entry, rank) => [chartKey(entry), { entry, rank }]))

  for (const [key, card] of state.holdingsCards) {
    if (!wanted.has(key)) {
      card.remove()
      state.holdingsCards.delete(key)
    }
  }

  for (const [key, { entry, rank }] of wanted) {
    let card = state.holdingsCards.get(key)
    if (!card) {
      card = buildHoldingCard(entry)
      state.holdingsCards.set(key, card)
      grid.append(card)
    } else {
      card.querySelector('.chart-label').innerHTML = holdingLabelHtml(entry)
    }
    card.style.order = rank
  }
}

function statsStrip() {
  if (!state.stats) return ''
  const enabled = state.instances.filter((i) => i.enabled).length
  return `
    <div class="stats">
      <div class="stat"><div class="n accent">${enabled}</div><div class="k">Active configs</div></div>
      <div class="stat"><div class="n">${state.stats.activeAlerts}</div><div class="k">Live alerts</div></div>
      <div class="stat"><div class="n">${state.stats.alertMembers}</div><div class="k">Members alerting</div></div>
      <div class="stat"><div class="n">${state.stats.launchesToday}</div><div class="k">Launches / 24h</div></div>
    </div>`
}

function featureBlock(feature, index) {
  const rows = state.instances.filter((i) => i.featureId === feature.id)
  const channelRows = rows.filter((i) => i.channelId)
  const guildRow = rows.find((i) => !i.channelId)

  const parts = []

  // Anything that is not a push destination gets a server-wide row, shown even
  // before it is saved so the effective default is visible rather than implied.
  if (feature.kind !== 'push') {
    parts.push(instanceRow(feature, guildRow ?? virtualRow(feature, null)))
  }

  for (const row of channelRows) parts.push(instanceRow(feature, row))

  if (feature.kind === 'push' && channelRows.length === 0) {
    parts.push(`<div class="empty">Not posting anywhere yet. Add a channel below.</div>`)
  }

  const used = new Set(channelRows.map((r) => r.channelId))
  const free = state.channels.filter((c) => !used.has(c.id))

  const addRow = `
    <div class="add-row">
      <span class="label">Add channel</span>
      <select data-add="${esc(feature.id)}" ${free.length ? '' : 'disabled'}>
        <option value="">${free.length ? 'Select a channel…' : 'All channels configured'}</option>
        ${free
          .map(
            (c) =>
              `<option value="${esc(c.id)}"${c.sendable ? '' : ' data-nosend="1"'}>#${esc(c.name)}${c.sendable ? '' : ' (bot cannot post)'}</option>`,
          )
          .join('')}
      </select>
      <span class="hint">${
        feature.kind === 'push'
          ? 'Each channel gets its own filters.'
          : 'A channel override replaces the server-wide setting there.'
      }</span>
    </div>`

  return `
    <section class="feature" style="animation-delay:${index * 55}ms">
      <div class="feature-head">
        <div class="feature-icon">${feature.icon}</div>
        <div style="flex:1">
          <div class="feature-title">${esc(feature.name)}<span class="feature-kind">${KIND_LABEL[feature.kind] ?? feature.kind}</span></div>
          <div class="feature-desc">${esc(feature.description)}</div>
          ${
            feature.commands.length
              ? `<div class="feature-cmds">${feature.commands.map((c) => `<span class="cmd">/${esc(c)}</span>`).join('')}</div>`
              : ''
          }
        </div>
      </div>
      <div class="instances">${parts.join('')}</div>
      ${addRow}
    </section>`
}

/** A row that exists only in the UI until someone touches it. */
function virtualRow(feature, channelId) {
  const settings = {}
  for (const f of feature.settings) settings[f.key] = f.default
  return {
    id: null,
    featureId: feature.id,
    channelId,
    enabled: feature.defaultEnabled,
    label: null,
    settings,
    virtual: true,
  }
}

function instanceRow(feature, row) {
  const key = keyOf(feature.id, row.channelId)
  const isOpen = state.open.has(key)
  const draft = state.drafts.get(key)
  const settings = { ...row.settings, ...(draft ?? {}) }

  const channel = row.channelId ? state.channels.find((c) => c.id === row.channelId) : null
  const name = row.channelId
    ? `<span class="hash">#</span>${esc(channel ? channel.name : row.channelId)}`
    : 'Server-wide'

  const meta = row.virtual
    ? 'using defaults — not configured yet'
    : row.channelId
      ? channel && !channel.sendable
        ? '⚠ bot cannot post in this channel'
        : row.label
          ? esc(row.label)
          : 'channel override'
      : 'applies where no channel override exists'

  return `
    <div class="instance${row.enabled ? ' on' : ''}${isOpen ? ' open' : ''}" data-key="${esc(key)}">
      <div class="instance-head">
        <button class="toggle" role="switch" aria-checked="${row.enabled}"
                data-toggle="${esc(key)}" aria-label="Toggle"></button>
        <span class="state${row.enabled ? ' on' : ''}">${row.enabled ? 'On' : 'Off'}</span>
        <div class="scope">
          <div class="scope-name">${name}</div>
          <div class="scope-meta">${meta}</div>
        </div>
        <button class="btn btn-sm" data-expand="${esc(key)}">
          <span class="chev">▶</span> Settings
        </button>
      </div>
      <div class="settings">
        <div class="fields">
          ${feature.settings.map((f) => fieldHtml(feature, f, settings, key)).join('')}
        </div>
        <div class="actions">
          ${draft ? '<span class="dirty-flag">● unsaved changes</span>' : ''}
          <div class="spacer"></div>
          ${
            row.id && row.channelId
              ? `<button class="btn btn-sm btn-danger" data-delete="${esc(row.id)}">Remove</button>`
              : ''
          }
          <button class="btn btn-sm" data-reset="${esc(key)}" ${draft ? '' : 'disabled'}>Discard</button>
          <button class="btn btn-sm btn-primary" data-save="${esc(key)}" ${draft ? '' : 'disabled'}>Save</button>
        </div>
      </div>
    </div>`
}

// ---------------------------------------------------------------- fields

function fieldHtml(feature, field, settings, key) {
  // showWhen lets a feature hide a setting that only matters in some modes.
  if (field.showWhen) {
    const other = settings[field.showWhen.key]
    const want = field.showWhen.equals
    const match = Array.isArray(other) ? other.includes(want) : other === want
    if (!match) return ''
  }

  const value = settings[field.key]
  const id = `${key}::${field.key}`
  const desc = field.description ? `<div class="fdesc">${esc(field.description)}</div>` : ''
  const wide =
    field.type === 'multiselect' ||
    field.type === 'roles' ||
    field.type === 'string' ||
    field.type === 'bands'
      ? ' wide'
      : ''

  let control = ''

  switch (field.type) {
    case 'boolean':
      control = `
        <div class="field-inline">
          <button class="toggle" role="switch" aria-checked="${!!value}" data-field="${esc(id)}" data-type="boolean"></button>
          <span class="hint">${value ? 'Enabled' : 'Disabled'}</span>
        </div>`
      break

    case 'number':
      control = `
        <div class="with-unit">
          <input type="number" data-field="${esc(id)}" data-type="number"
                 value="${esc(value)}"
                 ${field.min !== undefined ? `min="${field.min}"` : ''}
                 ${field.max !== undefined ? `max="${field.max}"` : ''}
                 ${field.step !== undefined ? `step="${field.step}"` : ''} />
          ${field.unit ? `<span class="unit">${esc(field.unit)}</span>` : ''}
        </div>`
      break

    case 'string':
      control = `<input type="text" data-field="${esc(id)}" data-type="string"
                        value="${esc(value)}"
                        ${field.maxLength ? `maxlength="${field.maxLength}"` : ''}
                        placeholder="${esc(field.placeholder ?? '')}" />`
      break

    case 'select':
      control = `<select data-field="${esc(id)}" data-type="select">
          ${field.options
            .map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`)
            .join('')}
        </select>`
      break

    case 'bands': {
      // A threshold that varies by size. The last row is always the catch-all,
      // so its edge is not editable - leaving a gap above the top band would
      // read as "no limit here" and quietly stop filtering.
      const rows = Array.isArray(value) ? value : []
      const atMax = field.maxRows !== undefined && rows.length >= field.maxRows

      control = `
        <div class="bands">
          <div class="bands-head">
            <span>${esc(field.edgeLabel ?? 'Up to')}</span>
            <span>${esc(field.valueLabel ?? 'Value')}</span>
            <span></span>
          </div>
          ${rows
            .map((row, index) => {
              const last = index === rows.length - 1
              const edge = last
                ? `<span class="band-any">anything above</span>`
                : `<div class="with-unit">
                     <input type="number" data-field="${esc(id)}" data-type="band-edge" data-row="${index}"
                            value="${esc(row.upTo ?? '')}" min="1" />
                     ${field.edgeUnit ? `<span class="unit">${esc(field.edgeUnit)}</span>` : ''}
                   </div>`
              return `
                <div class="bands-row">
                  ${edge}
                  <div class="with-unit">
                    <input type="number" data-field="${esc(id)}" data-type="band-value" data-row="${index}"
                           value="${esc(row.value)}"
                           ${field.min !== undefined ? `min="${field.min}"` : ''}
                           ${field.max !== undefined ? `max="${field.max}"` : ''} />
                    ${field.valueUnit ? `<span class="unit">${esc(field.valueUnit)}</span>` : ''}
                  </div>
                  ${
                    rows.length > 1 && !last
                      ? `<button class="band-x" type="button" data-band-remove="${esc(id)}" data-row="${index}" title="Remove band">×</button>`
                      : '<span></span>'
                  }
                </div>`
            })
            .join('')}
        </div>
        ${
          atMax
            ? `<div class="chips-note">Maximum of ${field.maxRows} bands.</div>`
            : `<button class="btn btn-small" type="button" data-band-add="${esc(id)}">Add band</button>`
        }`
      break
    }

    /*
     * Options come from the guild rather than from the field, because the field
     * cannot know them: they are whatever roles this server has. A stored role
     * that no longer exists is still shown as a chip - dropping it silently
     * would leave an admin looking at a picker that disagrees with what is
     * saved, and it has to be visible to be unpicked.
     */
    case 'roles': {
      const selected = Array.isArray(value) ? value : []
      const missing = selected.filter((id) => !state.roles.some((r) => r.id === id))
      const chip = (roleId, name, colour, pingable) =>
        `<button class="chip" type="button" aria-pressed="${selected.includes(roleId)}"
                 data-field="${esc(id)}" data-type="roles" data-value="${esc(roleId)}"
                 title="${pingable === false ? 'The bot cannot mention this role' : ''}">
           ${colour ? `<span class="role-dot" style="background:${esc(colour)}"></span>` : ''}${esc(name)}${pingable === false ? ' ⚠' : ''}
         </button>`

      control = `
        <div class="chips">
          ${state.roles.map((r) => chip(r.id, r.name, r.colour, r.pingable)).join('')}
          ${missing.map((id) => chip(id, `Deleted role ${id}`, null, true)).join('')}
        </div>
        ${
          state.roles.length === 0
            ? '<div class="chips-note">No roles to show — the bot may not be able to read this server’s roles.</div>'
            : selected.length === 0
              ? '<div class="chips-note">Nobody is pinged. The alert still posts.</div>'
              : ''
        }`
      break
    }

    case 'multiselect': {
      const selected = Array.isArray(value) ? value : []
      control = `
        <div class="chips">
          ${field.options
            .map(
              (o) =>
                `<button class="chip" type="button" aria-pressed="${selected.includes(o.value)}"
                         data-field="${esc(id)}" data-type="multiselect" data-value="${esc(o.value)}">${esc(o.label)}</button>`,
            )
            .join('')}
        </div>
        ${
          field.emptyMeansAll && selected.length === 0
            ? '<div class="chips-note">Nothing selected — all options apply.</div>'
            : ''
        }`
      break
    }
  }

  return `<div class="field${wide}">
      <label class="flabel">${esc(field.label)}</label>
      ${control}
      ${desc}
    </div>`
}

// ---------------------------------------------------------------- events

function wireTopbar() {
  const guild = document.getElementById('guild')
  if (guild) {
    guild.addEventListener('change', async (e) => {
      state.guildId = e.target.value
      localStorage.setItem('guildId', state.guildId)
      state.open.clear()
      await loadGuild()
      render()
    })
  }

  // Navigates by setting the hash rather than state directly - the hashchange
  // listener below is the one place that actually flips state.view, so a
  // pasted or bookmarked #/charts link lands the same way a click does.
  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => {
      if (state.view === btn.dataset.view) return
      location.hash = hashForView(btn.dataset.view)
    })
  }

  document.getElementById('logout')?.addEventListener('click', async () => {
    stopChartsPolling()
    await api('/auth/logout', { method: 'POST' })
    location.href = '/'
  })
}

function wireFeatures() {
  const root = document.getElementById('features')
  if (!root) return

  root.addEventListener('click', onClick)
  root.addEventListener('change', onChange)
  root.addEventListener('input', onInput)
}

function findRow(key) {
  const [featureId, channelId] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)]
  const feature = state.features.find((f) => f.id === featureId)
  const row =
    state.instances.find((i) => i.featureId === featureId && (i.channelId ?? '') === channelId) ??
    virtualRow(feature, channelId || null)
  return { feature, row, channelId: channelId || null }
}

async function onClick(event) {
  const expand = event.target.closest('[data-expand]')
  if (expand) {
    const key = expand.dataset.expand
    state.open.has(key) ? state.open.delete(key) : state.open.add(key)
    return render()
  }

  const toggle = event.target.closest('[data-toggle]')
  if (toggle) return toggleInstance(toggle.dataset.toggle)

  const chip = event.target.closest('.chip[data-field]')
  if (chip) return toggleChip(chip)

  const fieldToggle = event.target.closest('.toggle[data-field]')
  if (fieldToggle) return toggleBooleanField(fieldToggle)

  const bandAdd = event.target.closest('[data-band-add]')
  if (bandAdd) return addBand(bandAdd.dataset.bandAdd)

  const bandRemove = event.target.closest('[data-band-remove]')
  if (bandRemove) return removeBand(bandRemove.dataset.bandRemove, Number(bandRemove.dataset.row))

  const save = event.target.closest('[data-save]')
  if (save) return saveInstance(save.dataset.save)

  const reset = event.target.closest('[data-reset]')
  if (reset) {
    state.drafts.delete(reset.dataset.reset)
    return render()
  }

  const del = event.target.closest('[data-delete]')
  if (del) return removeInstance(del.dataset.delete)
}

function onChange(event) {
  const add = event.target.closest('[data-add]')
  if (add && add.value) return addChannel(add.dataset.add, add.value)

  const field = event.target.closest('select[data-field], input[data-field]')
  if (field) recordDraft(field)
}

function onInput(event) {
  const field = event.target.closest('input[data-field]')
  if (field) recordDraft(field, true)
}

/** Stores an edit without re-rendering, so focus and caret position survive. */
function recordDraft(el, silent = false) {
  const [key, fieldKey] = splitFieldId(el.dataset.field)
  const { feature, row } = findRow(key)
  const spec = feature.settings.find((f) => f.key === fieldKey)

  let value = el.value
  if (spec.type === 'number') {
    value = el.value === '' ? spec.default : Number(el.value)
    if (!Number.isFinite(value)) return
  }

  if (spec.type === 'bands') {
    const rows = currentBands(key, fieldKey, row).map((band) => ({ ...band }))
    const index = Number(el.dataset.row)
    const target = rows[index]
    if (!target) return

    const n = el.value === '' ? null : Number(el.value)
    if (n !== null && !Number.isFinite(n)) return

    if (el.dataset.type === 'band-edge') target.upTo = n
    else target.value = n ?? 0

    value = rows
  }

  const draft = state.drafts.get(key) ?? {}
  draft[fieldKey] = value

  // Drop the draft entirely once every field matches what is stored.
  const merged = { ...row.settings, ...draft }
  const unchanged = Object.keys(draft).every((k) => same(merged[k], row.settings[k]))
  if (unchanged) state.drafts.delete(key)
  else state.drafts.set(key, draft)

  if (!silent) render()
  else refreshActions(key)
}

function toggleBooleanField(el) {
  const [key, fieldKey] = splitFieldId(el.dataset.field)
  const { row } = findRow(key)
  const draft = state.drafts.get(key) ?? {}
  const current = draft[fieldKey] ?? row.settings[fieldKey]
  draft[fieldKey] = !current
  state.drafts.set(key, draft)
  render()
}

/**
 * Splits a field id back into its row key and setting key.
 *
 * The row key ends in a colon for the server-wide row (`call-tracker:`), so the
 * id reads `call-tracker:::volumeFloors` and a plain `split('::')` cuts it in
 * the wrong place - which silently broke editing any setting server-wide. The
 * separator is found from the right, where it is unambiguous.
 */
function splitFieldId(id) {
  const at = id.lastIndexOf('::')
  return [id.slice(0, at), id.slice(at + 2)]
}

/** The band rows as they currently stand, draft included. */
function currentBands(key, fieldKey, row) {
  const draft = state.drafts.get(key) ?? {}
  const value = draft[fieldKey] ?? row.settings[fieldKey] ?? []
  return Array.isArray(value) ? value : []
}

function setBands(key, fieldKey, rows) {
  const draft = state.drafts.get(key) ?? {}
  draft[fieldKey] = rows
  state.drafts.set(key, draft)
  render()
}

/**
 * Adds a band below the catch-all.
 *
 * The new edge starts at double the one before it, which is almost always
 * closer to what someone wants than zero and never produces an invalid set.
 */
function addBand(id) {
  const [key, fieldKey] = splitFieldId(id)
  const { row } = findRow(key)
  const rows = currentBands(key, fieldKey, row).map((band) => ({ ...band }))

  const lastEdge = rows.filter((b) => b.upTo !== null).pop()?.upTo ?? 50_000
  const catchAll = rows.pop() ?? { upTo: null, value: 0 }

  setBands(key, fieldKey, [...rows, { upTo: lastEdge * 2, value: catchAll.value }, catchAll])
}

function removeBand(id, index) {
  const [key, fieldKey] = splitFieldId(id)
  const { row } = findRow(key)
  const rows = currentBands(key, fieldKey, row).filter((_, i) => i !== index)

  setBands(key, fieldKey, rows.length > 0 ? rows : [{ upTo: null, value: 0 }])
}

function toggleChip(el) {
  const [key, fieldKey] = splitFieldId(el.dataset.field)
  const { row } = findRow(key)
  const draft = state.drafts.get(key) ?? {}
  const current = draft[fieldKey] ?? row.settings[fieldKey] ?? []
  const value = el.dataset.value

  draft[fieldKey] = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]

  state.drafts.set(key, draft)
  render()
}

const same = (a, b) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v) => b.includes(v))
    : a === b

/** Cheap partial update so typing does not blow away the input's focus. */
function refreshActions(key) {
  const el = document.querySelector(`.instance[data-key="${CSS.escape(key)}"]`)
  if (!el) return
  const dirty = state.drafts.has(key)
  el.querySelector('[data-save]')?.toggleAttribute('disabled', !dirty)
  el.querySelector('[data-reset]')?.toggleAttribute('disabled', !dirty)
}

// ---------------------------------------------------------------- mutations

async function toggleInstance(key) {
  const { feature, row, channelId } = findRow(key)
  try {
    await api(`/api/guilds/${state.guildId}/instances`, {
      method: 'PUT',
      body: JSON.stringify({ featureId: feature.id, channelId, enabled: !row.enabled }),
    })
    await loadGuild()
    render()
    toast(`${feature.name} ${!row.enabled ? 'enabled' : 'disabled'}${channelId ? '' : ' server-wide'}`)
  } catch (err) {
    toast(err.message, true)
  }
}

async function saveInstance(key) {
  const { feature, row, channelId } = findRow(key)
  const draft = state.drafts.get(key)
  if (!draft) return

  try {
    await api(`/api/guilds/${state.guildId}/instances`, {
      method: 'PUT',
      body: JSON.stringify({
        featureId: feature.id,
        channelId,
        enabled: row.enabled,
        settings: { ...row.settings, ...draft },
      }),
    })
    state.drafts.delete(key)
    await loadGuild()
    render()
    toast(`${feature.name} settings saved`)
  } catch (err) {
    toast(err.message, true)
  }
}

async function addChannel(featureId, channelId) {
  const feature = state.features.find((f) => f.id === featureId)
  try {
    await api(`/api/guilds/${state.guildId}/instances`, {
      method: 'PUT',
      body: JSON.stringify({ featureId, channelId, enabled: true }),
    })
    await loadGuild()
    state.open.add(keyOf(featureId, channelId))
    render()
    toast(`${feature.name} added to #${state.channels.find((c) => c.id === channelId)?.name ?? channelId}`)
  } catch (err) {
    toast(err.message, true)
  }
}

async function removeInstance(instanceId) {
  try {
    await api(`/api/guilds/${state.guildId}/instances/${instanceId}`, { method: 'DELETE' })
    await loadGuild()
    render()
    toast('Configuration removed')
  } catch (err) {
    toast(err.message, true)
  }
}

// ---------------------------------------------------------------- routing

/**
 * Hash-only, so a #/charts link needs no server route: the fragment never
 * reaches Fastify, and the same static index.html + app.js load either way.
 */
const HASH_BY_VIEW = {
  features: '',
  charts: '#/charts',
  history: '#/history',
  watchlist: '#/watchlist',
  wallets: '#/wallets',
  board: '#/board',
  alerts: '#/alerts',
  setup: '#/setup',
  holdings: '#/holdings',
}
const VIEW_BY_HASH = {
  '': 'features',
  '#/': 'features',
  '#/charts': 'charts',
  '#/history': 'history',
  '#/watchlist': 'watchlist',
  '#/wallets': 'wallets',
  '#/board': 'board',
  '#/alerts': 'alerts',
  '#/setup': 'setup',
  '#/holdings': 'holdings',
}

const hashForView = (view) => HASH_BY_VIEW[view] ?? ''
// A direct link/bookmark to #/holdings from a non-owner session falls back to
// the normal landing view rather than rendering a page that can only error -
// the API 403s regardless, this just avoids showing a dead end.
const viewFromHash = (hash) => {
  const view = VIEW_BY_HASH[hash] ?? 'features'
  return view === 'holdings' && !isOwner() ? 'features' : view
}

// Covers back/forward and a hash typed or pasted directly into the address
// bar while the app is already running - a click sets the hash, this is what
// actually applies it, so both paths land the same way.
window.addEventListener('hashchange', () => {
  const next = viewFromHash(location.hash)
  if (next === state.view || !state.guildId) return
  state.view = next
  render()
})

// ---------------------------------------------------------------- rug-warning tooltip

/**
 * One shared floating tooltip for every `.rug-warning` icon, wired once at
 * startup rather than per-render. `.chart-card`/`.chart-label` both clip
 * overflow (for the iframe's sake), so a tooltip anchored inside either would
 * be cut off - `position: fixed`, measured and placed on hover, sidesteps
 * that the same way a native tooltip would.
 */
let rugTooltipEl = null

function rugTooltip() {
  if (!rugTooltipEl) {
    rugTooltipEl = document.createElement('div')
    rugTooltipEl.className = 'rug-tooltip'
    document.body.append(rugTooltipEl)
  }
  return rugTooltipEl
}

function positionRugTooltip(tip, anchor) {
  const margin = 8
  const rect = anchor.getBoundingClientRect()

  tip.style.visibility = 'hidden'
  tip.style.display = 'block'
  const tipRect = tip.getBoundingClientRect()

  let left = Math.min(rect.left, window.innerWidth - tipRect.width - margin)
  let top = rect.bottom + margin
  if (top + tipRect.height > window.innerHeight - margin) top = rect.top - tipRect.height - margin

  tip.style.left = `${Math.max(margin, left)}px`
  tip.style.top = `${Math.max(margin, top)}px`
  tip.style.visibility = 'visible'
}

document.body.addEventListener('mouseover', (event) => {
  const btn = event.target.closest('.rug-warning')
  if (!btn) return
  const tip = rugTooltip()
  tip.textContent = btn.dataset.rugDetail
  positionRugTooltip(tip, btn)
})

document.body.addEventListener('mouseout', (event) => {
  if (!event.target.closest('.rug-warning')) return
  if (rugTooltipEl) rugTooltipEl.style.display = 'none'
})

boot().catch((err) => {
  document.getElementById('app').innerHTML =
    `<div class="banner">Could not load the dashboard: ${esc(err.message)}</div>`
})
