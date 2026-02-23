import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface Tenant {
  teamsTenantId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export class TenantStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
    logger.info('TenantStore initialized');
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        teams_tenant_id TEXT PRIMARY KEY,
        chatwoot_account_id INTEGER NOT NULL UNIQUE,
        chatwoot_inbox_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  getByTeamsTenantId(teamsTenantId: string): Tenant | undefined {
    const row = this.db.prepare(
      'SELECT teams_tenant_id, chatwoot_account_id, chatwoot_inbox_id, name, created_at, updated_at FROM tenants WHERE teams_tenant_id = ?'
    ).get(teamsTenantId) as any;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  getByChatwootAccountId(chatwootAccountId: number): Tenant | undefined {
    const row = this.db.prepare(
      'SELECT teams_tenant_id, chatwoot_account_id, chatwoot_inbox_id, name, created_at, updated_at FROM tenants WHERE chatwoot_account_id = ?'
    ).get(chatwootAccountId) as any;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  getAll(): Tenant[] {
    const rows = this.db.prepare(
      'SELECT teams_tenant_id, chatwoot_account_id, chatwoot_inbox_id, name, created_at, updated_at FROM tenants ORDER BY name'
    ).all() as any[];

    return rows.map((row) => this.mapRow(row));
  }

  upsert(tenant: Pick<Tenant, 'teamsTenantId' | 'chatwootAccountId' | 'chatwootInboxId' | 'name'>): Tenant {
    this.db.prepare(`
      INSERT INTO tenants (teams_tenant_id, chatwoot_account_id, chatwoot_inbox_id, name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(teams_tenant_id) DO UPDATE SET
        chatwoot_account_id = excluded.chatwoot_account_id,
        chatwoot_inbox_id = excluded.chatwoot_inbox_id,
        name = excluded.name,
        updated_at = datetime('now')
    `).run(tenant.teamsTenantId, tenant.chatwootAccountId, tenant.chatwootInboxId, tenant.name);

    return this.getByTeamsTenantId(tenant.teamsTenantId)!;
  }

  delete(teamsTenantId: string): boolean {
    const result = this.db.prepare('DELETE FROM tenants WHERE teams_tenant_id = ?').run(teamsTenantId);
    return result.changes > 0;
  }

  private mapRow(row: any): Tenant {
    return {
      teamsTenantId: row.teams_tenant_id,
      chatwootAccountId: row.chatwoot_account_id,
      chatwootInboxId: row.chatwoot_inbox_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
