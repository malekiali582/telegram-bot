import type { FastifyReply } from 'fastify';

/**
 * Strict headers on every response. The panel is a same-origin bundle with no inline
 * scripts or styles, so the CSP allows only 'self'; no page may frame it.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function applySecurityHeaders(reply: FastifyReply, options: { hsts: boolean }): void {
  reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  if (options.hsts)
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
}
