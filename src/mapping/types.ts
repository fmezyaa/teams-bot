import { ConversationReference } from 'botbuilder';

export interface ContactMapping {
  tenantId: string;
  teamsUserId: string;
  chatwootContactId: number;
  displayName: string;
  email?: string;
  createdAt: string;
}

export interface ConversationMapping {
  tenantId: string;
  teamsConversationId: string;
  teamsUserId: string;
  chatwootConversationId: number;
  conversationReference: ConversationReference;
  createdAt: string;
  updatedAt: string;
}
