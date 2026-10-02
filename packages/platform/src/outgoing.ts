/**
 * Normalized outbound messages. The bot core renders domain results into these;
 * each adapter converts them to its platform's wire format.
 */

/**
 * `html` is a deliberately small subset that every adapter must be able to convert:
 * `<b>`, `<i>`, `<code>`, `<a href="...">` and HTML entities. All interpolated
 * user-controlled text must already be escaped by the renderer.
 */
export type TextFormat = 'html' | 'plain';

export type Button =
  /** Sends `data` back as a ButtonClickEvent. */
  | { kind: 'callback'; label: string; data: string }
  | { kind: 'url'; label: string; url: string }
  /** Platform-specific "add this bot to a group" action. */
  | { kind: 'add_to_group'; label: string };

export interface OutgoingMessage {
  platformChatId: string;
  text: string;
  format: TextFormat;
  replyToMessageId?: string;
  /** Rows of buttons. */
  buttons?: Button[][];
  silent?: boolean;
}

export type MessageEdit = Pick<OutgoingMessage, 'text' | 'format' | 'buttons'>;

export interface SentMessageRef {
  platformChatId: string;
  messageId: string;
}
