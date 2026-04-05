import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import DeveloperLayout from './components/DeveloperLayout';
import PublicLayout from './components/PublicLayout';
import { ToastProvider } from './components/Toast';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import RegisterDeveloper from './pages/RegisterDeveloper';
import Pricing from './pages/Pricing';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import SessionDetail from './pages/SessionDetail';
import Repos from './pages/Repos';
import RepoDetail from './pages/RepoDetail';
import Agents from './pages/Agents';
import Policies from './pages/Policies';
import AuditLog from './pages/AuditLog';
import Insights from './pages/Insights';
import Settings from './pages/Settings';
import BudgetPage from './pages/Budget';
import IAM from './pages/IAM';
import Docs from './pages/Docs';
import PolicyDetail from './pages/PolicyDetail';
import AgentDetail from './pages/AgentDetail';
import Notifications from './pages/Notifications';
import Team from './pages/Team';
import UserDetail from './pages/UserDetail';
import Reports from './pages/Reports';
import MachineDetail from './pages/MachineDetail';
import Infrastructure from './pages/Infrastructure';
import AcceptInvite from './pages/AcceptInvite';
import PullRequests from './pages/PullRequests';
import Leaderboard from './pages/Leaderboard';
import Trails from './pages/Trails';
import TrailDetail from './pages/TrailDetail';
import Prompts from './pages/Prompts';
import ComplianceDashboard from './pages/Compliance';
import PublicPolicies from './pages/PublicPolicies';
import SharedSession from './pages/SharedSession';
import Admin from './pages/Admin';
import Blog from './pages/Blog';
import BlogPost from './pages/BlogPost';
import Demo from './pages/Demo';
import DemoPlatform from './pages/DemoPlatform';
import DemoCLI from './pages/DemoCLI';
import MyDashboard from './pages/MyDashboard';
import SessionCompare from './pages/SessionCompare';
import OAuthCallback from './pages/OAuthCallback';

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

export default function App() {
  return (
    <ToastProvider>
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
        element={<Navigate to="/iam" replace />}
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
        element={<Navigate to="/settings?tab=models" replace />}
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
    </ToastProvider>
  );
}
