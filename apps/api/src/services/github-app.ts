import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';

// ── GitHub App Token Management ──────────────────────────────────

const GITHUB_API = 'https://api.github.com';

/**
 * In-memory cache for installation access tokens.
 * Avoids DB reads/writes on every API call within the 1-hour token lifetime.
 */
const tokenCache = new Map<string, { token: string; expiresAt: Date }>();

/**
 * Generate a short-lived JWT signed with the GitHub App's private key.
 * Used to authenticate as the App itself (not as an installation).
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function generateAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60, // Issued 60 seconds in the past (clock drift tolerance)
      exp: now + 10 * 60, // Expires in 10 minutes (GitHub max)
      iss: appId,
    },
    privateKey,
    { algorithm: 'RS256' },
  );
}

/**
 * Exchange the App JWT for a short-lived installation access token.
 * Installation tokens last 1 hour and can access repos the App is installed on.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
 */
export async function createInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
  baseUrl: string = GITHUB_API,
): Promise<{ token: string; expiresAt: string }> {
  const appJwt = generateAppJWT(appId, privateKey);

  const url = `${baseUrl}/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Origin-AI-Governance/1.0',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create installation token (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * Get a valid installation access token, refreshing if expired or about to expire.
 * Uses in-memory cache first, falls back to DB-stored token, refreshes if needed.
 *
 * @param config - IntegrationConfig record from the database
 * @returns A valid Bearer token string
 */
export async function getValidInstallationToken(config: {
  id: string;
  token: string;
  settings: string;
  baseUrl: string;
}): Promise<string> {
  const SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry

  // 1. Check in-memory cache
  const cached = tokenCache.get(config.id);
  if (cached && cached.expiresAt.getTime() - Date.now() > SAFETY_MARGIN_MS) {
    return cached.token;
  }

  // 2. Parse settings to get App credentials
  let settings: {
    appId?: string;
    installationId?: string;
    privateKey?: string;
    tokenExpiresAt?: string;
  };
  try {
    settings = JSON.parse(config.settings);
  } catch {
    throw new Error('Invalid GitHub App settings in IntegrationConfig');
  }

  const { appId, installationId, privateKey, tokenExpiresAt } = settings;
  if (!appId || !installationId || !privateKey) {
    throw new Error('Missing GitHub App credentials (appId, installationId, or privateKey)');
  }

  // 3. Check if DB-stored token is still valid
  if (tokenExpiresAt && config.token) {
    const expiresAt = new Date(tokenExpiresAt);
    if (expiresAt.getTime() - Date.now() > SAFETY_MARGIN_MS) {
      // DB token is still valid, cache it and return
      tokenCache.set(config.id, { token: config.token, expiresAt });
      return config.token;
    }
  }

  // 4. Token expired or about to expire — refresh
  const decodedKey = privateKey.replace(/\\n/g, '\n');
  const baseUrl = config.baseUrl || GITHUB_API;

  const result = await createInstallationToken(appId, decodedKey, installationId, baseUrl);

  // 5. Update in-memory cache
  const expiresAt = new Date(result.expiresAt);
  tokenCache.set(config.id, { token: result.token, expiresAt });

  // 6. Update DB (async, non-blocking for the current request)
  const updatedSettings = { ...settings, tokenExpiresAt: result.expiresAt };
  prisma.integrationConfig
    .update({
      where: { id: config.id },
      data: {
        token: result.token,
        settings: JSON.stringify(updatedSettings),
      },
    })
    .catch((err) => console.error('[github-app] Failed to persist refreshed token:', err));

  return result.token;
}

/**
 * Test the GitHub App connection by fetching installation details.
 * Unlike PAT which uses GET /user, App uses GET /app/installations/{id}.
 */
export async function testGitHubAppConnection(
  appId: string,
  privateKey: string,
  installationId: string,
  baseUrl: string = GITHUB_API,
): Promise<{
  success: boolean;
  appSlug?: string;
  account?: string;
  permissions?: Record<string, string>;
  error?: string;
}> {
  try {
    const decodedKey = privateKey.replace(/\\n/g, '\n');
    const appJwt = generateAppJWT(appId, decodedKey);

    const url = `${baseUrl}/app/installations/${installationId}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Origin-AI-Governance/1.0',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${err}` };
    }

    const data = (await res.json()) as {
      app_slug: string;
      account: { login: string };
      permissions: Record<string, string>;
    };

    return {
      success: true,
      appSlug: data.app_slug,
      account: data.account?.login,
      permissions: data.permissions,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * List repos accessible by a GitHub App installation token.
 * Uses GET /installation/repositories (different from PAT's GET /user/repos).
 */
export async function listGitHubAppRepos(
  token: string,
  baseUrl: string = GITHUB_API,
): Promise<{
  success: boolean;
  repos?: Array<{
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    url: string;
    defaultBranch: string;
  }>;
  error?: string;
}> {
  const allRepos: Array<{
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    url: string;
    defaultBranch: string;
  }> = [];

  let url: string | null = `${baseUrl}/installation/repositories?per_page=100`;

  try {
    while (url) {
      const currentUrl: string = url;
      const res: globalThis.Response = await fetch(currentUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Origin-AI-Governance/1.0',
        },
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${err}` };
      }

      const data = (await res.json()) as {
        repositories: Array<{
          owner: { login: string };
          name: string;
          full_name: string;
          private: boolean;
          html_url: string;
          default_branch: string;
        }>;
      };

      for (const r of data.repositories) {
        allRepos.push({
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          url: r.html_url,
          defaultBranch: r.default_branch,
        });
      }

      // Parse Link header for pagination
      const linkHeader: string | null = res.headers.get('link');
      url = null;
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          url = nextMatch[1];
        }
      }
    }

    return { success: true, repos: allRepos };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Get the GitHub App slug from environment, or null if not configured.
 */
export function getGitHubAppConfig(): {
  configured: boolean;
  appId?: string;
  appSlug?: string;
  privateKey?: string;
  webhookSecret?: string;
} {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

  if (!appId || !appSlug || !privateKey) {
    return { configured: false };
  }

  return {
    configured: true,
    appId,
    appSlug,
    privateKey: privateKey.replace(/\\n/g, '\n'),
    webhookSecret,
  };
}
