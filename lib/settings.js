// 画面から変更できる監視設定の永続化
//
// data/rateshop-config.json に保存する。初回 (ファイル無し) は引数の seed
// (=環境変数由来の既定値) で作成し、以降はこのファイルが優先される。
// 画面から変更できるのは以下の5項目のみ:
//   hotels      監視する楽天施設番号 (文字列の配列)
//   own         上記のうち自社の施設番号 (文字列 | null)
//   dates       監視するチェックイン日のオフセット日数 (整数の配列)
//   adults      空室検索する宿泊人数のプロファイル (整数の配列・最大3件。例 [1,2])
//   concurrency ブラウザ収集の並列ページ数 (整数 1〜10)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FILE = 'rateshop-config.json'
const MAX_DATES = 14

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

// 受け取った値を安全な形に整える (画面からの入力もここを必ず通す)
export function normalizeConfig(raw = {}, base = {}) {
  const src = { ...base, ...raw }

  // 施設番号: 数字のみ・重複除去・最大30件
  const hotels = [...new Set(
    (Array.isArray(src.hotels) ? src.hotels : String(src.hotels ?? '').split(/[\s,、]+/))
      .map(s => String(s).trim())
      .filter(s => /^\d{1,10}$/.test(s))
  )].slice(0, 30)

  // 自社施設は監視施設に含まれるものだけ有効
  let own = src.own == null ? null : String(src.own).trim()
  if (!hotels.includes(own)) own = null

  // チェックイン日オフセット: 0 (今夜) 以上の整数・重複除去・昇順・最大14件
  const dates = [...new Set(
    (Array.isArray(src.dates) ? src.dates : String(src.dates ?? '').split(/[\s,、]+/))
      .map(s => Math.trunc(Number(s)))
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 365)
  )].sort((a, b) => a - b).slice(0, MAX_DATES)

  // 宿泊人数プロファイル: 1〜10名・重複除去・昇順・最大3件 (旧形式の単一数値も受ける)
  const adults = [...new Set(
    (Array.isArray(src.adults) ? src.adults : String(src.adults ?? '').split(/[\s,、]+/))
      .map(s => Math.trunc(Number(s)))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 10)
  )].sort((a, b) => a - b).slice(0, 3)

  return {
    hotels,
    own,
    dates: dates.length ? dates : [1, 3, 7, 14, 30],
    adults: adults.length ? adults : [2],
    concurrency: clampInt(src.concurrency, 1, 10, 3),
  }
}

export async function loadConfig(dataDir, seed) {
  const base = normalizeConfig(seed)
  if (!dataDir) return base
  try {
    const saved = JSON.parse(await readFile(path.join(dataDir, FILE), 'utf8'))
    return normalizeConfig(saved, base)
  } catch {
    // ファイルが無ければ seed で作成しておく
    await saveConfig(dataDir, base).catch(() => {})
    return base
  }
}

export async function saveConfig(dataDir, config) {
  if (!dataDir) return
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, FILE), JSON.stringify(config, null, 2))
}
