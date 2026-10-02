/**
 * Acceptance 5 (spec §19.5): the hunt cooldown applies after a failed attempt, and is
 * not consumed before the player has a tool (or the minimum level).
 */
import { cooldowns, transactions } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { hunt } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  createTestGame,
  foodOf,
  giveTool,
  newGroup,
  newPlayer,
  setCurseLevel,
  setLevel,
} from '@lulu/domain/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let group: number;
let otherGroup: number;
const T0 = Date.parse(TEST_START);

beforeAll(async () => {
  game = await createTestGame();
  group = await newGroup(game);
  otherGroup = await newGroup(game);
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
  game.rng.fallback = 'min';
});

const tryHunt = (userId: number, groupId = group) => hunt(game.ctx, { userId, groupId });
const huntCooldownRow = async (userId: number) =>
  (
    await game.ctx.db
      .select()
      .from(cooldowns)
      .where(and(eq(cooldowns.userId, userId), eq(cooldowns.kind, 'hunt')))
  )[0];

async function hunter(level = 2) {
  const userId = await newPlayer(game);
  await setLevel(game, userId, level);
  await giveTool(game, userId, 'knife'); // 60 % success
  return userId;
}

describe(`acceptance 5 — hunt cooldown (${testBackend()})`, () => {
  it('without a tool only gives guidance and uses no cooldown', async () => {
    const userId = await newPlayer(game);
    await setLevel(game, userId, 2);
    expect(await tryHunt(userId)).toEqual({ status: 'no_tool' });
    expect(await huntCooldownRow(userId)).toBeUndefined();
  });

  it('below level 2 only gives guidance, even with a tool, and uses no cooldown', async () => {
    const userId = await hunter(1);
    expect(await tryHunt(userId)).toEqual({ status: 'level_too_low', minLevel: 2 });
    expect(await huntCooldownRow(userId)).toBeUndefined();
    await setLevel(game, userId, 2);
    expect((await tryHunt(userId)).status).toMatch(/success|failed/);
  });

  it('starts the 3600 s cooldown after a failed attempt; it ends exactly at 3600 s', async () => {
    const userId = await hunter();
    game.rng.push(6_000); // knife succeeds on rolls 0..5999
    expect(await tryHunt(userId)).toEqual({
      status: 'failed',
      tool: 'knife',
      nextAvailableAt: new Date(T0 + 3_600_000),
    });
    game.clock.set(new Date(T0 + 3_599_999));
    expect(await tryHunt(userId)).toMatchObject({ status: 'cooldown', remainingMs: 1 });
    game.clock.set(new Date(T0 + 3_600_000));
    game.rng.push(5_999, 0); // success, then the first prey
    expect(await tryHunt(userId)).toMatchObject({ status: 'success', food: 'bone' });
    expect(await foodOf(game, userId, 'bone')).toBe(1);
  });

  it('shares the hunt cooldown across groups and serializes simultaneous attempts', async () => {
    const userId = await hunter();
    const results = await Promise.all([tryHunt(userId, group), tryHunt(userId, otherGroup)]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 'cooldown')).toHaveLength(1);
    const audit = await game.ctx.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.kind, 'hunt')));
    expect(audit).toHaveLength(1);
  });

  it('applies the hunting-haste buff of the group: level 4 → 48 minutes', async () => {
    const buffed = await newGroup(game, 'شتاب');
    await setCurseLevel(game, buffed, 'hunt_haste', 4);
    const userId = await hunter();
    const result = await tryHunt(userId, buffed);
    expect(result).toMatchObject({ nextAvailableAt: new Date(T0 + 48 * 60_000) });
    expect(await huntCooldownRow(userId)).toMatchObject({
      baseSeconds: 3600,
      effectiveSeconds: 2880,
      groupId: buffed,
    });
  });

  it("rolls success with the equipped tool's chance, then the prey", async () => {
    const userId = await hunter(3);
    game.rng.push(5_999, 2_399 + 4_000); // success; second roll lands in «mouse»
    expect(await tryHunt(userId)).toMatchObject({ status: 'success', food: 'mouse' });
    const [range] = game.rng.calls.slice(-2);
    expect(range).toEqual([0, 9_999]);
  });
});
