// クロール健診スクリプト (Chromeクロールが正常に取得できているかの単体診断)
//
// 本番の browser-source.js と同じ URL 生成 (planUrl) / DOMパース (parsePageInBrowser) を
// 再利用し、1セル (ホテル×日付×人数) を実際に開いて「どこまで取れているか」を可視化する。
// クロール全体を回さずに、取得失敗の切り分け (到達・描画・パースのどの段で落ちたか) ができる。
//
// 使い方 (本番と同じコンテナ内で実行するのが基本):
//   docker compose exec -T rate-monitor node lib/crawl-doctor.js [hotelNo] [--offset=N] [--adults=N]
//   docker compose exec -T rate-monitor node lib/crawl-doctor.js            # config の全ホテル×offset1を健診
//   docker compose exec -T rate-monitor node lib/crawl-doctor.js 16169 --offset=7 --adults=2 --dump
//
// 出力: 各セルの HTTP status / 主要セレクタ件数 / パース行数 / 部屋タイプ別最安値、
//       および PASS/WARN/FAIL の判定。--dump で失敗時に HTML とスクショを /tmp に保存。
//
// 終了コード: 全セル PASS=0 / WARN のみ=0 / FAIL が1つでもあれば=1 (CI・watch から検知可能)

import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { planUrl, parsePageInBrowser } from './browser-source.js'

