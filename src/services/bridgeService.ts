import { CloudAdapter, ConversationReference, MessageFactory } from 'botbuilder';
import { logger } from '../utils/logger';
import { ChatwootClient } from '../chatwoot/chatwootClient';
import { ChatwootWebhookPayload } from '../chatwoot/types';
import { ConversationStore } from '../mapping/conversationStore';
import { TenantStore } from '../mapping/tenantStore';
import { GraphProactiveService } from './graphProactiveService';

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
  private graphProactive: GraphProactiveService;

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
    this.graphProactive = new GraphProactiveService();
  }

  async handleTeamsMessage(payload: TeamsMessagePayload): Promise<void> {
    const { teamsTenantId, teamsUserId, teamsConversationId, userName, userEmail, text, conversationReference } = payload;

    // Resolve tenant
    const tenant = await this.tenantStore.getByTeamsTenantId(teamsTenantId);
    if (!tenant) {
      logger.warn({ teamsTenantId }, 'No tenant configured for Teams tenant ID');
      throw new Error(`No tenant configured for Teams tenant ID: ${teamsTenantId}`);
    }

    const { chatwootAccountId, chatwootInboxId } = tenant;

    // 1. Find or create Chatwoot contact
    let contactMapping = await this.store.getContactByTeamsUserId(teamsTenantId, teamsUserId);
    let chatwootContactId: number;

    if (contactMapping) {
      chatwootContactId = contactMapping.chatwootContactId;
    } else {
      const contact = await this.chatwootClient.findOrCreateContact(chatwootAccountId, teamsUserId, userName, userEmail);
      chatwootContactId = contact.id;
      await this.store.upsertContact(teamsTenantId, teamsUserId, chatwootContactId, userName, userEmail);
    }

    // 2. Find or create Chatwoot conversation
    let conversationMapping = await this.store.getConversation(teamsTenantId, teamsConversationId, teamsUserId);
    let chatwootConversationId: number;

    if (conversationMapping) {
      chatwootConversationId = conversationMapping.chatwootConversationId;
    } else {
      const sourceId = `teams:${teamsConversationId}:${teamsUserId}`;
      const conversation = await this.chatwootClient.createConversation(chatwootAccountId, chatwootInboxId, chatwootContactId, sourceId);
      chatwootConversationId = conversation.id;
    }

    // 3. Store/update conversation reference (needed for proactive messages back to Teams)
    await this.store.upsertConversation(
      teamsTenantId,
      teamsConversationId,
      teamsUserId,
      chatwootConversationId,
      conversationReference as ConversationReference
    );

    if (conversationReference.conversation?.conversationType === 'personal') {
      await this.store.upsertDmConversationReference(
        teamsTenantId,
        teamsUserId,
        conversationReference as ConversationReference,
      );
    }

    // 4. Send message to Chatwoot as incoming (from user).
    //    Recovery: Wird die gemappte Chatwoot-Conversation zwischenzeitlich
    //    geloescht (z.B. manuell), antwortet Chatwoot mit 404. Dann ist die
    //    gespeicherte Zuordnung tot — ohne Recovery wuerde jede weitere
    //    Teams-Nachricht dieses Chats dauerhaft 404en. Wir legen daher Kontakt
    //    + Conversation neu an, aktualisieren das Mapping und senden erneut.
    try {
      await this.chatwootClient.sendMessage(chatwootAccountId, chatwootConversationId, text, 'incoming');
    } catch (error) {
      if (!BridgeService.isNotFound(error)) {
        throw error;
      }
      logger.warn({
        teamsTenantId,
        teamsUserId,
        chatwootAccountId,
        staleChatwootConversationId: chatwootConversationId,
      }, 'Chatwoot conversation not found (404) — recreating contact + conversation and retrying');

      // Kontakt neu sicherstellen (Loeschung der Conversation laesst den Kontakt
      // i.d.R. bestehen; findOrCreate ist via identifier idempotent und deckt
      // auch den Fall ab, dass der Kontakt mitgeloescht wurde).
      const contact = await this.chatwootClient.findOrCreateContact(chatwootAccountId, teamsUserId, userName, userEmail);
      await this.store.upsertContact(teamsTenantId, teamsUserId, contact.id, userName, userEmail);

      const sourceId = `teams:${teamsConversationId}:${teamsUserId}`;
      const conversation = await this.chatwootClient.createConversation(chatwootAccountId, chatwootInboxId, contact.id, sourceId);
      chatwootConversationId = conversation.id;

      await this.store.upsertConversation(
        teamsTenantId,
        teamsConversationId,
        teamsUserId,
        chatwootConversationId,
        conversationReference as ConversationReference
      );

      await this.chatwootClient.sendMessage(chatwootAccountId, chatwootConversationId, text, 'incoming');

      logger.info({
        teamsTenantId,
        teamsUserId,
        chatwootAccountId,
        chatwootConversationId,
      }, 'Recovered from stale Chatwoot conversation (recreated)');
    }

    logger.info({
      teamsTenantId,
      teamsUserId,
      chatwootAccountId,
      chatwootConversationId,
    }, 'Teams → Chatwoot message forwarded');
  }

  /** True, wenn der Fehler ein HTTP-404 von Chatwoot (Axios) ist. */
  private static isNotFound(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
    return status === 404;
  }

  async handleChatwootWebhook(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.conversation!.id;
    const chatwootAccountId = payload.account?.id;
    const content = payload.content!;

    // Resolve tenant from Chatwoot account ID
    if (!chatwootAccountId) {
      logger.warn({ chatwootConversationId }, 'Chatwoot webhook missing account ID');
      return;
    }

    const tenant = await this.tenantStore.getByChatwootAccountId(chatwootAccountId);
    if (!tenant) {
      logger.warn({ chatwootAccountId, chatwootConversationId }, 'No tenant configured for Chatwoot account');
      return;
    }

    // Look up the Teams conversation mapping scoped to tenant
    const mapping = await this.store.getConversationByChatwootId(tenant.teamsTenantId, chatwootConversationId);
    if (!mapping) {
      logger.warn({ chatwootConversationId, chatwootAccountId }, 'No Teams mapping found for Chatwoot conversation');
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

  async sendProactiveDm(opts: {
    teamsTenantId: string;
    teamsUserId: string;
    text: string;
    target?: 'dm';
  }): Promise<void> {
    const { teamsTenantId, teamsUserId, text } = opts;
    let conversationReference = await this.store.getDmConversationReference(
      teamsTenantId,
      teamsUserId,
    );

    if (!conversationReference) {
      const chat = await this.graphProactive.ensurePersonalChat(teamsTenantId, teamsUserId);
      if (!chat) {
        throw new Error('Could not resolve Teams personal chat for proactive message');
      }
      conversationReference = this.graphProactive.buildConversationReference({
        tenantId: teamsTenantId,
        teamsUserId,
        chatId: chat.chatId,
        serviceUrl: chat.serviceUrl,
        botId: this.appId,
      }) as ConversationReference;
      await this.store.upsertDmConversationReference(
        teamsTenantId,
        teamsUserId,
        conversationReference,
      );
    }

    await this.adapter.continueConversationAsync(
      this.appId,
      conversationReference,
      async (turnContext) => {
        await turnContext.sendActivity(MessageFactory.text(text));
      },
    );

    logger.info({
      teamsTenantId,
      teamsUserId,
      textLength: text.length,
    }, 'Proactive Teams DM sent');
  }
}
