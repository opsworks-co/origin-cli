import { H2, P } from '../shared/Markdown';

export default function RbacSection() {
  return (
    <>
          <div>
            <h1 id="rbac" className="text-2xl font-bold mb-2">Team & Roles</h1>
            <P>
              Origin uses Role-Based Access Control (RBAC) to manage permissions. Each user has one role
              within their organization.
            </P>

            <H2 id="roles">Roles</H2>
            <div className="space-y-4 mt-4 mb-6">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-purple text-xs">OWNER</span>
                  <span className="text-gray-200 font-semibold">Organization Owner</span>
                </div>
                <P>Full access to everything. Can manage billing, delete the org, and manage all settings. One per org.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-red text-xs">ADMIN</span>
                  <span className="text-gray-200 font-semibold">Administrator</span>
                </div>
                <P>Can manage integrations, create/delete repos, manage webhooks, create policies, invite team members, and review sessions.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-blue text-xs">MEMBER</span>
                  <span className="text-gray-200 font-semibold">Team Member</span>
                </div>
                <P>Can create repos, review sessions, view all data, sync repos, and use the CLI/MCP. Cannot manage integrations or delete repos.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-gray text-xs">VIEWER</span>
                  <span className="text-gray-200 font-semibold">Read-Only Viewer</span>
                </div>
                <P>Can view dashboards, sessions, repos, policies, and audit logs. Cannot create, modify, or delete anything.</P>
              </div>
            </div>

            <H2>Permission Matrix</H2>
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm border border-gray-700 rounded-lg overflow-hidden">
                <thead>
                  <tr className="bg-gray-800">
                    <th className="text-left px-3 py-2 text-gray-400 font-medium">Action</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Owner</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Admin</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Member</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Viewer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {[
                    ['View dashboard & data', true, true, true, true],
                    ['Create repositories', true, true, true, false],
                    ['Import from GitHub', true, true, false, false],
                    ['Delete repositories', true, true, false, false],
                    ['Review sessions', true, true, true, false],
                    ['Manage agents', true, true, true, false],
                    ['Create/edit policies', true, true, false, false],
                    ['Manage integrations', true, true, false, false],
                    ['Create webhooks', true, true, false, false],
                    ['Manage API keys', true, true, false, false],
                    ['View audit logs', true, true, true, true],
                  ].map(([action, ...perms]) => (
                    <tr key={action as string} className="hover:bg-gray-800/30">
                      <td className="px-3 py-2 text-gray-300">{action as string}</td>
                      {(perms as boolean[]).map((allowed, i) => (
                        <td key={i} className="text-center px-3 py-2">
                          {allowed
                            ? <span className="text-green-400">&#10003;</span>
                            : <span className="text-gray-600">&mdash;</span>
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
    </>
  );
}
