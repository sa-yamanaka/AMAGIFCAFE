/**
 * POST /api/slot/spin
 * ---------------------------------------------------------------
 * スピン処理のコア。通常スピン + 倍プッシュ の両方を扱う。
 *
 * リクエスト:
 *   {
 *     idToken: string,            // LIFF から取得
 *     course: 'light'|'standard'|'premium'|'vip',
 *     action?: 'spin' | 'bonus_push',  // 省略時 'spin'
 *     parentSpinId?: string,      // bonus_push 時に必須
 *   }
 *
 * レスポンス:
 *   {
 *     spinId: string,
 *     isWin: boolean,
 *     prize: number,              // 円(アマギフ額面)。当選時のみ >0
 *     newBalance: number,         // コイン消費後の残高
 *     isServiceTime: boolean,
 *     bonusPushLevel: number,     // 0=通常, 1..3=倍プッシュ
 *     canBonusPushNext: boolean,  // 次の倍プッシュが可能か
 *   }
 *
 * 仕様メモ:
 * - 通常確率: 1/200、サービスタイム中: 1/100
 * - 倍プッシュ確率: 1/3, 1/4, 1/5（段階的）
 * - 倍プッシュは当選スピンを起点に最大3回まで
 * - 倍プッシュの課金単位 = コース単価(unitPrice)
 * - 失敗しても基本賞金は消えない（= 親スピンの prize_deliveries は既に pending で積んである）
 * - 当選時は prize_deliveries に pending で積む（アマギフは管理画面から手動/APIで発送）
 * - コイン消費は consume_coins (行ロック + BAN + 残高) で原子的に
 * - 不正検知は spin 後に走らせ、引っかかったら suspicious_activity に記録（応答は失敗させない）
 * ---------------------------------------------------------------
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  getSupabaseAdmin,
  upsertSlotUser,
  consumeCoins,
  insertSpinResult,
  isServiceTimeNow,
  checkSpamSpins,
  checkAbnormalWinRate,
  logSuspicious,
  rollWin,
  COURSES,
  ODDS_NORMAL,
  ODDS_SERVICE_TIME,
  BONUS_PUSH_ODDS,
  BONUS_PUSH_MAX,
  isCourseType,
  type CourseType,
  type SpinResultRow,
} from '@/lib/supabaseSlot';
import { verifyLineIdToken, LineAuthError } from '@/lib/lineAuth';

type Success = {
  spinId: string;
  isWin: boolean;
  prize: number;
  newBalance: number;
  isServiceTime: boolean;
  bonusPushLevel: number;
  canBonusPushNext: boolean;
};
type Failure = { error: string; newBalance?: number };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Success | Failure>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = (req.body ?? {}) as {
      idToken?: string;
      course?: string;
      action?: 'spin' | 'bonus_push';
      parentSpinId?: string;
    };

    // --- 入力バリデーション -----------------------------------
    if (!isCourseType(body.course)) {
      return res.status(400).json({ error: 'invalid_course' });
    }
    const course: CourseType = body.course;
    const cfg = COURSES[course];
    const action = body.action ?? 'spin';
    if (action !== 'spin' && action !== 'bonus_push') {
      return res.status(400).json({ error: 'invalid_action' });
    }
    if (action === 'bonus_push' && !body.parentSpinId) {
      return res.status(400).json({ error: 'missing_parent_spin_id' });
    }

    // --- LINE ID 検証 ----------------------------------------
    const verified = await verifyLineIdToken(body.idToken ?? '');

    // --- ユーザー取得(無ければ作成) ---------------------------
    const user = await upsertSlotUser(verified.sub, verified.name ?? null);
    if (user.is_banned) {
      return res.status(403).json({ error: 'banned', newBalance: user.coin_balance });
    }

    // --- 倍プッシュの前提確認 ---------------------------------
    let bonusLevel = 0;
    let parentSpin: SpinResultRow | null = null;
    if (action === 'bonus_push') {
      const supabase = getSupabaseAdmin();
      const { data: parentRow, error: parentErr } = await supabase
        .from('spin_results')
        .select('*')
        .eq('id', body.parentSpinId!)
        .eq('user_id', user.id)
        .maybeSingle();
      if (parentErr) throw parentErr;
      if (!parentRow) {
        return res.status(404).json({ error: 'parent_spin_not_found' });
      }
      if (!parentRow.is_win) {
        return res.status(400).json({ error: 'parent_not_win' });
      }
      if (parentRow.course !== course) {
        return res.status(400).json({ error: 'course_mismatch' });
      }
      parentSpin = parentRow as SpinResultRow;

      // これまでのチャレンジ回数を数える
      const { count, error: cntErr } = await supabase
        .from('spin_results')
        .select('id', { count: 'exact', head: true })
        .eq('parent_spin_id', parentSpin.id);
      if (cntErr) throw cntErr;

      bonusLevel = (count ?? 0) + 1;
      if (bonusLevel > BONUS_PUSH_MAX) {
        return res.status(400).json({ error: 'bonus_push_limit_reached' });
      }
    }

    // --- サービスタイム判定（通常スピンのみ影響） --------------
    const inServiceTime = action === 'spin' ? await isServiceTimeNow() : false;

    // --- コイン消費 ------------------------------------------
    const cost = cfg.coinCost;
    const consume = await consumeCoins({
      userId: user.id,
      amount: cost,
      meta: {
        course,
        action,
        parentSpinId: body.parentSpinId ?? null,
        bonusLevel,
        unitPriceYen: cfg.unitPriceYen,
      },
    });
    if (!consume.success) {
      return res.status(400).json({
        error: consume.reason ?? 'consume_failed',
        newBalance: consume.new_balance,
      });
    }

    // --- 確率判定 --------------------------------------------
    let odds: number;
    if (action === 'bonus_push') {
      odds = BONUS_PUSH_ODDS[bonusLevel - 1];
    } else {
      odds = inServiceTime ? ODDS_SERVICE_TIME : ODDS_NORMAL;
    }
    const isWin = rollWin(odds);
    const prize = isWin ? cfg.prizeYen : 0;

    // --- spin_results に記録 ---------------------------------
    const supabase = getSupabaseAdmin();
    const { data: spinRow, error: spinErr } = await supabase
      .from('spin_results')
      .insert({
        user_id: user.id,
        course,
        cost,
        is_win: isWin,
        prize,
        is_service_time: inServiceTime,
        bonus_push_level: bonusLevel,
        parent_spin_id: parentSpin?.id ?? null,
      })
      .select('*')
      .single();
    if (spinErr) throw spinErr;
    const spin = spinRow as SpinResultRow;

    // --- 当選時: prize_deliveries に pending で積む -----------
    if (isWin) {
      const { error: deliverErr } = await supabase
        .from('prize_deliveries')
        .insert({
          user_id: user.id,
          spin_result_id: spin.id,
          amount: prize,
          status: 'pending',
        });
      if (deliverErr) {
        // ここで失敗するとユーザーは「当選したのに賞金記録が無い」状態になる。
        // ログだけ残して応答は success で返すが、運用監視で検知する前提。
        console.error('[slot/spin] prize_deliveries insert failed', {
          spinId: spin.id,
          userId: user.id,
          err: deliverErr,
        });
        await logSuspicious({
          userId: user.id,
          kind: 'prize_delivery_insert_failed',
          detail: { spinId: spin.id, amount: prize, message: String(deliverErr?.message ?? deliverErr) },
        }).catch(() => undefined);
      }
    }

    // --- 不正検知（失敗させない。引っかかったらログだけ） -----
    try {
      const [spam, abnormal] = await Promise.all([
        checkSpamSpins(user.id, 10),
        checkAbnormalWinRate(user.id, 3600),
      ]);
      if (spam) {
        await logSuspicious({
          userId: user.id,
          kind: 'spam_spin',
          detail: { windowSeconds: 10, at: spin.created_at },
        });
      }
      if (abnormal) {
        await logSuspicious({
          userId: user.id,
          kind: 'abnormal_win_rate',
          detail: { windowSeconds: 3600, at: spin.created_at },
        });
      }
    } catch (e) {
      console.error('[slot/spin] suspicious check failed:', e);
    }

    // --- 次の倍プッシュが可能か -----------------------------
    const canBonusPushNext =
      isWin &&
      (action === 'spin' ? 1 : bonusLevel + 1) <= BONUS_PUSH_MAX;

    return res.status(200).json({
      spinId: spin.id,
      isWin,
      prize,
      newBalance: consume.new_balance,
      isServiceTime: inServiceTime,
      bonusPushLevel: bonusLevel,
      canBonusPushNext,
    });
  } catch (err) {
    if (err instanceof LineAuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[slot/spin] internal error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
