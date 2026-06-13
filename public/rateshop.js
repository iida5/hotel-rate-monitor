// 競合レート監視 - フロントエンド
//
// /api/rateshop/stream (Server-Sent Events) を購読し、
// 価格比較グリッドとアラートフィードを更新する。
// アラートのフィルタ条件 (種類・しきい値・自社表示・通知) は localStorage に保存。
//
// グリッドは「自社とのポジション比較」を主役にする:
//   - 競合セルに自社との差額 (自社より安い競合は強調色)
//   - 自社行に日付ごとの価格順位 (n位/m軒)
//   - 価格セルのクリックで観測履歴の推移チャートを表示

'use strict'

const $ = id => document.getElementById(id)

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

// フィルタチップは stock_up/stock_down と sale_start/sale_end をそれぞれ1つにまとめる
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

const FLASH_CLASS = {
  price_up: 'fl-up',
  price_down: 'fl-down',
  soldout: 'fl-bad',
  restock: 'fl-good',
  stock: 'fl-stk',
  sale: 'fl-sale',
  point: 'fl-point',
}

const state = {
  hotels: [],
  dates: [],
  adultsList: null,     // 実データモードの人数プロファイル (例 [1,2])。simはnull
  selAdults: null,      // グリッドに表示中の人数プロファイル
  grid: new Map(),      // key -> セル
  meta: new Map(),      // "hotel|date|人数" -> {sale:[ラベル], points} 現在のセール/ポイント状態
  expanded: new Set(),  // 内訳展開中のホテルID
  alerts: [],           // 新しい順
  lastObservedT: null,  // 直近の観測時刻 (スキャン表示の重複防止)
  observing: null,      // いま観測中の {hotelId, date} (グリッドのハイライト用)
  scanCycle: null,      // 進捗バー: 現在表示中の巡回番号
  scanMax: 0,           // 進捗バー: 今回の巡回で到達した最大セル番号 (逆行防止)
  cellsSeen: new Set(), // 今回の巡回で更新済みのセルキー (各セルのミニバー用)
  justCell: null,       // 直近に取得したセルキー (バーを伸ばすアニメ用)
  filters: loadFilters(),
}

function loadFilters() {
  // v3: セール・ポイントの種別を追加し、既定でONにする
  // (在庫±1室の通知で大事な値下げが埋もれるのを防ぐため在庫増減は既定OFFのまま)
  const def = { v: 3, types: ['price_up', 'price_down', 'soldout', 'restock', 'sale', 'point'], threshold: 5, showOwn: false, notify: false }
  try {
    const saved = JSON.parse(localStorage.getItem('rateshop-filters') || '{}')
    if (saved.v !== 3) return { ...def, notify: !!saved.notify, showOwn: !!saved.showOwn }
    return { ...def, ...saved }
  } catch {
    return def
  }
}

function saveFilters() {
  localStorage.setItem('rateshop-filters', JSON.stringify(state.filters))
}

// ---------- 整形ユーティリティ ----------

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const DOW = ['日', '月', '火', '水', '木', '金', '土']

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  return `${m}/${d}(${DOW[dow]})`
}

// 金土のみ強調 (ビジネスホテルでは日曜泊はむしろ平日並みに安い日のため)
const isWeekendDate = iso => {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  return dow === 5 || dow === 6
}

// 楽天トラベルのプラン一覧ページURL (実データモードのセル・アラートからの裏取り用)
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

// 実データモード (楽天の施設番号が使われている) か
const isRealMode = () => state.adultsList != null

// セルの鮮度: 最終観測からこの時間を超えたら「古い」表示にする
const STALE_MS = 30 * 60_000

