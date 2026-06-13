// 競合レート監視モジュール (レートショッパー)
//
// 競合ホテル群 × 日付グリッド (リードタイム) の「プラン別価格」と「残室数」を
// 定点観測し、前回観測値との差分から以下のアラートを生成する:
//   price_up / price_down  価格改定 (値上げ / 値下げ)
//   soldout                売止・満室 (販売中プランが消えた / 残室0になった)
//   restock                販売再開・在庫復活
//   stock_up / stock_down  残室数の増減
//
// データソースは2種類:
//   SimulatedRateSource  デモ用。新宿エリアの架空競合8軒を確率的に変動させる
//   RakutenRateSource    楽天トラベルAPI (VacantHotelSearch) で実データを観測。
//                        公式APIは残室数を返さないため、在庫系は
//                        「プラン消滅=売止」「再出現=販売再開」の検知になる
//
// アラートは data/rateshop-alerts.{sim|rakuten}.ndjson に追記され、
// RATESHOP_WEBHOOK が設定されていれば Slack 互換 Webhook へ POST される。

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

const ALERT_MAX = 400 // メモリに保持するアラート件数 (全量はNDJSONに残る)

// 観測状態ファイルの形式バージョン。セルのキー形式を変えたら上げる
// (旧形式の状態と差分を取ると誤報が噴き出すため、不一致時はベースラインから再登録)
// v3: 実データソースのキーが「ホテル|日付|人数|部屋タイプ」の4部形式になった
const STATE_VERSION = 3

// 観測履歴 (時系列) のアンカー間隔: 変動が無くてもこの間隔で1点は記録する
const OBS_ANCHOR_MS = 30 * 60_000

