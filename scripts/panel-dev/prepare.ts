import { randomBytes } from 'node:crypto';
import { activeOwners, createAdminUser, resetAdminPassword } from '@lulu/api';
import type { DatabaseHandle } from '@lulu/database';
import { migrateDatabase } from '@lulu/database';
import { ensureDefaultConfig } from '@lulu/domain';
import type { SeedOptions, SeedResult } from './seed.ts';
import { seedSampleData } from './seed.ts';

export const DEV_OWNER = 'owner';

export interface PreparedPanelDatabase {
  seed: SeedResult;
  /** The new password when the owner account was just made or reset; otherwise null. */
  owner: { username: string; password: string | null };
}

/**
 * The panel's development database: migrations, the game configuration, labelled
 * sample data (first run only) and a local owner account with a random password.
 */
export async function preparePanelDatabase(
  handle: DatabaseHandle,
  options: { sample: SeedOptions; newPassword: boolean },
): Promise<PreparedPanelDatabase> {
  await migrateDatabase(handle);
  await ensureDefaultConfig(handle.db);
  const seed = await seedSampleData(handle.db, options.sample);
  const now = options.sample.now;

  const password = randomBytes(12).toString('base64url');
  const [owner] = await activeOwners(handle.db);
  if (!owner) {
    const created = await createAdminUser(handle.db, {
      username: DEV_OWNER,
      password,
      role: 'owner',
      now,
    });
    if (created.status !== 'ok')
      throw new Error(`could not create the dev owner: ${created.status}`);
    return { seed, owner: { username: DEV_OWNER, password } };
  }
  if (options.newPassword) {
    const reset = await resetAdminPassword(handle.db, { adminUserId: owner.id, password, now });
    if (reset.status !== 'ok') throw new Error(`could not reset the dev owner: ${reset.status}`);
    return { seed, owner: { username: owner.username, password } };
  }
  return { seed, owner: { username: owner.username, password: null } };
}
