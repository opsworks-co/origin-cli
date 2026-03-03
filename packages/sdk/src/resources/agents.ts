import { HttpClient } from '../http.js';
import type { Agent, AgentVersion, CreateAgentParams, UpdateAgentParams } from '../types.js';

export class AgentsResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Agent[]> {
    return this.http.get<Agent[]>('/api/agents');
  }

  async get(id: string): Promise<Agent> {
    return this.http.get<Agent>(`/api/agents/${id}`);
  }

  async create(params: CreateAgentParams): Promise<Agent> {
    return this.http.post<Agent>('/api/agents', params);
  }

  async update(id: string, params: UpdateAgentParams): Promise<Agent> {
    return this.http.put<Agent>(`/api/agents/${id}`, params);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`/api/agents/${id}`);
  }

  async versions(id: string): Promise<{ versions: AgentVersion[]; total: number }> {
    return this.http.get(`/api/agents/${id}/versions`);
  }
}
