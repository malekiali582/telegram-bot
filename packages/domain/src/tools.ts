import { TOOL_KINDS } from '@lulu/config';
import type { ToolKind } from '@lulu/config';
import { inTransaction, ownedTools, playerState } from '@lulu/database';
import { and, eq } from 'drizzle-orm';
import type { DomainContext } from './context.ts';
import { findTransactionByKey, postTransaction, systemWalletId, userWallets } from './ledger.ts';
import { pointsToCenti } from './money.ts';
import { beginPlayerAction } from './players.ts';

export interface ToolShopItem {
  tool: ToolKind;
  priceCenti: bigint;
  successBp: number;
  owned: boolean;
  equipped: boolean;
}

/** «ابزار شکار»: price, success chance, ownership and equipped state of every tool. */
export async function toolShop(
  ctx: DomainContext,
  userId: number,
): Promise<{ items: ToolShopItem[]; cashCenti: bigint }> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, userId);
    const owned = await tx
      .select({ tool: ownedTools.toolKind })
      .from(ownedTools)
      .where(eq(ownedTools.userId, userId));
    const ownedSet = new Set(owned.map((o) => o.tool));
    const { cash } = await userWallets(tx, userId);
    return {
      cashCenti: cash.balance,
      items: TOOL_KINDS.map((tool) => ({
        tool,
        priceCenti: pointsToCenti(config.tools[tool].price),
        successBp: config.tools[tool].successBp,
        owned: ownedSet.has(tool),
        equipped: player.equippedTool === tool,
      })),
    };
  });
}

export type BuyToolResult =
  | { status: 'ok'; tool: ToolKind; priceCenti: bigint; cashCenti: bigint; equipped: boolean }
  | { status: 'already_owned'; tool: ToolKind }
  | { status: 'insufficient_funds'; priceCenti: bigint; cashCenti: bigint }
  | { status: 'duplicate'; transactionId: number }
  | { status: 'banned' };

/**
 * Buys a permanent tool from cash. No level requirement and no prerequisite tool.
 * Owning a tool twice is impossible (primary key on owned_tools). The first tool
 * bought is equipped automatically when nothing is equipped yet.
 */
export async function buyTool(
  ctx: DomainContext,
  input: { userId: number; tool: ToolKind; idempotencyKey?: string },
): Promise<BuyToolResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, input.userId);
    if (player.banned) return { status: 'banned' };
    if (input.idempotencyKey) {
      const previous = await findTransactionByKey(tx, input.idempotencyKey);
      if (previous) return { status: 'duplicate', transactionId: previous.id };
    }

    const [already] = await tx
      .select({ tool: ownedTools.toolKind })
      .from(ownedTools)
      .where(and(eq(ownedTools.userId, input.userId), eq(ownedTools.toolKind, input.tool)));
    if (already) return { status: 'already_owned', tool: input.tool };

    const priceCenti = pointsToCenti(config.tools[input.tool].price);
    const { cash } = await userWallets(tx, input.userId);
    if (cash.balance < priceCenti) {
      return { status: 'insufficient_funds', priceCenti, cashCenti: cash.balance };
    }

    const transactionId = await postTransaction(tx, {
      kind: 'tool_purchase',
      effectiveAt: now,
      userId: input.userId,
      configVersionId: versionId,
      entries: [
        { walletId: cash.id, amount: -priceCenti },
        { walletId: await systemWalletId(tx, 'burn:tool'), amount: priceCenti },
      ],
      metadata: { tool: input.tool },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await tx
      .insert(ownedTools)
      .values({ userId: input.userId, toolKind: input.tool, acquiredAt: now, transactionId });

    const equip = player.equippedTool === null;
    if (equip) {
      await tx
        .update(playerState)
        .set({ equippedTool: input.tool, updatedAt: now })
        .where(eq(playerState.userId, input.userId));
    }
    return {
      status: 'ok',
      tool: input.tool,
      priceCenti,
      cashCenti: cash.balance - priceCenti,
      equipped: equip,
    };
  });
}

export type EquipToolResult =
  { status: 'ok'; tool: ToolKind } | { status: 'not_owned'; tool: ToolKind } | { status: 'banned' };

/** Exactly one tool is equipped at a time; equipping replaces the previous one. */
export async function equipTool(
  ctx: DomainContext,
  input: { userId: number; tool: ToolKind },
): Promise<EquipToolResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const player = await beginPlayerAction(tx, input.userId);
    if (player.banned) return { status: 'banned' };
    const [owned] = await tx
      .select({ tool: ownedTools.toolKind })
      .from(ownedTools)
      .where(and(eq(ownedTools.userId, input.userId), eq(ownedTools.toolKind, input.tool)));
    if (!owned) return { status: 'not_owned', tool: input.tool };
    await tx
      .update(playerState)
      .set({ equippedTool: input.tool, updatedAt: now })
      .where(eq(playerState.userId, input.userId));
    return { status: 'ok', tool: input.tool };
  });
}
