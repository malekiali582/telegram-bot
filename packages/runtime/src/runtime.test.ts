import { jobRuns, jobState, outbox } from '@lulu/database';
import type { TestDatabase } from '@lulu/database/testing';
import { createTestDatabase, testBackend, usingRealPostgres } from '@lulu/database/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobDefinition } from './jobs.ts';
import { JobScheduler, holdLease } from './jobs.ts';
import { createLogger, redact, silentLogger } from './logger.ts';
import {
  MAX_ATTEMPTS,
  backoffMs,
  claimDue,
  deferClaimed,
  enqueue,
  markFailed,
  markSent,
} from './outbox.ts';
import { SendRateLimiter } from './rate-limit.ts';

describe('logger', () => {
  it('masks bot tokens anywhere and drops sensitive fields', () => {
    const token = '123456789:AAEhBP0av18Z_abcdefghijklmnopqrstuvwx';
    expect(
      redact({
        url: `https://api.telegram.org/bot${token}/getMe`,
        password: 'x',
        nested: { secretKey: 1, ok: 2 },
      }),
    ).toEqual({
      url: 'https://api.telegram.org/bot[redacted-token]/getMe',
      nested: { ok: 2 },
    });
    const lines: string[] = [];
    createLogger({ write: (l) => lines.push(l) }).error('failed', {
      error: new Error(`bad ${token}`),
      n: 5n,
    });
    expect(lines[0]).not.toContain(token);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'error',
      msg: 'failed',
      error: { message: 'bad [redacted-token]' },
      n: '5',
    });
  });

  it('respects the level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
  });
});

describe('send rate limits', () => {
  const limits = { globalPerSecond: 30, groupPerMinute: 20, privatePerSecond: 1 };
  const isGroup = (c: string) => c.startsWith('-');

  it('allows a burst of 5 per group, then ~20 per minute', () => {
    const l = new SendRateLimiter(limits, isGroup, 0);
    for (let i = 0; i < 5; i++) expect(l.tryReserve('-1', 0)).toBe(0);
    const wait = l.tryReserve('-1', 0);
    expect(wait).toBe(3_000); // 60 s / 20
    expect(l.tryReserve('-2', 0)).toBe(0); // other groups are independent
    expect(l.tryReserve('-1', 3_000)).toBe(0);
  });

  it('allows one message per second per private chat, and caps the global rate', () => {
    const l = new SendRateLimiter(limits, isGroup, 0);
    expect(l.tryReserve('5', 0)).toBe(0);
    expect(l.tryReserve('5', 0)).toBe(1_000);
    for (let i = 0; i < 29; i++) l.tryReserve(null, 0);
    expect(l.tryReserve(null, 0)).toBeGreaterThan(0); // 30 used in this second
  });

  it('does not lock up when the clock jumps backwards', () => {
    const l = new SendRateLimiter(limits, isGroup, 1_000_000);
    expect(l.tryReserve('7', 1_000_000)).toBe(0);
    expect(l.tryReserve('7', 500)).toBe(1_000); // backwards: no refill, but a finite wait
    expect(l.tryReserve('7', 1_500)).toBe(0);
  });
});

describe(`outbox (${testBackend()})`, () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  const at = (s: number) => new Date(Date.UTC(2026, 9, 2, 8, 0, s));
  const msg = (text: string) => ({
    kind: 'send' as const,
    payload: { platformChatId: '-1', text, format: 'plain' as const },
  });

  it('claims due rows once, leases them, and marks them sent', async () => {
    await enqueue(t.db, 'telegram', msg('a'), { notBefore: at(0) });
    await enqueue(t.db, 'telegram', msg('later'), { notBefore: at(30) });
    const first = await claimDue(t.db, at(1));
    expect(first.map((m) => (m.item.payload as { text: string }).text)).toEqual(['a']);
    expect(first[0]?.attempts).toBe(1);
    expect(await claimDue(t.db, at(2))).toEqual([]); // leased
    await markSent(t.db, first[0]!.id, at(2), { platformChatId: '-1', messageId: '9' });
    expect(await claimDue(t.db, at(120))).toHaveLength(1); // only "later" remains
  });

  it('backs off, honours retry_after, defers without counting, and goes dead', async () => {
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([2_000, 4_000, 8_000, 300_000]);
    // finish the previous test's leftover row so only "flaky" is due below
    for (const leftover of await claimDue(t.db, at(199)))
      await markSent(t.db, leftover.id, at(199), null);
    await enqueue(t.db, 'telegram', msg('flaky'), { notBefore: at(200) });
    let [m] = await claimDue(t.db, at(200));
    expect((m?.item.payload as { text: string }).text).toBe('flaky');
    expect(
      await markFailed(t.db, {
        id: m!.id,
        now: at(200),
        attempts: m!.attempts,
        error: 'x',
        kind: 'rate_limited',
        retryAfterSeconds: 7,
      }),
    ).toBe('retry');
    expect(await claimDue(t.db, at(206))).toEqual([]);
    [m] = await claimDue(t.db, at(207));
    expect(m?.attempts).toBe(2);
    await deferClaimed(t.db, m!.id, at(210));
    [m] = await claimDue(t.db, at(210));
    expect(m?.attempts).toBe(2); // the deferral did not count
    expect(
      await markFailed(t.db, {
        id: m!.id,
        now: at(210),
        attempts: MAX_ATTEMPTS,
        error: 'x',
        kind: 'transient',
      }),
    ).toBe('dead');
    const [row] = await t.db.select().from(outbox).where(eq(outbox.id, m!.id));
    expect(row?.status).toBe('dead');
  });
});

