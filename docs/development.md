# 実装とローカル検証

[開発版の案内](../README.md) · コマンドの実行場所は `hermes-ai-hub/` です。

## 実装した経路

- **AI Hub** が依頼・社員・対象案件を対応づけ、SQLiteで受付を冪等化します。各案件には異なる日付の契約台帳と議事録を用意しました。資料の選択と依頼の取得・回答時に、サーバー側の社員IDを使います。
- **Hermes** は社員ごとの実コンテナで動きます。AI Hubが `POST /v1/runs` で照合を依頼し、質問を保存します。担当者の回答後、同じ社員のコンテナでメモ作成を別のrunとして開始します。質問・回答の永続化と状態遷移はAI Hubが担当します。
- **共有手順** は「更新商談の準備」v2です。メモでは資料の各文に出典を付け、社員の判断を別欄に記録します。各コンテナに手順を読み取り専用で配置し、依頼の受付時に記録したハッシュから公開版の本文を取得して Runs API に渡します。v1 で受付済みの依頼は、社員の回答後も v1 で完了します。
- **モデル接続先** は合成応答サービス A・B と、任意で有効化できる Mac のローカル推論サービスです。社員の依頼はいずれも同じ Hermes Runs API と Hub の利用記録を通ります。
- **再起動と照合** では、受け付けた仕事、回答、成果物、段階別のHermes実行IDを保存します。送信結果や実行の所在が不明なら「結果を確認中」と表示し、その社員の後続依頼を待機させます。

管理操作権限を持つ担当者は「管理画面 → Hermes 実行照合」で社員・依頼ID・実行段階を確認し、次の操作を行えます。

- **実行結果を照合**。実行IDが残っている場合に、本人用のHermesからその結果を読み取ります。[保存済み実行IDの検証記録](../evidence/hermes-run-recovery.md)
- **受付記録を照合**。Hubが受付応答を受け取れず実行IDが空の場合に、本人用のHermesで依頼・段階の冪等キーとセッションの受付記録を読み取り専用で照合します。両方が同じ送信試行の実行を一意に示し、Runs APIでもその実行とセッションを確認できた場合だけ、元の仕事に実行IDを保存します。候補なし・複数・記録不一致・期限切れ・読み取り失敗の場合は保留が続きます。照合から新しい実行を送信することはありません。[受付応答が途切れた場合の検証記録](../evidence/hermes-receipt-recovery.md)
- **この週報を開始**。受付記録を照合しても実行を特定できなかった会議メモには、同じ社員が後から依頼した未送信の週報が表示されます。受付時刻と依頼IDで週報を選ぶと、その初稿の作成だけが始まります。他の実行中・結果不明の仕事がある間は待機します。会議メモは保留のまま引き続き照合できます。Hubは開始を指示した管理者・時刻・会議メモ・週報・根拠となった照合履歴を記録します。[個別開始と再起動の画面検証](../evidence/weekly-start.md)

個別に開始した週報の初稿が完了すると、Hubは保留中の元の会議メモの受付記録を自動で照合します。上限は会議メモごとに3回で、2回目は初回の30秒後、3回目は2回目の60秒後から照合できます。回数と次回時刻をSQLiteに保存するため、再起動や別の週報の完了でも回数はリセットされません。特定できないまま上限に達すると、管理画面にその旨が表示され、「受付記録を照合」で手動確認を続けられます。[再起動後の自動復旧と上限到達の検証](../evidence/auto-receipt.md)

この会議メモの調査を打ち切る場合、管理者は社員に伝える理由を入力して「結果未確認で対応終了」を選びます。元の仕事に終了理由と依頼時の資料が残り、待機中の次の依頼が通常の順序で進みます。Hubは会議メモごとに1件の終了記録に理由・操作者・時刻を保存します。終了後に受付記録が見つかっても、以前の照合応答やHubの再起動で会議メモが再開することはありません。[対応終了と後続依頼の画面検証](../evidence/meeting-closure.md)

