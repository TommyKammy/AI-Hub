# Cloudflareローカル環境でのHermes受付・結果の復旧試験

社員別の実Hermesと既存のAI Hubを使い、受付応答が消えた会議メモをコンテナ停止後に復旧する。WranglerはローカルのWorkers、Durable Objects、Containers、D1を起動し、Composeは検証専用のHubと固定応答モデルを起動する。画面は普段の社員・管理者画面を使用する。

## 保持する記録

| タイミング | 社員別のD1に保存する内容 |
| --- | --- |
| Hermesへ送る前 | 依頼・段階と送信試行のID。同じ社員・依頼・段階の再送はHTTP 409で終える。 |
| Hermesで受付を確認した時 | 既存の読取専用照合処理が受付とセッションを一意に特定した実行IDと確認時刻。 |
| 終了を確認した時 | 同じセッション・実行IDの終了状態、本文、保存時刻。確定済みの本文は上書きしない。 |

社員別Durable Objectのアラームが、依頼元の接続から独立して受付と結果を照会する。照合と結果の読取ではHermesに作成リクエストを送らない。確定済みの本文はコンテナの停止中にも読める。Hubは社員の所属・権限と元資料の出典を従来の処理で確認して元の仕事に反映する。本文が未保存で実行を読み取れない場合は保留を維持する。

終了時には同じ社員の `USER.md`、`MEMORY.md` とHubで生成した見積用 `SKILL.md` を別途D1に記録する。プロフィールや手順が変わった場合だけスナップショットの版を進める。ファイルの削除も保存し、起動時に最新の記録を先に戻してからHermesの準備完了を待つ。完了本文の保管は本人状態と独立させる。本人状態の記録を確認できないまま停止した場合は、古い状態を戻さず起動を保留する。

## このホストで再実行する

前提はColimaの `colima-mac-studio-solo`、Docker Buildx、Node.js 24、Chrome、開発版で `npm ci` により導入したWranglerとPlaywright。Composeでは既存の `ai-hub-hermes-local-hub` イメージを使用する。Colimaからマウント可能なホーム配下に専用ディレクトリを作る。専用プロジェクト名 `cf-hermes-22-lab` とポート19431–19433、19441–19442、19474を使用する。

```sh
# 開発版リポジトリのルートで実行
project="$(pwd -P)"
fixture="$project/test/cloudflare-recovery"
lab_dir="$(mktemp -d "$HOME/.codex/cf-recovery-XXXXXXXX")/lab"
export PATH="$(brew --prefix node@24)/bin:$PATH"
export DOCKER_HOST="unix://$HOME/.colima/mac-studio-solo/docker.sock"
export WRANGLER_SEND_METRICS=false
wrangler="$project/node_modules/.bin/wrangler"
export LAB_ADMIN_FILE="$lab_dir/hub/.runtime/admin-accounts/aoki"
python3 "$fixture/prepare.py" "$lab_dir"
cd "$lab_dir"
docker buildx version
docker --context colima-mac-studio-solo compose --env-file hub/.runtime/local.env -f hub/lab.yaml up -d
"$wrangler" d1 execute probe-db --local --file schema.sql
```

Buildxを専用のDocker設定ディレクトリに置いている場合は、そのディレクトリを `DOCKER_CONFIG` に設定する。次のコマンドを別のターミナルで、同じ作業ディレクトリ・環境変数を使って起動する。

```sh
"$wrangler" dev --local --ip 127.0.0.1 --port 19474 --inspector-port 0 --show-interactive-dev-session=false --types=false
```

```sh
node "$fixture/verify.mjs" begin
node "$fixture/verify.mjs" unfinished
node "$fixture/verify.mjs" wait
```

`begin` は田中の受付応答を切断し、元のHermesの受付・セッション各1件、D1の完了結果、Hub再起動後の保留を確認する。`unfinished` は佐藤の推論を待機させ、受付確認後・完了前に佐藤の検証用コンテナを強制停止する。`wait` はDockerの状態を読み、田中の10分間の無操作停止を待つ。この後、Wranglerを終了し、同じディレクトリで同じコマンドで起動し直す。

```sh
node "$fixture/verify.mjs" finish
```

