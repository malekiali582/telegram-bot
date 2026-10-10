import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { toIncomingEvents } from './convert.ts';

const BOT_ID = 777;
const group = { id: -100123, type: 'supergroup' as const, title: 'لولوآباد' };
const alice = { id: 42, is_bot: false, first_name: 'Ali', last_name: 'Rezaei', username: 'ali' };
const bot = { id: BOT_ID, is_bot: true, first_name: 'Lulu', username: 'LuluBot' };
const base = { message_id: 10, date: 1_700_000_000, chat: group };

const one = (update: Record<string, unknown>) => {
  const events = toIncomingEvents({ update_id: 5, ...update }, BOT_ID);
  expect(events).toHaveLength(1);
  return events[0]!;
};

describe('Telegram update → normalized events', () => {
  it('maps a plain group text message', () => {
    expect(one({ message: { ...base, from: alice, text: 'لولو' } })).toMatchObject({
      platform: 'telegram',
      type: 'text',
      updateId: '5',
      chat: { platformChatId: '-100123', kind: 'supergroup', title: 'لولوآباد' },
      messageId: '10',
      text: 'لولو',
      sender: { platformUserId: '42', isBot: false, displayName: 'Ali Rezaei', username: 'ali' },
      isAnonymousAdmin: false,
      isForwarded: false,
      isEdited: false,
    });
  });

  // Regression (manual test 2026-10-10): in a basic group the bot seemed to answer only
  // replies. A plain message there converts like in a supergroup; whether Telegram sends
  // it at all is Group Privacy (see logGroupPrivacy).
  it('maps a plain message in a basic group, without any reply', () => {
    const basic = { id: -4812, type: 'group' as const, title: 'گروه کوچک' };
    const event = one({ message: { ...base, chat: basic, from: alice, text: 'لولو' } });
    expect(event).toMatchObject({
      type: 'text',
      chat: { platformChatId: '-4812', kind: 'group', title: 'گروه کوچک' },
      text: 'لولو',
      sender: { platformUserId: '42' },
    });
    expect(event).not.toHaveProperty('replyTo');
  });

  it('marks edited, forwarded and bot-sent messages', () => {
    expect(
      one({ edited_message: { ...base, from: alice, text: 'لولو', edit_date: 1 } }),
    ).toMatchObject({
      isEdited: true,
    });
    const forwarded = one({
      message: {
        ...base,
        from: alice,
        text: 'لولو',
        forward_origin: { type: 'user', date: 1, sender_user: alice },
      },
    });
    expect(forwarded).toMatchObject({ isForwarded: true });
    expect(
      one({ message: { ...base, from: { ...alice, is_bot: true }, text: 'لولو' } }),
    ).toMatchObject({
      sender: { isBot: true },
    });
  });

  it('gives an anonymous admin (sender_chat = the group) no personal identity', () => {
    expect(
      one({
        message: {
          ...base,
          from: { id: 1087968824, is_bot: true, first_name: 'Group' },
          sender_chat: group,
          text: 'لولو',
        },
      }),
    ).toMatchObject({ sender: null, isAnonymousAdmin: true });
  });

  it('describes replies: to the bot, to a forwarded copy, and across chats', () => {
    const toBot = one({
      message: {
        ...base,
        from: alice,
        text: 'شنیدم',
        reply_to_message: { ...base, message_id: 9, from: bot, text: 'روح' },
      },
    });
    expect(toBot).toMatchObject({
      replyTo: {
        chatId: '-100123',
        messageId: '9',
        fromThisBot: true,
        sender: { platformUserId: '777' },
      },
    });

    const toForward = one({
      message: {
        ...base,
        from: alice,
        text: 'شنیدم',
        reply_to_message: {
          ...base,
          message_id: 8,
          from: alice,
          text: 'روح',
          forward_origin: { type: 'user', date: 1, sender_user: bot },
        },
      },
    });
    expect(toForward).toMatchObject({ replyTo: { messageId: '8', fromThisBot: false } });

    const crossChat = one({
      message: {
        ...base,
        from: alice,
        text: 'شنیدم',
        external_reply: {
          origin: { type: 'user', date: 1, sender_user: bot },
          chat: { id: -100999, type: 'supergroup', title: 'دیگر' },
          message_id: 3,
        },
      },
    });
    expect(crossChat).toMatchObject({
      replyTo: { chatId: '-100999', messageId: '3', fromThisBot: true },
    });

    // basic groups: Telegram omits chat/message_id in external_reply → not identifiable
    const basic = one({
      message: {
        ...base,
        from: alice,
        text: 'شنیدم',
        external_reply: { origin: { type: 'user', date: 1, sender_user: bot } },
      },
    });
    expect(basic).not.toHaveProperty('replyTo');
  });

  it('turns both migration service messages into the same migration', () => {
    const fromOld = one({
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -5, type: 'group', title: 'گروه' },
        migrate_to_chat_id: -1005,
      },
    });
    const fromNew = one({
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -1005, type: 'supergroup', title: 'گروه' },
        migrate_from_chat_id: -5,
      },
    });
    for (const event of [fromOld, fromNew]) {
      expect(event).toMatchObject({
        type: 'chat_migrated',
        fromPlatformChatId: '-5',
        chat: { platformChatId: '-1005' },
      });
    }
  });

  it('takes bot add/remove from my_chat_member only, members from service messages', () => {
    const member = (status: string) => ({ user: bot, status });
    const added = one({
      my_chat_member: {
        chat: group,
        from: alice,
        date: 1,
        old_chat_member: member('left'),
        new_chat_member: member('member'),
      },
    });
    expect(added).toMatchObject({
      type: 'bot_membership',
      status: 'added',
      actor: { platformUserId: '42' },
    });
    const removed = one({
      my_chat_member: {
        chat: group,
        from: alice,
        date: 1,
        old_chat_member: member('administrator'),
        new_chat_member: member('kicked'),
      },
    });
    expect(removed).toMatchObject({ type: 'bot_membership', status: 'removed' });
    // promotion member → administrator is not an add
    expect(
      toIncomingEvents(
        {
          update_id: 6,
          my_chat_member: {
            chat: group,
            from: alice,
            date: 1,
            old_chat_member: member('member'),
            new_chat_member: member('administrator'),
          },
        } as unknown as Update,
        BOT_ID,
      ),
    ).toEqual([]);

    // the service message about the bot itself is ignored (my_chat_member covers it)
    expect(
      toIncomingEvents(
        { update_id: 7, message: { ...base, new_chat_members: [bot] } } as unknown as Update,
        BOT_ID,
      ),
    ).toEqual([]);
    expect(one({ message: { ...base, left_chat_member: alice } })).toMatchObject({
      type: 'member_change',
      status: 'left',
      member: { platformUserId: '42' },
    });
  });

  it('maps button clicks with their message and chat', () => {
    expect(
      one({
        callback_query: {
          id: 'cb1',
          from: alice,
          chat_instance: 'x',
          data: 'b:abc',
          message: { ...base, from: bot, text: 'پیش‌نمایش' },
        },
      }),
    ).toMatchObject({
      type: 'button',
      callbackId: 'cb1',
      messageId: '10',
      data: 'b:abc',
      chat: { platformChatId: '-100123' },
      sender: { platformUserId: '42' },
    });
  });

  it('gives each event of a multi-event update its own id', () => {
    const events = toIncomingEvents(
      {
        update_id: 9,
        message: { ...base, new_chat_members: [alice, { ...alice, id: 43 }] },
      } as unknown as Update,
      BOT_ID,
    );
    expect(events.map((e) => e.updateId)).toEqual(['9:0', '9:1']);
  });
});