// 時刻表示: 今日以外は日付も付ける (「昨夜のアラートか今朝か」が分かるように)
function fmtTime(t) {
  const d = new Date(t)
  const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm.slice(0, 5)}`
}

const yen = v => '¥' + Number(v).toLocaleString()

// 残室数の表記: プローブ推定値は「約」を付けてサイト表示の実値 (バッジ) と区別する
const stockTxt = (stock, plus, src) =>
  stock == null ? '' : `${src === 'probe' ? '約' : ''}${stock}${plus ? '+' : ''}室`

const STOCK_PROBE_NOTE = '「約」付きの残室は推定値 (予約画面で一度に予約できた室数)。「約」なしはサイト表示の実値'

// 割引価格 (クーポン適用後) の併記。通常価格より安いときだけ表示する。
// 比較・アラートの基準は通常価格なので、これはあくまで補足表示。
function discTxt(price, discPrice) {
  if (discPrice == null || !price || discPrice >= price) return ''
  const pct = Math.round(((discPrice - price) / price) * 100)
  return `<span class="rs-disc">割引 ${yen(discPrice)} <span class="rs-disc-pct">(${pct}%)</span></span>`
}

// ---------- アラートのフィルタと表示 ----------

function passes(a) {
  if (a.own && !state.filters.showOwn) return false
  if (!state.filters.types.includes(typeGroup(a.type))) return false
  if ((a.type === 'price_up' || a.type === 'price_down') && Math.abs(a.pct) < state.filters.threshold) return false
  return true
}

function alertDetail(a) {
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
      return `販売再開 ${a.price != null ? yen(a.price) : ''}${a.stock != null ? ` / 残${stockTxt(a.stock, a.stockPlus, a.stockSrc)}` : ''}`
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

function feedItem(a, isNew) {
  // 実データモードでは楽天の該当ページに1クリックで飛べるようにする (裏取り用)
  const link = isRealMode()
    ? ` <a class="rs-link" href="${rakutenPlanUrl(a.hotelId, a.date, a.adults)}" target="_blank" rel="noopener" title="楽天トラベルの該当ページを開く">楽天↗</a>`
    : ''
  return `<li class="rs-alert ${typeGroup(a.type)} ${isNew ? 'rs-new' : ''}">
    <span class="feed-time">${fmtTime(a.t)}</span>
    <div class="rs-alert-body">
      <div><span class="rs-badge ${typeGroup(a.type)}">${TYPE_LABELS[a.type]}</span> <b>${esc(a.hotel)}</b>${a.own ? ' <span class="rs-own-tag">自社</span>' : ''}</div>
      <div class="rs-alert-meta">${fmtDate(a.date)}泊${a.adults ? `・${a.adults}名` : ''}・${esc(a.plan)}${link}</div>
      <div class="rs-alert-detail">${alertDetail(a)}</div>
    </div>
  </li>`
}

function renderFeed(newIds = new Set()) {
  const visible = state.alerts.filter(passes).slice(0, 100)
  $('alerts').innerHTML = visible.length
    ? visible.map(a => feedItem(a, newIds.has(a.id))).join('')
    : `<li class="rs-empty-state">
        <span class="rs-empty-circle"><svg class="ico ico-lg"><use href="#i-bell"/></svg></span>
        <span>条件に合うアラートはまだありません</span>
      </li>`
  $('alert-count').textContent = `(表示 ${visible.length} 件)`
}

// ---------- 前回確認時からの要約 (朝イチで全部読まなくて済むように) ----------

// 要約は localStorage に6時間保持し、F5やうっかり再読込でも消えないようにする。
// 「前回確認」を進めるのは30分以上間が空いたときだけ (F5連打で要約が痩せないように)
async function buildSummary() {
  const SEEN = 'rateshop-last-seen', SAVED = 'rateshop-summary'
  const now = Date.now()
  const lastSeen = Number(localStorage.getItem(SEEN) || 0)
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(SAVED) || 'null') } catch { /* 破損時は無視 */ }
  if (saved && now > saved.until) { saved = null; localStorage.removeItem(SAVED) }

  let html = null
  if (lastSeen && now - lastSeen > 30 * 60_000) {
    localStorage.setItem(SEEN, String(now))
    let alerts
    try {
      alerts = await fetch('/api/rateshop/alerts?limit=400').then(r => r.json())
    } catch {
      alerts = []
    }
    const since = alerts.filter(a => a.t > lastSeen && !a.own)
    if (since.length) {
      const counts = {}
      for (const a of since) counts[typeGroup(a.type)] = (counts[typeGroup(a.type)] || 0) + 1
      const main = ['price_down', 'soldout', 'price_up', 'restock']
        .filter(k => counts[k])
        .map(k => `<b class="sum-${k}">${TYPE_DEFS.find(t => t.key === k).label} ${counts[k]}件</b>`)
      html = `<span class="rs-summary-head">前回確認 (${fmtTime(lastSeen)}) から</span>` +
        `<span class="rs-summary-body">${main.length ? main.join('・') : '価格・売止の変動なし'}` +
        `${counts.stock ? `<span class="muted">｜在庫増減 ${counts.stock}件</span>` : ''}</span>`
      saved = { html, until: now + 6 * 3600_000 }
      localStorage.setItem(SAVED, JSON.stringify(saved))
    }
  } else if (!lastSeen) {
    localStorage.setItem(SEEN, String(now))
  }

  if (!html && saved) html = saved.html // 直近6時間以内の要約は再表示する
  if (!html) return
  const el = $('feed-summary')
  el.innerHTML = html + `<button class="close-x rs-summary-x" id="summary-close" title="閉じる">✕</button>`
  el.classList.remove('hidden')
  $('summary-close').onclick = () => {
    el.classList.add('hidden')
    localStorage.removeItem(SAVED)
  }
}

// ---------- デスクトップ通知 ----------

function notifyAlerts(list) {
  if (!state.filters.notify || !('Notification' in window) || Notification.permission !== 'granted') return
  for (const a of list.filter(passes).slice(0, 3)) {
    const detail = alertDetail(a).replace(/<[^>]+>/g, '')
    new Notification(`【${TYPE_LABELS[a.type]}】${a.hotel}`, {
      body: `${fmtDate(a.date)}泊「${a.plan}」 ${detail}`,
      tag: 'rateshop-' + a.id,
    })
  }
}

function renderNotifyBtn() {
  const btn = $('notify-btn')
  btn.textContent = `🔔 デスクトップ通知: ${state.filters.notify ? 'ON' : 'OFF'}`
  btn.classList.toggle('active', state.filters.notify)
}

// ---------- 価格比較グリッド ----------

// 選択中の人数プロファイルのセルだけを返す (simは人数なし=全件)
function cellsFor(hotelId, date) {
  const out = []
  for (const [key, c] of state.grid) {
    if (!key.startsWith(`${hotelId}|${date}|`)) continue
    if (state.selAdults != null && c.adults != null && c.adults !== state.selAdults) continue
    out.push(c)
  }
  return out
}

function planListFor(hotelId) {
  const plans = new Map() // planKey -> name
  for (const [key, c] of state.grid) {
    if (!key.startsWith(`${hotelId}|`)) continue
    if (state.selAdults != null && c.adults != null && c.adults !== state.selAdults) continue
    const pk = key.split('|').pop()
    if (!plans.has(pk)) plans.set(pk, c.plan)
  }
  return [...plans.entries()].map(([key, name]) => ({ key, name }))
}

// 内訳行のセルキー (実データモードは人数を含む4部キー)
const cellKeyFor = (hotelId, date, pk) =>
  state.adultsList ? `${hotelId}|${date}|${state.selAdults}|${pk}` : `${hotelId}|${date}|${pk}`

// グリッド集約セルのキー (フラッシュ・観測ハイライト用)
const aggKeyFor = (hotelId, date, adults) =>
  adults != null ? `${hotelId}|${date}|${adults}` : `${hotelId}|${date}`

// 観測の鮮度: 古いセルは淡色化し、ツールチップに観測時刻を出す
function staleInfo(t) {
  if (!isRealMode() || !t) return { cls: '', note: null }
  const age = Date.now() - t
  if (age < STALE_MS) return { cls: '', note: null }
  return { cls: ' stale', note: `観測: ${Math.round(age / 60_000)}分前 (古い可能性があります)` }
}

function cellHtml(dataKey, c) {
  if (!c) return `<td class="rs-cell" data-cell="${dataKey}">--</td>`
  const st = staleInfo(c.t)
  if (!c.avail) return `<td class="rs-cell soldout${st.cls}" data-cell="${dataKey}"${st.note ? ` title="${esc(st.note)}"` : ''}><span class="rs-soldout">満室/売止</span></td>`
  const stock = c.stock != null ? `残${stockTxt(c.stock, c.stockPlus, c.stockSrc)}` : ''
  const tipParts = []
  if (c.planName) tipParts.push(`最安プラン: ${c.planName}`)
  if (c.stockSrc === 'probe') tipParts.push(STOCK_PROBE_NOTE)
  if (st.note) tipParts.push(st.note)
  const tip = tipParts.length ? ` title="${esc(tipParts.join('\n'))}"` : ''
  return `<td class="rs-cell${st.cls}" data-cell="${dataKey}"${tip}><span class="rs-price">${yen(c.price)}</span>${discTxt(c.price, c.discPrice)}<span class="rs-stock">${stock}</span></td>`
}

function buildGrid() {
  const obs = state.observing
  const own = state.hotels.find(h => h.own)

  // 各集約セルの巡回更新インジケータ (実データモードかつ巡回が始まっているときだけ)。
  // 直近に取得したセルは伸びるアニメ (just)、それ以外の取得済みは静止の満タン (done)、未取得はグレー。
  const showProg = isRealMode() && state.scanCycle != null
  const cellProg = key => {
    if (!showProg) return ''
    const cls = key === state.justCell ? ' just' : state.cellsSeen.has(key) ? ' done' : ''
    return `<span class="rs-cell-prog${cls}"></span>`
  }

  // セル右上の現在状態バッジ: セール対象あり (🏷) / ポイント倍率
  const metaBadge = key => {
    const m = state.meta.get(key)
    if (!m) return ''
    const tags = []
    if (m.sale && m.sale.length) tags.push(`<span class="rs-tag sale" title="${esc(m.sale.join(' / '))}">🏷${m.sale.length > 1 ? m.sale.length : ''}</span>`)
    if (m.points != null) tags.push(`<span class="rs-tag point" title="ポイント${m.points}倍">P${m.points}</span>`)
    return tags.length ? `<span class="rs-tags">${tags.join('')}</span>` : ''
  }

  // 日付ごとの「ホテル別最安セル」を先に計算 (自社差額・順位に使う)
  const minBy = new Map() // `${hotelId}|${date}` -> 最安セル
  for (const h of state.hotels) {
    for (const d of state.dates) {
      const avail = cellsFor(h.id, d).filter(c => c.avail)
      if (avail.length) minBy.set(`${h.id}|${d}`, avail.reduce((a, c) => (c.price < a.price ? c : a)))
    }
  }

  let html = '<thead><tr><th class="rs-hotel-col">ホテル</th>'
    + state.dates.map(d =>
      `<th class="${isWeekendDate(d) ? 'weekend' : ''} ${obs?.date === d ? 'observing' : ''}">${fmtDate(d)}</th>`).join('')
    + '</tr></thead><tbody>'

  for (const h of state.hotels) {
    const observingRow = obs?.hotelId === h.id
    html += `<tr class="rs-hotel-row ${h.own ? 'own' : ''} ${observingRow ? 'observing' : ''}" data-hotel="${h.id}">`
    html += `<td class="rs-hotel-col"><span class="rs-caret">${state.expanded.has(h.id) ? '▾' : '▸'}</span>${esc(h.name)}${h.own ? ' <span class="rs-own-tag">自社</span>' : ''}</td>`
    for (const d of state.dates) {
      const cells = cellsFor(h.id, d)
      const avail = cells.filter(c => c.avail)
      const dataKey = aggKeyFor(h.id, d, state.selAdults)
      const wk = isWeekendDate(d) ? ' weekend' : ''
      const oc = observingRow && obs?.date === d ? ' rs-observing' : ''
      if (!cells.length) {
        html += `<td class="rs-cell${wk}${oc}" data-cell="${dataKey}">--${cellProg(dataKey)}</td>`
      } else if (!avail.length) {
        html += `<td class="rs-cell soldout${wk}${oc}" data-cell="${dataKey}"><span class="rs-soldout">満室/売止</span>${cellProg(dataKey)}</td>`
      } else {
        const min = minBy.get(`${h.id}|${d}`)
        // 残室: 実値・推定が取れた部屋タイプ分のみ合算。不明タイプや上限到達があれば「+」
        const known = avail.filter(c => c.stock != null)
        const anyProbe = known.some(c => c.stockSrc === 'probe')
        const sub = known.length
          ? `残${stockTxt(known.reduce((s, c) => s + c.stock, 0), known.length < avail.length || known.some(c => c.stockPlus), anyProbe ? 'probe' : 'badge')}`
          : `${avail.length}タイプ`

        // 自社とのポジション (競合行: 差額 / 自社行: 順位)
        let posHtml = '', posCls = ''
        if (own) {
          const ownMin = minBy.get(`${own.id}|${d}`)
          if (h.own) {
            const others = state.hotels.filter(x => !x.own).map(x => minBy.get(`${x.id}|${d}`)).filter(Boolean)
            if (ownMin && others.length) {
              const rank = 1 + others.filter(c => c.price < ownMin.price).length
              posHtml = `<span class="rs-pos rank">${rank}位/${others.length + 1}軒</span>`
            }
          } else if (ownMin) {
            const diff = min.price - ownMin.price
            if (diff < 0) { posHtml = `<span class="rs-pos cheaper">自社より${Math.abs(diff).toLocaleString()}安</span>`; posCls = ' below-own' }
            else if (diff > 0) posHtml = `<span class="rs-pos pricier">自社+${diff.toLocaleString()}</span>`
            else posHtml = `<span class="rs-pos">自社と同額</span>`
          }
        }

        const st = staleInfo(min.t)
        const tipParts = []
        if (min.planName) tipParts.push(`最安プラン: ${min.planName}`)
        if (anyProbe) tipParts.push(STOCK_PROBE_NOTE)
        if (st.note) tipParts.push(st.note)
        const tip = tipParts.length ? ` title="${esc(tipParts.join('\n'))}"` : ''
        html += `<td class="rs-cell${posCls}${wk}${oc}${st.cls}" data-cell="${dataKey}"${tip}>` +
          `${metaBadge(dataKey)}<span class="rs-price">${yen(min.price)}</span>${discTxt(min.price, min.discPrice)}${posHtml}<span class="rs-stock">${sub}</span>${cellProg(dataKey)}</td>`
      }
    }
    html += '</tr>'

    if (state.expanded.has(h.id)) {
      for (const plan of planListFor(h.id)) {
        html += `<tr class="rs-plan-row"><td class="rs-hotel-col rs-plan-name" title="${esc(plan.name)}">${esc(plan.name)}</td>`
        for (const d of state.dates) {
          const key = cellKeyFor(h.id, d, plan.key)
          html += cellHtml(key, state.grid.get(key))
        }
        html += '</tr>'
      }
    }
  }
  $('grid').innerHTML = html + '</tbody>'
}

// 新着アラートのあったセルを一瞬光らせる
function flashCells(alerts) {
  for (const a of alerts) {
    const cls = FLASH_CLASS[typeGroup(a.type)]
    const aggKey = aggKeyFor(a.hotelId, a.date, a.adults ?? null)
    for (const sel of [aggKey, a.key]) {
      const td = document.querySelector(`td[data-cell="${CSS.escape(sel)}"]`)
      if (!td) continue
      td.classList.remove(cls)
      void td.offsetWidth // アニメーション再トリガー
      td.classList.add(cls)
      setTimeout(() => td.classList.remove(cls), 1700)
    }
  }
}

// ---------- 人数プロファイル切替 ----------

function buildAdultsTabs() {
  const el = $('adults-tabs')
  if (!state.adultsList || state.adultsList.length < 2) {
    el.classList.add('hidden')
    el.innerHTML = ''
    return
  }
  el.classList.remove('hidden')
  el.innerHTML = state.adultsList.map(a =>
    `<button class="chip ${a === state.selAdults ? 'active' : ''}" data-adults="${a}">${a}名利用</button>`).join('')
}

$('adults-tabs').addEventListener('click', e => {
  const btn = e.target.closest('[data-adults]')
  if (!btn) return
  state.selAdults = Number(btn.dataset.adults)
  buildAdultsTabs()
  buildGrid()
})

// ---------- KPI ----------

function updateKpis(kpi) {
  $('kpi-price').textContent = `${kpi.priceChanges1h}回`
  $('kpi-soldout').textContent = kpi.soldout
  $('kpi-soldout-sub').textContent = `/ 全${kpi.cells}セル`
  $('kpi-alerts').textContent = kpi.alerts24h
  $('kpi-best-label').textContent = '競合最安' +
    (kpi.bestDate ? ` (${fmtDate(kpi.bestDate)}泊${kpi.bestAdults ? `・${kpi.bestAdults}名` : ''})` : '')
  if (kpi.best) {
    $('kpi-best').textContent = yen(kpi.best.price)
    let sub = kpi.best.hotel
    if (kpi.ownBest) {
      const diff = kpi.ownBest.price - kpi.best.price
      sub += diff > 0 ? ` / 自社が${diff.toLocaleString()}円高い`
        : diff < 0 ? ` / 自社が${Math.abs(diff).toLocaleString()}円安い`
        : ' / 自社と同額'
    }
    $('kpi-best-sub').textContent = sub
    $('kpi-best-sub').title = kpi.ownBest ? `自社最安 ${yen(kpi.ownBest.price)}` : ''
  } else {
    $('kpi-best').textContent = '--'
    $('kpi-best-sub').textContent = ''
  }
}

// ---------- 観測インジケータ ----------

// 新しい観測が届くたびにレーダーを点滅させ、観測対象とサイクル進捗を表示する
// 収集停止の検知: 実データモードで最終観測が古ければ警告を出す
// (古い数字を「現在値」と信じて値付けする事故が一番怖いため)。
// SSEが止まっても気づけるよう、SSE受信時に加えて30秒ごとにも再チェックする
function refreshStallWarning() {
  const latest = isRealMode()
    ? Math.max(state.lastObservedT ?? 0, ...[...state.grid.values()].map(c => c.t ?? 0))
    : 0
  const stalled = latest > 0 && Date.now() - latest > STALE_MS
  $('scan-text').parentElement.classList.toggle('warn', stalled)
  if (stalled) {
    $('scan-text').textContent = `⚠ 最終観測から${Math.round((Date.now() - latest) / 60_000)}分経過 — 収集が止まっている可能性があります`
  }
  return stalled
}
setInterval(refreshStallWarning, 30_000)

// 巡回 (cycle) の進捗状態を更新する。グリッド再描画より前に呼ぶこと。
// 並列ワーカーが前後して届くので「今回の巡回で見た最大セル番号」を進捗とし逆行を防ぐ。
// 巡回が変わったら 0 にリセットし、更新済みセルの記録もクリアして満タン→0→…と繰り返す。
function trackScan(lo) {
  if (!lo || !lo.idx) { state.justCell = null; return }
  if (lo.cycle !== state.scanCycle) {
    state.scanCycle = lo.cycle
    state.scanMax = 0
    state.cellsSeen = new Set() // 新しい巡回: 全セルを「未取得 (グレー)」に戻す
  }
  state.scanMax = Math.max(state.scanMax, lo.idx)
  state.justCell = lo.hotelId ? aggKeyFor(lo.hotelId, lo.date, lo.adults ?? null) : null
  if (state.justCell) state.cellsSeen.add(state.justCell)
}

// 取得状況のプログレスバー: 今回の巡回で何セル取れたかを表示する (進捗値は trackScan が更新済み)。
function updateProgress(lo, stalled) {
  const wrap = $('scan-progress')
  if (stalled || !lo || !lo.idx || !lo.total) {
    wrap.classList.add('hidden')
    return
  }
  const done = Math.min(state.scanMax, lo.total)
  const pct = Math.round((done / lo.total) * 100)
  const full = done >= lo.total
  wrap.classList.remove('hidden')
  const bar = $('scan-progress-bar')
  bar.style.width = pct + '%'
  bar.classList.toggle('full', full)
  $('scan-progress-label').textContent = full ? `巡回完了 ${done}/${lo.total}` : `取得中 ${done}/${lo.total} (${pct}%)`
}

function updateScanIndicator(msg) {
  const lo = msg.lastObserved

  const stalled = refreshStallWarning()
  updateProgress(lo, stalled)

  if (stalled) {
    // 警告表示を優先 (通常の「観測中」表示で上書きしない)
  } else if (lo) {
    // 件数 (idx/total) は下の進捗バーが表示するのでここでは出さない
    $('scan-text').textContent = `観測中: ${lo.hotel} ${fmtDate(lo.date)}泊${lo.adults ? ` ${lo.adults}名` : ''} ${fmtTime(lo.t)}`
  } else {
    $('scan-text').textContent = `更新: ${fmtTime(msg.t)}`
  }

  // レーダーの波紋アニメーションを再トリガー
  const radar = $('radar')
  radar.classList.remove('ping')
  void radar.offsetWidth
  radar.classList.add('ping')

  // 今まさに観測したセルをスキャン色で光らせる (アラートの有無に関係なく)
  if (lo?.hotelId && state.lastObservedT !== lo.t) {
    state.lastObservedT = lo.t
    const td = document.querySelector(`td[data-cell="${CSS.escape(aggKeyFor(lo.hotelId, lo.date, lo.adults ?? null))}"]`)
    if (td) {
      td.classList.remove('fl-scan')
      void td.offsetWidth
      td.classList.add('fl-scan')
      setTimeout(() => td.classList.remove('fl-scan'), 1400)
    }
  }
}

// ---------- 推移チャート (セルクリック) ----------

// rc を指定すると「その部屋タイプだけ」の推移 (内訳行のセルクリック)
async function openHistory(hotelId, date, rc = null, rcName = null) {
  const hotel = state.hotels.find(h => h.id === hotelId)
  $('history-caption').textContent = `${hotel?.name ?? hotelId}・${fmtDate(date)}泊` +
    (rcName ? `「${rcName}」` : '') + 'の推移' +
    (state.selAdults ? ` (${state.selAdults}名)` : '')
  $('history-body').innerHTML = '<p class="muted">読み込み中…</p>'
  // 実データモードでは楽天の該当ページへの裏取りリンクを出す
  const link = $('history-link')
  if (isRealMode()) {
    link.href = rakutenPlanUrl(hotelId, date, state.selAdults)
    link.classList.remove('hidden')
  } else {
    link.classList.add('hidden')
  }
  $('history-overlay').classList.remove('hidden')
  try {
    const q = new URLSearchParams({ hotel: hotelId, date })
    if (state.selAdults != null) q.set('adults', state.selAdults)
    const { history } = await fetch('/api/rateshop/history?' + q).then(r => r.json())
    renderHistory(history ?? [], rc)
  } catch {
    $('history-body').innerHTML = '<p class="muted">履歴を取得できませんでした</p>'
  }
}

// 観測履歴レコード [{t, rooms:[{rc, plan, price, stock, stockSrc, avail}]}] から
// 「最安値」と「残室合計」の推移チャート (SVG) と最新の部屋タイプ内訳を描く。
// roomClass (rc) を指定するとその部屋タイプ単独の推移になる
function renderHistory(records, rc = null) {
  const pts = records.map(r => {
    const rooms = (r.rooms ?? []).filter(x => rc == null || x.rc === rc)
    const avail = rooms.filter(x => x.avail && x.price)
    const known = avail.filter(x => x.stock != null)
    return {
      t: r.t,
      price: avail.length ? Math.min(...avail.map(x => x.price)) : null,
      stock: known.length ? known.reduce((s, x) => s + x.stock, 0) : null,
      stockPlus: known.some(x => x.stockPlus) || known.length < avail.length,
      soldout: !avail.length,
    }
  })
  const priced = pts.filter(p => p.price != null)
  if (priced.length < 2) {
    $('history-body').innerHTML =
      '<p class="muted">まだ推移を描けるだけの観測履歴がありません。監視を続けると、このホテル×日付の最安値と残室の推移がここに表示されます。</p>'
      + latestRoomsTable(records, rc)
    return
  }

  const W = 640, H = 230, L = 58, R = 40, T = 14, B = 30
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t
  const x = t => L + (W - L - R) * (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0))
  const pMin = Math.min(...priced.map(p => p.price)), pMax = Math.max(...priced.map(p => p.price))
  const pad = Math.max(200, Math.round((pMax - pMin) * 0.15))
  const yLo = pMin - pad, yHi = pMax + pad
  const y = v => T + (H - T - B) * (1 - (v - yLo) / (yHi - yLo))
  const sMax = Math.max(1, ...pts.filter(p => p.stock != null).map(p => p.stock))
  const ys = v => T + (H - T - B) * (1 - v / (sMax * 1.15))

  const line = priced.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
  const stocked = pts.filter(p => p.stock != null)
  const stockLine = stocked.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${ys(p.stock).toFixed(1)}`).join(' ')
  const dots = priced.map(p =>
    `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="3" class="hc-dot"><title>${fmtTime(p.t)}  ${yen(p.price)}${p.stock != null ? ` / 残${p.stock}${p.stockPlus ? '+' : ''}室` : ''}</title></circle>`).join('')
  const soldoutMarks = pts.filter(p => p.soldout).map(p =>
    `<text x="${x(p.t).toFixed(1)}" y="${H - B + 16}" class="hc-soldout" text-anchor="middle">満</text>`).join('')

  $('history-body').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="hc" role="img" aria-label="価格推移チャート">
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="hc-axis"/>
      <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="hc-axis"/>
      <text x="${L - 6}" y="${y(pMax) + 4}" class="hc-lbl" text-anchor="end">${yen(pMax)}</text>
      <text x="${L - 6}" y="${y(pMin) + 4}" class="hc-lbl" text-anchor="end">${yen(pMin)}</text>
      <text x="${L}" y="${H - 8}" class="hc-lbl">${fmtTime(t0)}</text>
      <text x="${W - R}" y="${H - 8}" class="hc-lbl" text-anchor="end">${fmtTime(t1)}</text>
      ${stockLine ? `<path d="${stockLine}" class="hc-stock"/><text x="${W - R + 4}" y="${ys(sMax) + 4}" class="hc-lbl hc-stock-lbl">残${sMax}室</text>` : ''}
      <path d="${line}" class="hc-price"/>
      ${dots}
      ${soldoutMarks}
    </svg>
    <p class="hc-legend"><span class="hc-key price"></span>最安値 <span class="hc-key stock"></span>${rc ? '残室' : '残室合計'} (推定含む)　点にカーソルで詳細</p>
    ${latestRoomsTable(records, rc)}`
}

function latestRoomsTable(records, rc = null) {
  const last = records[records.length - 1]
  const rooms = (last?.rooms ?? []).filter(x => rc == null || x.rc === rc)
  if (!rooms.length) return ''
  const rows = [...rooms]
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    .map(r => `<tr><td>${esc(r.plan ?? r.rc)}</td>` +
      `<td>${r.avail && r.price ? yen(r.price) + (r.discPrice && r.discPrice < r.price ? ` <span class="rs-disc-pct">→${yen(r.discPrice)}</span>` : '') : '<span class="rs-soldout">売止</span>'}</td>` +
      `<td>${r.stock != null ? `残${stockTxt(r.stock, r.stockPlus, r.stockSrc)}` : '--'}</td></tr>`).join('')
  return `<div class="hc-rooms"><div class="rs-ctl-label">最終観測 (${fmtTime(last.t)}) の部屋タイプ別内訳</div>
    <table class="hc-rooms-table"><thead><tr><th>部屋タイプ</th><th>最安値</th><th>残室</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

