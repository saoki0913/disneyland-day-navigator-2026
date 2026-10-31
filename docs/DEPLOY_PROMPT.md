# GPT（Cloudflare操作担当）に送るプロンプト

以下をそのままコピーして送ってください。

---

あなたは私のCloudflareアカウントで作業するデプロイ担当です。以下のWebアプリを **新規のCloudflare Pagesプロジェクト** として公開し、実際にスマホで使える状態になったことを確認してください。今日（2026年10月31日）、カリフォルニアのディズニーランドで使います。開園は現地8:00なので、それまでに完了させたいです。

## 対象
- リポジトリ：https://github.com/saoki0913/disneyland-day-navigator-2026
- ブランチ：`claude/vibrant-dijkstra-lbpi65`
- 構成：Cloudflare Pages（静的ファイル `public/` ＋ Pages Functions `functions/api/*`）。外部の有料サービス・DB・KVは不要。
- 詳細は README.md を参照。

## 絶対に守ること（安全条件）
このアカウントには本番サービスが稼働しています。以下は **変更・再デプロイ・削除・設定変更をしない** でください。
- Worker：`mogup-api`、`career-compass-web-production`、`career-compass-web-staging`
- Worker：`usa-trip-disney-day-1031`（今回は触らない。新しいPagesプロジェクトを作る）
- DNS、カスタムドメイン、ルート、アカウント共通の workers.dev サブドメイン（`mogup-backend`）
- 既存の環境変数・シークレット・課金設定

作業前と作業後に、ダッシュボードまたはCloudflare APIで **上記4つのWorkerの最終更新日時（modified_on）** を記録し（読み取りのみ）、変わっていないことを報告してください（作業前の値：mogup-api 2026-09-25T17:39:21Z / career-compass-web-production 2026-10-30T15:21:15Z / career-compass-web-staging 2026-10-30T15:10:51Z / usa-trip-disney-day-1031 2026-10-31T07:38:10Z）。
新たな費用が発生する操作や、上記に影響しうる操作が必要になったら、実行せずに私に確認してください。
APIトークンを使う場合、権限は「Account › Cloudflare Pages › Edit」だけで足ります。トークンをリポジトリやログに残さないでください。

## 手順
1. 取得とテスト（Node.js 20以上）
   ```bash
   git clone -b claude/vibrant-dijkstra-lbpi65 https://github.com/saoki0913/disneyland-day-navigator-2026.git
   cd disneyland-day-navigator-2026
   npm ci
   npm test            # 60件すべて pass であること
   npx wrangler whoami # 正しいアカウントか確認
   ```
2. Pagesプロジェクト作成（初回のみ）
   ```bash
   npx wrangler pages project list
   npx wrangler pages project create dl-navi-1031 --production-branch main
   ```
   名前が使えない場合は別名（例：`dl-navi-1031-park`）で作成し、`wrangler.toml` の `name` と `package.json` の `--project-name` を同じ名前に揃えてください。
3. プレビューにデプロイして確認
   ```bash
   npm run deploy:preview
   ```
   表示されたプレビューURLで、下の「確認項目」A〜Cを実施。
4. 問題なければ本番にデプロイ
   ```bash
   npm run deploy
   ```
   本番URL（`https://<プロジェクト名>.pages.dev`）で確認項目A〜Dをもう一度実施。

## 確認項目
### A. APIが本物のデータを返すか
- `GET /api/health` → `{"ok":true,...}`
- `GET /api/live` → `"ok":true` かつ `"source":"themeparks.wiki"`（失敗時は `queue-times.com`）。`attractions` に20件前後（rise, falcon, indy, space, haunted …）。開園前は status が `CLOSED`、wait が null でも正常。開園後（8:00以降）は `OPERATING` と待ち時間の数値が入ること。
  - `shows` に `fantasmic` / `fireworks` / `cavalcade` の当日時刻が入っているか報告（入っていなければ「入っていない」と報告。アプリは事前情報を「要確認」として表示します）。
  - 2回続けて叩くと2回目は `"cache":"HIT"` になること（60秒キャッシュ）。
