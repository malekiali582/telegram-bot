import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playerState, processedUpdates } from './schema.ts';
import type { PlayerFixture, TestDatabase } from './testing.ts';
import { createPlayerFixture, createTestDatabase, testBackend } from './testing.ts';
import { PG_ERROR, inTransaction, isUniqueViolation, lockPlayer, pgErrorCode } from './tx.ts';

let t: TestDatabase;
let player: PlayerFixture;

beforeAll(async () => {
  t = await createTestDatabase();
  player = await createPlayerFixture(t.db);
});
afterAll(async () => {
  await t.close();
});

describe(`transaction helpers (${testBackend()})`, () => {
  it('commits on success and rolls everything back on error', async () => {
    await inTransaction(t.db, async (tx) => {
      await tx.update(playerState).set({ level: 2 }).where(eq(playerState.userId, player.userId));
    });
    await expect(
      inTransaction(t.db, async (tx) => {
        await tx.update(playerState).set({ level: 3 }).where(eq(playerState.userId, player.userId));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [row] = await t.db
      .select()
      .from(playerState)
      .where(eq(playerState.userId, player.userId));
    expect(row?.level).toBe(2);
  });

  it('locks and returns the player row', async () => {
    const row = await inTransaction(t.db, (tx) => lockPlayer(tx, player.userId));
    expect(row?.userId).toBe(player.userId);
    expect(await inTransaction(t.db, (tx) => lockPlayer(tx, 999_999))).toBeUndefined();
  });

  it('finds the SQLSTATE through the ORM error wrapper', async () => {
    await t.db.insert(processedUpdates).values({ platform: 'telegram', updateId: 'dup' });
    try {
      await t.db.insert(processedUpdates).values({ platform: 'telegram', updateId: 'dup' });
      expect.unreachable();
    } catch (err) {
      expect(pgErrorCode(err)).toBe(PG_ERROR.uniqueViolation);
      expect(isUniqueViolation(err, 'processed_updates_pkey')).toBe(true);
      expect(isUniqueViolation(err, 'some_other_constraint')).toBe(false);
    }
  });

  it('retries serialization failures, then gives up; never retries other errors', async () => {
    let attempts = 0;
    const serializationFailure = Object.assign(new Error('could not serialize'), {
      code: PG_ERROR.serializationFailure,
    });
    await expect(
      inTransaction(
        t.db,
        () => {
          attempts++;
          return Promise.reject(serializationFailure);
        },
        { retries: 2 },
      ),
    ).rejects.toBe(serializationFailure);
    expect(attempts).toBe(3);

    attempts = 0;
    await expect(
      inTransaction(t.db, () => {
        attempts++;
        return Promise.reject(Object.assign(new Error('dup'), { code: PG_ERROR.uniqueViolation }));
      }),
    ).rejects.toThrow('dup');
    expect(attempts).toBe(1);

    attempts = 0;
    const result = await inTransaction(t.db, () => {
      attempts++;
      return attempts < 3 ? Promise.reject(serializationFailure) : Promise.resolve('ok');
    });
    expect([result, attempts]).toEqual(['ok', 3]);
  });
});
