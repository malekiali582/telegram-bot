import { randomInt } from 'node:crypto';
import type { Database } from '@lulu/database';
import { ConfigProvider } from './config-service.ts';

/** Source of the current instant. Injected so tests control time exactly. */
export interface Clock {
  now(): Date;
}

/** Source of randomness. Production uses a CSPRNG; results never come from clients. */
export interface Rng {
  /** Uniform integer in the closed range [min, max]. */
  int(min: number, max: number): number;
}

export const systemClock: Clock = { now: () => new Date() };

export const cryptoRng: Rng = {
  int: (min, max) => randomInt(min, max + 1),
};

/** Everything a domain service needs. Built once per process (bot, api, worker). */
export interface DomainContext {
  db: Database;
  clock: Clock;
  rng: Rng;
  config: ConfigProvider;
}

export function createDomainContext(
  db: Database,
  overrides: Partial<Omit<DomainContext, 'db'>> = {},
): DomainContext {
  return {
    db,
    clock: overrides.clock ?? systemClock,
    rng: overrides.rng ?? cryptoRng,
    config: overrides.config ?? new ConfigProvider(),
  };
}

/** Thrown for invariant violations and misuse — never for ordinary game outcomes. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
