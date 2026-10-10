import { CURSE_KINDS, FOOD_KINDS } from '@lulu/config';
import type { CurseKind, FoodKind, GameConfig } from '@lulu/config';
import type { Executor, Tx } from '@lulu/database';
import {
  bloodBanks,
  curses,
  huntingGrounds,
  inTransaction,
  inventory,
  memberships,
  settlementInventory,
  settlements,
  users,
} from '@lulu/database';
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { DomainError } from './context.ts';
import type { SystemWalletCode } from './ledger.ts';
import {
  findTransactionByKey,
  groupBloodBankWallet,
  postTransaction,
  systemWalletId,
  userWallets,
} from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction, touchMembership } from './players.ts';

/**
 * Role of the acting member in the group, as verified live with the platform by the
 * caller (bot layer). Only owners and admins of the group spend its treasury.
 */
export type GroupRole = 'owner' | 'admin' | 'member';

const canManage = (role: GroupRole) => role === 'owner' || role === 'admin';

interface CityState {
  groupId: number;
  level: number;
  huntPoints: number;
  huntPointsDonatedTotal: number;
  bloodDonatedTotal: bigint;
  bankLevel: number;
  groundLevel: number;
  curseLevels: Record<CurseKind, number>;
}

/**
 * Locks the city row: the group-wide mutex for upgrades and donations. Lock order is
 * always player → city → wallets, so donations and upgrades cannot deadlock.
 */
export async function lockCity(tx: Tx, groupId: number): Promise<CityState> {
  const [row] = await tx
    .select()
    .from(settlements)
    .where(eq(settlements.groupId, groupId))
    .for('update');
  if (!row) throw new DomainError('unknown_group', `group ${groupId} has no city`);
  return readCity(tx, row);
}

async function readCity(ex: Executor, row: typeof settlements.$inferSelect): Promise<CityState> {
  const [bank] = await ex.select().from(bloodBanks).where(eq(bloodBanks.groupId, row.groupId));
  const [ground] = await ex
    .select()
    .from(huntingGrounds)
    .where(eq(huntingGrounds.groupId, row.groupId));
  const curseRows = await ex.select().from(curses).where(eq(curses.groupId, row.groupId));
  const curseLevels = Object.fromEntries(
    CURSE_KINDS.map((k) => [k, curseRows.find((c) => c.kind === k)?.level ?? 0]),
  ) as Record<CurseKind, number>;
  return {
    groupId: row.groupId,
    level: row.level,
    huntPoints: row.huntPoints,
    huntPointsDonatedTotal: row.huntPointsDonatedTotal,
    bloodDonatedTotal: row.bloodDonatedTotal,
    bankLevel: bank?.level ?? 1,
    groundLevel: ground?.level ?? 1,
    curseLevels,
  };
}

/**
 * Active population (suggested rule, §11): registered, unbanned players who are
 * current members of this group and had a successful activity here within the window.
 */
export async function activePopulation(
  ex: Executor,
  groupId: number,
  now: Date,
  windowDays: number,
): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(activeMemberFilter(groupId, now, windowDays));
  return row?.n ?? 0;
}

/** The same players as activePopulation, by user id (ascending). */
export async function activeMemberIds(
  ex: Executor,
  groupId: number,
  now: Date,
  windowDays: number,
): Promise<number[]> {
  const rows = await ex
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(activeMemberFilter(groupId, now, windowDays))
    .orderBy(asc(memberships.userId));
  return rows.map((r) => r.userId);
}

function activeMemberFilter(groupId: number, now: Date, windowDays: number) {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  return and(
    eq(memberships.groupId, groupId),
    eq(memberships.status, 'member'),
    gte(memberships.lastSuccessAt, since),
    isNull(users.bannedAt),
  );
}

const bankCaps = (config: GameConfig, bankLevel: number) => {
  const level = config.bloodBank.levels[bankLevel - 1];
  if (!level) throw new DomainError('bad_level', `no blood bank level ${bankLevel}`);
  return level;
};

// ───────────────────────── view ─────────────────────────

