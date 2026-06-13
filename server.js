// 競合レート監視 (レートショッパー) - HTTPサーバー + SSE配信
//
// 外部依存ゼロ + Playwright (ブラウザ収集時)。
//   起動:  node server.js
//   閲覧:  http://localhost:3000
//
// エンドポイント:
//   GET  /                          監視ダッシュボード (public/rateshop.html)
//   GET  /api/rateshop/snapshot     現在の比較グリッド + 直近アラート
//   GET  /api/rateshop/alerts?limit= アラート履歴 (最大400件)
//   GET  /api/rateshop/timeline     ホテル別イベントタイムライン (hotel/from/to/adults)
//   GET  /api/rateshop/stream       SSE リアルタイムストリーム
//   GET  /api/rateshop/config       現在の監視設定 (画面の設定フォーム用)
//   POST /api/rateshop/config       監視設定を更新して監視を再起動
//
// 監視設定 (監視施設・自社施設・チェックイン日・宿泊人数・並列数) は
// 画面の「設定」から変更でき、data/rateshop-config.json に保存される。
// 環境変数は初回起動時の既定値 (seed) として使われる。
//
// 環境変数 (.env ファイルにも書ける。シェル設定が優先):
//   PORT               リッスンポート (既定 3000)
//   HOST               バインド先 (既定 127.0.0.1)
//   RATESHOP_SOURCE    データソース browser|rakuten|sim (既定: ホテル指定時 browser)
//   RATESHOP_HOTELS    監視する楽天施設番号 (カンマ区切り。設定の初期値)
//   RATESHOP_OWN       上記のうち自社の施設番号 (設定の初期値)
//   RATESHOP_DATES     監視するチェックイン日のオフセット日数 (既定 "1,3,7,14,30")
//   RATESHOP_ADULTS    空室検索する宿泊人数。カンマ区切りで最大3プロファイル (既定 2。例 "1,2")
//   RATESHOP_CONCURRENCY ブラウザ収集の並列ページ数 1〜10 (既定 3)
//   RATESHOP_STOCK_PROBE 残室数プローブの最大段数 1〜10 (既定 5。1で無効=バッジ実値のみ)
//   RATESHOP_HEADFUL   1 でブラウザを画面表示 (デバッグ用。既定はヘッドレス)
//   RATESHOP_WEBHOOK   アラート送信先のSlack互換Webhook URL (任意)
//   RATESHOP_WEBHOOK_TYPES Webhookで送る種別 (既定 price_up,price_down,soldout,restock)
//   RATESHOP_WEBHOOK_PCT   Webhookで送る価格変動の最小% (既定 0)
//   --- 以下は RATESHOP_SOURCE=rakuten のときのみ ---
//   RAKUTEN_APP_ID     楽天トラベルAPIのアプリID
//   RAKUTEN_ACCESS_KEY 楽天APIのアクセスキー (2026年2月の刷新以降は必須)
//   RAKUTEN_ORIGIN     アプリ登録した「許可されたWebサイト」のドメイン (403が出る場合に設定)
//   RATESHOP_TICK_MS   シミュレーションモードの更新間隔ミリ秒 (既定 5000)

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RateShopMonitor, SimulatedRateSource, RakutenRateSource } from './lib/rateshop.js'
import { BrowserRateSource } from './lib/browser-source.js'
import { loadConfig, normalizeConfig, saveConfig } from './lib/settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const DATA_DIR = path.join(__dirname, 'data')

