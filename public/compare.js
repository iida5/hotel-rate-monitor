// イベント比較ボード - フロントエンド
//
// /api/rateshop/timeline (全施設のアラート履歴) を読み、
// 「時間バケット × ホテル」のマトリクスに組み替えて横並びで表示する。
//   - 縦軸: 時間 (新しい順)。イベントのあるバケットだけを行にする
//   - 横軸: 監視ホテル (自社を左端)。表示列はホテルチップで切替
//   - セル: その時間帯のイベントを色付きチップで表示。クリックで詳細
//
// 共通ヘルパー (TYPE_LABELS, typeGroup, esc, fmtTime, eventDetail 等) は
// rateshop-common.js から読み込む。期間だけサーバー再取得し、他はクライアント側で絞る。

'use strict'

const $ = id => document.getElementById(id)

const PERIODS = [
  { key: '1', label: '24時間', days: 1 },
  { key: '3', label: '3日', days: 3 },
  { key: '7', label: '7日', days: 7 },
  { key: '30', label: '30日', days: 30 },
  { key: 'all', label: '全期間', days: null },
]

const BUCKETS = [
  { key: 15, label: '15分' },
  { key: 30, label: '30分' },
  { key: 60, label: '1時間' },
]

const state = {
  hotels: [],
  adultsList: null,
  isRealMode: false,
  period: '7',
  bucket: 30,                                  // 行の粒度 (分)
  adults: null,
  dateFilter: '',
  roomFilter: '',
  // 在庫増減は詰まり防止のため既定OFF (価格・売止・再開・セール・ポイントを主役に)
  types: ['price_up', 'price_down', 'soldout', 'restock', 'sale', 'point'],
  selectedHotels: null,                        // 表示する列 (Set)。null=初期化前
  events: [],
  cells: new Map(),                            // `${bucketStart}|${hotelId}` -> events[] (クリック詳細用)
}

// ---------- 整形 ----------

const p2 = n => String(n).padStart(2, '0')
function fmtBucket(t) {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]}) ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// ホテルを自社優先で並べる (設定順は維持)
function orderedHotels() {
  return [...state.hotels].sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0))
}
function shownHotels() {
  return orderedHotels().filter(h => state.selectedHotels?.has(h.id))
}

// ---------- データ取得 ----------

async function fetchBoard() {
  const params = new URLSearchParams()
  const period = PERIODS.find(p => p.key === state.period)
  if (period && period.days != null) params.set('from', String(Date.now() - period.days * 86_400_000))
  $('board').innerHTML = ''
  try {
    const res = await fetch('/api/rateshop/timeline?' + params).then(r => r.json())
    state.hotels = res.hotels ?? []
    state.adultsList = res.adultsList ?? null
    state.isRealMode = state.adultsList != null
    state.events = res.events ?? []
    return true
  } catch {
    $('board').innerHTML = '<tbody><tr><td class="muted">ボードを取得できませんでした。</td></tr></tbody>'
    return false
  }
}

// ---------- フィルタ ----------

function filteredEvents() {
  return state.events.filter(a => {
    if (!state.types.includes(typeGroup(a.type))) return false
    if (state.adults != null && a.adults != null && a.adults !== state.adults) return false
    if (state.dateFilter && a.date !== state.dateFilter) return false
    if (state.roomFilter) {
      if (isScopeEvent(a) || a.plan !== state.roomFilter) return false
    }
    return true
  })
}

// ---------- 描画: フィルタ群 ----------

