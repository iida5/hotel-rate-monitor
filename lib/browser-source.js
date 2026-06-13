// ブラウザ経由の競合レート収集ソース (Playwright)
//
// 楽天トラベルAPIの代替。各競合ホテルのプラン一覧ページを実ブラウザで開き、
// 部屋タイプ別の最安値と残室を読み取って RateShopMonitor に流し込む。
// 差分検知・アラート・グリッド・観測インジケータは API版と共通 (ソース非依存)。
//
// API版との違い:
//   - 1ホテル×1日付の基本観測は「1ページ読み込み」で全プラン×全部屋タイプを取得。
//     並列ワーカーで複数セルを同時取得できる
//   - 残室は2段構え:
//       (1) 楽天サイトの「残りX室/あとX室」バッジがあればその実値
//       (2) バッジが無い部屋タイプは、予約部屋数 (f_heya_su) を 2→3→… と増やした
//           ページを読み「一度に何室予約できるか」を推定 (在庫プローブ、stockProbe段)。
//           上限まで予約できたものは「N室以上 (N+)」
//   - 満室日は部屋行だけ表示され価格が出ない。「部屋行あり・価格なし」を
//     全タイプ満室と判定し、満室マーカー (キー末尾 "*") をグリッドに置く
//
// プラン一覧ページURL (日付は 年/月/日 が別パラメータ):
//   https://hotel.travel.rakuten.co.jp/hotelinfo/plan/{hotelNo}
//     ?f_nen1=YYYY&f_tuki1=MM&f_hi1=DD&f_nen2=...&f_otona_su=2&f_heya_su=1&...
//
// DOM構造 (2026-06 時点。変わったら parsePage 内のセレクタを調整):
//   LI.planThumb            プランカード (h4 = プラン名)
//     UL.htlPlnRmTypLst
//       LI.rm-type-wrapper   部屋タイプ1件 (部屋名 + 価格)
//         .htlPlnRmTypPrcArea  価格エリア (SPAN.ndPrice = 合計N円)

import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const p2 = n => String(n).padStart(2, '0')

export function planUrl(hotelNo, offset, adults, rooms) {
  const ci = new Date(Date.now() + offset * 86_400_000)
  const co = new Date(Date.now() + (offset + 1) * 86_400_000)
  const params = new URLSearchParams({
    f_nen1: ci.getFullYear(), f_tuki1: p2(ci.getMonth() + 1), f_hi1: p2(ci.getDate()),
    f_nen2: co.getFullYear(), f_tuki2: p2(co.getMonth() + 1), f_hi2: p2(co.getDate()),
    f_otona_su: String(adults), f_heya_su: String(rooms),
    f_s1: '0', f_s2: '0', f_y1: '0', f_y2: '0', f_y3: '0', f_y4: '0', f_teikei: '',
  })
  return `https://hotel.travel.rakuten.co.jp/hotelinfo/plan/${hotelNo}?${params}`
}

export class BrowserRateSource {
  constructor(monitor, { hotelNos, ownHotelNo = null, adults = [2], concurrency = 3, stockProbe = 5, navDelayMs = 800, headless = true }) {
    this.monitor = monitor
    this.hotelNos = hotelNos
    this.ownHotelNo = ownHotelNo == null ? null : String(ownHotelNo)
    this.adultsList = Array.isArray(adults) ? adults : [adults] // 人数プロファイル (例 [1,2])
    this.concurrency = Math.min(10, Math.max(1, concurrency))
    this.stockProbe = Math.min(10, Math.max(1, stockProbe)) // 1 = プローブ無効 (バッジ実値のみ)
    this.navDelayMs = navDelayMs
    this.headless = headless
    this.browser = null
    this.stopped = false
    this.loopPromise = null
  }

  // resume: true なら前回の観測状態を読み込み差分を継続。
  //         false (設定変更による再起動時) はベースラインから取り直す。
  async start({ resume = true } = {}) {
    const m = this.monitor
    this.stopped = false
    m.mode = `ブラウザ収集 (楽天トラベル / 並列${this.concurrency}` +
      (this.stockProbe > 1 ? `・在庫プローブ${this.stockProbe}段` : '') + ')'
    m.modeKey = 'browser'
    m.adultsList = this.adultsList
    m.hotels = this.hotelNos.map(no => ({ id: String(no), name: `施設 ${no}`, own: String(no) === this.ownHotelNo }))
    if (resume && await m.loadState()) {
      m.log('[browser] 前回の観測状態を復元しました (前回値との差分からアラートを再開します)')
    }
    if (resume) {
      const n = await m.loadAlerts()
      if (n) m.log(`[browser] アラート履歴を ${n} 件復元しました (直近24時間)`)
    }
    try {
      this.browser = await chromium.launch({ headless: this.headless })
    } catch (e) {
      m.log(`[browser] ブラウザ起動に失敗しました。'npx playwright install chromium' を実行してください: ${e.message}`)
      return
    }
    m.log(`[browser] ブラウザ収集を開始: ${m.hotels.length}軒 × ${m.dateOffsets.length}日付 × ${this.adultsList.join('/')}名 ` +
      `(部屋タイプ別最安値・残室=バッジ実値${this.stockProbe > 1 ? `+プローブ推定${this.stockProbe}段` : ''})`)
    this.loopPromise = this.loop()
  }

