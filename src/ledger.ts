// src/ledger.ts
// TimeLink 회계장부 모듈
// 특허 보정서 3.8 (사용량 확정의 멱등 처리) 정합
//
// 원칙:
//   - 모든 잔액 변경은 tl_ledger 에 이벤트로 기록 (원본)
//   - users.tl_balance 는 캐시. 감사 시 ledger 재생으로 검증 가능
//   - idempotency UNIQUE → 재전송 안전 (중복 가산 방지)
//   - 이중 기록: 각 이벤트는 짝 (debit ↔ revenue + fee 등)

export type LedgerEventType =
  | 'charge'    // 사용자 TL 충전
  | 'debit'     // 세그먼트 재생 차감
  | 'refund'    // 미확정 세그먼트 환불
  | 'revenue'   // 창작자 수익
  | 'fee'       // 플랫폼 수수료
  | 'withdraw'; // 창작자 출금

export interface LedgerEvent {
  /** 멱등키 — 재전송 방지 (필수) */
  idempotency: string;
  /** 당사자 user_id */
  userId: number;
  /** 상대방 user_id (창작자/플랫폼) */
  counterparty?: number | null;
  /** 이벤트 타입 */
  eventType: LedgerEventType;
  /** 금액 (부호 있음: +입금, -출금) */
  amount: number;
  /** TL3 v3 AAD 와 동일 식별자 */
  sessionId?: string | null;
  segmentIndex?: number | null;
  fileId?: number | null;
  /** 원본 레코드 참조 */
  refTable?: string | null;
  refId?: string | null;
  /** 부가정보 (JSON 직렬화됨) */
  meta?: Record<string, unknown> | null;
}

export interface RecordResult {
  id: string;
  duplicate: boolean;
}

export interface AuditResult {
  ledgerSum: number;
  balance: number;
  ok: boolean;
  eventCount: number;
}

const enc = new TextEncoder();

function uuid(): string {
  // Cloudflare Workers 환경에서는 crypto.randomUUID() 사용 가능
  if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
    return (crypto as any).randomUUID();
  }
  // fallback (거의 안 씀)
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 회계 이벤트 기록.
 * - idempotency UNIQUE 충돌 시 duplicate=true 반환 (재전송 안전)
 * - balance_after 는 기록 시점의 users.tl_balance 스냅샷
 */
export async function recordEvent(
  db: D1Database,
  ev: LedgerEvent
): Promise<RecordResult> {
  if (!ev.idempotency) throw new Error('idempotency is required');
  if (!Number.isFinite(ev.amount) || ev.amount === 0) {
    throw new Error('amount must be non-zero finite number');
  }
  if (!Number.isInteger(ev.userId) || ev.userId <= 0) {
    throw new Error('userId must be positive integer');
  }

  const id = uuid();
  const ts = Math.floor(Date.now() / 1000);
  const metaJson = ev.meta ? JSON.stringify(ev.meta) : null;

  // 현재 잔액 스냅샷 (기록 시점)
  const u = await db
    .prepare('SELECT tl_balance FROM users WHERE id=?')
    .bind(ev.userId)
    .first<{ tl_balance: number }>();
  const balanceAfter = Number(u?.tl_balance ?? 0);

  try {
    await db
      .prepare(
        `INSERT INTO tl_ledger (
          id, idempotency, ts, user_id, counterparty, event_type,
          amount, balance_after, session_id, segment_index, file_id,
          ref_table, ref_id, meta
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id,
        ev.idempotency,
        ts,
        ev.userId,
        ev.counterparty ?? null,
        ev.eventType,
        ev.amount,
        balanceAfter,
        ev.sessionId ?? null,
        ev.segmentIndex ?? null,
        ev.fileId ?? null,
        ev.refTable ?? null,
        ev.refId ?? null,
        metaJson
      )
      .run();
    return { id, duplicate: false };
  } catch (e: any) {
    const msg = String(e?.message || '');
    if (msg.includes('UNIQUE') || msg.includes('constraint')) {
      // 멱등키 충돌 → 기존 이벤트 반환
      const row = await db
        .prepare('SELECT id FROM tl_ledger WHERE idempotency=?')
        .bind(ev.idempotency)
        .first<{ id: string }>();
      return { id: row?.id ?? '', duplicate: true };
    }
    throw e;
  }
}

/**
 * 현재 사용자 잔액 조회 (users.tl_balance).
 */
export async function getBalance(db: D1Database, userId: number): Promise<number> {
  const u = await db
    .prepare('SELECT tl_balance FROM users WHERE id=?')
    .bind(userId)
    .first<{ tl_balance: number }>();
  return Number(u?.tl_balance ?? 0);
}

/**
 * 감사: ledger 합계와 users.tl_balance 일치 검증.
 * 특허 보정서 3.8: 회계 정합성 확인.
 */
export async function auditUser(
  db: D1Database,
  userId: number,
  fromTs?: number
): Promise<AuditResult> {
  const from = fromTs ?? 0;
  const sumRow = await db
    .prepare(
      'SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM tl_ledger WHERE user_id=? AND ts>=?'
    )
    .bind(userId, from)
    .first<{ s: number; n: number }>();
  const balance = await getBalance(db, userId);
  const ledgerSum = Number(sumRow?.s ?? 0);
  const eventCount = Number(sumRow?.n ?? 0);
  // 부동소수 오차 감안 (0.01 TL 이내)
  const ok = Math.abs(ledgerSum - balance) < 0.01;
  return { ledgerSum, balance, ok, eventCount };
}

/**
 * 특정 세션의 이벤트 조회 (디버깅/감사용).
 */
export async function listBySession(
  db: D1Database,
  sessionId: string,
  limit = 100
): Promise<Array<Record<string, unknown>>> {
  const r = await db
    .prepare(
      'SELECT * FROM tl_ledger WHERE session_id=? ORDER BY ts ASC LIMIT ?'
    )
    .bind(sessionId, limit)
    .all();
  return (r.results ?? []) as Array<Record<string, unknown>>;
}
