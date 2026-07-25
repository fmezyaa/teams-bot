import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { ChatwootWebhookPayload } from './types';
import { BridgeService } from '../services/bridgeService';
import { createWebhookAuthMiddleware, WebhookAuthOptions } from './webhookAuth';

export function createChatwootWebhookRouter(
  bridgeService: BridgeService,
  auth: WebhookAuthOptions,
): Router {
  const router = Router();
  const requireSecret = createWebhookAuthMiddleware(auth);

  const handleWebhook = (req: Request, res: Response): void => {
    // Respond immediately to avoid webhook timeout
    res.status(200).json({ status: 'ok' });

    const payload = req.body as ChatwootWebhookPayload;

    // Full payload contains customer message content in cleartext — debug only.
    logger.debug({ payload: JSON.stringify(req.body).substring(0, 1000) }, 'Chatwoot webhook raw payload');
    logger.info(
      {
        event: payload.event,
        messageType: payload.message_type,
        hasContent: !!payload.content,
        accountId: payload.account?.id,
      },
      'Chatwoot webhook received',
    );

    // Only process outgoing (agent) messages that are not private
    if (payload.event !== 'message_created') {
      logger.debug({ event: payload.event }, 'Ignoring non-message event');
      return;
    }

    if (payload.message_type !== 1 && payload.message_type !== 'outgoing') {
      logger.debug({ messageType: payload.message_type }, 'Ignoring non-outgoing message');
      return;
    }

    if (payload.private) {
      logger.debug('Ignoring private message');
      return;
    }

    if (!payload.conversation?.id || !payload.content) {
      logger.warn('Webhook payload missing conversation ID or content');
      return;
    }

    bridgeService.handleChatwootWebhook(payload).catch((error) => {
      logger.error({ error, conversationId: payload.conversation?.id }, 'Failed to handle Chatwoot webhook');
    });
  };

  router.post('/webhook', requireSecret, handleWebhook);
  // Chatwoot's API inbox only stores a URL (no custom headers), so the secret
  // may also be passed as the last path segment.
  router.post('/webhook/:secret', requireSecret, handleWebhook);

  return router;
}