  // 監視対象 (ホテル×日付×人数) の全セルを並列ワーカーで巡回し続ける
  async loop() {
    const m = this.monitor
    const jobs = []
    for (const hotel of m.hotels) for (const offset of m.dateOffsets) for (const adults of this.adultsList) jobs.push({ hotel, offset, adults })

    while (!this.stopped) {
      this.cycle = (this.cycle ?? 0) + 1 // 巡回ごとに進捗バーをリセットさせるための周回番号
      let cursor = 0
      const total = jobs.length
      const worker = async () => {
        if (this.stopped) return
        let page
        try {
          page = await this.browser.newPage({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            locale: 'ja-JP', viewport: { width: 1280, height: 2600 },
          })
        } catch { return } // 停止中にブラウザが閉じられた等
        // 画像・フォント・トラッカーを止めて高速化&負荷軽減
        await page.route('**/*', route => {
          const type = route.request().resourceType()
          if (type === 'image' || type === 'font' || type === 'media') return route.abort()
          return route.continue()
        }).catch(() => {})
        try {
          while (!this.stopped) {
            const i = cursor++
            if (i >= jobs.length) break
            const { hotel, offset, adults } = jobs[i]
            try {
              await this.pollOne(page, hotel, offset, adults, i + 1, total)
            } catch (e) {
              if (!this.stopped) m.log(`[browser] ${hotel.name} +${offset}日 ${adults}名の取得に失敗: ${e.message}`)
            }
            await sleep(this.navDelayMs)
          }
        } finally {
          await page.close().catch(() => {})
        }
      }
      await Promise.all(Array.from({ length: this.concurrency }, () => worker())).catch(() => {})
      if (!this.stopped) await m.saveState()
    }
  }