export const ALERT_LABELS = {
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

// 残室数の表記: プローブ推定値は「約」を付けて実値 (バッジ) と区別する
export function formatStock(stock, plus, src) {
  if (stock == null) return ''
  return `${src === 'probe' ? '約' : ''}${stock}${plus ? '+' : ''}室`
}

export function formatAlertText(a) {
  const head = `【${ALERT_LABELS[a.type]}】${a.hotel} ${a.date}泊` +
    (a.adults ? ` ${a.adults}名` : '') + `「${a.plan}」`
  switch (a.type) {
    case 'price_up':
    case 'price_down':
      return `${head} ¥${a.oldPrice.toLocaleString()} → ¥${a.price.toLocaleString()} (${a.pct > 0 ? '+' : ''}${a.pct}%)` +
        (a.ownPrice != null ? `｜自社最安 ¥${a.ownPrice.toLocaleString()}` : '') +
        (a.planName ? `｜${a.planName}` : '')
    case 'soldout':
      return `${head} 販売停止を検知 (直前価格 ¥${a.price?.toLocaleString() ?? '-'})`
    case 'restock':
      return `${head} 販売再開 ¥${a.price?.toLocaleString() ?? '-'}${a.stock != null ? ` / 残${formatStock(a.stock, a.stockPlus, a.stockSrc)}` : ''}`
    case 'stock_up':
    case 'stock_down':
      return `${head} 残室 ${formatStock(a.oldStock, a.oldStockPlus, a.stockSrc)} → ${formatStock(a.stock, a.stockPlus, a.stockSrc)}`
    case 'sale_start':
    case 'sale_end':
      return head // head の「ラベル名」で内容は伝わる
    case 'point_up':
      return `${head} ポイント${a.oldPoints != null ? `${a.oldPoints}倍 → ` : ''}${a.points}倍`
    default:
      return head
  }
}

// ローカルタイムの YYYY-MM-DD (toISOStringはUTCで日付がずれるため使わない)
function dateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export class RateShopMonitor {
  constructor({ dateOffsets = [1, 3, 7, 14, 30], dataDir = null, webhook = null, webhookFilter = null, log = (...a) => console.log(...a) } = {}) {
    this.dateOffsets = [...dateOffsets].sort((a, b) => a - b)
    this.dataDir = dataDir
    this.webhook = webhook
    // Webhook のサーバー側フィルタ: 在庫±1室のような細かい通知で
    // 通知先が埋まらないよう、既定では価格・売止・再開のみ送る
    this.webhookFilter = { types: ['price_up', 'price_down', 'soldout', 'restock'], minPct: 0, ...(webhookFilter ?? {}) }
    this.log = log
    this.hotels = []        // [{id, name, own}]
    this.cells = new Map()  // "hotelId|date|[人数|]planKey" -> {plan, price, stock, stockSrc, avail, adults}
    this.meta = new Map()   // "hotelId|date|[人数]" -> {sale:[ラベル], points, t} セール/ポイントのホテル×日付状態
    this.alerts = []        // 新しい順
    this.alertSeq = 0
    this.mode = '---'
    this.modeKey = 'sim'
    this.adultsList = null   // 実データソースが設定する人数プロファイル (例 [1,2])
    this.lastObserved = null // 直近の観測対象 (楽天巡回の進捗表示用)
    this.onEmit = null       // サーバーがSSE配信用に差し替えるコールバック
    this._obsLogged = new Map() // 観測履歴の重複抑制: scopeKey -> {hash, t}
  }

  dates() {
    return this.dateOffsets.map(o => dateStr(o))
  }

  // 監視するチェックイン日オフセットを差し替える (昇順を保つ)
  setDateOffsets(offsets) {
    this.dateOffsets = [...offsets].sort((a, b) => a - b)
  }

  // 設定変更による再起動時に観測のベースラインをまっさらにする
  // (監視施設・日付が変わった直後の差分で誤アラートを出さないため)
  resetObservations() {
    this.cells.clear()
    this.meta.clear()
    this.lastObserved = null
  }

  // 観測結果をスコープ単位で取り込み、前回値との差分からアラートを生成する。
  // observed: Map(key -> cell)。scopePrefixes に一致する既存セルのうち
  // observed に含まれないものは「売止」とみなす。
  // initial: ベースライン登録のみ行いアラートを出さない
  // quiet:   アラートは記録するが永続化・Webhook・SSE配信を行わない (ウォームアップ用)
  applyScope(scopePrefixes, observed, ts, { initial = false, quiet = false, meta = null } = {}) {
    // 日付が変わって監視対象外になった日付のセルは黙って捨てる
    const validDates = new Set(this.dates())
    for (const key of [...this.cells.keys()]) {
      if (!validDates.has(key.split('|')[1])) this.cells.delete(key)
    }

    // 「初観測のホテル×日付×人数」は差分ではなくベースライン登録として扱う
    // (日付グリッドの繰り上がりや新規ホテル・人数プロファイル追加で誤報を出さないため)。
    // ペアのキーは末尾の部屋タイプ部分を除いた部分 (人数があれば人数まで含む)
    const pairOf = key => key.split('|').slice(0, -1).join('|')
    const knownPairs = new Set()
    for (const key of this.cells.keys()) {
      knownPairs.add(pairOf(key))
    }

    const fresh = []
    for (const [key, cell] of observed) {
      const prev = this.cells.get(key)
      this.cells.set(key, { ...cell, t: ts }) // t = 最終観測時刻 (鮮度表示用)
      if (initial) continue
      const meta = { adults: cell.adults ?? null } // 人数プロファイル (実データソースのみ)
      if (!prev) {
        // 販売中のセルとして初登場した場合のみ「販売再開」(満室マーカー等の非販売セルは対象外)
        if (cell.avail && knownPairs.has(pairOf(key))) {
          fresh.push(this.alert('restock', ts, key, cell.plan, { ...meta, price: cell.price, stock: cell.stock, stockPlus: !!cell.stockPlus, stockSrc: cell.stockSrc ?? null, planName: cell.planName }))
        }
        continue
      }
      if (!prev.avail && cell.avail) {
        fresh.push(this.alert('restock', ts, key, cell.plan, { ...meta, price: cell.price, stock: cell.stock, stockPlus: !!cell.stockPlus, stockSrc: cell.stockSrc ?? null, planName: cell.planName }))
        continue
      }
      if (prev.avail && !cell.avail) {
        fresh.push(this.alert('soldout', ts, key, cell.plan, { ...meta, price: prev.price }))
        continue
      }
      if (!cell.avail) continue
      if (cell.price !== prev.price) {
        const pct = Math.round(((cell.price - prev.price) / prev.price) * 1000) / 10
        const extra = { ...meta, oldPrice: prev.price, price: cell.price, pct, planName: cell.planName }
        // 競合の価格変動には自社の同日付・同人数の最安値を併記する
        // (通知だけで「追随するか流すか」を判断できるように)
        const [hid, date] = key.split('|')
        const ownId = this.hotels.find(h => h.own)?.id
        if (ownId && ownId !== hid) {
          const op = this.ownMinPrice(date, cell.adults ?? null)
          if (op != null) extra.ownPrice = op
        }
        fresh.push(this.alert(cell.price > prev.price ? 'price_up' : 'price_down', ts, key, cell.plan, extra))
      }
      if (cell.stock != null && prev.stock != null && cell.stock !== prev.stock) {
        fresh.push(this.alert(cell.stock > prev.stock ? 'stock_up' : 'stock_down', ts, key, cell.plan, {
          ...meta, oldStock: prev.stock, oldStockPlus: !!prev.stockPlus,
          stock: cell.stock, stockPlus: !!cell.stockPlus, stockSrc: cell.stockSrc ?? null,
          price: cell.price,
        }))
      }
    }

    // スコープ内で前回は販売中だったのに今回観測されなかったプラン → 売止
    for (const [key, prev] of this.cells) {
      if (observed.has(key)) continue
      if (!scopePrefixes.some(pfx => key.startsWith(pfx))) continue
      if (!prev.avail) continue
      prev.avail = false
      if (!initial) fresh.push(this.alert('soldout', ts, key, prev.plan, { adults: prev.adults ?? null, price: prev.price }))
    }

    // セール/ポイントのメタ差分 (ホテル×日付×人数単位)。観測した部屋タイプ横断の状態を比較する
    if (meta) fresh.push(...this.diffMeta(scopePrefixes, meta, ts, initial))

    if (!quiet && fresh.length) {
      void this.persistAlerts(fresh)
      void this.pushWebhook(fresh.filter(a => !a.own && this.passesWebhookFilter(a))) // 自社の変動は外部通知しない
    }
    if (!quiet) {
      void this.persistObservations(observed, ts) // 時系列分析用の観測履歴
      this.onEmit?.(this.payload(fresh))
    }
    return fresh
  }

  // セール/ポイントのメタ状態を前回と比較し、開始/終了/ポイントUPのアラートを生成する。
  // next = { sale: [ラベル...], points: 倍率|null }。初観測 (prev無し) や initial はベースライン登録のみ。
  diffMeta(scopePrefixes, next, ts, initial) {
    const out = []
    const sale = [...new Set(next.sale ?? [])].sort()
    const points = next.points ?? null
    for (const pfx of scopePrefixes) {
      const scopeKey = pfx.replace(/\|+$/, '') // "hotel|date|人数"
      const prev = this.meta.get(scopeKey)
      this.meta.set(scopeKey, { sale, points, t: ts })
      if (initial || !prev) continue // ベースライン登録のみ
      const adults = (() => { const p = scopeKey.split('|'); return p[2] ? Number(p[2]) : null })()
      const prevSale = new Set(prev.sale ?? [])
      const nextSale = new Set(sale)
      for (const label of sale) if (!prevSale.has(label)) out.push(this.alert('sale_start', ts, scopeKey, label, { adults, label }))
      for (const label of (prev.sale ?? [])) if (!nextSale.has(label)) out.push(this.alert('sale_end', ts, scopeKey, label, { adults, label }))
      // ポイント倍率は上昇のみ通知 (下降は値下げ的にネガティブではないため出さない)
      if (points != null && prev.points != null && points > prev.points) {
        out.push(this.alert('point_up', ts, scopeKey, `ポイント${points}倍`, { adults, oldPoints: prev.points, points }))
      }
    }
    return out
  }

  // 自社ホテルの「指定日付×人数」の部屋タイプ別最安値 (販売中のみ)。無ければ null
  ownMinPrice(date, adults = null) {
    const ownId = this.hotels.find(h => h.own)?.id
    if (!ownId) return null
    let min = null
    for (const [key, c] of this.cells) {
      if (!key.startsWith(`${ownId}|${date}|`)) continue
      if (!c.avail || c.price == null) continue
      if (adults != null && c.adults != null && c.adults !== adults) continue
      if (min == null || c.price < min) min = c.price
    }
    return min
  }

  passesWebhookFilter(a) {
    const f = this.webhookFilter
    if (!f.types.includes(a.type)) return false
    if ((a.type === 'price_up' || a.type === 'price_down') && Math.abs(a.pct) < f.minPct) return false
    return true
  }

  alert(type, t, key, plan, extra = {}) {
    const [hotelId, date] = key.split('|')
    const hotel = this.hotels.find(h => h.id === hotelId)
    const a = {
      id: ++this.alertSeq, t, type, key, hotelId, date, plan,
      hotel: hotel?.name ?? hotelId, own: !!hotel?.own,
      ...extra,
    }
    this.alerts.unshift(a)
    if (this.alerts.length > ALERT_MAX) this.alerts.length = ALERT_MAX
    return a
  }

  payload(newAlerts = []) {
    const grid = []
    for (const [key, c] of this.cells) {
      const [h, d] = key.split('|')
      grid.push({
        key, h, d, plan: c.plan, planName: c.planName, price: c.price, discPrice: c.discPrice ?? null,
        stock: c.stock, stockPlus: !!c.stockPlus, stockSrc: c.stockSrc ?? null,
        adults: c.adults ?? null, avail: c.avail, t: c.t ?? null,
      })
    }
    const meta = []
    for (const [key, m] of this.meta) {
      const sale = m.sale ?? []
      const points = (m.points != null && m.points >= 2) ? m.points : null // 1倍 (通常) はバッジに出さない
      if (sale.length || points != null) meta.push({ key, sale, points })
    }
    return {
      t: Date.now(),
      mode: this.mode,
      hotels: this.hotels,
      dates: this.dates(),
      adultsList: this.adultsList,
      lastObserved: this.lastObserved,
      grid,
      meta,
      kpi: this.kpi(),
      alerts: newAlerts,
    }
  }

  kpi() {
    const now = Date.now()
    let priceChanges1h = 0, alerts24h = 0
    for (const a of this.alerts) { // alerts は新しい順なので途中でbreakできる
      if (a.t < now - 86_400_000) break
      alerts24h++
      if (a.t >= now - 3_600_000 && !a.own && (a.type === 'price_up' || a.type === 'price_down')) priceChanges1h++
    }

    // 「競合最安」は監視日付のうち最も近い日×主プロファイル (先頭の人数) で比較する
    let soldout = 0
    let best = null, ownBest = null
    const bestDate = this.dates()[0]
    const primaryAdults = this.adultsList?.[0] ?? null
    const ownIds = new Set(this.hotels.filter(h => h.own).map(h => h.id))
    for (const [key, c] of this.cells) {
      if (!c.avail) { soldout++; continue }
      const [h, d] = key.split('|')
      if (d !== bestDate) continue
      if (primaryAdults != null && c.adults != null && c.adults !== primaryAdults) continue
      if (ownIds.has(h)) {
        if (!ownBest || c.price < ownBest.price) ownBest = { price: c.price }
      } else if (!best || c.price < best.price) {
        best = { price: c.price, hotel: this.hotels.find(x => x.id === h)?.name ?? h }
      }
    }
    return { priceChanges1h, alerts24h, soldout, cells: this.cells.size, best, ownBest, bestDate, bestAdults: primaryAdults }
  }

  async persistAlerts(alerts) {
    if (!this.dataDir) return
    try {
      await mkdir(this.dataDir, { recursive: true })
      const file = path.join(this.dataDir, `rateshop-alerts.${this.modeKey}.ndjson`)
      await appendFile(file, alerts.map(a => JSON.stringify(a)).join('\n') + '\n')
    } catch (e) {
      this.log(`[rateshop] アラート履歴の保存に失敗: ${e.message}`)
    }
  }

  // ---- 観測履歴 (時系列) ----
  //
  // 観測のたびに「ホテル×日付×人数」単位のスナップショット行を
  // data/rateshop-observations.{ソース}.ndjson に追記する。
  // 内容が前回記録と同じ場合は OBS_ANCHOR_MS ごとのアンカー1点に間引く
  // (推移チャートとExcel等での時系列分析の元データ)。

  obsFile() {
    return this.dataDir ? path.join(this.dataDir, `rateshop-observations.${this.modeKey}.ndjson`) : null
  }

  async persistObservations(observed, ts) {
    if (!this.obsFile()) return
    // ホテル|日付|人数 単位にまとめる
    const groups = new Map()
    for (const [key, cell] of observed) {
      const [hotelId, date] = key.split('|')
      const gk = `${hotelId}|${date}|${cell.adults ?? ''}`
      if (!groups.has(gk)) groups.set(gk, [])
      groups.get(gk).push({
        rc: key.split('|').pop(), plan: cell.plan, price: cell.price, discPrice: cell.discPrice ?? null,
        stock: cell.stock ?? null, stockPlus: !!cell.stockPlus, stockSrc: cell.stockSrc ?? null,
        avail: !!cell.avail,
      })
    }
    const lines = []
    for (const [gk, rooms] of groups) {
      rooms.sort((a, b) => String(a.rc).localeCompare(String(b.rc)))
      const hash = JSON.stringify(rooms)
      const last = this._obsLogged.get(gk)
      if (last && last.hash === hash && ts - last.t < OBS_ANCHOR_MS) continue
      this._obsLogged.set(gk, { hash, t: ts })
      const [hotelId, date, adults] = gk.split('|')
      lines.push(JSON.stringify({ t: ts, hotelId, date, adults: adults ? Number(adults) : null, rooms }))
    }
    if (!lines.length) return
    try {
      await mkdir(this.dataDir, { recursive: true })
      await appendFile(this.obsFile(), lines.join('\n') + '\n')
    } catch (e) {
      this.log(`[rateshop] 観測履歴の保存に失敗: ${e.message}`)
    }
  }

  // 推移チャート用にホテル×日付の観測履歴を読み出す (新しい順に最大 limit 件)
  async readHistory({ hotelId, date, adults = null, limit = 500 }) {
    if (!this.obsFile()) return []
    let text
    try {
      text = await readFile(this.obsFile(), 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (rec.hotelId !== hotelId || rec.date !== date) continue
        if (adults != null && rec.adults != null && rec.adults !== adults) continue
        out.push(rec)
      } catch { /* 壊れた行は読み飛ばす */ }
    }
    return out.slice(-limit)
  }

  // ホテル別イベントタイムライン用に、アラート履歴ファイルを読み出す。
  // メモリ上の this.alerts は ALERT_MAX 件で打ち切られるため、振り返りでは
  // NDJSON 全量 (古い順に追記) を直接読み、フィルタして新しい順で返す。
  //   hotelId  施設番号で絞る (未指定なら全施設)
  //   from/to  観測時刻 t (ミリ秒) の範囲
  //   adults   宿泊人数で絞る (イベントに adults が無い行は通す)
  async readTimeline({ hotelId = null, from = null, to = null, adults = null, limit = 3000 } = {}) {
    const file = this.dataDir
      ? path.join(this.dataDir, `rateshop-alerts.${this.modeKey}.ndjson`)
      : null
    if (!file) return []
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const a = JSON.parse(line)
        if (hotelId && a.hotelId !== hotelId) continue
        if (from != null && a.t < from) continue
        if (to != null && a.t > to) continue
        if (adults != null && a.adults != null && a.adults !== adults) continue
        out.push(a)
      } catch { /* 壊れた行は読み飛ばす */ }
    }
    // ファイルは古い順。新しい順で返し、上限は新しい側を優先して残す
    out.reverse()
    return out.slice(0, limit)
  }

  async pushWebhook(alerts) {
    if (!this.webhook || !alerts.length) return
    const lines = alerts.slice(0, 10).map(formatAlertText)
    if (alerts.length > 10) lines.push(`…ほか ${alerts.length - 10} 件`)
    try {
      const res = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lines.join('\n') }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      this.log(`[rateshop] Webhook送信に失敗: ${e.message}`)
    }
  }

  // ---- 観測状態の永続化 (実データモードで再起動時の誤報を防ぐ) ----

  stateFile() {
    // ソース別に分離 (キー形式が異なるため混在させると誤報が出る)
    return this.dataDir ? path.join(this.dataDir, `rateshop-state.${this.modeKey}.json`) : null
  }

  async saveState() {
    if (!this.stateFile()) return
    try {
      await mkdir(this.dataDir, { recursive: true })
      await writeFile(this.stateFile(), JSON.stringify({ savedAt: Date.now(), version: STATE_VERSION, cells: [...this.cells.entries()] }))
    } catch (e) {
      this.log(`[rateshop] 観測状態の保存に失敗: ${e.message}`)
    }
  }

  async loadState(maxAgeMs = 48 * 3_600_000) {
    if (!this.stateFile()) return false
    try {
      const data = JSON.parse(await readFile(this.stateFile(), 'utf8'))
      if (data?.version !== STATE_VERSION) return false
      if (!Array.isArray(data?.cells) || Date.now() - data.savedAt > maxAgeMs) return false
      this.cells = new Map(data.cells)
      return true
    } catch {
      return false
    }
  }

  // 再起動時に NDJSON のアラート履歴を読み戻し、画面のアラート一覧/KPIを復元する。
  // 直近 maxAgeMs (既定24時間) のものを新しい順に最大 ALERT_MAX 件まで取り込む。
  async loadAlerts(maxAgeMs = 24 * 3_600_000) {
    if (!this.dataDir) return 0
    const file = path.join(this.dataDir, `rateshop-alerts.${this.modeKey}.ndjson`)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return 0 // 履歴ファイルがまだ無い
    }
    const cutoff = Date.now() - maxAgeMs
    const recent = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const a = JSON.parse(line)
        if (typeof a.t === 'number' && a.t >= cutoff) recent.push(a)
      } catch { /* 壊れた行は読み飛ばす */ }
    }
    recent.reverse() // ファイルは古い順 → 画面は新しい順
    this.alerts = recent.slice(0, ALERT_MAX)
    // 続きのアラートIDが重複しないよう採番カウンタを最大値に合わせる
    this.alertSeq = this.alerts.reduce((mx, a) => Math.max(mx, a.id || 0), 0)
    return this.alerts.length
  }
}

