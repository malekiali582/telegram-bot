/**
 * Acceptance 13 (spec §19.13), end to end through the platform-independent bot core,
 * the transactional outbox and the sender, with a fake platform adapter:
 * old / used / foreign / forged buttons, duplicate updates, send failures, and
 * negative or excessive amounts. Also the event filters, the live admin check and the
 * ghost flows (including a supergroup migration).
 */
import { outbox, processedUpdates, transactions } from '@lulu/database';
import { testBackend } from '@lulu/database/testing';
import type { BotDeps } from '@lulu/bot';
import { T, processEvent } from '@lulu/bot';
import { EventFactory, FakeAdapter } from '@lulu/bot/testing';
import { findUserIdByIdentity, importGhostBatch } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  cashOf,
  createTestGame,
  ghostBatchInput,
  grantPoints,
  levelOf,
  TEST_START,
} from '@lulu/domain/testing';
import type { ChatRef, IncomingEvent, Sender } from '@lulu/platform';
import { silentLogger } from '@lulu/runtime';
import { OutboxSender } from '@lulu/worker';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let adapter: FakeAdapter;
let deps: BotDeps;
let sender: OutboxSender;
const ev = new EventFactory();
const G = ev.group('-1001', 'لولوآباد آزمایشی');

beforeAll(async () => {
  game = await createTestGame();
  adapter = new FakeAdapter();
  deps = {
    ctx: game.ctx,
    botUsername: 'LuluTestBot',
    memberRole: (c, u) => adapter.getMemberRole(c, u),
    log: silentLogger,
  };
  sender = new OutboxSender({
    ctx: game.ctx,
    adapters: { telegram: adapter },
    log: silentLogger,
    limiter: null, // rate limits have their own tests; the clock here is frozen
  });
  await importGhostBatch(game.ctx, ghostBatchInput('2026-10-02'), { source: 'file' });
});
afterAll(async () => {
  await game.close();
});
beforeEach(() => {
  game.clock.set(TEST_START);
  game.rng.fallback = 'min';
});

const run = (e: IncomingEvent) => processEvent(deps, e);
async function flush() {
  for (let i = 0; i < 50; i++) if ((await sender.drainOnce()).claimed === 0) return;
}
async function say(
  chat: ChatRef,
  who: Sender | null,
  text: string,
  options: Parameters<EventFactory['text']>[3] = {},
) {
  const outcome = await run(ev.text(chat, who, text, options));
  await flush();
  return outcome;
}
const userIdOf = async (who: Sender) =>
  (await findUserIdByIdentity(game.ctx.db, 'telegram', who.platformUserId))!;
/** Callback data of a labelled button in the last message sent to the chat. */
function buttonData(chat: ChatRef, label: string): { data: string; messageId: string } {
  const msg = adapter.last(chat.platformChatId)!;
  for (const row of msg.buttons ?? []) {
    for (const b of row)
      if (b.kind === 'callback' && b.label === label)
        return { data: b.data, messageId: msg.messageId };
  }
  throw new Error(`no button «${label}» in: ${msg.text}`);
}
async function click(chat: ChatRef, who: Sender, button: { data: string; messageId: string }) {
  const outcome = await run(ev.click(chat, who, button.data, button.messageId));
  await flush();
  return { outcome, answer: adapter.answers[adapter.answers.length - 1] };
}
let n = 0;
const newUser = () => ev.user(String(9000 + ++n), `بازیکن ${n}`);

describe(`acceptance 13 — duplicate updates (${testBackend()})`, () => {
  it('processes a redelivered update once: one reward, one reply', async () => {
    const u = newUser();
    const event = ev.text(G, u, 'لولو');
    expect(await run(event)).toBe('processed');
    expect(await run(event)).toBe('duplicate');
    await flush();
    expect(await cashOf(game, await userIdOf(u))).toBe(100n);
    expect(adapter.textsIn(G.platformChatId).filter((t) => t.includes(`بازیکن ${n}`))).toHaveLength(
      1,
    );
  });

  it('ignores ordinary chat without touching the database', async () => {
    const [before] = await game.ctx.db.select({ n: count() }).from(processedUpdates);
    expect(await say(G, newUser(), 'سلام لولو، خوبی؟')).toBe('ignored');
    const [after] = await game.ctx.db.select({ n: count() }).from(processedUpdates);
    expect(after?.n).toBe(before?.n);
  });
});

