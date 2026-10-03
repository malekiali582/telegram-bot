import type { Platform } from '@lulu/database';
import type { Button, ChatKind } from '@lulu/platform';
import type { OnSentHook, OutboxItem } from '@lulu/runtime';

/** Where a reply goes: the chat (and message) an event came from. */
export interface Conversation {
  platform: Platform;
  chatId: string;
  chatKind: ChatKind;
  /** The triggering message, replied to in groups so answers stay attached. */
  messageId?: string;
}

/** One outgoing effect of handling an event; written to the outbox in the same transaction. */
export interface Reply {
  item: OutboxItem;
  onSent?: OnSentHook;
}

export function send(
  conv: Conversation,
  text: string,
  options: { buttons?: Button[][]; reply?: boolean; onSent?: OnSentHook } = {},
): Reply {
  const replyTo =
    (options.reply ?? true) && conv.chatKind !== 'private' ? conv.messageId : undefined;
  return {
    item: {
      kind: 'send',
      payload: {
        platformChatId: conv.chatId,
        text,
        format: 'html',
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(options.buttons?.length ? { buttons: options.buttons } : {}),
      },
    },
    ...(options.onSent ? { onSent: options.onSent } : {}),
  };
}

/** Replaces a message's text (and buttons; none when omitted). */
export function edit(
  conv: Conversation,
  messageId: string,
  text: string,
  buttons?: Button[][],
): Reply {
  return {
    item: {
      kind: 'edit',
      payload: {
        platformChatId: conv.chatId,
        messageId,
        edit: { text, format: 'html', buttons: buttons ?? [] },
      },
    },
  };
}

/** Acknowledges a button click (Telegram shows a small toast or an alert). */
export function answer(
  conv: Conversation,
  callbackId: string,
  text?: string,
  alert = false,
): Reply {
  return {
    item: {
      kind: 'answer_button',
      payload: { platformChatId: conv.chatId, callbackId, ...(text ? { text } : {}), alert },
    },
  };
}