// ---------- シミュレーションソース (デモ用) ----------

const SIM_HOTELS = [
  { id: 'h0', name: '(自社) シティホテル新宿', own: true, base: 17800 },
  { id: 'h1', name: '新宿グランドホテル', own: false, base: 21500 },
  { id: 'h2', name: 'パークホテル西新宿', own: false, base: 19800 },
  { id: 'h3', name: '新宿ロイヤルホテル', own: false, base: 24200 },
  { id: 'h4', name: 'プラザホテル歌舞伎町', own: false, base: 15400 },
  { id: 'h5', name: 'ステーションホテル新宿', own: false, base: 16900 },
  { id: 'h6', name: 'ホテルグレイス新宿御苑', own: false, base: 18600 },
  { id: 'h7', name: '新宿アーバンホテル', own: false, base: 13800 },
]

const SIM_PLANS = [
  { key: 'std', name: 'スタンダードダブル 素泊まり', f: 1.00 },
  { key: 'stdb', name: 'スタンダードダブル 朝食付', f: 1.18 },
  { key: 'twn', name: 'ツイン 素泊まり', f: 1.28 },
  { key: 'dlx', name: 'デラックスツイン 朝食付', f: 1.62 },
]

export class SimulatedRateSource {
  constructor(monitor, { tickMs = 5000 } = {}) {
    this.monitor = monitor
    this.tickMs = tickMs
    this.state = new Map() // key -> {plan, price, stock} (シミュレーションの真値)
    this.timer = null
  }

