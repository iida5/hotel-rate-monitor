// 47都道府県マスタデータ
//   id      : JIS都道府県コード
//   name    : 表示名
//   region  : 地方区分
//   city    : 代表都市(ホテル名生成に使用)
//   pop     : 観光・宿泊需要の基礎ポテンシャル (0〜1)
//   adrBase : 平均客室単価のベースライン (円)
//   gx, gy  : タイルマップ上のグリッド座標 (x: 西→東, y: 北→南)
//   season  : 季節需要パターンのキー (seasonTables を参照)

export const PREFECTURES = [
  { id: 1,  name: '北海道',  region: '北海道', city: '札幌',     pop: 0.80, adrBase: 13000, gx: 13, gy: 0,  season: 'hokkaido' },
  { id: 2,  name: '青森',    region: '東北',   city: '青森',     pop: 0.50, adrBase: 9000,  gx: 12, gy: 2,  season: 'default' },
  { id: 3,  name: '岩手',    region: '東北',   city: '盛岡',     pop: 0.48, adrBase: 8800,  gx: 12, gy: 3,  season: 'default' },
  { id: 4,  name: '宮城',    region: '東北',   city: '仙台',     pop: 0.62, adrBase: 11000, gx: 12, gy: 4,  season: 'default' },
  { id: 5,  name: '秋田',    region: '東北',   city: '秋田',     pop: 0.46, adrBase: 8800,  gx: 11, gy: 3,  season: 'default' },
  { id: 6,  name: '山形',    region: '東北',   city: '山形',     pop: 0.47, adrBase: 9000,  gx: 11, gy: 4,  season: 'default' },
  { id: 7,  name: '福島',    region: '東北',   city: '福島',     pop: 0.50, adrBase: 9200,  gx: 12, gy: 5,  season: 'default' },
  { id: 8,  name: '茨城',    region: '関東',   city: '水戸',     pop: 0.50, adrBase: 8800,  gx: 13, gy: 6,  season: 'default' },
  { id: 9,  name: '栃木',    region: '関東',   city: '宇都宮',   pop: 0.55, adrBase: 10500, gx: 12, gy: 6,  season: 'default' },
  { id: 10, name: '群馬',    region: '関東',   city: '前橋',     pop: 0.53, adrBase: 10000, gx: 11, gy: 6,  season: 'default' },
  { id: 11, name: '埼玉',    region: '関東',   city: 'さいたま', pop: 0.52, adrBase: 9000,  gx: 11, gy: 7,  season: 'default' },
  { id: 12, name: '千葉',    region: '関東',   city: '舞浜',     pop: 0.74, adrBase: 14000, gx: 12, gy: 8,  season: 'default' },
  { id: 13, name: '東京',    region: '関東',   city: '東京',     pop: 0.92, adrBase: 19000, gx: 11, gy: 8,  season: 'default' },
  { id: 14, name: '神奈川',  region: '関東',   city: '横浜',     pop: 0.74, adrBase: 14000, gx: 11, gy: 9,  season: 'default' },
  { id: 15, name: '新潟',    region: '中部',   city: '新潟',     pop: 0.52, adrBase: 9500,  gx: 10, gy: 5,  season: 'snow' },
  { id: 16, name: '富山',    region: '中部',   city: '富山',     pop: 0.50, adrBase: 9500,  gx: 9,  gy: 6,  season: 'default' },
  { id: 17, name: '石川',    region: '中部',   city: '金沢',     pop: 0.68, adrBase: 13000, gx: 8,  gy: 6,  season: 'default' },
  { id: 18, name: '福井',    region: '中部',   city: '福井',     pop: 0.47, adrBase: 9200,  gx: 8,  gy: 7,  season: 'default' },
  { id: 19, name: '山梨',    region: '中部',   city: '甲府',     pop: 0.56, adrBase: 11000, gx: 10, gy: 7,  season: 'default' },
  { id: 20, name: '長野',    region: '中部',   city: '長野',     pop: 0.62, adrBase: 11500, gx: 10, gy: 6,  season: 'snow' },
  { id: 21, name: '岐阜',    region: '中部',   city: '岐阜',     pop: 0.54, adrBase: 10000, gx: 9,  gy: 7,  season: 'default' },
  { id: 22, name: '静岡',    region: '中部',   city: '熱海',     pop: 0.60, adrBase: 11000, gx: 10, gy: 8,  season: 'default' },
  { id: 23, name: '愛知',    region: '中部',   city: '名古屋',   pop: 0.70, adrBase: 11500, gx: 9,  gy: 8,  season: 'default' },
  { id: 24, name: '三重',    region: '近畿',   city: '伊勢',     pop: 0.52, adrBase: 10000, gx: 9,  gy: 9,  season: 'default' },
  { id: 25, name: '滋賀',    region: '近畿',   city: '大津',     pop: 0.48, adrBase: 9500,  gx: 8,  gy: 8,  season: 'default' },
  { id: 26, name: '京都',    region: '近畿',   city: '京都',     pop: 0.86, adrBase: 17000, gx: 7,  gy: 8,  season: 'kyoto' },
  { id: 27, name: '大阪',    region: '近畿',   city: '大阪',     pop: 0.88, adrBase: 15000, gx: 7,  gy: 9,  season: 'default' },
  { id: 28, name: '兵庫',    region: '近畿',   city: '神戸',     pop: 0.66, adrBase: 12000, gx: 6,  gy: 8,  season: 'default' },
  { id: 29, name: '奈良',    region: '近畿',   city: '奈良',     pop: 0.58, adrBase: 10500, gx: 8,  gy: 9,  season: 'kyoto' },
  { id: 30, name: '和歌山',  region: '近畿',   city: '白浜',     pop: 0.52, adrBase: 10500, gx: 7,  gy: 10, season: 'default' },
  { id: 31, name: '鳥取',    region: '中国',   city: '鳥取',     pop: 0.45, adrBase: 8800,  gx: 5,  gy: 8,  season: 'default' },
  { id: 32, name: '島根',    region: '中国',   city: '松江',     pop: 0.46, adrBase: 9000,  gx: 4,  gy: 8,  season: 'default' },
  { id: 33, name: '岡山',    region: '中国',   city: '岡山',     pop: 0.54, adrBase: 9500,  gx: 5,  gy: 9,  season: 'default' },
  { id: 34, name: '広島',    region: '中国',   city: '広島',     pop: 0.66, adrBase: 11000, gx: 4,  gy: 9,  season: 'default' },
  { id: 35, name: '山口',    region: '中国',   city: '下関',     pop: 0.47, adrBase: 8800,  gx: 3,  gy: 9,  season: 'default' },
  { id: 36, name: '徳島',    region: '四国',   city: '徳島',     pop: 0.45, adrBase: 8800,  gx: 6,  gy: 10, season: 'default' },
  { id: 37, name: '香川',    region: '四国',   city: '高松',     pop: 0.52, adrBase: 9500,  gx: 5,  gy: 10, season: 'default' },
  { id: 38, name: '愛媛',    region: '四国',   city: '松山',     pop: 0.50, adrBase: 9500,  gx: 4,  gy: 10, season: 'default' },
  { id: 39, name: '高知',    region: '四国',   city: '高知',     pop: 0.46, adrBase: 9000,  gx: 5,  gy: 11, season: 'default' },
  { id: 40, name: '福岡',    region: '九州',   city: '博多',     pop: 0.78, adrBase: 12000, gx: 1,  gy: 10, season: 'default' },
  { id: 41, name: '佐賀',    region: '九州',   city: '佐賀',     pop: 0.45, adrBase: 8500,  gx: 0,  gy: 10, season: 'default' },
  { id: 42, name: '長崎',    region: '九州',   city: '長崎',     pop: 0.58, adrBase: 10500, gx: 0,  gy: 11, season: 'default' },
  { id: 43, name: '熊本',    region: '九州',   city: '熊本',     pop: 0.56, adrBase: 10000, gx: 1,  gy: 11, season: 'default' },
  { id: 44, name: '大分',    region: '九州',   city: '別府',     pop: 0.60, adrBase: 11000, gx: 2,  gy: 10, season: 'default' },
  { id: 45, name: '宮崎',    region: '九州',   city: '宮崎',     pop: 0.50, adrBase: 9500,  gx: 2,  gy: 11, season: 'default' },
  { id: 46, name: '鹿児島',  region: '九州',   city: '鹿児島',   pop: 0.56, adrBase: 10500, gx: 1,  gy: 12, season: 'default' },
  { id: 47, name: '沖縄',    region: '沖縄',   city: '那覇',     pop: 0.84, adrBase: 16000, gx: 0,  gy: 14, season: 'okinawa' },
]
