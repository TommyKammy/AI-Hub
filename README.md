# AI Hub · Hermes採用版

社員が本人用のHermesに自然文で相談するローカル開発版です。「ホーム」で依頼を始め、「依頼一覧」で会話・出典・採用版を開きます。「手順を探す」では会社標準・チーム共有・自分が作成した手順を、「業務スペース」では社内資料・案件・記憶・承認を扱います。

## 開発の入口

| 目的 | 開く場所 |
| --- | --- |
| 開発版をブラウザで確認する | [社員ホーム](http://127.0.0.1:18731/) · [アカウント選択](http://127.0.0.1:18731/login) · [管理者画面](http://127.0.0.1:18733/admin.html) |
| 画面を変更する | [操作モック](ai-hub-home-mockup.html) · [配信中の画面のソース](public/) · [モックとの比較テスト](test/mock-navigation-browser.mjs) |
| API・永続化・Hermesの実行を変更する | [実装とローカル検証](docs/development.md) · [HTTP入口](server.mjs) · [依頼の保存と実行](hub.mjs) |
| 操作や権限を確認する | [社員画面の操作](docs/employee-guide.md) · [管理者の運用](docs/admin-guide.md) |
| 配置案の背景を確認する | [Opus独立レビュー](docs/reviews/Claude-Opus-review-report.md) · [当時のレビュー依頼](docs/reviews/Claude-Opus-review-request.md) |

このMacの[ワークスペース案内](../README.md)から、[アーカイブした初期設計・S01試作](../archive/Planning_Pack_v0.1.2/README.md)を参照できます。

## 起動と操作

Node.js 24以上とDocker Compose v2.33.1以降が必要です。このリポジトリのルートで実行します。このMacで検証したDocker contextは `colima-mac-studio-solo` です。別のホストでは稼働しているcontextを指定してください。

```sh
node infra/init.mjs
docker --context colima-mac-studio-solo compose --env-file .runtime/local.env up -d --wait
```

1. [佐藤のワークスペース](http://127.0.0.1:18731) で「A社の更新商談を準備して」と依頼します。
2. Hermesから質問が届いたら契約台帳と議事録を開き、「日付は未確定として先方に確認する」と回答します。完了するとメモと出典を開けます。
3. [田中のワークスペース](http://127.0.0.1:18732) で「手順を探す」から同じ公開版を選び、B社の案件で試せます。二人の画面はローカル開発用の固定IDに対応し、PCの利用者は両方を開けます。

停止と再起動には次のコマンドを使います。SQLiteとHermesのデータはプロジェクト専用の名前付きボリュームに保存します。キーは初回だけ生成し、ホスト側の `.runtime/local.env` に保存します。

```sh
docker --context colima-mac-studio-solo compose --env-file .runtime/local.env stop
docker --context colima-mac-studio-solo compose --env-file .runtime/local.env up -d --wait
```

[最新モックアップとの差異と、開発版の画面・操作の検証記録](evidence/2026-11-23-design-parity/README.md)

## 変更を検証する

Node.js のテストは `npm test` で実行します。画面を変更した場合は、起動中の開発版で該当するブラウザテストも実行します。このワークスペースでアカウント切り替えを確認する例です。

```sh
npm ci
node test/session-browser.mjs
```

Wrangler と Playwright はこのリポジトリの開発依存です。`npm ci` でロックファイルの版を導入し、`./node_modules/.bin/wrangler --version` で確認できます。ブラウザテストにはホストにインストールした Chrome を使用します。

Cloudflare のローカル検証は [test](test/) 配下の `cloudflare-*` から選びます。検証結果は `evidence/`、認証情報とローカル起動設定は `.runtime/` にあります。
