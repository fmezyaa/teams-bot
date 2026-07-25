import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { ChatwootContact, ChatwootConversation, ChatwootMessage } from './types';

export class ChatwootClient {
  private api: AxiosInstance;

  constructor(baseUrl: string, apiToken: string) {
    this.api = axios.create({
      baseURL: `${baseUrl}/api/v1`,
      headers: {
        'api_access_token': apiToken,
        'Content-Type': 'application/json',
      },
    });
  }

  private static getStatus(error: unknown): number | undefined {
    return (error as { response?: { status?: number } } | undefined)?.response?.status;
  }

  async searchContactsByQuery(accountId: number, query: string): Promise<ChatwootContact[]> {
    try {
      const response = await this.api.get(`/accounts/${accountId}/contacts/search`, {
        params: { q: query },
      });
      return response.data?.payload ?? [];
    } catch (error) {
      logger.error({ error, query, accountId }, 'Failed to search contact');
      throw error;
    }
  }

  /**
   * Look up a contact by its Teams identifier (AAD Object ID).
   *
   * Chatwoot's contact search is fuzzy and regularly returns unrelated
   * contacts. Only an *exact* identifier match may be returned — falling back
   * to the first search hit binds the Teams user to a stranger's contact and
   * persists that wrong mapping. No match means "create a new contact".
   */
  async searchContact(accountId: number, teamsUserId: string): Promise<ChatwootContact | undefined> {
    const contacts = await this.searchContactsByQuery(accountId, teamsUserId);
    const match = contacts.find((c) => c.identifier === teamsUserId);
    if (!match && contacts.length > 0) {
      logger.debug(
        { teamsUserId, accountId, candidates: contacts.length },
        'Contact search returned only non-exact matches — ignoring them',
      );
    }
    return match;
  }

  async getContact(accountId: number, contactId: number): Promise<ChatwootContact | undefined> {
    try {
      const response = await this.api.get(`/accounts/${accountId}/contacts/${contactId}`);
      const payload = response.data?.payload ?? response.data;
      const contact = payload?.contact ?? payload;
      if (!contact?.id) return undefined;
      return {
        id: Number(contact.id),
        name: contact.name ?? '',
        email: contact.email,
        identifier: contact.identifier,
        custom_attributes: contact.custom_attributes,
      };
    } catch (error) {
      logger.error({ error, contactId, accountId }, 'Failed to get contact');
      return undefined;
    }
  }

  async updateContact(
    accountId: number,
    contactId: number,
    data: { name?: string; email?: string; identifier?: string },
  ): Promise<ChatwootContact> {
    try {
      await this.api.put(`/accounts/${accountId}/contacts/${contactId}`, data);
      logger.info({ contactId, accountId, identifier: data.identifier }, 'Updated Chatwoot contact');
      return {
        id: contactId,
        name: data.name ?? '',
        email: data.email,
        identifier: data.identifier,
      };
    } catch (error) {
      logger.error({ error, contactId, accountId }, 'Failed to update contact');
      throw error;
    }
  }

  async createContact(accountId: number, teamsUserId: string, name: string, email?: string): Promise<ChatwootContact> {
    try {
      const response = await this.api.post(`/accounts/${accountId}/contacts`, {
        identifier: teamsUserId,
        name,
        email: email || undefined,
      });
      logger.info({ contactId: response.data.payload.contact.id, teamsUserId, accountId }, 'Created Chatwoot contact');
      return response.data.payload.contact;
    } catch (error) {
      if (ChatwootClient.getStatus(error) !== 422) {
        logger.error({ error, teamsUserId, accountId }, 'Failed to create contact');
      }
      throw error;
    }
  }

