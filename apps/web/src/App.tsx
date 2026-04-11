import React, { useEffect, Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import DeveloperLayout from './components/DeveloperLayout';
import PublicLayout from './components/PublicLayout';
import { ToastProvider } from './components/Toast';
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
import PublicPolicies from './pages/PublicPolicies';
import SharedSession from './pages/SharedSession';

// ── Lazy-loaded: content-heavy or rarely-visited routes. Each becomes its
//    own chunk, which keeps the main bundle small and speeds up first paint
//    for signed-out and first-visit users. ─────────────────────────────────
const Docs = lazy(() => import('./pages/Docs'));
const Blog = lazy(() => import('./pages/Blog'));
const BlogPost = lazy(() => import('./pages/BlogPost'));
const Demo = lazy(() => import('./pages/Demo'));
const DemoPlatform = lazy(() => import('./pages/DemoPlatform'));
const DemoCLI = lazy(() => import('./pages/DemoCLI'));
const Sessions = lazy(() => import('./pages/Sessions'));
const SessionDetail = lazy(() => import('./pages/SessionDetail'));
const SessionCompare = lazy(() => import('./pages/SessionCompare'));
const Repos = lazy(() => import('./pages/Repos'));
const RepoDetail = lazy(() => import('./pages/RepoDetail'));
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
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const TrailDetail = lazy(() => import('./pages/TrailDetail'));
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

/** Picks Layout or DeveloperLayout based on accountType */
function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.accountType === 'developer') {
    return <DeveloperLayout>{children}</DeveloperLayout>;
  }
  return <Layout>{children}</Layout>;
}

/** Redirects developer accounts to /me, shows org Dashboard for org accounts */
function DashboardRedirect() {
  const { user } = useAuth();
  if (user?.accountType === 'developer') {
    return <Navigate to="/me" replace />;
  }
  return <Layout><Dashboard /></Layout>;
}

// Scrolls the window to the top whenever the route path changes — avoids the
// jarring "stuck scroll position" when navigating between pages.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ToastProvider>
    <ScrollToTop />
    <ErrorBoundary label="Origin">
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" /></div>}>
    <Routes>
      {/* Public routes — wrapped in PublicLayout */}
      <Route path="/" element={<PublicLayout><Landing /></PublicLayout>} />
      <Route path="/docs" element={<PublicLayout><Docs /></PublicLayout>} />
      <Route path="/docs/:section" element={<PublicLayout><Docs /></PublicLayout>} />
      <Route path="/pricing" element={<PublicLayout><Pricing /></PublicLayout>} />
      <Route path="/cli" element={<Navigate to="/docs#cli" replace />} />
      <Route path="/blog" element={<PublicLayout><Blog /></PublicLayout>} />
      <Route path="/blog/:slug" element={<PublicLayout><BlogPost /></PublicLayout>} />
      <Route path="/demo" element={<PublicLayout><Demo /></PublicLayout>} />
      <Route path="/demo/platform" element={<PublicLayout><DemoPlatform /></PublicLayout>} />
      <Route path="/demo/cli" element={<PublicLayout><DemoCLI /></PublicLayout>} />
      <Route path="/org/:orgSlug/policies" element={<PublicLayout><PublicPolicies /></PublicLayout>} />
      <Route path="/s/:slug" element={<SharedSession />} />
      <Route path="/auth/:provider/callback" element={<OAuthCallback />} />
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/register" element={<Register />} />
      <Route path="/register/developer" element={<RegisterDeveloper />} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/accept-invite/:token" element={<AcceptInvite />} />

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
            <AppLayout>
              <Agents />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/policies"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Policies />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/policies/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <PolicyDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <AgentDetail />
            </AppLayout>
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
            <AppLayout>
              <PullRequests />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route path="/team" element={<Navigate to="/iam" replace />} />
      <Route
        path="/team/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <UserDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route path="/audit" element={<Navigate to="/settings?tab=audit" replace />} />
      <Route path="/insights" element={<ProtectedRoute><AppLayout><Insights /></AppLayout></ProtectedRoute>} />
      <Route path="/reports" element={<Navigate to="/settings?tab=reports" replace />} />
      <Route
        path="/infrastructure"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Infrastructure />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/machines/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <MachineDetail />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/budget"
        element={
          <ProtectedRoute>
            <AppLayout>
              <BudgetPage />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/iam"
        element={
          <ProtectedRoute>
            <AppLayout>
              <IAM />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/integrations"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Integrations />
            </AppLayout>
          </ProtectedRoute>
        }
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
      <Route
        path="/leaderboard"
        element={<ProtectedRoute><AppLayout><Leaderboard /></AppLayout></ProtectedRoute>}
      />
      <Route
        path="/api-keys"
        element={<ProtectedRoute><AppLayout><ApiKeys /></AppLayout></ProtectedRoute>}
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
