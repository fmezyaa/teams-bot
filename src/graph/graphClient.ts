import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

/**
 * Selected fields we read from a Microsoft Graph user profile. Only these
 * three are requested via $select — nothing else is pulled.
 */
export interface GraphUserProfile {
  jobTitle?: string | null;
  officeLocation?: string | null;
  department?: string | null;
}

/** Error carrying the HTTP status of a failed Graph/token call. */
export class GraphError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
  }
}

interface CachedToken {
  accessToken: string;
  /** Epoch millis at which the token should be considered expired. */
  expiresAt: number;
}

const LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
/** Refresh a little before actual expiry to avoid edge-of-window failures. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * App-only Microsoft Graph client (client-credentials flow). A single
 * multi-tenant app registration authenticates against each customer tenant,
 * provided the customer granted admin consent for the Application permission
 * `User.Read.All`. Access tokens are cached in-memory per tenant.
 */
export class GraphClient {
  private clientId: string;
  private clientSecret: string;
  private http: AxiosInstance;
  private tokenCache = new Map<string, CachedToken>();

  constructor(clientId: string, clientSecret: string, http: AxiosInstance = axios) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.http = http;
  }

  /**
   * Fetch jobTitle / officeLocation / department for a user by AAD object ID
   * within the given tenant. Throws {@link GraphError} on failure (carrying the
   * HTTP status so callers can special-case 403 = missing admin consent).
   */
  async getUserProfile(teamsTenantId: string, aadObjectId: string): Promise<GraphUserProfile> {
    const token = await this.getToken(teamsTenantId);

    try {
      const response = await this.http.get(
        `${GRAPH_BASE}/users/${encodeURIComponent(aadObjectId)}`,
        {
          params: { $select: 'jobTitle,officeLocation,department' },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const data = response.data || {};
      return {
        jobTitle: data.jobTitle ?? null,
        officeLocation: data.officeLocation ?? null,
        department: data.department ?? null,
      };
    } catch (error) {
      throw GraphClient.toGraphError(error, 'Failed to fetch Graph user profile');
    }
  }

  /** Return a valid access token for the tenant, using the cache when possible. */
  private async getToken(teamsTenantId: string): Promise<string> {
    const cached = this.tokenCache.get(teamsTenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    });

    try {
      const response = await this.http.post(
        `${LOGIN_HOST}/${encodeURIComponent(teamsTenantId)}/oauth2/v2.0/token`,
        body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const accessToken: string | undefined = response.data?.access_token;
      const expiresInSec: number = Number(response.data?.expires_in) || 3600;
      if (!accessToken) {
        throw new GraphError('Token endpoint returned no access_token');
      }

      this.tokenCache.set(teamsTenantId, {
        accessToken,
        expiresAt: Date.now() + expiresInSec * 1000 - TOKEN_EXPIRY_BUFFER_MS,
      });
      return accessToken;
    } catch (error) {
      throw GraphClient.toGraphError(error, 'Failed to acquire Graph token');
    }
  }

  /** Normalize an axios/other error into a {@link GraphError} without leaking secrets. */
  private static toGraphError(error: unknown, message: string): GraphError {
    if (error instanceof GraphError) {
      return error;
    }
    const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
    return new GraphError(message, status);
  }

  /** Test/diagnostic helper: drop all cached tokens. */
  clearTokenCache(): void {
    this.tokenCache.clear();
  }
}