  async findOrCreateContact(accountId: number, teamsUserId: string, name: string, email?: string): Promise<ChatwootContact> {
    const existing = await this.searchContact(accountId, teamsUserId);
    if (existing) {
      logger.debug({ contactId: existing.id, teamsUserId }, 'Found existing contact');
      return existing;
    }

    try {
      return await this.createContact(accountId, teamsUserId, name, email);
    } catch (error) {
      if (ChatwootClient.getStatus(error) !== 422) {
        throw error;
      }

      // 422 = duplicate. The identifier may already exist even though the
      // search above missed it (Chatwoot's search index lags behind writes).
      // Re-check by exact identifier before giving up — never by fuzzy match.
      const byIdentifier = await this.retrySearchContact(accountId, teamsUserId);
      if (byIdentifier) {
        logger.info(
          { contactId: byIdentifier.id, teamsUserId, accountId },
          'Contact create returned 422 — found existing contact by exact identifier',
        );
        return byIdentifier;
      }

      if (!email) {
        logger.error({ error, teamsUserId, accountId }, 'Failed to create contact (422, no email to recover by)');
        throw error;
      }

      const recovered = await this.recoverExistingContactByEmail(accountId, teamsUserId, name, email);
      if (recovered) {
        return recovered;
      }

      logger.error({ error, teamsUserId, accountId, email }, 'Failed to create contact');
      throw error;
    }
  }

  /** searchContact that never throws — used on recovery paths after a 422. */
  private async retrySearchContact(accountId: number, teamsUserId: string): Promise<ChatwootContact | undefined> {
    try {
      return await this.searchContact(accountId, teamsUserId);
    } catch (error) {
      logger.warn({ error, teamsUserId, accountId }, 'Identifier re-check after 422 failed');
      return undefined;
    }
  }

  private async recoverExistingContactByEmail(
    accountId: number,
    teamsUserId: string,
    name: string,
    email: string,
  ): Promise<ChatwootContact | undefined> {
    const contacts = await this.searchContactsByQuery(accountId, email);
    const match = contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase());
    if (!match) {
      logger.warn({ email, accountId, teamsUserId }, 'Contact create returned 422 but no matching contact found by email');
      return undefined;
    }

    logger.info(
      { contactId: match.id, email, teamsUserId, accountId },
      'Recovered existing Chatwoot contact by email, updating identifier',
    );
    return this.updateContact(accountId, match.id, { name, identifier: teamsUserId });
  }

  /**
   * Merge the given custom attributes into the contact's existing ones.
   * Chatwoot's PATCH replaces the whole custom_attributes object, so we
   * read-merge-write to preserve keys set by other systems. Skips the write
   * when nothing would change.
   */
  async updateContactCustomAttributes(
    accountId: number,
    contactId: number,
    attributes: Record<string, unknown>
  ): Promise<void> {
    const contact = await this.getContact(accountId, contactId);
    if (!contact) {
      logger.warn({ contactId, accountId }, 'Contact not found — skipping custom_attributes update');
      return;
    }
    const existing = contact.custom_attributes || {};
    const merged = { ...existing, ...attributes };

    const changed = Object.keys(attributes).some((key) => existing[key] !== attributes[key]);
    if (!changed) {
      logger.debug({ contactId, accountId }, 'Contact custom_attributes already up to date — skipping PATCH');
      return;
    }

    try {
      await this.api.patch(`/accounts/${accountId}/contacts/${contactId}`, {
        custom_attributes: merged,
      });
      logger.info(
        { contactId, accountId, keys: Object.keys(attributes) },
        'Updated Chatwoot contact custom_attributes'
      );
    } catch (error) {
      logger.error({ error, contactId, accountId }, 'Failed to update contact custom_attributes');
      throw error;
    }
  }

  async createConversation(accountId: number, inboxId: number, contactId: number, sourceId?: string): Promise<ChatwootConversation> {
    try {
      const response = await this.api.post(`/accounts/${accountId}/conversations`, {
        contact_id: contactId,
        inbox_id: inboxId,
        source_id: sourceId,
      });
      logger.info({ conversationId: response.data.id, contactId, accountId }, 'Created Chatwoot conversation');
      return response.data;
    } catch (error) {
      logger.error({ error, contactId, accountId }, 'Failed to create conversation');
      throw error;
    }
  }

  async sendMessage(accountId: number, conversationId: number, content: string, messageType: 'incoming' | 'outgoing' = 'incoming'): Promise<ChatwootMessage> {
    try {
      const response = await this.api.post(
        `/accounts/${accountId}/conversations/${conversationId}/messages`,
        {
          content,
          message_type: messageType,
          private: false,
        }
      );
      logger.debug({ conversationId, messageType, accountId }, 'Sent message to Chatwoot');
      return response.data;
    } catch (error) {
      logger.error({ error, conversationId, accountId }, 'Failed to send message to Chatwoot');
      throw error;
    }
  }
}
