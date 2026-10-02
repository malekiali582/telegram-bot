import { BP_SCALE } from '@lulu/config';
import type { CooldownKind, Tx } from '@lulu/database';
import { cooldowns, waitNotices } from '@lulu/database';
import { and, eq } from 'drizzle-orm';

/**
 * Cooldown after applying a group curse: linear reduction per level, relative to the
 * base. Rounded up to whole seconds so a buff never shortens a wait by a fraction more
 * than configured.
 */
export function effectiveCooldownSeconds(
  baseSeconds: number,
  reductionPerLevelBp: number,
  curseLevel: number,
): number {
  const factor = BP_SCALE - reductionPerLevelBp * curseLevel;
  if (factor <= 0) throw new RangeError('curse would remove the cooldown entirely');
  return Math.ceil((baseSeconds * factor) / BP_SCALE);
}

/** When the player may act again; `undefined` if the cooldown has never been set. */
export async function cooldownAvailableAt(
  tx: Tx,
  userId: number,
  kind: CooldownKind,
): Promise<Date | undefined> {
  const [row] = await tx
    .select({ availableAt: cooldowns.availableAt })
    .from(cooldowns)
    .where(and(eq(cooldowns.userId, userId), eq(cooldowns.kind, kind)));
  return row?.availableAt;
}

/** Waiting is over exactly at `availableAt` (half-open interval). */
export function isCoolingDown(availableAt: Date | undefined, now: Date): boolean {
  return availableAt !== undefined && now.getTime() < availableAt.getTime();
}

/**
 * Records a cooldown with the snapshot of the group it was earned in. Switching groups
 * or upgrading a city later never shortens it.
 */
export async function startCooldown(
  tx: Tx,
  input: {
    userId: number;
    kind: CooldownKind;
    now: Date;
    groupId: number | null;
    baseSeconds: number;
    effectiveSeconds: number;
  },
): Promise<Date> {
  const availableAt = new Date(input.now.getTime() + input.effectiveSeconds * 1000);
  const values = {
    availableAt,
    setAt: input.now,
    groupId: input.groupId,
    baseSeconds: input.baseSeconds,
    effectiveSeconds: input.effectiveSeconds,
  };
  await tx
    .insert(cooldowns)
    .values({ userId: input.userId, kind: input.kind, ...values })
    .onConflictDoUpdate({ target: [cooldowns.userId, cooldowns.kind], set: values });
  return availableAt;
}

/**
 * Rate limit for "time remaining" replies so a group is not flooded: at most one
 * notice per player, group and action within `throttleSeconds`. Returns true when a
 * notice should be sent now (and records it).
 */
export async function claimWaitNotice(
  tx: Tx,
  input: {
    userId: number;
    groupId: number;
    kind: CooldownKind;
    now: Date;
    throttleSeconds: number;
  },
): Promise<boolean> {
  const key = and(
    eq(waitNotices.userId, input.userId),
    eq(waitNotices.groupId, input.groupId),
    eq(waitNotices.kind, input.kind),
  );
  const [row] = await tx
    .select({ lastSentAt: waitNotices.lastSentAt })
    .from(waitNotices)
    .where(key);
  if (row && input.now.getTime() - row.lastSentAt.getTime() < input.throttleSeconds * 1000) {
    return false;
  }
  await tx
    .insert(waitNotices)
    .values({
      userId: input.userId,
      groupId: input.groupId,
      kind: input.kind,
      lastSentAt: input.now,
    })
    .onConflictDoUpdate({
      target: [waitNotices.userId, waitNotices.groupId, waitNotices.kind],
      set: { lastSentAt: input.now },
    });
  return true;
}
