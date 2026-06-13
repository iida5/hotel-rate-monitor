// ホテル別イベントタイムライン - フロントエンド
//
// /api/rateshop/timeline からアラート履歴 (NDJSON全量) を読み、
// ホテルごとに「いつ何をしたか」を日付グループで時系列表示する。
//   - 左: 監視中のホテル一覧 (選ぶと右が切り替わる)
//   - 右: 期間・人数・チェックイン日・部屋タイプ・種別で絞り込んだイベント列
//
// 期間と人数はサーバー側で絞り (再取得)、チェックイン日・部屋タイプ・種別は
// 取得済みイベントに対してクライアント側で絞る。

'use strict'

const $ = id => document.getElementById(id)

// 種別ラベル・整形ユーティリティ (TYPE_LABELS / TYPE_DEFS / typeGroup / esc / DOW /
// fmtDate / fmtTime / yen / stockTxt / rakutenPlanUrl / eventDetail / isScopeEvent)
// は rateshop-common.js で定義 (HTMLで先に読み込む)。

const PERIODS = [
  { key: '1', label: '24時間', days: 1 },
  { key: '3', label: '3日', days: 3 },
  { key: '7', label: '7日', days: 7 },
  { key: '30', label: '30日', days: 30 },
  { key: 'all', label: '全期間', days: null },
]

