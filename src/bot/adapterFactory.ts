import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
} from 'botbuilder';
import { logger } from '../utils/logger';

export function createAdapter(appId: string, appPassword: string, tenantId: string): CloudAdapter {
  const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
    MicrosoftAppId: appId,
    MicrosoftAppPassword: appPassword,
    MicrosoftAppTenantId: tenantId,
    MicrosoftAppType: 'SingleTenant',
  };

  const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(authConfig);
  const adapter = new CloudAdapter(botFrameworkAuth);

  adapter.onTurnError = async (context, error) => {
    logger.error({ error }, 'Bot adapter onTurnError');
    try {
      await context.sendActivity('An error occurred processing your message. Please try again.');
    } catch (sendError) {
      logger.error({ sendError }, 'Failed to send error message to user');
    }
  };

  return adapter;
}
