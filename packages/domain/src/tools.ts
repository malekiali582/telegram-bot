import { TOOL_KINDS } from '@lulu/config';
import type { GameConfig, ToolKind } from '@lulu/config';
import type { Executor } from '@lulu/database';
import { inTransaction, ownedTools } from '@lulu/database';
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

export async function ownedToolKinds(ex: Executor, userId: number): Promise<ToolKind[]> {
  const rows = await ex
    .select({ tool: ownedTools.toolKind })
    .from(ownedTools)
    .where(eq(ownedTools.userId, userId));
  return TOOL_KINDS.filter((t) => rows.some((r) => r.tool === t));
}

/**
 * The tool a player hunts with: always the strongest one owned (highest success chance,
 * then the higher price, then the later tool in the list). Nothing is equipped by hand,
 * so buying a better tool switches to it at once, and a config change re-ranks tools.
 */
export function strongestTool(config: GameConfig, owned: readonly ToolKind[]): ToolKind | null {
  let best: ToolKind | null = null;
  for (const tool of TOOL_KINDS) {
    if (!owned.includes(tool)) continue;
    const t = config.tools[tool];
    const b = best === null ? null : config.tools[best];
    if (!b || t.successBp > b.successBp || (t.successBp === b.successBp && t.price >= b.price)) {
      best = tool;
    }
  }
  return best;
}

/** «ابزار شکار»: price, success chance, ownership and the tool in use. */
export async function toolShop(
  ctx: DomainContext,
  userId: number,
): Promise<{ items: ToolShopItem[]; cashCenti: bigint }> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { config } = await ctx.config.effectiveAt(tx, now);
    await beginPlayerAction(tx, ctx, userId, now);
    const owned = await ownedToolKinds(tx, userId);
    const inUse = strongestTool(config, owned);
    const { cash } = await userWallets(tx, userId);
    return {
      cashCenti: cash.balance,
      items: TOOL_KINDS.map((tool) => ({
        tool,
        priceCenti: pointsToCenti(config.tools[tool].price),
        successBp: config.tools[tool].successBp,
        owned: owned.includes(tool),
        equipped: inUse === tool,
      })),
    };
  });
}

export type BuyToolResult =
  | {
      status: 'ok';
      tool: ToolKind;
      priceCenti: bigint;
      cashCenti: bigint;
      /** The strongest owned tool after the purchase, which hunting now uses. */
      inUse: ToolKind;
    }
  | { status: 'already_owned'; tool: ToolKind }
  | { status: 'insufficient_funds'; priceCenti: bigint; cashCenti: bigint }
  | { status: 'duplicate'; transactionId: number }
  | { status: 'banned' };

/**
 * Buys a permanent tool from cash. No level requirement and no prerequisite tool.
 * Owning a tool twice is impossible (primary key on owned_tools). Hunting always uses
 * the strongest owned tool, so a better tool is in use as soon as it is bought.
 */
export async function buyTool(
  ctx: DomainContext,
  input: { userId: number; tool: ToolKind; idempotencyKey?: string },
): Promise<BuyToolResult> {
  const now = ctx.clock.now();
  return inTransaction(ctx.db, async (tx) => {
    const { versionId, config } = await ctx.config.effectiveAt(tx, now);
    const player = await beginPlayerAction(tx, ctx, input.userId, now);
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

    return {
      status: 'ok',
      tool: input.tool,
      priceCenti,
      cashCenti: cash.balance - priceCenti,
      inUse: strongestTool(config, await ownedToolKinds(tx, input.userId)) ?? input.tool,
    };
  });
}
