/**
 * Acceptance 2 (spec §19.2): insufficient funds, and no duplicate purchase or upgrade
 * under concurrent or repeated requests.
 */
import { ledgerEntries, ownedTools } from '@lulu/database';
import { queryRows } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import {
  buyTool,
  hunt,
  playerProfile,
  previewLevelUpgrade,
  strongestTool,
  toolShop,
  upgradeLevel,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  cashOf,
  createTestGame,
  grantPoints,
  levelOf,
  newGroup,
  newPlayer,
  setLevel,
} from '@lulu/domain/testing';
import { DEFAULT_GAME_CONFIG } from '@lulu/config';
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
      inUse: 'magic_wand',
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

  it('always uses the strongest owned tool: a better purchase replaces it at once', async () => {
    const userId = await newPlayer(game);
    await setLevel(game, userId, 2);
    await grantPoints(game, userId, 63_000);
    expect(await buyTool(game.ctx, { userId, tool: 'knife' })).toMatchObject({ inUse: 'knife' });
    expect(await buyTool(game.ctx, { userId, tool: 'sword' })).toMatchObject({ inUse: 'sword' });
    // a weaker tool bought later never replaces a stronger one
    expect(await buyTool(game.ctx, { userId, tool: 'axe' })).toMatchObject({ inUse: 'sword' });

    const profile = await playerProfile(game.ctx, userId);
    expect(profile.tools).toEqual({ owned: ['knife', 'axe', 'sword'], equipped: 'sword' });
    const shop = await toolShop(game.ctx, userId);
    expect(shop.items.filter((i) => i.equipped).map((i) => i.tool)).toEqual(['sword']);

    game.rng.push(7_999, 0); // success under the sword's 80 % (not under the axe's 70 %)
    expect(await hunt(game.ctx, { userId, groupId: await newGroup(game) })).toMatchObject({
      status: 'success',
      tool: 'sword',
    });
  });

  it('ranks tools by success chance, then price, then list order', () => {
    const c = structuredClone(DEFAULT_GAME_CONFIG);
    expect(strongestTool(c, [])).toBeNull();
    expect(strongestTool(c, ['bow', 'knife'])).toBe('bow');
    c.tools.knife.successBp = 9_500; // a config change re-ranks
    expect(strongestTool(c, ['bow', 'knife'])).toBe('knife');
    c.tools.knife.successBp = 9_000;
    expect(strongestTool(c, ['bow', 'knife'])).toBe('bow'); // tie: the dearer one
    c.tools.knife.price = c.tools.bow.price;
    expect(strongestTool(c, ['bow', 'knife'])).toBe('bow'); // full tie: later in the list
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
