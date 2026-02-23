import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { ChatwootWebhookPayload } from './types';
import { BridgeService } from '../services/bridgeService';

export function createChatwootWebhookRouter(bridgeService: BridgeService): Router {
  const router = Router();

  router.post('/webhook', (req: Request, res: Response) => {
    // Respond immediately to avoid webhook timeout
    res.status(200).json({ status: 'ok' });

    const payload = req.body as ChatwootWebhookPayload;

    logger.debug({ event: payload.event, messageType: payload.message_type }, 'Chatwoot webhook received');

    // Only process outgoing (agent) messages that are not private
    if (payload.event !== 'message_created') {
      logger.debug({ event: payload.event }, 'Ignoring non-message event');
      return;
    }

    if (payload.message_type !== 1) {
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
  });

  return router;
}
