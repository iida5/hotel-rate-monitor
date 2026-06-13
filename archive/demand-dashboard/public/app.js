// 日本ホテル需要 リアルタイムダッシュボード - フロントエンド
//
// /api/stream (Server-Sent Events) を購読し、2秒ごとに
// 地図・KPI・チャート・ランキング・フィードを更新する。

'use strict'

const $ = id => document.getElementById(id)

// ---------- 状態 ----------
const state = {
  meta: [],                 // 都道府県マスタ
  metaById: new Map(),
  latest: new Map(),        // id -> 最新値 {d, occ, adr, rev, s, tr}
  prevKpi: null,
  national: [],             // 全国需要指数の履歴 [{t, d}]
  selected: null,           // 選択中の都道府県ID
  sparkHistory: [],         // 選択県の履歴
  seenFeedIds: new Set(),
  tickSinceHotelRefresh: 0,
}

const HISTORY_MAX = 300
const ALERT_THRESHOLD = 82

// ---------- カラースケール (需要指数 0-100 → 色) ----------
const COLOR_STOPS = [
  [0,   [23, 37, 79]],    // 深紺
  [35,  [37, 99, 235]],   // 青
  [55,  [14, 165, 233]],  // 水色
  [70,  [250, 204, 21]],  // 黄
  [85,  [249, 115, 22]],  // 橙
  [100, [239, 68, 68]],   // 赤
]

function demandColor(d) {
  const v = Math.max(0, Math.min(100, d))
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [p1, c1] = COLOR_STOPS[i - 1]
    const [p2, c2] = COLOR_STOPS[i]
    if (v <= p2) {
      const t = (v - p1) / (p2 - p1)
      const rgb = c1.map((a, k) => Math.round(a + (c2[k] - a) * t))
      return `rgb(${rgb.join(',')})`
    }
  }
  return 'rgb(239,68,68)'
}

// タイル上の文字色: 黄色系の明るい背景では黒文字にする
function textColor(d) {
  return (d >= 58 && d < 82) ? '#0b1220' : '#f4f7fb'
}

// ---------- 地図の構築 ----------
const SVG_NS = 'http://www.w3.org/2000/svg'
const CELL = 50, TILE = 44, PAD = 4
const tileEls = new Map() // id -> {g, rect, nameEl, valEl}

function buildMap() {
  const svg = $('map')
  for (const p of state.meta) {
    const x = p.gx * CELL + PAD
    const y = p.gy * CELL + PAD

    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('class', 'tile')
    g.dataset.id = p.id

    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', x); rect.setAttribute('y', y)
    rect.setAttribute('width', TILE); rect.setAttribute('height', TILE)
    rect.setAttribute('rx', 7)
    rect.setAttribute('fill', '#17254f')
    rect.setAttribute('stroke', '#0b1220')
    rect.setAttribute('stroke-width', '1')

    const nameEl = document.createElementNS(SVG_NS, 'text')
    nameEl.setAttribute('x', x + TILE / 2); nameEl.setAttribute('y', y + 17)
    nameEl.setAttribute('text-anchor', 'middle')
    nameEl.setAttribute('class', 't-name')
    nameEl.textContent = p.name

    const valEl = document.createElementNS(SVG_NS, 'text')
    valEl.setAttribute('x', x + TILE / 2); valEl.setAttribute('y', y + 35)
    valEl.setAttribute('text-anchor', 'middle')
    valEl.setAttribute('class', 't-val')
    valEl.textContent = '--'

    const title = document.createElementNS(SVG_NS, 'title')
    title.textContent = p.name

    g.append(rect, nameEl, valEl, title)
    g.addEventListener('click', () => selectPref(p.id))
    svg.appendChild(g)
    tileEls.set(p.id, { g, rect, nameEl, valEl, title })
  }
}

function updateMap() {
  for (const [id, t] of tileEls) {
    const v = state.latest.get(id)
    if (!v) continue
    const color = demandColor(v.d)
    const tc = textColor(v.d)
    t.rect.setAttribute('fill', color)
    t.nameEl.setAttribute('fill', tc)
    t.valEl.setAttribute('fill', tc)
    t.valEl.textContent = Math.round(v.d)
    t.g.classList.toggle('alert', v.d >= ALERT_THRESHOLD)
    t.g.classList.toggle('selected', id === state.selected)
    const m = state.metaById.get(id)
    t.title.textContent =
      `${m.name}\n需要指数: ${v.d}\n稼働率: ${v.occ}%\nADR: ¥${v.adr.toLocaleString()}\n検索: ${v.s.toLocaleString()}/分`
  }
}

// ---------- KPI ----------
function setDelta(el, diff, fmt = v => v.toFixed(1)) {
  if (diff == null) { el.textContent = ''; return }
  const cls = diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : ''
  el.className = 'kpi-delta ' + cls
  el.textContent = (diff >= 0 ? '▲ +' : '▼ ') + fmt(diff)
}