// 日付グループ見出し (「6/13(金)」+ 今日/昨日)
function dayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
function dayHeader(t) {
  const d = new Date(t)
  const today = new Date()
  const yest = new Date(); yest.setDate(today.getDate() - 1)
  const same = (a, b) => a.toDateString() === b.toDateString()
  const tag = same(d, today) ? ' 今日' : same(d, yest) ? ' 昨日' : ''
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})${tag}`
}

// ---------- 状態 ----------

const state = {
  hotels: [],
  adultsList: null,
  selHotel: null,      // 選択中の hotelId
  period: '7',         // 期間プリセットキー
  adults: null,        // 選択中の人数 (null=すべて)
  dateFilter: '',      // チェックイン日 (iso、空=すべて)
  roomFilter: '',      // 部屋タイプ (plan文字列、空=すべて)
  types: TYPE_DEFS.map(d => d.key), // 表示する種別グループ
  events: [],          // サーバーから取得した生イベント (新しい順)
  isRealMode: false,
  trend: null,         // 推移チャートのキャッシュ {key, selRec, ownRec, ...}
}

// ---------- データ取得 ----------

async function fetchTimeline() {
  const params = new URLSearchParams()
  if (state.selHotel) params.set('hotel', state.selHotel)
  const period = PERIODS.find(p => p.key === state.period)
  if (period && period.days != null) {
    params.set('from', String(Date.now() - period.days * 86_400_000))
  }
  if (state.adults != null) params.set('adults', String(state.adults))
  $('timeline').innerHTML = '<p class="muted">読み込み中…</p>'
  try {
    const res = await fetch('/api/rateshop/timeline?' + params).then(r => r.json())
    state.hotels = res.hotels ?? []
    state.adultsList = res.adultsList ?? null
    state.isRealMode = state.adultsList != null
    state.events = res.events ?? []
    return true
  } catch {
    $('timeline').innerHTML = '<p class="muted">タイムラインを取得できませんでした。</p>'
    return false
  }
}

// ---------- 描画 ----------

function renderHotels() {
  const ul = $('hotel-list')
  if (!state.hotels.length) {
    ul.innerHTML = '<li class="muted">監視中のホテルがありません。ダッシュボードの設定で施設を登録してください。</li>'
    return
  }
  ul.innerHTML = state.hotels.map(h => `
    <li class="tl-hotel ${h.id === state.selHotel ? 'active' : ''}" data-hotel="${esc(h.id)}">
      <span class="tl-hotel-name">${esc(h.name)}</span>
      ${h.own ? '<span class="rs-own-tag">自社</span>' : ''}
    </li>`).join('')
}

function renderAdultsChips() {
  const field = $('adults-field')
  if (!state.adultsList || state.adultsList.length <= 1) {
    field.classList.add('hidden')
    return
  }
  field.classList.remove('hidden')
  const chips = [{ v: null, label: 'すべて' }, ...state.adultsList.map(a => ({ v: a, label: `${a}名` }))]
  $('adults-chips').innerHTML = chips.map(c =>
    `<button class="chip ${state.adults === c.v ? 'active' : ''}" data-adults="${c.v == null ? '' : c.v}">${c.label}</button>`).join('')
}

function renderPeriodChips() {
  $('period-chips').innerHTML = PERIODS.map(p =>
    `<button class="chip ${state.period === p.key ? 'active' : ''}" data-period="${p.key}">${p.label}</button>`).join('')
}

function renderTypeChips() {
  $('type-chips').innerHTML = TYPE_DEFS.map(d =>
    `<button class="chip ${state.types.includes(d.key) ? 'active' : ''}" data-type="${d.key}">${d.label}</button>`).join('')
}

// チェックイン日・部屋タイプの選択肢を、取得済みイベントから組み立てる。
// 期間を狭めて選択中の値が候補から消えた場合はフィルタをリセットする。
function renderSelectOptions() {
  const dates = [...new Set(state.events.map(a => a.date).filter(Boolean))].sort()
  if (state.dateFilter && !dates.includes(state.dateFilter)) state.dateFilter = ''
  const dsel = $('date-filter')
  dsel.innerHTML = '<option value="">すべて</option>' +
    dates.map(d => `<option value="${d}" ${state.dateFilter === d ? 'selected' : ''}>${fmtDate(d)}泊</option>`).join('')

  // 部屋タイプはスコープ系 (セール/ポイント) を除いた plan を候補にする
  const rooms = [...new Set(state.events.filter(a => !isScopeEvent(a)).map(a => a.plan).filter(Boolean))].sort()
  if (state.roomFilter && !rooms.includes(state.roomFilter)) state.roomFilter = ''
  const rsel = $('room-filter')
  rsel.innerHTML = '<option value="">すべて</option>' +
    rooms.map(r => `<option value="${esc(r)}" ${state.roomFilter === r ? 'selected' : ''}>${esc(r)}</option>`).join('')
}

// クライアント側フィルタを適用したイベント列
function filteredEvents() {
  return state.events.filter(a => {
    if (!state.types.includes(typeGroup(a.type))) return false
    if (state.dateFilter && a.date !== state.dateFilter) return false
    if (state.roomFilter) {
      // 部屋を指定したら、その部屋のイベントだけ (スコープ系は除外)
      if (isScopeEvent(a) || a.plan !== state.roomFilter) return false
    }
    return true
  })
}

function eventRow(a) {
  const link = state.isRealMode && a.date
    ? ` <a class="rs-link" href="${rakutenPlanUrl(a.hotelId, a.date, a.adults)}" target="_blank" rel="noopener" title="楽天トラベルの該当ページを開く">楽天↗</a>`
    : ''
  const g = typeGroup(a.type)
  return `<li class="rs-alert ${g}">
    <span class="feed-time">${fmtTime(a.t)}</span>
    <div class="rs-alert-body">
      <div><span class="rs-badge ${g}">${TYPE_LABELS[a.type]}</span> <span class="tl-meta-when">${a.date ? `${fmtDate(a.date)}泊` : ''}${a.adults ? `・${a.adults}名` : ''}</span></div>
      <div class="rs-alert-meta">${esc(a.plan ?? '')}${link}</div>
      <div class="rs-alert-detail">${eventDetail(a)}</div>
    </div>
  </li>`
}

function renderTimeline() {
  const cap = $('tl-caption')
  const hotel = state.hotels.find(h => h.id === state.selHotel)
  cap.textContent = hotel ? `${hotel.name} のタイムライン` : 'タイムライン'

  if (!state.selHotel) {
    $('timeline').innerHTML = '<p class="muted">左のホテルを選んでください。</p>'
    $('event-count').textContent = ''
    return
  }
  const events = filteredEvents()
  $('event-count').textContent = `${events.length}件`
  if (!events.length) {
    $('timeline').innerHTML = '<p class="muted">この条件のイベントはありません。期間を広げるか、種別フィルタを見直してください。</p>'
    return
  }
  // 日付グループ (新しい順)。events はサーバーから新しい順で来ている
  const groups = []
  let cur = null
  for (const a of events) {
    const dk = dayKey(a.t)
    if (!cur || cur.dk !== dk) { cur = { dk, header: dayHeader(a.t), items: [] }; groups.push(cur) }
    cur.items.push(a)
  }
  $('timeline').innerHTML = groups.map(g => `
    <div class="tl-day">
      <div class="tl-day-head"><span class="tl-day-label">${g.header}</span><span class="tl-day-count">${g.items.length}件</span></div>
      <ul class="rs-feed">${g.items.map(eventRow).join('')}</ul>
    </div>`).join('')
}

function renderFiltersPanel() {
  renderPeriodChips()
  renderAdultsChips()
  renderTypeChips()
  renderSelectOptions()
}

// ---------- 価格推移チャート (第2段階: observations を重ねる) ----------

// チャートに使う人数: 明示選択があればそれ、無ければ先頭プロファイル (実データ時)
function chartAdults() {
  if (state.adults != null) return state.adults
  return state.adultsList && state.adultsList.length ? state.adultsList[0] : null
}

// 期間プリセットの開始時刻 (全期間は null)
function periodFrom() {
  const p = PERIODS.find(x => x.key === state.period)
  return p && p.days != null ? Date.now() - p.days * 86_400_000 : null
}

// 観測履歴レコード -> [{t, price}] (空室の最安値。期間内に絞る)
function pricePoints(records, fromT) {
  return (records ?? []).map(r => {
    const avail = (r.rooms ?? []).filter(x => x.avail && x.price)
    return { t: r.t, price: avail.length ? Math.min(...avail.map(x => x.price)) : null }
  }).filter(p => p.price != null && (fromT == null || p.t >= fromT))
}

async function fetchHistory(hotelId, date, adults) {
  const q = new URLSearchParams({ hotel: hotelId, date })
  if (adults != null) q.set('adults', String(adults))
  try {
    const { history } = await fetch('/api/rateshop/history?' + q).then(r => r.json())
    return history ?? []
  } catch {
    return null
  }
}

// チャートのデータ取得 (人数/期間/種別の切替では再取得せずキャッシュから再描画する)
async function loadTrend() {
  const cap = $('trend-caption')
  $('trend-gap').textContent = ''
  const hotel = state.hotels.find(h => h.id === state.selHotel)
  if (!state.selHotel || !state.dateFilter) {
    state.trend = null
    cap.textContent = '価格推移'
    $('trend-body').innerHTML = '<p class="muted">上の「チェックイン日」を1つ選ぶと、その日の最安値推移を自社と重ねて表示します。</p>'
    return
  }
  const adults = chartAdults()
  cap.textContent = `${hotel?.name ?? state.selHotel}・${fmtDate(state.dateFilter)}泊${adults != null ? `・${adults}名` : ''} の最安値推移`

  const key = `${state.selHotel}|${state.dateFilter}|${adults}`
  if (state.trend && state.trend.key === key) { renderTrend(state.trend); return }

  $('trend-body').innerHTML = '<p class="muted">読み込み中…</p>'
  const own = state.hotels.find(h => h.own)
  const isOwnSelected = !!(own && own.id === state.selHotel)
  const [selRec, ownRec] = await Promise.all([
    fetchHistory(state.selHotel, state.dateFilter, adults),
    (own && !isOwnSelected) ? fetchHistory(own.id, state.dateFilter, adults) : Promise.resolve(null),
  ])
  // 取得中に選択が変わっていたら破棄
  if (`${state.selHotel}|${state.dateFilter}|${chartAdults()}` !== key) return
  state.trend = { key, selRec, ownRec, own, isOwnSelected, adults }
  renderTrend(state.trend)
}

function renderTrend({ selRec, ownRec, own, isOwnSelected, adults }) {
  const fromT = periodFrom()
  const selPts = pricePoints(selRec, fromT)
  const ownPts = pricePoints(ownRec, fromT)
  // このホテル×日付のイベント (期間・種別・人数フィルタ後) をマーカーにする
  const evts = filteredEvents().filter(a => a.date === state.dateFilter &&
    (fromT == null || a.t >= fromT))

  if (selPts.length < 2) {
    $('trend-body').innerHTML =
      '<p class="muted">まだ推移を描けるだけの観測履歴がありません。監視を続けると、この日の最安値推移がここに表示されます。</p>'
    return
  }

  const allP = [...selPts, ...ownPts]
  const W = 720, H = 250, L = 60, R = 24, T = 16, B = 34
  const t0 = Math.min(...allP.map(p => p.t)), t1 = Math.max(...allP.map(p => p.t))
  const x = t => L + (W - L - R) * (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0))
  const pMin = Math.min(...allP.map(p => p.price)), pMax = Math.max(...allP.map(p => p.price))
  const pad = Math.max(200, Math.round((pMax - pMin) * 0.15))
  const yLo = pMin - pad, yHi = pMax + pad
  const y = v => T + (H - T - B) * (1 - (v - yLo) / (yHi - yLo))

  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
  const selLine = path(selPts)
  const ownLine = ownPts.length >= 2 ? path(ownPts) : ''
  const selDots = selPts.map(p =>
    `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="3" class="hc-dot"><title>${fmtTime(p.t)}  ${yen(p.price)}</title></circle>`).join('')

  // イベントマーカー: 時間軸上の縦線 + 下端の▲ (種別色)
  const evtMarks = evts.map(a => {
    const g = typeGroup(a.type)
    const xx = x(a.t).toFixed(1)
    return `<line x1="${xx}" y1="${T}" x2="${xx}" y2="${H - B}" class="tl-evt-line ${g}"/>` +
      `<polygon points="${xx},${H - B} ${(+xx - 4).toFixed(1)},${H - B + 7} ${(+xx + 4).toFixed(1)},${H - B + 7}" class="tl-evt-mark ${g}"><title>${fmtTime(a.t)}  ${TYPE_LABELS[a.type]} ${esc(a.plan ?? '')}</title></polygon>`
  }).join('')

  // 差額サマリー: 両系列の最新値で比較 (競合視点)。パネル見出し右に出す
  if (!isOwnSelected && ownPts.length) {
    const diff = selPts[selPts.length - 1].price - ownPts[ownPts.length - 1].price
    const word = diff > 0 ? '高い' : diff < 0 ? '安い' : '同額'
    const cls = diff > 0 ? 'up-txt' : diff < 0 ? 'down-txt' : ''
    $('trend-gap').innerHTML = diff === 0
      ? '現在 自社と同額'
      : `現在 自社より <b class="${cls}">${yen(Math.abs(diff))} ${word}</b>`
  }

  const legend = `<p class="hc-legend">
    <span class="hc-key price"></span>${esc(state.hotels.find(h => h.id === state.selHotel)?.name ?? '対象')}
    ${ownLine ? `<span class="hc-key own"></span>${esc(own?.name ?? '自社')} (自社)` : ''}
    <span class="tl-evt-key"></span>イベント発生　点にカーソルで詳細</p>`

  $('trend-body').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="hc" role="img" aria-label="価格推移チャート">
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="hc-axis"/>
      <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="hc-axis"/>
      <text x="${L - 6}" y="${y(pMax) + 4}" class="hc-lbl" text-anchor="end">${yen(pMax)}</text>
      <text x="${L - 6}" y="${y(pMin) + 4}" class="hc-lbl" text-anchor="end">${yen(pMin)}</text>
      <text x="${L}" y="${H - 8}" class="hc-lbl">${fmtTime(t0)}</text>
      <text x="${W - R}" y="${H - 8}" class="hc-lbl" text-anchor="end">${fmtTime(t1)}</text>
      ${evtMarks}
      ${ownLine ? `<path d="${ownLine}" class="hc-own"/>` : ''}
      <path d="${selLine}" class="hc-price"/>
      ${selDots}
    </svg>
    ${legend}`
}