describe.runIf(usingRealPostgres)('outbox on real PostgreSQL', () => {
  it('gives two concurrent senders disjoint rows', async () => {
    const t = await createTestDatabase();
    try {
      for (let i = 0; i < 30; i++) {
        await enqueue(
          t.db,
          'telegram',
          { kind: 'send', payload: { platformChatId: '-1', text: String(i), format: 'plain' } },
          { notBefore: new Date(0) },
        );
      }
      const [a, b] = await Promise.all([
        claimDue(t.db, new Date(), { limit: 20 }),
        claimDue(t.db, new Date(), { limit: 20 }),
      ]);
      const ids = [...a, ...b].map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(30);
    } finally {
      await t.close();
    }
  });
});

describe(`job scheduler (${testBackend()})`, () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it('runs a due job in exactly one of several schedulers and records the run', async () => {
    let runs = 0;
    const job: JobDefinition = {
      name: 'demo',
      intervalMs: 60_000,
      run: async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
    };
    const now = new Date('2026-10-02T08:00:00Z');
    const schedulers = Array.from(
      { length: 4 },
      (_, i) => new JobScheduler(t.db, [job], silentLogger, () => now, `w${i}`),
    );
    await schedulers[0]!.ensureJobs();
    const ran = await Promise.all(schedulers.map((s) => s.tick()));
    expect(runs).toBe(1);
    expect(ran.flat()).toEqual(['demo']);
    const [state] = await t.db.select().from(jobState).where(eq(jobState.name, 'demo'));
    expect(state).toMatchObject({
      leaseOwner: null,
      consecutiveFailures: 0,
      nextRunAt: new Date(now.getTime() + 60_000),
    });
    const [run] = await t.db.select().from(jobRuns).where(eq(jobRuns.jobName, 'demo'));
    expect(run).toMatchObject({ status: 'succeeded', stats: { ok: true } });
    expect(await schedulers[1]!.tick()).toEqual([]); // not due again yet
  });

  it('records failures, counts them, and still schedules the next run', async () => {
    const now = new Date('2026-10-02T09:00:00Z');
    const job: JobDefinition = {
      name: 'broken',
      intervalMs: 1_000,
      run: () => Promise.reject(new Error('boom')),
    };
    const s = new JobScheduler(t.db, [job], silentLogger, () => now, 'w');
    await s.ensureJobs();
    await s.tick();
    const [state] = await t.db.select().from(jobState).where(eq(jobState.name, 'broken'));
    expect(state).toMatchObject({
      lastError: 'boom',
      consecutiveFailures: 1,
      nextRunAt: new Date(now.getTime() + 1_000),
    });
  });

  it("lets a crashed holder's lease expire, and keeps a live one exclusive", async () => {
    const t0 = new Date('2026-10-02T10:00:00Z');
    expect(await holdLease(t.db, 'sender', 'a', t0, 30_000)).toBe(true);
    expect(await holdLease(t.db, 'sender', 'b', new Date(t0.getTime() + 10_000), 30_000)).toBe(
      false,
    );
    expect(await holdLease(t.db, 'sender', 'a', new Date(t0.getTime() + 20_000), 30_000)).toBe(
      true,
    ); // renewal
    expect(await holdLease(t.db, 'sender', 'b', new Date(t0.getTime() + 51_000), 30_000)).toBe(
      true,
    ); // a died
  });
});