- `GET /api/meta` → `coords` に施設の座標が15件以上、`schedule.operating` に 10/31 の open/close（分単位。480=8:00, 1380=23:00）。実際の営業時間を報告。
- `GET /api/photos?set=rides`、`?set=food`、`?set=shows` → `ok:true`。

### B. 写真が「本物で正しい」か（重要）
`/api/photos` の3セットの各 `src` を実際に開いて目で確認し、表にしてください：
| id | 写っているもの | 正しい？ | 備考 |
- 正しい＝**カリフォルニアのディズニーランド（Anaheim）** の該当アトラクション／店舗／ショー（または料理）の写真。
- フロリダ・東京・パリ等の別パーク、無関係な写真、ロゴ、暗すぎる/小さすぎる写真は ✗。
- ✗ や欠けているものは、Wikimedia Commons（https://commons.wikimedia.org ）で正しい写真を探し、`lib/server.js` の `PHOTO_OVERRIDES` に追記してください：
  ```js
  export const PHOTO_OVERRIDES = {
    rise: { src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/…/800px-….jpg', page: 'https://commons.wikimedia.org/wiki/File:….jpg', author: '撮影者名', license: 'CC BY-SA 4.0' },
  };
  ```
  `src` は幅800px前後のサムネイルURL。追記したら同ファイルの `PHOTO_CACHE_VERSION` を1増やし、`npm test` → 再デプロイ。
- Disney公式サイトやブログの画像は著作権の都合で使わず、Commons（自由ライセンス）だけを使ってください。

### C. スマホでの動作（iPhoneサイズ、可能なら実機のSafari）
- 下のタブ（いま／プラン／マップ／探す／ショー）がすべて開く。横スクロールが出ない。
- 「いま」に「次は○○へ！」カードと、画面下の大きな「✓ ○○ 乗った！」ボタンが出る。
- 「乗った！」→ 完了になり、プランタブの「✅ 完了したこと」に残る。それをタップすると確認が出て、未完了に戻せる。リロード後も記録が残る。
- 右上の「LIVE」ピルを押すと待ち時間が更新される（成功の通知が出る）。
- マップに地図（OpenStreetMap）とピンが表示される。「📍 現在地を使う」で位置情報の許可ダイアログが出る。
- 探す → 施設をタップで写真・説明・待ち時間グラフが出る。
- 自動テストも実施してよい（APIはモック、UIの確認用）：
  ```bash
  node tests/e2e.mjs https://<プレビューまたは本番URL>
  ```
  29/29 pass であること。

### D. 安全確認
- 上記4つの既存Workerの最終更新日時が作業前と同じであること。
- 新規に作ったのは Pages プロジェクト1つだけであること。
- 追加費用が発生していないこと（Pages無料枠・Workers無料枠内）。

## 報告してほしいこと
1. 本番URL（とプレビューURL）
2. 確認項目A〜Dの結果（失敗があればエラー内容そのまま）
3. 写真チェック表と、差し替えた写真の一覧
4. `/api/live` の当日ショー時刻、`/api/meta` の営業時間
5. コードを変更した場合は、その差分を同じブランチ `claude/vibrant-dijkstra-lbpi65` に commit & push（コミットメッセージに変更内容を書く）
6. 既存サービスに変更がないことの確認結果

## 困ったとき
- `wrangler pages deploy` で functions のビルドエラー → `npx wrangler pages functions build --outdir /tmp/fb` でエラー内容を確認して報告。
- `/api/live` が 502 → レスポンスの `errors` をそのまま報告（ThemeParks.wiki 側の障害の可能性。アプリ自体は推定値で動きます）。
- `/api/photos` で一部が欠ける → Bの手順で `PHOTO_OVERRIDES` に追加。
- 上記以外で既存サービスに触れる必要が出たら、作業を止めて私に確認。
