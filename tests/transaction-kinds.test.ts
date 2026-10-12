import { readFileSync, readdirSync } from 'node:fs';
import { TRANSACTION_KIND_NAMES } from '@lulu/i18n';
import { describe, expect, it } from 'vitest';

/**
 * Every transaction kind the game records has a Persian name for the panel and the CSV
 * export. Kinds are read from the domain sources: `kind: '…'` inside postTransaction
 * calls, the city upgrade table and the treasury direction.
 */
const dir = new URL('../packages/domain/src/', import.meta.url);
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testing.ts')
  .map((f) => readFileSync(new URL(f, dir), 'utf8'))
  .join('\n');

describe('transaction kind names', () => {
  it('cover every kind the domain services record', () => {
    const kinds = new Set<string>();
    for (const m of sources.matchAll(/postTransaction\(tx, \{\s*kind: '([a-z_]+)'/g))
      kinds.add(m[1]!);
    for (const m of sources.matchAll(/^\s+kind: '([a-z_]+_upgrade)',$/gm)) kinds.add(m[1]!);
    for (const m of sources.matchAll(/'(treasury_[a-z]+)'/g)) kinds.add(m[1]!);
    expect(kinds.size).toBeGreaterThan(15);
    const missing = [...kinds].filter((k) => !(k in TRANSACTION_KIND_NAMES));
    expect(missing).toEqual([]);
  });
});
