export interface ChatwootContact {
  id: number;
  name: string;
  email?: string;
  identifier?: string;
}

export interface ChatwootConversation {
  id: number;
  inbox_id: number;
  contact_id: number;
  status: string;
}

export interface ChatwootMessage {
  id: number;
  content: string;
  message_type: number; // 0 = incoming, 1 = outgoing
  conversation_id: number;
  private: boolean;
  sender?: {
    id: number;
    type: string;
  };
}

export interface ChatwootWebhookPayload {
  event: string;
  id?: number;
  content?: string;
  message_type?: number | string;
  private?: boolean;
  content_type?: string;
  conversation?: {
    id: number;
    inbox_id: number;
    contact_id: number;
  };
  sender?: {
    id: number;
    type: string;
  };
  account?: {
    id: number;
  };
}