$('history-close').addEventListener('click', () => $('history-overlay').classList.add('hidden'))
$('history-overlay').addEventListener('click', e => {
  if (e.target.id === 'history-overlay') $('history-overlay').classList.add('hidden')
})

// ---------- SSE 受信 ----------

let firstFrame = true

function onPayload(msg) {
  state.hotels = msg.hotels
  state.dates = msg.dates
  state.adultsList = msg.adultsList ?? null
  if (state.selAdults == null || (state.adultsList && !state.adultsList.includes(state.selAdults))) {
    state.selAdults = state.adultsList?.[0] ?? null
  }
  state.grid = new Map(msg.grid.map(c => [c.key, c]))
  state.meta = new Map((msg.meta ?? []).map(m => [m.key, m]))
  state.observing = msg.lastObserved?.hotelId
    ? { hotelId: msg.lastObserved.hotelId, date: msg.lastObserved.date }
    : null
  $('mode-badge').textContent = 'モード: ' + msg.mode

  if (msg.recent) state.alerts = msg.recent // 初回フレームに履歴が載ってくる

  const fresh = msg.alerts ?? []
  if (!firstFrame && fresh.length) {
    state.alerts = [...fresh].reverse().concat(state.alerts).slice(0, 300)
  }

  updateKpis(msg.kpi)
  buildAdultsTabs()
  trackScan(msg.lastObserved) // グリッド描画前に巡回進捗・更新済みセルを反映
  buildGrid()
  renderFeed(new Set(fresh.map(a => a.id)))
  updateScanIndicator(msg)

  if (!firstFrame && fresh.length) {
    flashCells(fresh)
    notifyAlerts(fresh)
  }

  $('grid-note').textContent = msg.mode.startsWith('シミュレーション')
    ? 'ホテル名クリックで内訳、価格セルクリックで推移チャート ※デモ用の架空データです (実データ監視は README 参照)'
    : `ホテル名クリックで部屋タイプ別の内訳、価格セルクリックで推移チャート (楽天の該当ページにも飛べます)。価格は${state.selAdults ?? '-'}名1室・1泊の部屋タイプ別最安値。${STOCK_PROBE_NOTE}`

  firstFrame = false
}

