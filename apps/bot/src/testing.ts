import type {
  ButtonClickEvent,
  ChatRef,
  IncomingEvent,
  MemberRole,
  MessageEdit,
  OutgoingMessage,
  PlatformAdapter,
  ReplyTarget,
  SendFailureKind,
  Sender,
  SentMessageRef,
  TextMessageEvent,
} from '@lulu/platform';
import { PlatformSendError, TELEGRAM_CAPABILITIES } from '@lulu/platform';

/**
 * In-memory platform for end-to-end tests of the bot core and the outbox sender:
 * records everything "sent", can be told to fail, and answers role lookups.
 */
export class FakeAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;
  readonly capabilities = TELEGRAM_CAPABILITIES;
  readonly sent: (OutgoingMessage & { messageId: string })[] = [];
  readonly edits: (SentMessageRef & MessageEdit)[] = [];
  readonly answers: { callbackId: string; text?: string; alert?: boolean }[] = [];
  readonly roles = new Map<string, MemberRole>();
  private failures: { kind: SendFailureKind; retryAfter?: number }[] = [];
  private nextId = 1000;

  /** The next call(s) fail like the platform would. */
  failNext(kind: SendFailureKind, retryAfter?: number, times = 1): void {
    for (let i = 0; i < times; i++)
      this.failures.push({ kind, ...(retryAfter ? { retryAfter } : {}) });
  }

  private maybeFail(): void {
    const failure = this.failures.shift();
    if (failure)
      throw new PlatformSendError(failure.kind, `fake ${failure.kind}`, failure.retryAfter);
  }

  send(message: OutgoingMessage): Promise<SentMessageRef> {
    this.maybeFail();
    const messageId = String(this.nextId++);
    this.sent.push({ ...message, messageId });
    return Promise.resolve({ platformChatId: message.platformChatId, messageId });
  }

  edit(target: SentMessageRef, edit: MessageEdit): Promise<void> {
    this.maybeFail();
    this.edits.push({ ...target, ...edit });
    return Promise.resolve();
  }

  answerButton(callbackId: string, notice?: { text: string; alert?: boolean }): Promise<void> {
    this.maybeFail();
    this.answers.push({ callbackId, ...(notice ?? {}) });
    return Promise.resolve();
  }

  getMemberRole(platformChatId: string, platformUserId: string): Promise<MemberRole> {
    return Promise.resolve(this.roles.get(`${platformChatId}:${platformUserId}`) ?? 'member');
  }

  setRole(chatId: string, userId: string, role: MemberRole): void {
    this.roles.set(`${chatId}:${userId}`, role);
  }

  /** Texts sent to a chat, oldest first. */
  textsIn(chatId: string): string[] {
    return this.sent.filter((m) => m.platformChatId === chatId).map((m) => m.text);
  }

  last(chatId?: string): (OutgoingMessage & { messageId: string }) | undefined {
    const list = chatId ? this.sent.filter((m) => m.platformChatId === chatId) : this.sent;
    return list[list.length - 1];
  }
}

/** Omit over each member of the event union. */
type WithoutMeta<T> = T extends unknown ? Omit<T, 'updateId' | 'receivedAt' | 'platform'> : never;

/** Builds normalized events for tests. */
export class EventFactory {
  private updateId = 1;
  private messageId = 1;

  group(id: string, title = 'گروه آزمایشی'): ChatRef {
    return { platformChatId: id, kind: 'group', title };
  }

  private(id: string): ChatRef {
    return { platformChatId: id, kind: 'private' };
  }

  user(id: string, displayName = `کاربر ${id}`, isBot = false): Sender {
    return { platformUserId: id, isBot, displayName };
  }

  nextUpdateId(): string {
    return String(this.updateId++);
  }

  text(
    chat: ChatRef,
    sender: Sender | null,
    text: string,
    options: Partial<
      Pick<TextMessageEvent, 'isAnonymousAdmin' | 'isForwarded' | 'isEdited' | 'updateId'>
    > & {
      replyTo?: ReplyTarget;
    } = {},
  ): TextMessageEvent {
    const { replyTo, ...flags } = options;
    return {
      platform: 'telegram',
      type: 'text',
      updateId: flags.updateId ?? this.nextUpdateId(),
      receivedAt: new Date(),
      chat,
      messageId: String(this.messageId++),
      text,
      sender,
      isAnonymousAdmin: flags.isAnonymousAdmin ?? false,
      isForwarded: flags.isForwarded ?? false,
      isEdited: flags.isEdited ?? false,
      ...(replyTo ? { replyTo } : {}),
    };
  }

  click(chat: ChatRef, sender: Sender, data: string, messageId?: string): ButtonClickEvent {
    return {
      platform: 'telegram',
      type: 'button',
      updateId: this.nextUpdateId(),
      receivedAt: new Date(),
      chat,
      callbackId: `cb-${this.updateId}`,
      ...(messageId ? { messageId } : {}),
      data,
      sender,
    };
  }

  event(event: WithoutMeta<IncomingEvent>): IncomingEvent {
    return {
      platform: 'telegram',
      updateId: this.nextUpdateId(),
      receivedAt: new Date(),
      ...event,
    };
  }
}
