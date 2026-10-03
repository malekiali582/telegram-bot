import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Database } from '@lulu/database';
import { jobRuns, jobState, queryRows } from '@lulu/database';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from './logger.ts';

/**
 * Periodic jobs scheduled through PostgreSQL only (no Redis/BullMQ). A job runs when
 * its `next_run_at` has passed and no live lease exists; claiming is one atomic
 * UPDATE … RETURNING, so of several workers exactly one runs a job. A crashed worker's
 * lease simply expires. Every run is recorded in `job_runs` for the admin dashboard.
 */

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Lease length; must exceed the longest expected run. */
  leaseMs?: number;
  run(): Promise<Record<string, unknown> | void>;
}

export const newOwnerId = () => `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

export class JobScheduler {
  readonly ownerId: string;
  private readonly db: Database;
  private readonly jobs: JobDefinition[];
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(
    db: Database,
    jobs: JobDefinition[],
    log: Logger,
    now: () => Date = () => new Date(),
    ownerId: string = newOwnerId(),
  ) {
    this.db = db;
    this.jobs = jobs;
    this.log = log;
    this.now = now;
    this.ownerId = ownerId;
  }

  /** Creates missing job rows (due immediately); existing schedules are kept. */
  async ensureJobs(): Promise<void> {
    for (const job of this.jobs) {
      await this.db
        .insert(jobState)
        .values({ name: job.name, nextRunAt: this.now() })
        .onConflictDoNothing();
    }
  }

  /** Claims the job if it is due and unleased. */
  async tryClaim(job: JobDefinition): Promise<boolean> {
    const now = this.now();
    const until = new Date(now.getTime() + (job.leaseMs ?? 5 * 60_000));
    const rows = await queryRows<{ name: string }>(
      this.db,
      sql`UPDATE job_state SET lease_owner = ${this.ownerId},
                               lease_expires_at = ${until.toISOString()}::timestamptz,
                               last_started_at = ${now.toISOString()}::timestamptz,
                               updated_at = ${now.toISOString()}::timestamptz
          WHERE name = ${job.name}
            AND next_run_at <= ${now.toISOString()}::timestamptz
            AND (lease_expires_at IS NULL OR lease_expires_at < ${now.toISOString()}::timestamptz)
          RETURNING name`,
    );
    return rows.length === 1;
  }

  /** Runs every due job once. Returns the names of the jobs this process ran. */
  async tick(): Promise<string[]> {
    const ran: string[] = [];
    for (const job of this.jobs) {
      if (!(await this.tryClaim(job))) continue;
      ran.push(job.name);
      await this.execute(job);
    }
    return ran;
  }

  private async execute(job: JobDefinition): Promise<void> {
    const startedAt = this.now();
    const [run] = await this.db
      .insert(jobRuns)
      .values({ jobName: job.name, leaseOwner: this.ownerId, startedAt, status: 'running' })
      .returning({ id: jobRuns.id });
    let error: string | null = null;
    let stats: Record<string, unknown> = {};
    try {
      stats = (await job.run()) ?? {};
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.log.error('job failed', { job: job.name, error: err });
    }
    const finishedAt = this.now();
    await this.db
      .update(jobRuns)
      .set({ finishedAt, status: error ? 'failed' : 'succeeded', error, stats })
      .where(eq(jobRuns.id, run!.id));
    await this.db
      .update(jobState)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        lastFinishedAt: finishedAt,
        lastError: error,
        consecutiveFailures: error ? sql`${jobState.consecutiveFailures} + 1` : 0,
        nextRunAt: new Date(finishedAt.getTime() + job.intervalMs),
        updatedAt: finishedAt,
      })
      .where(eq(jobState.name, job.name));
  }
}

/**
 * A lease held continuously (for the single outbox sender). Returns true while this
 * owner holds it; renew it well before it expires.
 */
export async function holdLease(
  db: Database,
  name: string,
  ownerId: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  await db.insert(jobState).values({ name, nextRunAt: now }).onConflictDoNothing();
  const until = new Date(now.getTime() + leaseMs);
  const rows = await queryRows<{ name: string }>(
    db,
    sql`UPDATE job_state SET lease_owner = ${ownerId},
                             lease_expires_at = ${until.toISOString()}::timestamptz,
                             updated_at = ${now.toISOString()}::timestamptz
        WHERE name = ${name}
          AND (lease_owner = ${ownerId} OR lease_expires_at IS NULL
               OR lease_expires_at < ${now.toISOString()}::timestamptz)
        RETURNING name`,
  );
  return rows.length === 1;
}

export async function releaseLease(db: Database, name: string, ownerId: string): Promise<void> {
  await queryRows(
    db,
    sql`UPDATE job_state SET lease_owner = NULL, lease_expires_at = NULL
        WHERE name = ${name} AND lease_owner = ${ownerId} RETURNING name`,
  );
}