function updateKpis(kpi) {
  $('kpi-demand').textContent = kpi.demand.toFixed(1)
  $('kpi-occ').textContent = kpi.occ.toFixed(1) + '%'
  $('kpi-adr').textContent = '¥' + kpi.adr.toLocaleString()
  $('kpi-alerts').textContent = kpi.alerts.length

  const names = kpi.alerts.slice(0, 4).map(id => state.metaById.get(id)?.name).filter(Boolean)
  $('kpi-alert-names').textContent = names.length
    ? names.join('・') + (kpi.alerts.length > 4 ? ' 他' : '')
    : '現在アラートなし'

  if (state.prevKpi) {
    setDelta($('kpi-demand-delta'), kpi.demand - state.prevKpi.demand)
    setDelta($('kpi-occ-delta'), kpi.occ - state.prevKpi.occ, v => v.toFixed(1) + 'pt')
    setDelta($('kpi-adr-delta'), kpi.adr - state.prevKpi.adr, v => '¥' + Math.abs(Math.round(v)).toLocaleString())
  }
  state.prevKpi = kpi
}

// ---------- 折れ線チャート ----------
function drawLineChart(canvas, points, { min = 0, max = 100, color = '#38bdf8' } = {}) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight || Number(canvas.getAttribute('height'))
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)
  if (points.length < 2) return

  // 値域は実データに少し余白を持たせてフィット
  const vals = points.map(p => p.d)
  const lo = Math.max(min, Math.floor(Math.min(...vals) - 6))
  const hi = Math.min(max, Math.ceil(Math.max(...vals) + 6))
  const X = i => (i / (points.length - 1)) * (w - 38) + 4
  const Y = v => h - 18 - ((v - lo) / (hi - lo)) * (h - 30)

  // 横グリッド線と目盛り
  ctx.strokeStyle = 'rgba(139,155,184,0.15)'
  ctx.fillStyle = 'rgba(139,155,184,0.8)'
  ctx.font = '10px sans-serif'
  ctx.lineWidth = 1
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3
    const y = Y(v)
    ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(w - 34, y); ctx.stroke()
    ctx.fillText(v.toFixed(0), w - 28, y + 3)
  }

  // 面グラデーション
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, color + '55')
  grad.addColorStop(1, color + '00')
  ctx.beginPath()
  points.forEach((p, i) => i === 0 ? ctx.moveTo(X(i), Y(p.d)) : ctx.lineTo(X(i), Y(p.d)))
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.lineTo(X(points.length - 1), h - 18)
  ctx.lineTo(X(0), h - 18)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  // 最新値マーカー
  const last = points[points.length - 1]
  ctx.beginPath()
  ctx.arc(X(points.length - 1), Y(last.d), 3.5, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

// ---------- ランキング ----------
function updateRanking() {
  const rows = [...state.latest.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 10)

  const ol = $('ranking')
  ol.innerHTML = ''
  rows.forEach((r, i) => {
    const m = state.metaById.get(r.id)
    const li = document.createElement('li')
    li.className = 'rank-row'
    li.innerHTML = `
      <span class="rank-no ${i < 3 ? 'top' : ''}">${i + 1}</span>
      <span class="rank-name">${m.name}</span>
      <span class="rank-bar-wrap"><span class="rank-bar" style="width:${r.d}%;background:${demandColor(r.d)}"></span></span>
      <span class="rank-val">${r.d.toFixed(1)}</span>
      <span class="rank-tr ${r.tr > 0.5 ? 'up' : r.tr < -0.5 ? 'down' : ''}">${r.tr > 0.5 ? '▲' : r.tr < -0.5 ? '▼' : '─'}${Math.abs(r.tr).toFixed(1)}</span>`
    li.addEventListener('click', () => selectPref(r.id))
    ol.appendChild(li)
  })
}

// ---------- フィード ----------
function updateFeed(feed) {
  const ul = $('feed')
  // 新着のみ先頭に追加 (サーバーは新しい順で送ってくる)
  for (const item of [...feed].reverse()) {
    if (state.seenFeedIds.has(item.id)) continue
    state.seenFeedIds.add(item.id)
    const li = document.createElement('li')
    if (item.boost < 0) li.classList.add('negative')
    const time = new Date(item.t).toLocaleTimeString('ja-JP')
    const place = item.muniName ? `${item.prefName}・${item.muniName}` : item.prefName
    li.innerHTML = `
      <span class="feed-time">${time}</span>
      <span>【${place}】${item.label}</span>
      <span class="feed-boost ${item.boost >= 0 ? 'up' : 'down'}">${item.boost >= 0 ? '+' : ''}${item.boost}pt</span>`
    ul.prepend(li)
  }
  while (ul.children.length > 25) ul.removeChild(ul.lastChild)
}

// ---------- 詳細パネル ----------
async function selectPref(id) {
  state.selected = id
  const m = state.metaById.get(id)
  $('detail').classList.remove('hidden')
  $('detail-title').textContent = `${m.name} (${m.region}地方)`

  const [hist, hotels, munis] = await Promise.all([
    fetch(`/api/history?pref=${id}`).then(r => r.json()),
    fetch(`/api/hotels?pref=${id}`).then(r => r.json()),
    fetch(`/api/municipalities?pref=${id}`).then(r => r.json()),
  ])
  if (state.selected !== id) return // 取得中に別の県が選ばれたら破棄
  state.sparkHistory = hist.pref
  renderDetailStats()
  renderHotels(hotels)
  renderMunis(munis)
  drawLineChart($('spark'), state.sparkHistory, { color: '#a78bfa' })
  updateMap()
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function renderDetailStats() {
  const v = state.latest.get(state.selected)
  if (!v) return
  const items = [
    ['需要指数', v.d.toFixed(1)],
    ['稼働率', v.occ.toFixed(1) + '%'],
    ['ADR', '¥' + v.adr.toLocaleString()],
    ['RevPAR', '¥' + v.rev.toLocaleString()],
    ['検索数/分', v.s.toLocaleString()],
    ['直近1分変化', (v.tr >= 0 ? '+' : '') + v.tr.toFixed(1) + 'pt'],
  ]
  $('detail-stats').innerHTML = items
    .map(([l, val]) => `<div class="dstat"><div class="l">${l}</div><div class="v">${val}</div></div>`)
    .join('')
}

function renderMunis(munis) {
  $('muni-rows').innerHTML = munis.map(m => `
    <li class="muni-row">
      <span class="muni-name" title="${m.name}">${m.name}</span>
      <span class="rank-bar-wrap"><span class="rank-bar" style="width:${m.d}%;background:${demandColor(m.d)}"></span></span>
      <span class="muni-val">${m.d.toFixed(1)}</span>
      <span class="muni-occ">${m.occ.toFixed(1)}%</span>
      <span class="muni-adr">¥${m.adr.toLocaleString()}</span>
    </li>`).join('')
}

function renderHotels(hotels) {
  $('hotel-rows').innerHTML = hotels.map(h => {
    const color = h.occ >= 90 ? 'var(--red)' : h.occ >= 70 ? 'var(--yellow)' : 'var(--green)'
    return `<tr>
      <td>${h.name}</td>
      <td>${h.rooms}</td>
      <td><span class="occ-badge" style="color:${color}">${h.occ.toFixed(1)}%</span></td>
      <td>¥${h.adr.toLocaleString()}</td>
    </tr>`
  }).join('')
}

$('detail-close').addEventListener('click', () => {
  state.selected = null
  $('detail').classList.add('hidden')
  updateMap()
})

// ---------- SSE 受信 ----------
function onTick(msg) {
  for (const p of msg.prefs) state.latest.set(p.id, p)

  state.national.push({ t: msg.t, d: msg.kpi.demand })
  if (state.national.length > HISTORY_MAX) state.national.shift()

  $('source-badge').textContent = 'データ: ' + msg.source

  updateMap()
  updateKpis(msg.kpi)
  drawLineChart($('trend'), state.national)
  updateRanking()
  updateFeed(msg.feed)

  // 選択中の県があればスパークラインとステータスも追従
  if (state.selected) {
    const v = state.latest.get(state.selected)
    state.sparkHistory.push({ t: msg.t, d: v.d })
    if (state.sparkHistory.length > HISTORY_MAX) state.sparkHistory.shift()
    renderDetailStats()
    drawLineChart($('spark'), state.sparkHistory, { color: '#a78bfa' })
    const sel = state.selected
    fetch(`/api/municipalities?pref=${sel}`).then(r => r.json())
      .then(m => { if (state.selected === sel) renderMunis(m) })
    if (++state.tickSinceHotelRefresh >= 5) {
      state.tickSinceHotelRefresh = 0
      fetch(`/api/hotels?pref=${sel}`).then(r => r.json())
        .then(h => { if (state.selected === sel) renderHotels(h) })
    }
  }
}

function connect() {
  const es = new EventSource('/api/stream')
  const conn = $('conn')
  es.onopen = () => { conn.className = 'conn live'; conn.lastChild.textContent = 'LIVE' }
  es.onerror = () => { conn.className = 'conn dead'; conn.lastChild.textContent = '再接続中...' }
  es.onmessage = e => {
    try { onTick(JSON.parse(e.data)) } catch (err) { console.error(err) }
  }
}

// ---------- 時計 ----------
setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('ja-JP')
}, 1000)

// ---------- 初期化 ----------
async function init() {
  const [meta, hist, snapshot] = await Promise.all([
    fetch('/api/meta').then(r => r.json()),
    fetch('/api/history?pref=13').then(r => r.json()),
    fetch('/api/snapshot').then(r => r.json()),
  ])
  state.meta = meta
  state.metaById = new Map(meta.map(p => [p.id, p]))
  state.national = hist.national.map(p => ({ t: p.t, d: p.d }))
  buildMap()
  onTick(snapshot)
  connect()
}

window.addEventListener('resize', () => {
  drawLineChart($('trend'), state.national)
  if (state.selected) drawLineChart($('spark'), state.sparkHistory, { color: '#a78bfa' })
})

init()
