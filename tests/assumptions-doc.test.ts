import { readFileSync } from 'node:fs';
import {
  DEFAULT_GAME_CONFIG,
  configLeaves,
  labelOf,
  normalizeConfigPath,
  patternMatches,
} from '@lulu/config';
import type { ConfigLabel } from '@lulu/config';
import { describe, expect, it } from 'vitest';

/**
 * Keeps docs/assumptions.md honest: every config key it cites must exist, keys in
 * section «الف» (owner rules) must be labelled `fixed` in code, and keys in section
 * «ب» (suggested values) must be labelled `suggested`.
 */

const doc = readFileSync(new URL('../docs/assumptions.md', import.meta.url), 'utf8');
const leaves = configLeaves(DEFAULT_GAME_CONFIG).map((l) => normalizeConfigPath(l.path));
const topLevelKeys = new Set(Object.keys(DEFAULT_GAME_CONFIG));

function section(marker: string): string {
  const start = doc.indexOf(`\n## ${marker}`);
  if (start === -1) throw new Error(`section «${marker}» not found`);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

function configKeys(text: string): string[] {
  const keys = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] ?? '');
  return [...new Set(keys.filter((k) => topLevelKeys.has(k.split(/[.[]/)[0] ?? '')))];
}

const matching = (key: string) => leaves.filter((leaf) => patternMatches(key, leaf));
const isWildcard = (key: string) => key.includes('*') || key.includes('[]');

const fixedSection = section('الف');
const suggestedSection = section('ب');
const fixedKeys = configKeys(fixedSection);
const suggestedKeys = configKeys(suggestedSection);

function wrongLabels(keys: string[], expected: ConfigLabel, exceptionKeys: string[]): string[] {
  // A specific key in the other section is an explicit exception to a wildcard here,
  // e.g. «الف» cites foods.*.nutrition while «ب» names foods.human.nutrition.
  // Exceptions only excuse wildcard expansions, never a key cited explicitly.
  const exceptions = new Set(exceptionKeys.filter((k) => !isWildcard(k)).flatMap(matching));
  return keys.flatMap((key) =>
    matching(key)
      .filter((leaf) => !(isWildcard(key) && exceptions.has(leaf)) && labelOf(leaf) !== expected)
      .map((leaf) => `${key} → ${leaf} is ${labelOf(leaf)}`),
  );
}

describe('docs/assumptions.md ↔ packages/config', () => {
  it('cites config keys in both rule sections', () => {
    expect(fixedKeys.length).toBeGreaterThan(10);
    expect(suggestedKeys.length).toBeGreaterThan(10);
  });

  it('cites only keys that exist in the config', () => {
    const unknown = [...fixedKeys, ...suggestedKeys].filter((k) => matching(k).length === 0);
    expect(unknown).toEqual([]);
  });

  it('never cites the same key as both a rule and a suggestion', () => {
    expect(fixedKeys.filter((k) => suggestedKeys.includes(k))).toEqual([]);
  });

  it('section «الف» cites only fixed owner rules', () => {
    expect(wrongLabels(fixedKeys, 'fixed', suggestedKeys)).toEqual([]);
  });

  it('section «ب» cites only suggested values', () => {
    expect(wrongLabels(suggestedKeys, 'suggested', fixedKeys)).toEqual([]);
  });

  it('documents every fixed rule that exists in code', () => {
    const documented = new Set(fixedKeys.flatMap(matching));
    const structural = /(^|\.)level$|\[\]\.level$/;
    const undocumented = [...new Set(leaves)].filter(
      (leaf) => labelOf(leaf) === 'fixed' && !documented.has(leaf) && !structural.test(leaf),
    );
    expect(undocumented).toEqual([]);
  });
});
