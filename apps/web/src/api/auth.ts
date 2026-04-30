// ── Auth API ────────────────────────────────────────────────────────────
import { request } from './_client.js';

// Server returns the user, full membership list, and the chosen active org
// for this request. Frontend uses `memberships` to render the org switcher
// and `activeOrgId` to know which org's data the response is for.
export interface AuthResponse {
  token?: string;          // Optional — cookie auth alone is enough
  user: User;
  memberships: Membership[];
  activeOrgId: string | null;
  activeRole: string | null;
  apiKey?: string;         // Auto-generated for solo developer accounts
  isNewAccount?: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  accountType: 'org' | 'developer';
  avatarUrl: string | null;
  emailVerified?: boolean;
  provider?: string | null;
}

export interface Membership {
  orgId: string;
  name: string;
  slug: string;
  type: 'team' | 'personal';
  role: string;
  joinedAt?: string;
}

export function updateProfile(data: { name?: string; email?: string; avatarUrl?: string }) {
  return request<AuthResponse>('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function changePassword(currentPassword: string, newPassword: string) {
  return request<{ success: boolean }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function login(email: string, password: string) {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(
  email: string,
  password: string,
  name: string,
  orgName: string,
  orgSlug: string,
) {
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, orgName, orgSlug }),
  });
}

export function registerDeveloper(email: string, password: string, name: string) {
  return request<AuthResponse>('/api/auth/register/developer', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
}

export function forgotPassword(email: string) {
  return request<{ message: string }>('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token: string, password: string) {
  return request<{ message: string }>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

export function verifyResetToken(token: string) {
  return request<{ valid: boolean; type: string | null }>(`/api/auth/verify-token/${token}`);
}

export function sendVerificationEmail() {
  return request<{ message: string }>('/api/auth/send-verification', { method: 'POST' });
}

export function verifyEmail(token: string) {
  return request<{ message: string }>('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function getOAuthUrl(provider: 'github' | 'gitlab' | 'google') {
  return request<{ url: string }>(`/api/auth/oauth/${provider}`);
}

export function oauthCallback(provider: string, code: string, state: string, accountType?: string) {
  return request<AuthResponse>(`/api/auth/oauth/${provider}/callback`, {
    method: 'POST',
    body: JSON.stringify({ code, state, accountType }),
  });
}

export function getMe() {
  return request<AuthResponse>('/api/auth/me');
}

// ── Multi-org self endpoints ────────────────────────────────────────────

export function listMemberships() {
  return request<Membership[]>('/api/me/memberships');
}

export function setActiveOrg(orgId: string) {
  return request<{ activeOrgId: string }>('/api/me/active-org', {
    method: 'POST',
    body: JSON.stringify({ orgId }),
  });
}

export function createOrg(name: string, slug?: string) {
  return request<{ orgId: string; name: string; slug: string; type: string; role: string }>('/api/orgs', {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  });
}

export function leaveOrg(orgId: string) {
  return request<{ success: boolean }>(`/api/orgs/${orgId}/leave`, {
    method: 'POST',
  });
}
