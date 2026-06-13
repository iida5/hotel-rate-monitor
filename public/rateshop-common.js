// 競合レート監視 - 画面共通ヘルパー
//
// 複数ページ (イベント比較ボード等) で共有する整形ユーティリティと種別定義。
// 既存の rateshop.js / timeline.js は各自に同等の定義を持つため読み込まない
// (二重宣言を避けるため)。このファイルを読むページは下記を再宣言しないこと。

'use strict'

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

// 比較ボードのセル内チップ用の短縮ラベル
const TYPE_LABELS_SHORT = {
  price_up: '値上げ',
  price_down: '値下げ',
  soldout: '売止',
  restock: '再開',
  stock_up: '在庫増',
  stock_down: '在庫減',
  sale_start: 'セール',
  sale_end: 'セール終',
  point_up: 'P UP',
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

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const DOW = ['日', '月', '火', '水', '木', '金', '土']

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay()
  return `${m}/${d}(${DOW[dow]})`
}

// 時刻表示: 今日以外は日付も付ける
function fmtTime(t) {
  const d = new Date(t)
  const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm.slice(0, 5)}`
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

// アラート1件の詳細テキスト (timeline.js の eventDetail と同等)
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

// セール/ポイントなど部屋タイプを持たないスコープ単位のイベントか
const isScopeEvent = a => a.type === 'sale_start' || a.type === 'sale_end' || a.type === 'point_up'
