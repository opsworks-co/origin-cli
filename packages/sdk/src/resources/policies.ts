import { HttpClient } from '../http.js';
import type { Policy, PolicyVersion, PolicyRule, CreatePolicyParams, UpdatePolicyParams, CreatePolicyRuleParams } from '../types.js';

export class PoliciesResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Policy[]> {
    return this.http.get<Policy[]>('/api/policies');
  }

  async create(params: CreatePolicyParams): Promise<Policy> {
    return this.http.post<Policy>('/api/policies', params);
  }

  async update(id: string, params: UpdatePolicyParams): Promise<Policy> {
    return this.http.put<Policy>(`/api/policies/${id}`, params);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`/api/policies/${id}`);
  }

  async addRule(policyId: string, params: CreatePolicyRuleParams): Promise<PolicyRule> {
    return this.http.post<PolicyRule>(`/api/policies/${policyId}/rules`, params);
  }

  async deleteRule(policyId: string, ruleId: string): Promise<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`/api/policies/${policyId}/rules/${ruleId}`);
  }

  async versions(id: string): Promise<{ versions: PolicyVersion[]; total: number }> {
    return this.http.get(`/api/policies/${id}/versions`);
  }
}
