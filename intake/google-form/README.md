# GoogleフォームによるCSV自動取込

GitHubアカウントを持たない利用者からCSVを受け取り、譜面単位で別のGoogleアカウントによる再現を確認できた差分だけをPull Requestへ送る構成です。GoogleフォームのファイルアップロードはGoogleへのログインを要求します。

## 照合規則

公開中の `data.json` を正本として扱います。導入時の正本は `maimai-14plus-dxscore-rank1-20260824-2115.csv` です。

- CSV全体の完全一致は要求しません。
- 譜面キーは `難易度 | 譜面種別 | 曲名` です。
- 差分の一致判定には SCORE、DXスター、プレイヤー、DATE を使います。
- ファイル名の取得日時、ランキング更新日時、詳細URL、RATEは一致判定に使いません。RATEはSCOREと理論値から再計算します。
- 最初の差分は `pending` として非公開で保留します。
- 同じ差分を別の確認済みGoogleアカウントが送ると `confirmed` になります。同じアカウントの再提出は票を増やしません。
- 次の有効なCSVで元の値へ戻っていた差分、または別の値になった差分は取り下げ、新しい差分を保留します。
- 譜面の追加・削除・理論値変更は自動反映しません。その譜面の保留状態にも影響させず、警告だけを記録します。
- CSV内にSCORE減少、SCORE同一でDATE変更、SCORE増加なのにDATEが増えていない等のERRORが1件でもあれば、その提出全体でキューを変更しません。

たとえば、正本に対して次のCSVが届いた場合は以下のように進みます。

1. アカウント1から `A` → Aを保留
2. アカウント2から `A + B` → Aを確定、Bを保留
3. アカウント3から `B + C`（Aは確定値を維持）→ Bを確定、Cを保留

確定差分は正本へ合成したCSVとしてPR化します。PRが検証・マージ・GitHub Pagesへ反映されるまで次のPRは作らず、その間の後続差分はキューへ保持します。

## 1. Googleフォーム

1. 新しいGoogleフォームを作ります。
2. 設定でメールアドレスを**確認済み**として収集します。
3. ファイルアップロードの質問を1つ作り、質問名を `CSVファイル`、ファイル数を1件、上限を1 MB程度にします。
4. 必要なら自由記述の `備考` を追加します。自動処理には使いません。
5. 回答先として新しいGoogleスプレッドシートを作ります。

メールアドレスは回答Sheetと非公開の差分キューだけに保存し、CSV、PR本文、公開サイトへは書き出しません。フォームと回答Sheetを共同編集できる相手は保守者だけにします。

## 2. GitHub App

個人アクセストークンではなく、このリポジトリだけへインストールする非公開GitHub Appを使います。

1. GitHubの **Settings → Developer settings → GitHub Apps → New GitHub App** を開きます。
2. Webhookを無効にします。
3. Repository permissionsを次の最小権限にします。
   - Metadata: Read-only
   - Contents: Read and write
   - Pull requests: Read and write
4. Appを作成し、秘密鍵を1つ生成します。
5. **Install App** で `Only select repositories` を選び、`Men-cotton/maimai-14plus-rekidai` だけへインストールします。
6. App ID、Installation ID、秘密鍵を控えます。秘密鍵ファイルをリポジトリへ追加してはいけません。

AppはCSV用ブランチとPRを作り、保護ルールの自動検証に合格したPRへauto-mergeを予約します。`main` を直接更新しません。

## 3. Apps Script

1. 回答先Sheetから **拡張機能 → Apps Script** を開きます。
2. このディレクトリの `Code.gs` と `Validation.gs` を同名ファイルとしてコピーします。
3. `appsscript.json` の内容もマニフェストへ反映します。
4. **プロジェクトの設定 → スクリプト プロパティ** に次を登録します。

| 名前 | 必須 | 値 |
|---|---:|---|
| `GITHUB_APP_ID` | 必須 | GitHub App ID |
| `GITHUB_INSTALLATION_ID` | 必須 | リポジトリへのInstallation ID |
| `GITHUB_APP_PRIVATE_KEY` | 必須 | `-----BEGIN RSA PRIVATE KEY-----` から始まる秘密鍵全文 |
| `OWNER_EMAIL` | 任意 | 自動処理失敗とPR作成の通知先 |
| `CONSENSUS_QUORUM` | 任意 | 必要な異なるGoogleアカウント数。既定値 `2`、最小 `2` |
| `MAX_SUBMISSIONS_PER_HOUR` | 任意 | 1アカウント当たりの毎時上限。既定値 `5` |
| `CANONICAL_DATA_URL` | 任意 | 正本JSON。通常は変更不要 |
| `TIMESTAMP_COLUMN_HEADER` | 任意 | 既定値 `タイムスタンプ` |
| `EMAIL_COLUMN_HEADER` | 任意 | 既定値 `メールアドレス` |
| `CSV_COLUMN_HEADER` | 任意 | 既定値 `CSVファイル` |

5. 回答Sheetを再読み込みし、**maimai更新 → 初期設定・トリガー作成** を1回実行して権限を許可します。
6. 非公開の `差分キュー` Sheet、フォーム送信トリガー、5分ごとの再試行トリガーが作られたことを確認します。

## 障害時

- GitHub APIやPages取得の一時エラー: 確定差分を保持し、5分ごとのトリガーで再試行します。
- PRが未マージのまま閉じた: そのPRを失敗扱いにし、先行値へ依存し得る未公開差分を取り下げます。次のCSVから正本基準で再照合します。
- PRがマージ済みでPagesが未反映: 次のPRを作らず待機します。
- 譜面追加・削除、理論値・定数・初出バージョン変更: 従来どおり保守者がリポジトリで手動更新します。

## セキュリティ上の限界

確認済みGoogleアカウントは無記名投稿や単純なbotを抑止しますが、1人が複数アカウントを管理する可能性までは排除できません。自動反映は単調なSCORE更新と既存譜面に限定し、GitHub側でも信頼済みCIを必須にすることで影響範囲を狭めています。

参考:

- [Googleフォームでのファイルアップロード](https://support.google.com/docs/answer/15473134?hl=ja)
- [GitHub Appとしての認証](https://docs.github.com/ja/apps/creating-github-apps/authenticating-with-a-github-app)