  start() {
    const m = this.monitor
    m.mode = 'シミュレーション (新宿エリア・架空データ)'
    m.modeKey = 'sim'
    m.adultsList = null // シミュレーションは人数プロファイルなし
    m.hotels = SIM_HOTELS.map(({ id, name, own }) => ({ id, name, own }))

    // 過去30tick分の変動を先に生成して、起動直後からアラート履歴が見えるようにする
    const now = Date.now()
    this.ensureCells()
    this.observe(now - 30 * this.tickMs, { initial: true, quiet: true })
    for (let i = 29; i >= 1; i--) {
      this.mutate()
      this.observe(now - i * this.tickMs, { quiet: true })
    }
    this.timer = setInterval(() => { this.mutate(); this.observe(Date.now()) }, this.tickMs)
    m.log(`[rateshop] シミュレーションモードで監視開始: ${SIM_HOTELS.length}軒 × ${m.dateOffsets.length}日付 × ${SIM_PLANS.length}プラン`)
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  ensureCells() {
    const dates = this.monitor.dates()
    const valid = new Set(dates)
    for (const key of [...this.state.keys()]) {
      if (!valid.has(key.split('|')[1])) this.state.delete(key)
    }
    this.monitor.dateOffsets.forEach((offset, di) => {
      const date = dates[di]
      const dow = new Date(date + 'T12:00:00').getDay()
      const weekend = (dow === 5 || dow === 6) ? 1.18 : 1.0
      const lead = 1.12 - Math.min(30, offset) * 0.005 // 直近日ほど強気の価格
      for (const h of SIM_HOTELS) {
        for (const plan of SIM_PLANS) {
          const key = `${h.id}|${date}|${plan.key}`
          if (this.state.has(key)) continue
          const price = Math.round(h.base * plan.f * lead * weekend * rand(0.97, 1.03) / 100) * 100
          const stock = Math.random() < 0.07 ? 0 : Math.round(rand(1, 14))
          this.state.set(key, { plan: plan.name, price, stock })
        }
      }
    })
  }

  mutate() {
    this.ensureCells()
    const now = Date.now()
    for (const [key, c] of this.state) {
      const own = key.startsWith('h0|')
      // 直近日ほど予約・価格改定が活発になる重み
      const daysOut = Math.max(1, Math.round((new Date(key.split('|')[1] + 'T15:00:00') - now) / 86_400_000))
      const w = daysOut <= 3 ? 1.6 : daysOut <= 7 ? 1.2 : daysOut <= 14 ? 0.9 : 0.6
      const r = Math.random()
      if (r < 0.004 * w) { // 予約が入って残室が減る
        if (c.stock > 0) c.stock = Math.max(0, c.stock - (Math.random() < 0.25 ? 2 : 1))
      } else if (r < 0.006 * w) { // キャンセル・在庫開放で残室が戻る
        c.stock = Math.min(15, c.stock + (Math.random() < 0.3 ? 2 : 1))
      } else if (r < (own ? 0.0066 : 0.009) * w) { // レベニュー担当の価格改定 (自社はまれ)
        const dir = Math.random() < 0.55 ? 1 : -1
        c.price = Math.max(6000, Math.round(c.price * (1 + dir * rand(0.02, 0.10)) / 100) * 100)
      }
    }
  }

  observe(ts, opts = {}) {
    const observed = new Map()
    for (const [key, c] of this.state) {
      observed.set(key, { plan: c.plan, price: c.price, stock: c.stock, stockSrc: 'badge', avail: c.stock > 0 })
    }
    this.monitor.applyScope([''], observed, ts, opts)
  }
}

// ---------- 楽天トラベルAPIソース (実データ) ----------
//
// RAKUTEN_APP_ID・RAKUTEN_ACCESS_KEY・RATESHOP_HOTELS (施設番号のカンマ区切り) が
// 設定されたときに使う。2026年2月のAPI刷新後の仕様 (openapi.rakuten.co.jp +
// accessKey 必須) に対応。403 が出る場合はアプリ登録した「許可されたWebサイト」を
// RAKUTEN_ORIGIN で指定する。
// レート制限 (1リクエスト/秒) を守り、ホテル×日付を1件ずつ巡回する。
//
// 監視単位は「部屋タイプ (roomClass) 別の最安値」:
//   既定の施設ごと検索はホテル全体の代表プラン1件しか返さないため、
//   searchPattern=1 (宿泊プランごと検索) を安い順で最大2ページ (60プラン) 取得し、
//   部屋タイプごとに最安プランへ集約する。プランの入れ替わり (SALE終了等) は
//   部屋タイプ最安値の価格変動として検知され、プラン単位の売止/再開ノイズを避ける。
//   アラートには「そのとき最安だったプラン名」を併記する。
//
// 残室数の推定 (在庫プローブ):
//   公式APIは残室数を返さないため、roomNum (部屋数) を 1→2→… と増やしながら
//   照会し、各部屋タイプが「一度に何室まで予約可能か」を残室数の推定値とする。
//   stockProbe 段 (既定5、最大10) まで調べ、上限に達したものは「5+」と表示。
//   1予約あたりの販売上限がある場合は実在庫より少なく出ることがある。
//
// リクエスト数: 1ホテル×1日付あたり最大 (プローブ段数 + 1) 回。
// 例: 5軒 × 5日付 × (5+1) × 約1.1秒 ≒ 1巡 最大約2.8分

const RAKUTEN_API = 'https://openapi.rakuten.co.jp/engine/api/Travel'

export class RakutenRateSource {
  constructor(monitor, { appId, accessKey, hotelNos, ownHotelNo = null, adults = [2], origin = null, stockProbe = 5, intervalMs = 1100 }) {
    this.monitor = monitor
    this.appId = appId
    this.accessKey = accessKey
    this.headers = origin ? { Origin: origin, Referer: origin } : {}
    this.hotelNos = hotelNos
    this.ownHotelNo = ownHotelNo == null ? null : String(ownHotelNo)
    this.adultsList = Array.isArray(adults) ? adults : [adults] // 人数プロファイル (例 [1,2])
    this.stockProbe = Math.min(10, Math.max(1, stockProbe)) // 1 = プローブ無効 (売止/再販売のみ検知)
    this.intervalMs = intervalMs
    this.stopped = false
    this.loopPromise = null
  }

