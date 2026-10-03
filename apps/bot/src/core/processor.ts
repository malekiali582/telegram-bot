import { inTransaction, processedUpdates } from '@lulu/database';
import type { DomainContext } from '@lulu/domain';
import {
  botRemovedFromGroup,
  findGroupIdByChat,
  findUserIdByIdentity,
  memberLeftGroup,
  migrateGroupChat,
  openEncountersOfGroup,
  registerGroup,
  registerPlayer,
} from '@lulu/domain';
import { parseCommand } from '@lulu/i18n';
import type {
  ButtonClickEvent,
  ChatRef,
  IncomingEvent,
  MemberRole,
  TextMessageEvent,
} from '@lulu/platform';
import { isGroupChat } from '@lulu/platform';
import type { Logger } from '@lulu/runtime';
import { enqueue } from '@lulu/runtime';
import { claimButton, peekButton, tokenFromData } from './buttons.ts';
import type { HandlerContext } from './handlers.ts';
import { ADMIN_COMMANDS, ADMIN_OPS, handleButton, handleCommand } from './handlers.ts';
import type { Conversation, Reply } from './reply.ts';
import { answer, send } from './reply.ts';
import { T } from './texts.ts';

export interface BotDeps {
  /** Root context; each update gets a copy bound to its own transaction. */
  ctx: DomainContext;
  botUsername: string;
  /** Live lookup of a member's role in a group (server-side admin check). */
  memberRole(platformChatId: string, platformUserId: string): Promise<MemberRole>;
  log: Logger;
}

export type ProcessOutcome = 'processed' | 'ignored' | 'duplicate';

/**
 * Handles one normalized event. Dedupe (processed_updates), the game result and every
 * outgoing message are written in one transaction: either all of it commits or none,
 * so a redelivered update or a failed send can never repeat a money movement. The
 * transaction is retried as a whole on serialization failures and deadlocks.
 */
export async function processEvent(deps: BotDeps, event: IncomingEvent): Promise<ProcessOutcome> {
  switch (event.type) {
    case 'text':
      return processText(deps, event);
    case 'button':
      return processButton(deps, event);
    case 'bot_membership':
      return inUpdate(deps, event, async (ctx) => {
        if (event.status === 'removed') {
          await botRemovedFromGroup(ctx, {
            platform: event.platform,
            platformChatId: event.chat.platformChatId,
          });
          return [];
        }
        await registerGroup(ctx, {
          platform: event.platform,
          platformChatId: event.chat.platformChatId,
          title: event.chat.title ?? '',
        });
        return [send(conversation(event.chat, event.platform), T.groupWelcome, { reply: false })];
      });
    case 'member_change':
      if (event.status !== 'left') return 'ignored';
      return inUpdate(deps, event, async (ctx) => {
        const userId = await findUserIdByIdentity(
          ctx.db,
          event.platform,
          event.member.platformUserId,
        );
        const groupId = await findGroupIdByChat(ctx.db, event.platform, event.chat.platformChatId);
        if (userId !== undefined && groupId !== undefined)
          await memberLeftGroup(ctx, { groupId, userId });
        return [];
      });
    case 'chat_migrated':
      return inUpdate(deps, event, async (ctx) => {
        const result = await migrateGroupChat(ctx, {
          platform: event.platform,
          fromChatId: event.fromPlatformChatId,
          toChatId: event.chat.platformChatId,
        });
        if (result.status === 'conflict') {
          deps.log.warn('group migration conflict; needs an admin', { ...result });
        }
        if (result.status !== 'migrated') return [];
        deps.log.info('group migrated to a supergroup; same city kept', {
          groupId: result.groupId,
          from: event.fromPlatformChatId,
          to: event.chat.platformChatId,
        });
        // Replies to messages of the old (basic) group may not be identifiable, so open
        // ghosts are re-posted here and linked to their encounter when delivered.
        const conv = conversation(event.chat, event.platform);
        const now = ctx.clock.now();
        return (await openEncountersOfGroup(ctx, result.groupId)).map((g) =>
          send(conv, T.ghostRepost(g.ownerName, g.text, g.fearReward, g.expiresAt, now), {
            reply: false,
            onSent: { type: 'ghost_repost', encounterId: g.encounterId },
          }),
        );
      });
  }
}

function conversation(
  chat: ChatRef,
  platform: IncomingEvent['platform'],
  messageId?: string,
): Conversation {
  return {
    platform,
    chatId: chat.platformChatId,
    chatKind: chat.kind,
    ...(messageId ? { messageId } : {}),
  };
}

