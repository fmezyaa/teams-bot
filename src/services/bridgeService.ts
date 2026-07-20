import { CloudAdapter, ConversationReference, MessageFactory } from 'botbuilder';
import { logger } from '../utils/logger';
import { ChatwootClient } from '../chatwoot/chatwootClient';
import { ChatwootWebhookPayload } from '../chatwoot/types';
import { ConversationStore } from '../mapping/conversationStore';
import { TenantStore, Tenant } from '../mapping/tenantStore';
import { EnrichmentService } from './enrichmentService';
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
  private enrichmentService?: EnrichmentService;
  private graphEnabled: boolean;
  private graphProactive: GraphProactiveService;

  constructor(
    chatwootClient: ChatwootClient,
    store: ConversationStore,
    tenantStore: TenantStore,
    adapter: CloudAdapter,
    appId: string,
    options: { enrichmentService?: EnrichmentService; graphEnabled?: boolean } = {},
  ) {
    this.chatwootClient = chatwootClient;
    this.store = store;
    this.tenantStore = tenantStore;
    this.adapter = adapter;
    this.appId = appId;
    this.enrichmentService = options.enrichmentService;
    this.graphEnabled = options.graphEnabled ?? false;
    this.graphProactive = new GraphProactiveService();
  }

  async handleTeamsMessage(payload: TeamsMessagePayload): Promise<void> {
    const {
      teamsTenantId,
      teamsUserId,
      teamsConversationId,
      userName,
      userEmail,
      text,
      conversationReference,
    } = payload;

    const tenant = await this.tenantStore.getByTeamsTenantId(teamsTenantId);
    if (!tenant) {
      logger.warn({ teamsTenantId }, 'No tenant configured for Teams tenant ID');
      throw new Error(`No tenant configured for Teams tenant ID: ${teamsTenantId}`);
    }

    const { chatwootAccountId, chatwootInboxId } = tenant;

    let contactMapping = await this.store.getContactByTeamsUserId(teamsTenantId, teamsUserId);
    let chatwootContactId: number;

    if (contactMapping) {
      chatwootContactId = contactMapping.chatwootContactId;
    } else {
      const contact = await this.chatwootClient.findOrCreateContact(
        chatwootAccountId,
        teamsUserId,
        userName,
        userEmail,
      );
      chatwootContactId = contact.id;
      await this.store.upsertContact(teamsTenantId, teamsUserId, chatwootContactId, userName, userEmail);
    }

    // Best-effort Microsoft Graph enrichment (Standort/Position/Region).
    // Fire-and-forget: never awaited, never throws, so it cannot block or break
    // the message flow. Gated per tenant + global Graph config.
    this.maybeEnrichContact(tenant, chatwootContactId, teamsUserId);

    // 2. Find or create Chatwoot conversation
    let conversationMapping = await this.store.getConversation(
      teamsTenantId,
      teamsConversationId,
      teamsUserId,
    );

    // Reply-routing fallback: proactive DMs use Graph chat IDs; Bot Framework
    // replies often arrive with a different conversation id (`a:...`).
    if (!conversationMapping && conversationReference.conversation?.conversationType === 'personal') {
      const fallback = await this.store.getLatestPersonalConversationByUser(teamsTenantId, teamsUserId);
      if (fallback) {
        conversationMapping = fallback;
        logger.info(
          {
            teamsTenantId,
            teamsUserId,
            previousConversationId: fallback.teamsConversationId,
            newConversationId: teamsConversationId,
            chatwootConversationId: fallback.chatwootConversationId,
          },
          'Reusing Chatwoot conversation via personal-DM fallback lookup',
        );
      }
    }

    let chatwootConversationId: number;

    if (conversationMapping) {
      chatwootConversationId = conversationMapping.chatwootConversationId;
    } else {
      const sourceId = `teams:${teamsConversationId}:${teamsUserId}`;
      const conversation = await this.chatwootClient.createConversation(
        chatwootAccountId,
        chatwootInboxId,
        chatwootContactId,
        sourceId,
      );
      chatwootConversationId = conversation.id;
    }

    // Always refresh mapping with the latest Bot Framework reference + conversation id.
    await this.store.upsertConversation(
      teamsTenantId,
      teamsConversationId,
      teamsUserId,
      chatwootConversationId,
      conversationReference as ConversationReference,
    );

    if (conversationReference.conversation?.conversationType === 'personal') {
      await this.store.upsertDmConversationReference(
        teamsTenantId,
        teamsUserId,
        conversationReference as ConversationReference,
      );
    }

    try {
      await this.chatwootClient.sendMessage(chatwootAccountId, chatwootConversationId, text, 'incoming');
    } catch (error) {
      if (!BridgeService.isNotFound(error)) {
        throw error;
      }
      logger.warn(
        {
          teamsTenantId,
          teamsUserId,
          chatwootAccountId,
          staleChatwootConversationId: chatwootConversationId,
        },
        'Chatwoot conversation not found (404) — recreating contact + conversation and retrying',
      );

      const contact = await this.chatwootClient.findOrCreateContact(
        chatwootAccountId,
        teamsUserId,
        userName,
        userEmail,
      );
      await this.store.upsertContact(teamsTenantId, teamsUserId, contact.id, userName, userEmail);

      // Keep enrichment consistent when the contact is (re)created here. The
      // TTL cache dedupes against the initial attempt above for the same user.
      this.maybeEnrichContact(tenant, contact.id, teamsUserId);

      const sourceId = `teams:${teamsConversationId}:${teamsUserId}`;
      const conversation = await this.chatwootClient.createConversation(
        chatwootAccountId,
        chatwootInboxId,
        contact.id,
        sourceId,
      );
      chatwootConversationId = conversation.id;

      await this.store.upsertConversation(
        teamsTenantId,
        teamsConversationId,
        teamsUserId,
        chatwootConversationId,
        conversationReference as ConversationReference,
      );

      await this.chatwootClient.sendMessage(chatwootAccountId, chatwootConversationId, text, 'incoming');

      logger.info(
        {
          teamsTenantId,
          teamsUserId,
          chatwootAccountId,
          chatwootConversationId,
        },
        'Recovered from stale Chatwoot conversation (recreated)',
      );
    }

    logger.info(
      {
        teamsTenantId,
        teamsUserId,
        chatwootAccountId,
        chatwootConversationId,
      },
      'Teams → Chatwoot message forwarded',
    );
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

    if (!chatwootAccountId) {
      logger.warn({ chatwootConversationId }, 'Chatwoot webhook missing account ID');
      return;
    }

    const tenant = await this.tenantStore.getByChatwootAccountId(chatwootAccountId);
    if (!tenant) {
      logger.warn({ chatwootAccountId, chatwootConversationId }, 'No tenant configured for Chatwoot account');
      return;
    }

    const inboxId = payload.conversation?.inbox_id;
    if (inboxId != null && Number(inboxId) !== tenant.chatwootInboxId) {
      logger.debug(
        { inboxId, expectedInboxId: tenant.chatwootInboxId, chatwootConversationId },
        'Ignoring webhook for non-Teams inbox',
      );
      return;
    }

    const mapping = await this.store.getConversationByChatwootId(
      tenant.teamsTenantId,
      chatwootConversationId,
    );

    if (mapping) {
      await this.deliverViaContinueConversation(mapping.conversationReference, content, {
        chatwootConversationId,
        teamsConversationId: mapping.teamsConversationId,
        tenantId: mapping.tenantId,
      });
      return;
    }

    // First-contact campaign path: no mapping yet — resolve Teams user and send proactively.
    const teamsUserId = await this.resolveTeamsUserIdFromWebhook(payload, tenant.chatwootAccountId);
    if (!teamsUserId) {
      logger.warn(
        { chatwootConversationId, chatwootAccountId },
        'No Teams mapping and could not resolve contact identifier for proactive DM',
      );
      return;
    }

    logger.info(
      { chatwootConversationId, chatwootAccountId, teamsUserId },
      'No Teams mapping — delivering as first-contact proactive DM',
    );

    const sendResult = await this.sendProactiveDm({
      teamsTenantId: tenant.teamsTenantId,
      teamsUserId,
      text: content,
      target: 'dm',
    });

    await this.store.upsertConversation(
      tenant.teamsTenantId,
      sendResult.chatId,
      teamsUserId,
      chatwootConversationId,
      sendResult.conversationReference,
    );
    await this.store.upsertDmConversationReference(
      tenant.teamsTenantId,
      teamsUserId,
      sendResult.conversationReference,
    );

    const sender = payload.conversation?.meta?.sender;
    await this.store.upsertContact(
      tenant.teamsTenantId,
      teamsUserId,
      sender?.id ?? payload.conversation?.contact_id ?? 0,
      sender?.name ?? 'Teams User',
      sender?.email,
    );

    logger.info(
      {
        chatwootConversationId,
        teamsUserId,
        chatId: sendResult.chatId,
        tenantId: tenant.teamsTenantId,
      },
      'First-contact Chatwoot → Teams DM delivered and mapped',
    );
  }

  private async resolveTeamsUserIdFromWebhook(
    payload: ChatwootWebhookPayload,
    chatwootAccountId: number,
  ): Promise<string | null> {
    const fromMeta = payload.conversation?.meta?.sender?.identifier?.trim();
    if (fromMeta) return fromMeta;

    const fromSender = payload.sender?.identifier?.trim();
    if (fromSender && payload.sender?.type !== 'user') {
      // agent bot / user messages — identifier may not be Teams AAD id
    }
    if (fromSender) return fromSender;

    const contactId = payload.conversation?.meta?.sender?.id ?? payload.conversation?.contact_id;
    if (contactId) {
      const contact = await this.chatwootClient.getContact(chatwootAccountId, Number(contactId));
      if (contact?.identifier?.trim()) return contact.identifier.trim();
    }

    return null;
  }

  private async deliverViaContinueConversation(
    conversationReference: ConversationReference,
    content: string,
    logCtx: { chatwootConversationId: number; teamsConversationId: string; tenantId: string },
  ): Promise<void> {
    try {
      await this.adapter.continueConversationAsync(this.appId, conversationReference, async (turnContext) => {
        await turnContext.sendActivity(MessageFactory.text(content));
      });

      logger.info(logCtx, 'Chatwoot → Teams message forwarded');
    } catch (error) {
      logger.error(
        {
          error,
          chatwootConversationId: logCtx.chatwootConversationId,
          teamsConversationId: logCtx.teamsConversationId,
        },
        'Failed to send proactive message to Teams',
      );
      throw error;
    }
  }

  async sendProactiveDm(opts: {
    teamsTenantId: string;
    teamsUserId: string;
    text: string;
    target?: 'dm';
  }): Promise<{ chatId: string; conversationReference: ConversationReference }> {
    const { teamsTenantId, teamsUserId, text } = opts;
    let conversationReference = await this.store.getDmConversationReference(teamsTenantId, teamsUserId);

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
      await this.store.upsertDmConversationReference(teamsTenantId, teamsUserId, conversationReference);
    }

    await this.adapter.continueConversationAsync(
      this.appId,
      conversationReference,
      async (turnContext) => {
        await turnContext.sendActivity(MessageFactory.text(text));
      },
    );

    const chatId = conversationReference.conversation?.id;
    if (!chatId) {
      throw new Error('Proactive DM conversation reference missing conversation id');
    }

    logger.info(
      {
        teamsTenantId,
        teamsUserId,
        textLength: text.length,
        chatId,
      },
      'Proactive Teams DM sent',
    );

    return { chatId, conversationReference };
  }

  async getGreetingForTenant(
    teamsTenantId: string,
  ): Promise<{ enabled: boolean; text: string } | null> {
    const tenant = await this.tenantStore.getByTeamsTenantId(teamsTenantId);
    if (!tenant) return null;
    if (!tenant.greetingEnabled) {
      return { enabled: false, text: '' };
    }
    return {
      enabled: true,
      text:
        tenant.greetingText?.trim() ||
        'Hallo! Schreib mir gerne deine Frage — ich helfe dir sofort weiter.',
    };
  }
}
