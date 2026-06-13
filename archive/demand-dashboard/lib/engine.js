// 需要シミュレーションエンジン
//
// 2秒ごとの tick で 47都道府県それぞれの「需要指数 (0〜100)」を更新する。
// 需要指数は以下の要素の合成:
//   - 基礎ポテンシャル (都市の観光・ビジネス需要の強さ)
//   - 季節係数 (月別、地域特性あり: 沖縄/北海道/京都/雪国)
//   - 曜日係数 (週末は観光地が上昇、平日はビジネス都市が底堅い)
//   - 確率的ショック (平均回帰するランダムウォーク)
//   - 需要イベント (コンサート・国際会議・悪天候キャンセル等の一時的な急変)
//   - 外部実データバイアス (楽天トラベルAPI連携時に注入される)
//
// 需要指数から稼働率・ADR(平均客室単価)・RevPAR・検索ボリュームを導出する。

import { PREFECTURES } from './prefectures.js'
import { MUNICIPALITIES } from './municipalities.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

// 標準正規乱数 (Box-Muller法)
function randn() {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// 月別の季節係数 (1月〜12月)
const SEASON_TABLES = {
  default:  [0.85, 0.90, 1.00, 1.05, 1.10, 0.90, 1.05, 1.20, 0.95, 1.00, 1.05, 1.00],
  okinawa:  [0.88, 0.92, 1.10, 1.02, 1.00, 0.85, 1.15, 1.20, 1.00, 0.95, 0.90, 0.95],
  hokkaido: [1.05, 1.15, 0.90, 0.85, 0.95, 1.00, 1.15, 1.20, 1.00, 0.95, 0.90, 1.05],
  kyoto:    [0.85, 0.90, 1.05, 1.20, 1.00, 0.88, 0.95, 1.00, 0.95, 1.05, 1.20, 1.00],
  snow:     [1.12, 1.15, 1.00, 0.85, 0.90, 0.88, 1.00, 1.15, 0.92, 0.95, 0.95, 1.05],
}

// ビジネス需要が強く平日も埋まる都道府県 (東京・大阪・愛知・福岡)
const BUSINESS_PREFS = new Set([13, 27, 23, 40])

// 需要イベントのテンプレート (boost は需要指数への加算幅の範囲)
const EVENT_TEMPLATES = [
  { label: '大型コンサートの開催が決定',       boost: [12, 25] },
  { label: '国際会議・大型展示会を開催中',     boost: [8, 18] },
  { label: '花火大会・祭りで予約が集中',       boost: [10, 20] },
  { label: 'プロスポーツの試合開催',           boost: [8, 16] },
  { label: 'インバウンド団体予約が急増',       boost: [10, 22] },
  { label: '航空券セールの影響で検索数が急増', boost: [6, 14] },
  { label: 'テレビ番組の特集放映で注目度上昇', boost: [8, 18] },
  { label: '人気アーティストの聖地巡礼ブーム', boost: [6, 15] },
  { label: '悪天候予報でキャンセルが増加',     boost: [-18, -8] },
  { label: '近隣イベント中止の影響で予約減',   boost: [-14, -6] },
]

// ホテル名生成用のブランド名
const HOTEL_BRANDS = [
  'グランドホテル', 'パークホテル', 'ロイヤルホテル', 'ステーションホテル',
  'シティホテル', 'リゾート&スパ', 'ベイホテル', 'プラザホテル', '温泉ホテル 月乃湯',
]

const HISTORY_MAX = 300   // 保持する履歴ポイント数 (2秒間隔で約10分)
const FEED_MAX = 40       // 保持するフィード件数
const ALERT_THRESHOLD = 82

export class Engine {
  constructor({ tickMs = 2000 } = {}) {
    this.tickMs = tickMs
    this.prefs = PREFECTURES.map(p => ({
      ...p,
      shock: 0, demand: 0, occ: 0, adr: 0, revpar: 0, search: 0, trend: 0,
    }))
    this.history = new Map(this.prefs.map(p => [p.id, []]))
    this.national = []
    this.events = []          // 進行中の需要イベント
    this.feed = []            // 画面に流すフィード
    this.externalBias = new Map() // 楽天トラベル等の実データから得た需要指数
    this.externalSource = null
    this.tickCount = 0
    this.eventSeq = 0
    this.hotels = new Map()
    this.generateHotels()

    // 市区町村(主要宿泊エリア)の状態。県の需要から派生して毎tick更新する
    this.munis = new Map(this.prefs.map(p => [
      p.id,
      (MUNICIPALITIES[p.id] ?? []).map(m => ({
        name: m.n, w: m.w, adrF: m.a,
        shock: 0, demand: 0, occ: 0, adr: 0,
      })),
    ]))

    // チャートが最初から見えるよう、過去10分ぶんの履歴をウォームアップ生成
    const now = Date.now()
    for (let i = HISTORY_MAX; i > 0; i--) this.tick(now - i * this.tickMs)
    this.feed = this.feed.slice(0, 8) // ウォームアップ分のフィードは間引く
  }

  generateHotels() {
    for (const p of this.prefs) {
      const brands = [...HOTEL_BRANDS].sort(() => Math.random() - 0.5).slice(0, 6)
      this.hotels.set(p.id, brands.map(brand => ({
        name: `${p.city}${brand}`,
        rooms: Math.round(rand(60, 420)),
        occOffset: randn() * 5,
        adrBase: Math.round(p.adrBase * rand(0.75, 1.35)),
      })))
    }
  }

  spawnEvent(now) {
    // 需要ポテンシャルで重み付けして対象都道府県を選ぶ
    const total = this.prefs.reduce((s, p) => s + p.pop, 0)
    let r = Math.random() * total
    let pref = this.prefs[0]
    for (const p of this.prefs) { r -= p.pop; if (r <= 0) { pref = p; break } }

    // 県内の発生地 (市区町村) もウェイトで重み付けして選ぶ
    const munis = this.munis.get(pref.id) ?? []
    let muniIdx = -1
    if (munis.length) {
      const totalW = munis.reduce((s, m) => s + m.w, 0)
      let rw = Math.random() * totalW
      muniIdx = munis.length - 1
      for (let i = 0; i < munis.length; i++) {
        rw -= munis[i].w
        if (rw <= 0) { muniIdx = i; break }
      }
    }

    const tpl = EVENT_TEMPLATES[Math.floor(Math.random() * EVENT_TEMPLATES.length)]
    const boost = Math.round(rand(tpl.boost[0], tpl.boost[1]))
    const duration = rand(45_000, 150_000)
    const ev = {
      id: ++this.eventSeq,
      prefId: pref.id,
      muniIdx,
      label: tpl.label,
      boost,
      start: now,
      end: now + duration,
    }
    this.events.push(ev)
    this.feed.unshift({
      id: ev.id, t: now, prefId: pref.id, prefName: pref.name,
      muniName: muniIdx >= 0 ? munis[muniIdx].name : null,
      label: tpl.label, boost,
    })
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX
  }

  // イベント効果の立ち上がり/減衰カーブ (0〜1)
  envelope(ev, now) {
    const len = ev.end - ev.start
    const x = (now - ev.start) / len
    if (x < 0 || x > 1) return 0
    if (x < 0.15) return x / 0.15            // ランプアップ
    if (x > 0.75) return (1 - x) / 0.25      // 減衰
    return 1
  }

  tick(ts = Date.now()) {
    this.tickCount++
    const d = new Date(ts)
    const month = d.getMonth()        // 0-11
    const dow = d.getDay()            // 0=日
    const hour = d.getHours()

    if (Math.random() < 0.12) this.spawnEvent(ts)
    this.events = this.events.filter(e => e.end > ts)

    // 夜間に検索が増える時間帯係数
    const hourFactor = 0.75 + 0.5 * Math.exp(-((hour - 21) ** 2) / 18)

    let sumD = 0, sumOcc = 0, sumAdr = 0, sumSearch = 0
    const alerts = []

    for (const p of this.prefs) {
      // 平均回帰ショック
      p.shock += -p.shock * 0.06 + randn() * 0.9
      p.shock = clamp(p.shock, -10, 10)

      const season = SEASON_TABLES[p.season][month]
      let weekday = (dow === 5) ? 1.10 : (dow === 6) ? 1.18 : (dow === 0) ? 0.95 : 1.0
      if (BUSINESS_PREFS.has(p.id) && dow >= 1 && dow <= 4) weekday = 1.06

      const prefEvents = this.events.filter(e => e.prefId === p.id)
      const eventBoost = prefEvents.reduce((s, e) => s + e.boost * this.envelope(e, ts), 0)

      // 都道府県ごとに位相のずれたゆるやかな波で動きを出す
      const wave = 4 * Math.sin(this.tickCount / 45 + p.id)

      let demand = p.pop * 68 * season * weekday + p.shock + eventBoost + wave
      if (this.externalBias.has(p.id)) {
        demand = 0.55 * demand + 0.45 * this.externalBias.get(p.id)
      }
      p.demand = clamp(demand, 3, 100)

      p.occ = clamp(p.demand * 0.68 + 26 + randn() * 0.7, 25, 99)
      p.adr = Math.round(p.adrBase * (0.78 + 0.5 * p.demand / 100))
      p.revpar = Math.round(p.adr * p.occ / 100)
      p.search = Math.round(p.pop * 900 * (0.4 + p.demand / 100) * hourFactor * rand(0.92, 1.08))

      // 市区町村: 県の需要をウェイトで按分し、固有のショックと
      // 発生地イベントの追加ブーストを乗せる
      for (let i = 0, munis = this.munis.get(p.id); i < munis.length; i++) {
        const m = munis[i]
        m.shock += -m.shock * 0.08 + randn() * 1.2
        m.shock = clamp(m.shock, -12, 12)
        const muniEvent = prefEvents
          .filter(e => e.muniIdx === i)
          .reduce((s, e) => s + e.boost * this.envelope(e, ts) * 0.7, 0)
        const muniWave = 3 * Math.sin(this.tickCount / 40 + i * 2.1 + p.id)
        m.demand = clamp(p.demand * (0.55 + 0.55 * m.w) + m.shock + muniWave + muniEvent, 2, 100)
        m.occ = clamp(m.demand * 0.68 + 26 + randn() * 0.5, 22, 99)
        m.adr = Math.round(p.adrBase * m.adrF * (0.78 + 0.5 * m.demand / 100))
      }

      const hist = this.history.get(p.id)
      hist.push({ t: ts, d: round1(p.demand) })
      if (hist.length > HISTORY_MAX) hist.shift()
      const past = hist[Math.max(0, hist.length - 31)]
      p.trend = round1(p.demand - past.d)

      sumD += p.demand; sumOcc += p.occ; sumAdr += p.adr; sumSearch += p.search
      if (p.demand >= ALERT_THRESHOLD) alerts.push(p.id)
    }

    const n = this.prefs.length
    this.kpi = {
      demand: round1(sumD / n),
      occ: round1(sumOcc / n),
      adr: Math.round(sumAdr / n),
      search: sumSearch,
      alerts,
    }
    this.national.push({ t: ts, d: this.kpi.demand, occ: this.kpi.occ })
    if (this.national.length > HISTORY_MAX) this.national.shift()
  }

  // SSE / スナップショットで配信するペイロード
  streamPayload() {
    return {
      t: Date.now(),
      source: this.externalSource ? `${this.externalSource} + シミュレーション` : 'シミュレーション',
      kpi: this.kpi,
      prefs: this.prefs.map(p => ({
        id: p.id,
        d: round1(p.demand),
        occ: round1(p.occ),
        adr: p.adr,
        rev: p.revpar,
        s: p.search,
        tr: p.trend,
      })),
      feed: this.feed.slice(0, 25),
    }
  }

  meta() {
    return PREFECTURES.map(({ id, name, region, city, gx, gy, adrBase }) =>
      ({ id, name, region, city, gx, gy, adrBase }))
  }

  historyFor(prefId) {
    return {
      pref: this.history.get(prefId) ?? [],
      national: this.national,
    }
  }

  municipalitiesFor(prefId) {
    return (this.munis.get(prefId) ?? [])
      .map(m => ({ name: m.name, d: round1(m.demand), occ: round1(m.occ), adr: m.adr }))
      .sort((a, b) => b.d - a.d)
  }

  hotelsFor(prefId) {
    const pref = this.prefs.find(p => p.id === prefId)
    const list = this.hotels.get(prefId)
    if (!pref || !list) return []
    return list.map(h => ({
      name: h.name,
      rooms: h.rooms,
      occ: round1(clamp(pref.occ + h.occOffset + randn() * 2, 20, 100)),
      adr: Math.round(h.adrBase * (0.8 + 0.4 * pref.demand / 100)),
    })).sort((a, b) => b.occ - a.occ)
  }
}

function round1(v) { return Math.round(v * 10) / 10 }
