/**
 * The Fomo feed page.
 *
 * Backfill over REST, then stay attached over SSE. The two halves overlap on
 * purpose: every (re)connect re-fetches, so an event that arrived while the
 * stream was down is not a hole in the record - it just arrives as part of the
 * next backfill rather than as a live row.
 *
 * Everything on this page is built with DOM nodes and `textContent`, never
 * innerHTML. A thesis is arbitrary text written by a stranger on a site we do
 * not control, and it reaches this page unescaped from Fomo's API. Rendering it
 * as markup would be a stored XSS with extra steps.
 */

const feedEl = document.getElementById('feed')
const feedEmptyEl = document.getElementById('feed-empty')
const tradesEl = document.getElementById('trades')
const tradesEmptyEl = document.getElementById('trades-empty')
const summaryEl = document.getElementById('trade-summary')
const filterTextEl = document.getElementById('filter-text')

const streamLight = document.getElementById('stream-light')
const streamLabel = document.getElementById('stream-label')
const feedLight = document.getElementById('feed-light')
const feedLabel = document.getElementById('feed-label')

/** Newest first, and the only copy of the list the page holds. */
let alerts = []
let trades = []
/** eventId -> number of trades taken on it, for the "traded" badge. */
let tradesByEvent = new Map()

let activeKind = ''
let activeText = ''

// --- formatting ----------------------------------------------------------

const usd = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

const price = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  // Meme tokens price in the tenth decimal; a fixed precision shows $0.00.
  if (n > 0 && n < 0.01) return `$${n.toPrecision(3)}`
  return `$${n.toFixed(4)}`
}

const pct = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : null

