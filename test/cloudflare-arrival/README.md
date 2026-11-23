# 資料が揃ったら一度だけ実行するローカル結合試験

受付用Workerが、元の相談ID・本人・依頼文・添付済み資料ID・待っている資料ID・期限をローカルD1に保存する。到着イベントが持つのは資料IDのみ。利用中の本人であることを既存Hubで確認し、比較に使う2件の原文はD1の閲覧権限を確認して取得する。到着時の判定、実行権の取得、原文の読取は同じD1バッチにまとめている。期限超過と本人の受信箱への通知追加も同じトランザクションで行う。

実行権を得たWorkerは、相談IDを冪等キーにして既存の社員別Hubへ見積比較を依頼する。以降は既存のHub、実行中継Worker、社員別Durable ObjectとHermesコンテナを通る。相談IDとHubの仕事IDの対応をD1に保存し、待機前と同じ相談APIで結果と出典を取得する。受付応答が途切れた場合は保留し、`POST /consultations/:id/reconcile` が同じ社員のHubにGETで受付を照会する。照合は別途資料権限を再検査し、新しい仕事を作らない。ここでは社員の資料置き場・権限と受信箱を検証専用D1で表現し、資料の投入と到着イベントはテストドライバが代行する。

## 再実行

1. [既存の検証環境](../cloudflare-recovery/README.md)の手順で、新しい専用ディレクトリにHub・モデル・実行中継Workerを起動する。先行の検証ジョブは実行せず、新規のD1とHubを使う。
2. そのディレクトリの下に `arrival/` を作り、ここにある `worker.mjs`、`wrangler.jsonc`、`schema.sql` をコピーする。検証ディレクトリの `.dev.vars` を `arrival/.dev.vars` にもコピーする。既存の検証と同じNode.jsとWranglerを使い、`WRANGLER` にWrangler実行ファイルの絶対パスを設定する。
3. `arrival/` で次を実行する。

   ```sh
   "$WRANGLER" d1 execute arrival-db --local --file schema.sql
   "$WRANGLER" dev --local --ip 127.0.0.1 --port 19475 --inspector-port 0 --show-interactive-dev-session=false --types=false
   ```

4. 別の端末を開き、開発版リポジトリのルートで `driver="$PWD/test/cloudflare-arrival/verify.py"` を設定する。検証ディレクトリに移り、`python3 "$driver"` を実行する。600秒の無操作停止はDockerだけをポーリングして待つ。権限失効、未着、重複到着を含めた検証記録は `results/` に保存する。
5. 終了時は両方のWranglerを終了し、専用Composeを既存の検証環境の手順で停止する。

通知の配信先はローカルの社員別受信箱。実サービスからのWebhook配送、Teams・メール配信、商用モデル、Cloudflare実環境での挙動は別途検証する。

`node test/cloudflare-arrival/reconciliation.mjs` は、ローカルのWorker・D1と検証用Hub応答で、期限との競合・利用停止・実行権取得後と受付後の応答断・Worker再起動・重複配達・本人照会を検証する。実環境の接続は使わない。
