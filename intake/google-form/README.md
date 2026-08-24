# Googleフォーム取込（運用者用）

CSVの譜面差分を保留し、異なるGoogleアカウント2件以上で一致した差分だけを自動PRにします。

## 設定

1. 確認済みメールアドレスを収集するGoogleフォームに、ファイルアップロード項目 `CSVファイル` と回答Sheetを作る。
2. 回答SheetのApps Scriptへ `Code.gs`、`Validation.gs`、`appsscript.json` を登録する。
3. リポジトリ限定のGitHub Appに `Contents: Read and write` と `Pull requests: Read and write` を設定する。
4. Script Propertiesへ `GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY` を登録する。
5. 回答Sheetの **maimai更新 → 初期設定・トリガー作成** を実行する。

任意設定は `OWNER_EMAIL`、`CONSENSUS_QUORUM`、`MAX_SUBMISSIONS_PER_HOUR` です。
