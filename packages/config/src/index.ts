export * from './ids.ts';
export * from './schema.ts';
export * from './defaults.ts';
export * from './labels.ts';
export * from './env.ts';

import { gameConfigSchema } from './schema.ts';
import type { GameConfig } from './schema.ts';

/** Validates an untrusted config document (panel input, stored version). */
export function parseGameConfig(input: unknown): GameConfig {
  return gameConfigSchema.parse(input);
}
