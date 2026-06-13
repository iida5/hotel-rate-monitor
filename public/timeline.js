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

// ---- rateshop.js と同じ表示流儀 (種別ラベル・整形ユーティリティ) ----

const TYPE_LABELS = {
  price_up: '値上げ',
  price_down: '値下げ',
  soldout: '売止/満室',
  restock: '販売再開',
  stock_up: '在庫増',
  stock_down: '在庫減',
  sale_start: 'セール開始',
  sale_end: 'セール終了',
  point_up: 'ポイントUP',
}

const TYPE_DEFS = [
  { key: 'price_up', label: '値上げ' },
  { key: 'price_down', label: '値下げ' },
  { key: 'soldout', label: '売止/満室' },
  { key: 'restock', label: '販売再開' },
  { key: 'stock', label: '在庫増減' },
  { key: 'sale', label: 'セール' },
  { key: 'point', label: 'ポイント' },
]
const typeGroup = t =>
  (t === 'stock_up' || t === 'stock_down') ? 'stock'
  : (t === 'sale_start' || t === 'sale_end') ? 'sale'
  : (t === 'point_up') ? 'point'
  : t

const PERIODS = [
  { key: '1', label: '24時間', days: 1 },
  { key: '3', label: '3日', days: 3 },
  { key: '7', label: '7日', days: 7 },
  { key: '30', label: '30日', days: 30 },
  { key: 'all', label: '全期間', days: null },
]

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const DOW = ['日', '月', '火', '水', '木', '金', '土']

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  return `${m}/${d}(${DOW[dow]})`
}

// イベント発生時刻 (今日以外は日付も付ける)
function fmtTime(t) {
  const d = new Date(t)
  const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm.slice(0, 5)}`
}

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

const yen = v => '¥' + Number(v).toLocaleString()

const stockTxt = (stock, plus, src) =>
  stock == null ? '' : `${src === 'probe' ? '約' : ''}${stock}${plus ? '+' : ''}室`

// 楽天トラベルのプラン一覧ページURL (実データの裏取り用)
function rakutenPlanUrl(hotelId, dateIso, adults) {
  const [y, m, d] = dateIso.split('-').map(Number)
  const ci = new Date(y, m - 1, d)
  const co = new Date(y, m - 1, d + 1)
  const p2 = n => String(n).padStart(2, '0')
  const q = new URLSearchParams({
    f_nen1: ci.getFullYear(), f_tuki1: p2(ci.getMonth() + 1), f_hi1: p2(ci.getDate()),
    f_nen2: co.getFullYear(), f_tuki2: p2(co.getMonth() + 1), f_hi2: p2(co.getDate()),
    f_otona_su: String(adults ?? 2), f_heya_su: '1',
    f_s1: '0', f_s2: '0', f_y1: '0', f_y2: '0', f_y3: '0', f_y4: '0', f_teikei: '',
  })
  return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${hotelId}?${q}`
}

function eventDetail(a) {
  switch (a.type) {
    case 'price_up':
    case 'price_down': {
      const cls = a.type === 'price_up' ? 'up-txt' : 'down-txt'
      const own = a.ownPrice != null && !a.own
        ? ` <span class="rs-own-ref">自社最安 ${yen(a.ownPrice)}</span>` : ''
      return `${yen(a.oldPrice)} → <b>${yen(a.price)}</b> <span class="${cls}">(${a.pct > 0 ? '+' : ''}${a.pct}%)</span>${own}` +
        (a.planName ? `<div class="rs-plan-note" title="${esc(a.planName)}">${esc(a.planName)}</div>` : '')
    }
    case 'soldout':
      return `販売停止を検知 (直前価格 ${a.price != null ? yen(a.price) : '-'})`
    case 'restock':
      return `販売再開 ${a.price != null ? yen(a.price) : ''}${a.stock != null ? ` / 残${stockTxt(a.stock, a.stockPlus, a.stockSrc)}` : ''}` +
        (a.planName ? `<div class="rs-plan-note" title="${esc(a.planName)}">${esc(a.planName)}</div>` : '')
    case 'stock_up':
    case 'stock_down':
      return `残室 ${stockTxt(a.oldStock, a.oldStockPlus, a.stockSrc)} → <b>${stockTxt(a.stock, a.stockPlus, a.stockSrc)}</b>`
    case 'sale_start':
      return `<b>${esc(a.label ?? a.plan)}</b> の対象プランが登場`
    case 'sale_end':
      return `<b>${esc(a.label ?? a.plan)}</b> の対象プランがなくなりました`
    case 'point_up':
      return `ポイント ${a.oldPoints != null ? `${a.oldPoints}倍 → ` : ''}<b>${a.points}倍</b>`
    default:
      return ''
  }
}

// 種別がスコープ単位 (部屋タイプを持たない) か。部屋フィルタ時の扱いを分ける。
const isScopeEvent = a => a.type === 'sale_start' || a.type === 'sale_end' || a.type === 'point_up'

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

// チェックイン日・部屋タイプの選択肢を、取得済みイベントから組み立てる
function renderSelectOptions() {
  const dates = [...new Set(state.events.map(a => a.date).filter(Boolean))].sort()
  const dsel = $('date-filter')
  dsel.innerHTML = '<option value="">すべて</option>' +
    dates.map(d => `<option value="${d}" ${state.dateFilter === d ? 'selected' : ''}>${fmtDate(d)}泊</option>`).join('')

  // 部屋タイプはスコープ系 (セール/ポイント) を除いた plan を候補にする
  const rooms = [...new Set(state.events.filter(a => !isScopeEvent(a)).map(a => a.plan).filter(Boolean))].sort()
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

// ---------- 操作 ----------

// ホテル/期間/人数が変わったら再取得。種別・日付・部屋はクライアント側のみ。
async function reload() {
  await fetchTimeline()
  renderHotels()
  renderFiltersPanel()
  renderTimeline()
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
})

$('date-filter').addEventListener('change', e => {
  state.dateFilter = e.target.value
  renderTimeline()
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
  // 既定の選択ホテル: 自社があればそれ、なければ先頭
  const own = state.hotels.find(h => h.own)
  state.selHotel = own ? own.id : (state.hotels[0]?.id ?? null)
  if (state.selHotel) {
    await reload() // 選択ホテルで取得し直す
  } else {
    renderHotels()
    renderFiltersPanel()
    renderTimeline()
  }
}

init()