export interface CityView {
  level: number;
  maxLevel: number;
  population: { active: number; windowDays: number; requiredForNext: number | null };
  huntStore: {
    points: number;
    donatedTotal: number;
    donatedByFood: Record<FoodKind, number>;
  };
  bloodBank: { balanceCenti: bigint; level: number; donatedTotalCenti: bigint };
  huntingGround: { level: number; maxForBank: number };
  curses: Record<CurseKind, { level: number; maxForBank: number }>;
  next: {
    city: { level: number; bloodBankCostCenti: bigint; huntPointsCost: number } | null;
    bloodBank: { level: number; costCenti: bigint; requiresCityLevel: number } | null;
    huntingGround: { level: number; costCenti: bigint } | null;
    curses: Record<CurseKind, { level: number; costCenti: bigint } | null>;
  };
}

/** «لولوآباد»: the five pillars of the group's city. */
export async function cityView(ctx: DomainContext, groupId: number): Promise<CityView> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    const [row] = await tx.select().from(settlements).where(eq(settlements.groupId, groupId));
    if (!row) throw new DomainError('unknown_group', `group ${groupId} has no city`);
    const city = await readCity(tx, row);
    const bank = await groupBloodBankWallet(tx, groupId);
    const caps = bankCaps(config, city.bankLevel);
    const history = await tx
      .select()
      .from(settlementInventory)
      .where(eq(settlementInventory.groupId, groupId));
    const nextCity = config.city.levels.find((l) => l.level === city.level + 1) ?? null;
    const nextBank = config.bloodBank.levels[city.bankLevel] ?? null;
    const nextGround = config.huntingGrounds[city.groundLevel] ?? null;

    return {
      level: city.level,
      maxLevel: config.city.levels.length + 1,
      population: {
        active: await activePopulation(tx, groupId, now, config.city.activePopulationWindowDays),
        windowDays: config.city.activePopulationWindowDays,
        requiredForNext: nextCity?.requiredActivePopulation ?? null,
      },
      huntStore: {
        points: city.huntPoints,
        donatedTotal: city.huntPointsDonatedTotal,
        donatedByFood: Object.fromEntries(
          FOOD_KINDS.map((f) => [f, history.find((h) => h.food === f)?.donatedCount ?? 0]),
        ) as Record<FoodKind, number>,
      },
      bloodBank: {
        balanceCenti: bank.balance,
        level: city.bankLevel,
        donatedTotalCenti: city.bloodDonatedTotal,
      },
      huntingGround: { level: city.groundLevel, maxForBank: caps.maxHuntingGroundLevel },
      curses: Object.fromEntries(
        CURSE_KINDS.map((k) => [k, { level: city.curseLevels[k], maxForBank: caps.maxCurseLevel }]),
      ) as Record<CurseKind, { level: number; maxForBank: number }>,
      next: {
        city: nextCity && {
          level: nextCity.level,
          bloodBankCostCenti: pointsToCenti(nextCity.bloodBankCost),
          huntPointsCost: nextCity.huntPointsCost,
        },
        bloodBank: nextBank?.upgradeCost
          ? {
              level: nextBank.level,
              costCenti: pointsToCenti(nextBank.upgradeCost),
              requiresCityLevel: nextBank.level,
            }
          : null,
        huntingGround: nextGround?.upgradeCost
          ? { level: nextGround.level, costCenti: pointsToCenti(nextGround.upgradeCost) }
          : null,
        curses: Object.fromEntries(
          CURSE_KINDS.map((k) => {
            const cost = config.curses[k].levelCosts[city.curseLevels[k]];
            return [
              k,
              cost === undefined
                ? null
                : { level: city.curseLevels[k] + 1, costCenti: pointsToCenti(cost) },
            ];
          }),
        ) as Record<CurseKind, { level: number; costCenti: bigint } | null>,
      },
    };
  });
}

// ───────────────────────── donations (any member) ─────────────────────────

export type DonationResult =
  | { status: 'ok'; amountCenti: bigint; bankBalanceCenti: bigint; cashCenti: bigint }
  | { status: 'invalid_amount' }
  | { status: 'insufficient_funds'; availableCenti: bigint }
  | { status: 'duplicate' }
  | { status: 'banned' };