describe(`acceptance 13 — buttons (${testBackend()})`, () => {
  async function upgradePreview(u: Sender) {
    await say(G, u, 'لولو');
    await grantPoints(game, await userIdOf(u), 300);
    await say(G, u, 'ارتقای لولو');
    return { confirm: buttonData(G, T.btn.confirm), cancel: buttonData(G, T.btn.cancel) };
  }

  it('confirms once; the same (now old) button is refused afterwards', async () => {
    const u = newUser();
    const { confirm, cancel } = await upgradePreview(u);
    expect((await click(G, u, confirm)).answer).toMatchObject({ text: T.button.done });
    expect(await levelOf(game, await userIdOf(u))).toBe(2);
    expect((await click(G, u, confirm)).answer).toMatchObject({ text: T.button.used, alert: true });
    expect((await click(G, u, cancel)).answer).toMatchObject({ text: T.button.used });
    expect(await levelOf(game, await userIdOf(u))).toBe(2);
  });

  it('refuses a button pressed by someone else, and leaves it usable for its owner', async () => {
    const owner = newUser();
    const intruder = newUser();
    await say(G, intruder, 'لولو');
    const { confirm } = await upgradePreview(owner);
    expect((await click(G, intruder, confirm)).answer).toMatchObject({
      text: T.button.notYours,
      alert: true,
    });
    expect(await levelOf(game, await userIdOf(owner))).toBe(1);
    await click(G, owner, confirm);
    expect(await levelOf(game, await userIdOf(owner))).toBe(2);
  });

  it('refuses an expired button', async () => {
    const u = newUser();
    const { confirm } = await upgradePreview(u);
    game.clock.advanceSeconds(120);
    expect((await click(G, u, confirm)).answer).toMatchObject({ text: T.button.expired });
    expect(await levelOf(game, await userIdOf(u))).toBe(1);
  });

  it('cancel invalidates the confirm button of the same message', async () => {
    const u = newUser();
    const { confirm, cancel } = await upgradePreview(u);
    await click(G, u, cancel);
    expect(adapter.edits[adapter.edits.length - 1]).toMatchObject({
      text: T.cancelled,
      buttons: [],
    });
    expect((await click(G, u, confirm)).answer).toMatchObject({ text: T.button.used });
    expect(await levelOf(game, await userIdOf(u))).toBe(1);
  });

  it('refuses forged or garbage button data', async () => {
    const u = newUser();
    await say(G, u, 'لولو');
    for (const data of ['b:AAAAAAAAAAAAAAAAAAAAAA', 'garbage', 'b:../../etc', '']) {
      const { answer } = await click(G, u, { data, messageId: '1' });
      expect(answer).toMatchObject({ text: T.button.invalid, alert: true });
    }
  });

  it('applies one of two simultaneous clicks on the same confirm button', async () => {
    const u = newUser();
    const { confirm } = await upgradePreview(u);
    await grantPoints(game, await userIdOf(u), 6_000); // enough for a second upgrade
    const outcomes = await Promise.all([
      run(ev.click(G, u, confirm.data, confirm.messageId)),
      run(ev.click(G, u, confirm.data, confirm.messageId)),
    ]);
    await flush();
    expect(outcomes).toEqual(['processed', 'processed']);
    expect(await levelOf(game, await userIdOf(u))).toBe(2);
  });
});

