import type { Api } from 'grammy';
import { GrammyError, HttpError } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type {
  Button,
  MemberRole,
  MessageEdit,
  OutgoingMessage,
  PlatformAdapter,
  SentMessageRef,
} from '@lulu/platform';
import { PlatformSendError, TELEGRAM_CAPABILITIES } from '@lulu/platform';

/** Maps Telegram API failures onto retry decisions for the outbox. */
export function classifyTelegramError(err: unknown): PlatformSendError {
  if (err instanceof GrammyError) {
    if (err.error_code === 429) {
      return new PlatformSendError(
        'rate_limited',
        err.description,
        err.parameters.retry_after ?? 1,
      );
    }
    if (err.error_code >= 500) return new PlatformSendError('transient', err.description);
    // 400 bad request, 403 blocked/kicked, 404: retrying cannot help
    return new PlatformSendError('permanent', err.description);
  }
  if (err instanceof HttpError) return new PlatformSendError('transient', err.message);
  return new PlatformSendError('transient', err instanceof Error ? err.message : String(err));
}

const harmless = (err: unknown, fragment: string) =>
  err instanceof GrammyError && err.error_code === 400 && err.description.includes(fragment);

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;
  readonly capabilities = TELEGRAM_CAPABILITIES;
  private readonly api: Api;
  private readonly botUsername: string;

  constructor(api: Api, botUsername: string) {
    this.api = api;
    this.botUsername = botUsername;
  }

  keyboard(rows: Button[][]): InlineKeyboardButton[][] {
    return rows.map((row) =>
      row.map((b): InlineKeyboardButton => {
        switch (b.kind) {
          case 'callback':
            return { text: b.label, callback_data: b.data };
          case 'url':
            return { text: b.label, url: b.url };
          case 'add_to_group':
            return { text: b.label, url: `https://t.me/${this.botUsername}?startgroup=lulu` };
        }
      }),
    );
  }

  async send(m: OutgoingMessage): Promise<SentMessageRef> {
    try {
      const sent = await this.api.sendMessage(Number(m.platformChatId), m.text, {
        ...(m.format === 'html' ? { parse_mode: 'HTML' as const } : {}),
        ...(m.replyToMessageId
          ? {
              reply_parameters: {
                message_id: Number(m.replyToMessageId),
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(m.buttons?.length
          ? { reply_markup: { inline_keyboard: this.keyboard(m.buttons) } }
          : {}),
        ...(m.silent ? { disable_notification: true } : {}),
        link_preview_options: { is_disabled: true },
      });
      return { platformChatId: m.platformChatId, messageId: String(sent.message_id) };
    } catch (err) {
      throw classifyTelegramError(err);
    }
  }

  async edit(target: SentMessageRef, e: MessageEdit): Promise<void> {
    try {
      await this.api.editMessageText(
        Number(target.platformChatId),
        Number(target.messageId),
        e.text,
        {
          ...(e.format === 'html' ? { parse_mode: 'HTML' as const } : {}),
          reply_markup: { inline_keyboard: this.keyboard(e.buttons ?? []) },
          link_preview_options: { is_disabled: true },
        },
      );
    } catch (err) {
      if (harmless(err, 'message is not modified')) return;
      throw classifyTelegramError(err);
    }
  }

  async answerButton(
    callbackId: string,
    notice?: { text: string; alert?: boolean },
  ): Promise<void> {
    try {
      await this.api.answerCallbackQuery(callbackId, {
        ...(notice?.text ? { text: notice.text } : {}),
        ...(notice?.alert ? { show_alert: true } : {}),
      });
    } catch (err) {
      // An old query cannot be answered any more; the action itself already happened.
      if (harmless(err, 'query is too old')) return;
      throw classifyTelegramError(err);
    }
  }

  async getMemberRole(platformChatId: string, platformUserId: string): Promise<MemberRole> {
    const member = await this.api.getChatMember(Number(platformChatId), Number(platformUserId));
    switch (member.status) {
      case 'creator':
        return 'owner';
      case 'administrator':
        return 'admin';
      case 'member':
      case 'restricted':
        return 'member';
      default:
        return 'left';
    }
  }
}