function ago(iso) {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86_400)}d`
}

/** A node with text set safely. The only way this page puts strings on screen. */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

// --- rendering -----------------------------------------------------------

/**
 * The ticker, as a link to Fomo where one can be built.
 *
 * Fomo covers every chain these alerts arrive on, so this is almost always a
 * link - but a chain its slug map does not know produces plain text rather than
 * a guessed URL, because a 404 in front of someone about to trade is worse than
 * no link at all. The server decides; this only renders what it was given.
 */
function tickerNode(alert) {
  const label = `$${alert.ticker}`
  if (!alert.fomoUrl) return el('span', 'fomo-ticker', label)

  const a = el('a', 'fomo-ticker fomo-link', label)
  a.href = alert.fomoUrl
  a.target = '_blank'
  // noopener: the opened page must not get a handle on this one via window.opener.
  a.rel = 'noopener noreferrer'
  a.title = `Open ${alert.ticker} on Fomo`
  return a
}

/** A named venue link beside the ticker. Only ever built from a server-supplied URL. */
function venueLink(label, url) {
  const a = el('a', 'fomo-venue', label)
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.title = `Open on ${label}`
  return a
}

function matchesFilter(alert) {
  if (activeKind && alert.kind !== activeKind) return false
  if (!activeText) return true
  const needle = activeText.toLowerCase()
  return (
    (alert.traderHandle ?? '').toLowerCase().includes(needle) ||
    (alert.traderName ?? '').toLowerCase().includes(needle) ||
    (alert.ticker ?? '').toLowerCase().includes(needle)
  )
}

function alertRow(alert, isNew) {
  const li = el('li', 'fomo-row')
  li.dataset.kind = alert.kind
  li.dataset.eventId = alert.eventId
  if (isNew) li.classList.add('is-new')

  const body = el('div', 'fomo-body')

  const head = el('div', 'fomo-head')
  head.append(el('span', 'fomo-kind', alert.kind))
  head.append(el('span', 'fomo-trader', alert.traderHandle ?? alert.traderName ?? 'unknown'))
  if (alert.traderVerified) {
    const tick = el('span', 'fomo-verified', '✓')
    tick.title = 'Verified on Fomo'
    head.append(tick)
  }
  if (alert.ticker) head.append(tickerNode(alert))
  if (alert.axiomUrl) head.append(venueLink('Axiom', alert.axiomUrl))

  const tradeCount = tradesByEvent.get(alert.eventId) ?? 0
  if (tradeCount > 0) {
    head.append(el('span', 'fomo-traded', tradeCount === 1 ? 'traded' : `traded ×${tradeCount}`))
  }
  body.append(head)

  const meta = el('div', 'fomo-meta')
  const bits = []
  if (alert.kind !== 'THESIS') {
    const amount = usd(alert.usdAmount)
    if (amount) bits.push(`${amount} ${alert.kind === 'BUY' ? 'in' : 'out'}`)
    const p = price(alert.price)
    if (p) bits.push(p)
    const mc = usd(alert.marketCap)
    if (mc) bits.push(`mc ${mc}`)
  } else if (alert.position) {
    const held = usd(alert.position.usdValue)
    if (held) bits.push(`holding ${held}`)
    const upnl = pct(alert.position.percentageUnrealizedPnl)
    if (upnl) bits.push(`unrealised ${upnl}`)
  }
  if (alert.chainId) bits.push(alert.chainId)
  for (const bit of bits) meta.append(el('span', null, bit))
  if (bits.length > 0) body.append(meta)

  if (alert.kind === 'THESIS' && alert.thesis) {
    const p = el('p', 'fomo-thesis', alert.thesis)
    body.append(p)
    // Only offer the control when there is something hidden to reveal. Measured
    // after insert, so this is deferred to the next frame.
    requestAnimationFrame(() => {
      if (p.scrollHeight > p.clientHeight + 2) {
        const more = el('button', 'fomo-more', 'Show more')
        more.addEventListener('click', () => {
          const open = p.classList.toggle('is-open')
          more.textContent = open ? 'Show less' : 'Show more'
        })
        p.after(more)
      }
    })
  }

  const when = el('div', 'fomo-when', ago(alert.createdAt))
  when.dataset.at = alert.createdAt
  when.title = new Date(alert.createdAt).toLocaleString()

  li.append(body, when)
  return li
}

function renderFeed() {
  const shown = alerts.filter(matchesFilter)
  feedEl.replaceChildren(...shown.map((a) => alertRow(a, false)))
  feedEmptyEl.hidden = shown.length > 0
  if (shown.length === 0 && alerts.length > 0) {
    feedEmptyEl.textContent = 'No alerts match that filter.'
  }
}

function tradeRow(trade) {
  const li = el('li', 'fomo-trade')

  const head = el('div', 'fomo-trade-head')
  head.append(el('strong', null, `${trade.side} ${trade.ticker ?? '?'}`))
  const mode = el('span', 'fomo-mode', trade.mode)
  mode.dataset.mode = trade.mode
  head.append(mode)
  li.append(head)

  const meta = el('div', 'fomo-meta')
  const amount = usd(trade.usdAmount)
  if (amount) meta.append(el('span', null, amount))
  if (typeof trade.pnlUsd === 'number') {
    const p = el('span', 'fomo-pnl', `${usd(trade.pnlUsd)}${pct(trade.pnlPct) ? ` (${pct(trade.pnlPct)})` : ''}`)
    p.dataset.sign = trade.pnlUsd >= 0 ? 'up' : 'down'
    meta.append(p)
  }
  meta.append(el('span', 'fomo-status', trade.status))
  meta.append(el('span', null, trade.source))
  li.append(meta)

  return li
}

function renderTrades() {
  tradesEl.replaceChildren(...trades.map(tradeRow))
  tradesEmptyEl.hidden = trades.length > 0
}

function renderSummary(summary) {
  summaryEl.replaceChildren()
  // Never a combined total. A paper fill and a live fill are not the same
  // evidence, and one number that adds them is a number that gets believed.
  for (const row of summary) {
    const div = el('div', 'fomo-summary-row')
    const mode = el('span', 'fomo-mode', row.mode)
    mode.dataset.mode = row.mode
    div.append(mode)

    const right = el('span', null)
    const realised = usd(row.realisedUsd)
    right.textContent = `${row.trades} trade${row.trades === 1 ? '' : 's'}` +
      (row.closed > 0 && realised ? ` · ${realised}` : '')
    div.append(right)
    summaryEl.append(div)
  }
}

function renderStats() {
  const count = (kind) => alerts.filter((a) => a.kind === kind).length
  document.getElementById('stat-buy').textContent = count('BUY')
  document.getElementById('stat-sell').textContent = count('SELL')
  document.getElementById('stat-thesis').textContent = count('THESIS')

  const volume = alerts
    .filter((a) => a.kind === 'BUY' || a.kind === 'SELL')
    .reduce((sum, a) => sum + (typeof a.usdAmount === 'number' ? a.usdAmount : 0), 0)
  document.getElementById('stat-usd').textContent = usd(volume) ?? '–'

  document.getElementById('stat-last').textContent = alerts.length > 0 ? `${ago(alerts[0].createdAt)} ago` : '–'
}

/** Re-stamp the relative times in place, without rebuilding a single row. */
function tickTimes() {
  for (const node of feedEl.querySelectorAll('.fomo-when')) {
    node.textContent = ago(node.dataset.at)
  }
  if (alerts.length > 0) {
    document.getElementById('stat-last').textContent = `${ago(alerts[0].createdAt)} ago`
  }
}

// --- data ----------------------------------------------------------------

function showError(message) {
  let box = document.getElementById('fomo-error')
  if (!box) {
    box = el('div', 'fomo-error')
    box.id = 'fomo-error'
    document.querySelector('.fomo-main').prepend(box)
  }
  box.textContent = message
}

function clearError() {
  document.getElementById('fomo-error')?.remove()
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (res.status === 401) {
    location.href = '/'
    throw new Error('not signed in')
  }
  if (!res.ok) throw new Error(`${url} responded ${res.status}`)
  return res.json()
}

function indexTrades() {
  tradesByEvent = new Map()
  for (const t of trades) {
    tradesByEvent.set(t.eventId, (tradesByEvent.get(t.eventId) ?? 0) + 1)
  }
}

async function backfill() {
  try {
    const [alertData, tradeData] = await Promise.all([
      getJson('/api/fomo/alerts?limit=200'),
      getJson('/api/fomo/trades?limit=200'),
    ])
    alerts = alertData.alerts ?? []
    trades = tradeData.trades ?? []
    indexTrades()
    renderFeed()
    renderTrades()
    renderSummary(tradeData.summary ?? [])
    renderStats()
    clearError()
  } catch (err) {
    showError(`Could not load the record: ${err.message}`)
  }
}

async function refreshHealth() {
  try {
    const health = await getJson('/api/fomo/health')
    const state = health.state ?? 'unknown'
    feedLight.dataset.state = state
    feedLabel.textContent =
      state === 'AUTH_REQUIRED' ? 'session expired' : `feed ${state.toLowerCase()}`
  } catch {
    // A health call that fails is not worth a banner - the stream light already
    // says whether this page is talking to the bot.
    feedLight.dataset.state = 'unknown'
    feedLabel.textContent = 'feed ?'
  }
}

// --- live ----------------------------------------------------------------

function setStream(state, label) {
  streamLight.dataset.state = state
  streamLabel.textContent = label
}

function onLiveAlert(alert) {
  // The stream and a backfill can both deliver the same event around a
  // reconnect. eventId is the dedup key end to end, so use it here too.
  if (alerts.some((a) => a.eventId === alert.eventId)) return
  alerts.unshift(alert)
  if (alerts.length > 200) alerts.length = 200

  renderStats()
  if (!matchesFilter(alert)) return

  feedEmptyEl.hidden = true
  const row = alertRow(alert, true)
  feedEl.prepend(row)
  // Keep the DOM the same length as the model.
  while (feedEl.children.length > 200) feedEl.lastElementChild.remove()
}

function onLiveTrade(trade) {
  const i = trades.findIndex((t) => t.tradeRef === trade.tradeRef)
  if (i >= 0) trades[i] = trade
  else trades.unshift(trade)
  indexTrades()
  renderTrades()

  // The badge on the alert this trade belongs to may have just appeared.
  const row = feedEl.querySelector(`[data-event-id="${CSS.escape(trade.eventId)}"]`)
  if (row && !row.querySelector('.fomo-traded')) {
    const count = tradesByEvent.get(trade.eventId) ?? 1
    row
      .querySelector('.fomo-head')
      .append(el('span', 'fomo-traded', count === 1 ? 'traded' : `traded ×${count}`))
  }
  void refreshSummary()
}

/**
 * An Axiom link that resolved after its alert was already on screen.
 *
 * Added in place rather than by re-rendering the row: re-rendering would restart
 * the arrival flash on an alert that is no longer new, which reads as a second
 * event.
 */
function onLiveLinks(event) {
  const alert = alerts.find((a) => a.eventId === event.eventId)
  if (alert) alert.axiomUrl = event.axiomUrl

  const row = feedEl.querySelector(`[data-event-id="${CSS.escape(event.eventId)}"]`)
  if (!row || row.querySelector('.fomo-venue')) return
  row.querySelector('.fomo-head')?.append(venueLink('Axiom', event.axiomUrl))
}

async function refreshSummary() {
  try {
    const data = await getJson('/api/fomo/trades?limit=1')
    renderSummary(data.summary ?? [])
  } catch {
    // Leave the previous totals on screen rather than blanking them.
  }
}

function connect() {
  setStream('connecting', 'connecting')
  const source = new EventSource('/api/fomo/stream', { withCredentials: true })

  source.addEventListener('ready', () => setStream('live', 'live'))

  source.addEventListener('overloaded', () => {
    // The server refused us because it is at its subscriber cap. Reconnecting
    // immediately would just be refused again, so stop and say so.
    setStream('offline', 'too many tabs')
    source.close()
  })

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data)
      if (event.type === 'alert') onLiveAlert(event.alert)
      else if (event.type === 'trade') onLiveTrade(event.trade)
      else if (event.type === 'links') onLiveLinks(event)
    } catch {
      // One malformed frame is not a reason to drop the connection.
    }
  }

  source.onerror = () => {
    // EventSource reconnects on its own; this only reflects it in the UI. The
    // backfill on the next `ready` is what closes any gap the drop left.
    if (source.readyState === EventSource.CLOSED) {
      setStream('offline', 'disconnected')
      // Closed for good - EventSource will not retry this one.
      setTimeout(connect, 5000)
    } else {
      setStream('connecting', 'reconnecting')
    }
  }

  // Any transition back to live re-syncs, because a live row we missed while
  // disconnected would otherwise never appear.
  source.addEventListener('ready', () => void backfill())
}

// --- wiring --------------------------------------------------------------

for (const tab of document.querySelectorAll('.fomo-tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.fomo-tab')) {
      other.classList.toggle('is-on', other === tab)
      other.setAttribute('aria-selected', other === tab ? 'true' : 'false')
    }
    activeKind = tab.dataset.kind ?? ''
    renderFeed()
  })
}

let filterTimer
filterTextEl.addEventListener('input', () => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    activeText = filterTextEl.value.trim()
    renderFeed()
  }, 150)
})

setInterval(tickTimes, 30_000)
setInterval(() => void refreshHealth(), 60_000)

void backfill()
void refreshHealth()
connect()