function connect() {
  const es = new EventSource('/api/rateshop/stream')
  const conn = $('conn')
  es.onopen = () => { conn.className = 'conn live'; conn.lastChild.textContent = 'LIVE' }
  es.onerror = () => { conn.className = 'conn dead'; conn.lastChild.textContent = '再接続中...' }
  es.onmessage = e => {
    try { onPayload(JSON.parse(e.data)) } catch (err) { console.error(err) }
  }
}

// ---------- 操作系 ----------

// ホテル名セル: 内訳の展開/折りたたみ。価格セル: 推移チャート
// (内訳行の価格セルはその部屋タイプ単独の推移を開く)
$('grid').addEventListener('click', e => {
  if (e.target.closest('a')) return // セル内リンクはそのまま飛ばす
  const td = e.target.closest('td')
  if (!td) return
  if (td.classList.contains('rs-hotel-col')) {
    const row = e.target.closest('.rs-hotel-row')
    if (!row) return
    const id = row.dataset.hotel
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id)
    buildGrid()
    return
  }
  const key = td.dataset.cell
  if (!key) return
  const parts = key.split('|')
  const [hotelId, date] = parts
  if (!hotelId || !date) return
  if (td.closest('.rs-plan-row')) {
    const rc = parts[parts.length - 1]
    const rcName = td.closest('tr')?.querySelector('.rs-plan-name')?.textContent ?? null
    openHistory(hotelId, date, rc, rcName)
  } else {
    openHistory(hotelId, date)
  }
})

