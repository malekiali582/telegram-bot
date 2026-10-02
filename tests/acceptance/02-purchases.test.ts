/**
 * Acceptance 2 (spec §19.2): insufficient funds, and no duplicate purchase or upgrade
 * under concurrent or repeated requests.
 */
import { ledgerEntries, ownedTools, playerState } from '@lulu/database';
import { queryRows } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { buyTool, equipTool, previewLevelUpgrade, upgradeLevel } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  cashOf,
  createTestGame,
  grantPoints,
  levelOf,
  newPlayer,
  setLevel,
} from '@lulu/domain/testing';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
});

const ownedCount = async (userId: number) =>
  (
    await game.ctx.db.select({ n: count() }).from(ownedTools).where(eq(ownedTools.userId, userId))
  )[0]?.n ?? 0;

describe(`acceptance 2 — level upgrades (${testBackend()})`, () => {
  it('shows the cost first and rejects when cash is short by one point', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 299);
    expect(await previewLevelUpgrade(game.ctx, userId)).toMatchObject({
      status: 'ok',
      currentLevel: 1,
      nextLevel: 2,
      costCenti: 30_000n,
      affordable: false,
    });
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 1 })).toEqual({
      status: 'insufficient_funds',
      costCenti: 30_000n,
      cashCenti: 29_900n,
    });
    expect(await levelOf(game, userId)).toBe(1);
    expect(await cashOf(game, userId)).toBe(29_900n);

    await grantPoints(game, userId, 1);
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 1 })).toMatchObject({
      status: 'ok',
      newLevel: 2,
      cashCenti: 0n,
    });
  });

  it('is sequential: no skipping levels, no upgrade past level 6', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 100_000_000);
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 5 })).toEqual({
      status: 'stale',
      currentLevel: 1,
    });
    await setLevel(game, userId, 6);
    expect(await upgradeLevel(game.ctx, { userId, expectedLevel: 6 })).toEqual({
      status: 'max_level',
      currentLevel: 6,
    });
    expect(await previewLevelUpgrade(game.ctx, userId)).toEqual({
      status: 'max_level',
      currentLevel: 6,
    });
  });

  it('upgrades once when the same confirmation arrives twice at the same time', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 600); // enough for two upgrades if the guard failed
    const results = await Promise.all([
      upgradeLevel(game.ctx, { userId, expectedLevel: 1 }),
      upgradeLevel(game.ctx, { userId, expectedLevel: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'stale']);
    expect(await levelOf(game, userId)).toBe(2);
    expect(await cashOf(game, userId)).toBe(30_000n);
  });

  it('treats a repeated idempotency key as a duplicate, sequentially and concurrently', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 7_000);
    const first = await upgradeLevel(game.ctx, {
      userId,
      expectedLevel: 1,
      idempotencyKey: 'up:1',
    });
    expect(first.status).toBe('ok');
    const repeat = await upgradeLevel(game.ctx, {
      userId,
      expectedLevel: 1,
      idempotencyKey: 'up:1',
    });
    expect(repeat).toEqual({
      status: 'duplicate',
      transactionId: first.status === 'ok' ? first.transactionId : -1,
    });

    const racing = await Promise.all([
      upgradeLevel(game.ctx, { userId, expectedLevel: 2, idempotencyKey: 'up:2' }),
      upgradeLevel(game.ctx, { userId, expectedLevel: 2, idempotencyKey: 'up:2' }),
    ]);
    expect(racing.map((r) => r.status).sort()).toEqual(['duplicate', 'ok']);
    expect(await levelOf(game, userId)).toBe(3);
    expect(await cashOf(game, userId)).toBe((7_000n - 300n - 6_000n) * 100n);
  });
});

describe(`acceptance 2 — hunting tools (${testBackend()})`, () => {
  it('rejects a purchase with insufficient cash and changes nothing', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 499);
    expect(await buyTool(game.ctx, { userId, tool: 'knife' })).toEqual({
      status: 'insufficient_funds',
      priceCenti: 50_000n,
      cashCenti: 49_900n,
    });
    expect(await ownedCount(userId)).toBe(0);
    expect(await cashOf(game, userId)).toBe(49_900n);
  });

  it('has no level requirement and no prerequisite tool', async () => {
    const userId = await newPlayer(game); // level 1
    await grantPoints(game, userId, 4_000_000);
    expect(await buyTool(game.ctx, { userId, tool: 'magic_wand' })).toMatchObject({
      status: 'ok',
      equipped: true,
      cashCenti: 0n,
    });
  });

  it('never sells the same tool twice, even to concurrent requests', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 1_000);
    const results = await Promise.all([
      buyTool(game.ctx, { userId, tool: 'knife' }),
      buyTool(game.ctx, { userId, tool: 'knife' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['already_owned', 'ok']);
    expect(await buyTool(game.ctx, { userId, tool: 'knife' })).toEqual({
      status: 'already_owned',
      tool: 'knife',
    });
    expect(await ownedCount(userId)).toBe(1);
    expect(await cashOf(game, userId)).toBe(50_000n);
  });

  it('dedupes a repeated purchase request by idempotency key', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 10_000);
    await buyTool(game.ctx, { userId, tool: 'axe', idempotencyKey: 'buy:axe' });
    expect(
      await buyTool(game.ctx, { userId, tool: 'axe', idempotencyKey: 'buy:axe' }),
    ).toMatchObject({ status: 'duplicate' });
    expect(await cashOf(game, userId)).toBe(250_000n);
  });

  it('equips only owned tools, one at a time; later purchases do not re-equip', async () => {
    const userId = await newPlayer(game);
    await grantPoints(game, userId, 8_000);
    expect(await buyTool(game.ctx, { userId, tool: 'knife' })).toMatchObject({ equipped: true });
    expect(await buyTool(game.ctx, { userId, tool: 'axe' })).toMatchObject({ equipped: false });
    expect(await equipTool(game.ctx, { userId, tool: 'sword' })).toEqual({
      status: 'not_owned',
      tool: 'sword',
    });
    expect(await equipTool(game.ctx, { userId, tool: 'axe' })).toEqual({
      status: 'ok',
      tool: 'axe',
    });
    const [row] = await game.ctx.db
      .select({ tool: playerState.equippedTool })
      .from(playerState)
      .where(eq(playerState.userId, userId));
    expect(row?.tool).toBe('axe');
  });
});

describe('money is conserved', () => {
  it('every transaction so far sums to zero and no user wallet is negative', async () => {
    const [unbalanced] = await queryRows<{ n: string }>(
      game.ctx.db,
      sql`SELECT count(*)::text AS n FROM (
            SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount) <> 0
          ) x`,
    );
    expect(unbalanced?.n).toBe('0');
    const [negative] = await queryRows<{ n: string }>(
      game.ctx.db,
      sql`SELECT count(*)::text AS n FROM wallets WHERE kind <> 'system' AND balance < 0`,
    );
    expect(negative?.n).toBe('0');
    const [entries] = await game.ctx.db.select({ n: count() }).from(ledgerEntries);
    expect(entries?.n).toBeGreaterThan(0);
  });
});
