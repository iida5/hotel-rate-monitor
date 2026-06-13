// 自社との差額ヒートマップ - フロントエンド
//
// /api/rateshop/stream (SSE) のスナップショット (grid) を購読し、
// 「競合の最安値 − 自社の最安値」を 横=チェックイン日 × 縦=競合ホテル の
// ヒートマップで表示する。赤=競合が自社より安い(危険)、青=自社が優位。
//
// 共通ヘルパー (esc, fmtDate, yen, stockTxt, rakutenPlanUrl, isWeekendDate) は
// rateshop-common.js から読み込む。現在値の比較なので時系列ではなくリアルタイム反映。

'use strict'

const $ = id => document.getElementById(id)

const state = {
  hotels: [],
  dates: [],
  adultsList: null,
  adults: null,
  grid: [],
  isRealMode: false,
  detail: null,   // 開いているセルの {hotelId, date}
}

// ---------- 集計 ----------

// 現在の人数プロファイルで「ホテル|日付 -> 最安セル」を作る。
// あわせて「セルは存在するが空室ゼロ(=売止)」の判定用に存在集合も返す。
function buildMins(adults) {
  const mins = new Map()      // key -> {price, plan, planName, key, stock, stockPlus, stockSrc}
  const present = new Set()   // この人数で1セルでも観測がある hotel|date
  for (const c of state.grid) {
    if (adults != null && c.adults != null && c.adults !== adults) continue
    const k = `${c.h}|${c.d}`
    present.add(k)
    if (!c.avail || c.price == null) continue
    const cur = mins.get(k)
    if (!cur || c.price < cur.price) {
      mins.set(k, { price: c.price, plan: c.plan, planName: c.planName, key: c.key, stock: c.stock, stockPlus: c.stockPlus, stockSrc: c.stockSrc })
    }
  }
  return { mins, present }
}

// 差額セルの背景色: マイナス(競合が安い)=赤、プラス=青。差が大きいほど濃い。
function cellStyle(diff, ownPrice) {
  const pct = ownPrice ? Math.abs(diff) / ownPrice : 0
  const a = Math.min(0.85, 0.16 + (pct / 0.15) * 0.69) // 0%→0.16, 15%以上→0.85
  if (diff < 0) return `background:rgba(239,68,68,${a.toFixed(2)})`
  if (diff > 0) return `background:rgba(56,189,248,${a.toFixed(2)})`
  return 'background:rgba(148,163,184,0.12)'
}

const signedYen = v => (v < 0 ? '−' : '+') + '¥' + Math.abs(v).toLocaleString()

// ---------- 描画 ----------

function renderAdultsChips() {
  const field = $('adults-field')
  if (!state.adultsList || state.adultsList.length <= 1) { field.classList.add('hidden'); return }
  field.classList.remove('hidden')
  const chips = state.adultsList.map(a => ({ v: a, label: `${a}名` }))
  $('adults-chips').innerHTML = chips.map(c =>
    `<button class="chip ${state.adults === c.v ? 'active' : ''}" data-adults="${c.v}">${c.label}</button>`).join('')
}

function render() {
  renderAdultsChips()
  const own = state.hotels.find(h => h.own)
  const rivals = state.hotels.filter(h => !h.own)
  const cap = $('hm-caption')

  if (!own) {
    cap.textContent = '差額ヒートマップ'
    $('heatmap').innerHTML = '<tbody><tr><td class="muted">自社施設が未設定です。ダッシュボードの設定で「自社施設」を指定すると差額を表示できます。</td></tr></tbody>'
    $('danger-summary').textContent = ''
    return
  }
  if (!rivals.length || !state.dates.length) {
    cap.textContent = '差額ヒートマップ'
    $('heatmap').innerHTML = '<tbody><tr><td class="muted">比較できる競合・日付がまだありません。観測が進むと表示されます。</td></tr></tbody>'
    $('danger-summary').textContent = ''
    return
  }

  const { mins, present } = buildMins(state.adults)
  cap.textContent = `競合 ${rivals.length}軒 × ${state.dates.length}日付${state.adults != null ? `・${state.adults}名` : ''}`

  // ヘッダー: 日付 + その日の自社最安(基準)
  const head = '<thead><tr><th class="hm-corner">競合 ＼ 日付</th>' +
    state.dates.map(d => {
      const om = mins.get(`${own.id}|${d}`)
      const base = om ? yen(om.price) : (present.has(`${own.id}|${d}`) ? '売止' : '—')
      return `<th class="${isWeekendDate(d) ? 'weekend' : ''}">${fmtDate(d)}<span class="hm-base" title="自社最安 (基準)">自社 ${base}</span></th>`
    }).join('') + '</tr></thead>'

  let danger = 0, worst = null
  const body = '<tbody>' + rivals.map(h => {
    const tds = state.dates.map(d => {
      const rm = mins.get(`${h.id}|${d}`)
      const om = mins.get(`${own.id}|${d}`)
      if (!rm) { // 競合に空室なし
        const txt = present.has(`${h.id}|${d}`) ? '売止' : '—'
        return `<td class="hm-cell na">${txt}</td>`
      }
      if (!om) { // 自社が比較不能 → 差額出せず競合価格のみ
        return `<td class="hm-cell na" data-hotel="${esc(h.id)}" data-date="${d}" tabindex="0"><span class="hm-diff">${yen(rm.price)}</span><span class="hm-sub">自社比較不可</span></td>`
      }
      const diff = rm.price - om.price
      if (diff < 0) { danger++; if (!worst || diff < worst.diff) worst = { diff, hotel: h.name, date: d } }
      return `<td class="hm-cell" style="${cellStyle(diff, om.price)}" data-hotel="${esc(h.id)}" data-date="${d}" tabindex="0">` +
        `<span class="hm-diff">${diff === 0 ? '±0' : signedYen(diff)}</span><span class="hm-sub">競合 ${yen(rm.price)}</span></td>`
    }).join('')
    return `<tr><td class="hm-rowhead">${esc(h.name)}</td>${tds}</tr>`
  }).join('') + '</tbody>'

  $('heatmap').innerHTML = head + body

  $('danger-summary').innerHTML = danger
    ? `<b class="up-txt">${danger}セル</b>で競合が自社より安い` +
      (worst ? `（最大 ${fmtDate(worst.date)} ${esc(worst.hotel)} ${signedYen(worst.diff)}）` : '')
    : '競合が自社を下回るセルはありません'

  // 開いていた詳細を最新値で更新
  if (state.detail && !$('detail-overlay').classList.contains('hidden')) {
    openDetail(state.detail.hotelId, state.detail.date)
  }
}