function buildChips() {
  $('type-chips').innerHTML = TYPE_DEFS.map(t =>
    `<button class="chip ${state.filters.types.includes(t.key) ? 'active' : ''}" data-type="${t.key}">${t.label}</button>`
  ).join('')
}

$('type-chips').addEventListener('click', e => {
  const btn = e.target.closest('[data-type]')
  if (!btn) return
  const key = btn.dataset.type
  const types = state.filters.types
  state.filters.types = types.includes(key) ? types.filter(t => t !== key) : [...types, key]
  saveFilters()
  buildChips()
  renderFeed()
})

$('threshold').addEventListener('change', e => {
  state.filters.threshold = Number(e.target.value)
  saveFilters()
  renderFeed()
})

$('show-own').addEventListener('change', e => {
  state.filters.showOwn = e.target.checked
  saveFilters()
  renderFeed()
})

$('notify-btn').addEventListener('click', async () => {
  if (!state.filters.notify) {
    if (!('Notification' in window)) return
    if (Notification.permission !== 'granted') {
      const p = await Notification.requestPermission()
      if (p !== 'granted') return
    }
    state.filters.notify = true
  } else {
    state.filters.notify = false
  }
  saveFilters()
  renderNotifyBtn()
})

// ---------- 監視設定モーダル ----------

