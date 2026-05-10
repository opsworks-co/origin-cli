import React, { useEffect, Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import DeveloperLayout from './components/DeveloperLayout';
import PublicLayout from './components/PublicLayout';
import { ToastProvider } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
// ── Eagerly loaded: first-paint critical, tiny, or always-visible pages ──
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import RegisterDeveloper from './pages/RegisterDeveloper';
import Pricing from './pages/Pricing';
import Dashboard from './pages/Dashboard';
import MyDashboard from './pages/MyDashboard';
import AcceptInvite from './pages/AcceptInvite';
import OAuthCallback from './pages/OAuthCallback';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import CliLink from './pages/CliLink';
import PublicPolicies from './pages/PublicPolicies';
import SharedSession from './pages/SharedSession';

// ── Lazy-loaded: content-heavy or rarely-visited routes. Each becomes its
//    own chunk, which keeps the main bundle small and speeds up first paint
//    for signed-out and first-visit users. ─────────────────────────────────
const Docs = lazy(() => import('./pages/Docs'));
const Scan = lazy(() => import('./pages/Scan'));
const CLICommands = lazy(() => import('./pages/CLICommands'));
const Blog = lazy(() => import('./pages/Blog'));
const BlogPost = lazy(() => import('./pages/BlogPost'));
const Demo = lazy(() => import('./pages/Demo'));
const DemoPlatform = lazy(() => import('./pages/DemoPlatform'));
const DemoCLI = lazy(() => import('./pages/DemoCLI'));
const UseCases = lazy(() => import('./pages/UseCases'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Sessions = lazy(() => import('./pages/Sessions'));
const LiveFeed = lazy(() => import('./pages/LiveFeed'));
const SessionDetail = lazy(() => import('./pages/SessionDetail'));
const SessionCompare = lazy(() => import('./pages/SessionCompare'));
const Repos = lazy(() => import('./pages/Repos'));
const RepoDetail = lazy(() => import('./pages/RepoDetail'));
const RepoIssues = lazy(() => import('./pages/RepoIssues'));
const RepoAccess = lazy(() => import('./pages/RepoAccess'));
const AgentAccess = lazy(() => import('./pages/AgentAccess'));
const UserAccess = lazy(() => import('./pages/UserAccess'));
const CommitDetail = lazy(() => import('./pages/CommitDetail'));
const Agents = lazy(() => import('./pages/Agents'));
const AgentDetail = lazy(() => import('./pages/AgentDetail'));
const Policies = lazy(() => import('./pages/Policies'));
const PolicyDetail = lazy(() => import('./pages/PolicyDetail'));
const Insights = lazy(() => import('./pages/Insights'));
const Settings = lazy(() => import('./pages/Settings'));
const Integrations = lazy(() => import('./pages/Integrations'));
const ApiKeys = lazy(() => import('./pages/ApiKeys'));
const BudgetPage = lazy(() => import('./pages/Budget'));
const IAM = lazy(() => import('./pages/IAM'));
const Notifications = lazy(() => import('./pages/Notifications'));
const UserDetail = lazy(() => import('./pages/UserDetail'));
const MachineDetail = lazy(() => import('./pages/MachineDetail'));
const Infrastructure = lazy(() => import('./pages/Infrastructure'));
const PullRequests = lazy(() => import('./pages/PullRequests'));
const SpendQuality = lazy(() => import('./pages/SpendQuality'));
const TrailDetail = lazy(() => import('./pages/TrailDetail'));
const Snapshots = lazy(() => import('./pages/Snapshots'));
const Admin = lazy(() => import('./pages/Admin'));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

/**
 * Roles that get the slim DeveloperLayout (self-only view: Dashboard,
 * Sessions, Repos, Insights, Settings — no Governance/IAM/Budget). Admin
 * and Owner keep the full Layout with the management surfaces. The backend
 * already scopes most "team" data (sessions, stats) to `userId = me` for
 * non-admins, so this layout swap is the missing piece on the UI side.
 */
function isAdminRole(role: string | undefined | null): boolean {
  const r = (role || '').toUpperCase();
  return r === 'OWNER' || r === 'ADMIN';
}

function shouldUseDeveloperLayout(activeOrg: { type?: string; role?: string } | null | undefined, user: { accountType?: string } | null | undefined): boolean {
  if (activeOrg) {
    return activeOrg.type === 'personal' || !isAdminRole(activeOrg.role);
  }
  // Pre-membership-fetch fall-back: trust user.accountType.
  return user?.accountType === 'developer';
}

/** Picks Layout or DeveloperLayout based on the active org's type *and* the
 *  user's role within it — non-admin members of team orgs get the slim view. */
function AppLayout({ children }: { children: React.ReactNode }) {
  const { activeOrg, user } = useAuth();
  if (shouldUseDeveloperLayout(activeOrg, user)) {
    return <DeveloperLayout>{children}</DeveloperLayout>;
  }
  return <Layout>{children}</Layout>;
}

/** Redirects to /me when the active org is a personal workspace or the
 *  user is a non-admin member (their dashboard is /me, not the team one). */
function DashboardRedirect() {
  const { activeOrg, user } = useAuth();
  if (shouldUseDeveloperLayout(activeOrg, user)) {
    return <Navigate to="/me" replace />;
  }
  return <Layout><Dashboard /></Layout>;
}

/** Route guard: bounce non-admin members away from admin-only surfaces.
 *  Used for /budget, /policies, /infrastructure, /iam, /agents, /pull-requests,
 *  /admin — pages that exist only to manage the org. They're already hidden
 *  from the member's nav (DeveloperLayout doesn't link them), but a member
 *  who types the URL or clicks a stale link should land back on their
 *  dashboard rather than seeing a 403 wall or a forbidden-feeling page. */
function AdminOnlyRoute({ children }: { children: React.ReactNode }) {
  const { activeOrg, user, loading } = useAuth();
  // While memberships load, render nothing rather than flashing the
  // page — once activeOrg arrives we'll redirect or render.
  if (loading) return null;
  // Solo personal workspaces are always "admin" of themselves.
  if (activeOrg?.type === 'personal') return <>{children}</>;
  if (activeOrg && isAdminRole(activeOrg.role)) return <>{children}</>;
  // Pre-membership-fetch fall-back for accountType=org users — let it
  // through; resolveOrgContext on the server still gates writes.
  if (!activeOrg && user?.accountType === 'org') return <>{children}</>;
  return <Navigate to="/me" replace />;
}

// Scrolls the window to the top whenever the route path changes — avoids the
// jarring "stuck scroll position" when navigating between pages.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    // Clear the chunk-reload guard so future deploys can auto-reload again
    sessionStorage.removeItem('chunk_reload');
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ToastProvider>
    <ScrollToTop />
    <UpdateBanner />
    <ErrorBoundary label="Origin">
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" /></div>}>
    <Routes>
      {/* Public routes — wrapped in PublicLayout */}
      <Route path="/" element={<PublicLayout><Landing /></PublicLayout>} />
      <Route path="/docs" element={<PublicLayout><Docs /></PublicLayout>} />
      <Route path="/docs/:section" element={<PublicLayout><Docs /></PublicLayout>} />
      <Route path="/docs/cli/commands" element={<PublicLayout><CLICommands /></PublicLayout>} />
      <Route path="/pricing" element={<PublicLayout><Pricing /></PublicLayout>} />
      <Route path="/cli" element={<Navigate to="/docs#cli" replace />} />
      <Route path="/cli/commands" element={<Navigate to="/docs/cli/commands" replace />} />
      <Route path="/blog" element={<PublicLayout><Blog /></PublicLayout>} />
      <Route path="/blog/:slug" element={<PublicLayout><BlogPost /></PublicLayout>} />
      <Route path="/use-cases" element={<PublicLayout><UseCases /></PublicLayout>} />
      <Route path="/demo" element={<PublicLayout><Demo /></PublicLayout>} />
      <Route path="/demo/platform" element={<PublicLayout><DemoPlatform /></PublicLayout>} />
      <Route path="/demo/cli" element={<PublicLayout><DemoCLI /></PublicLayout>} />
      <Route path="/org/:orgSlug/policies" element={<PublicLayout><PublicPolicies /></PublicLayout>} />
      <Route path="/scan" element={<PublicLayout><Scan /></PublicLayout>} />
      <Route path="/scan/:token" element={<PublicLayout><Scan /></PublicLayout>} />
      <Route path="/s/:slug" element={<SharedSession />} />
      <Route path="/auth/:provider/callback" element={<OAuthCallback />} />
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/cli-link" element={<CliLink />} />
      <Route path="/register" element={<Register />} />
      <Route path="/register/developer" element={<RegisterDeveloper />} />
      <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/invite" element={<AcceptInvite />} />
      <Route path="/accept-invite/:token" element={<AcceptInvite />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />

      {/* Protected routes — wrapped in AppLayout (auto-picks org vs developer layout) */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardRedirect />
          </ProtectedRoute>
        }
      />
      <Route
        path="/me"
        element={
          <ProtectedRoute>
            <AppLayout>
              <MyDashboard />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Repos />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <RepoDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos/:id/issues"
        element={
          <ProtectedRoute>
            <AppLayout>
              <RepoIssues />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos/:id/access"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <RepoAccess />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents/:id/access"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <AgentAccess />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/iam/users/:id/access"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <UserAccess />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos/:id/commits/:sha"
        element={
          <ProtectedRoute>
            <AppLayout>
              <CommitDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sessions"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Sessions />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/live"
        element={
          <ProtectedRoute>
            <AppLayout>
              <LiveFeed />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sessions/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <SessionDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/compare/:id1/:id2"
        element={
          <ProtectedRoute>
            <AppLayout>
              <SessionCompare />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <Agents />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/policies"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <Policies />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/policies/:id"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <PolicyDetail />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents/:id"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <AgentDetail />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/notifications"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Notifications />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/pull-requests"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <PullRequests />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route path="/team" element={<Navigate to="/iam" replace />} />
      <Route
        path="/team/:id"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <UserDetail />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route path="/audit" element={<Navigate to="/settings?tab=audit" replace />} />
      <Route path="/insights" element={<ProtectedRoute><AppLayout><Insights /></AppLayout></ProtectedRoute>} />
      <Route path="/insights/spend-quality" element={<ProtectedRoute><AppLayout><SpendQuality /></AppLayout></ProtectedRoute>} />
      {/* Leaderboard folded into Spend Quality — same per-dev rollups + four
          new columns. Existing /leaderboard URLs continue to work via
          redirect so nobody's bookmark dies. */}
      <Route path="/leaderboard" element={<Navigate to="/insights/spend-quality" replace />} />
      <Route path="/reports" element={<Navigate to="/settings?tab=reports" replace />} />
      <Route
        path="/infrastructure"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <Infrastructure />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/machines/:id"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <MachineDetail />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/budget"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <BudgetPage />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/iam"
        element={
          <ProtectedRoute>
            <AdminOnlyRoute>
              <AppLayout>
                <IAM />
              </AppLayout>
            </AdminOnlyRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/integrations"
        element={<Navigate to="/settings?tab=integrations" replace />}
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Settings />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      {/* Old /leaderboard route removed — folded into /insights/spend-quality
          via the redirect declared earlier in this file. */}
      <Route
        path="/api-keys"
        element={<Navigate to="/settings?tab=keys" replace />}
      />
      <Route
        path="/snapshots"
        element={<ProtectedRoute><AppLayout><Snapshots /></AppLayout></ProtectedRoute>}
      />
      <Route
        path="/trails"
        element={<Navigate to="/settings?tab=trails" replace />}
      />
      <Route
        path="/trails/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <TrailDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/prompts"
        element={<Navigate to="/sessions" replace />}
      />
      <Route
        path="/compliance"
        element={<Navigate to="/settings?tab=compliance" replace />}
      />
      <Route
        path="/models"
        element={<Navigate to="/insights" replace />}
      />

      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Admin />
            </AppLayout>
          </ProtectedRoute>
        }
      />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </ErrorBoundary>
    </ToastProvider>
  );
}
