import type { IncomingEvent, ReplyTarget, Sender, ChatRef, ChatKind } from '@lulu/platform';
import type { Chat, Message, Update, User } from 'grammy/types';

/**
 * Telegram update → normalized events. Pure, so it is tested with real update shapes.
 *
 * Notes on Telegram semantics (Bot API):
 * - An anonymous group admin posts with `sender_chat` = the group itself and no
 *   personal identity; messages "on behalf of" a channel also carry `sender_chat`.
 *   Both get `sender: null` and may not perform personal actions.
 * - `forward_origin` marks forwarded copies; a forwarded ghost is never the bot's
 *   own message.
 * - `external_reply` is a reply to a message from another chat; its `chat` and
 *   `message_id` exist only for supergroups and channels.
 * - Bot added/removed is taken from `my_chat_member` only (the service messages
 *   `new_chat_members`/`left_chat_member` about the bot would duplicate it).
 */

const chatKind = (chat: Chat): ChatKind => chat.type;

/** Omit over each member of a union (plain Omit would merge the variants). */
type WithoutUpdateId<T> = T extends unknown ? Omit<T, 'updateId'> : never;

export function chatRef(chat: Chat): ChatRef {
  const ref: ChatRef = { platformChatId: String(chat.id), kind: chatKind(chat) };
  if ('title' in chat && chat.title) ref.title = chat.title;
  return ref;
}

export function senderOf(user: User): Sender {
  const sender: Sender = {
    platformUserId: String(user.id),
    isBot: user.is_bot,
    displayName:
      [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || String(user.id),
  };
  if (user.username) sender.username = user.username;
  if (user.language_code) sender.languageCode = user.language_code;
  return sender;
}

function replyTarget(m: Message, botId: number): ReplyTarget | undefined {
  const r = m.reply_to_message;
  if (r) {
    return {
      chatId: String(r.chat.id),
      messageId: String(r.message_id),
      sender: r.sender_chat || !r.from ? null : senderOf(r.from),
      fromThisBot: r.from?.id === botId && !r.forward_origin && !r.sender_chat,
    };
  }
  const x = m.external_reply;
  if (x?.chat && x.message_id !== undefined) {
    const user = x.origin.type === 'user' ? x.origin.sender_user : null;
    return {
      chatId: String(x.chat.id),
      messageId: String(x.message_id),
      sender: user ? senderOf(user) : null,
      fromThisBot: user?.id === botId,
    };
  }
  return undefined;
}

export function toIncomingEvents(
  update: Update,
  botId: number,
  receivedAt = new Date(),
): IncomingEvent[] {
  const events: WithoutUpdateId<IncomingEvent>[] = [];
  const base = { platform: 'telegram' as const, receivedAt };

  const message = update.message ?? update.edited_message;
  if (message) {
    const m = message;
    const chat = chatRef(m.chat);
    if (m.migrate_to_chat_id !== undefined) {
      events.push({
        ...base,
        type: 'chat_migrated',
        chat: {
          platformChatId: String(m.migrate_to_chat_id),
          kind: 'supergroup',
          ...(chat.title ? { title: chat.title } : {}),
        },
        fromPlatformChatId: chat.platformChatId,
      });
    }
    if (m.migrate_from_chat_id !== undefined) {
      events.push({
        ...base,
        type: 'chat_migrated',
        chat,
        fromPlatformChatId: String(m.migrate_from_chat_id),
      });
    }
    for (const member of m.new_chat_members ?? []) {
      if (member.id !== botId)
        events.push({
          ...base,
          type: 'member_change',
          chat,
          status: 'joined',
          member: senderOf(member),
        });
    }
    if (m.left_chat_member && m.left_chat_member.id !== botId) {
      events.push({
        ...base,
        type: 'member_change',
        chat,
        status: 'left',
        member: senderOf(m.left_chat_member),
      });
    }
    if (typeof m.text === 'string') {
      const isAnonymousAdmin = m.sender_chat !== undefined && m.sender_chat.id === m.chat.id;
      const replyTo = replyTarget(m, botId);
      events.push({
        ...base,
        type: 'text',
        chat,
        messageId: String(m.message_id),
        text: m.text,
        sender: m.sender_chat || !m.from ? null : senderOf(m.from),
        isAnonymousAdmin,
        isForwarded: m.forward_origin !== undefined,
        isEdited: update.edited_message !== undefined,
        ...(replyTo ? { replyTo } : {}),
      });
    }
  }

  const q = update.callback_query;
  if (q?.message) {
    events.push({
      ...base,
      type: 'button',
      chat: chatRef(q.message.chat),
      callbackId: q.id,
      messageId: String(q.message.message_id),
      data: q.data ?? '',
      sender: senderOf(q.from),
    });
  }

  const membership = update.my_chat_member;
  if (membership) {
    const was = membership.old_chat_member.status;
    const now = membership.new_chat_member.status;
    const inside = (s: string) =>
      s === 'member' || s === 'administrator' || s === 'creator' || s === 'restricted';
    if (!inside(was) && inside(now)) {
      events.push({
        ...base,
        type: 'bot_membership',
        chat: chatRef(membership.chat),
        status: 'added',
        actor: senderOf(membership.from),
      });
    } else if (inside(was) && !inside(now)) {
      events.push({
        ...base,
        type: 'bot_membership',
        chat: chatRef(membership.chat),
        status: 'removed',
        actor: senderOf(membership.from),
      });
    }
  }

  return events.map((e, i) => ({
    ...e,
    updateId: events.length === 1 ? String(update.update_id) : `${update.update_id}:${i}`,
  }));
}
