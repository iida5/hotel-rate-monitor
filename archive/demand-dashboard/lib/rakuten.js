// 楽天トラベルAPI 連携モジュール (実験的・オプション)
//
// 環境変数 RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY が設定されている場合のみ有効化される。
// (2026年2月のAPI刷新で、エンドポイントが openapi.rakuten.co.jp に変わり
//  applicationId に加えて accessKey が必須になった)
// 各都道府県について「明日チェックインで空室のある施設数 ÷ 全登録施設数」から
// 実勢の逼迫度を推定し、需要指数 (0〜100) としてエンジンに注入する。
// エンジン側はシミュレーション値 55% + 実データ 45% でブレンドする。
//
// API レート制限 (1リクエスト/秒) を守るため、都道府県を1件ずつ順番に
// ポーリングする。全47県を一巡するのに約1.5分かかる。
// 取得に失敗した場合は警告ログを出してシミュレーションのみで継続する。

const API = 'https://openapi.rakuten.co.jp/engine/api/Travel'
const POLL_INTERVAL_MS = 1500

const sleep = ms => new Promise(r => setTimeout(r, ms))

// "東京都"→"東京"、"京都府"→"京都" のように都府県サフィックスを除去。
// 末尾の「都」を機械的に削ると「京都」が「京」になるため、都は東京都のみ対象
const normalize = s => s === '北海道' ? s : s.replace(/^東京都$/, '東京').replace(/[府県]$/, '')

export class RakutenConnector {
  constructor({ appId, accessKey, origin = null }, engine, log = (...a) => console.log(...a)) {
    this.appId = appId
    this.accessKey = accessKey
    // 新APIは呼び出し元ドメインを検証することがある。403が出る場合は
    // アプリ登録した「許可されたWebサイト」を RAKUTEN_ORIGIN で指定する
    this.headers = origin ? { Origin: origin, Referer: origin } : {}
    this.engine = engine
    this.log = log
    this.targets = []          // { prefId, code, name, total }
  }

  get auth() {
    return `applicationId=${this.appId}&accessKey=${encodeURIComponent(this.accessKey)}`
  }

  async start() {
    try {
      await this.loadAreaClasses()
      this.log(`[rakuten] エリア取得成功: ${this.targets.length} 都道府県を監視します (各県の主要エリアを代表観測点として使用)`)
      this.engine.externalSource = '楽天トラベル'
      this.pollLoop() // 待たずにバックグラウンドで回す
    } catch (e) {
      this.log(`[rakuten] 実データ連携を無効化しました (シミュレーションのみで継続): ${e.message}`)
    }
  }

  async fetchJson(url) {
    const res = await fetch(url, { headers: this.headers })
    if (res.status === 429) { await sleep(5000); return this.fetchJson(url) }
    if (!res.ok) {
      let detail = ''
      try {
        const body = await res.json()
        detail = body.error_description ?? body.error ?? ''
      } catch { /* 本文がJSONでない場合は無視 */ }
      if (res.status === 403 && !detail) detail = 'アプリ設定の「許可されたWebサイト」を確認し、RAKUTEN_ORIGIN に登録ドメインを設定してください'
      throw new Error(`HTTP ${res.status}${detail ? ` (${detail})` : ''}`)
    }
    return res.json()
  }

  // GetAreaClass API で都道府県 (middleClass) コードの一覧を取得。
  // 検索APIは「子の区分が存在する場合は子まで指定必須」のため、
  // 各県の先頭の小エリア (主要都市。さらに細区分があればその先頭) を
  // 代表観測点として記録する。
  async loadAreaClasses() {
    const url = `${API}/GetAreaClass/20140210?${this.auth}&format=json`
    const data = await this.fetchJson(url)
    // 20140210版: largeClass はオブジェクトで middleClasses を直接持つ
    // (旧20131024版は largeClass が [情報, {middleClasses}] の配列だった)
    const large = data?.areaClasses?.largeClasses?.[0]?.largeClass
    const middles = (Array.isArray(large) ? large?.[1]?.middleClasses : large?.middleClasses) ?? []
    for (const m of middles) {
      const info = Array.isArray(m?.middleClass) ? m.middleClass[0] : m?.middleClass
      if (!info?.middleClassCode || !info?.middleClassName) continue
      const name = normalize(info.middleClassName)
      const pref = this.engine.prefs.find(p => normalize(p.name) === name)
      if (!pref) continue

      const sRaw = (Array.isArray(m.middleClass) ? m.middleClass[1]?.smallClasses : info.smallClasses)?.[0]?.smallClass
      const small = Array.isArray(sRaw) ? sRaw[0] : sRaw
      const dRaw = ((Array.isArray(sRaw) ? sRaw[1]?.detailClasses : sRaw?.detailClasses) ?? [])[0]?.detailClass
      const detail = Array.isArray(dRaw) ? dRaw[0] : dRaw

      this.targets.push({
        prefId: pref.id,
        name,
        middleCode: info.middleClassCode,
        smallCode: small?.smallClassCode ?? null,
        detailCode: detail?.detailClassCode ?? null,
        areaName: small?.smallClassName ?? name,
        total: 0,
      })
    }
    if (this.targets.length === 0) throw new Error('対応する都道府県エリアが見つかりませんでした')
  }

  // 検索APIに渡す地区コードのクエリ文字列 (存在する階層まで指定)
  areaParams(target) {
    let q = `&largeClassCode=japan&middleClassCode=${encodeURIComponent(target.middleCode)}`
    if (target.smallCode) q += `&smallClassCode=${encodeURIComponent(target.smallCode)}`
    if (target.detailCode) q += `&detailClassCode=${encodeURIComponent(target.detailCode)}`
    return q
  }

  async pollLoop() {
    let i = 0
    while (true) {
      const target = this.targets[i % this.targets.length]
      i++
      try {
        await this.pollOne(target)
      } catch (e) {
        this.log(`[rakuten] ${target.name} の取得に失敗: ${e.message}`)
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async pollOne(target) {
    // 全登録施設数 (ベースライン) は都道府県ごとに一度だけ取得してキャッシュ
    if (!target.total) {
      const url = `${API}/SimpleHotelSearch/20170426?${this.auth}&format=json` +
        `${this.areaParams(target)}&hits=1`
      const data = await this.fetchJson(url)
      target.total = data?.pagingInfo?.recordCount ?? 0
      await sleep(POLL_INTERVAL_MS)
    }
    if (!target.total) return

    const ci = dateStr(1), co = dateStr(2) // 明日チェックイン・1泊
    const url = `${API}/VacantHotelSearch/20170426?${this.auth}&format=json` +
      `${this.areaParams(target)}` +
      `&checkinDate=${ci}&checkoutDate=${co}&adultNum=1&hits=1`
    let vacant = 0
    try {
      const data = await this.fetchJson(url)
      vacant = data?.pagingInfo?.recordCount ?? 0
    } catch (e) {
      // 楽天APIは空室ゼロのとき 404 を返すため、それは「満室」として扱う
      if (!String(e.message).includes('404')) throw e
    }

    // 空室施設の割合が低いほど需要が逼迫していると推定
    const pressure = 1 - Math.min(1, vacant / target.total)
    const index = Math.min(98, Math.max(5, pressure * 160))
    this.engine.externalBias.set(target.prefId, index)
  }
}

function dateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return d.toISOString().slice(0, 10)
}