/**
 * «اهدای خون»: a final gift from the donor's cash to this group's blood bank. Nobody —
 * neither the donor nor an admin — can take it back out personally.
 */
export async function donateBlood(
  ctx: DomainContext,
  input: { userId: number; groupId: number; amountCenti: bigint; idempotencyKey?: string },
): Promise<DonationResult> {
  if (input.amountCenti <= 0n) return { status: 'invalid_amount' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }
    await lockCity(tx, input.groupId);
    const { cash } = await userWallets(tx, input.userId);
    if (cash.balance < input.amountCenti) {
      return { status: 'insufficient_funds', availableCenti: cash.balance };
    }
    const bank = await groupBloodBankWallet(tx, input.groupId);
    await postTransaction(tx, {
      kind: 'blood_donation',
      effectiveAt: now,
      userId: input.userId,
      groupId: input.groupId,
      configVersionId: versionId,
      entries: [
        { walletId: cash.id, amount: -input.amountCenti },
        { walletId: bank.id, amount: input.amountCenti },
      ],
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await tx
      .update(settlements)
      .set({
        bloodDonatedTotal: sql`${settlements.bloodDonatedTotal} + ${input.amountCenti.toString()}::numeric`,
        updatedAt: now,
      })
      .where(eq(settlements.groupId, input.groupId));
    await touchMembership(tx, input.groupId, input.userId, now, false);
    return {
      status: 'ok',
      amountCenti: input.amountCenti,
      bankBalanceCenti: bank.balance + input.amountCenti,
      cashCenti: cash.balance - input.amountCenti,
    };
  });
}

export type HuntDonationResult =
  | { status: 'ok'; food: FoodKind; count: number; huntPoints: number; poolPoints: number }
  | { status: 'invalid_count' }
  | { status: 'not_enough_food'; have: number }
  | { status: 'duplicate' }
  | { status: 'banned' };

/**
 * «اهدای شکار»: prey leaves the donor's cellar; count × nutrition joins the group's
 * hunt-point pool (the resource for city upgrades, not money). The kind and count of
 * donated prey are kept separately as history.
 */
export async function donateHunt(
  ctx: DomainContext,
  input: {
    userId: number;
    groupId: number;
    food: FoodKind;
    count: number;
    idempotencyKey?: string;
  },
): Promise<HuntDonationResult> {
  if (!Number.isSafeInteger(input.count) || input.count < 1) return { status: 'invalid_count' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }
    const city = await lockCity(tx, input.groupId);
    const [stock] = await tx
      .select({ quantity: inventory.quantity })
      .from(inventory)
      .where(and(eq(inventory.userId, input.userId), eq(inventory.food, input.food)));
    const have = stock?.quantity ?? 0;
    if (have < input.count) return { status: 'not_enough_food', have };

    const points = input.count * config.foods[input.food].nutrition;
    await tx
      .update(inventory)
      .set({ quantity: sql`${inventory.quantity} - ${input.count}` })
      .where(and(eq(inventory.userId, input.userId), eq(inventory.food, input.food)));
    await tx
      .update(settlements)
      .set({
        huntPoints: sql`${settlements.huntPoints} + ${points}`,
        huntPointsDonatedTotal: sql`${settlements.huntPointsDonatedTotal} + ${points}`,
        updatedAt: now,
      })
      .where(eq(settlements.groupId, input.groupId));
    await tx
      .insert(settlementInventory)
      .values({ groupId: input.groupId, food: input.food, donatedCount: input.count })
      .onConflictDoUpdate({
        target: [settlementInventory.groupId, settlementInventory.food],
        set: { donatedCount: sql`${settlementInventory.donatedCount} + ${input.count}` },
      });
    await postTransaction(tx, {
      kind: 'hunt_donation',
      effectiveAt: now,
      userId: input.userId,
      groupId: input.groupId,
      configVersionId: versionId,
      entries: [],
      metadata: { food: input.food, count: input.count, points },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await touchMembership(tx, input.groupId, input.userId, now, false);
    return {
      status: 'ok',
      food: input.food,
      count: input.count,
      huntPoints: points,
      poolPoints: city.huntPoints + points,
    };
  });
}

