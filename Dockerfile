# 競合レート監視ダッシュボード — コンテナイメージ
#
# データ取得は HTTP fetch + node-html-parser のみ (ブラウザ不要) になったため、
# ベースは軽量な Node 公式 slim イメージ。Chromium も OS依存ライブラリも要らないので
# イメージは大幅に小さく、別PCへの移設も「node があれば動く」状態を保てる。
FROM node:22-bookworm-slim

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる (依存は node-html-parser のみ)。
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
