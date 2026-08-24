# maimai 14+ でらっくスコア歴代表

maimai DX NETから取得した難易度14+の歴代表を、検証済みCSVから生成する静的サイトです。

- 公開先: <https://men-cotton.github.io/maimai-14plus-rekidai/>
- 現行データ: 86譜面（MASTER 76 / Re:MASTER 10）
- 実行時サービス・データベース・Cookie・秘密情報: なし

## 更新方法

一般利用者は配布済みの取得スクリプトでCSVを生成し、Googleへのログインが必要なGoogleフォームへアップロードします。GitHubアカウントは不要です。

最初のCSVに現れたランキング差分は公開せず、譜面単位で保留します。別の確認済みGoogleアカウントから届いた次のCSVにも同じ差分があれば、その差分だけを確定します。新たな別差分は同時に保留できるため、CSV全体の完全一致は不要です。確定差分はApps Scriptが正本へ合成し、GitHub AppでPull Requestを作成します。`Repository tests` と `Trusted CSV validation` の成功後に自動マージされ、GitHub Pagesが更新されます。

導入時の正本は2026-08-24 21:15取得版です。Googleフォーム受付の実装と設定手順は [`intake/google-form/`](intake/google-form/) にあります。

CSVファイル名は `maimai-14plus-dxscore-rank1-YYYYMMDD-HHMM.csv` のまま変更しません。確定差分から生成した各CSVは監査履歴として残り、初期値から日時順に再生されます。Apps Scriptは `main` へ直接書き込まず、保護されたPR経由でのみ更新します。

## 検証規則

ERRORが1件でもあればPRは失敗し、サイトは更新されません。

| 条件 | 結果 |
|---|---|
| SCORE増加、かつDATEが前回より後 | 更新 |
| SCORE同一、DATE同一 | 更新（ランキング確認日時など） |
| SCORE同一、DATE変更 | ERROR |
| SCORE減少 | ERROR |
| SCORE増加、DATEが前回以前 | ERROR |
| 譜面の追加・削除 | WARN、旧譜面一覧を維持 |
| 理論値変更（譜面変更の可能性） | WARN、その譜面は旧値を維持 |
| プレイヤー名変更 | WARN、ほかの検証に通れば更新 |
| 定数・初出バージョンの不足 | WARN、CSVからは更新しない |

次の項目も毎回検証します。

- 必須列、列数、重複見出し、CSV構文、ファイル名と時系列
- 譜面キー（難易度・譜面種別・曲名）の一意性
- 難易度、種別、レベル、DXスターの許容値
- `0 ≤ SCORE ≤ 理論値`、理論値が3の倍数であること
- RATEを `SCORE ÷ 理論値` から再計算した値との一致
- DATE・ランキング更新日時の形式、実在日、前後関係
- 取得失敗行がないこと
- 詳細URLのHTTPS、ホスト、パス、許可パラメータ
- URLの `diff=3`（MASTER）/ `diff=4`（Re:MASTER）の対応
- 行数の急変、プレイヤー変更、メタデータ欠落
- 表計算式として実行され得る文字列、制御文字、HTML出力時のエスケープ

## 手動保守

譜面追加・削除・定数更新・初出バージョン更新は、通常のCSV PRでは反映されません。保守者が内容を確認した上で、次を行うコードPRで更新します。

- 定数・初出のみ: `metadata/` の対応JSONを編集
- 譜面構成の変更: `npm run baseline:roll` で検証済み履歴を `data/seed.json` に畳み込み、seedとmetadataを編集

`baseline:roll` はCIでは実行できません。履歴CSVは `data/archive/` へ移動し、削除しません。

## セキュリティ設計

- 通常のPRは `data/updates/` の新規CSV 1件だけを許可します。
- `pull_request_target` 側はデフォルトブランチの信頼済み検証コードだけを実行し、PRからは規定パスのCSV内容だけを読み込みます。
- PR用ワークフローは `contents: read` のみで、秘密情報を使用しません。
- 公開処理は `main` へのマージ後だけ実行し、GitHub Pages以外へ書き込みません。
- 外部Actionは完全なコミットSHAに固定しています。
- DependabotのAction更新PRも同じテストと保守者確認を通します。
- サイトはビルド済み静的HTML/JSONだけで、maimai DX NETのCookieを含みません。
- Google確認済みメールアドレスは非公開の回答Sheetと差分キューにだけ保存し、CSV・PR・公開サイトへ出力しません。
- 同一アカウントの再提出は差分の確認数を増やしません。提出回数にも上限を設けます。

## ローカル確認

Node.js 20以上で次を実行します。外部パッケージのインストールは不要です。

```console
npm run check
```

生成物は `dist/site/` に出力されます。

## データ出典

- ランキング: [maimai DX NET](https://maimaidx.jp/)
- 初出バージョン: [SaltMeta](https://github.com/realtvop/SaltMeta)
- 定数・配信順: [maimai　攻略wiki](https://gamerch.com/maimai/)
- 表の構成: [IIDX SP☆12歴代表](https://docs.google.com/spreadsheets/d/1badmnhvsFKU8C1LydrvaaCC-L3fETIZ3PRfPV_qFrUk/preview)

## ライセンス

コードはMIT Licenseです。ランキング・曲名その他の第三者データに対する権利は、それぞれの権利者に帰属します。
