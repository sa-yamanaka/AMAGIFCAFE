/**
 * supabaseSlot.ts
 * ---------------------------------------------------------------
 * スロットアプリ専用の Supabase クライアント + DB関数ラッパ。
 *
 * 認証はごはんびよりと同じく Supabase Auth を使わず、
 * LIFF から取得した lineUserId を主キーに Service Role Key で操作する。
 * → 本ファイルはサーバー側(API Route)からのみ import すること。
 *   絶対にクライアントコンポーネントから import しない。
 *
 * DB関数の呼び方は slot_schema.sql の関数シグネチャに合わせている。
 * もし schema 側の引数名を変更したら本ファイルも揃えること。
 * ---------------------------------------------------------------
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ------------------------------
// 環境変数チェック（起動時に fail-fast）
// ------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
}

// ------------------------------
// シングルトンクライアント
// ------------------------------
let _client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client;
  _client = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: { schema: 'public' },
  });
  return _client;
}

// ============================================================
// 型定義
// ============================================================

export type CourseType = 'light' | 'standard' | 'premium' | 'vip';

/**
 * コイン ↔ 円 の交換レート。
 *   コインパック: 10コイン=¥1,000 / 50コイン=¥5,000 / 100コイン=¥10,000
 *   → 1コイン = ¥100 で固定。
 * このレートを変えるときはコインパック価格も一緒に見直すこと。
 */
export const COIN_YEN_RATE = 100;

export interface CourseConfig {
  type: CourseType;
  unitPriceYen: number;     // 1スピンの表示価格(円)。景品法表記用。
  coinCost: number;         // 1スピンで消費するコイン数。unitPriceYen / COIN_YEN_RATE
  prizeMultiplier: number;  // アマギフ額面倍率（1スピン単価の何倍か）
  prizeYen: number;         // 実際のアマギフ額面(円) = unitPriceYen * prizeMultiplier
  label: string;
}

/**
 * コース定義（schema 側のENUMや CHECK と揃えること）
 * 景品法：1スピン単価 × 20倍以内 → すべてクリア
 */
export const COURSES: Record<CourseType, CourseConfig> = {
  light: {
    type: 'light',
    unitPriceYen: 100,
    coinCost: 1,
    prizeMultiplier: 20,
    prizeYen: 2000,
    label: 'アマギフライト',
  },
  standard: {
    type: 'standard',
    unitPriceYen: 300,
    coinCost: 3,
    prizeMultiplier: 17,
    prizeYen: 5100,
    label: 'スタンダード',
  },
  premium: {
    type: 'premium',
    unitPriceYen: 500,
    coinCost: 5,
    prizeMultiplier: 15,
    prizeYen: 7500,
    label: 'プレミアム',
  },
  vip: {
    type: 'vip',
    unitPriceYen: 1000,
    coinCost: 10,
    prizeMultiplier: 10,
    prizeYen: 10000,
    label: 'VIP',
  },
};

/**
 * コインパック定義。Stripe の Price ID は環境変数から解決する。
 */
export type CoinPackId = 'pack_10' | 'pack_50' | 'pack_100';

export interface CoinPackConfig {
  id: CoinPackId;
  coins: number;
  priceYen: number;
  stripePriceEnvKey: string;   // 実際の Price ID を持つ環境変数名
  label: string;
}

export const COIN_PACKS: Record<CoinPackId, CoinPackConfig> = {
  pack_10: {
    id: 'pack_10',
    coins: 10,
    priceYen: 1000,
    stripePriceEnvKey: 'STRIPE_PRICE_COIN_10',
    label: '10コイン',
  },
  pack_50: {
    id: 'pack_50',
    coins: 50,
    priceYen: 5000,
    stripePriceEnvKey: 'STRIPE_PRICE_COIN_50',
    label: '50コイン',
  },
  pack_100: {
    id: 'pack_100',
    coins: 100,
    priceYen: 10000,
    stripePriceEnvKey: 'STRIPE_PRICE_COIN_100',
    label: '100コイン',
  },
};

export function isCoinPackId(v: unknown): v is CoinPackId {
  return typeof v === 'string' && v in COIN_PACKS;
}

/** 確率分母(1/N) */
export const ODDS_NORMAL = 200;
export const ODDS_SERVICE_TIME = 100;

/** 倍プッシュ段階別の確率分母(1/N) */
export const BONUS_PUSH_ODDS: number[] = [3, 4, 5];
export const BONUS_PUSH_MAX = BONUS_PUSH_ODDS.length;

// ============================================================
// slot_users 周り
// ============================================================

export interface SlotUser {
  id: string;           // uuid
  line_user_id: string;
  display_name: string | null;
  coin_balance: number;
  is_banned: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * LINE ユーザーの upsert。存在すれば取得、無ければ作成。
 * schema: upsert_slot_user(p_line_user_id text, p_display_name text)
 *   RETURNS slot_users 行
 */
export async function upsertSlotUser(
  lineUserId: string,
  displayName: string | null = null
): Promise<SlotUser> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('upsert_slot_user', {
    p_line_user_id: lineUserId,
    p_display_name: displayName,
  });
  if (error) throw error;
  // RETURNS row の場合 data は object or array。両対応。
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('upsert_slot_user returned no row');
  return row as SlotUser;
}