// ───────────────────────── upgrades (owner/admin only) ─────────────────────────

export type GroupUpgradeResult =
  | { status: 'ok'; newLevel: number; costCenti: bigint; bankBalanceCenti: bigint }
  /** Only the group's owner or admins may spend the city's resources. */
  | { status: 'not_admin' }
  | { status: 'stale'; currentLevel: number }
  | { status: 'max_level'; currentLevel: number }
  | { status: 'population_too_low'; active: number; required: number }
  | { status: 'insufficient_bank'; costCenti: bigint; balanceCenti: bigint }
  | { status: 'insufficient_hunt_points'; cost: number; available: number }
  /** The blood bank cannot outgrow the city. */
  | { status: 'requires_city_level'; required: number }
  /** Hunting ground and curses are capped by the blood bank level. */
  | { status: 'requires_bank_level'; maxForBank: number }
  | { status: 'duplicate' }
  | { status: 'banned' };

interface UpgradeInput {
  groupId: number;
  actorUserId: number;
  actorRole: GroupRole;
  expectedLevel: number;
  idempotencyKey?: string;
}

/** A refusal, or the cost of the upgrade and the change to apply once it is paid. */
type UpgradeDecision =
  GroupUpgradeResult | { costCenti: bigint; huntPointsCost?: number; apply: () => Promise<void> };

interface UpgradePlan {
  currentLevel: number;
  decide(city: CityState, config: GameConfig): UpgradeDecision | Promise<UpgradeDecision>;
  burn: SystemWalletCode;
  kind: string;
}

