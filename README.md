# アマギフスロット

Next.js + Supabase + Stripe + LINE LIFF で動くアマギフスロットアプリ。

## 構成

```
lib/
  supabaseSlot.ts       Service Role Key を使うサーバー専用クライアント + 定数/型
  lineAuth.ts           LIFF IDトークン検証

pages/
  _app.tsx              グローバルCSS
  index.tsx             / → /slot へリダイレクト
  slot/index.tsx        スロット本体画面（LIFF初期化・UI）
  api/
    slot/
      user.ts           POST: LIFFトークン検証 + ユーザー登録 + 残高返却
      spin.ts           POST: スピン（通常 / 倍プッシュ）
      purchase.ts       POST: Stripe Checkout Session 作成
    stripe/
      slot-webhook.ts   POST: 決済完了 → add_coins

slot_schema.sql         Supabase に流すスキーマ
.env.example            環境変数テンプレ
```

## 初期セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. Supabase

1. Supabase プロジェクトを用意
2. Dashboard → SQL Editor に `slot_schema.sql` を貼って Run
3. Project Settings → API から以下を控える
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - service_role key → `SUPABASE_SERVICE_ROLE_KEY`

### 3. LINE

1. LINE Developers で LIFF アプリを作成
2. LIFF ID を `NEXT_PUBLIC_LIFF_ID` に
3. LINE Login チャネルID を `NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID` に
   （未設定時は LIFF_ID の先頭部分を使用）
4. Endpoint URL を本番URL + `/slot` に設定

### 4. Stripe

1. コインパックの Product / Price を3つ作成
   - 10コイン / ¥1,000
   - 50コイン / ¥5,000
   - 100コイン / ¥10,000
2. 各 Price ID を `.env` に設定
   - `STRIPE_PRICE_COIN_10`
   - `STRIPE_PRICE_COIN_50`
   - `STRIPE_PRICE_COIN_100`
3. Webhook エンドポイントを追加
   - URL: `https://<your-domain>/api/stripe/slot-webhook`
   - イベント: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`
   - Signing secret → `STRIPE_WEBHOOK_SECRET`

### 5. 環境変数

`.env.example` を `.env.local` にコピーして各値を埋める。

### 6. 起動

```bash
npm run dev            # http://localhost:3000/slot
npm run typecheck      # 型チェック
npm run build && npm start
```

## サービスタイム運用

`service_time_schedule` テーブルに `starts_at / ends_at` を入れるだけで
当選確率が 1/200 → 1/100 に切り替わる。

```sql
insert into service_time_schedule (starts_at, ends_at, note) values
  ('2026-04-21 12:00:00+09', '2026-04-21 12:30:00+09', '平日ランダム'),
  ('2026-04-21 18:00:00+09', '2026-04-21 18:30:00+09', '平日ランダム'),
  ('2026-04-21 21:00:00+09', '2026-04-21 21:30:00+09', '平日ランダム');
```

平日ランダムの自動投入や LINE プッシュ通知は別ジョブに切り出す前提
（Supabase Scheduled Function / Vercel Cron / GitHub Actions など）。

## 景品法ポイント

- 1スピン単価 × 20倍以内：全コースクリア済み
- 倍プッシュは「追加スピン」で単価×20倍以内の判定枠内：クリア
- 本番運用前に弁護士確認推奨

## アマギフ発送運用

- 当選すると `prize_deliveries` に `pending` で積まれる
- 管理画面（未実装）または Supabase Dashboard から手動で
  アマギフコードを採番 → `gift_code` + `status='sent'` + `sent_at` を更新
- LINE メッセージ API でユーザーに通知する別ジョブを用意する
- スケール後に Amazon Incentives API に移行

## 不正検知

`spin_results` と `coin_transactions` を突き合わせて以下を自動検知：

- `check_spam_spins(user_id, 10)` — 10秒で10スピン以上
- `check_abnormal_win_rate(user_id, 3600)` — 1時間内20スピン以上 かつ 当選率2.5%以上
- `check_balance_integrity(user_id)` — 残高と履歴の整合性

いずれも `suspicious_activity` テーブルにログが残る。

## TODO

- [ ] サービスタイム自動投入ジョブ
- [ ] LINE プッシュ通知
- [ ] 管理画面（発送管理・ユーザー検索・BAN）
- [ ] Amazon Incentives API 連携
- [ ] E2E テスト
