import { CloudAdapter, ConversationReference, MessageFactory } from 'botbuilder';
import { logger } from '../utils/logger';
import { ChatwootClient } from '../chatwoot/chatwootClient';
import { ChatwootWebhookPayload } from '../chatwoot/types';
import { ConversationStore } from '../mapping/conversationStore';
import { TenantStore } from '../mapping/tenantStore';

export interface TeamsMessagePayload {
  teamsTenantId: string;
  teamsUserId: string;
  teamsConversationId: string;
  userName: string;
  userEmail?: string;
  text: string;
  conversationReference: Partial<ConversationReference>;
}

export class BridgeService {
  private chatwootClient: ChatwootClient;
  private store: ConversationStore;
  private tenantStore: TenantStore;
  private adapter: CloudAdapter;
  private appId: string;

  constructor(
    chatwootClient: ChatwootClient,
    store: ConversationStore,
    tenantStore: TenantStore,
    adapter: CloudAdapter,
    appId: string
  ) {
    this.chatwootClient = chatwootClient;
    this.store = store;
    this.tenantStore = tenantStore;
    this.adapter = adapter;
    this.appId = appId;
  }

  async handleTeamsMessage(payload: TeamsMessagePayload): Promise<void> {
    const { teamsTenantId, teamsUserId, teamsConversationId, userName, userEmail, text, conversationReference } = payload;

    // Resolve tenant
    const tenant = this.tenantStore.getByTeamsTenantId(teamsTenantId);
    if (!tenant) {
      logger.warn({ teamsTenantId }, 'No tenant configured for Teams tenant ID');
      throw new Error(`No tenant configured for Teams tenant ID: ${teamsTenantId}`);
    }

    const { chatwootAccountId, chatwootInboxId } = tenant;

    // 1. Find or create Chatwoot contact
    let contactMapping = this.store.getContactByTeamsUserId(teamsTenantId, teamsUserId);
    let chatwootContactId: number;

    if (contactMapping) {
      chatwootContactId = contactMapping.chatwootContactId;
    } else {
      const contact = await this.chatwootClient.findOrCreateContact(chatwootAccountId, teamsUserId, userName, userEmail);
      chatwootContactId = contact.id;
      this.store.upsertContact(teamsTenantId, teamsUserId, chatwootContactId, userName, userEmail);
    }

    // 2. Find or create Chatwoot conversation
    let conversationMapping = this.store.getConversation(teamsTenantId, teamsConversationId, teamsUserId);
    let chatwootConversationId: number;

    if (conversationMapping) {
      chatwootConversationId = conversationMapping.chatwootConversationId;
    } else {
      const sourceId = `teams:${teamsConversationId}:${teamsUserId}`;
      const conversation = await this.chatwootClient.createConversation(chatwootAccountId, chatwootInboxId, chatwootContactId, sourceId);
      chatwootConversationId = conversation.id;
    }

    // 3. Store/update conversation reference (needed for proactive messages back to Teams)
    this.store.upsertConversation(
      teamsTenantId,
      teamsConversationId,
      teamsUserId,
      chatwootConversationId,
      conversationReference as ConversationReference
    );

    // 4. Send message to Chatwoot as incoming (from user)
    await this.chatwootClient.sendMessage(chatwootAccountId, chatwootConversationId, text, 'incoming');

    logger.info({
      teamsTenantId,
      teamsUserId,
      chatwootAccountId,
      chatwootConversationId,
    }, 'Teams → Chatwoot message forwarded');
  }

  async handleChatwootWebhook(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.conversation!.id;
    const content = payload.content!;

    // Look up the Teams conversation mapping (globally unique by chatwoot_conversation_id)
    const mapping = this.store.getConversationByChatwootId(chatwootConversationId);
    if (!mapping) {
      logger.warn({ chatwootConversationId }, 'No Teams mapping found for Chatwoot conversation');
      return;
    }

    const conversationReference = mapping.conversationReference;

    // Send proactive message to Teams
    try {
      await this.adapter.continueConversationAsync(
        this.appId,
        conversationReference,
        async (turnContext) => {
          await turnContext.sendActivity(MessageFactory.text(content));
        }
      );

      logger.info({
        chatwootConversationId,
        teamsConversationId: mapping.teamsConversationId,
        tenantId: mapping.tenantId,
      }, 'Chatwoot → Teams message forwarded');
    } catch (error) {
      logger.error({
        error,
        chatwootConversationId,
        teamsConversationId: mapping.teamsConversationId,
      }, 'Failed to send proactive message to Teams');
      throw error;
    }
  }
}
