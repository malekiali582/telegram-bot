import { eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from './client.ts';
import { playerState } from './schema.ts';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run a query: the database or an open transaction. */
export type Executor = Database | Tx;

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** SQLSTATE codes the services react to. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  restrictViolation: '23001',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/** Finds the PostgreSQL error inside driver/ORM wrappers (Drizzle wraps it in `cause`). */
function findPgError(err: unknown): PgLikeError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as PgLikeError;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code))
      return candidate;
    current = candidate.cause;
  }
  return undefined;
}

export function pgErrorCode(err: unknown): string | undefined {
  return findPgError(err)?.code as string | undefined;
}

/** Name of the violated constraint, when the driver reports it. */
export function pgConstraint(err: unknown): string | undefined {
  const constraint = findPgError(err)?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return (
    pgErrorCode(err) === PG_ERROR.uniqueViolation &&
    (constraint === undefined || pgConstraint(err) === constraint)
  );
}

const RETRYABLE: ReadonlySet<string> = new Set([
  PG_ERROR.serializationFailure,
  PG_ERROR.deadlockDetected,
]);

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /** Extra attempts after a serialization failure or deadlock. */
  retries?: number;
}

/**
 * Runs `fn` in a transaction and retries it when PostgreSQL aborts it for a
 * serialization failure or deadlock. `fn` must be safe to re-run: keep side effects
 * (sending messages, logging results) out of it — write them to the outbox instead.
 */
export async function inTransaction<T>(
  db: Database,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(
        fn,
        options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined,
      );
    } catch (err) {
      const code = pgErrorCode(err);
      if (attempt >= retries || code === undefined || !RETRYABLE.has(code)) throw err;
      // short jittered backoff so competing transactions do not collide again
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * (attempt + 1)));
    }
  }
}

/**
 * Locks the player's state row for the rest of the transaction. This row is the
 * player-wide mutex: every money or cooldown change for a player takes it first, so
 * actions from different groups cannot interleave.
 */
export async function lockPlayer(tx: Tx, userId: number) {
  const rows = await tx
    .select()
    .from(playerState)
    .where(eq(playerState.userId, userId))
    .for('update');
  return rows[0];
}

/** Runs raw SQL and returns its rows; both drivers (pg, PGlite) expose them as `rows`. */
export async function queryRows<R>(ex: Executor, query: SQL): Promise<R[]> {
  const result: unknown = await ex.execute(query);
  return (result as { rows: R[] }).rows;
}
