# 競合レート監視ダッシュボード — コンテナイメージ
#
# ベースは Playwright 公式イメージ。Chromium 本体・OS依存ライブラリ・Node が
# 同梱済みなので、別PCでも「npx playwright install」「実行権限の修復」
# 「Node バージョン合わせ」といった手作業が一切不要になる。
#
# タグの v1.60.0 は package.json の playwright バージョンと必ず一致させること
# (イメージ内のブラウザと npm パッケージのバージョン整合が取れる)。
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる。
# ブラウザはイメージに同梱済みなので postinstall での再ダウンロードを止める。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# アプリ本体 (data/ は実行時にボリュームで渡すのでイメージには含めない)
COPY server.js ./
COPY lib ./lib
COPY public ./public

# コンテナ外から到達できるよう 0.0.0.0 で待ち受ける
# (既定の 127.0.0.1 だとポートを公開してもホストから見えない)
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000
CMD ["node", "server.js"]
