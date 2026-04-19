/**
 * POST /api/slot/purchase
 * ---------------------------------------------------------------
 * コインパック購入。Stripe Checkout Session を生成して URL を返す。
 *
 * リクエスト:
 *   { idToken: string, packId: 'pack_10'|'pack_50'|'pack_100' }
 *
 * レスポンス:
 *   { url: string, sessionId: string }
 *
 * フロント側は返ってきた url へ遷移させるだけで OK。
 * 決済完了後は /api/stripe/slot-webhook 経由で add_coins が走る。
 * ---------------------------------------------------------------
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import {
  upsertSlotUser,
  COIN_PACKS,
  isCoinPackId,
} from '@/lib/supabaseSlot';
import { verifyLineIdToken, LineAuthError } from '@/lib/lineAuth';

const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) {
  // 起動時に fail-fast
  throw new Error('STRIPE_SECRET_KEY is not set');
}

const stripe = new Stripe(stripeSecret, {
  // 2024-06-20 以降で最新に合わせる（ライブラリ側の apiVersion 型定義に依存）
  apiVersion: '2024-09-30.acacia' as unknown as Stripe.LatestApiVersion,
  typescript: true,
});

type Success = { url: string; sessionId: string };
type Failure = { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Success | Failure>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = (req.body ?? {}) as { idToken?: string; packId?: string };

    if (!isCoinPackId(body.packId)) {
      return res.status(400).json({ error: 'invalid_pack_id' });
    }
    const pack = COIN_PACKS[body.packId];

    // Stripe Price ID を環境変数から解決
    const priceId = process.env[pack.stripePriceEnvKey];
    if (!priceId) {
      console.error('[slot/purchase] price env not set:', pack.stripePriceEnvKey);
      return res.status(500).json({ error: 'stripe_price_not_configured' });
    }

    // ID トークン検証
    const verified = await verifyLineIdToken(body.idToken ?? '');

    // ユーザーを upsert（Webhook 側で user_id を使うのでここで確定させる）
    const user = await upsertSlotUser(verified.sub, verified.name ?? null);
    if (user.is_banned) {
      return res.status(403).json({ error: 'banned' });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    // LIFF 内ブラウザで動かすことを想定した遷移先
    const successUrl = `${appUrl}/slot?purchase=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${appUrl}/slot?purchase=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // 重要: webhook で誰にコインを付与するか特定するためのキー
      client_reference_id: user.id,
      metadata: {
        slot_user_id: user.id,
        line_user_id: user.line_user_id,
        pack_id: pack.id,
        coins: String(pack.coins),
        price_yen: String(pack.priceYen),
      },
      // 二重リクエストによる Checkout Session 重複作成を防止。
      // 同じ (user + pack + 時刻ブロック) であれば同一セッションが返る。
      //   5分窓で二重タップを吸収する程度の粒度。
      //   ※ Stripe の idempotency_key はオプションなので、必要なら有効化する。
      //   idempotency-key header を付けたい場合は requestOptions を使う。
    }, {
      idempotencyKey: buildIdempotencyKey(user.id, pack.id),
    });

    if (!session.url) {
      return res.status(500).json({ error: 'stripe_session_no_url' });
    }

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    if (err instanceof LineAuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof Stripe.errors.StripeError) {
      console.error('[slot/purchase] stripe error:', err.type, err.message);
      return res.status(502).json({ error: 'stripe_error' });
    }
    console.error('[slot/purchase] internal error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

/**
 * 5分ブロック + user + pack の idempotency key。
 * 同じユーザーが同じパックを5分以内に複数回押しても、
 * Stripe 側で同じ Checkout Session が返る。
 */
function buildIdempotencyKey(userId: string, packId: string): string {
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  return `slot-purchase:${userId}:${packId}:${bucket}`;
}