/**
 * コイン残高取得（直接テーブルから）
 */
export async function getSlotUserByLineId(
  lineUserId: string
): Promise<SlotUser | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('slot_users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (error) throw error;
  return (data as SlotUser) ?? null;
}

// ============================================================
// コイン消費・付与
// ============================================================

export interface ConsumeResult {
  success: boolean;
  new_balance: number;
  reason?: string; // 'insufficient' | 'banned' | null
}

/**
 * スピン時のコイン消費。
 * 行ロック・BANチェック・残高チェックは schema 関数側で行う。
 * schema: consume_coins(p_user_id uuid, p_amount int, p_meta jsonb)
 *   RETURNS table(success bool, new_balance int, reason text)
 */
export async function consumeCoins(params: {
  userId: string;
  amount: number;
  meta?: Record<string, unknown>;
}): Promise<ConsumeResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('consume_coins', {
    p_user_id: params.userId,
    p_amount: params.amount,
    p_meta: params.meta ?? {},
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('consume_coins returned no row');
  return row as ConsumeResult;
}

export interface AddCoinsResult {
  success: boolean;
  new_balance: number;
  duplicated?: boolean; // 重複決済などで弾いた場合 true
}

/**
 * 購入成功・当選時のコイン付与。
 * schema: add_coins(p_user_id uuid, p_amount int, p_stripe_session_id text, p_meta jsonb)
 *   RETURNS table(success bool, new_balance int, duplicated bool)
 */
export async function addCoins(params: {
  userId: string;
  amount: number;
  stripeSessionId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<AddCoinsResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('add_coins', {
    p_user_id: params.userId,
    p_amount: params.amount,
    p_stripe_session_id: params.stripeSessionId ?? null,
    p_meta: params.meta ?? {},
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('add_coins returned no row');
  return row as AddCoinsResult;
}

// ============================================================
// スピン結果・サービスタイム
// ============================================================

export interface SpinResultRow {
  id: string;
  user_id: string;
  course: CourseType;
  cost: number;
  is_win: boolean;
  prize: number;
  is_service_time: boolean;
  bonus_push_level: number; // 0=通常, 1..3=倍プッシュ
  created_at: string;
}

export async function insertSpinResult(
  row: Omit<SpinResultRow, 'id' | 'created_at'>
): Promise<SpinResultRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('spin_results')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data as SpinResultRow;
}

/**
 * 現在時刻がサービスタイム中かどうか判定。
 * service_time_schedule テーブルから [starts_at, ends_at] を引く想定。
 */
export async function isServiceTimeNow(at: Date = new Date()): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const iso = at.toISOString();
  const { data, error } = await supabase
    .from('service_time_schedule')
    .select('id')
    .lte('starts_at', iso)
    .gte('ends_at', iso)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// 不正検知
// ============================================================

/** schema: check_balance_integrity(p_user_id uuid) returns bool */
export async function checkBalanceIntegrity(userId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('check_balance_integrity', {
    p_user_id: userId,
  });
  if (error) throw error;
  return Boolean(data);
}

/** schema: check_spam_spins(p_user_id uuid, p_window_seconds int) returns bool */
export async function checkSpamSpins(
  userId: string,
  windowSeconds = 10
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('check_spam_spins', {
    p_user_id: userId,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return Boolean(data);
}

/** schema: check_abnormal_win_rate(p_user_id uuid, p_window_seconds int) returns bool */
export async function checkAbnormalWinRate(
  userId: string,
  windowSeconds = 3600
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('check_abnormal_win_rate', {
    p_user_id: userId,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return Boolean(data);
}

/** 不正検知ログ(suspicious_activity)への insert */
export async function logSuspicious(params: {
  userId: string;
  kind: string;      // 'spam_spin' | 'abnormal_win_rate' | 'balance_mismatch' など
  detail?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('suspicious_activity').insert({
    user_id: params.userId,
    kind: params.kind,
    detail: params.detail ?? {},
  });
  if (error) throw error;
}

// ============================================================
// 共通ユーティリティ
// ============================================================

/**
 * 1/N 確率で当選判定。crypto.randomInt を使ってメルセンヌツイスタ等より
 * 予測困難にする（サーバー側限定）。
 */
export function rollWin(oneInN: number): boolean {
  // 動的 import でEdge環境でも壊れないようにする
  // Node.js前提なのでそのまま require 可
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomInt } = require('crypto') as typeof import('crypto');
  return randomInt(0, oneInN) === 0;
}

/** コース→景品額（円） */
export function prizeYenOf(course: CourseType): number {
  return COURSES[course].prizeYen;
}

/** コース→コイン消費数 */
export function coinCostOf(course: CourseType): number {
  return COURSES[course].coinCost;
}

/** コースが有効か */
export function isCourseType(v: unknown): v is CourseType {
  return typeof v === 'string' && v in COURSES;
}
