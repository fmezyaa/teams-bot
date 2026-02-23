import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { createAdapter } from './bot/adapterFactory';
import { TeamsBot } from './bot/teamsBot';
import { ChatwootClient } from './chatwoot/chatwootClient';
import { createChatwootWebhookRouter } from './chatwoot/chatwootWebhook';
import { ConversationStore } from './mapping/conversationStore';
import { BridgeService } from './services/bridgeService';

// Initialize components
const adapter = createAdapter(
  config.microsoftAppId,
  config.microsoftAppPassword,
  config.microsoftAppTenantId
);

const chatwootClient = new ChatwootClient(
  config.chatwootBaseUrl,
  config.chatwootApiAccessToken,
  config.chatwootAccountId,
  config.chatwootInboxId
);

const store = new ConversationStore(config.dbPath);

const bridgeService = new BridgeService(
  chatwootClient,
  store,
  adapter,
  config.microsoftAppId
);

const bot = new TeamsBot(bridgeService);

// Express app
const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Teams Bot Framework endpoint
app.post('/api/messages', async (req, res) => {
  try {
    await adapter.process(req, res, (context) => bot.run(context));
  } catch (error) {
    logger.error({ error }, 'Error processing Teams message');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Chatwoot webhook endpoint
app.use('/api/chatwoot', createChatwootWebhookRouter(bridgeService));

// Start server
app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Chatwoot-Teams Bridge started');
  logger.info({ bridgeBaseUrl: config.bridgeBaseUrl }, 'Bridge base URL');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  store.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  store.close();
  process.exit(0);
});
