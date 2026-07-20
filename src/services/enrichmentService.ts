import { logger } from '../utils/logger';
import { ChatwootClient } from '../chatwoot/chatwootClient';
import { GraphClient, GraphError } from '../graph/graphClient';

export interface EnrichmentParams {
  teamsTenantId: string;
  /** AAD object ID of the Teams user (falls back to Teams user id upstream). */
  aadObjectId: string;
  chatwootAccountId: number;
  chatwootContactId: number;
}

/** Default: enrich a given (tenant, user) pair at most once per 24h. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort enrichment of a Chatwoot contact with Microsoft Graph profile
 * data (Standort/Position/Region). Fully fire-and-forget safe: never throws,
 * so it can never block the message flow. Deduplicated per (tenant, user) via
 * an in-memory TTL cache — a process restart simply re-runs it once (harmless).
 */
export class EnrichmentService {
  private graphClient: GraphClient;
  private chatwootClient: ChatwootClient;
  private ttlMs: number;
  private lastRun = new Map<string, number>();

  constructor(
    graphClient: GraphClient,
    chatwootClient: ChatwootClient,
    options: { ttlMs?: number } = {}
  ) {
    this.graphClient = graphClient;
    this.chatwootClient = chatwootClient;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Look up the user's Graph profile and write standort/position/region to the
   * Chatwoot contact. Any error (Graph, PATCH, unexpected) is caught and logged;
   * the promise always resolves. Call fire-and-forget (no await needed).
   */
  async enrichContact(params: EnrichmentParams): Promise<void> {
    const { teamsTenantId, aadObjectId, chatwootAccountId, chatwootContactId } = params;
    const cacheKey = `${teamsTenantId}:${aadObjectId}`;

    const last = this.lastRun.get(cacheKey);
    if (last !== undefined && Date.now() - last < this.ttlMs) {
      return;
    }
    // Mark the attempt up front so failures (e.g. missing consent) don't retry
    // on every message for the next TTL window.
    this.lastRun.set(cacheKey, Date.now());

    try {
      const profile = await this.graphClient.getUserProfile(teamsTenantId, aadObjectId);

      const attributes: Record<string, string> = {};
      if (profile.officeLocation) attributes.standort = profile.officeLocation;
      if (profile.jobTitle) attributes.position = profile.jobTitle;
      if (profile.department) attributes.region = profile.department;

      if (Object.keys(attributes).length === 0) {
        logger.debug({ teamsTenantId, aadObjectId }, 'Graph profile had no enrichable fields');
        return;
      }

      await this.chatwootClient.updateContactCustomAttributes(
        chatwootAccountId,
        chatwootContactId,
        attributes
      );

      logger.info(
        { teamsTenantId, chatwootContactId, keys: Object.keys(attributes) },
        'Enriched Chatwoot contact from Microsoft Graph'
      );
    } catch (error) {
      if (error instanceof GraphError && error.status === 403) {
        logger.warn(
          { teamsTenantId, aadObjectId },
          `Graph enrichment forbidden — Admin-Consent für User.Read.All im Tenant ${teamsTenantId} fehlt`
        );
        return;
      }
      const status = (error as GraphError | undefined)?.status;
      logger.warn(
        { teamsTenantId, aadObjectId, status },
        'Graph enrichment failed (ignored — message flow unaffected)'
      );
    }
  }
}
