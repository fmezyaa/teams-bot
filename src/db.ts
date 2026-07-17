import { Pool } from 'pg';
import { config } from './config';
import { logger } from './utils/logger';

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams_bot_tenants (
      teams_tenant_id TEXT PRIMARY KEY,
      chatwoot_account_id BIGINT NOT NULL UNIQUE,
      chatwoot_inbox_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      greeting_enabled BOOLEAN NOT NULL DEFAULT false,
      greeting_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Additive migrations for existing deployments.
  await pool.query(`
    ALTER TABLE teams_bot_tenants
      ADD COLUMN IF NOT EXISTS greeting_enabled BOOLEAN NOT NULL DEFAULT false;
  `);
  await pool.query(`
    ALTER TABLE teams_bot_tenants
      ADD COLUMN IF NOT EXISTS greeting_text TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams_bot_contact_mappings (
      tenant_id TEXT NOT NULL DEFAULT '',
      teams_user_id TEXT NOT NULL,
      chatwoot_contact_id BIGINT NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, teams_user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams_bot_conversation_mappings (
      tenant_id TEXT NOT NULL DEFAULT '',
      teams_conversation_id TEXT NOT NULL,
      teams_user_id TEXT NOT NULL,
      chatwoot_conversation_id BIGINT NOT NULL,
      conversation_reference TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, teams_conversation_id, teams_user_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_teams_bot_conversation_chatwoot
      ON teams_bot_conversation_mappings (tenant_id, chatwoot_conversation_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_teams_bot_conversation_user
      ON teams_bot_conversation_mappings (tenant_id, teams_user_id, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams_bot_dm_refs (
      tenant_id TEXT NOT NULL,
      teams_user_id TEXT NOT NULL,
      conversation_reference TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, teams_user_id)
    );
  `);

  logger.info('Database schema initialized');
}