const parseList = s => String(s).split(/[\s,、]+/).map(t => t.trim()).filter(Boolean)

// 監視施設テキストエリアの内容から「自社施設」プルダウンを作り直す
function syncOwnOptions() {
  const hotels = parseList($('cfg-hotels').value).filter(s => /^\d{1,10}$/.test(s))
  const keep = $('cfg-own').value
  $('cfg-own').innerHTML = '<option value="">(指定なし)</option>'
    + hotels.map(h => `<option value="${h}">${h}</option>`).join('')
  $('cfg-own').value = hotels.includes(keep) ? keep : ''
}

function setSettingsMsg(text, cls = '') {
  const el = $('settings-msg')
  el.textContent = text
  el.className = 'settings-msg ' + cls
}

let settingsReady = false // フォームの読み込み完了まで保存を抑止 (読み込み中の保存で空値を送らない)

async function openSettings() {
  setSettingsMsg('読み込み中…', 'busy')
  settingsReady = false
  $('settings-save').disabled = true
  $('settings-overlay').classList.remove('hidden')
  try {
    const { config } = await fetch('/api/rateshop/config').then(r => r.json())
    $('cfg-hotels').value = (config.hotels || []).join('\n')
    $('cfg-dates').value = (config.dates || []).join(',')
    $('cfg-adults').value = (Array.isArray(config.adults) ? config.adults : [config.adults ?? 2]).join(',')
    $('cfg-concurrency').value = config.concurrency ?? 3
    syncOwnOptions()
    $('cfg-own').value = config.own || ''
    setSettingsMsg('')
    settingsReady = true
    $('settings-save').disabled = false
  } catch {
    setSettingsMsg('現在の設定を取得できませんでした', 'error')
  }
}

