/**
 * POST /api/stripe/slot-webhook
 * ---------------------------------------------------------------
 * Stripe Checkout 決済完了を受けて add_coins(p_stripe_session_id=...) を実行。
 *
 * Stripe Dashboard で以下のイベントを購読：
 *   - checkout.session.completed
 *   - checkout.session.async_payment_succeeded   (銀行振込等の遅延決済対策)
 *
 * 重要:
 *   - 生リクエストボディで署名検証する必要があるため、bodyParser を無効化する
 *   - 二重付与は DB 側の unique index (coin_transactions.stripe_session_id) と
 *     add_coins() 内の重複チェックで二重に防止する
 * ---------------------------------------------------------------
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { buffer } from 'micro';
import { addCoins, COIN_PACKS, isCoinPackId } from '@/lib/supabaseSlot';

export const config = {
  api: {
    bodyParser: false, // 署名検証のため生のbodyが必要
  },
};

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!stripeSecret) throw new Error('STRIPE_SECRET_KEY is not set');
if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');

const stripe = new Stripe(stripeSecret, {
  apiVersion: '2024-09-30.acacia' as unknown as Stripe.LatestApiVersion,
  typescript: true,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('method_not_allowed');
  }

  let event: Stripe.Event;

  // --- 署名検証 --------------------------------------------------
  try {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).send('missing_signature');
    }
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, signature, webhookSecret!);
  } catch (err) {
    console.error('[slot-webhook] signature verification failed:', err);
    return res.status(400).send('invalid_signature');
  }

  // --- イベント処理 ---------------------------------------------
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }
      // 必要に応じて追加のイベントを処理
      // case 'charge.refunded': ...
      default:
        // 未購読イベントは 200 OK で握りつぶす
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[slot-webhook] handler error:', err);
    // Stripe は 2xx 以外だとリトライしてくれる。DB等の一時障害はここに落とす。
    return res.status(500).send('handler_error');
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // 支払完了していないセッションは無視（async は async_payment_succeeded で別途来る）
  if (session.payment_status !== 'paid') {
    return;
  }

  const slotUserId = session.client_reference_id
    ?? (session.metadata?.slot_user_id as string | undefined);

  const packIdRaw = session.metadata?.pack_id;
  const coinsStr  = session.metadata?.coins;

  if (!slotUserId || !packIdRaw) {
    console.error('[slot-webhook] missing metadata', {
      sessionId: session.id,
      slotUserId,
      packIdRaw,
    });
    return;
  }

  // metadata が改ざんされていても、pack 定義の正規テーブルから再計算する
  if (!isCoinPackId(packIdRaw)) {
    console.error('[slot-webhook] invalid pack id', packIdRaw);
    return;
  }
  const pack = COIN_PACKS[packIdRaw];

  // 念のため metadata のコイン数と照合（一致しなければ定義値を信頼）
  const metaCoins = Number(coinsStr);
  const coinsToGrant = Number.isFinite(metaCoins) && metaCoins === pack.coins
    ? metaCoins
    : pack.coins;

  const result = await addCoins({
    userId: slotUserId,
    amount: coinsToGrant,
    stripeSessionId: session.id,
    meta: {
      source: 'stripe_checkout',
      pack_id: pack.id,
      price_yen: pack.priceYen,
      amount_total: session.amount_total,
      currency: session.currency,
    },
  });

  if (result.duplicated) {
    console.info('[slot-webhook] duplicated event ignored', {
      sessionId: session.id,
      userId: slotUserId,
    });
    return;
  }
  if (!result.success) {
    // ユーザーが居ない等の理由。DBに残るログで調査する前提でログだけ出す。
    console.error('[slot-webhook] add_coins failed', {
      sessionId: session.id,
      userId: slotUserId,
    });
    return;
  }

  console.info('[slot-webhook] coins granted', {
    sessionId: session.id,
    userId: slotUserId,
    coins: coinsToGrant,
    newBalance: result.new_balance,
  });
}