async function inUpdate(
  deps: BotDeps,
  event: IncomingEvent,
  handle: (ctx: DomainContext) => Promise<Reply[]>,
): Promise<ProcessOutcome> {
  return inTransaction(deps.ctx.db, async (tx) => {
    const fresh = await tx
      .insert(processedUpdates)
      .values({ platform: event.platform, updateId: event.updateId })
      .onConflictDoNothing()
      .returning({ updateId: processedUpdates.updateId });
    if (fresh.length === 0) return 'duplicate' as const;

    const ctx: DomainContext = { ...deps.ctx, db: tx };
    const replies = await handle(ctx);
    const now = ctx.clock.now();
    for (const reply of replies) {
      await enqueue(tx, event.platform, reply.item, {
        notBefore: now,
        ...(reply.onSent ? { onSent: reply.onSent } : {}),
      });
    }
    return 'processed' as const;
  });
}

async function liveRole(deps: BotDeps, chatId: string, userId: string): Promise<MemberRole> {
  try {
    return await deps.memberRole(chatId, userId);
  } catch (err) {
    deps.log.warn('role lookup failed; treating as member', { error: err });
    return 'unknown';
  }
}

async function processText(deps: BotDeps, event: TextMessageEvent): Promise<ProcessOutcome> {
  // Bots, edits and forwards never trigger game actions (and never earn «لولو»).
  if (event.isEdited || event.isForwarded || event.sender?.isBot) return 'ignored';
  const command = parseCommand(event.text, { botUsername: deps.botUsername });
  if (!command) return 'ignored';

  const conv = conversation(event.chat, event.platform, event.messageId);
  const inGroup = isGroupChat(event.chat);
  const sender = event.sender;
  if (!sender || event.isAnonymousAdmin) {
    return inUpdate(deps, event, () => Promise.resolve([send(conv, T.anonymousAdmin)]));
  }
  const role =
    inGroup && ADMIN_COMMANDS.has(command.command)
      ? await liveRole(deps, event.chat.platformChatId, sender.platformUserId)
      : undefined;

  return inUpdate(deps, event, async (ctx) => {
    const registered = await registerPlayer(ctx, {
      platform: event.platform,
      platformUserId: sender.platformUserId,
      displayName: sender.displayName,
      username: sender.username ?? null,
      isBot: sender.isBot,
    });
    if (registered.status !== 'ok') return [];
    const groupId = inGroup ? await groupOf(ctx, event.chat, event.platform) : null;
    const h: HandlerContext = {
      ctx,
      conv,
      userId: registered.userId,
      sender,
      groupId,
      role,
      replyTo: event.replyTo,
    };
    return handleCommand(h, command);
  });
}

/** The city of a group chat; registers it if the bot never saw it being added. */
async function groupOf(ctx: DomainContext, chat: ChatRef, platform: IncomingEvent['platform']) {
  const known = await findGroupIdByChat(ctx.db, platform, chat.platformChatId);
  if (known !== undefined) return known;
  const { groupId } = await registerGroup(ctx, {
    platform,
    platformChatId: chat.platformChatId,
    title: chat.title ?? '',
  });
  return groupId;
}

async function processButton(deps: BotDeps, event: ButtonClickEvent): Promise<ProcessOutcome> {
  const conv = conversation(event.chat, event.platform, event.messageId);
  const token = tokenFromData(event.data);
  if (!token) {
    return inUpdate(deps, event, () =>
      Promise.resolve([answer(conv, event.callbackId, T.button.invalid, true)]),
    );
  }

  // City upgrades re-check the clicker's role live before anything is spent.
  const peek = await peekButton(deps.ctx.db, token);
  const needsRole =
    peek?.action === 'confirm' &&
    typeof peek.params.op === 'string' &&
    ADMIN_OPS.has(peek.params.op) &&
    isGroupChat(event.chat);
  const role = needsRole
    ? await liveRole(deps, event.chat.platformChatId, event.sender.platformUserId)
    : undefined;

  return inUpdate(deps, event, async (ctx) => {
    const userId = await findUserIdByIdentity(ctx.db, event.platform, event.sender.platformUserId);
    const claim = await claimButton(ctx.db, {
      token,
      userId,
      platform: event.platform,
      chatId: event.chat.platformChatId,
      now: ctx.clock.now(),
    });
    if (claim.status !== 'ok') {
      const text = {
        invalid: T.button.invalid,
        not_yours: T.button.notYours,
        used: T.button.used,
        expired: T.button.expired,
      }[claim.status];
      return [answer(conv, event.callbackId, text, true)];
    }
    const h: HandlerContext = {
      ctx,
      conv,
      userId: claim.button.userId,
      sender: event.sender,
      groupId: claim.button.groupId,
      role,
      replyTo: undefined,
    };
    return handleButton(
      h,
      { callbackId: event.callbackId, messageId: event.messageId, token },
      claim.button,
    );
  });
}
