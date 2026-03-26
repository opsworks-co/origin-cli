import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import PublicLayout from './components/PublicLayout';
import { ToastProvider } from './components/Toast';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
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
import CLI from './pages/CLI';
import SharedSession from './pages/SharedSession';
import Admin from './pages/Admin';
import Blog from './pages/Blog';
import BlogPost from './pages/BlogPost';

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

export default function App() {
  return (
    <ToastProvider>
    <Routes>
      {/* Public routes — wrapped in PublicLayout */}
      <Route path="/" element={<PublicLayout><Landing /></PublicLayout>} />
      <Route path="/docs" element={<PublicLayout><Docs /></PublicLayout>} />
      <Route path="/pricing" element={<PublicLayout><Pricing /></PublicLayout>} />
      <Route path="/cli" element={<PublicLayout><CLI /></PublicLayout>} />
      <Route path="/blog" element={<PublicLayout><Blog /></PublicLayout>} />
      <Route path="/blog/:slug" element={<PublicLayout><BlogPost /></PublicLayout>} />
      <Route path="/org/:orgSlug/policies" element={<PublicLayout><PublicPolicies /></PublicLayout>} />
      <Route path="/s/:slug" element={<SharedSession />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/invite/:token" element={<AcceptInvite />} />
      <Route path="/accept-invite/:token" element={<AcceptInvite />} />

      {/* Protected routes — wrapped in Layout */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Layout>
              <Dashboard />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos"
        element={
          <ProtectedRoute>
            <Layout>
              <Repos />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/repos/:id"
        element={
          <ProtectedRoute>
            <Layout>
              <RepoDetail />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sessions"
        element={
          <ProtectedRoute>
            <Layout>
              <Sessions />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/sessions/:id"
        element={
          <ProtectedRoute>
            <Layout>
              <SessionDetail />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents"
        element={
          <ProtectedRoute>
            <Layout>
              <Agents />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/policies"
        element={
          <ProtectedRoute>
            <Layout>
              <Policies />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/policies/:id"
        element={
          <ProtectedRoute>
            <Layout>
              <PolicyDetail />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents/:id"
        element={
          <ProtectedRoute>
            <Layout>
              <AgentDetail />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/notifications"
        element={
          <ProtectedRoute>
            <Layout>
              <Notifications />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/pull-requests"
        element={
          <ProtectedRoute>
            <Layout>
              <PullRequests />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route path="/team" element={<Navigate to="/iam" replace />} />
      <Route
        path="/team/:id"
        element={
          <ProtectedRoute>
            <Layout>
              <UserDetail />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route path="/audit" element={<Navigate to="/settings?tab=audit" replace />} />
      <Route path="/insights" element={<ProtectedRoute><Layout><Insights /></Layout></ProtectedRoute>} />
      <Route path="/reports" element={<Navigate to="/settings?tab=reports" replace />} />
      <Route
        path="/infrastructure"
        element={
          <ProtectedRoute>
            <Layout>
              <Infrastructure />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/machines/:id"
        element={
          <ProtectedRoute>
            <Layout>
              <MachineDetail />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/budget"
        element={
          <ProtectedRoute>
            <Layout>
              <BudgetPage />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/iam"
        element={
          <ProtectedRoute>
            <Layout>
              <IAM />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Layout>
              <Settings />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/leaderboard"
        element={<ProtectedRoute><Layout><Leaderboard /></Layout></ProtectedRoute>}
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
            <Layout>
              <TrailDetail />
            </Layout>
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
            <Layout>
              <Admin />
            </Layout>
          </ProtectedRoute>
        }
      />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ToastProvider>
  );
}
