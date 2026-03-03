import { HttpClient } from './http.js';
import { AgentsResource } from './resources/agents.js';
import { PoliciesResource } from './resources/policies.js';
import { SessionsResource } from './resources/sessions.js';
import { ReposResource } from './resources/repos.js';
import { AuditResource } from './resources/audit.js';
import { StatsResource } from './resources/stats.js';
import { MachinesResource } from './resources/machines.js';
import { NotificationsResource } from './resources/notifications.js';

export interface OriginClientOptions {
  apiKey: string;
  baseUrl: string;
}

export class OriginClient {
  readonly agents: AgentsResource;
  readonly policies: PoliciesResource;
  readonly sessions: SessionsResource;
  readonly repos: ReposResource;
  readonly audit: AuditResource;
  readonly stats: StatsResource;
  readonly machines: MachinesResource;
  readonly notifications: NotificationsResource;

  constructor(options: OriginClientOptions) {
    const http = new HttpClient(options);
    this.agents = new AgentsResource(http);
    this.policies = new PoliciesResource(http);
    this.sessions = new SessionsResource(http);
    this.repos = new ReposResource(http);
    this.audit = new AuditResource(http);
    this.stats = new StatsResource(http);
    this.machines = new MachinesResource(http);
    this.notifications = new NotificationsResource(http);
  }
}

// Re-export everything
export * from './types.js';
export { OriginError, OriginAuthError, OriginNotFoundError } from './errors.js';