  async start({ resume = true } = {}) {
    const m = this.monitor
    this.stopped = false
    m.mode = '楽天トラベルAPI (実データ)'
    m.modeKey = 'rakuten'
    m.adultsList = this.adultsList
    m.hotels = this.hotelNos.map(no => ({ id: String(no), name: `施設 ${no}`, own: String(no) === this.ownHotelNo }))
    if (resume && await m.loadState()) {
      m.log('[rateshop] 前回の観測状態を復元しました (前回値との差分からアラートを再開します)')
    }
    if (resume) {
      const n = await m.loadAlerts()
      if (n) m.log(`[rateshop] アラート履歴を ${n} 件復元しました (直近24時間)`)
    }
    const maxSec = Math.round(m.hotels.length * m.dateOffsets.length * this.adultsList.length * (this.stockProbe + 1) * this.intervalMs / 1000)
    m.log(`[rateshop] 楽天トラベルAPIで監視開始: ${m.hotels.length}軒 × ${m.dateOffsets.length}日付 × ${this.adultsList.join('/')}名 (部屋タイプ別最安値` +
      (this.stockProbe > 1 ? `・在庫プローブ${this.stockProbe}段` : '') + `, 1巡 最大約${maxSec}秒)`)
    this.loopPromise = this.loop()
  }