  async pollOne(page, hotel, offset, adults, idx, total) {
    const date = `${new Date(Date.now() + offset * 86_400_000).getFullYear()}-${p2(new Date(Date.now() + offset * 86_400_000).getMonth() + 1)}-${p2(new Date(Date.now() + offset * 86_400_000).getDate())}`
    const parsed = await this.readPage(page, planUrl(hotel.id, offset, adults, 1))
    if (!parsed) { await sleep(3000); return } // 一時エラーはこの巡回をスキップ
    const { hotelName, rows, wraps } = parsed
    if (hotelName) hotel.name = hotelName

    // 満室判定: 「満室」等の文言がある、または部屋行はあるのに価格が1件も無い
    // (楽天は満室日でも部屋行を表示するが価格を出さない)
    const allSoldOut = parsed.sellingClosed || (rows.length === 0 && wraps > 0)

    // 部屋タイプコード (srw/ctw/dbb…。API版の roomClass と同一) でグルーピングし
    // 最安へ集約する。表示名は最短のものを採用 (短い名/長い名の揺れを吸収)。
    // 残室は実値 (残りX室) が取れた行を優先する。
    const classes = new Map() // roomClassCode -> セル
    for (const r of rows) {
      if (!r.price || !r.code) continue
      const cur = classes.get(r.code)
      if (!cur) {
        classes.set(r.code, {
          plan: r.roomName,         // 表示名 = 部屋タイプ名
          planName: r.planName,     // そのとき最安のプラン名
          price: r.price,
          discPrice: r.discPrice,   // そのプランの割引価格 (なければ null)
          stock: r.stock,           // 残室バッジの実値 (なければ null)
          stockPlus: false,
          stockSrc: r.stock != null ? 'badge' : null, // badge=サイト表示の実値 / probe=推定
          avail: true,
          adults,
        })
      } else {
        // 通常価格で最安を選ぶ。割引価格も同じプランのものに合わせて持つ
        if (r.price < cur.price) { cur.price = r.price; cur.discPrice = r.discPrice; cur.planName = r.planName }
        if (r.roomName && r.roomName.length < cur.plan.length) cur.plan = r.roomName
        if (cur.stock == null) { cur.stock = r.stock; cur.stockSrc = r.stock != null ? 'badge' : null }
        else if (r.stock != null) cur.stock = Math.min(cur.stock, r.stock)
      }
    }

    // プランも部屋行も満室表示も無い場合は観測失敗とみなしスキップ
    // (ページ構造変化やタイムアウトを売止と誤検知しないため)
    if (classes.size === 0 && !allSoldOut) {
      this.monitor.log(`[browser] ${hotel.name} ${date}: プランを取得できませんでした (スキップ)`)
      return
    }

    // 在庫プローブ: 残室バッジが無い部屋タイプは、予約部屋数 (f_heya_su) を
    // 2室→3室…と増やしたページを読み、「一度に何室予約できるか」を残室の推定値に
    // する (API版と同じ手法)。バッジがある部屋タイプは実値をそのまま使う。
    const unknown = new Set([...classes.entries()].filter(([, c]) => c.stock == null).map(([k]) => k))
    if (this.stockProbe > 1 && unknown.size > 0) {
      for (const k of unknown) { const c = classes.get(k); c.stock = 1; c.stockPlus = false; c.stockSrc = 'probe' }
      for (let n = 2; n <= this.stockProbe && unknown.size > 0; n++) {
        await sleep(this.navDelayMs)
        const probe = await this.readPage(page, planUrl(hotel.id, offset, adults, n), { quick: true })
        if (!probe) break // 一時エラー: ここまでの推定値で確定 (低めに出るだけで誤報はない)
        const seen = new Set(probe.rows.map(r => r.code))
        let any = false
        for (const k of [...unknown]) {
          if (seen.has(k)) {
            const c = classes.get(k)
            c.stock = n
            c.stockPlus = n === this.stockProbe // 上限まで予約可 = 「n室以上」
            any = true
          } else {
            unknown.delete(k) // n室は予約不可 → 残りは n-1 室で確定
          }
        }
        if (!any) break
      }
    }

    const observed = new Map()
    for (const [key, cell] of classes) observed.set(`${hotel.id}|${date}|${adults}|${key}`, cell)

    if (classes.size === 0) {
      // 全タイプ満室: グリッドに「満室/売止」を表示し、後日の販売再開検知の
      // 起点にするための満室マーカーを置く (avail=false なのでアラートは出ない)
      observed.set(`${hotel.id}|${date}|${adults}|*`, { plan: '全部屋タイプ', planName: '', price: null, stock: 0, stockPlus: false, stockSrc: null, avail: false, adults })
    } else {
      // 販売が確認できたら過去の満室マーカーは黙って消す
      this.monitor.cells.delete(`${hotel.id}|${date}|${adults}|*`)
    }

    this.monitor.lastObserved = { hotelId: hotel.id, hotel: hotel.name, date, adults, t: Date.now(), idx, total, cycle: this.cycle }
    // セール/ポイントのホテル×日付状態 (部屋タイプ横断)。差分から開始/終了/ポイントUPを検知
    const meta = { sale: parsed.saleLabels ?? [], points: parsed.points ?? null }
    this.monitor.applyScope([`${hotel.id}|${date}|${adults}|`], observed, Date.now(), { meta })
  }

  // プラン一覧ページを開いてパース結果を返す。一時エラー時は null。
  // quick: 在庫プローブ用 (リトライを省略して軽く読む)
  async readPage(page, url, { quick = false } = {}) {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 })
    const status = resp?.status() ?? 0
    if (status >= 500 || status === 429) return null
    // 固定待ちではなく要素の出現を待つ (並列負荷で描画が遅れても取りこぼさない)。
    // まず部屋行、続いて価格の描画を待つ。満室日は価格が出ないので価格待ちは短めにする
    await page.waitForSelector('.rm-type-wrapper', { timeout: 15000 }).catch(() => {})
    await page.waitForSelector('.rm-type-wrapper .ndPrice, .rm-type-wrapper .discountedPrice', { timeout: quick ? 4000 : 5000 }).catch(() => {})
    // 遅延読み込みのプランカードを引き出す
    await page.evaluate(async () => {
      for (let y = 0; y < 5000; y += 1000) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)) }
      window.scrollTo(0, 0)
    }).catch(() => {})

    // パース。0件のときは描画途中の可能性があるので一度だけ待って再試行
    let parsed = await page.evaluate(parsePageInBrowser)
    if (parsed.rows.length === 0 && !quick) {
      await page.waitForTimeout(2500)
      parsed = await page.evaluate(parsePageInBrowser)
    }
    return parsed
  }

  async stop() {
    this.stopped = true
    // ブラウザを閉じると進行中の goto/evaluate が即座に reject され、
    // ワーカーが stopped を見て速やかに抜ける
    if (this.browser) await this.browser.close().catch(() => {})
    this.browser = null
    await this.loopPromise?.catch(() => {})
    this.loopPromise = null
  }
}