async function runUpgrade(
  ctx: DomainContext,
  input: UpgradeInput,
  plan: (tx: Tx, city: CityState, now: Date) => UpgradePlan,
): Promise<GroupUpgradeResult> {
  if (!canManage(input.actorRole)) return { status: 'not_admin' };
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const actor = await beginPlayerAction(tx, ctx, input.actorUserId, now);
    if (actor.banned) return { status: 'banned' };
    if (input.idempotencyKey && (await findTransactionByKey(tx, input.idempotencyKey))) {
      return { status: 'duplicate' };
    }
    const city = await lockCity(tx, input.groupId);
    const p = plan(tx, city, now);
    if (p.currentLevel !== input.expectedLevel)
      return { status: 'stale', currentLevel: p.currentLevel };

    const bank = await groupBloodBankWallet(tx, input.groupId);
    const decision = await p.decide(city, config);
    if ('status' in decision) return decision;
    if (bank.balance < decision.costCenti) {
      return {
        status: 'insufficient_bank',
        costCenti: decision.costCenti,
        balanceCenti: bank.balance,
      };
    }
    const huntPointsCost = decision.huntPointsCost ?? 0;
    if (city.huntPoints < huntPointsCost) {
      return {
        status: 'insufficient_hunt_points',
        cost: huntPointsCost,
        available: city.huntPoints,
      };
    }

    await postTransaction(tx, {
      kind: p.kind,
      effectiveAt: now,
      userId: input.actorUserId,
      groupId: input.groupId,
      configVersionId: versionId,
      entries: [
        { walletId: bank.id, amount: -decision.costCenti },
        { walletId: await systemWalletId(tx, p.burn), amount: decision.costCenti },
      ],
      metadata: {
        fromLevel: p.currentLevel,
        toLevel: p.currentLevel + 1,
        huntPointsCost,
        actorRole: input.actorRole,
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (huntPointsCost > 0) {
      await tx
        .update(settlements)
        .set({ huntPoints: sql`${settlements.huntPoints} - ${huntPointsCost}`, updatedAt: now })
        .where(eq(settlements.groupId, input.groupId));
    }
    await decision.apply();
    return {
      status: 'ok',
      newLevel: p.currentLevel + 1,
      costCenti: decision.costCenti,
      bankBalanceCenti: bank.balance - decision.costCenti,
    };
  });
}

/**
 * «ارتقای آبادی»: needs the active population (checked now; a later drop never lowers
 * the level), blood-bank points and hunt points, both consumed by the upgrade.
 */
export function upgradeCity(ctx: DomainContext, input: UpgradeInput): Promise<GroupUpgradeResult> {
  return runUpgrade(ctx, input, (tx, city, now) => ({
    currentLevel: city.level,
    kind: 'city_upgrade',
    burn: 'burn:city_upgrade',
    async decide(c, config) {
      const next = config.city.levels.find((l) => l.level === c.level + 1);
      if (!next) return { status: 'max_level', currentLevel: c.level };
      const active = await activePopulation(
        tx,
        c.groupId,
        now,
        config.city.activePopulationWindowDays,
      );
      if (active < next.requiredActivePopulation) {
        return { status: 'population_too_low', active, required: next.requiredActivePopulation };
      }
      return {
        costCenti: pointsToCenti(next.bloodBankCost),
        huntPointsCost: next.huntPointsCost,
        apply: async () => {
          await tx
            .update(settlements)
            .set({ level: next.level, updatedAt: now })
            .where(eq(settlements.groupId, c.groupId));
        },
      };
    },
  }));
}

/** «ارتقای بانک خون»: paid from the bank itself; never above the city level. */
export function upgradeBloodBank(
  ctx: DomainContext,
  input: UpgradeInput,
): Promise<GroupUpgradeResult> {
  return runUpgrade(ctx, input, (tx, city, now) => ({
    currentLevel: city.bankLevel,
    kind: 'blood_bank_upgrade',
    burn: 'burn:blood_bank_upgrade',
    decide(c, config) {
      const next = config.bloodBank.levels[c.bankLevel];
      if (!next?.upgradeCost) return { status: 'max_level', currentLevel: c.bankLevel };
      if (next.level > c.level) return { status: 'requires_city_level', required: next.level };
      return {
        costCenti: pointsToCenti(next.upgradeCost),
        apply: async () => {
          await tx
            .update(bloodBanks)
            .set({ level: next.level, updatedAt: now })
            .where(eq(bloodBanks.groupId, c.groupId));
        },
      };
    },
  }));
}

/** «ارتقای شکارگاه»: paid from the bank; capped by the bank level. */
export function upgradeHuntingGround(
  ctx: DomainContext,
  input: UpgradeInput,
): Promise<GroupUpgradeResult> {
  return runUpgrade(ctx, input, (tx, city, now) => ({
    currentLevel: city.groundLevel,
    kind: 'hunting_ground_upgrade',
    burn: 'burn:hunting_ground_upgrade',
    decide(c, config) {
      const next = config.huntingGrounds[c.groundLevel];
      if (!next?.upgradeCost) return { status: 'max_level', currentLevel: c.groundLevel };
      const cap = bankCaps(config, c.bankLevel).maxHuntingGroundLevel;
      if (next.level > cap) return { status: 'requires_bank_level', maxForBank: cap };
      return {
        costCenti: pointsToCenti(next.upgradeCost),
        apply: async () => {
          await tx
            .update(huntingGrounds)
            .set({ level: next.level, updatedAt: now })
            .where(eq(huntingGrounds.groupId, c.groupId));
        },
      };
    },
  }));
}

/** Buys the next level of one curse from the bank; capped by the bank level. */
export function upgradeCurse(
  ctx: DomainContext,
  input: UpgradeInput & { curse: CurseKind },
): Promise<GroupUpgradeResult> {
  return runUpgrade(ctx, input, (tx, city, now) => ({
    currentLevel: city.curseLevels[input.curse],
    kind: 'curse_upgrade',
    burn: 'burn:curse',
    decide(c, config) {
      const level = c.curseLevels[input.curse];
      const cost = config.curses[input.curse].levelCosts[level];
      if (cost === undefined) return { status: 'max_level', currentLevel: level };
      const cap = bankCaps(config, c.bankLevel).maxCurseLevel;
      if (level + 1 > cap) return { status: 'requires_bank_level', maxForBank: cap };
      return {
        costCenti: pointsToCenti(cost),
        apply: async () => {
          await tx
            .update(curses)
            .set({ level: level + 1, updatedAt: now })
            .where(and(eq(curses.groupId, c.groupId), eq(curses.kind, input.curse)));
        },
      };
    },
  }));
}
