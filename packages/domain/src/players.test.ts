import { transactions, userIdentities, users, wallets } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGroup } from './groups.ts';
import { registerPlayer } from './players.ts';
import type { TestGame } from './testing.ts';
import { cashOf, createTestGame, levelOf } from './testing.ts';

let game: TestGame;
beforeAll(async () => {
  game = await createTestGame();
});
afterAll(async () => {
  await game.close();
});

const identity = (id: string, name = 'علی') => ({
  platform: 'telegram' as const,
  platformUserId: id,
  displayName: name,
});

describe(`player registration (${testBackend()})`, () => {
  it('creates a level-1 player with zero balances and no reward', async () => {
    const result = await registerPlayer(game.ctx, identity('1001'));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.created).toBe(true);
    expect(await levelOf(game, result.userId)).toBe(1);
    expect(await cashOf(game, result.userId)).toBe(0n);
    const [tx] = await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(eq(transactions.userId, result.userId));
    expect(tx?.n).toBe(0);
  });

  it('is idempotent: repeating /start returns the same player and refreshes the name', async () => {
    const first = await registerPlayer(game.ctx, identity('1002', 'قدیمی'));
    const again = await registerPlayer(game.ctx, identity('1002', 'جدید'));
    if (first.status !== 'ok' || again.status !== 'ok') throw new Error('expected ok');
    expect(again).toEqual({ status: 'ok', userId: first.userId, created: false });
    const [user] = await game.ctx.db.select().from(users).where(eq(users.id, first.userId));
    expect(user?.displayName).toBe('جدید');
  });

  it('creates one player when the same identity registers 8 times concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => registerPlayer(game.ctx, identity('1003'))),
    );
    const ids = new Set(results.map((r) => (r.status === 'ok' ? r.userId : 0)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 'ok' && r.created)).toHaveLength(1);
    const [row] = await game.ctx.db
      .select({ n: count() })
      .from(userIdentities)
      .where(eq(userIdentities.platformUserId, '1003'));
    expect(row?.n).toBe(1);
    const [walletRows] = await game.ctx.db
      .select({ n: count() })
      .from(wallets)
      .where(eq(wallets.userId, [...ids][0]!));
    expect(walletRows?.n).toBe(2);
  });

  it('refuses bots', async () => {
    expect(await registerPlayer(game.ctx, { ...identity('1004'), isBot: true })).toEqual({
      status: 'rejected_bot',
    });
  });
});

describe('group registration (minimal; full lifecycle in step 6)', () => {
  it('creates a city once and reuses it when the bot is added again', async () => {
    const input = { platform: 'telegram' as const, platformChatId: '-1009', title: 'شهر' };
    const [a, b] = await Promise.all([
      registerGroup(game.ctx, input),
      registerGroup(game.ctx, input),
    ]);
    expect(a.groupId).toBe(b.groupId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });
});
