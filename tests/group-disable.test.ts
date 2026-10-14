/**
 * A group disabled in the admin panel (8.4): the bot runs no command and no button
 * there, says why at most every 10 minutes, and keeps everything. Private chats and
 * other groups are unaffected. End to end through the bot core, outbox and sender.
 */
import type { BotDeps } from '@lulu/bot';
import { T, makeButtons, processEvent } from '@lulu/bot';
import { EventFactory, FakeAdapter } from '@lulu/bot/testing';
import { pendingConfirmations, transactions } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import { findGroupIdByChat, findUserIdByIdentity, setGroupDisabled } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { createAdminUser, createTestGame } from '@lulu/domain/testing';
import type { IncomingEvent } from '@lulu/platform';
import { silentLogger } from '@lulu/runtime';
import { OutboxSender } from '@lulu/worker';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let game: TestGame;
let adapter: FakeAdapter;
let deps: BotDeps;
let sender: OutboxSender;
const ev = new EventFactory();
const G = ev.group('-1009001', 'گروه غیرفعال');
const OTHER = ev.group('-1009002', 'گروه دیگر');
const sara = ev.user('5001', 'سارا');

beforeAll(async () => {
  game = await createTestGame('2026-10-14T08:00:00Z');
  adapter = new FakeAdapter();
  deps = {
    ctx: game.ctx,
    botUsername: 'LuluTestBot',
    memberRole: () => Promise.resolve('member'),
    log: silentLogger,
  };
  sender = new OutboxSender({
    ctx: game.ctx,
    adapters: { telegram: adapter },
    log: silentLogger,
    limiter: null,
  });
});
afterAll(async () => {
  await game.close();
});

async function run(e: IncomingEvent) {
  await processEvent(deps, e);
  for (let i = 0; i < 20; i++) if ((await sender.drainOnce()).claimed === 0) return;
}
const lolos = async () =>
  (
    await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(eq(transactions.kind, 'lolo_reward'))
  )[0]!.n;

describe(`disabled group (${testBackend()})`, () => {
  it('runs nothing there, explains once per 10 minutes, and resumes when enabled', async () => {
    await run(ev.text(G, sara, 'لولو'));
    expect(await lolos()).toBe(1);
    const groupId = (await findGroupIdByChat(game.ctx.db, 'telegram', G.platformChatId))!;
    const admin = await createAdminUser(game);
    await setGroupDisabled(game.ctx, {
      groupId,
      disabled: true,
      reason: 'اسپم',
      adminUserId: admin,
    });

    game.clock.advance(10 * 60_000); // the lolo cooldown is over
    const before = adapter.textsIn(G.platformChatId).length;
    await run(ev.text(G, sara, 'لولو'));
    await run(ev.text(G, sara, 'شکار'));
    expect(adapter.textsIn(G.platformChatId).slice(before)).toEqual([T.groupDisabled]);
    expect(await lolos()).toBe(1);

    game.clock.advance(11 * 60_000);
    await run(ev.text(G, sara, 'لولو'));
    expect(adapter.textsIn(G.platformChatId).slice(before)).toEqual([
      T.groupDisabled,
      T.groupDisabled,
    ]);

    // Elsewhere the same player plays as usual.
    await run(ev.text(OTHER, sara, 'لولو'));
    expect(await lolos()).toBe(2);
    await run(ev.text(ev.private('5001'), sara, '/start'));
    expect(adapter.textsIn('5001').length).toBeGreaterThan(0);

    // Buttons of the group answer with an alert and stay unused.
    const userId = (await findUserIdByIdentity(game.ctx.db, 'telegram', sara.platformUserId))!;
    const [row] = await makeButtons(
      game.ctx,
      { userId, groupId, platform: 'telegram', chatId: G.platformChatId },
      [[{ label: 'راهنما', action: 'help' }]],
    );
    const button = row![0]!;
    if (button.kind !== 'callback') throw new Error('expected a callback button');
    await run(ev.click(G, sara, button.data, '1'));
    expect(adapter.answers.at(-1)).toMatchObject({ text: T.groupDisabledButton, alert: true });
    const [stored] = await game.ctx.db.select().from(pendingConfirmations);
    expect(stored!.usedAt).toBeNull();

    await setGroupDisabled(game.ctx, {
      groupId,
      disabled: false,
      reason: 'تمام شد',
      adminUserId: admin,
    });
    game.clock.advance(10 * 60_000);
    await run(ev.text(G, sara, 'لولو'));
    expect(await lolos()).toBe(3);
  });
});
