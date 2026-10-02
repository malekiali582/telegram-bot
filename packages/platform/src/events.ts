/**
 * Normalized inbound events. Adapters translate their platform's raw updates into
 * these shapes; the bot core and domain never see Telegram/Rubika payloads.
 *
 * All platform identifiers are strings so that 64-bit ids (Telegram chat ids) and
 * non-numeric ids (other platforms) are carried losslessly.
 */

export const PLATFORMS = ['telegram', 'rubika'] as const;
export type PlatformId = (typeof PLATFORMS)[number];

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel';

export interface ChatRef {
  platformChatId: string;
  kind: ChatKind;
  /** Untrusted user-controlled text; escape before rendering. */
  title?: string;
}

export interface Sender {
  platformUserId: string;
  isBot: boolean;
  /** Untrusted user-controlled text; escape before rendering. */
  displayName: string;
  username?: string;
  languageCode?: string;
}

interface EventBase {
  platform: PlatformId;
  /** Unique per platform; `(platform, updateId)` is the dedupe key. */
  updateId: string;
  receivedAt: Date;
  chat: ChatRef;
}

export interface ReplyTarget {
  /**
   * Chat the replied-to message belongs to. Usually the current chat; differs for
   * replies to messages from another chat (Telegram `external_reply`), e.g. a message
   * posted before the group was migrated to a supergroup.
   */
  chatId: string;
  messageId: string;
  /** `null` when the replied-to message has no personal sender (channel post, anonymous admin). */
  sender: Sender | null;
  /** True when the replied-to message was sent by this bot. */
  fromThisBot: boolean;
}

export interface TextMessageEvent extends EventBase {
  type: 'text';
  messageId: string;
  text: string;
  /**
   * `null` when the message has no identifiable personal sender, e.g. an anonymous
   * group admin or a message sent on behalf of a channel. Such senders must not be
   * able to perform personal financial actions.
   */
  sender: Sender | null;
  isAnonymousAdmin: boolean;
  isForwarded: boolean;
  isEdited: boolean;
  replyTo?: ReplyTarget;
}

export interface ButtonClickEvent extends EventBase {
  type: 'button';
  /** Platform handle used to acknowledge the click. */
  callbackId: string;
  /** Message the button was attached to, if the platform reports it. */
  messageId?: string;
  /** Opaque payload previously put on the button. Untrusted: may be forged. */
  data: string;
  sender: Sender;
}

export interface BotMembershipEvent extends EventBase {
  type: 'bot_membership';
  status: 'added' | 'removed';
  actor?: Sender;
}

export interface MemberChangeEvent extends EventBase {
  type: 'member_change';
  status: 'joined' | 'left';
  member: Sender;
}

export interface ChatMigratedEvent extends EventBase {
  type: 'chat_migrated';
  /** `chat` holds the new identity; this is the identity it replaces. */
  fromPlatformChatId: string;
}

export type IncomingEvent =
  TextMessageEvent | ButtonClickEvent | BotMembershipEvent | MemberChangeEvent | ChatMigratedEvent;

export function isGroupChat(chat: ChatRef): boolean {
  return chat.kind === 'group' || chat.kind === 'supergroup';
}