function renderPeriodChips() {
  $('period-chips').innerHTML = PERIODS.map(p =>
    `<button class="chip ${state.period === p.key ? 'active' : ''}" data-period="${p.key}">${p.label}</button>`).join('')
}
function renderBucketChips() {
  $('bucket-chips').innerHTML = BUCKETS.map(b =>
    `<button class="chip ${state.bucket === b.key ? 'active' : ''}" data-bucket="${b.key}">${b.label}</button>`).join('')
}
function renderAdultsChips() {
  const field = $('adults-field')
  if (!state.adultsList || state.adultsList.length <= 1) { field.classList.add('hidden'); return }
  field.classList.remove('hidden')
  const chips = [{ v: null, label: 'すべて' }, ...state.adultsList.map(a => ({ v: a, label: `${a}名` }))]
  $('adults-chips').innerHTML = chips.map(c =>
    `<button class="chip ${state.adults === c.v ? 'active' : ''}" data-adults="${c.v == null ? '' : c.v}">${c.label}</button>`).join('')
}
function renderTypeChips() {
  $('type-chips').innerHTML = TYPE_DEFS.map(d =>
    `<button class="chip ${state.types.includes(d.key) ? 'active' : ''}" data-type="${d.key}">${d.label}</button>`).join('')
}
function renderHotelChips() {
  $('hotel-chips').innerHTML = orderedHotels().map(h =>
    `<button class="chip ${state.selectedHotels?.has(h.id) ? 'active' : ''}" data-hotel="${esc(h.id)}">${esc(h.name)}${h.own ? ' (自社)' : ''}</button>`).join('')
}
function renderSelectOptions() {
  const dates = [...new Set(state.events.map(a => a.date).filter(Boolean))].sort()
  if (state.dateFilter && !dates.includes(state.dateFilter)) state.dateFilter = ''
  $('date-filter').innerHTML = '<option value="">すべて</option>' +
    dates.map(d => `<option value="${d}" ${state.dateFilter === d ? 'selected' : ''}>${fmtDate(d)}泊</option>`).join('')

  const rooms = [...new Set(state.events.filter(a => !isScopeEvent(a)).map(a => a.plan).filter(Boolean))].sort()
  if (state.roomFilter && !rooms.includes(state.roomFilter)) state.roomFilter = ''
  $('room-filter').innerHTML = '<option value="">すべて</option>' +
    rooms.map(r => `<option value="${esc(r)}" ${state.roomFilter === r ? 'selected' : ''}>${esc(r)}</option>`).join('')
}

function renderFilters() {
  renderPeriodChips()
  renderBucketChips()
  renderAdultsChips()
  renderTypeChips()
  renderHotelChips()
  renderSelectOptions()
}

// ---------- 描画: ボード本体 ----------

