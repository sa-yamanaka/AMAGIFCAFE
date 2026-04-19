/**
 * /slot  スロット画面（Pages Router）
 * ---------------------------------------------------------------
 * - LIFF 初期化 → IDトークンで /api/slot/user を叩く
 * - 4コース選択、スピン、倍プッシュ
 * - コイン購入(Checkout遷移)
 * - CSS だけで3リール風のシンプル演出
 * ---------------------------------------------------------------
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';

// 型だけ再利用（サーバー側のクライアントは import しない！）
type CourseType = 'light' | 'standard' | 'premium' | 'vip';
type CoinPackId = 'pack_10' | 'pack_50' | 'pack_100';

interface CourseMeta {
  type: CourseType;
  label: string;
  unitPriceYen: number;
  coinCost: number;
  prizeYen: number;
}

const COURSES: CourseMeta[] = [
  { type: 'light',    label: 'アマギフライト',  unitPriceYen: 100,  coinCost: 1,  prizeYen: 2000 },
  { type: 'standard', label: 'スタンダード',    unitPriceYen: 300,  coinCost: 3,  prizeYen: 5100 },
  { type: 'premium',  label: 'プレミアム',      unitPriceYen: 500,  coinCost: 5,  prizeYen: 7500 },
  { type: 'vip',      label: 'VIP',             unitPriceYen: 1000, coinCost: 10, prizeYen: 10000 },
];

const COIN_PACKS: { id: CoinPackId; coins: number; priceYen: number; label: string }[] = [
  { id: 'pack_10',  coins: 10,  priceYen: 1000,  label: '10コイン' },
  { id: 'pack_50',  coins: 50,  priceYen: 5000,  label: '50コイン' },
  { id: 'pack_100', coins: 100, priceYen: 10000, label: '100コイン' },
];

const REEL_SYMBOLS = ['🍒', '🍋', '🔔', '💎', '7️⃣', '🎁'];

type SpinResponse = {
  spinId: string;
  isWin: boolean;
  prize: number;
  newBalance: number;
  isServiceTime: boolean;
  bonusPushLevel: number;
  canBonusPushNext: boolean;
};

interface UserState {
  id: string;
  lineUserId: string;
  displayName: string | null;
  coinBalance: number;
  isBanned: boolean;
}

export default function SlotPage() {
  const [liffReady, setLiffReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<UserState | null>(null);

  const [selectedCourse, setSelectedCourse] = useState<CourseType>('light');
  const [isSpinning, setIsSpinning] = useState(false);
  const [lastResult, setLastResult] = useState<SpinResponse | null>(null);
  const [totalWinYen, setTotalWinYen] = useState(0);
  const [bonusLevel, setBonusLevel] = useState(0); // 現セッションでの倍プッシュ段階
  const [parentSpinId, setParentSpinId] = useState<string | null>(null);
  const [reelSymbols, setReelSymbols] = useState<string[]>(['🎁', '🎁', '🎁']);
  const [message, setMessage] = useState<string>('コースを選んでスピン！');

  const idTokenRef = useRef<string | null>(null);

  // ---------------- LIFF 初期化 -----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const liff = (await import('@line/liff')).default;
        const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
        if (!liffId) {
          setAuthError('LIFF_ID未設定');
          return;
        }
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }
        const token = liff.getIDToken();
        if (!token) {
          setAuthError('IDトークンが取得できません');
          return;
        }
        idTokenRef.current = token;
        setLiffReady(true);

        // 初回: ユーザー登録 & 残高取得
        const res = await fetch('/api/slot/user', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken: token }),
        });
        const json = await res.json();
        if (!res.ok) {
          setAuthError(json.error ?? 'user_fetch_failed');
          return;
        }
        if (cancelled) return;
        setUser(json.user as UserState);
      } catch (e: any) {
        console.error(e);
        setAuthError(e?.message ?? 'liff_init_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------- スピン実行 ----------------
  const doSpin = useCallback(
    async (action: 'spin' | 'bonus_push' = 'spin') => {
      if (!idTokenRef.current || !user) return;
      if (isSpinning) return;
      setIsSpinning(true);
      setMessage(action === 'bonus_push' ? '倍プッシュ挑戦中…' : 'スピン中…');
      setLastResult(null);

      // リール回転演出（結果到着までループさせる）
      let spinInterval: ReturnType<typeof setInterval> | null = null;
      spinInterval = setInterval(() => {
        setReelSymbols([
          REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)],
          REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)],
          REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)],
        ]);
      }, 80);

      try {
        const res = await fetch('/api/slot/spin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idToken: idTokenRef.current,
            course: selectedCourse,
            action,
            parentSpinId: action === 'bonus_push' ? parentSpinId : undefined,
          }),
        });
        const json = await res.json();
        if (spinInterval) clearInterval(spinInterval);

        if (!res.ok) {
          setReelSymbols(['❌', '❌', '❌']);
          setMessage(errorLabel(json.error));
          if (typeof json.newBalance === 'number') {
            setUser((u) => (u ? { ...u, coinBalance: json.newBalance } : u));
          }
          return;
        }

        const data = json as SpinResponse;
        setLastResult(data);

        // 結果シンボル
        if (data.isWin) {
          setReelSymbols(['7️⃣', '7️⃣', '7️⃣']);
          setTotalWinYen((y) => y + data.prize);
          setParentSpinId(action === 'spin' ? data.spinId : parentSpinId);
          setBonusLevel(data.bonusPushLevel);
          setMessage(
            action === 'bonus_push'
              ? `倍プッシュ${data.bonusPushLevel}段目 成功! +¥${data.prize.toLocaleString()}`
              : `当選! ¥${data.prize.toLocaleString()} のアマギフゲット${data.isServiceTime ? ' (サービスタイム)' : ''}`,
          );
        } else {
          setReelSymbols([
            REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)],
            REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)],
            REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)],
          ]);
          setMessage(
            action === 'bonus_push'
              ? `倍プッシュ失敗… 基本賞金は確定済み`
              : 'はずれ もう一度挑戦!',
          );
          // 倍プッシュ失敗 → チェーン終了
          if (action === 'bonus_push') {
            setParentSpinId(null);
            setBonusLevel(0);
          }
        }

        setUser((u) => (u ? { ...u, coinBalance: data.newBalance } : u));
      } catch (e: any) {
        if (spinInterval) clearInterval(spinInterval);
        console.error(e);
        setMessage('通信エラー');
      } finally {
        setIsSpinning(false);
      }
    },
    [user, isSpinning, selectedCourse, parentSpinId],
  );

  // ---------------- コイン購入 ----------------
  const doPurchase = useCallback(async (packId: CoinPackId) => {
    if (!idTokenRef.current) return;
    const res = await fetch('/api/slot/purchase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: idTokenRef.current, packId }),
    });
    const json = await res.json();
    if (!res.ok || !json.url) {
      alert(`購入URLの取得に失敗しました: ${json.error ?? ''}`);
      return;
    }
    // LIFF 内でも外ブラウザでも遷移
    window.location.href = json.url;
  }, []);

  const selectedCfg = useMemo(
    () => COURSES.find((c) => c.type === selectedCourse)!,
    [selectedCourse],
  );

  const canBonusPush =
    !!lastResult?.isWin && !!parentSpinId && bonusLevel < 3 && !isSpinning;

  // ---------------- 画面 ----------------
  if (authError) {
    return (
      <main style={styles.center}>
        <p>認証エラー: {authError}</p>
      </main>
    );
  }
  if (!liffReady || !user) {
    return (
      <main style={styles.center}>
        <p>LIFF初期化中…</p>
      </main>
    );
  }

  return (
    <>
      <Head>
        <title>アマギフスロット</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <main style={styles.page}>
        <header style={styles.header}>
          <h1 style={styles.title}>アマギフスロット</h1>
          <div style={styles.balance}>
            所持コイン: <b>{user.coinBalance.toLocaleString()}</b>
          </div>
          <div style={styles.subBalance}>
            獲得アマギフ累計: ¥{totalWinYen.toLocaleString()}
          </div>
        </header>

        {/* コース選択 */}
        <section style={styles.courses}>
          {COURSES.map((c) => {
            const active = c.type === selectedCourse;
            return (
              <button
                key={c.type}
                onClick={() => setSelectedCourse(c.type)}
                disabled={isSpinning}
                style={{
                  ...styles.courseBtn,
                  ...(active ? styles.courseBtnActive : {}),
                }}
              >
                <div style={styles.courseLabel}>{c.label}</div>
                <div style={styles.courseSub}>
                  ¥{c.unitPriceYen}/回 ({c.coinCost}コイン)
                </div>
                <div style={styles.courseSub}>当選 ¥{c.prizeYen.toLocaleString()}</div>
              </button>
            );
          })}
        </section>

        {/* スロット本体 */}
        <section style={styles.slot}>
          <div style={styles.reels}>
            {reelSymbols.map((s, i) => (
              <div
                key={i}
                style={{
                  ...styles.reel,
                  ...(isSpinning ? styles.reelSpinning : {}),
                }}
              >
                {s}
              </div>
            ))}
          </div>
          <p style={styles.message}>{message}</p>
        </section>

        {/* メインボタン */}
        <section style={styles.actions}>
          <button
            onClick={() => doSpin('spin')}
            disabled={isSpinning || user.coinBalance < selectedCfg.coinCost}
            style={styles.primaryBtn}
          >
            {isSpinning ? 'スピン中…' : `スピン (${selectedCfg.coinCost}コイン)`}
          </button>

          {canBonusPush && (
            <button
              onClick={() => doSpin('bonus_push')}
              disabled={isSpinning || user.coinBalance < selectedCfg.coinCost}
              style={styles.bonusBtn}
            >
              倍プッシュに挑戦 ({selectedCfg.coinCost}コイン / 最大3回)
            </button>
          )}
        </section>

        {/* コイン購入 */}
        <section style={styles.shop}>
          <h2 style={styles.shopTitle}>コインを購入</h2>
          <div style={styles.packs}>
            {COIN_PACKS.map((p) => (
              <button
                key={p.id}
                onClick={() => doPurchase(p.id)}
                style={styles.packBtn}
              >
                <div style={styles.packCoins}>{p.coins}コイン</div>
                <div style={styles.packPrice}>¥{p.priceYen.toLocaleString()}</div>
              </button>
            ))}
          </div>
        </section>

        <footer style={styles.footer}>
          <small>※1コイン=¥100 / 景品法遵守の運用です</small>
        </footer>
      </main>
    </>
  );
}

