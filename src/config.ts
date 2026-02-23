import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  microsoftAppId: required('MICROSOFT_APP_ID'),
  microsoftAppPassword: required('MICROSOFT_APP_PASSWORD'),
  microsoftAppTenantId: required('MICROSOFT_APP_TENANT_ID'),

  chatwootBaseUrl: required('CHATWOOT_BASE_URL').replace(/\/+$/, ''),
  chatwootApiAccessToken: required('CHATWOOT_API_ACCESS_TOKEN'),

  adminApiToken: required('ADMIN_API_TOKEN'),

  bridgeBaseUrl: required('BRIDGE_BASE_URL').replace(/\/+$/, ''),
  port: parseInt(optional('PORT', '3978'), 10),
  dbPath: optional('DB_PATH', '/data/bridge.db'),
} as const;