// .env の簡易パーサ (node:util の parseEnv は Node 20.12+ のため自前で持つ)。
// KEY=VALUE 行のみ対応。# 始まりの行と空行は無視し、値の前後の引用符は外す。
function parseEnv(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

// .env があれば読み込む (シェルで設定済みの環境変数が優先)
try {
  const parsed = parseEnv(readFileSync(path.join(__dirname, '.env'), 'utf8'))
  for (const [k, v] of Object.entries(parsed)) process.env[k] ??= v
  console.log('[env] .env を読み込みました')
} catch { /* .env が無ければ環境変数のみで動作 */ }

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

// ---------- 環境変数由来の固定設定 (画面からは変更しない項目) ----------

// 2026年2月のAPI刷新以降、楽天APIは applicationId に加えて accessKey が必須
const rakutenAuth = {
  appId: process.env.RAKUTEN_APP_ID,
  accessKey: process.env.RAKUTEN_ACCESS_KEY,
  origin: process.env.RAKUTEN_ORIGIN || null,
}
const rakutenReady = Boolean(rakutenAuth.appId && rakutenAuth.accessKey)
if (rakutenAuth.appId && !rakutenAuth.accessKey) {
  console.log('[rakuten] RAKUTEN_ACCESS_KEY が未設定です。2026年2月のAPI刷新以降、アプリIDに加えてアクセスキーが必須です。')
  console.log('[rakuten] https://webservice.rakuten.co.jp/app/list のアプリ詳細で確認できます。')
}

// CLI 引数 --source=sim|browser|rakuten は環境変数 RATESHOP_SOURCE より優先 (検証用)
const argSource = process.argv.find(a => a.startsWith('--source='))?.split('=')[1]

const FIXED = {
  source: (argSource || process.env.RATESHOP_SOURCE || '').toLowerCase(),
  stockProbe: Number(process.env.RATESHOP_STOCK_PROBE || 5),
  headless: process.env.RATESHOP_HEADFUL !== '1',
  tickMs: Number(process.env.RATESHOP_TICK_MS || 5000),
}

// ---------- 監視設定 (画面から変更可能な5項目) ----------

const envSeed = {
  hotels: process.env.RATESHOP_HOTELS || '',
  own: process.env.RATESHOP_OWN || null,
  dates: process.env.RATESHOP_DATES || '1,3,7,14,30',
  adults: process.env.RATESHOP_ADULTS,
  concurrency: process.env.RATESHOP_CONCURRENCY,
}
let config = await loadConfig(DATA_DIR, envSeed)

// Webhook のサーバー側フィルタ (通知先が在庫±1室で埋まるのを防ぐ)
//   RATESHOP_WEBHOOK_TYPES 送る種別のカンマ区切り (既定 price_up,price_down,soldout,restock)
//   RATESHOP_WEBHOOK_PCT   価格変動はこの%以上のみ送る (既定 0)
const webhookTypes = (process.env.RATESHOP_WEBHOOK_TYPES || 'price_up,price_down,soldout,restock')
  .split(',').map(s => s.trim()).filter(Boolean)
const rateshop = new RateShopMonitor({
  dateOffsets: config.dates,
  dataDir: DATA_DIR,
  webhook: process.env.RATESHOP_WEBHOOK || null,
  webhookFilter: { types: webhookTypes, minPct: Number(process.env.RATESHOP_WEBHOOK_PCT || 0) },
})

// 設定とデータソースから、使うべきソース種別を決める
function resolveKind(cfg) {
  if (!cfg.hotels.length) return 'sim'
  if (FIXED.source) return FIXED.source
  return 'browser'
}

function buildSource(cfg) {
  const kind = resolveKind(cfg)
  if (kind === 'rakuten' && rakutenReady) {
    return new RakutenRateSource(rateshop, {
      ...rakutenAuth,
      hotelNos: cfg.hotels,
      ownHotelNo: cfg.own,
      adults: cfg.adults,
      stockProbe: FIXED.stockProbe,
    })
  }
  if (kind === 'browser') {
    return new BrowserRateSource(rateshop, {
      hotelNos: cfg.hotels,
      ownHotelNo: cfg.own,
      adults: cfg.adults,
      concurrency: cfg.concurrency,
      stockProbe: FIXED.stockProbe,
      headless: FIXED.headless,
    })
  }
  if (kind === 'rakuten') {
    console.log('[rateshop] 楽天APIの認証情報が揃っていないため、シミュレーションモードで起動します。')
  }
  return new SimulatedRateSource(rateshop, { tickMs: FIXED.tickMs })
}

let activeSource = buildSource(config)
let applying = false // 設定変更の多重実行ガード

await activeSource.start()

// 画面から設定が変わったら: 現在のソースを止め、ベースラインをリセットして再起動
async function applyConfig(rawConfig) {
  const next = normalizeConfig(rawConfig, config)
  applying = true
  try {
    await activeSource?.stop?.()
    rateshop.setDateOffsets(next.dates)
    rateshop.resetObservations() // 監視対象が変わるので差分のベースラインを取り直す
    config = next
    await saveConfig(DATA_DIR, config)
    activeSource = buildSource(config)
    await activeSource.start({ resume: false })
    console.log(`[rateshop] 設定を更新しました: ${config.hotels.length}軒 / 日付 ${config.dates.join(',')} / ${config.adults.join('/')}名 / 並列${config.concurrency}`)
  } finally {
    applying = false
  }
  // 設定変更直後のスナップショットを即配信
  broadcast()
  return config
}

// 終了時にソースを後始末
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    Promise.resolve(activeSource?.stop?.()).finally(() => process.exit(0))
  })
}

