import {
  TeamsActivityHandler,
  TurnContext,
  TeamsInfo,
  Activity,
} from 'botbuilder';
import { logger } from '../utils/logger';
import { toTeamsMarkdown } from '../utils/teamsText';
import { BridgeService } from '../services/bridgeService';

export class TeamsBot extends TeamsActivityHandler {
  private bridgeService: BridgeService;

  constructor(bridgeService: BridgeService) {
    super();
    this.bridgeService = bridgeService;

    this.onMessage(async (context: TurnContext, next) => {
      try {
        await this.handleIncomingMessage(context);
      } catch (error: any) {
        logger.error({ error }, 'Error handling Teams message');
        if (error?.message?.startsWith('No tenant configured')) {
          await context.sendActivity(
            'This organization is not configured for support. Please contact your administrator.',
          );
        } else {
          await context.sendActivity('Sorry, something went wrong processing your message.');
        }
      }
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded || [];
      const teamsTenantId =
        context.activity.channelData?.tenant?.id || context.activity.conversation.tenantId;

      let greeting: { enabled: boolean; text: string } | null = null;
      if (teamsTenantId) {
        try {
          greeting = await this.bridgeService.getGreetingForTenant(teamsTenantId);
        } catch (error) {
          logger.warn({ error, teamsTenantId }, 'Could not load tenant greeting settings');
        }
      }

      // Default: no greeting — silent app installs for campaigns must not spam users.
      if (greeting?.enabled && greeting.text) {
        for (const member of membersAdded) {
          if (member.id !== context.activity.recipient.id) {
            await context.sendActivity(toTeamsMarkdown(greeting.text));
          }
        }
      }
      await next();
    });
  }

  private async handleIncomingMessage(context: TurnContext): Promise<void> {
    const activity = context.activity;
    let text = activity.text || '';

    if (
      activity.conversation.conversationType === 'channel' ||
      activity.conversation.conversationType === 'groupChat'
    ) {
      TurnContext.removeMentionText(activity, activity.recipient.id);
      text = activity.text?.trim() || '';
    } else {
      text = text.trim();
    }

    if (!text) {
      await context.sendActivity('Please send a text message.');
      return;
    }

    const teamsTenantId = activity.channelData?.tenant?.id || activity.conversation.tenantId;
    if (!teamsTenantId) {
      logger.warn(
        { conversationId: activity.conversation.id, channelData: activity.channelData },
        'No tenant ID found in Teams activity',
      );
      await context.sendActivity('Could not determine your organization. Please try again.');
      return;
    }

    await context.sendActivities([{ type: 'typing' } as Partial<Activity>]);

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

    const conversationReference = TurnContext.getConversationReference(activity);

    await this.bridgeService.handleTeamsMessage({
      teamsTenantId,
      teamsUserId,
      teamsConversationId: activity.conversation.id,
      userName,
      userEmail,
      text,
      conversationReference,
    });

    logger.info(
      {
        teamsTenantId,
        teamsUserId,
        conversationType: activity.conversation.conversationType,
        textLength: text.length,
      },
      'Forwarded Teams message to Chatwoot',
    );
  }
}