  async stop() {
    this.stopped = true
    await this.loopPromise?.catch(() => {})
    this.loopPromise = null
  }

  async loop() {
    const m = this.monitor
    const total = m.hotels.length * m.dateOffsets.length * this.adultsList.length
    while (!this.stopped) {
      this.cycle = (this.cycle ?? 0) + 1 // 巡回ごとに進捗バーをリセットさせるための周回番号
      let idx = 0
      for (const hotel of m.hotels) {
        for (const offset of m.dateOffsets) {
          for (const adults of this.adultsList) {
            if (this.stopped) return
            idx++
            try {
              await this.pollOne(hotel, offset, adults, idx, total)
            } catch (e) {
              m.log(`[rateshop] ${hotel.name} +${offset}日 ${adults}名の取得に失敗: ${e.message}`)
            }
            await sleep(this.intervalMs)
          }
        }
      }
      if (!this.stopped) await m.saveState()
    }
  }

  buildUrl(hotel, date, checkout, adults, roomNum, page) {
    // searchPattern=1: 宿泊プランごと検索 (安い順)。sort の "+" は %2B にエンコード必須
    return `${RAKUTEN_API}/VacantHotelSearch/20170426` +
      `?applicationId=${this.appId}&accessKey=${encodeURIComponent(this.accessKey)}&format=json` +
      `&hotelNo=${hotel.id}&checkinDate=${date}&checkoutDate=${checkout}` +
      `&adultNum=${adults}&roomNum=${roomNum}` +
      `&searchPattern=1&hits=30&sort=%2BroomCharge&page=${page}`
  }

