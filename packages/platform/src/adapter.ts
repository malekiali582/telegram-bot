import type { IncomingEvent, PlatformId } from './events.ts';
import type { MessageEdit, OutgoingMessage, SentMessageRef } from './outgoing.ts';

export interface PlatformCapabilities {
  maxTextLength: number;
  /** Byte limit of a callback button payload, measured in UTF-8. */
  maxCallbackDataBytes: number;
  maxButtonsPerRow: number;
  maxButtonRows: number;
  canEditMessages: boolean;
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'left' | 'unknown';

/** Sending side of a platform. Used by the outbox sender in the worker. */
export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly capabilities: PlatformCapabilities;

  send(message: OutgoingMessage): Promise<SentMessageRef>;
  edit(target: SentMessageRef, edit: MessageEdit): Promise<void>;
  /** Acknowledges a button click, optionally with a short toast/alert. */
  answerButton(callbackId: string, notice?: { text: string; alert?: boolean }): Promise<void>;
  /** Live role lookup; group management permissions are always checked server-side. */
  getMemberRole(platformChatId: string, platformUserId: string): Promise<MemberRole>;
}

export type IncomingEventHandler = (event: IncomingEvent) => Promise<void>;

/**
 * Receiving side of a platform (long polling in development, webhook in production;
 * never both at once). The handler must finish its database transaction before
 * resolving so the platform does not redeliver a processed update.
 */
export interface IncomingEventSource {
  readonly platform: PlatformId;
  start(handler: IncomingEventHandler): Promise<void>;
  stop(): Promise<void>;
}

export type SendFailureKind =
  /** Platform asked us to slow down; retry after `retryAfterSeconds`. */
  | 'rate_limited'
  /** Network error or 5xx; retry with backoff. */
  | 'transient'
  /** Will never succeed (bot blocked, chat gone, invalid message); do not retry. */
  | 'permanent';

export class PlatformSendError extends Error {
  readonly kind: SendFailureKind;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: SendFailureKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'PlatformSendError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
