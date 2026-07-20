import pino from 'pino';

/**
 * Sanitizing serializer for the `error` key.
 *
 * Axios errors carry the full request config — including the Chatwoot
 * `api_access_token` header — plus hundreds of lines of socket internals.
 * Logging them raw leaks the token into container logs (seen live on the
 * 404-recovery path). Only keep what is useful for debugging: message,
 * status, method, url, response body and stack. Never headers/config/request.
 */
function sanitizeError(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return error;
  const err = error as {
    message?: unknown;
    name?: unknown;
    stack?: unknown;
    response?: { status?: number; data?: unknown };
    config?: { method?: string; url?: string; baseURL?: string };
    isAxiosError?: boolean;
  };

  const base: Record<string, unknown> = {
    message: typeof err.message === 'string' ? err.message : String(error),
  };
  if (typeof err.name === 'string') base.name = err.name;
  if (err.response?.status !== undefined) base.status = err.response.status;
  if (err.response?.data !== undefined) base.responseData = err.response.data;
  if (err.config?.method) base.method = err.config.method.toUpperCase();
  if (err.config?.url) base.url = err.config.url;
  if (typeof err.stack === 'string' && !err.isAxiosError) base.stack = err.stack;
  return base;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    error: sanitizeError,
    err: sanitizeError,
  },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
