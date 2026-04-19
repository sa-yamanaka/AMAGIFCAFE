/**
 * lineAuth.ts
 * ---------------------------------------------------------------
 * LIFF から渡された ID トークンを LINE Verify API で検証し、
 * サーバー側で検証済みの lineUserId を返すユーティリティ。
 *
 * フロントから渡ってきた lineUserId を直接信じず、必ずこの関数を通す。
 * ---------------------------------------------------------------
 */

const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

export interface VerifiedLineUser {
  sub: string;      // LINE user id (U...)
  name?: string;
  picture?: string;
  exp: number;
  iat: number;
}

export class LineAuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
    this.name = 'LineAuthError';
  }
}

/**
 * LINE Login チャネルID を環境変数から解決する。
 * 未設定時は NEXT_PUBLIC_LIFF_ID の先頭部分を使う。
 */
function resolveChannelId(): string {
  const explicit = process.env.NEXT_PUBLIC_LINE_LOGIN_CHANNEL_ID;
  if (explicit) return explicit;
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  if (!liffId) {
    throw new LineAuthError('liff_id_not_configured', 500);
  }
  const head = liffId.split('-')[0];
  if (!head) {
    throw new LineAuthError('liff_id_malformed', 500);
  }
  return head;
}

/**
 * ID トークンを LINE に検証させる。
 * 成功時は payload(sub等) を返す。失敗時は LineAuthError を throw。
 */
export async function verifyLineIdToken(idToken: string): Promise<VerifiedLineUser> {
  if (!idToken || typeof idToken !== 'string') {
    throw new LineAuthError('missing_id_token', 400);
  }

  const channelId = resolveChannelId();

  const res = await fetch(LINE_VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      id_token: idToken,
      client_id: channelId,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[lineAuth] verify failed:', res.status, text);
    throw new LineAuthError('invalid_id_token', 401);
  }

  const payload = (await res.json()) as VerifiedLineUser;
  if (!payload?.sub) {
    throw new LineAuthError('invalid_id_token_payload', 401);
  }
  return payload;
}