管理者と閲覧専用管理者は「管理操作の監査ログ → 対応終了した会議メモを検索」で依頼IDを入力すると、自動照合の各日時・結果と、終了した担当者・日時・理由を同じ画面で確認できます。日時は日本時間です。検索機能の導入前に終了した会議メモも、保存済みの記録から読み取れます。照合中断などで結果が保存されていない回は、記録がない件数を表示します。[両権限での監査検索の検証](../evidence/meeting-closure-audit.md)

完了済みの成果物は通常の出典チェックを通して元の仕事に表示し、実行中なら同じIDの進捗確認を再開します。照合履歴には操作者・時刻・結果が残り、自動照合の操作者は `system:auto-receipt` です。受付記録の読み取りはこのプロジェクトで固定したHermesの保存形式に対応しています。既存のローカル環境への反映には、[開発版の起動手順](../README.md#起動と操作)を実行して社員別のCompose設定を再生成してください。

AI Hubのブラウザ入口だけをループバックに公開し、Hermesの保存領域・APIキー・内部ネットワークを社員別に用意しています。合成モデルには専用の内部ネットワークから、Mac の推論サービスには Hub から Colima のホスト接続を使ってアクセスします。合成資料と固定IDでの検証用です。

## 検証

リポジトリのルートで実行します。Node.js とブラウザのテストに使う依存関係は `npm ci` で用意します。

```sh
npm test
python3 -B -m unittest discover -s test/python
```

`npm test` は [`test/node/`](../test/node/) のテストを実行し、一時SQLiteなどを使って受付の重複、所有者制限、実行と回答、結果不明時の扱いを検証します。Python のテストは Hermes の受付記録の読み取りと業務ツールを検証します。

### ブラウザで個別に実行する

Chrome をインストールして、確認したい操作のスクリプトを実行します。接続先のポートや専用の Compose プロジェクトは、スクリプトと各操作ガイドで確認してください。

| 対象 | 実行例 | 前提 |
| --- | --- | --- |
| [社員・モックとの比較](../test/browser/shared/mock-navigation-browser.mjs) | `node test/browser/shared/mock-navigation-browser.mjs` | 通常のローカル開発版と管理者アカウントの初期設定 |
| [管理者](../test/browser/admin/) | `node test/browser/admin/admin-directory-audit-browser.mjs` | テストが一時ディレクトリに専用サーバーを起動 |
| [受付](../test/browser/inquiries/) | `node test/browser/inquiries/inquiry-browser.mjs` | 専用の比較環境。詳しくは[社員画面の操作](employee-guide.md)を参照 |
| [アカウント切り替え](../test/browser/shared/) | `node test/browser/shared/session-browser.mjs` | 通常のローカル開発版 |

[社員の業務操作ごとのスクリプト](../test/browser/employee/) は [社員画面の操作](employee-guide.md) を参照してください。Playwright は既定で開発依存の `@playwright/test` を使用します。別のインストールを使う場合は `PLAYWRIGHT_PACKAGE` にパッケージ名または絶対パスを指定できます。

### Compose・モデル・Cloudflare の結合試験

`node test/integration/compose/live.mjs` は起動済みのローカル合成環境で社員ごとに1件の依頼を作り、回答・成果物、別社員からの拒否、公開版ハッシュの一致を確かめます。実行後の合成依頼は画面に残ります。

専用プロジェクトで使う Compose の追加設定は [`test/integration/compose/`](../test/integration/compose/) にあります。`compose.yaml` を最初の `-f` に指定すると、追加設定のファイルマウントもリポジトリのルートを基準に解決されます。実モデルとの比較スクリプトは [`test/integration/models/`](../test/integration/models/) にあります。

Cloudflare のローカル検証については [Hermesの受付・結果の復旧](../test/integration/cloudflare-recovery/README.md) と [資料到着時の実行](../test/integration/cloudflare-arrival/README.md) の手順を参照してください。Wrangler は `npm ci` で導入されます。

## 実装の入口と次の工程

| ファイル | 担当 |
|---|---|
| [server.mjs](../server.mjs) | ローカルサーバーの起動入口 |
| [src/http/server.mjs](../src/http/server.mjs) | 社員別のHTTPサーバー、画面・仕事API |
| [src/jobs/hub.mjs](../src/jobs/hub.mjs) | 依頼・試行の永続化と認可、Hermes Runs API、復旧時の状態遷移 |
| [src/fixtures.mjs](../src/fixtures.mjs) | 合成社員と、日付が食い違う二案件の版付き資料 |
| [公開手順](../skills/renewal-brief/SKILL.md) | 両社員の実行に固定する手順本文 |
| [compose.yaml](../compose.yaml) | 固定digestのイメージ、個人別のHermesと専用ボリューム、閉域モデル |
| [public](../public) | 社員の三画面、質問への回答、出典とメモの表示 |

工程5では、個人の草案から部門向けに公開し、別社員が自分の案件で実行できます。公開手順の改訂と公開取消は管理画面から操作できます。組織IdPと実CRMの接続、実案件での業務受入は後続です。

Hermesの仕様参照先は[公式Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)と[公式Docker構成](https://hermes-agent.nousresearch.com/docs/user-guide/docker)です。


ローカル合成環境で `node test/browser/admin/admin-browser.mjs` を実行すると、現在の合成標準モデルからもう一方に切り替え、公開前の依頼1件と公開後の依頼2件を完了します。公開後の設定と検証用依頼はローカル環境に残ります。

## 工程4　Mac の実モデルと合成モデルの比較

[改善前の工程4の結果](../evidence/stage4-a-renewal.md) と [手順 v2 での再検証](../evidence/stage4-a-renewal-v2.md) に、各3回の応答時間・出典・手直し箇所を記録しました。保存済みの v2 結果は `node test/integration/models/check-renewal-comparison.mjs` で照合できます。新しい比較結果を照合するときは、同じコマンドの引数に生成された JSON ファイルのパスを渡します。

この Mac の MTPLX はループバックの 8001 番で `qwen3.8-flash-next` を提供します。Colima 内の Hub は `http://host.lima.internal:8001/v1` に接続します。通常環境では `.runtime/local.env` に `LOCAL_MLX_ENABLED=1` を設定し、起動コマンドで Hub を再作成します。管理画面の「Mac ローカル推論（MLX）」でモデルを登録し、接続テストを実行します。全社員への公開は別途操作します。

下記の比較環境は専用の SQLite・Hermes ボリュームを使います。A社の同じ依頼・回答を各モデルで3回処理し、質問・メモ・段階別待ち時間・提供元が返したモデルIDを `.runtime/compare-*.json` に保存します。

```sh
docker --context colima-mac-studio-solo compose -p ai-hub-hermes-compare --env-file .runtime/local.env -f compose.yaml -f .runtime/admin-workspaces.json -f infra/compose.compare.yaml up -d --wait
node test/integration/models/compare-local.mjs
docker --context colima-mac-studio-solo compose -p ai-hub-hermes-compare --env-file .runtime/local.env -f compose.yaml -f .runtime/admin-workspaces.json -f infra/compose.compare.yaml stop
```


## 業種パッケージを追加する

[業種パッケージ定義](../src/procedures/industry-packages.json) に業種の `id`、表示名 `name`、整数版 `version`、手順配列 `procedures` を追加します。各手順には既存例と同じ形式で `id`、手順名、利用する資料、依頼例、成果物、本文を指定します。これらの手順は既存の文章作成ツールを使います。業種 ID と各業種内の手順 ID には一意の英小文字・数字のスラッグ（語の区切りは単一のハイフン）を使います。ID は公開後も固定し、内容を更新する際はパッケージ版を上げます。定義の配布だけでは社員画面に追加されません。既に導入した手順の本文は管理画面で改訂します。
