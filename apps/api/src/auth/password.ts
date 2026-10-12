import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Admin passwords: scrypt (memory-hard, in Node's standard library), random 16-byte
 * salt, stored as `scrypt$<N>$<r>$<p>$<salt>$<hash>` so the cost can be raised later
 * without breaking existing hashes.
 */

const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const PREFIX = 'scrypt';

export const PASSWORD_MIN_LENGTH = 12;
/** Bounds the hashing work an attacker can request per login attempt. */
export const PASSWORD_MAX_LENGTH = 256;

function derive(
  password: string,
  salt: Buffer,
  cost: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFC'),
      salt,
      KEY_LENGTH,
      // 128 * N * r bytes are needed; leave headroom.
      { ...cost, maxmem: 256 * cost.N * cost.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return [
    PREFIX,
    COST.N,
    COST.r,
    COST.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** Constant-time comparison; false (never an exception) for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!N || !r || !p || N > 2 ** 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;

/**
 * A real hash of a random password. Checked when the username does not exist, so a
 * login for an unknown user takes as long as one with a wrong password.
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummy;
}

export type PasswordProblem = 'too_short' | 'too_long';

export function checkNewPassword(password: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}
