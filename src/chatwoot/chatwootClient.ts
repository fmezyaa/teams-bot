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

  async searchContact(accountId: number, teamsUserId: string): Promise<ChatwootContact | undefined> {
    const contacts = await this.searchContactsByQuery(accountId, teamsUserId);
    return contacts.find((c) => c.identifier === teamsUserId) ?? contacts[0];
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
      if (ChatwootClient.getStatus(error) !== 422 || !email) {
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