  async fetchPage(url) {
    const res = await fetch(url, { headers: this.headers })
    if (res.status === 429) return { rateLimited: true }
    if (res.status === 404) return { data: null } // この条件では予約可能プランなし
    if (!res.ok) {
      let detail = ''
      try {
        const body = await res.json()
        detail = body.error_description ?? body.error ?? ''
      } catch { /* 本文がJSONでない場合は無視 */ }
      if (res.status === 403 && !detail) detail = 'アプリ設定の「許可されたWebサイト」を確認し、RAKUTEN_ORIGIN に登録ドメインを設定してください'
      throw new Error(`HTTP ${res.status}${detail ? ` (${detail})` : ''}`)
    }
    return { data: await res.json() }
  }

  // レスポンスからプラン一覧と施設基本情報を取り出す
  parsePage(data) {
    const plans = []
    let basic = null
    for (const h of data?.hotels ?? []) {
      for (const part of h?.hotel ?? []) {
        if (part.hotelBasicInfo) basic = part.hotelBasicInfo
        if (!Array.isArray(part.roomInfo)) continue
        let info = null, total = 0
        for (const entry of part.roomInfo) {
          if (entry.roomBasicInfo) info = entry.roomBasicInfo
          if (entry.dailyCharge) total += entry.dailyCharge.total ?? entry.dailyCharge.rakutenCharge ?? 0
        }
        if (info && total) plans.push({ info, price: total })
      }
    }
    return { plans, basic }
  }