describe(`acceptance 13 — send failures never repeat the action (${testBackend()})`, () => {
  it('retries a transient failure with backoff and sends exactly once', async () => {
    const u = newUser();
    adapter.failNext('transient');
    const before = adapter.sent.length;
    await say(G, u, 'لولو');
    expect(adapter.sent.length).toBe(before); // first attempt failed
    game.clock.advanceSeconds(1);
    await flush();
    expect(adapter.sent.length).toBe(before); // still waiting (backoff 2 s)
    game.clock.advanceSeconds(1);
    await flush();
    expect(adapter.sent.length).toBe(before + 1);
    const uid = await userIdOf(u);
    expect(await cashOf(game, uid)).toBe(100n);
    const [rows] = await game.ctx.db
      .select({ n: count() })
      .from(transactions)
      .where(eq(transactions.userId, uid));
    expect(rows?.n).toBe(1);
  });

  it('waits exactly retry_after when rate limited', async () => {
    adapter.failNext('rate_limited', 7);
    const before = adapter.sent.length;
    await say(G, newUser(), 'لولو');
    game.clock.advance(6_999);
    await flush();
    expect(adapter.sent.length).toBe(before);
    game.clock.advance(1);
    await flush();
    expect(adapter.sent.length).toBe(before + 1);
  });

  it('gives up on a permanent failure without undoing the committed action', async () => {
    const u = newUser();
    adapter.failNext('permanent');
    await say(G, u, 'لولو');
    game.clock.advanceSeconds(600);
    await flush();
    const dead = await game.ctx.db.select().from(outbox).where(eq(outbox.status, 'dead'));
    expect(dead.length).toBeGreaterThan(0);
    expect(await cashOf(game, await userIdOf(u))).toBe(100n);
  });
});

describe(`acceptance 13 — amounts and filters (${testBackend()})`, () => {
  it('rejects negative, zero, too precise and excessive amounts without changing anything', async () => {
    const u = newUser();
    await say(G, u, 'لولو'); // 1 point
    const uid = await userIdOf(u);
    await say(G, u, 'واریز گنجینه -50');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.invalidAmount);
    await say(G, u, 'واریز گنجینه 0');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.invalidAmount);
    await say(G, u, 'برداشت گنجینه ۱٫۲۳۴');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.tooPrecise);
    await say(G, u, 'واریز گنجینه ۹۹۹۹۹');
    const last = adapter.last(G.platformChatId)!;
    expect(last.text).toBe(T.insufficient(100n));
    expect(last.buttons).toBeUndefined(); // nothing to confirm
    await say(G, u, 'اهدای خون ۱۰۰۰');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.insufficient(100n));
    expect(await cashOf(game, uid)).toBe(100n);
  });

  it('ignores «لولو» from bots, edited and forwarded messages', async () => {
    const u = newUser();
    expect(await say(G, ev.user('7777', 'بات', true), 'لولو')).toBe('ignored');
    expect(await say(G, u, 'لولو', { isEdited: true })).toBe('ignored');
    expect(await say(G, u, 'لولو', { isForwarded: true })).toBe('ignored');
    expect(await findUserIdByIdentity(game.ctx.db, 'telegram', u.platformUserId)).toBeUndefined();
  });

  it('refuses personal actions for an anonymous admin', async () => {
    expect(await say(G, null, 'لولو', { isAnonymousAdmin: true })).toBe('processed');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.anonymousAdmin);
  });

  it('keeps group-only actions out of private chats', async () => {
    const u = newUser();
    const P = ev.private(u.platformUserId);
    await say(P, u, 'لولو');
    expect(adapter.last(P.platformChatId)?.text).toBe(T.groupOnly);
    await say(P, u, 'غار من');
    expect(adapter.last(P.platformChatId)?.text).toContain('غار');
  });
});

describe(`acceptance 13 — live admin check (${testBackend()})`, () => {
  it('re-checks the role when the upgrade is confirmed', async () => {
    const admin = newUser();
    await say(G, admin, 'لولو');
    await say(G, admin, 'ارتقای بانک خون');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.onlyAdmins);

    adapter.setRole(G.platformChatId, admin.platformUserId, 'admin');
    await say(G, admin, 'ارتقای آبادی');
    const confirm = buttonData(G, T.btn.confirm);
    adapter.setRole(G.platformChatId, admin.platformUserId, 'member'); // demoted meanwhile
    await click(G, admin, confirm);
    expect(adapter.edits[adapter.edits.length - 1]?.text).toBe(T.onlyAdmins);
  });
});