// ---------- セル詳細 ----------

function openDetail(hotelId, date) {
  const own = state.hotels.find(h => h.own)
  const hotel = state.hotels.find(h => h.id === hotelId)
  const { mins } = buildMins(state.adults)
  const rm = mins.get(`${hotelId}|${date}`)
  const om = own ? mins.get(`${own.id}|${date}`) : null
  state.detail = { hotelId, date }
  $('detail-caption').textContent = `${hotel?.name ?? hotelId}・${fmtDate(date)}泊${state.adults != null ? `・${state.adults}名` : ''}`

  const line = (label, m, h) => {
    if (!m) return `<div class="hm-d-row"><span class="hm-d-label">${label}</span><span class="muted">空室なし</span></div>`
    const link = state.isRealMode
      ? ` <a class="rs-link" href="${rakutenPlanUrl(h.id, date, state.adults)}" target="_blank" rel="noopener">楽天↗</a>` : ''
    return `<div class="hm-d-row"><span class="hm-d-label">${label}</span>` +
      `<span><b>${yen(m.price)}</b>${m.stock != null ? ` <span class="muted">残${stockTxt(m.stock, m.stockPlus, m.stockSrc)}</span>` : ''}${link}` +
      `<div class="rs-plan-note">${esc(m.plan ?? '')}${m.planName ? ` ／ ${esc(m.planName)}` : ''}</div></span></div>`
  }

  let verdict = ''
  if (rm && om) {
    const diff = rm.price - om.price
    verdict = diff < 0
      ? `<div class="hm-verdict danger">この日付は競合が <b>${signedYen(diff)}</b> 自社を下回っています（要注意）</div>`
      : diff > 0
        ? `<div class="hm-verdict safe">自社が <b>${signedYen(-diff)}</b> 競合より安い（優位）</div>`
        : `<div class="hm-verdict">競合と同額</div>`
  }

  $('detail-body').innerHTML = verdict +
    line('競合 ' + (hotel?.name ?? ''), rm, hotel) +
    line('自社 ' + (own?.name ?? ''), om, own)
  $('detail-overlay').classList.remove('hidden')
}
function closeDetail() { state.detail = null; $('detail-overlay').classList.add('hidden') }

// ---------- SSE ----------

function applyPayload(j) {
  if (!j || !Array.isArray(j.grid)) return
  state.hotels = j.hotels ?? []
  state.dates = j.dates ?? []
  state.adultsList = j.adultsList ?? null
  state.isRealMode = state.adultsList != null
  if (state.adults == null || (state.adultsList && !state.adultsList.includes(state.adults))) {
    state.adults = state.adultsList?.[0] ?? null
  }
  state.grid = j.grid
  $('mode-badge').textContent = 'モード: ' + (state.isRealMode ? '実データ収集' : 'シミュレーション')
  render()
}

function setConn(cls, text) {
  const el = $('conn'); el.className = 'conn ' + cls
  el.innerHTML = `<span class="dot"></span>${text}`
}

function connect() {
  const es = new EventSource('/api/rateshop/stream')
  es.onopen = () => setConn('live', 'リアルタイム接続中')
  es.onmessage = e => {
    setConn('live', 'リアルタイム接続中')
    try { applyPayload(JSON.parse(e.data)) } catch { /* 壊れたフレームは無視 */ }
  }
  es.onerror = () => setConn('dead', '再接続中...')
}

// ---------- 操作 ----------

$('adults-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  state.adults = Number(btn.dataset.adults); render()
})
$('heatmap').addEventListener('click', e => {
  const td = e.target.closest('.hm-cell'); if (!td || !td.dataset.hotel) return
  openDetail(td.dataset.hotel, td.dataset.date)
})
$('heatmap').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const td = e.target.closest('.hm-cell'); if (!td || !td.dataset.hotel) return
  e.preventDefault(); openDetail(td.dataset.hotel, td.dataset.date)
})
$('detail-close').addEventListener('click', closeDetail)
$('detail-overlay').addEventListener('click', e => { if (e.target.id === 'detail-overlay') closeDetail() })
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail() })

// ---------- 時計 ----------

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
setInterval(tickClock, 1000)
tickClock()

connect()
