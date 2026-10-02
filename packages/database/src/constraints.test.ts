import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ghostBatches,
  ghostStories,
  groupIdentities,
  groups,
  interestSettlements,
  jobState,
  ownedTools,
  playerState,
  processedUpdates,
  transactions,
  userIdentities,
  wallets,
} from './schema.ts';
import type { PlayerFixture, TestDatabase } from './testing.ts';
import { createPlayerFixture, createTestDatabase } from './testing.ts';
import { PG_ERROR, isUniqueViolation, pgConstraint, pgErrorCode } from './tx.ts';

let t: TestDatabase;
let player: PlayerFixture;

beforeAll(async () => {
  t = await createTestDatabase();
  player = await createPlayerFixture(t.db);
});
afterAll(async () => {
  await t.close();
});

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to fail');
}

const codeOf = async (promise: Promise<unknown>) => pgErrorCode(await errorOf(promise));

async function testTransaction(): Promise<number> {
  const [row] = await t.db
    .insert(transactions)
    .values({ kind: 'test', effectiveAt: new Date() })
    .returning({ id: transactions.id });
  return row!.id;
}

describe('identity constraints', () => {
  it('maps one platform id to one user, independently per platform', async () => {
    await t.db
      .insert(userIdentities)
      .values({ platform: 'telegram', platformUserId: '42', userId: player.userId });
    const err = await errorOf(
      t.db
        .insert(userIdentities)
        .values({ platform: 'telegram', platformUserId: '42', userId: player.userId }),
    );
    expect(isUniqueViolation(err)).toBe(true);
    await expect(
      t.db
        .insert(userIdentities)
        .values({ platform: 'rubika', platformUserId: '42', userId: player.userId }),
    ).resolves.toBeDefined();
  });

  it('gives a group at most one chat id per platform', async () => {
    const [group] = await t.db.insert(groups).values({ title: 'گروه' }).returning();
    await t.db
      .insert(groupIdentities)
      .values({ platform: 'telegram', platformChatId: '-1', groupId: group!.id });
    const err = await errorOf(
      t.db
        .insert(groupIdentities)
        .values({ platform: 'telegram', platformChatId: '-1009', groupId: group!.id }),
    );
    expect(isUniqueViolation(err, 'group_identities_one_per_platform')).toBe(true);
  });

  it('rejects unknown platforms', async () => {
    expect(
      await codeOf(
        t.db.execute(
          sql`INSERT INTO user_identities (platform, platform_user_id, user_id) VALUES ('icq', '1', ${player.userId})`,
        ),
      ),
    ).toBe(PG_ERROR.checkViolation);
  });

  it('dedupes platform updates', async () => {
    await t.db.insert(processedUpdates).values({ platform: 'telegram', updateId: '1001' });
    expect(
      await codeOf(
        t.db.insert(processedUpdates).values({ platform: 'telegram', updateId: '1001' }),
      ),
    ).toBe(PG_ERROR.uniqueViolation);
  });
});

