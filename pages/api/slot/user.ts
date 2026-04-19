/**
 * POST /api/slot/user
 * ---------------------------------------------------------------
 * LIFF から渡された ID トークンを検証し、slot_users を upsert、残高を返す。
 *
 * フロント(LIFF)からの呼び方:
 *   const idToken = liff.getIDToken();
 *   const res = await fetch('/api/slot/user', {
 *     method: 'POST',
 *     headers: { 'content-type': 'application/json' },
 *     body: JSON.stringify({ idToken }),
 *   });
 *
 * 返却:
 *   { user: { id, lineUserId, displayName, coinBalance, isBanned } }
 * ---------------------------------------------------------------
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertSlotUser } from '@/lib/supabaseSlot';
import { verifyLineIdToken, LineAuthError } from '@/lib/lineAuth';

type Success = {
  user: {
    id: string;
    lineUserId: string;
    displayName: string | null;
    coinBalance: number;
    isBanned: boolean;
  };
};
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
    const { idToken, displayName } = (req.body ?? {}) as {
      idToken?: string;
      displayName?: string;
    };

    const verified = await verifyLineIdToken(idToken ?? '');

    const user = await upsertSlotUser(
      verified.sub,
      displayName ?? verified.name ?? null
    );

    return res.status(200).json({
      user: {
        id: user.id,
        lineUserId: user.line_user_id,
        displayName: user.display_name,
        coinBalance: user.coin_balance,
        isBanned: user.is_banned,
      },
    });
  } catch (err) {
    if (err instanceof LineAuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[slot/user] internal error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
