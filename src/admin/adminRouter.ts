import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { TenantStore } from '../mapping/tenantStore';

export function createAdminRouter(tenantStore: TenantStore, adminApiToken: string): Router {
  const router = Router();

  // Serve admin frontend (no auth required — login happens client-side)
  router.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/admin.html'));
  });

  // Bearer token auth middleware
  router.use((req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = authHeader.slice(7);
    if (token !== adminApiToken) {
      res.status(403).json({ error: 'Invalid API token' });
      return;
    }
    next();
  });

  // GET /tenants - List all tenants
  router.get('/tenants', async (_req: Request, res: Response) => {
    try {
      const tenants = await tenantStore.getAll();
      res.json(tenants);
    } catch (error) {
      logger.error({ error }, 'Failed to list tenants');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /tenants/by-account/:chatwootAccountId
  router.get('/tenants/by-account/:chatwootAccountId', async (req: Request, res: Response) => {
    try {
      const accountId = Number(req.params.chatwootAccountId);
      if (!Number.isFinite(accountId)) {
        res.status(400).json({ error: 'chatwootAccountId must be a number' });
        return;
      }
      const tenant = await tenantStore.getByChatwootAccountId(accountId);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      res.json(tenant);
    } catch (error) {
      logger.error({ error, accountId: req.params.chatwootAccountId }, 'Failed to get tenant by account');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /tenants/:id - Get single tenant
  router.get('/tenants/:id', async (req: Request, res: Response) => {
    try {
      const tenant = await tenantStore.getByTeamsTenantId(req.params.id as string);
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      res.json(tenant);
    } catch (error) {
      logger.error({ error, tenantId: req.params.id }, 'Failed to get tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /tenants - Create or update tenant
  router.post('/tenants', async (req: Request, res: Response) => {
    try {
      const {
        teamsTenantId,
        chatwootAccountId,
        chatwootInboxId,
        name,
        graphEnrichmentEnabled,
        greetingEnabled,
        greetingText,
      } = req.body;

      if (!teamsTenantId || !chatwootAccountId || !chatwootInboxId || !name) {
        res.status(400).json({
          error: 'Missing required fields: teamsTenantId, chatwootAccountId, chatwootInboxId, name',
        });
        return;
      }

      if (typeof chatwootAccountId !== 'number' || typeof chatwootInboxId !== 'number') {
        res.status(400).json({ error: 'chatwootAccountId and chatwootInboxId must be numbers' });
        return;
      }

      if (graphEnrichmentEnabled !== undefined && typeof graphEnrichmentEnabled !== 'boolean') {
        res.status(400).json({ error: 'graphEnrichmentEnabled must be a boolean' });
        return;
      }

      const tenant = await tenantStore.upsert({
        teamsTenantId,
        chatwootAccountId,
        chatwootInboxId,
        name,
        graphEnrichmentEnabled: graphEnrichmentEnabled === true,
        greetingEnabled: Boolean(greetingEnabled),
        greetingText: typeof greetingText === 'string' ? greetingText : null,
      });
      logger.info({ teamsTenantId, name }, 'Tenant upserted via Admin API');
      res.status(201).json(tenant);
    } catch (error) {
      logger.error({ error }, 'Failed to upsert tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /tenants/:id - Delete tenant
  router.delete('/tenants/:id', async (req: Request, res: Response) => {
    try {
      const deleted = await tenantStore.delete(req.params.id as string);
      if (!deleted) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      logger.info({ tenantId: req.params.id }, 'Tenant deleted via Admin API');
      res.status(204).send();
    } catch (error) {
      logger.error({ error, tenantId: req.params.id }, 'Failed to delete tenant');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
