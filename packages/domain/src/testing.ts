import type { CurseKind, FoodKind, ToolKind } from '@lulu/config';
import { curses, huntingGrounds, inventory, playerState, users } from '@lulu/database';
import type { TestDatabase } from '@lulu/database/testing';
import { createTestDatabase } from '@lulu/database/testing';
import { and, eq, sql } from 'drizzle-orm';
import { ensureDefaultConfig } from './config-service.ts';
import type { Clock, DomainContext, Rng } from './context.ts';
import { createDomainContext } from './context.ts';
import { registerGroup } from './groups.ts';
import { postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { registerPlayer } from './players.ts';
import { buyTool } from './tools.ts';

/** A clock the test moves by hand. */
export class TestClock implements Clock {
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}

/**
 * Deterministic randomness: queued values are returned first (each must fall in the
 * requested range), then a fallback picks the range minimum, maximum or midpoint.
 */
export class TestRng implements Rng {
  private queue: number[] = [];
  fallback: 'min' | 'max' | 'mid' = 'min';
  /** Every range requested, for assertions. */
  readonly calls: [number, number][] = [];

  push(...values: number[]): this {
    this.queue.push(...values);
    return this;
  }

  int(min: number, max: number): number {
    this.calls.push([min, max]);
    const next = this.queue.shift();
    if (next !== undefined) {
      if (next < min || next > max)
        throw new RangeError(`scripted ${next} outside [${min}, ${max}]`);
      return next;
    }
    if (this.fallback === 'max') return max;
    if (this.fallback === 'mid') return Math.floor((min + max) / 2);
    return min;
  }
}

export interface TestGame {
  db: TestDatabase;
  ctx: DomainContext;
  clock: TestClock;
  rng: TestRng;
  close(): Promise<void>;
}

export const TEST_START = '2026-10-02T08:00:00.000Z';

/** Fresh migrated database with the default config, a test clock and a scripted RNG. */
export async function createTestGame(start: string = TEST_START): Promise<TestGame> {
  const db = await createTestDatabase();
  await ensureDefaultConfig(db.db);
  const clock = new TestClock(start);
  const rng = new TestRng();
  return {
    db,
    ctx: createDomainContext(db.db, { clock, rng }),
    clock,
    rng,
    close: () => db.close(),
  };
}

let nextPlatformId = 1;

export async function newPlayer(game: TestGame, name = 'لولوی آزمایشی'): Promise<number> {
  const result = await registerPlayer(game.ctx, {
    platform: 'telegram',
    platformUserId: String(nextPlatformId++),
    displayName: name,
  });
  if (result.status !== 'ok') throw new Error('could not register test player');
  return result.userId;
}

export async function newGroup(game: TestGame, title = 'گروه آزمایشی'): Promise<number> {
  const { groupId } = await registerGroup(game.ctx, {
    platform: 'telegram',
    platformChatId: `-100${nextPlatformId++}`,
    title,
  });
  return groupId;
}

/** Credits whole points from the admin adjustment account (test setup only). */
export async function grantPoints(game: TestGame, userId: number, points: number): Promise<void> {
  await game.ctx.db.transaction(async (tx) => {
    const { cash } = await userWallets(tx, userId);
    const amount = pointsToCenti(points);
    await postTransaction(tx, {
      kind: 'test_grant',
      effectiveAt: game.clock.now(),
      userId,
      entries: [
        { walletId: await systemWalletId(tx, 'adjust:admin'), amount: -amount },
        { walletId: cash.id, amount },
      ],
    });
  });
}

export async function cashOf(game: TestGame, userId: number): Promise<bigint> {
  return (await userWallets(game.ctx.db, userId)).cash.balance;
}

export async function setLevel(game: TestGame, userId: number, level: number): Promise<void> {
  await game.ctx.db.update(playerState).set({ level }).where(eq(playerState.userId, userId));
}

export async function levelOf(game: TestGame, userId: number): Promise<number> {
  const [row] = await game.ctx.db
    .select({ level: playerState.level })
    .from(playerState)
    .where(eq(playerState.userId, userId));
  return row?.level ?? 0;
}

export async function giveFood(
  game: TestGame,
  userId: number,
  food: FoodKind,
  quantity: number,
): Promise<void> {
  await game.ctx.db
    .insert(inventory)
    .values({ userId, food, quantity })
    .onConflictDoUpdate({
      target: [inventory.userId, inventory.food],
      set: { quantity: sql`${inventory.quantity} + ${quantity}` },
    });
}

export async function foodOf(game: TestGame, userId: number, food: FoodKind): Promise<number> {
  const [row] = await game.ctx.db
    .select({ quantity: inventory.quantity })
    .from(inventory)
    .where(and(eq(inventory.userId, userId), eq(inventory.food, food)));
  return row?.quantity ?? 0;
}

/** Buys and equips a tool with freshly granted points. */
export async function giveTool(game: TestGame, userId: number, tool: ToolKind): Promise<void> {
  await grantPoints(game, userId, await priceOf(game, tool));
  const bought = await buyTool(game.ctx, { userId, tool });
  if (bought.status !== 'ok') throw new Error(`could not buy ${tool}: ${bought.status}`);
  await game.ctx.db
    .update(playerState)
    .set({ equippedTool: tool })
    .where(eq(playerState.userId, userId));
}

async function priceOf(game: TestGame, tool: ToolKind): Promise<number> {
  const { config } = await game.ctx.config.effectiveAt(game.ctx.db, game.clock.now());
  return config.tools[tool].price;
}

export async function setCurseLevel(
  game: TestGame,
  groupId: number,
  kind: CurseKind,
  level: number,
): Promise<void> {
  await game.ctx.db
    .update(curses)
    .set({ level })
    .where(and(eq(curses.groupId, groupId), eq(curses.kind, kind)));
}

export async function setHuntingGroundLevel(
  game: TestGame,
  groupId: number,
  level: number,
): Promise<void> {
  await game.ctx.db
    .update(huntingGrounds)
    .set({ level })
    .where(eq(huntingGrounds.groupId, groupId));
}

export async function banPlayer(game: TestGame, userId: number, reason = 'آزمایش'): Promise<void> {
  await game.ctx.db
    .update(users)
    .set({ bannedAt: game.clock.now(), banReason: reason })
    .where(eq(users.id, userId));
}
