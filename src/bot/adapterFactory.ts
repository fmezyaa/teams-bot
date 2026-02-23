import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
} from 'botbuilder';
import { logger } from '../utils/logger';

export function createAdapter(appId: string, appPassword: string): CloudAdapter {
  const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
    MicrosoftAppId: appId,
    MicrosoftAppPassword: appPassword,
    MicrosoftAppType: 'MultiTenant',
  };

  const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(authConfig);
  const adapter = new CloudAdapter(botFrameworkAuth);

  adapter.onTurnError = async (context, error: any) => {
    logger.error({ err: error, message: error?.message, stack: error?.stack, code: error?.code }, 'Bot adapter onTurnError');
    try {
      await context.sendActivity('An error occurred processing your message. Please try again.');
    } catch (sendError) {
      logger.error({ sendError }, 'Failed to send error message to user');
    }
  };

  return adapter;
}
