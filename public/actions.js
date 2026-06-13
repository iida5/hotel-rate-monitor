// 競合アクション (ランキング & イベントストーリー) - フロントエンド
//
// /api/rateshop/timeline (全施設のアラート履歴) を読み、2つの見方を出す:
//   1. ランキング   期間内のイベント回数をホテル別に集計。誰がいちばん動いているか
//   2. ストーリー   チェックイン日を選び、その日の出来事を古い順にナラティブ表示。
//                   直前の他社の同方向の動き(追随)や、自社最安を割った瞬間を強調
//
// 共通ヘルパー (TYPE_LABELS, typeGroup, esc, fmtDate, fmtTime, yen, eventDetail 等) は
// rateshop-common.js から読み込む。期間だけサーバー再取得、人数等はクライアント側。

'use strict'

const $ = id => document.getElementById(id)

const PERIODS = [
  { key: '1', label: '24時間', days: 1 },
  { key: '3', label: '3日', days: 3 },
  { key: '7', label: '7日', days: 7 },
  { key: '30', label: '30日', days: 30 },
  { key: 'all', label: '全期間', days: null },
]

// ランキングの集計列 (typeGroup 単位)
const RANK_COLS = [
  { key: 'price_down', label: '値下げ', cls: 'price_down' },
  { key: 'price_up', label: '値上げ', cls: 'price_up' },
  { key: 'soldout', label: '売止', cls: 'soldout' },
  { key: 'restock', label: '再開', cls: 'restock' },
  { key: 'stock', label: '在庫', cls: 'stock' },
  { key: 'sale', label: 'セール', cls: 'sale' },
  { key: 'point', label: 'P', cls: 'point' },
]

// 「追随」とみなす時間窓 (同じ日付で他社が同方向の価格変動をした直後)
const FOLLOW_WINDOW_MS = 90 * 60_000

const state = {
  hotels: [],
  adultsList: null,
  adults: null,
  isRealMode: false,
  period: '7',
  events: [],
  storyDate: '',
}

// ---------- データ取得 ----------

async function fetchData() {
  const params = new URLSearchParams()
  const period = PERIODS.find(p => p.key === state.period)
  if (period && period.days != null) params.set('from', String(Date.now() - period.days * 86_400_000))
  try {
    const res = await fetch('/api/rateshop/timeline?' + params).then(r => r.json())
    state.hotels = res.hotels ?? []
    state.adultsList = res.adultsList ?? null
    state.isRealMode = state.adultsList != null
    state.events = res.events ?? []
    return true
  } catch {
    return false
  }
}

// 人数フィルタ後のイベント (adults を持たないイベントは常に通す)
function scopedEvents() {
  return state.events.filter(a => state.adults == null || a.adults == null || a.adults === state.adults)
}

// ---------- ランキング ----------

function buildRanking(events) {
  const map = new Map()
  for (const h of state.hotels) map.set(h.id, { id: h.id, name: h.name, own: !!h.own, counts: {}, total: 0 })
  for (const a of events) {
    let e = map.get(a.hotelId)
    if (!e) { e = { id: a.hotelId, name: a.hotel ?? a.hotelId, own: !!a.own, counts: {}, total: 0 }; map.set(a.hotelId, e) }
    const g = typeGroup(a.type)
    e.counts[g] = (e.counts[g] ?? 0) + 1
    e.total++
  }
  return [...map.values()].sort((x, y) => y.total - x.total || (x.own ? 1 : 0) - (y.own ? 1 : 0))
}

function renderRanking(events) {
  const rows = buildRanking(events)
  const maxTotal = Math.max(1, ...rows.map(r => r.total))
  const active = rows.filter(r => r.total > 0).length
  $('rank-note').textContent = `${active}/${rows.length}軒が稼働`

  const head = '<thead><tr><th class="rk-rank">#</th><th class="rk-name">ホテル</th>' +
    RANK_COLS.map(c => `<th class="rk-num">${c.label}</th>`).join('') +
    '<th class="rk-num">合計</th><th class="rk-bar">アクション量</th></tr></thead>'

  const body = '<tbody>' + rows.map((r, i) => {
    const cells = RANK_COLS.map(c => {
      const n = r.counts[c.key] ?? 0
      return `<td class="rk-num ${n ? c.cls : 'zero'}">${n || '·'}</td>`
    }).join('')
    const w = Math.round((r.total / maxTotal) * 100)
    return `<tr class="${r.own ? 'own' : ''}">` +
      `<td class="rk-rank">${r.total ? i + 1 : '–'}</td>` +
      `<td class="rk-name">${esc(r.name)}${r.own ? ' <span class="rs-own-tag">自社</span>' : ''}</td>` +
      cells +
      `<td class="rk-num rk-total">${r.total}</td>` +
      `<td class="rk-bar"><span class="rk-bar-track"><span class="rk-bar-fill${r.own ? ' own' : ''}" style="width:${w}%"></span></span></td>` +
      '</tr>'
  }).join('') + '</tbody>'

  $('ranking').innerHTML = head + body
}

// ---------- ストーリー ----------

// 価格変動の方向 (値上げ +1 / 値下げ -1 / それ以外 0)
function priceDir(a) {
  return a.type === 'price_up' ? 1 : a.type === 'price_down' ? -1 : 0
}

