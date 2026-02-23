import { ConversationReference } from 'botbuilder';

export interface ContactMapping {
  teamsUserId: string;
  chatwootContactId: number;
  displayName: string;
  email?: string;
  createdAt: string;
}

export interface ConversationMapping {
  teamsConversationId: string;
  teamsUserId: string;
  chatwootConversationId: number;
  conversationReference: ConversationReference;
  createdAt: string;
  updatedAt: string;
}