const sseClients = new Set()
// onEmit から渡されたペイロード (新着アラート入り) はそのまま流す。
// 引数なしで呼ばれた場合 (設定変更直後など) は現在のスナップショットを作る。
function broadcast(payload) {
  if (sseClients.size === 0) return
  const frame = `data: ${JSON.stringify(payload ?? rateshop.payload())}\n\n`
  for (const client of sseClients) client.write(frame)
}
rateshop.onEmit = broadcast

// ---------- HTTPサーバー ----------

function json(res, body, status = 200) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(data)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', chunk => {
      buf += chunk
      if (buf.length > limit) reject(new Error('リクエストが大きすぎます'))
    })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'rateshop.html' : urlPath.slice(1)
  const filePath = path.resolve(PUBLIC_DIR, rel)
  if (!filePath.startsWith(PUBLIC_DIR)) { // パストラバーサル防止
    res.writeHead(403); res.end('Forbidden'); return
  }
  try {
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  }
}

const server = http.createServer(async (req, res) => {
  // 不正なリクエストURL (例: パス "//") で new URL が例外を投げても
  // プロセス全体を巻き込まないよう、URLパースと処理全体を保護する。
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('400 Bad Request')
    return
  }
  try {
  const p = url.pathname

  if (p === '/api/rateshop/snapshot') {
    return json(res, { ...rateshop.payload(), recent: rateshop.alerts.slice(0, 120) })
  }

  if (p === '/api/rateshop/alerts') {
    const limit = Math.min(400, Number(url.searchParams.get('limit') || 100))
    return json(res, rateshop.alerts.slice(0, limit))
  }

  // 推移チャート用の観測履歴 (ホテル×日付、人数は任意)
  if (p === '/api/rateshop/history') {
    const hotelId = url.searchParams.get('hotel')
    const date = url.searchParams.get('date')
    if (!hotelId || !date) return json(res, { error: 'hotel と date を指定してください' }, 400)
    const adultsRaw = url.searchParams.get('adults')
    const adults = adultsRaw ? Number(adultsRaw) : null
    const history = await rateshop.readHistory({ hotelId, date, adults })
    return json(res, { hotelId, date, adults, history })
  }

  // ホテル別イベントタイムライン (アラート履歴を施設・期間・人数で絞る)
  if (p === '/api/rateshop/timeline') {
    const hotelId = url.searchParams.get('hotel') || null
    const fromRaw = url.searchParams.get('from')
    const toRaw = url.searchParams.get('to')
    const adultsRaw = url.searchParams.get('adults')
    const from = fromRaw ? Number(fromRaw) : null
    const to = toRaw ? Number(toRaw) : null
    const adults = adultsRaw ? Number(adultsRaw) : null
    const events = await rateshop.readTimeline({ hotelId, from, to, adults })
    // 左カラムのホテル一覧と人数タブ用に、現在の監視対象も併せて返す
    return json(res, {
      hotelId, from, to, adults,
      hotels: rateshop.hotels,
      adultsList: rateshop.adultsList ?? null,
      events,
    })
  }

  if (p === '/api/rateshop/config') {
    if (req.method === 'GET') {
      return json(res, { config, kind: resolveKind(config), applying })
    }
    if (req.method === 'POST') {
      if (applying) return json(res, { error: '設定を適用中です。少し待って再度お試しください。' }, 409)
      try {
        const body = await readBody(req)
        const saved = await applyConfig(JSON.parse(body || '{}'))
        return json(res, { ok: true, config: saved, kind: resolveKind(saved) })
      } catch (e) {
        return json(res, { error: e.message }, 400)
      }
    }
    res.writeHead(405); res.end('Method Not Allowed'); return
  }

  if (p === '/api/rateshop/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write('retry: 3000\n\n')
    res.write(`data: ${JSON.stringify({ ...rateshop.payload(), recent: rateshop.alerts.slice(0, 120) })}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // 旧需要ダッシュボードのパスは競合監視にリダイレクト
  if (p === '/rateshop.html' || p === '/index.html') {
    res.writeHead(302, { Location: '/' })
    res.end()
    return
  }

  return serveStatic(res, p)
  } catch (e) {
    // 想定外の例外でも監視を落とさない。応答前なら500を返す。
    console.error(`[server] リクエスト処理でエラー: ${e?.message ?? e}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('500 Internal Server Error')
    } else {
      res.end()
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log('==============================================')
  console.log('  ホテル競合レート監視ダッシュボード')
  console.log(`  http://localhost:${PORT}`)
  const label = { browser: 'ブラウザ収集 (楽天トラベル)', rakuten: '楽天トラベルAPI', sim: 'シミュレーション' }
  console.log(`  データソース: ${label[resolveKind(config)] ?? resolveKind(config)}`)
  console.log('==============================================')
})
