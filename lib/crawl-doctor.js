// クロール健診スクリプト (HTTP取得が正常にできているかの単体診断)
//
// 本番の browser-source.js と同じ URL 生成 (planUrl) / HTMLパース (parsePlanHtml) を
// 再利用し、1セル (ホテル×日付×人数) を実際に fetch して「どこまで取れているか」を可視化する。
// クロール全体を回さずに、取得失敗の切り分け (到達・マークアップ・パースのどの段で落ちたか) ができる。
//
// 使い方 (本番と同じコンテナ内で実行するのが基本):
//   docker compose exec -T rate-monitor node lib/crawl-doctor.js [hotelNo] [--offset=N] [--adults=N]
//   docker compose exec -T rate-monitor node lib/crawl-doctor.js            # config の全ホテル×offset1を健診
//   docker compose exec -T rate-monitor node lib/crawl-doctor.js 16169 --offset=7 --adults=2 --dump
//
// 出力: 各セルの HTTP status / 主要セレクタ件数 / パース行数 / 部屋タイプ別最安値、
//       および PASS/WARN/FAIL の判定。--dump で失敗時に HTML を /tmp に保存。
//
// 終了コード: 全セル PASS=0 / WARN のみ=0 / FAIL が1つでもあれば=1 (CI・watch から検知可能)

import { readFile, writeFile } from 'node:fs/promises'
import { parse } from 'node-html-parser'
import { planUrl, parsePlanHtml } from './browser-source.js'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
}

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

// 1セルを診断。本番と同じ fetch + parsePlanHtml を踏み、生のセレクタ件数も併記する。
async function diagnoseCell(hotelNo, offset, adults, dump) {
  const url = planUrl(hotelNo, offset, adults, 1)
  const date = dateOf(offset)
  const r = { hotelNo, offset, date, adults, url, status: 0, planThumb: 0, wraps: 0, prices: 0, rows: 0, classes: 0, hotelName: '', block: null, soldOut: false, verdict: 'FAIL', notes: [], cheapest: [] }

  let html = ''
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) })
    r.status = resp.status
    html = await resp.text()
  } catch (e) {
    r.verdict = 'FAIL'
    r.notes.push(`取得失敗: ${e.message}`)
    return r
  }

  try {
    // セレクタ別の生件数 (どの段で0になるかの切り分け用)
    const root = parse(html)
    root.querySelectorAll('script, style, noscript').forEach(e => e.remove())
    r.planThumb = root.querySelectorAll('li.planThumb, .planThumb').length
    r.wraps = root.querySelectorAll('.rm-type-wrapper').length
    r.prices = root.querySelectorAll('.rm-type-wrapper .ndPrice, .rm-type-wrapper .discountedPrice').length
    const bodyText = (root.querySelector('body') || root).structuredText.slice(0, 4000)

    // 本番と同一のパース
    const parsed = parsePlanHtml(html)
    r.rows = parsed.rows.length
    r.hotelName = parsed.hotelName || ''
    r.soldOut = parsed.sellingClosed || (parsed.rows.length === 0 && r.wraps > 0)

    const hit = BLOCK_HINTS.find(h => h.re.test(bodyText))
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
    if (r.status >= 500 || r.status === 429 || r.status === 403) { r.verdict = 'FAIL'; r.notes.push(`HTTP ${r.status} (サーバ側エラー/レート制限)`) }
    else if (r.block) { r.verdict = 'FAIL'; r.notes.push(`ブロック検知: ${r.block}`) }
    else if (r.classes > 0) {
      r.verdict = 'PASS'
      if (parsed.rows.some(x => x.code) && parsed.rows.some(x => !x.code)) r.notes.push('一部の行で部屋タイプコード欠落 (data-room-type-img-wrap)')
      if (r.prices > 0 && r.rows === 0) r.notes.push('価格DOMはあるがパース0 = ndPrice書式変化の疑い')
    }
    else if (r.soldOut) { r.verdict = 'PASS'; r.notes.push('全室満室/売止 (正常な空データ)') }
    else if (r.wraps > 0 && r.prices === 0) { r.verdict = 'WARN'; r.notes.push('部屋行はあるが価格DOMが0 = 満室か、価格セレクタ変化の疑い') }
    else if (r.planThumb === 0 && r.wraps === 0) { r.verdict = 'FAIL'; r.notes.push('プランカード自体が0 = ページ構造変化/別ページ着地の疑い') }
    else { r.verdict = 'WARN'; r.notes.push('プランはあるが部屋タイプコードが取れず集約0') }

    if (dump && r.verdict === 'FAIL') {
      const base = `/tmp/crawl-doctor-${hotelNo}-${offset}-${adults}`
      await writeFile(`${base}.html`, html).catch(() => {})
      r.notes.push(`証跡: ${base}.html`)
    }
  } catch (e) {
    r.verdict = 'FAIL'
    r.notes.push(`例外: ${e.message}`)
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

  console.log(`\n=== クロール健診 (HTTP直接取得) ===`)
  console.log(`対象: ${hotels.length}軒 / offset +${opts.offset}日 (${dateOf(opts.offset)}) / ${opts.adults}名\n`)

  const results = []
  for (const h of hotels) {
    const r = await diagnoseCell(h, opts.offset, opts.adults, opts.dump)
    results.push(r)
    const icon = r.verdict === 'PASS' ? '✅' : r.verdict === 'WARN' ? '⚠️ ' : '❌'
    console.log(`${icon} ${r.verdict}  施設${r.hotelNo}  ${r.hotelName || '(名称取得不可)'}`)
    console.log(`     HTTP ${r.status} | planThumb=${r.planThumb} wraps=${r.wraps} price-DOM=${r.prices} | parse rows=${r.rows} 部屋タイプ=${r.classes}`)
    for (const n of r.notes) console.log(`     ・${n}`)
    for (const c of r.cheapest) console.log(`       - ${c.code} ${c.plan}  ¥${c.price.toLocaleString()}${c.stock != null ? ` (残${c.stock})` : ''}`)
    console.log(`     ${r.url}`)
    console.log('')
  }

  const pass = results.filter(r => r.verdict === 'PASS').length
  const warn = results.filter(r => r.verdict === 'WARN').length
  const fail = results.filter(r => r.verdict === 'FAIL').length
  console.log(`=== 集計: PASS ${pass} / WARN ${warn} / FAIL ${fail} (全${results.length}軒) ===`)
  if (fail > 0) console.log(`FAIL があります。--dump 付きで再実行すると /tmp に HTML を保存します。`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
