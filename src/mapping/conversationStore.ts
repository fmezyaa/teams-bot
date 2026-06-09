import { Pool } from 'pg';
import { ConversationReference } from 'botbuilder';
import { logger } from '../utils/logger';
import { ContactMapping, ConversationMapping } from './types';

export class ConversationStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    logger.info('ConversationStore initialized');
  }

  async getContactByTeamsUserId(tenantId: string, teamsUserId: string): Promise<ContactMapping | undefined> {
    const result = await this.pool.query(
      'SELECT tenant_id, teams_user_id, chatwoot_contact_id, display_name, email, created_at FROM teams_bot_contact_mappings WHERE tenant_id = $1 AND teams_user_id = $2',
      [tenantId, teamsUserId]
    );

    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];

    return {
      tenantId: row.tenant_id,
      teamsUserId: row.teams_user_id,
      chatwootContactId: Number(row.chatwoot_contact_id),
      displayName: row.display_name,
      email: row.email,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  async upsertContact(tenantId: string, teamsUserId: string, chatwootContactId: number, displayName: string, email?: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO teams_bot_contact_mappings (tenant_id, teams_user_id, chatwoot_contact_id, display_name, email)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, teams_user_id) DO UPDATE SET
        chatwoot_contact_id = excluded.chatwoot_contact_id,
        display_name = excluded.display_name,
        email = excluded.email
      `,
      [tenantId, teamsUserId, chatwootContactId, displayName, email ?? null]
    );
  }

  async getConversation(tenantId: string, teamsConversationId: string, teamsUserId: string): Promise<ConversationMapping | undefined> {
    const result = await this.pool.query(
      'SELECT tenant_id, teams_conversation_id, teams_user_id, chatwoot_conversation_id, conversation_reference, created_at, updated_at FROM teams_bot_conversation_mappings WHERE tenant_id = $1 AND teams_conversation_id = $2 AND teams_user_id = $3',
      [tenantId, teamsConversationId, teamsUserId]
    );

    if (result.rows.length === 0) return undefined;
    return this.mapRow(result.rows[0]);
  }

  async getConversationByChatwootId(tenantId: string, chatwootConversationId: number): Promise<ConversationMapping | undefined> {
    const result = await this.pool.query(
      'SELECT tenant_id, teams_conversation_id, teams_user_id, chatwoot_conversation_id, conversation_reference, created_at, updated_at FROM teams_bot_conversation_mappings WHERE tenant_id = $1 AND chatwoot_conversation_id = $2',
      [tenantId, chatwootConversationId]
    );

    if (result.rows.length === 0) return undefined;
    return this.mapRow(result.rows[0]);
  }

  async upsertConversation(
    tenantId: string,
    teamsConversationId: string,
    teamsUserId: string,
    chatwootConversationId: number,
    conversationReference: ConversationReference
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO teams_bot_conversation_mappings (tenant_id, teams_conversation_id, teams_user_id, chatwoot_conversation_id, conversation_reference)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, teams_conversation_id, teams_user_id) DO UPDATE SET
        chatwoot_conversation_id = excluded.chatwoot_conversation_id,
        conversation_reference = excluded.conversation_reference,
        updated_at = now()
      `,
      [tenantId, teamsConversationId, teamsUserId, chatwootConversationId, JSON.stringify(conversationReference)]
    );
  }

  private mapRow(row: any): ConversationMapping {
    return {
      tenantId: row.tenant_id,
      teamsConversationId: row.teams_conversation_id,
      teamsUserId: row.teams_user_id,
      chatwootConversationId: Number(row.chatwoot_conversation_id),
      conversationReference: JSON.parse(row.conversation_reference),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }
}
