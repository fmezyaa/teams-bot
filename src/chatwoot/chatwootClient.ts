import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { ChatwootContact, ChatwootConversation, ChatwootMessage } from './types';

export class ChatwootClient {
  private api: AxiosInstance;
  private accountId: number;
  private inboxId: number;

  constructor(baseUrl: string, apiToken: string, accountId: number, inboxId: number) {
    this.accountId = accountId;
    this.inboxId = inboxId;
    this.api = axios.create({
      baseURL: `${baseUrl}/api/v1`,
      headers: {
        'api_access_token': apiToken,
        'Content-Type': 'application/json',
      },
    });
  }

  private get basePath(): string {
    return `/accounts/${this.accountId}`;
  }

  async searchContact(teamsUserId: string): Promise<ChatwootContact | undefined> {
    try {
      const response = await this.api.get(`${this.basePath}/contacts/search`, {
        params: { q: teamsUserId, search_type: 'identifier' },
      });
      const contacts = response.data?.payload;
      if (contacts && contacts.length > 0) {
        return contacts[0];
      }
      return undefined;
    } catch (error) {
      logger.error({ error, teamsUserId }, 'Failed to search contact');
      throw error;
    }
  }

  async createContact(teamsUserId: string, name: string, email?: string): Promise<ChatwootContact> {
    try {
      const response = await this.api.post(`${this.basePath}/contacts`, {
        identifier: teamsUserId,
        name,
        email: email || undefined,
      });
      logger.info({ contactId: response.data.payload.contact.id, teamsUserId }, 'Created Chatwoot contact');
      return response.data.payload.contact;
    } catch (error) {
      logger.error({ error, teamsUserId }, 'Failed to create contact');
      throw error;
    }
  }

  async findOrCreateContact(teamsUserId: string, name: string, email?: string): Promise<ChatwootContact> {
    const existing = await this.searchContact(teamsUserId);
    if (existing) {
      logger.debug({ contactId: existing.id, teamsUserId }, 'Found existing contact');
      return existing;
    }
    return this.createContact(teamsUserId, name, email);
  }

  async createConversation(contactId: number, sourceId?: string): Promise<ChatwootConversation> {
    try {
      const response = await this.api.post(`${this.basePath}/conversations`, {
        contact_id: contactId,
        inbox_id: this.inboxId,
        source_id: sourceId,
      });
      logger.info({ conversationId: response.data.id, contactId }, 'Created Chatwoot conversation');
      return response.data;
    } catch (error) {
      logger.error({ error, contactId }, 'Failed to create conversation');
      throw error;
    }
  }

  async sendMessage(conversationId: number, content: string, messageType: 'incoming' | 'outgoing' = 'incoming'): Promise<ChatwootMessage> {
    try {
      const response = await this.api.post(
        `${this.basePath}/conversations/${conversationId}/messages`,
        {
          content,
          message_type: messageType,
          private: false,
        }
      );
      logger.debug({ conversationId, messageType }, 'Sent message to Chatwoot');
      return response.data;
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to send message to Chatwoot');
      throw error;
    }
  }
}
