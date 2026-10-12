import type { Database, Executor } from '@lulu/database';
import { queryRows } from '@lulu/database';
import { HEARTBEAT_STALE_MS, OUTBOX_CHANNEL, SENDER_LEASE } from '@lulu/runtime';
import { sql } from 'drizzle-orm';
import type {
  JobRunView,
  JobView,
  OutboxMessageView,
  ServiceInstanceView,
  ServiceState,
  SystemSummaryView,
  SystemView,
} from './contract.ts';

/**
 * Operational status for the panel: bot and worker heartbeats, scheduled jobs and the
 * outgoing message queue. Read-only, except `retryDeadMessage`.
 */

const OVERDUE_MS = 5 * 60_000;
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

async function services(db: Database, now: Date): Promise<ServiceInstanceView[]> {
  const rows = await queryRows<{
    service: 'bot' | 'worker';
    instance: string;
    started_at: Date;
    last_seen_at: Date;
    stopped_at: Date | null;
    details: Record<string, unknown>;
  }>(
    db,
    sql`SELECT service, instance, started_at, last_seen_at, stopped_at, details
        FROM service_heartbeats
        WHERE last_seen_at > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz
        ORDER BY service, last_seen_at DESC`,
  );
  return rows.map((r) => ({
    service: r.service,
    instance: r.instance,
    state:
      r.stopped_at !== null
        ? 'stopped'
        : now.getTime() - new Date(r.last_seen_at).getTime() > HEARTBEAT_STALE_MS
          ? 'unresponsive'
          : 'online',
    startedAt: iso(r.started_at)!,
    lastSeenAt: iso(r.last_seen_at)!,
    stoppedAt: iso(r.stopped_at),
    details: r.details,
  }));
}

/** Online if any process is; otherwise the most recent one's state. */
function serviceState(list: ServiceInstanceView[], service: 'bot' | 'worker'): ServiceState {
  const mine = list.filter((s) => s.service === service);
  if (mine.some((s) => s.state === 'online')) return 'online';
  return mine[0]?.state ?? 'never';
}

const runView = (r: {
  id: number | string;
  job_name: string;
  status: JobRunView['status'];
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}): JobRunView => ({
  id: Number(r.id),
  job: r.job_name,
  status: r.status,
  startedAt: iso(r.started_at)!,
  finishedAt: iso(r.finished_at),
  error: r.error,
});

async function jobs(db: Database, now: Date): Promise<JobView[]> {
  const states = await queryRows<{
    name: string;
    next_run_at: Date;
    lease_expires_at: Date | null;
    last_started_at: Date | null;
    last_finished_at: Date | null;
    last_error: string | null;
    consecutive_failures: number;
  }>(db, sql`SELECT * FROM job_state WHERE name <> ${SENDER_LEASE} ORDER BY name`);
  const runs = await queryRows<Parameters<typeof runView>[0] & { rank: number }>(
    db,
    sql`SELECT * FROM (
          SELECT id, job_name, status, started_at, finished_at, error,
                 row_number() OVER (PARTITION BY job_name ORDER BY started_at DESC, id DESC) AS rank
          FROM job_runs) r
        WHERE rank <= 10 ORDER BY job_name, started_at DESC, id DESC`,
  );
  return states.map((s) => {
    const running = s.lease_expires_at !== null && new Date(s.lease_expires_at) > now;
    return {
      name: s.name,
      nextRunAt: iso(s.next_run_at)!,
      lastStartedAt: iso(s.last_started_at),
      lastFinishedAt: iso(s.last_finished_at),
      lastError: s.last_error,
      consecutiveFailures: s.consecutive_failures,
      running,
      overdue: !running && now.getTime() - new Date(s.next_run_at).getTime() > OVERDUE_MS,
      recentRuns: runs.filter((r) => r.job_name === s.name).map(runView),
    };
  });
}

type OutboxRow = {
  id: number | string;
  platform: OutboxMessageView['platform'];
  kind: OutboxMessageView['kind'];
  status: OutboxMessageView['status'];
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  next_attempt_at: Date;
  group_id: number | string | null;
  group_title: string | null;
};

function messageText(kind: OutboxRow['kind'], payload: Record<string, unknown>): string | null {
  const text =
    kind === 'edit'
      ? (payload.edit as { text?: unknown } | undefined)?.text
      : kind === 'answer_button'
        ? payload.text
        : payload.text;
  return typeof text === 'string' ? text.slice(0, 500) : null;
}

export function messageView(r: OutboxRow): OutboxMessageView {
  const chatId = typeof r.payload.platformChatId === 'string' ? r.payload.platformChatId : null;
  return {
    id: Number(r.id),
    platform: r.platform,
    kind: r.kind,
    status: r.status,
    chatId,
    group: r.group_id !== null ? { id: Number(r.group_id), title: r.group_title ?? '' } : null,
    text: messageText(r.kind, r.payload),
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: iso(r.created_at)!,
    nextAttemptAt: iso(r.next_attempt_at)!,
  };
}

