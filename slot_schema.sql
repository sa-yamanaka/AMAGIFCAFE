-- ============================================================
-- slot_schema.sql
-- アマギフスロットアプリ用 Supabase スキーマ
--
-- 実行方法：
--   Supabase Dashboard → SQL Editor にまるごと貼り付けて Run
--   （冪等に書いてあるので何度流しても安全。ただし関数は CREATE OR REPLACE）
--
-- 認証方針：
--   Supabase Auth は使わない。LINE LIFF 経由で取得した line_user_id を
--   主キーに、サーバー(Next.js API Route)が Service Role Key で操作する。
--   → RLS は ENABLE する（念のため）が、anon/authenticated ロールには
--     いかなる policy も与えない＝実質 Service Role 専用。
-- ============================================================

-- ------------------------------------------------------------
-- 拡張
-- ------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ------------------------------------------------------------
-- ユーティリティ：updated_at 自動更新トリガ
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ============================================================
-- 1. slot_users  ユーザー・コイン残高
-- ============================================================
create table if not exists slot_users (
  id             uuid primary key default gen_random_uuid(),
  line_user_id   text not null unique,
  display_name   text,
  coin_balance   integer not null default 0 check (coin_balance >= 0),
  is_banned      boolean not null default false,
  ban_reason     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_slot_users_line_user_id
  on slot_users (line_user_id);

drop trigger if exists trg_slot_users_updated on slot_users;
create trigger trg_slot_users_updated
  before update on slot_users
  for each row execute function set_updated_at();


-- ============================================================
-- 2. coin_transactions  コイン増減の全ログ（改ざん防止の核）
-- ============================================================
-- kind:
--   'purchase'     Stripe決済で付与
--   'spin_cost'    スピン消費
--   'spin_prize'   当選付与（アマギフ発送前の内部残高への付与用。現状は未使用。
--                  賞金は prize_deliveries に積む運用のためここは将来拡張用）
--   'refund'       返金
--   'admin_adjust' 手動調整
-- ------------------------------------------------------------
create table if not exists coin_transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references slot_users(id) on delete cascade,
  amount             integer not null,        -- 正:付与 / 負:消費
  kind               text not null check (kind in
                     ('purchase','spin_cost','spin_prize','refund','admin_adjust')),
  balance_after      integer not null check (balance_after >= 0),
  stripe_session_id  text,                    -- 重複決済防止用（purchase時のみ）
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists idx_coin_tx_user_created
  on coin_transactions (user_id, created_at desc);

-- Stripeセッションの重複付与防止
create unique index if not exists uq_coin_tx_stripe_session
  on coin_transactions (stripe_session_id)
  where stripe_session_id is not null;


-- ============================================================
-- 3. spin_results  スピン結果ログ
-- ============================================================
create table if not exists spin_results (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references slot_users(id) on delete cascade,
  course             text not null check (course in ('light','standard','premium','vip')),
  cost               integer not null check (cost >= 0),
  is_win             boolean not null,
  prize              integer not null default 0 check (prize >= 0),
  is_service_time    boolean not null default false,
  bonus_push_level   integer not null default 0 check (bonus_push_level between 0 and 3),
  parent_spin_id     uuid references spin_results(id), -- 倍プッシュ時の元スピン
  created_at         timestamptz not null default now()
);

create index if not exists idx_spin_results_user_created
  on spin_results (user_id, created_at desc);

create index if not exists idx_spin_results_win_created
  on spin_results (is_win, created_at desc);


-- ============================================================
-- 4. prize_deliveries  アマギフ発送管理
-- ============================================================
-- status:
--   'pending'     発送待ち（当選直後）
--   'sent'        LINE等で発送済み
--   'failed'      発送失敗
--   'cancelled'   キャンセル
-- ------------------------------------------------------------
create table if not exists prize_deliveries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references slot_users(id) on delete cascade,
  spin_result_id uuid not null unique references spin_results(id) on delete cascade,
  amount         integer not null check (amount > 0),
  status         text not null default 'pending'
                 check (status in ('pending','sent','failed','cancelled')),
  gift_code      text,                -- アマギフコード（発送後に埋める）
  sent_at        timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_prize_deliveries_status
  on prize_deliveries (status, created_at);

create index if not exists idx_prize_deliveries_user
  on prize_deliveries (user_id, created_at desc);

drop trigger if exists trg_prize_deliveries_updated on prize_deliveries;
create trigger trg_prize_deliveries_updated
  before update on prize_deliveries
  for each row execute function set_updated_at();


-- ============================================================
-- 5. service_time_schedule  サービスタイム管理
-- ============================================================
create table if not exists service_time_schedule (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  note       text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists idx_service_time_range
  on service_time_schedule (starts_at, ends_at);


-- ============================================================
-- 6. suspicious_activity  不正検知ログ
-- ============================================================
create table if not exists suspicious_activity (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references slot_users(id) on delete cascade,
  kind       text not null,    -- 'spam_spin' / 'abnormal_win_rate' / 'balance_mismatch' など
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_suspicious_user_created
  on suspicious_activity (user_id, created_at desc);

create index if not exists idx_suspicious_kind_created
  on suspicious_activity (kind, created_at desc);


-- ============================================================
-- RLS（Row Level Security）
-- ------------------------------------------------------------
-- すべて ENABLE するが、anon/authenticated 向けのpolicyは一切作らない。
-- Service Role Key は RLS をバイパスするので、API からの操作だけが通る。
-- ============================================================
alter table slot_users             enable row level security;
alter table coin_transactions      enable row level security;
alter table spin_results           enable row level security;
alter table prize_deliveries       enable row level security;
alter table service_time_schedule  enable row level security;
alter table suspicious_activity    enable row level security;


-- ============================================================
-- 関数 1/6 : upsert_slot_user
--   LINE ユーザーの upsert。存在すれば取得、無ければ作成。
-- ============================================================
create or replace function upsert_slot_user(
  p_line_user_id text,
  p_display_name text default null
)
returns slot_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row slot_users;
begin
  insert into slot_users (line_user_id, display_name)
  values (p_line_user_id, p_display_name)
  on conflict (line_user_id) do update
    set display_name = coalesce(excluded.display_name, slot_users.display_name),
        updated_at   = now()
  returning * into v_row;

  return v_row;
end;
$$;


-- ============================================================
-- 関数 2/6 : consume_coins
--   スピン時のコイン消費。行ロック・BAN・残高チェックを原子的に行う。
-- ============================================================
create or replace function consume_coins(
  p_user_id uuid,
  p_amount  integer,
  p_meta    jsonb default '{}'::jsonb
)
returns table (
  success     boolean,
  new_balance integer,
  reason      text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    slot_users;
  v_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    return query select false, 0, 'invalid_amount';
    return;
  end if;

  -- 行ロックを取って同一ユーザーの同時スピンを直列化
  select * into v_user
    from slot_users
   where id = p_user_id
   for update;

  if not found then
    return query select false, 0, 'user_not_found';
    return;
  end if;

  if v_user.is_banned then
    return query select false, v_user.coin_balance, 'banned';
    return;
  end if;

  if v_user.coin_balance < p_amount then
    return query select false, v_user.coin_balance, 'insufficient';
    return;
  end if;

  update slot_users
     set coin_balance = coin_balance - p_amount,
         updated_at   = now()
   where id = p_user_id
   returning coin_balance into v_balance;

  insert into coin_transactions (user_id, amount, kind, balance_after, meta)
  values (p_user_id, -p_amount, 'spin_cost', v_balance, coalesce(p_meta, '{}'::jsonb));

  return query select true, v_balance, null::text;
end;
$$;


-- ============================================================
-- 関数 3/6 : add_coins
--   コイン付与。Stripeセッション指定時は重複決済を検知する。
-- ============================================================
create or replace function add_coins(
  p_user_id            uuid,
  p_amount             integer,
  p_stripe_session_id  text default null,
  p_meta               jsonb default '{}'::jsonb
)
returns table (
  success     boolean,
  new_balance integer,
  duplicated  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user        slot_users;
  v_balance     integer;
  v_exists_id   uuid;
  v_kind        text;
begin
  if p_amount is null or p_amount <= 0 then
    return query select false, 0, false;
    return;
  end if;

  -- 重複決済チェック（Stripeセッション単位）
  if p_stripe_session_id is not null then
    select id into v_exists_id
      from coin_transactions
     where stripe_session_id = p_stripe_session_id
     limit 1;

    if v_exists_id is not null then
      select coin_balance into v_balance
        from slot_users where id = p_user_id;
      return query select true, coalesce(v_balance, 0), true;
      return;
    end if;
  end if;

  -- 行ロック
  select * into v_user
    from slot_users
   where id = p_user_id
   for update;

  if not found then
    return query select false, 0, false;
    return;
  end if;

  v_kind := case when p_stripe_session_id is not null then 'purchase' else 'admin_adjust' end;

  update slot_users
     set coin_balance = coin_balance + p_amount,
         updated_at   = now()
   where id = p_user_id
   returning coin_balance into v_balance;

  insert into coin_transactions (
    user_id, amount, kind, balance_after, stripe_session_id, meta
  ) values (
    p_user_id, p_amount, v_kind, v_balance, p_stripe_session_id, coalesce(p_meta, '{}'::jsonb)
  );

  return query select true, v_balance, false;
end;
$$;


-- ============================================================
-- 関数 4/6 : check_balance_integrity
--   slot_users.coin_balance と coin_transactions の総和が一致するか。
-- ============================================================
create or replace function check_balance_integrity(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
  v_sum     integer;
begin
  select coin_balance into v_balance
    from slot_users where id = p_user_id;

  if v_balance is null then
    return false;
  end if;

  select coalesce(sum(amount), 0) into v_sum
    from coin_transactions where user_id = p_user_id;

  return v_balance = v_sum;
end;
$$;


-- ============================================================
-- 関数 5/6 : check_spam_spins
--   直近 N 秒間のスピン数が閾値(既定10件)を超えていれば true。
-- ============================================================
create or replace function check_spam_spins(
  p_user_id        uuid,
  p_window_seconds integer default 10,
  p_threshold      integer default 10
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from spin_results
   where user_id = p_user_id
     and created_at >= now() - make_interval(secs => p_window_seconds);

  return v_count >= p_threshold;
end;
$$;


-- ============================================================
-- 関数 6/6 : check_abnormal_win_rate
--   直近 N 秒間（既定1時間）の当選率が異常かどうか。
--   スピン数が20件以上 かつ 当選率が理論値(0.5%)の5倍以上なら true。
-- ============================================================
create or replace function check_abnormal_win_rate(
  p_user_id        uuid,
  p_window_seconds integer default 3600
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_wins  integer;
  v_rate  numeric;
begin
  select count(*),
         count(*) filter (where is_win)
    into v_total, v_wins
    from spin_results
   where user_id = p_user_id
     and created_at >= now() - make_interval(secs => p_window_seconds);

  if v_total < 20 then
    return false;
  end if;

  v_rate := v_wins::numeric / v_total::numeric;

  -- 通常確率 1/200=0.005 の5倍(=2.5%)を超えたら異常扱い
  return v_rate >= 0.025;
end;
$$;


-- ============================================================
-- 実行権限（Service Role / postgres / authenticated / anon ）
-- ------------------------------------------------------------
-- SECURITY DEFINER なので関数実行そのものの権限は definer(= postgres)で走る。
-- ただし呼び出し側がEXECUTEを持っていないと呼べないので明示的に GRANT する。
-- anon には spin/user 関連は触らせないので付与しない。
-- ============================================================
grant execute on function upsert_slot_user(text, text)                       to service_role;
grant execute on function consume_coins(uuid, integer, jsonb)                to service_role;
grant execute on function add_coins(uuid, integer, text, jsonb)              to service_role;
grant execute on function check_balance_integrity(uuid)                      to service_role;
grant execute on function check_spam_spins(uuid, integer, integer)           to service_role;
grant execute on function check_abnormal_win_rate(uuid, integer)             to service_role;


-- ============================================================
-- END of slot_schema.sql
-- ============================================================
