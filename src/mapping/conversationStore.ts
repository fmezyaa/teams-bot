import Database from 'better-sqlite3';
import { ConversationReference } from 'botbuilder';
import { logger } from '../utils/logger';
import { ContactMapping, ConversationMapping } from './types';

export class ConversationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
    logger.info('ConversationStore initialized');
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contact_mappings (
        tenant_id TEXT NOT NULL DEFAULT '',
        teams_user_id TEXT NOT NULL,
        chatwoot_contact_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, teams_user_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_mappings (
        tenant_id TEXT NOT NULL DEFAULT '',
        teams_conversation_id TEXT NOT NULL,
        teams_user_id TEXT NOT NULL,
        chatwoot_conversation_id INTEGER NOT NULL UNIQUE,
        conversation_reference TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, teams_conversation_id, teams_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_chatwoot
        ON conversation_mappings(chatwoot_conversation_id);
    `);
  }

  getContactByTeamsUserId(tenantId: string, teamsUserId: string): ContactMapping | undefined {
    const row = this.db.prepare(
      'SELECT tenant_id, teams_user_id, chatwoot_contact_id, display_name, email, created_at FROM contact_mappings WHERE tenant_id = ? AND teams_user_id = ?'
    ).get(tenantId, teamsUserId) as any;

    if (!row) return undefined;

    return {
      tenantId: row.tenant_id,
      teamsUserId: row.teams_user_id,
      chatwootContactId: row.chatwoot_contact_id,
      displayName: row.display_name,
      email: row.email,
      createdAt: row.created_at,
    };
  }

  upsertContact(tenantId: string, teamsUserId: string, chatwootContactId: number, displayName: string, email?: string): void {
    this.db.prepare(`
      INSERT INTO contact_mappings (tenant_id, teams_user_id, chatwoot_contact_id, display_name, email)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, teams_user_id) DO UPDATE SET
        chatwoot_contact_id = excluded.chatwoot_contact_id,
        display_name = excluded.display_name,
        email = excluded.email
    `).run(tenantId, teamsUserId, chatwootContactId, displayName, email ?? null);
  }

  getConversation(tenantId: string, teamsConversationId: string, teamsUserId: string): ConversationMapping | undefined {
    const row = this.db.prepare(
      'SELECT tenant_id, teams_conversation_id, teams_user_id, chatwoot_conversation_id, conversation_reference, created_at, updated_at FROM conversation_mappings WHERE tenant_id = ? AND teams_conversation_id = ? AND teams_user_id = ?'
    ).get(tenantId, teamsConversationId, teamsUserId) as any;

    if (!row) return undefined;

    return {
      tenantId: row.tenant_id,
      teamsConversationId: row.teams_conversation_id,
      teamsUserId: row.teams_user_id,
      chatwootConversationId: row.chatwoot_conversation_id,
      conversationReference: JSON.parse(row.conversation_reference),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getConversationByChatwootId(chatwootConversationId: number): ConversationMapping | undefined {
    const row = this.db.prepare(
      'SELECT tenant_id, teams_conversation_id, teams_user_id, chatwoot_conversation_id, conversation_reference, created_at, updated_at FROM conversation_mappings WHERE chatwoot_conversation_id = ?'
    ).get(chatwootConversationId) as any;

    if (!row) return undefined;

    return {
      tenantId: row.tenant_id,
      teamsConversationId: row.teams_conversation_id,
      teamsUserId: row.teams_user_id,
      chatwootConversationId: row.chatwoot_conversation_id,
      conversationReference: JSON.parse(row.conversation_reference),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertConversation(
    tenantId: string,
    teamsConversationId: string,
    teamsUserId: string,
    chatwootConversationId: number,
    conversationReference: ConversationReference
  ): void {
    this.db.prepare(`
      INSERT INTO conversation_mappings (tenant_id, teams_conversation_id, teams_user_id, chatwoot_conversation_id, conversation_reference)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, teams_conversation_id, teams_user_id) DO UPDATE SET
        chatwoot_conversation_id = excluded.chatwoot_conversation_id,
        conversation_reference = excluded.conversation_reference,
        updated_at = datetime('now')
    `).run(tenantId, teamsConversationId, teamsUserId, chatwootConversationId, JSON.stringify(conversationReference));
  }
}
