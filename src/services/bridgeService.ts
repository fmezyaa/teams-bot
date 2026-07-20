import { CloudAdapter, ConversationReference, MessageFactory } from 'botbuilder';
import { logger } from '../utils/logger';
import { ChatwootClient } from '../chatwoot/chatwootClient';
import { ChatwootWebhookPayload } from '../chatwoot/types';
import { ConversationStore } from '../mapping/conversationStore';
import { TenantStore, Tenant } from '../mapping/tenantStore';
import { EnrichmentService } from './enrichmentService';

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
  private enrichmentService?: EnrichmentService;
  private graphEnabled: boolean;

  constructor(
    chatwootClient: ChatwootClient,
    store: ConversationStore,
    tenantStore: TenantStore,
    adapter: CloudAdapter,
    appId: string,
    options: { enrichmentService?: EnrichmentService; graphEnabled?: boolean } = {}
  ) {
    this.chatwootClient = chatwootClient;
    this.store = store;
    this.tenantStore = tenantStore;
    this.adapter = adapter;
    this.appId = appId;
    this.enrichmentService = options.enrichmentService;
    this.graphEnabled = options.graphEnabled ?? false;
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

    // Best-effort Microsoft Graph enrichment (Standort/Position/Region).
    // Fire-and-forget: never awaited, never throws, so it cannot block or break
    // the message flow. Gated per tenant + global Graph config.
    this.maybeEnrichContact(tenant, chatwootContactId, teamsUserId);

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

      // Keep enrichment consistent when the contact is (re)created here. The
      // TTL cache dedupes against the initial attempt above for the same user.
      this.maybeEnrichContact(tenant, contact.id, teamsUserId);

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

  /**
   * Fire-and-forget contact enrichment via Microsoft Graph, gated by the global
   * Graph config and the per-tenant `graphEnrichmentEnabled` flag. Deliberately
   * not awaited; the underlying service never throws, and any residual rejection
   * is swallowed so the message flow is never affected.
   */
  private maybeEnrichContact(tenant: Tenant, chatwootContactId: number, teamsUserId: string): void {
    if (!this.graphEnabled || !this.enrichmentService || !tenant.graphEnrichmentEnabled) {
      return;
    }
    void this.enrichmentService
      .enrichContact({
        teamsTenantId: tenant.teamsTenantId,
        aadObjectId: teamsUserId,
        chatwootAccountId: tenant.chatwootAccountId,
        chatwootContactId,
      })
      .catch((error) => {
        logger.warn({ error, teamsTenantId: tenant.teamsTenantId }, 'Unexpected enrichment rejection (ignored)');
      });
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
}
