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

  async searchContact(accountId: number, teamsUserId: string): Promise<ChatwootContact | undefined> {
    try {
      const response = await this.api.get(`/accounts/${accountId}/contacts/search`, {
        params: { q: teamsUserId, search_type: 'identifier' },
      });
      const contacts = response.data?.payload;
      if (contacts && contacts.length > 0) {
        return contacts[0];
      }
      return undefined;
    } catch (error) {
      logger.error({ error, teamsUserId, accountId }, 'Failed to search contact');
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
      logger.error({ error, teamsUserId, accountId }, 'Failed to create contact');
      throw error;
    }
  }

  async findOrCreateContact(accountId: number, teamsUserId: string, name: string, email?: string): Promise<ChatwootContact> {
    const existing = await this.searchContact(accountId, teamsUserId);
    if (existing) {
      logger.debug({ contactId: existing.id, teamsUserId }, 'Found existing contact');
      return existing;
    }
    return this.createContact(accountId, teamsUserId, name, email);
  }

  async getContact(accountId: number, contactId: number): Promise<ChatwootContact> {
    try {
      const response = await this.api.get(`/accounts/${accountId}/contacts/${contactId}`);
      return response.data.payload;
    } catch (error) {
      logger.error({ error, contactId, accountId }, 'Failed to get contact');
      throw error;
    }
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
