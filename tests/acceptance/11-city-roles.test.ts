/**
 * Acceptance 11 (spec §19.11): only the group's owner/admins spend its treasury, a
 * regular member cannot, and buffs of two cities never combine. Also covers the
 * upgrade rules of «لولوآباد» (population, blood bank, hunt points, caps).
 */
import { testBackend, usingRealPostgres } from '@lulu/database/testing';
import {
  claimLolo,
  cityView,
  donateBlood,
  donateHunt,
  memberLeftGroup,
  upgradeBloodBank,
  upgradeCity,
  upgradeCurse,
  upgradeHuntingGround,
} from '@lulu/domain';
import type { GroupRole } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  TEST_START,
  activeMembers,
  banPlayer,
  cashOf,
  createTestGame,
  foodOf,
  fundBloodBank,
  giveFood,
  grantPoints,
  newGroup,
  newPlayer,
  setCurseLevel,
} from '@lulu/domain/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
const T0 = Date.parse(TEST_START);
const DAY = 86_400_000;

beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
});

const P = (points: number) => BigInt(points) * 100n;
const view = (groupId: number) => cityView(game.ctx, groupId);
const as = (actorUserId: number, actorRole: GroupRole, groupId: number, expectedLevel: number) => ({
  groupId,
  actorUserId,
  actorRole,
  expectedLevel,
});

/** A city with 3 active members, 20 000 in the bank and 100 hunt points. */
async function readyCity() {
  const groupId = await newGroup(game);
  const [admin, member] = await activeMembers(game, groupId, 3);
  await fundBloodBank(game, groupId, 20_000);
  await giveFood(game, member!, 'bone', 100);
  expect(
    (await donateHunt(game.ctx, { userId: member!, groupId, food: 'bone', count: 100 })).status,
  ).toBe('ok');
  return { groupId, admin: admin!, member: member! };
}

describe(`acceptance 11 — who may spend the city's treasury (${testBackend()})`, () => {
  it('rejects every upgrade by a regular member and leaves the treasury untouched', async () => {
    const { groupId, member } = await readyCity();
    const before = await view(groupId);
    const m = as(member, 'member', groupId, 1);
    expect(await upgradeCity(game.ctx, m)).toEqual({ status: 'not_admin' });
    expect(await upgradeBloodBank(game.ctx, m)).toEqual({ status: 'not_admin' });
    expect(await upgradeHuntingGround(game.ctx, m)).toEqual({ status: 'not_admin' });
    expect(
      await upgradeCurse(game.ctx, { ...as(member, 'member', groupId, 0), curse: 'lolo_echo' }),
    ).toEqual({
      status: 'not_admin',
    });
    expect(await view(groupId)).toEqual(before);
  });

  it('lets the owner or an admin upgrade, paying exactly from bank and hunt pool', async () => {
    const { groupId, admin } = await readyCity();
    expect(await upgradeCity(game.ctx, as(admin, 'admin', groupId, 1))).toEqual({
      status: 'ok',
      newLevel: 2,
      costCenti: P(10_000),
      bankBalanceCenti: P(10_000),
    });
    const v = await view(groupId);
    expect(v.level).toBe(2);
    expect(v.huntStore).toMatchObject({ points: 90, donatedTotal: 100 }); // history is kept
    expect(v.huntStore.donatedByFood.bone).toBe(100);
    expect(await upgradeBloodBank(game.ctx, as(admin, 'owner', groupId, 1))).toMatchObject({
      status: 'ok',
      newLevel: 2,
      costCenti: P(5_000),
    });
  });

  it('anyone can donate; the gift is final and cannot be taken out personally', async () => {
    const { groupId, member } = await readyCity();
    await grantPoints(game, member, 700);
    // cash: 1 point from the member's first lolo + 700 granted − 500 donated
    expect(
      await donateBlood(game.ctx, { userId: member, groupId, amountCenti: P(500) }),
    ).toMatchObject({
      status: 'ok',
      cashCenti: P(201),
    });
    expect(await cashOf(game, member)).toBe(P(201));
    expect((await view(groupId)).bloodBank).toMatchObject({
      balanceCenti: P(20_500),
      donatedTotalCenti: P(500),
    });
    expect(
      await donateBlood(game.ctx, { userId: member, groupId, amountCenti: P(10_000) }),
    ).toMatchObject({
      status: 'insufficient_funds',
    });
    expect(await donateBlood(game.ctx, { userId: member, groupId, amountCenti: 0n })).toEqual({
      status: 'invalid_amount',
    });
  });
});

