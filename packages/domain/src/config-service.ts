import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_GAME_CONFIG, parseGameConfig } from '@lulu/config';
import type { GameConfig } from '@lulu/config';
import type { Database, Executor } from '@lulu/database';
import { configVersions, queryRows } from '@lulu/database';
import { desc, eq, lte, sql } from 'drizzle-orm';

export interface EffectiveConfig {
  versionId: number;
  config: GameConfig;
}

/**
 * The code defaults are stored as the first config version, effective from the epoch,
 * so every operation can reference a version. Repeatable and race-free: a partial
 * unique index allows one `source = 'default'` row, and the insert ignores conflicts.
 *
 * If a default row already exists it is never changed, even if the code defaults have
 * since been edited; `matchesCodeDefaults` reports that drift so it can be surfaced
 * instead of silently rewriting the economy.
 */
export async function ensureDefaultConfig(
  db: Database,
  defaults: GameConfig = DEFAULT_GAME_CONFIG,
): Promise<{ versionId: number; created: boolean; matchesCodeDefaults: boolean }> {
  const validated = parseGameConfig(defaults);
  const inserted = await queryRows<{ id: string | number }>(
    db,
    sql`INSERT INTO config_versions (config, source, note, effective_from)
        VALUES (${JSON.stringify(validated)}::jsonb, 'default', 'v1 defaults from code', 'epoch')
        ON CONFLICT ((true)) WHERE source = 'default' DO NOTHING
        RETURNING id`,
  );
  if (inserted[0]) {
    return { versionId: Number(inserted[0].id), created: true, matchesCodeDefaults: true };
  }
  const [existing] = await db
    .select({ id: configVersions.id, config: configVersions.config })
    .from(configVersions)
    .where(eq(configVersions.source, 'default'));
  if (!existing) throw new Error('default config row vanished');
  return {
    versionId: existing.id,
    created: false,
    matchesCodeDefaults: isDeepStrictEqual(existing.config, validated),
  };
}

/** Resolves the configuration version in force at an instant. Parsed documents are cached by id. */
export class ConfigProvider {
  private readonly parsed = new Map<number, GameConfig>();

  async effectiveAt(ex: Executor, at: Date): Promise<EffectiveConfig> {
    const [row] = await ex
      .select({ id: configVersions.id, config: configVersions.config })
      .from(configVersions)
      .where(lte(configVersions.effectiveFrom, at))
      .orderBy(desc(configVersions.effectiveFrom), desc(configVersions.id))
      .limit(1);
    if (!row) {
      throw new Error('no game configuration is in force; run ensureDefaultConfig at startup');
    }
    let config = this.parsed.get(row.id);
    if (!config) {
      config = parseGameConfig(row.config);
      this.parsed.set(row.id, config);
    }
    return { versionId: row.id, config };
  }
}
