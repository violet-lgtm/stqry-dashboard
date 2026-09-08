import 'dotenv/config';

/**
 * Credentials can arrive three ways, in this order of precedence:
 *   1. GA_CREDENTIALS_JSON  — the whole service-account key as inline JSON
 *      (the practical option on Heroku/Fly/Cloud Run, where there is no disk
 *      to drop a key file on).
 *   2. GA_CLIENT_EMAIL + GA_PRIVATE_KEY — the two fields that actually matter,
 *      as separate vars.
 *   3. GOOGLE_APPLICATION_CREDENTIALS or ambient ADC — handled by the Google
 *      client library itself; we pass no explicit credentials.
 */
function readCredentials() {
  const { GA_CREDENTIALS_JSON, GA_CLIENT_EMAIL, GA_PRIVATE_KEY } = process.env;

  if (GA_CREDENTIALS_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(GA_CREDENTIALS_JSON);
    } catch {
      throw new Error('GA_CREDENTIALS_JSON is set but is not valid JSON.');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GA_CREDENTIALS_JSON is missing client_email or private_key.');
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  }

  if (GA_CLIENT_EMAIL && GA_PRIVATE_KEY) {
    // Dotenv and most dashboards keep the key on one line with literal "\n".
    return { client_email: GA_CLIENT_EMAIL, private_key: GA_PRIVATE_KEY.replace(/\\n/g, '\n') };
  }

  return null;
}

const propertyId = (process.env.GA_PROPERTY_ID || '').replace(/^properties\//, '').trim();
const credentials = readCredentials();
const hasAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

/**
 * `useMockData` is what the rest of the app branches on. Forcing it with
 * GA_USE_MOCK=true is useful for local UI work; otherwise we fall back to mock
 * data only when there is genuinely nothing to authenticate with, and the API
 * response says so explicitly so the UI can show a banner rather than passing
 * invented numbers off as real ones.
 */
const forceMock = /^(1|true|yes)$/i.test(process.env.GA_USE_MOCK || '');
const canQueryGa = Boolean(propertyId) && (Boolean(credentials) || hasAdc);

export const config = {
  port: Number(process.env.PORT) || 3000,
  propertyId,
  credentials,
  timeZone: process.env.GA_TIMEZONE || 'UTC',
  topPagesLimit: Number(process.env.GA_TOP_PAGES_LIMIT) || 10,
  useMockData: forceMock || !canQueryGa,
  mockReason: forceMock
    ? 'GA_USE_MOCK is set, so the dashboard is showing generated sample data.'
    : !propertyId
      ? 'GA_PROPERTY_ID is not set, so the dashboard is showing generated sample data.'
      : 'No Google service-account credentials were found, so the dashboard is showing generated sample data.',
};