describe(`acceptance 11 — upgrade rules (${testBackend()})`, () => {
  it('needs the active population; banned and departed members do not count', async () => {
    const groupId = await newGroup(game);
    const members = await activeMembers(game, groupId, 3);
    await fundBloodBank(game, groupId, 20_000);
    await giveFood(game, members[0]!, 'bone', 10);
    await donateHunt(game.ctx, { userId: members[0]!, groupId, food: 'bone', count: 10 });
    await banPlayer(game, members[1]!);
    await memberLeftGroup(game.ctx, { groupId, userId: members[2]! });
    expect(await upgradeCity(game.ctx, as(members[0]!, 'admin', groupId, 1))).toEqual({
      status: 'population_too_low',
      active: 1,
      required: 3,
    });
  });

  it('counts only activity within the last 7 days, and a later drop never lowers the level', async () => {
    const { groupId, admin } = await readyCity();
    expect((await upgradeCity(game.ctx, as(admin, 'admin', groupId, 1))).status).toBe('ok');
    game.clock.set(new Date(T0 + 8 * DAY));
    const v = await view(groupId);
    expect(v.population.active).toBe(0);
    expect(v.level).toBe(2);
    await fundBloodBank(game, groupId, 100_000);
    expect(await upgradeCity(game.ctx, as(admin, 'admin', groupId, 2))).toMatchObject({
      status: 'population_too_low',
    });
  });

  it('refuses without enough bank points or hunt points', async () => {
    const groupId = await newGroup(game);
    const [admin] = await activeMembers(game, groupId, 3);
    await fundBloodBank(game, groupId, 9_999);
    expect(await upgradeCity(game.ctx, as(admin!, 'admin', groupId, 1))).toEqual({
      status: 'insufficient_bank',
      costCenti: P(10_000),
      balanceCenti: P(9_999),
    });
    await fundBloodBank(game, groupId, 1);
    expect(await upgradeCity(game.ctx, as(admin!, 'admin', groupId, 1))).toEqual({
      status: 'insufficient_hunt_points',
      cost: 10,
      available: 0,
    });
  });

  it('keeps the bank at or below the city, and caps ground and curses by the bank', async () => {
    const { groupId, admin } = await readyCity();
    const a = (level: number) => as(admin, 'admin', groupId, level);
    expect(await upgradeBloodBank(game.ctx, a(1))).toEqual({
      status: 'requires_city_level',
      required: 2,
    });
    // bank level 1 opens neither hunting ground upgrades nor curses
    expect(await upgradeHuntingGround(game.ctx, a(1))).toEqual({
      status: 'requires_bank_level',
      maxForBank: 1,
    });
    expect(await upgradeCurse(game.ctx, { ...a(0), curse: 'hunt_haste' })).toEqual({
      status: 'requires_bank_level',
      maxForBank: 0,
    });

    await fundBloodBank(game, groupId, 100_000);
    await upgradeCity(game.ctx, a(1));
    await upgradeBloodBank(game.ctx, a(1));
    expect(await upgradeHuntingGround(game.ctx, a(1))).toMatchObject({ status: 'ok', newLevel: 2 });
    expect(await upgradeHuntingGround(game.ctx, a(2))).toEqual({
      status: 'requires_bank_level',
      maxForBank: 2,
    });
    expect(await upgradeCurse(game.ctx, { ...a(0), curse: 'hunt_haste' })).toMatchObject({
      status: 'ok',
      newLevel: 1,
      costCenti: P(10_000),
    });
    expect(await upgradeCurse(game.ctx, { ...a(1), curse: 'hunt_haste' })).toEqual({
      status: 'requires_bank_level',
      maxForBank: 1,
    });
    // each part upgrades independently
    expect((await view(groupId)).curses).toEqual({
      hunt_haste: { level: 1, maxForBank: 1 },
      lolo_echo: { level: 0, maxForBank: 1 },
    });
  });

  it('upgrades once when two admins confirm at the same time; stale and duplicate are refused', async () => {
    const { groupId, admin, member } = await readyCity();
    const results = await Promise.all([
      upgradeCity(game.ctx, as(admin, 'admin', groupId, 1)),
      upgradeCity(game.ctx, as(member, 'owner', groupId, 1)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'stale']);
    expect((await view(groupId)).bloodBank.balanceCenti).toBe(P(10_000));

    await fundBloodBank(game, groupId, 10_000);
    const key = { idempotencyKey: 'bank-up' };
    expect(
      (await upgradeBloodBank(game.ctx, { ...as(admin, 'admin', groupId, 1), ...key })).status,
    ).toBe('ok');
    expect(await upgradeBloodBank(game.ctx, { ...as(admin, 'admin', groupId, 1), ...key })).toEqual(
      {
        status: 'duplicate',
      },
    );
  });

  it('moves donated prey from the cellar into the hunt pool by nutrition', async () => {
    const groupId = await newGroup(game);
    const userId = await newPlayer(game);
    await giveFood(game, userId, 'deer', 3);
    expect(await donateHunt(game.ctx, { userId, groupId, food: 'deer', count: 4 })).toEqual({
      status: 'not_enough_food',
      have: 3,
    });
    expect(await donateHunt(game.ctx, { userId, groupId, food: 'deer', count: 2 })).toEqual({
      status: 'ok',
      food: 'deer',
      count: 2,
      huntPoints: 60,
      poolPoints: 60,
    });
    expect(await foodOf(game, userId, 'deer')).toBe(1);
    expect((await view(groupId)).huntStore.donatedByFood.deer).toBe(2);
  });
});

describe(`acceptance 11 — buffs of two cities never combine (${testBackend()})`, () => {
  it('uses only the buff of the group where the lolo happens', async () => {
    const echo2 = await newGroup(game, 'پژواک ۲');
    const echo4 = await newGroup(game, 'پژواک ۴');
    await setCurseLevel(game, echo2, 'lolo_echo', 2); // 300 × 0.90 = 270 s
    await setCurseLevel(game, echo4, 'lolo_echo', 4); // 300 × 0.80 = 240 s
    const userId = await newPlayer(game);
    await claimLolo(game.ctx, { userId, groupId: echo4 }); // member of both cities
    game.clock.set(new Date(T0 + 240_000));
    expect(await claimLolo(game.ctx, { userId, groupId: echo2 })).toMatchObject({
      status: 'ok',
      nextAvailableAt: new Date(T0 + 240_000 + 270_000), // not 300 × (1 − 0.1 − 0.2)
    });
  });
});

describe.runIf(usingRealPostgres)(
  'acceptance 11 — donations racing an upgrade on real PostgreSQL',
  () => {
    it('neither deadlocks nor loses a donation', async () => {
      const { groupId, admin } = await readyCity();
      const donors = await Promise.all(Array.from({ length: 6 }, () => newPlayer(game)));
      for (const d of donors) await grantPoints(game, d, 100);
      await Promise.all([
        ...donors.map((d) => donateBlood(game.ctx, { userId: d, groupId, amountCenti: P(100) })),
        upgradeCity(game.ctx, as(admin, 'admin', groupId, 1)),
      ]);
      expect((await view(groupId)).bloodBank.balanceCenti).toBe(P(20_000 + 600 - 10_000));
    });
  },
);