`finish` は社員・試行の照合、同時に2回送った重複リクエスト、管理者の再操作、元の仕事の本文と出典、待機していた週報の出典を検査する。`results/` にスクリーンショットと実行記録を保存する。終了時はWranglerを止め、検証用Composeを `docker --context colima-mac-studio-solo compose --env-file hub/.runtime/local.env -f hub/lab.yaml down -v` で終了する。

## 10分を超える実行を検証する

新しい検証ディレクトリで、準備コマンドに `--slow-model` を付ける。

```sh
python3 "$fixture/prepare.py" "$lab_dir" --slow-model
```

上と同じ手順でCompose・D1・Wranglerを起動し、`begin` の代わりに `long` を実行する。専用コンテナ内のテスト用中継が、田中の最初のローカルモデル応答の本文を615秒間保持する。HermesとHubには通常のモデル・実行APIを使用する。時計を進める操作は行わない。

```sh
node "$fixture/verify.mjs" long
node "$fixture/verify.mjs" wait
```

`long` は、受付応答を失った仕事について、処理中にHubを再起動し、10分経過後も同じコンテナ・実行ID・セッションで処理中であること、その時点でD1の完了本文が空であること、応答解放後に自動回収できたことを確認する。無操作タイマーには [Cloudflare ContainersのsetInactivityTimeout](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout) を使用する。照合用の記録は `results/long-*.json` に残る。確定後にもHubを再起動し、保留が維持されることを確認する。その後は `wait` で自然停止を確認し、Wranglerを再起動して `finish` を実行する。これで元の仕事の本文・出典、重複防止、後続週報まで検査できる。

## スナップショットと予約起動

固定応答モデルの新規ラボで、起動後に先行の検証ジョブを作らず `node "$fixture/live-personal.mjs"` を実行する。合成の個人状態を入れ、2件の仕事でD1の版を1→2にし、2件目の実行前に削除したファイルを記録する。以降はDockerの観測だけで10分の自然停止を待つ。停止中の結果取得がHermesを起こさず、次の予約枠だけが社員本人を起こすことを確認する。必要な時間は約11分。結果は `results/live-*.json`。このラボを使い回すと先行のD1記録があるため、新規の試験環境から実行する。

`python3 -B "$fixture/verify-personal-state.py"` は既存の実Hermesイメージからネットワーク無効のコンテナを4個順に起動し、スナップショット処理だけを確認する。

## 永続ボリューム方式とのローカル比較

実行中の通常Composeと別のポート・ボリュームを使う。新規の作業ディレクトリを用意し、`prepare.py` で永続ボリューム側を準備する。以下の `$direct` は `prepare.py` の出力先、`$fixture` はこのディレクトリ。既に指定サブネットを使っている場合は、検証専用ファイルをコピーして未使用のサブネットを指定する。

```sh
rtk proxy docker --context colima-mac-studio-solo compose -p aihub-wp08-direct \
  --env-file "$direct/hub/.runtime/local.env" -f "$direct/hub/compose.yaml" \
  -f "$fixture/benchmark.override.yaml" up -d --pull never
rtk proxy node "$fixture/benchmark.mjs" persistent-volume
rtk proxy node "$fixture/benchmark.mjs" containers
```

`containers` は上の予約起動試験が終了したWranglerラボの作業ディレクトリで実行する。各方式で同じ合成依頼をウォーム5回・停止後5回と同一社員への並行2件で測る。停止対象は検証用コンテナだけ。結果は標準出力のJSON。Docker Composeで用意した検証用ネットワークとコンテナを終了するときは、同じプロジェクト名と設定ファイルで `down` を実行する。

## 適用範囲

ローカルのarm64イメージと合成資料を使用する。既存のHubの業務DBはSQLiteで、今回追加した実行記録の保管先がD1。検証用Workerは受付が未確認の試行を送信後10分間照会する。受付を一意に確認した実行は、確認時刻から最長24時間、同じ実行IDを照会できる。Hermesが同じセッションで処理中と返した場合にコンテナの無操作タイマーを更新する。完了結果の読取期限は保存後24時間。24時間連続稼働、データの物理削除、Cloudflare実環境の性能・課金は未検証。