const p2 = n => String(n).padStart(2, '0')
const dateOf = offset => {
  const d = new Date(Date.now() + offset * 86_400_000)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// ボット検知・メンテナンス・404 等、楽天が正規のプランページ以外を返したときの目印。
// これらが本文に出ていてプランが0件なら「構造変化」ではなく「ブロック/異常応答」と切り分ける。
const BLOCK_HINTS = [
  { re: /アクセスが集中|しばらく時間をおいて|ただいま大変混雑/, label: '混雑/レート制限ページ' },
  { re: /reCAPTCHA|captcha|ロボットではない|認証にご協力/i, label: 'CAPTCHA/ボット検知' },
  { re: /メンテナンス|ただいまご利用いただけません/, label: 'メンテナンス画面' },
  { re: /ページが見つかりません|お探しのページ|404 Not Found/i, label: '404/ページ消失' },
  { re: /該当する施設|施設情報が見つかりません/, label: '施設番号が無効' },
]

function parseArgs(argv) {
  const opts = { offset: 1, adults: 2, dump: false, hotels: [] }
  for (const a of argv) {
    if (a.startsWith('--offset=')) opts.offset = Number(a.slice(9))
    else if (a.startsWith('--adults=')) opts.adults = Number(a.slice(9))
    else if (a === '--dump') opts.dump = true
    else if (!a.startsWith('--')) opts.hotels.push(a)
  }
  return opts
}

async function configHotels() {
  try {
    const cfg = JSON.parse(await readFile(new URL('../data/rateshop-config.json', import.meta.url)))
    return Array.isArray(cfg.hotels) ? cfg.hotels.map(String) : []
  } catch { return [] }
}

// 1セルを診断。production の readPage と同じ待機・スクロール手順を踏んでからパースする。
async function diagnoseCell(browser, hotelNo, offset, adults, dump) {
  const url = planUrl(hotelNo, offset, adults, 1)
  const date = dateOf(offset)
  const r = { hotelNo, offset, date, adults, url, status: 0, planThumb: 0, wraps: 0, prices: 0, rows: 0, classes: 0, hotelName: '', block: null, soldOut: false, verdict: 'FAIL', notes: [], cheapest: [] }

  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'ja-JP', viewport: { width: 1280, height: 2600 },
  })
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    if (t === 'image' || t === 'font' || t === 'media') return route.abort()
    return route.continue()
  }).catch(() => {})

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 })
    r.status = resp?.status() ?? 0
    await page.waitForSelector('.rm-type-wrapper', { timeout: 15000 }).catch(() => {})
    await page.waitForSelector('.rm-type-wrapper .ndPrice, .rm-type-wrapper .discountedPrice', { timeout: 5000 }).catch(() => {})
    await page.evaluate(async () => {
      for (let y = 0; y < 5000; y += 1000) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)) }
      window.scrollTo(0, 0)
    }).catch(() => {})

    // セレクタ別の生件数 (どの段で0になるかの切り分け用) と本番パース結果を両方取る
    const probe = await page.evaluate(() => ({
      planThumb: document.querySelectorAll('li.planThumb, .planThumb').length,
      wraps: document.querySelectorAll('.rm-type-wrapper').length,
      prices: document.querySelectorAll('.rm-type-wrapper .ndPrice, .rm-type-wrapper .discountedPrice').length,
      bodyText: (document.body?.innerText || '').slice(0, 4000),
      title: document.title,
    }))
    let parsed = await page.evaluate(parsePageInBrowser)
    if (parsed.rows.length === 0) {
      await page.waitForTimeout(2500)
      parsed = await page.evaluate(parsePageInBrowser)
    }

    r.planThumb = probe.planThumb
    r.wraps = probe.wraps
    r.prices = probe.prices
    r.rows = parsed.rows.length
    r.hotelName = parsed.hotelName || ''
    r.soldOut = parsed.sellingClosed || (parsed.rows.length === 0 && probe.wraps > 0)

    const hit = BLOCK_HINTS.find(h => h.re.test(probe.bodyText))
    if (hit) { r.block = hit.label }

    // 本番と同じく部屋タイプコードで最安に集約
    const classes = new Map()
    for (const row of parsed.rows) {
      if (!row.price || !row.code) continue
      const cur = classes.get(row.code)
      if (!cur || row.price < cur.price) classes.set(row.code, { code: row.code, plan: row.roomName, price: row.price, stock: row.stock })
    }
    r.classes = classes.size
    r.cheapest = [...classes.values()].sort((a, b) => a.price - b.price).slice(0, 5)

    // 判定
    if (r.status >= 500 || r.status === 429) { r.verdict = 'FAIL'; r.notes.push(`HTTP ${r.status} (サーバ側エラー/レート制限)`) }
    else if (r.block) { r.verdict = 'FAIL'; r.notes.push(`ブロック検知: ${r.block}`) }
    else if (r.classes > 0) {
      r.verdict = 'PASS'
      if (parsed.rows.some(x => x.code) && parsed.rows.some(x => !x.code)) r.notes.push('一部の行で部屋タイプコード欠落 (data-room-type-img-wrap)')
      if (r.prices > 0 && r.rows === 0) r.notes.push('価格DOMはあるがパース0 = ndPrice書式変化の疑い')
    }
    else if (r.soldOut) { r.verdict = 'PASS'; r.notes.push('全室満室/売止 (正常な空データ)') }
    else if (r.wraps > 0 && r.prices === 0) { r.verdict = 'WARN'; r.notes.push('部屋行はあるが価格DOMが0 = 満室か、価格セレクタ変化の疑い') }
    else if (r.planThumb === 0 && r.wraps === 0) { r.verdict = 'FAIL'; r.notes.push('プランカード自体が0 = ページ構造変化/未描画/別ページ着地の疑い') }
    else { r.verdict = 'WARN'; r.notes.push('プランはあるが部屋タイプコードが取れず集約0') }

    if (dump && r.verdict === 'FAIL') {
      const base = `/tmp/crawl-doctor-${hotelNo}-${offset}-${adults}`
      await writeFile(`${base}.html`, await page.content()).catch(() => {})
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {})
      r.notes.push(`証跡: ${base}.html / ${base}.png`)
    }
  } catch (e) {
    r.verdict = 'FAIL'
    r.notes.push(`例外: ${e.message}`)
  } finally {
    await page.close().catch(() => {})
  }
  return r
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const hotels = opts.hotels.length ? opts.hotels : await configHotels()
  if (!hotels.length) {
    console.error('診断対象のホテルがありません。引数で施設番号を渡すか data/rateshop-config.json を用意してください。')
    process.exit(2)
  }

  console.log(`\n=== Chromeクロール健診 ===`)
  console.log(`対象: ${hotels.length}軒 / offset +${opts.offset}日 (${dateOf(opts.offset)}) / ${opts.adults}名\n`)

  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (e) {
    console.error(`ブラウザ起動失敗: ${e.message}`)
    console.error(`コンテナ内で実行していますか? 例: docker compose exec -T rate-monitor node lib/crawl-doctor.js`)
    process.exit(2)
  }

  const results = []
  for (const h of hotels) {
    const r = await diagnoseCell(browser, h, opts.offset, opts.adults, opts.dump)
    results.push(r)
    const icon = r.verdict === 'PASS' ? '✅' : r.verdict === 'WARN' ? '⚠️ ' : '❌'
    console.log(`${icon} ${r.verdict}  施設${r.hotelNo}  ${r.hotelName || '(名称取得不可)'}`)
    console.log(`     HTTP ${r.status} | planThumb=${r.planThumb} wraps=${r.wraps} price-DOM=${r.prices} | parse rows=${r.rows} 部屋タイプ=${r.classes}`)
    for (const n of r.notes) console.log(`     ・${n}`)
    for (const c of r.cheapest) console.log(`       - ${c.code} ${c.plan}  ¥${c.price.toLocaleString()}${c.stock != null ? ` (残${c.stock})` : ''}`)
    console.log(`     ${r.url}`)
    console.log('')
  }
  await browser.close().catch(() => {})

  const pass = results.filter(r => r.verdict === 'PASS').length
  const warn = results.filter(r => r.verdict === 'WARN').length
  const fail = results.filter(r => r.verdict === 'FAIL').length
  console.log(`=== 集計: PASS ${pass} / WARN ${warn} / FAIL ${fail} (全${results.length}軒) ===`)
  if (fail > 0) console.log(`FAIL があります。--dump 付きで再実行すると /tmp に HTML/スクショを保存します。`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