// page.evaluate に渡す関数 (ブラウザ内で実行される)。
// 戻り値: { hotelName, sellingClosed, wraps, saleLabels: [ラベル], points: 倍率|null,
//          rows: [{ code, roomName, planName, price, discPrice, stock }] }
// crawl-doctor.js が本番と同一のパースを検証に使うため export している
export function parsePageInBrowser() {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim()
  const toNum = s => { const m = clean(s).replace(/,/g, '').match(/([0-9]{3,})/); return m ? Number(m[1]) : 0 }

  // 部屋タイプ名を整形: 先頭の「N / N」(写真カウンタ) と広さ・設備の後半を落とす。
  // 全角スペースは半角に統一 (短い名と長い名の接頭辞照合のため)
  const roomName = wrap => {
    const priceArea = wrap.querySelector('.htlPlnRmTypPrcArea')
    let t = clean(wrap.innerText)
    if (priceArea) t = clean(t.replace(clean(priceArea.innerText), ''))
    t = t.replace(/^\d+\s*\/\s*\d+\s*/, '')          // "1 / 2 " 写真カウンタ
    t = t.split('｜')[0]                               // 設備の区切り
    t = t.replace(/\s*\d+(?:\.\d+)?\s*(?:m²|㎡|平米).*$/, '') // 広さ以降
    t = t.replace(/(を見る|の詳細|お気に入り).*$/, '')
    t = t.replace(/　/g, ' ')                      // 全角スペース→半角
    return clean(t).slice(0, 40)
  }

  const stockOf = text => {
    const m = clean(text).match(/(?:残り|あと)\s*([0-9]+)\s*室/)
    return m ? Number(m[1]) : null
  }

  // 部屋タイプコード: data-room-type-img-wrap="<planId>-<roomClass>" の末尾。
  // API版の roomClass と同じ安定コード (srw/ctw/dbb…)
  const roomCode = wrap => {
    const el = wrap.querySelector('[data-room-type-img-wrap]')
    const v = el?.getAttribute('data-room-type-img-wrap') || ''
    const m = v.match(/-([a-z0-9]+)$/i)
    return m ? m[1] : ''
  }

  // セール/キャンペーンのラベル判定 (プランカード内テキストから。ページ全体ではなく
  // カード単位で見ることで「このホテル×日付に該当プランがある」ものだけを拾う)
  const SALE_PATTERNS = [
    [/スーパー\s*SALE|スーパーセール/i, '楽天スーパーSALE'],
    [/お買い物マラソン|買い回り|買いまわり/, 'お買い物マラソン'],
    [/5と0のつく日|5と0の付く日/, '5と0のつく日'],
    [/タイムセール/, 'タイムセール'],
    [/感謝祭/, '感謝祭'],
  ]
  const saleSet = new Set()
  let maxPoints = null

  const rows = []
  const cards = document.querySelectorAll('li.planThumb, .planThumb')
  for (const card of cards) {
    const planName = clean(card.querySelector('h4')?.textContent).slice(0, 50)
    // このカードのテキストからセールラベル・ポイント倍率を抽出 (横断で集約)
    const cardText = clean(card.innerText)
    for (const [re, label] of SALE_PATTERNS) if (re.test(cardText)) saleSet.add(label)
    const pm = cardText.match(/ポイント\s*(\d+)\s*倍/)
    if (pm) { const n = Number(pm[1]); if (maxPoints == null || n > maxPoints) maxPoints = n }
    for (const wrap of card.querySelectorAll('.rm-type-wrapper')) {
      // 標準の合計価格 (ndPrice) を比較・アラートの基準にする。クーポン適用後
      // (discountedPrice) はクーポン条件付きで比較が不安定なため基準にはせず、
      // 「割引価格」として併記用に別保持する (通常より安いときだけ)。
      const nd = toNum(wrap.querySelector('.ndPrice')?.textContent)
      const disc = toNum(wrap.querySelector('.discountedPrice')?.textContent)
      const price = nd || disc                                  // 通常 (無ければ割引をフォールバック)
      if (!price) continue
      const discPrice = (nd && disc && disc < nd) ? disc : null  // 実割引があるときのみ
      rows.push({
        code: roomCode(wrap),      // 部屋タイプコード (安定キー)
        roomName: roomName(wrap),
        planName,
        price,
        discPrice,                 // クーポン適用後の割引価格 (なければ null)
        stock: stockOf(wrap.innerText),
      })
    }
  }

  const hotelName = clean(document.querySelector('h1, .hotel-name, [class*="hotelName"]')?.textContent)
    .replace(/\s*(宿泊)?プラン一覧.*$/, '').replace(/\s*の宿泊予約.*$/, '').trim().slice(0, 40)
  const bodyText = document.body.innerText
  const sellingClosed = cards.length === 0 && /満室|予約を受け付けて|空室がございません|該当するプラン/.test(bodyText)
  const wraps = document.querySelectorAll('.rm-type-wrapper').length

  return { hotelName, sellingClosed, rows, wraps, saleLabels: [...saleSet], points: maxPoints }
}