// ---------- 操作 ----------

// ホテル/期間/人数が変わったら再取得。種別・日付・部屋はクライアント側のみ。
async function reload() {
  await fetchTimeline()
  renderHotels()
  renderFiltersPanel()
  renderTimeline()
  loadTrend()
}

function selectHotel(id) {
  if (state.selHotel === id) return
  state.selHotel = id
  // ホテルを変えるとチェックイン日・部屋の候補も変わるのでリセット
  state.dateFilter = ''
  state.roomFilter = ''
  reload()
}

// ---------- イベント結線 ----------

$('hotel-list').addEventListener('click', e => {
  const li = e.target.closest('.tl-hotel')
  if (li) selectHotel(li.dataset.hotel)
})

$('period-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip')
  if (!btn) return
  state.period = btn.dataset.period
  reload()
})

$('adults-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip')
  if (!btn) return
  state.adults = btn.dataset.adults === '' ? null : Number(btn.dataset.adults)
  reload()
})

$('type-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip')
  if (!btn) return
  const key = btn.dataset.type
  const i = state.types.indexOf(key)
  if (i >= 0) state.types.splice(i, 1)
  else state.types.push(key)
  renderTypeChips()
  renderTimeline()
  loadTrend() // イベントマーカーは種別フィルタに追従 (キャッシュから再描画)
})

$('date-filter').addEventListener('change', e => {
  state.dateFilter = e.target.value
  renderTimeline()
  loadTrend()
})

$('room-filter').addEventListener('change', e => {
  state.roomFilter = e.target.value
  renderTimeline()
})

// ---------- 時計 ----------

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
setInterval(tickClock, 1000)
tickClock()

// ---------- 初期化 ----------

async function init() {
  await fetchTimeline() // hotel未指定で全施設のホテル一覧を取得
  $('mode-badge').textContent = 'モード: ' + (state.isRealMode ? '実データ収集' : 'シミュレーション')
  // 既定の選択ホテル: 自社との差額オーバーレイが映える競合を優先。
  // 競合が無ければ自社、それも無ければ先頭。
  const firstRival = state.hotels.find(h => !h.own)
  state.selHotel = (firstRival ?? state.hotels.find(h => h.own) ?? state.hotels[0])?.id ?? null
  if (state.selHotel) {
    await reload() // 選択ホテルで取得し直す
  } else {
    renderHotels()
    renderFiltersPanel()
    renderTimeline()
  }
}

init()