function buildBoard() {
  const bucketMs = state.bucket * 60_000
  const shown = new Set(shownHotels().map(h => h.id))
  const cells = new Map()          // key -> events[]
  const bucketSet = new Set()
  for (const a of filteredEvents()) {
    if (!shown.has(a.hotelId)) continue
    const bucketStart = Math.floor(a.t / bucketMs) * bucketMs
    bucketSet.add(bucketStart)
    const key = `${bucketStart}|${a.hotelId}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(a)
  }
  state.cells = cells
  return [...bucketSet].sort((a, b) => b - a) // 新しい順
}

function chipHtml(a) {
  const g = typeGroup(a.type)
  const title = `${fmtTime(a.t)} ${TYPE_LABELS[a.type]}${a.plan ? ' / ' + a.plan : ''}`
  return `<span class="cb-chip ${g}" title="${esc(title)}">${TYPE_LABELS_SHORT[a.type] ?? a.type}</span>`
}

function renderBoard() {
  const cap = $('board-caption')
  const hotels = shownHotels()
  if (!hotels.length) {
    cap.textContent = 'イベント比較ボード'
    $('board').innerHTML = ''
    $('board-count').textContent = ''
    $('board').innerHTML = '<tbody><tr><td class="muted">表示するホテル列が選ばれていません。上の「表示ホテル」から選んでください。</td></tr></tbody>'
    return
  }
  const buckets = buildBoard()
  const period = PERIODS.find(p => p.key === state.period)
  cap.textContent = `直近${period?.label ?? ''}・${state.bucket}分単位`
  const totalEvents = [...state.cells.values()].reduce((s, arr) => s + arr.length, 0)
  $('board-count').textContent = `${totalEvents}件 / ${buckets.length}行`

  if (!buckets.length) {
    $('board').innerHTML = '<tbody><tr><td class="muted">この条件のイベントはありません。期間を広げるか種別フィルタを見直してください。</td></tr></tbody>'
    return
  }

  const head = `<thead><tr><th class="cb-time-h">時刻</th>` +
    hotels.map(h => `<th class="${h.own ? 'own' : ''}">${esc(h.name)}${h.own ? ' <span class="rs-own-tag">自社</span>' : ''}</th>`).join('') +
    `</tr></thead>`

  const body = '<tbody>' + buckets.map(b => {
    const cells = hotels.map(h => {
      const evs = state.cells.get(`${b}|${h.id}`)
      if (!evs || !evs.length) return `<td class="cb-cell empty${h.own ? ' own' : ''}"></td>`
      const chips = [...evs].sort((x, y) => y.t - x.t).map(chipHtml).join('')
      return `<td class="cb-cell${h.own ? ' own' : ''}" data-bucket="${b}" data-hotel="${esc(h.id)}" tabindex="0">${chips}</td>`
    }).join('')
    return `<tr><td class="cb-time">${fmtBucket(b)}</td>${cells}</tr>`
  }).join('') + '</tbody>'

  $('board').innerHTML = head + body
}

// ---------- セル詳細モーダル ----------

function openDetail(bucketStart, hotelId) {
  const evs = state.cells.get(`${bucketStart}|${hotelId}`)
  if (!evs || !evs.length) return
  const hotel = state.hotels.find(h => h.id === hotelId)
  const bucketMs = state.bucket * 60_000
  const endLabel = (() => { const d = new Date(Number(bucketStart) + bucketMs); return `${p2(d.getHours())}:${p2(d.getMinutes())}` })()
  $('detail-caption').textContent = `${hotel?.name ?? hotelId}・${fmtBucket(Number(bucketStart))}〜${endLabel}`
  const rows = [...evs].sort((a, b) => b.t - a.t).map(a => {
    const g = typeGroup(a.type)
    const link = state.isRealMode && a.date
      ? ` <a class="rs-link" href="${rakutenPlanUrl(a.hotelId, a.date, a.adults)}" target="_blank" rel="noopener">楽天↗</a>` : ''
    return `<li class="rs-alert ${g}">
      <span class="feed-time">${fmtTime(a.t)}</span>
      <div class="rs-alert-body">
        <div><span class="rs-badge ${g}">${TYPE_LABELS[a.type]}</span> <span class="tl-meta-when">${a.date ? `${fmtDate(a.date)}泊` : ''}${a.adults ? `・${a.adults}名` : ''}</span></div>
        <div class="rs-alert-meta">${esc(a.plan ?? '')}${link}</div>
        <div class="rs-alert-detail">${eventDetail(a)}</div>
      </div>
    </li>`
  }).join('')
  $('detail-body').innerHTML = `<ul class="rs-feed">${rows}</ul>`
  $('detail-overlay').classList.remove('hidden')
}
function closeDetail() { $('detail-overlay').classList.add('hidden') }

// ---------- 操作 ----------

// 期間だけサーバー再取得。粒度・人数・日付・部屋・種別・列はクライアント側で再描画。
async function reload() {
  await fetchBoard()
  if (state.selectedHotels == null) initSelectedHotels()
  renderFilters()
  renderBoard()
}
function rerender() {
  renderFilters()
  renderBoard()
}

// 既定の表示列: 自社 + 競合先頭4軒 (最大5列)
function initSelectedHotels() {
  const ordered = orderedHotels()
  state.selectedHotels = new Set(ordered.slice(0, 5).map(h => h.id))
}

// ---------- イベント結線 ----------

$('period-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  state.period = btn.dataset.period; reload()
})
$('bucket-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  state.bucket = Number(btn.dataset.bucket); rerender()
})
$('adults-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  state.adults = btn.dataset.adults === '' ? null : Number(btn.dataset.adults); rerender()
})
$('type-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  const key = btn.dataset.type, i = state.types.indexOf(key)
  if (i >= 0) state.types.splice(i, 1); else state.types.push(key)
  rerender()
})
$('hotel-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  const id = btn.dataset.hotel
  if (state.selectedHotels.has(id)) state.selectedHotels.delete(id)
  else state.selectedHotels.add(id)
  rerender()
})
$('date-filter').addEventListener('change', e => { state.dateFilter = e.target.value; renderBoard() })
$('room-filter').addEventListener('change', e => { state.roomFilter = e.target.value; renderBoard() })

$('board').addEventListener('click', e => {
  const td = e.target.closest('.cb-cell'); if (!td || !td.dataset.bucket) return
  openDetail(td.dataset.bucket, td.dataset.hotel)
})
$('board').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const td = e.target.closest('.cb-cell'); if (!td || !td.dataset.bucket) return
  e.preventDefault(); openDetail(td.dataset.bucket, td.dataset.hotel)
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

// ---------- 初期化 ----------

async function init() {
  await fetchBoard()
  $('mode-badge').textContent = 'モード: ' + (state.isRealMode ? '実データ収集' : 'シミュレーション')
  initSelectedHotels()
  renderFilters()
  renderBoard()
}
init()
