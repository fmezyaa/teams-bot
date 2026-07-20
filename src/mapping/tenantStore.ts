import { Pool } from 'pg';
import { logger } from '../utils/logger';

export interface Tenant {
  teamsTenantId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  name: string;
  graphEnrichmentEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const TENANT_COLUMNS =
  'teams_tenant_id, chatwoot_account_id, chatwoot_inbox_id, name, graph_enrichment_enabled, created_at, updated_at';

export class TenantStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    logger.info('TenantStore initialized');
  }

  async getByTeamsTenantId(teamsTenantId: string): Promise<Tenant | undefined> {
    const result = await this.pool.query(
      `SELECT ${TENANT_COLUMNS} FROM teams_bot_tenants WHERE teams_tenant_id = $1`,
      [teamsTenantId]
    );

    if (result.rows.length === 0) return undefined;
    return this.mapRow(result.rows[0]);
  }

  async getByChatwootAccountId(chatwootAccountId: number): Promise<Tenant | undefined> {
    const result = await this.pool.query(
      `SELECT ${TENANT_COLUMNS} FROM teams_bot_tenants WHERE chatwoot_account_id = $1`,
      [chatwootAccountId]
    );

    if (result.rows.length === 0) return undefined;
    return this.mapRow(result.rows[0]);
  }

  async getAll(): Promise<Tenant[]> {
    const result = await this.pool.query(
      `SELECT ${TENANT_COLUMNS} FROM teams_bot_tenants ORDER BY name`
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  async upsert(
    tenant: Pick<Tenant, 'teamsTenantId' | 'chatwootAccountId' | 'chatwootInboxId' | 'name'> &
      Partial<Pick<Tenant, 'graphEnrichmentEnabled'>>
  ): Promise<Tenant> {
    const result = await this.pool.query(
      `
      INSERT INTO teams_bot_tenants (teams_tenant_id, chatwoot_account_id, chatwoot_inbox_id, name, graph_enrichment_enabled)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (teams_tenant_id) DO UPDATE SET
        chatwoot_account_id = excluded.chatwoot_account_id,
        chatwoot_inbox_id = excluded.chatwoot_inbox_id,
        name = excluded.name,
        graph_enrichment_enabled = excluded.graph_enrichment_enabled,
        updated_at = now()
      RETURNING ${TENANT_COLUMNS}
      `,
      [
        tenant.teamsTenantId,
        tenant.chatwootAccountId,
        tenant.chatwootInboxId,
        tenant.name,
        tenant.graphEnrichmentEnabled ?? false,
      ]
    );

    return this.mapRow(result.rows[0]);
  }

  async delete(teamsTenantId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM teams_bot_tenants WHERE teams_tenant_id = $1', [teamsTenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: any): Tenant {
    return {
      teamsTenantId: row.teams_tenant_id,
      chatwootAccountId: Number(row.chatwoot_account_id),
      chatwootInboxId: Number(row.chatwoot_inbox_id),
      name: row.name,
      graphEnrichmentEnabled: row.graph_enrichment_enabled === true,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }
}
