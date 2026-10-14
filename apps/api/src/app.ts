import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { DomainContext } from '@lulu/domain';
import type { Logger } from '@lulu/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import type { ActiveSession } from './auth/sessions.ts';
import { findActiveSession, safeEqual, sha256 } from './auth/sessions.ts';
import type { ApiErrorBody, AppInfo, RouteAccess } from './contract.ts';
import { CSRF_HEADER } from './contract.ts';
import { ApiError, codeForStatus, errorMessage } from './errors.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admins.ts';
import { announcementRoutes } from './routes/announcements.ts';
import { auditRoutes } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { configRoutes } from './routes/config.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { ghostRoutes } from './routes/ghosts.ts';
import { groupRoutes } from './routes/groups.ts';
import { healthRoutes } from './routes/health.ts';
import { playerRoutes } from './routes/players.ts';
import { systemRoutes } from './routes/system.ts';
import { transactionRoutes } from './routes/transactions.ts';
import { applySecurityHeaders } from './security.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every /api route; the app refuses to start without it. */
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** Set for every route whose access is not `public`. */
    session: ActiveSession | null;
  }
}

export interface ApiOptions {
  ctx: DomainContext;
  log: Logger;
  /**
   * Origin the panel is served from, e.g. https://panel.example.com. Development may
   * list more than one (localhost and 127.0.0.1 are different origins).
   */
  adminOrigin: string | readonly string[];
  sessionSecret: string;
  /** HTTPS deployment: `__Host-` cookie with Secure, plus HSTS. */
  cookieSecure: boolean;
  /** Fastify `trustProxy`: the reverse proxy in front, so request.ip is the client. */
  trustProxy?: boolean | string | number;
  /** Built panel (apps/admin/dist) served on the same origin. */
  staticDir?: string;
  /** Where the panel writes logical backups, and how many it keeps. */
  backups?: { dir: string; keep: number };
  app?: AppInfo;
}

export interface RegisteredRoute {
  method: string;
  url: string;
  access: RouteAccess;
}

export interface ApiDeps extends Required<Pick<ApiOptions, 'ctx' | 'log' | 'sessionSecret'>> {
  cookieName: string;
  cookieSecure: boolean;
  app: AppInfo;
  backups: { dir: string; keep: number } | undefined;
}

export const sessionCookieName = (secure: boolean) =>
  // `__Host-` needs Secure; plain-HTTP local development uses an unprefixed name.
  secure ? '__Host-lulu_session' : 'lulu_session';

/** A hop count becomes "trust the nearest N proxies". */
function trustProxyOption(value: ApiOptions['trustProxy']) {
  if (typeof value !== 'number') return value ?? false;
  return (_address: string, hop: number) => hop < value;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApi(
  options: ApiOptions,
): Promise<{ app: FastifyInstance; routes: RegisteredRoute[] }> {
  const allowedOrigins = new Set(
    (typeof options.adminOrigin === 'string' ? [options.adminOrigin] : options.adminOrigin).map(
      (o) => new URL(o).origin,
    ),
  );
  const deps: ApiDeps = {
    ctx: options.ctx,
    log: options.log,
    sessionSecret: options.sessionSecret,
    cookieName: sessionCookieName(options.cookieSecure),
    cookieSecure: options.cookieSecure,
    app: options.app ?? { mode: 'production' },
    backups: options.backups,
  };
  const log = options.log;

  const app = Fastify({
    logger: false,
    trustProxy: trustProxyOption(options.trustProxy),
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    routerOptions: { ignoreTrailingSlash: true },
  });

  // Every API route declares who may call it; a route without that never goes live.
  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const access = route.config?.access;
    if (access === undefined) {
      throw new Error(`route ${String(route.method)} ${route.url} does not declare its access`);
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method !== 'HEAD') routes.push({ method, url: route.url, access });
    }
  });

  await app.register(fastifyCookie);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request) => {
    // 1. Writes must come from the panel's own origin (CSRF, together with the token).
    if (UNSAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !allowedOrigins.has(origin))
        throw new ApiError('bad_origin');
    }
    const access = request.routeOptions.config.access ?? 'public';
    if (access === 'public') return;

    // 2. A live session.
    const token = request.cookies[deps.cookieName];
    let session = null;
    if (token) {
      const now = options.ctx.clock.now();
      const { config } = await options.ctx.config.effectiveAt(options.ctx.db, now);
      const idleMs = config.admin.sessionIdleMinutes * 60_000;
      session = await findActiveSession(options.ctx.db, token, now, idleMs);
    }
    if (!session) throw new ApiError('unauthenticated');

    // 3. The per-session CSRF token on writes.
    if (UNSAFE_METHODS.has(request.method)) {
      const csrf = request.headers[CSRF_HEADER];
      if (typeof csrf !== 'string' || !safeEqual(sha256(csrf), session.csrfTokenHash)) {
        throw new ApiError('bad_csrf');
      }
    }

    // 4. Role.
    if (access === 'owner' && session.admin.role !== 'owner') throw new ApiError('forbidden');
    request.session = session;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    applySecurityHeaders(reply, { hsts: options.cookieSecure });
    reply.header('x-request-id', request.id);
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    // Path pattern only: no query strings, bodies, cookies or tokens in logs.
    log.info('http', {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      requestId: request.id,
      ...(request.session ? { adminId: request.session.admin.id } : {}),
    });
  });

  const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        requestId: request.id,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    };
    if (error.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(error.retryAfterSeconds));
    }
    return reply.code(error.status).type('application/json; charset=utf-8').send(body);
  };

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) return sendError(request, reply, err);
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      log.error('request failed', { requestId: request.id, error: err });
      return sendError(request, reply, new ApiError('internal'));
    }
    const code = codeForStatus(status);
    return sendError(request, reply, new ApiError(code, { message: errorMessage(code) }));
  });

  const staticDir =
    options.staticDir && existsSync(join(options.staticDir, 'index.html'))
      ? options.staticDir
      : undefined;
  if (staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        // Hashed bundle names never change content; the HTML always revalidates.
        reply.header(
          'cache-control',
          /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (
      staticDir &&
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      request.url !== '/api'
    ) {
      // Client-side routes of the single-page panel.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendError(request, reply, new ApiError('not_found'));
  });

  await app.register(healthRoutes, { deps });
  await app.register(authRoutes, { deps });
  await app.register(dashboardRoutes, { deps });
  await app.register(systemRoutes, { deps });
  await app.register(playerRoutes, { deps });
  await app.register(transactionRoutes, { deps });
  await app.register(groupRoutes, { deps });
  await app.register(configRoutes, { deps });
  await app.register(ghostRoutes, { deps });
  await app.register(announcementRoutes, { deps });
  await app.register(adminRoutes, { deps });
  await app.register(accountRoutes, { deps });
  await app.register(auditRoutes, { deps });
  return { app, routes };
}