describe(`acceptance 13 — ghosts end to end (${testBackend()})`, () => {
  it('attaches the delivered message, so only a reply to it (not a forward) is heard', async () => {
    const u = newUser();
    await say(G, u, 'جستجوی روح');
    const ghostMsg = adapter.last(G.platformChatId)!;
    expect(ghostMsg.text).toContain('روحی از یاد رفته');

    const forwarded = {
      chatId: G.platformChatId,
      messageId: '424242',
      sender: u,
      fromThisBot: false,
    };
    await say(G, u, 'شنیدم', { replyTo: forwarded });
    expect(adapter.last(G.platformChatId)?.text).toBe(T.heardNotGhost);

    const original = {
      chatId: G.platformChatId,
      messageId: ghostMsg.messageId,
      sender: null,
      fromThisBot: true,
    };
    await say(G, u, 'شنیدم', { replyTo: original });
    expect(adapter.last(G.platformChatId)?.text).toContain('شنید');
    await say(G, u, 'شنیدم', { replyTo: original });
    expect(adapter.last(G.platformChatId)?.text).toBe(T.heardAlready);
  });

  it('after a supergroup migration, re-posts open ghosts and accepts «شنیدم» on them once', async () => {
    const old = ev.group('-2002', 'گروه قدیمی');
    const u = newUser();
    await say(old, u, 'جستجوی روح');
    const oldGhost = adapter.last(old.platformChatId)!;

    const superChat: ChatRef = {
      platformChatId: '-1002002',
      kind: 'supergroup',
      title: 'گروه قدیمی',
    };
    expect(
      await run(
        ev.event({
          type: 'chat_migrated',
          chat: superChat,
          fromPlatformChatId: old.platformChatId,
        }),
      ),
    ).toBe('processed');
    // Telegram sends the migration in both chats; the second is a no-op
    await run(
      ev.event({ type: 'chat_migrated', chat: superChat, fromPlatformChatId: old.platformChatId }),
    );
    await flush();
    const reposts = adapter
      .textsIn(superChat.platformChatId)
      .filter((t) => t.includes('روح شنیده‌نشده'));
    expect(reposts).toHaveLength(1);
    const repost = adapter.last(superChat.platformChatId)!;

    await say(superChat, u, 'شنیدم', {
      replyTo: {
        chatId: superChat.platformChatId,
        messageId: repost.messageId,
        sender: null,
        fromThisBot: true,
      },
    });
    expect(adapter.last(superChat.platformChatId)?.text).toContain('شنید!');
    // the original (pre-migration) message, if Telegram can identify it, is the same ghost
    await say(superChat, u, 'شنیدم', {
      replyTo: {
        chatId: old.platformChatId,
        messageId: oldGhost.messageId,
        sender: null,
        fromThisBot: true,
      },
    });
    expect(adapter.last(superChat.platformChatId)?.text).toBe(T.heardAlready);
  });
});

describe(`acceptance 13 — transfer by reply (${testBackend()})`, () => {
  it('previews recipient and amount, then moves money once on confirm', async () => {
    const a = newUser();
    const b = newUser();
    await say(G, a, 'لولو');
    await say(G, b, 'لولو');
    await grantPoints(game, await userIdOf(a), 500);
    await say(G, a, 'انتقال ۲۰۰', {
      replyTo: { chatId: G.platformChatId, messageId: '55', sender: b, fromThisBot: false },
    });
    expect(adapter.last(G.platformChatId)?.text).toContain(b.displayName);
    await click(G, a, buttonData(G, T.btn.confirm));
    expect(await cashOf(game, await userIdOf(b))).toBe(100n + 20_000n);
    expect(await cashOf(game, await userIdOf(a))).toBe(100n + 50_000n - 20_000n);
  });

  it('refuses transfers to bots, to oneself and without a reply', async () => {
    const a = newUser();
    await say(G, a, 'لولو');
    await say(G, a, 'انتقال ۱');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.replyToPerson);
    await say(G, a, 'انتقال ۱', {
      replyTo: { chatId: G.platformChatId, messageId: '9', sender: a, fromThisBot: false },
    });
    expect(adapter.last(G.platformChatId)?.text).toBe(T.selfTransfer);
    const bot = ev.user('1', 'لولو', true);
    await say(G, a, 'انتقال ۱', {
      replyTo: { chatId: G.platformChatId, messageId: '9', sender: bot, fromThisBot: true },
    });
    expect(adapter.last(G.platformChatId)?.text).toBe(T.targetIsBot);
  });
});
