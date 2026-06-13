---
description: Dockerを停止→リビルド→起動して再デプロイする (public/lib/server.js の変更反映用)
allowed-tools: Bash(docker compose down:*), Bash(docker compose up:*), Bash(docker compose ps:*), Bash(docker compose logs:*)
---

プロジェクトの Docker コンテナを再デプロイしてください。`public/` や `lib/`、`server.js` の変更は
イメージに焼き込まれているため、リビルドしないと反映されません。以下を順に実行します。

1. `docker compose down` — 現在のコンテナを停止・削除する
   (`./data` はバインドマウントなので設定・履歴は消えません)
2. `docker compose up -d --build` — イメージをリビルドしてバックグラウンド起動する
3. `docker compose ps` — コンテナが Up になったか確認する

最後に、起動できたかどうかを一行で報告してください。`up` でビルドや起動が失敗した場合は、
`docker compose logs --tail=40` の出力を添えてエラー内容を伝えてください。成功したら
「ブラウザを Ctrl+Shift+R で再読込してください」と添えてください。
