import {
  TeamsActivityHandler,
  TurnContext,
  TeamsInfo,
  ChannelInfo,
  MessageFactory,
  Activity,
} from 'botbuilder';
import { logger } from '../utils/logger';
import { BridgeService } from '../services/bridgeService';

export class TeamsBot extends TeamsActivityHandler {
  private bridgeService: BridgeService;

  constructor(bridgeService: BridgeService) {
    super();
    this.bridgeService = bridgeService;

    this.onMessage(async (context: TurnContext, next) => {
      try {
        await this.handleIncomingMessage(context);
      } catch (error) {
        logger.error({ error }, 'Error handling Teams message');
        await context.sendActivity('Sorry, something went wrong processing your message.');
      }
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded || [];
      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            'Hello! I\'m the support assistant. Send me a message and I\'ll connect you with our team.'
          );
        }
      }
      await next();
    });
  }

  private async handleIncomingMessage(context: TurnContext): Promise<void> {
    const activity = context.activity;
    let text = activity.text || '';

    // Strip @mention in channel messages
    if (activity.conversation.conversationType === 'channel' || activity.conversation.conversationType === 'groupChat') {
      const mentions = TurnContext.removeMentionText(activity, activity.recipient.id);
      text = activity.text?.trim() || '';
    } else {
      text = text.trim();
    }

    if (!text) {
      await context.sendActivity('Please send a text message.');
      return;
    }

    // Send typing indicator
    await context.sendActivities([{ type: 'typing' } as Partial<Activity>]);

    // Get user info from Teams
    let userName = activity.from.name || 'Teams User';
    let userEmail: string | undefined;
    const teamsUserId = activity.from.aadObjectId || activity.from.id;

    try {
      const member = await TeamsInfo.getMember(context, activity.from.id);
      userName = member.name || userName;
      userEmail = member.email;
    } catch (error) {
      logger.warn({ error, userId: activity.from.id }, 'Could not fetch Teams member info');
    }

    // Build conversation reference for proactive messaging
    const conversationReference = TurnContext.getConversationReference(activity);

    await this.bridgeService.handleTeamsMessage({
      teamsUserId,
      teamsConversationId: activity.conversation.id,
      userName,
      userEmail,
      text,
      conversationReference,
    });

    logger.info({
      teamsUserId,
      conversationType: activity.conversation.conversationType,
      textLength: text.length,
    }, 'Forwarded Teams message to Chatwoot');
  }
}
