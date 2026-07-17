import axios from 'axios';
import { ConversationReference } from 'botbuilder';
import { config } from '../config';
import { logger } from '../utils/logger';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Default Bot Framework service URL for EMEA.
 * Documented assumption for our deployment region.
 */
const DEFAULT_SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

export class GraphProactiveService {
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  async getAppOnlyToken(tenantId: string): Promise<string> {
    const cached = this.tokenCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached.token;
    }
    const body = new URLSearchParams({
      client_id: config.microsoftAppId,
      client_secret: config.microsoftAppPassword,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
    const { data } = await axios.post<{ access_token: string; expires_in?: number }>(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    this.tokenCache.set(tenantId, { token: data.access_token, expiresAt });
    return data.access_token;
  }

  /**
   * Ensures the Teams bot app is installed for the user and returns the
   * personal bot↔user chat id (not an arbitrary one-on-one human chat).
   */
  async ensurePersonalChat(
    tenantId: string,
    teamsUserId: string,
  ): Promise<{ chatId: string; serviceUrl: string } | null> {
    try {
      const token = await this.getAppOnlyToken(tenantId);
      const headers = { Authorization: `Bearer ${token}` };

      const catalog = await axios.get<{ value: Array<{ id: string }> }>(
        `${GRAPH}/appCatalogs/teamsApps`,
        {
          headers,
          params: {
            $filter: `externalId eq '${config.microsoftAppId}'`,
          },
        },
      );
      const teamsAppId = catalog.data.value?.[0]?.id;
      if (!teamsAppId) {
        logger.warn('Teams app catalog entry not found for proactive install');
        return null;
      }

      try {
        await axios.post(
          `${GRAPH}/users/${teamsUserId}/teamwork/installedApps`,
          {
            'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${teamsAppId}`,
          },
          { headers: { ...headers, 'Content-Type': 'application/json' } },
        );
      } catch (installErr: unknown) {
        const ax = installErr as { response?: { status?: number } };
        if (ax.response?.status !== 409) {
          logger.warn({ installErr }, 'App install failed (non-409)');
        }
      }

      // Resolve the installation id for THIS bot app (not a random oneOnOne chat).
      const installed = await axios.get<{
        value: Array<{ id: string; teamsApp?: { externalId?: string; id?: string } }>;
      }>(`${GRAPH}/users/${teamsUserId}/teamwork/installedApps`, {
        headers,
        params: {
          $expand: 'teamsApp',
          $filter: `teamsApp/externalId eq '${config.microsoftAppId}'`,
        },
      });

      const installationId = installed.data.value?.[0]?.id;
      if (!installationId) {
        logger.warn(
          { teamsUserId, tenantId },
          'Bot app installation not found after install attempt',
        );
        return null;
      }

      const chatRes = await axios.get<{ id: string }>(
        `${GRAPH}/users/${teamsUserId}/teamwork/installedApps/${installationId}/chat`,
        { headers },
      );

      if (!chatRes.data?.id) {
        logger.warn({ teamsUserId, installationId }, 'Bot personal chat not found');
        return null;
      }

      return {
        chatId: chatRes.data.id,
        serviceUrl: DEFAULT_SERVICE_URL,
      };
    } catch (err: unknown) {
      logger.error({ err }, 'ensurePersonalChat failed');
      return null;
    }
  }

  buildConversationReference(opts: {
    tenantId: string;
    teamsUserId: string;
    chatId: string;
    serviceUrl: string;
    botId: string;
  }): Partial<ConversationReference> {
    return {
      channelId: 'msteams',
      serviceUrl: opts.serviceUrl,
      conversation: {
        id: opts.chatId,
        tenantId: opts.tenantId,
        conversationType: 'personal',
        isGroup: false,
      } as ConversationReference['conversation'],
      bot: {
        id: opts.botId,
        name: 'Support Assistant',
      },
      user: {
        id: opts.teamsUserId,
        name: 'User',
      },
    };
  }
}
