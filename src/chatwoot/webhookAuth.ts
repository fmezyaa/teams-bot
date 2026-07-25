import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger';

/**
 * Shared secret authentication for the Chatwoot webhook.
 *
 * Chatwoot's API inbox lets us configure exactly one webhook URL and no custom
 * headers in every UI variant, so the secret is accepted from either:
 *   - the header `x-ezyaa-webhook-secret`, or
 *   - a trailing path segment (`POST /api/chatwoot/webhook/<secret>`).
 *
 * Rollout is two-staged so an existing deployment never breaks:
 *   - `CHATWOOT_WEBHOOK_SECRET` unset  → no check at all (legacy behaviour).
 *   - set + `CHATWOOT_WEBHOOK_ENFORCE=false` (default) → unauthenticated calls
 *     are still processed but logged as `[webhook-unsigned]` warnings.
 *   - set + `CHATWOOT_WEBHOOK_ENFORCE=true` → unauthenticated calls get 401.
 */

export const WEBHOOK_SECRET_HEADER = 'x-ezyaa-webhook-secret';

/** Grep-friendly marker for calls that arrived without a valid secret. */
export const UNSIGNED_MARKER = '[webhook-unsigned]';

export interface WebhookAuthOptions {
  /** Expected secret; empty string disables the check entirely. */
  secret: string;
  /** When true, invalid/missing secrets are rejected with 401. */
  enforce: boolean;
}

/**
 * Length-safe, constant-time secret comparison.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees equal-length
 * buffers (it throws otherwise, and comparing lengths up front would leak the
 * secret length). Never throws — any unexpected input yields `false`.
 */
export function secretsMatch(expected: string, provided: unknown): boolean {
  try {
    if (typeof expected !== 'string' || expected.length === 0) return false;
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
    const b = crypto.createHash('sha256').update(provided, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Reads the candidate secret from the header or the `:secret` path segment. */
export function extractProvidedSecret(req: Pick<Request, 'headers' | 'params'>): string | undefined {
  const raw = req.headers?.[WEBHOOK_SECRET_HEADER];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  if (typeof fromHeader === 'string' && fromHeader.trim().length > 0) {
    return fromHeader.trim();
  }

  // Express has already URL-decoded route params.
  const fromPath = (req.params as Record<string, string | undefined> | undefined)?.secret;
  if (typeof fromPath === 'string' && fromPath.trim().length > 0) {
    return fromPath.trim();
  }

  return undefined;
}

function remoteIp(req: Request): string | undefined {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof first === 'string' && first.trim().length > 0) {
    return first.split(',')[0]?.trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}

export function createWebhookAuthMiddleware(options: WebhookAuthOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!options.secret) {
      next();
      return;
    }

    const provided = extractProvidedSecret(req);
    if (secretsMatch(options.secret, provided)) {
      next();
      return;
    }

    // Deliberately never log the provided value — a near-miss guess would end
    // up in the logs. Only log *where* a candidate was supplied.
    const context = {
      remoteIp: remoteIp(req),
      hasHeaderSecret: typeof req.headers?.[WEBHOOK_SECRET_HEADER] === 'string',
      hasPathSecret: typeof (req.params as Record<string, unknown> | undefined)?.secret === 'string',
      enforce: options.enforce,
    };

    if (options.enforce) {
      logger.warn(context, `${UNSIGNED_MARKER} rejected Chatwoot webhook without valid secret`);
      res.status(401).json({ error: 'invalid_webhook_secret' });
      return;
    }

    logger.warn(
      context,
      `${UNSIGNED_MARKER} Chatwoot webhook without valid secret accepted (CHATWOOT_WEBHOOK_ENFORCE=false)`,
    );
    next();
  };
}

/** Startup diagnostics for the current webhook auth configuration. */
export function logWebhookAuthStatus(options: WebhookAuthOptions): void {
  if (!options.secret) {
    logger.warn(
      `${UNSIGNED_MARKER} CHATWOOT_WEBHOOK_SECRET is not set — the Chatwoot webhook is UNAUTHENTICATED. ` +
        'Anyone who knows the URL can send messages to Teams users in the name of the bot. ' +
        'Set CHATWOOT_WEBHOOK_SECRET (and later CHATWOOT_WEBHOOK_ENFORCE=true).',
    );
    return;
  }

  if (!options.enforce) {
    logger.warn(
      'CHATWOOT_WEBHOOK_SECRET is set but CHATWOOT_WEBHOOK_ENFORCE=false — unsigned webhook calls are ' +
        `still processed and logged with ${UNSIGNED_MARKER}. Flip to true once the logs are clean.`,
    );
    return;
  }

  logger.info('Chatwoot webhook secret enforced (401 on missing/invalid secret)');
}