describe('money and item constraints', () => {
  it('allows one cash wallet per user and enforces wallet ownership shape', async () => {
    expect(
      await codeOf(t.db.insert(wallets).values({ kind: 'user_cash', userId: player.userId })),
    ).toBe(PG_ERROR.uniqueViolation);
    expect(await codeOf(t.db.insert(wallets).values({ kind: 'user_cash' }))).toBe(
      PG_ERROR.checkViolation,
    );
    expect(
      await codeOf(t.db.insert(wallets).values({ kind: 'system', systemCode: 'free money' })),
    ).toBe(PG_ERROR.checkViolation);
  });

  it('makes the same tool impossible to own twice', async () => {
    const transactionId = await testTransaction();
    const row = { userId: player.userId, toolKind: 'knife', acquiredAt: new Date(), transactionId };
    await t.db.insert(ownedTools).values(row);
    expect(await codeOf(t.db.insert(ownedTools).values(row))).toBe(PG_ERROR.uniqueViolation);
    expect(
      await codeOf(t.db.insert(ownedTools).values({ ...row, toolKind: 'rocket_launcher' })),
    ).toBe(PG_ERROR.foreignKeyViolation);
  });

  it('only lets a player equip a tool they own', async () => {
    expect(
      await codeOf(
        t.db.execute(
          sql`UPDATE player_state SET equipped_tool = 'bow' WHERE user_id = ${player.userId}`,
        ),
      ),
    ).toBe(PG_ERROR.foreignKeyViolation);
    await expect(
      t.db.execute(
        sql`UPDATE player_state SET equipped_tool = 'knife' WHERE user_id = ${player.userId}`,
      ),
    ).resolves.toBeDefined();
    const rows = await t.db.select().from(playerState);
    expect(rows.find((r) => r.userId === player.userId)?.equippedTool).toBe('knife');
  });

  it('records interest for a (player, midnight) pair only once', async () => {
    const row = {
      userId: player.userId,
      boundaryDate: '2026-10-02',
      balanceBefore: 100_000n,
      interest: 3_000n,
      rateBp: 300,
    };
    await t.db.insert(interestSettlements).values(row);
    const err = await errorOf(t.db.insert(interestSettlements).values(row));
    expect(isUniqueViolation(err)).toBe(true);
    expect(pgConstraint(err)).toBe('interest_settlements_pkey');
  });

  it('dedupes idempotency keys', async () => {
    const values = { kind: 'test', effectiveAt: new Date(), idempotencyKey: 'confirm:abc' };
    await t.db.insert(transactions).values(values);
    expect(await codeOf(t.db.insert(transactions).values(values))).toBe(PG_ERROR.uniqueViolation);
  });

  it('rejects negative inventory and levels below 1', async () => {
    expect(
      await codeOf(
        t.db.execute(
          sql`INSERT INTO inventory (user_id, food, quantity) VALUES (${player.userId}, 'bone', -1)`,
        ),
      ),
    ).toBe(PG_ERROR.checkViolation);
    expect(
      await codeOf(
        t.db.execute(sql`UPDATE player_state SET level = 0 WHERE user_id = ${player.userId}`),
      ),
    ).toBe(PG_ERROR.checkViolation);
  });
});

describe('ghost content constraints', () => {
  const batch = (key: string, activeDate: string, status: 'scheduled' | 'active') => ({
    batchKey: key,
    activeDate,
    timezone: 'Asia/Tehran',
    status,
    source: 'file' as const,
    contentHash: key,
  });

  it('keeps at most one live batch and one scheduled batch per date', async () => {
    await t.db.insert(ghostBatches).values(batch('b1', '2026-10-01', 'active'));
    expect(
      await codeOf(t.db.insert(ghostBatches).values(batch('b2', '2026-10-02', 'active'))),
    ).toBe(PG_ERROR.uniqueViolation);
    await t.db.insert(ghostBatches).values(batch('b3', '2026-10-03', 'scheduled'));
    expect(
      await codeOf(t.db.insert(ghostBatches).values(batch('b4', '2026-10-03', 'scheduled'))),
    ).toBe(PG_ERROR.uniqueViolation);
  });

  it('rejects blank story text and duplicate story ids within a batch', async () => {
    const [b] = await t.db
      .insert(ghostBatches)
      .values(batch('b5', '2026-10-05', 'scheduled'))
      .returning();
    expect(
      await codeOf(
        t.db
          .insert(ghostStories)
          .values({ batchId: b!.id, storyKey: 's1', position: 1, text: '  ' }),
      ),
    ).toBe(PG_ERROR.checkViolation);
    await t.db
      .insert(ghostStories)
      .values({ batchId: b!.id, storyKey: 's1', position: 1, text: 'متن' });
    expect(
      await codeOf(
        t.db
          .insert(ghostStories)
          .values({ batchId: b!.id, storyKey: 's1', position: 2, text: 'متن دیگر' }),
      ),
    ).toBe(PG_ERROR.uniqueViolation);
  });
});

describe('job state constraints', () => {
  it('requires lease owner and lease expiry together', async () => {
    expect(
      await codeOf(
        t.db.insert(jobState).values({ name: 'x', nextRunAt: new Date(), leaseOwner: 'worker-1' }),
      ),
    ).toBe(PG_ERROR.checkViolation);
  });
});