function closeSettings() {
  $('settings-overlay').classList.add('hidden')
}

async function saveSettings() {
  if (!settingsReady) return
  const payload = {
    hotels: parseList($('cfg-hotels').value),
    own: $('cfg-own').value || null,
    dates: parseList($('cfg-dates').value).map(Number),
    adults: parseList($('cfg-adults').value).map(Number),
    concurrency: Number($('cfg-concurrency').value),
  }
  if (!payload.hotels.every(h => /^\d{1,10}$/.test(h))) {
    setSettingsMsg('監視施設は数字の施設番号のみ指定できます', 'error')
    return
  }
  $('settings-save').disabled = true
  setSettingsMsg('設定を適用し、監視を再起動しています…', 'busy')
  try {
    const res = await fetch('/api/rateshop/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    const c = data.config
    setSettingsMsg(`保存しました (${c.hotels.length}軒 / 日付 ${c.dates.join(',')} / ${c.adults.join('・')}名 / 並列${c.concurrency})`, 'ok')
    setTimeout(closeSettings, 900)
  } catch (e) {
    setSettingsMsg('保存に失敗しました: ' + e.message, 'error')
  } finally {
    $('settings-save').disabled = false
  }
}

$('settings-btn').addEventListener('click', openSettings)
$('settings-close').addEventListener('click', closeSettings)
$('settings-cancel').addEventListener('click', closeSettings)
$('settings-save').addEventListener('click', saveSettings)
$('cfg-hotels').addEventListener('input', syncOwnOptions)
$('settings-overlay').addEventListener('click', e => { if (e.target.id === 'settings-overlay') closeSettings() })
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('history-overlay').classList.contains('hidden')) $('history-overlay').classList.add('hidden')
    else if (!$('settings-overlay').classList.contains('hidden')) closeSettings()
  }
})

// ---------- 時計 ----------

setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('ja-JP')
}, 1000)

// ---------- 初期化 ----------

buildChips()
renderNotifyBtn()
$('threshold').value = String(state.filters.threshold)
$('show-own').checked = state.filters.showOwn
buildSummary()
connect()