/** The chat id, current or from before a supergroup migration, resolved to its group. */
const outboxWithGroup = sql`
  SELECT o.id, o.platform, o.kind, o.status, o.payload, o.attempts, o.last_error,
         o.created_at, o.next_attempt_at, g.id AS group_id, g.title AS group_title
  FROM outbox o
  LEFT JOIN LATERAL (
    SELECT group_id FROM group_identities gi
     WHERE gi.platform = o.platform AND gi.platform_chat_id = o.payload->>'platformChatId'
    UNION ALL
    SELECT group_id FROM group_identity_history gh
     WHERE gh.platform = o.platform AND gh.platform_chat_id = o.payload->>'platformChatId'
    LIMIT 1) k ON true
  LEFT JOIN groups g ON g.id = k.group_id`;

async function outboxStatus(db: Database, now: Date): Promise<SystemView['outbox']> {
  const [counts] = await queryRows<{
    pending: number;
    dead: number;
    sent24h: number;
    oldest: Date | null;
  }>(
    db,
    sql`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
               count(*) FILTER (WHERE status = 'dead')::int AS dead,
               count(*) FILTER (WHERE status = 'sent'
                 AND sent_at > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz)::int AS sent24h,
               min(created_at) FILTER (WHERE status = 'pending') AS oldest
        FROM outbox`,
  );
  const [lease] = await queryRows<{ active: boolean }>(
    db,
    sql`SELECT lease_expires_at > ${now.toISOString()}::timestamptz AS active
        FROM job_state WHERE name = ${SENDER_LEASE}`,
  );
  const dead = await queryRows<OutboxRow>(
    db,
    sql`${outboxWithGroup} WHERE o.status = 'dead' ORDER BY o.created_at DESC, o.id DESC LIMIT 50`,
  );
  return {
    pending: counts?.pending ?? 0,
    dead: counts?.dead ?? 0,
    sent24h: counts?.sent24h ?? 0,
    oldestPendingAt: iso(counts?.oldest ?? null),
    senderActive: lease?.active === true,
    deadMessages: dead.map(messageView),
  };
}

async function failedRuns(db: Database, now: Date, sinceMs: number, limit: number) {
  return (
    await queryRows<Parameters<typeof runView>[0]>(
      db,
      sql`SELECT id, job_name, status, started_at, finished_at, error FROM job_runs
          WHERE status = 'failed'
            AND started_at > ${new Date(now.getTime() - sinceMs).toISOString()}::timestamptz
          ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
    )
  ).map(runView);
}

function summarize(
  serviceList: ServiceInstanceView[],
  jobList: JobView[],
  outbox: { pending: number; dead: number },
  failed24h: number,
): SystemSummaryView {
  return {
    bot: serviceState(serviceList, 'bot'),
    worker: serviceState(serviceList, 'worker'),
    jobsWithProblems: jobList.filter((j) => j.overdue || j.lastError !== null).length,
    pendingMessages: outbox.pending,
    deadMessages: outbox.dead,
    failedRuns24h: failed24h,
  };
}

export async function systemStatus(db: Database, now: Date): Promise<SystemView> {
  const serviceList = await services(db, now);
  const jobList = await jobs(db, now);
  const outbox = await outboxStatus(db, now);
  const recentFailures = await failedRuns(db, now, 7 * 86_400_000, 20);
  const failed24h = recentFailures.filter(
    (r) => now.getTime() - new Date(r.startedAt).getTime() < 86_400_000,
  ).length;
  return {
    now: now.toISOString(),
    summary: summarize(serviceList, jobList, outbox, failed24h),
    services: serviceList,
    jobs: jobList,
    recentFailures,
    outbox,
  };
}

/** The status card on the dashboard: the same numbers, without the lists. */
export async function systemSummary(db: Database, now: Date): Promise<SystemSummaryView> {
  return (await systemStatus(db, now)).summary;
}

export type RetryResult =
  { status: 'ok'; previousError: string | null } | { status: 'not_found' } | { status: 'not_dead' };

/** Puts a failed message back in the queue with a fresh set of attempts. */
export async function retryDeadMessage(db: Executor, id: number, now: Date): Promise<RetryResult> {
  const [row] = await queryRows<{ status: string; last_error: string | null }>(
    db,
    sql`SELECT status, last_error FROM outbox WHERE id = ${id}`,
  );
  if (!row) return { status: 'not_found' };
  const updated = await queryRows<{ id: number }>(
    db,
    sql`UPDATE outbox SET status = 'pending', attempts = 0,
               next_attempt_at = ${now.toISOString()}::timestamptz
        WHERE id = ${id} AND status = 'dead' RETURNING id`,
  );
  if (updated.length === 0) return { status: 'not_dead' };
  await db.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`);
  return { status: 'ok', previousError: row.last_error };
}
