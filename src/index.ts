import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { pool, initSchema } from './db';
import { createAdapter } from './bot/adapterFactory';
import { TeamsBot } from './bot/teamsBot';
import { ChatwootClient } from './chatwoot/chatwootClient';
import { createChatwootWebhookRouter } from './chatwoot/chatwootWebhook';
import { ConversationStore } from './mapping/conversationStore';
import { TenantStore } from './mapping/tenantStore';
import { BridgeService } from './services/bridgeService';
import { EnrichmentService } from './services/enrichmentService';
import { GraphClient } from './graph/graphClient';
import { createAdminRouter } from './admin/adminRouter';

// Initialize components
const adapter = createAdapter(
  config.microsoftAppId,
  config.microsoftAppPassword,
  config.microsoftAppTenantId
);

const chatwootClient = new ChatwootClient(
  config.chatwootBaseUrl,
  config.chatwootApiAccessToken
);

const tenantStore = new TenantStore(pool);
const store = new ConversationStore(pool);

// Microsoft Graph contact enrichment (optional; only wired when configured).
const enrichmentService = config.graph.enabled
  ? new EnrichmentService(
      new GraphClient(config.graph.clientId, config.graph.clientSecret),
      chatwootClient
    )
  : undefined;

if (config.graph.enabled) {
  logger.info('Microsoft Graph enrichment enabled (per-tenant flag still required)');
}

const bridgeService = new BridgeService(
  chatwootClient,
  store,
  tenantStore,
  adapter,
  config.microsoftAppId,
  { enrichmentService, graphEnabled: config.graph.enabled }
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
  } catch (error: any) {
    logger.error({ err: error, message: error?.message, stack: error?.stack, code: error?.code }, 'Error processing Teams message');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Chatwoot webhook endpoint
app.use('/api/chatwoot', createChatwootWebhookRouter(bridgeService));

// Admin API
app.use('/api/admin', createAdminRouter(tenantStore, config.adminApiToken));

// Start server
async function start(): Promise<void> {
  await initSchema();

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Chatwoot-Teams Bridge started');
    logger.info({ bridgeBaseUrl: config.bridgeBaseUrl }, 'Bridge base URL');
  });
}

start().catch((error) => {
  logger.error({ err: error }, 'Failed to start Chatwoot-Teams Bridge');
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