  async pollOne(hotel, offset, adults, idx, total) {
    const date = dateStr(offset)
    const checkout = dateStr(offset + 1)
    const classes = new Map() // roomClass -> セル (部屋タイプ別の最安値)

    // 1室条件で安い順に最大2ページ (60プラン) 取得し、部屋タイプ別の最安へ集約
    let pageCount = 1
    for (let page = 1; page <= Math.min(2, pageCount); page++) {
      if (page > 1) await sleep(this.intervalMs)
      const { rateLimited, data } = await this.fetchPage(this.buildUrl(hotel, date, checkout, adults, 1, page))
      if (rateLimited) { await sleep(5000); return }
      if (!data) break // 404: 予約可能プランなし = 全部屋タイプ売止
      pageCount = data.pagingInfo?.pageCount ?? 1
      const { plans, basic } = this.parsePage(data)
      if (basic?.hotelName) hotel.name = basic.hotelName
      for (const { info, price } of plans) {
        const rc = String(info.roomClass ?? 'room').replaceAll('|', '/')
        const cur = classes.get(rc)
        if (!cur || price < cur.price) {
          classes.set(rc, {
            plan: String(info.roomName ?? `部屋タイプ ${rc}`).trim(), // 表示名は部屋タイプ名
            planName: String(info.planName ?? ''),                    // そのとき最安のプラン名
            price, stock: 1, stockPlus: false, stockSrc: 'probe', avail: true, adults,
          })
        }
      }
    }

    // roomNum を増やしながら「各部屋タイプが一度に何室予約できるか」を推定
    for (let n = 2; n <= this.stockProbe && classes.size > 0; n++) {
      await sleep(this.intervalMs)
      const { rateLimited, data } = await this.fetchPage(this.buildUrl(hotel, date, checkout, adults, n, 1))
      // レート超過時は中途半端な在庫推定で誤報を出さないよう、この観測ごと破棄
      if (rateLimited) { await sleep(5000); return }
      if (!data) break // n室ではどの部屋タイプも予約不可
      for (const { info } of this.parsePage(data).plans) {
        const rc = String(info.roomClass ?? 'room').replaceAll('|', '/')
        const cell = classes.get(rc)
        if (cell) { cell.stock = n; cell.stockPlus = n === this.stockProbe }
      }
    }

    // プローブ無効時 (1段) は残室数を推定できないので「不明」のままにする
    if (this.stockProbe === 1) {
      for (const cell of classes.values()) { cell.stock = null; cell.stockPlus = false; cell.stockSrc = null }
    }

    const observed = new Map()
    for (const [rc, cell] of classes) observed.set(`${hotel.id}|${date}|${adults}|${rc}`, cell)
    this.monitor.lastObserved = { hotelId: hotel.id, hotel: hotel.name, date, adults, t: Date.now(), idx, total, cycle: this.cycle }
    this.monitor.applyScope([`${hotel.id}|${date}|${adults}|`], observed, Date.now())
  }
}