// ---------------- helpers ----------------
function errorLabel(code?: string): string {
  switch (code) {
    case 'insufficient': return 'コインが足りません';
    case 'banned':       return 'このアカウントは利用できません';
    case 'invalid_course': return 'コースが不正です';
    case 'parent_not_win': return '当選スピンからでないと倍プッシュできません';
    case 'bonus_push_limit_reached': return '倍プッシュは最大3回までです';
    default: return `エラー: ${code ?? 'unknown'}`;
  }
}

// ---------------- styles ----------------
const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: 'system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif',
    background: 'linear-gradient(180deg,#101030 0%,#202050 100%)',
    color: '#fff',
    minHeight: '100vh',
    padding: '16px',
    boxSizing: 'border-box',
  },
  center: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#101030',
    color: '#fff',
    fontFamily: 'system-ui, sans-serif',
  },
  header: { textAlign: 'center', marginBottom: 16 },
  title: { margin: '0 0 8px', fontSize: 24, letterSpacing: 2 },
  balance: { fontSize: 16 },
  subBalance: { fontSize: 12, opacity: 0.7 },
  courses: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
    marginBottom: 16,
  },
  courseBtn: {
    background: 'rgba(255,255,255,0.05)',
    border: '2px solid rgba(255,255,255,0.2)',
    borderRadius: 12,
    color: '#fff',
    padding: '10px 8px',
    cursor: 'pointer',
    textAlign: 'center',
  },
  courseBtnActive: {
    background: 'rgba(255,215,0,0.15)',
    border: '2px solid #FFD700',
  },
  courseLabel: { fontWeight: 'bold', marginBottom: 4 },
  courseSub: { fontSize: 11, opacity: 0.85 },
  slot: {
    background: 'rgba(0,0,0,0.4)',
    border: '2px solid rgba(255,255,255,0.2)',
    borderRadius: 16,
    padding: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  reels: {
    display: 'flex',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 12,
  },
  reel: {
    width: 72,
    height: 96,
    fontSize: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#fff',
    color: '#000',
    borderRadius: 12,
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    transition: 'transform 0.08s',
  },
  reelSpinning: {
    animation: 'reelSpin 0.2s linear infinite',
  },
  message: { minHeight: 20, fontSize: 14 },
  actions: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  primaryBtn: {
    background: 'linear-gradient(180deg,#FFD700,#E6AC00)',
    color: '#222',
    border: 'none',
    borderRadius: 12,
    padding: '16px',
    fontSize: 16,
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  bonusBtn: {
    background: 'linear-gradient(180deg,#FF5E5E,#C71E1E)',
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    padding: '14px',
    fontSize: 14,
    fontWeight: 'bold',
    cursor: 'pointer',
  },
  shop: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  shopTitle: { fontSize: 14, margin: '0 0 8px' },
  packs: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  packBtn: {
    background: '#1e1e3f',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 10,
    padding: '10px 4px',
    cursor: 'pointer',
    textAlign: 'center',
  },
  packCoins: { fontWeight: 'bold' },
  packPrice: { fontSize: 12, opacity: 0.8 },
  footer: { textAlign: 'center', opacity: 0.5 },
};