function buildStory(events, date) {
  const evs = events.filter(a => a.date === date).sort((a, b) => a.t - b.t) // 古い順 = 物語の流れ
  return evs.map((a, i) => {
    const dir = priceDir(a)
    let follow = null
    if (dir !== 0) {
      // 直前 FOLLOW_WINDOW_MS 以内に、別ホテルが同方向へ動いていたら「追随」
      for (let j = i - 1; j >= 0; j--) {
        const b = evs[j]
        if (a.t - b.t > FOLLOW_WINDOW_MS) break
        if (b.hotelId !== a.hotelId && priceDir(b) === dir) { follow = b; break }
      }
    }
    // 競合が自社最安を割った瞬間
    const undercut = !a.own && a.price != null && a.ownPrice != null && a.price < a.ownPrice
    return { a, follow, undercut }
  })
}

function storyCard({ a, follow, undercut }) {
  const g = typeGroup(a.type)
  const link = state.isRealMode && a.date
    ? ` <a class="rs-link" href="${rakutenPlanUrl(a.hotelId, a.date, a.adults)}" target="_blank" rel="noopener">楽天↗</a>` : ''
  const tags =
    (follow ? `<span class="st-tag follow">${esc(follow.hotel)}に追随か</span>` : '') +
    (undercut ? '<span class="st-tag undercut">自社を下回る</span>' : '')
  return `<li class="st-item ${g}">
    <span class="st-time">${fmtTime(a.t)}</span>
    <div class="st-body">
      <div class="st-lead"><span class="rs-badge ${g}">${TYPE_LABELS[a.type]}</span> <b>${esc(a.hotel)}</b>${a.own ? ' <span class="rs-own-tag">自社</span>' : ''}${a.adults ? ` <span class="muted">${a.adults}名</span>` : ''}${tags}</div>
      <div class="st-detail">${esc(a.plan ?? '')}${link}</div>
      <div class="st-detail">${eventDetail(a)}</div>
    </div>
  </li>`
}

function renderStory(events) {
  const sel = $('story-date')
  const dates = [...new Set(events.map(a => a.date).filter(Boolean))].sort()
  if (!dates.length) {
    sel.innerHTML = ''
    $('story-caption').textContent = 'イベントストーリー'
    $('story').innerHTML = '<p class="muted">この期間に出来事がありません。期間を広げてください。</p>'
    return
  }
  // 既定: イベントが最も多い日付 (いちばん荒れた日)
  if (!state.storyDate || !dates.includes(state.storyDate)) {
    const countByDate = new Map()
    for (const a of events) if (a.date) countByDate.set(a.date, (countByDate.get(a.date) ?? 0) + 1)
    state.storyDate = [...countByDate.entries()].sort((x, y) => y[1] - x[1])[0][0]
  }
  sel.innerHTML = dates.map(d =>
    `<option value="${d}" ${state.storyDate === d ? 'selected' : ''}>${fmtDate(d)}泊</option>`).join('')

  const cards = buildStory(events, state.storyDate)
  $('story-caption').textContent = `${fmtDate(state.storyDate)}泊 のイベントストーリー`
  if (!cards.length) {
    $('story').innerHTML = '<p class="muted">この日付の出来事はありません。</p>'
    return
  }
  const follows = cards.filter(c => c.follow).length
  const undercuts = cards.filter(c => c.undercut).length
  const summary = `<div class="st-summary">この日 <b>${cards.length}件</b>の動き` +
    (follows ? ` ・ 追随 <b>${follows}件</b>` : '') +
    (undercuts ? ` ・ 自社を下回った <b class="up-txt">${undercuts}件</b>` : '') + '</div>'
  $('story').innerHTML = summary + `<ul class="st-list">${cards.map(storyCard).join('')}</ul>`
}

// ---------- 描画まとめ ----------

function renderPeriodChips() {
  $('period-chips').innerHTML = PERIODS.map(p =>
    `<button class="chip ${state.period === p.key ? 'active' : ''}" data-period="${p.key}">${p.label}</button>`).join('')
}
function renderAdultsChips() {
  const field = $('adults-field')
  if (!state.adultsList || state.adultsList.length <= 1) { field.classList.add('hidden'); return }
  field.classList.remove('hidden')
  const chips = [{ v: null, label: 'すべて' }, ...state.adultsList.map(a => ({ v: a, label: `${a}名` }))]
  $('adults-chips').innerHTML = chips.map(c =>
    `<button class="chip ${state.adults === c.v ? 'active' : ''}" data-adults="${c.v == null ? '' : c.v}">${c.label}</button>`).join('')
}

function renderAll() {
  const period = PERIODS.find(p => p.key === state.period)
  $('range-note').textContent = `直近${period?.label ?? ''}・全${state.events.length}件`
  renderPeriodChips()
  renderAdultsChips()
  const events = scopedEvents()
  renderRanking(events)
  renderStory(events)
}

// ---------- 操作 ----------

async function reload() { await fetchData(); renderAll() }

$('period-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  state.period = btn.dataset.period; reload()
})
$('adults-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip'); if (!btn) return
  state.adults = btn.dataset.adults === '' ? null : Number(btn.dataset.adults); renderAll()
})
$('story-date').addEventListener('change', e => {
  state.storyDate = e.target.value; renderStory(scopedEvents())
})

// ---------- 時計 ----------

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
setInterval(tickClock, 1000)
tickClock()

// ---------- 初期化 ----------

async function init() {
  await fetchData()
  $('mode-badge').textContent = 'モード: ' + (state.isRealMode ? '実データ収集' : 'シミュレーション')
  renderAll()
}
init()
