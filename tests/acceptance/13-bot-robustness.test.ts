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
import { T, makeButtons, processEvent } from '@lulu/bot';
import { EventFactory, FakeAdapter } from '@lulu/bot/testing';
import {
  findGroupIdByChat,
  findUserIdByIdentity,
  importGhostBatch,
  scaryLeaderboard,
} from '@lulu/domain';
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

  it('refuses an expired confirmation, saying how long it was valid', async () => {
    const u = newUser();
    const { confirm } = await upgradePreview(u);
    game.clock.advanceSeconds(120);
    const { answer } = await click(G, u, confirm);
    expect(answer).toMatchObject({ text: T.button.expired(120), alert: true });
    expect(answer?.text).toContain('۲ دقیقه');
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
    expect(adapter.last(G.platformChatId)?.text).toBe(T.amountNegative);
    await say(G, u, 'واریز گنجینه 0');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.amountZero);
    await say(G, u, 'واریز گنجینه ۱۰۰۰۰۰۰۰۰۰۰۰۰۰۰');
    expect(adapter.last(G.platformChatId)?.text).toBe(T.amountTooLarge);
    await say(G, u, 'واریز گنجینه ۵۰ تا');
    expect(adapter.last(G.platformChatId)?.text).toBe(
      T.amountNotANumber('50 تا', 'واریز گنجینه ۱۰۰'),
    );
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

// Regression (manual test 2026-10-04): every «انتقال …» got only «مبلغ نامعتبر است».
// The amount was checked before the reply, and the reply never said what was wrong.
describe(`acceptance 13 — transfer mistakes get a precise answer (${testBackend()})`, () => {
  const replyTo = (who: Sender) => ({
    replyTo: { chatId: G.platformChatId, messageId: '77', sender: who, fromThisBot: false },
  });

  it('accepts ASCII, Persian and grouped amounts when replying to the recipient', async () => {
    const a = newUser();
    const b = newUser();
    await say(G, a, 'لولو');
    await say(G, b, 'لولو');
    await grantPoints(game, await userIdOf(a), 5000);
    for (const text of ['انتقال 50', 'انتقال ۵۰', 'انتقال ٥٠', 'انتقال 1,500', 'انتقال ۱٬۵۰۰']) {
      await say(G, a, text, replyTo(b));
      expect(adapter.last(G.platformChatId)?.text, text).toContain(b.displayName);
      expect(buttonData(G, T.btn.confirm).data, text).toMatch(/^b:/);
    }
    await click(G, a, buttonData(G, T.btn.confirm));
    expect(await cashOf(game, await userIdOf(b))).toBe(100n + 150_000n);
  });

  it('says a reply is needed (not «invalid amount») when there is none, whatever follows', async () => {
    const a = newUser();
    await say(G, a, 'لولو');
    for (const text of ['انتقال 50', 'انتقال ۵۰ @someone', 'انتقال 50 به علی', 'انتقال صد']) {
      await say(G, a, text);
      expect(adapter.last(G.platformChatId)?.text, text).toBe(T.replyToPerson);
    }
  });

  it('quotes what was not a number and says the recipient comes from the reply', async () => {
    const a = newUser();
    const b = newUser();
    await say(G, a, 'لولو');
    await say(G, b, 'لولو');
    await say(G, a, 'انتقال ۵۰ @someone', replyTo(b));
    const last = adapter.last(G.platformChatId)!;
    expect(last.text).toBe(
      `${T.amountNotANumber('50 @someone', 'انتقال ۱۰۰')}\n${T.transferRecipientByReply}`,
    );
    expect(last.text).toContain('«50 @someone» عدد نیست');
    expect(last.buttons).toBeUndefined();
    await say(G, a, 'انتقال 0', replyTo(b));
    expect(adapter.last(G.platformChatId)?.text).toBe(T.amountZero);
    await say(G, a, 'انتقال -5', replyTo(b));
    expect(adapter.last(G.platformChatId)?.text).toBe(T.amountNegative);
    await say(G, a, 'انتقال', replyTo(b));
    expect(adapter.last(G.platformChatId)?.text).toBe(T.missingArg('انتقال ۱۰۰'));
  });

  it('escapes and shortens the quoted text', async () => {
    const a = newUser();
    const b = newUser();
    await say(G, a, 'لولو');
    await say(G, b, 'لولو');
    await say(G, a, `انتقال <b>${'x'.repeat(100)}</b>`, replyTo(b));
    const text = adapter.last(G.platformChatId)!.text;
    expect(text).toContain('&lt;b&gt;');
    expect(text).not.toContain('<b>x');
    expect(text).not.toContain('x'.repeat(50));
  });
});

// Regression (manual tests 2026-10-04 and 2026-10-10): «ترسناک‌ترین لولوها» in a group
// showed every player of the bot. Now: this group's members ranked by lolopoints, and
// under them the bot-wide top three.
describe(`acceptance 13 — leaderboard scope (${testBackend()})`, () => {
  const G1 = ev.group('-1002001', 'گروه اول');
  const G2 = ev.group('-1002002', 'گروه دوم');
  /** The group's own list, the bot-wide top three, and their names. */
  const parts = (text: string) => {
    const [own = '', global = ''] = text.split('🌍');
    return { own, global };
  };
  const line = (displayName: string) => new RegExp(`<b>${displayName}</b> — `);

  it('ranks only the members of this group, then shows the bot-wide top three', async () => {
    const a = newUser(); // plays in G1
    const b = newUser(); // plays in G2 only
    const c = newUser(); // in G1, but has only asked for the board there
    await say(G1, a, 'لولو');
    await say(G2, b, 'لولو');
    await grantPoints(game, await userIdOf(a), 70);
    await say(G1, c, 'ترسناک‌ترین لولوها');

    const inGroup = adapter.last(G1.platformChatId)!;
    const { own, global } = parts(inGroup.text);
    expect(own).toContain('— این گروه');
    expect(own).toMatch(line(a.displayName));
    expect(own).toMatch(line(c.displayName));
    expect(own).not.toMatch(line(b.displayName));
    expect(own.search(line(a.displayName))).toBeLessThan(own.search(line(c.displayName))); // 71 > 0
    expect(own).toContain('۷۱ پوینت');
    const top3 = await scaryLeaderboard(game.ctx, { limit: 3 });
    expect(top3).toHaveLength(3);
    for (const e of top3) expect(global).toMatch(line(e.displayName));
    expect(global.trim().split('\n')).toHaveLength(5); // title, three players, the note
    expect(inGroup.buttons).toBeUndefined();

    await say(G2, b, 'ترسناکترین لولوها');
    const other = parts(adapter.last(G2.platformChatId)!.text).own;
    expect(other).toMatch(line(b.displayName));
    expect(other).not.toMatch(line(a.displayName));
    expect(other).not.toMatch(line(c.displayName));

    const P = ev.private(a.platformUserId);
    await say(P, a, 'ترسناک‌ترین لولوها');
    const inPrivate = adapter.last(P.platformChatId)!.text;
    expect(inPrivate).toContain('— کل ربات');
    expect(inPrivate).not.toContain('🌍');
  });

  it('does not list players who left the group', async () => {
    const G3 = ev.group('-1002003', 'گروه سوم');
    const stays = newUser();
    const leaves = newUser();
    await say(G3, stays, 'لولو');
    await say(G3, leaves, 'لولو');
    await run(ev.event({ type: 'member_change', chat: G3, status: 'left', member: leaves }));
    await say(G3, stays, 'ترسناک‌ترین لولوها');
    const { own } = parts(adapter.last(G3.platformChatId)!.text);
    expect(own).toMatch(line(stays.displayName));
    expect(own).not.toMatch(line(leaves.displayName));
  });

  it('an old «global» button posts nothing and says it is no longer valid', async () => {
    const a = newUser();
    await say(G1, a, 'لولو');
    const groupId = (await findGroupIdByChat(game.ctx.db, 'telegram', G1.platformChatId))!;
    const [row] = await makeButtons(
      game.ctx,
      { userId: await userIdOf(a), groupId, platform: 'telegram', chatId: G1.platformChatId },
      [[{ label: 'رتبه‌بندی جهانی', action: 'global_board' }]],
    );
    const old = row![0]!;
    if (old.kind !== 'callback') throw new Error('expected a callback button');
    const sentBefore = adapter.sent.length;
    const { answer } = await click(G1, a, { data: old.data, messageId: '1' });
    expect(answer).toMatchObject({ text: T.button.invalid, alert: true });
    expect(adapter.sent.length).toBe(sentBefore);
  });
});

// Regression (manual test 2026-10-10): every button worked only right after /start. All
// buttons expired after 120 s and pressing one used up the others of its message, so
// «راهنما» after «غار من» said «already used». Menu buttons now never expire.
describe(`acceptance 13 — menu buttons stay usable (${testBackend()})`, () => {
  const startMenu = async (chat: ChatRef, who: Sender) => {
    await say(chat, who, '/start');
    return { help: buttonData(chat, T.btn.help), cave: buttonData(chat, T.btn.cave) };
  };

  it('help and my cave work in any order, again and again, days later', async () => {
    const u = newUser();
    const P = ev.private(u.platformUserId);
    const { help, cave } = await startMenu(P, u);
    const helpText = 'راهنمای لولو';
    for (const button of [cave, help, help, cave]) {
      const before = adapter.sent.length;
      const { answer } = await click(P, u, button);
      expect(answer?.alert).toBeFalsy();
      expect(adapter.sent.length).toBe(before + 1);
    }
    expect(adapter.textsIn(P.platformChatId).filter((t) => t.includes(helpText))).toHaveLength(2);
    game.clock.advanceSeconds(3 * 86_400);
    const { answer } = await click(P, u, help);
    expect(answer?.alert).toBeFalsy();
    expect(adapter.last(P.platformChatId)?.text).toContain(helpText);
  });

  it("in a group, anyone may press help; my cave stays its owner's", async () => {
    const owner = newUser();
    const other = newUser();
    await say(G, other, 'لولو');
    const { help, cave } = await startMenu(G, owner);
    await click(G, other, help);
    expect(adapter.last(G.platformChatId)?.text).toContain('راهنمای لولو');
    expect((await click(G, other, cave)).answer).toMatchObject({
      text: T.button.notYours,
      alert: true,
    });
    await click(G, owner, cave);
    expect(adapter.last(G.platformChatId)?.text).toContain(owner.displayName);
  });

  it('a shop «buy» button keeps working; only the confirmation it opens expires', async () => {
    const u = newUser();
    await say(G, u, 'لولو');
    await grantPoints(game, await userIdOf(u), 1_000);
    await say(G, u, 'ابزار شکار');
    const shop = adapter.last(G.platformChatId)!;
    expect(shop.text).toContain('قوی‌ترین ابزار');
    const labels = (shop.buttons ?? []).flat().map((b) => b.label);
    expect(labels.some((l) => l.startsWith('تجهیز'))).toBe(false);
    const buyKnife = buttonData(G, 'خرید چاقو');

    await click(G, u, buyKnife);
    const firstConfirm = buttonData(G, T.btn.confirm);
    game.clock.advanceSeconds(600);
    expect((await click(G, u, firstConfirm)).answer).toMatchObject({
      text: T.button.expired(120),
    });
    await click(G, u, buyKnife); // the menu message was not replaced and still works
    await click(G, u, buttonData(G, T.btn.confirm));
    expect(adapter.edits[adapter.edits.length - 1]?.text).toBe(T.toolOk('knife', 'knife'));
  });

  it('«تجهیز …» is no longer a command', async () => {
    const u = newUser();
    expect(await say(G, u, 'تجهیز چاقو')).toBe('ignored');
  });
});

// Regression (manual test 2026-10-10): in a basic (non-super) group the bot seemed to
// answer only replies to its own messages. The bot core treats both kinds alike; if
// Telegram does not deliver plain messages, Group Privacy is on (logged at startup).
describe(`acceptance 13 — basic groups (${testBackend()})`, () => {
  it('answers a plain «لولو» that is not a reply, in a basic group and a supergroup', async () => {
    for (const chat of [
      ev.group('-4100', 'گروه ساده'),
      { platformChatId: '-1004100', kind: 'supergroup', title: 'سوپرگروه' } as ChatRef,
    ]) {
      const u = newUser();
      expect(await say(chat, u, 'لولو')).toBe('processed');
      expect(adapter.last(chat.platformChatId)?.text).toContain('لولو کرد');
      expect(await cashOf(game, await userIdOf(u))).toBe(100n);
    }
  });
});

// The owner rule of 2026-10-10: «شنیدم» pays every active member of the group.
describe(`acceptance 13 — ghost reward for the group (${testBackend()})`, () => {
  it('tells the group how many members were paid', async () => {
    const chat = ev.group('-4200', 'گروه روح');
    const finder = newUser();
    const member = newUser();
    await say(chat, member, 'لولو');
    await say(chat, finder, 'جستجوی روح');
    const ghostMsg = adapter.last(chat.platformChatId)!;
    expect(ghostMsg.text).toContain('هر عضو فعال این گروه');
    const before = await cashOf(game, await userIdOf(member));
    await say(chat, finder, 'شنیدم', {
      replyTo: {
        chatId: chat.platformChatId,
        messageId: ghostMsg.messageId,
        sender: null,
        fromThisBot: true,
      },
    });
    expect(adapter.last(chat.platformChatId)?.text).toBe(T.heardOk(finder.displayName, 5_000n, 2));
    expect(await cashOf(game, await userIdOf(member))).toBe(before + 5_000n);
  });
});
