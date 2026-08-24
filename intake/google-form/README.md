# Googleフォーム取込（運用者用）

CSVの譜面差分を保留し、異なるGoogleアカウント2件以上で一致した差分だけを自動PRにします。

## 設定

1. 確認済みメールアドレスを収集するGoogleフォームに、ファイルアップロード項目 `CSVファイル` と回答Sheetを作る。
2. 回答SheetのApps Scriptへ `Code.gs`、`Validation.gs`、`appsscript.json` を登録する。
3. リポジトリ限定のGitHub Appに `Contents: Read and write` と `Pull requests: Read and write` を設定する。
4. Script Propertiesへ `GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY` を登録する。
5. 回答Sheetの **maimai更新 → 初期設定・トリガー作成** を実行する。

任意設定は `OWNER_EMAIL`、`CONSENSUS_QUORUM`、`MAX_SUBMISSIONS_PER_HOUR` です。

## BAN

悪意ある提出の回答行を選択し、**maimai更新 → 選択行の送信者をBAN** を実行します。以後の提出は処理せず、未確定キューに残る同アカウントの確認票も除外します。解除は **maimai更新 → BANを解除** から行います。

BAN対象はメールアドレスそのものではなく、Script Propertiesへ秘密値付きハッシュで保存します。Googleフォーム上では通常どおり送信完了になります。

送信者の信頼点は初期値 `0`、上限 `1` です。形式検証または差分検証に失敗した提出で `-1`、両方に合格した提出で `+1` とし、`-3` に到達した時点で自動BANします。信頼点も秘密値付きハッシュをキーに保存し、BAN解除時は `0` に戻します。
