import { HttpClient } from '../http.js';
import type { Session, SessionListParams, SessionListResponse, SessionReview } from '../types.js';

export class SessionsResource {
  constructor(private http: HttpClient) {}

  async list(params?: SessionListParams): Promise<SessionListResponse> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.model) query.set('model', params.model);
    if (params?.agentId) query.set('agentId', params.agentId);
    if (params?.repoId) query.set('repoId', params.repoId);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.http.get<SessionListResponse>(`/api/sessions${qs ? `?${qs}` : ''}`);
  }

  async get(id: string): Promise<Session> {
    return this.http.get<Session>(`/api/sessions/${id}`);
  }

  async review(id: string, status: 'APPROVED' | 'REJECTED' | 'FLAGGED', note?: string): Promise<SessionReview> {
    return this.http.post<SessionReview>(`/api/sessions/${id}/review`, { status, note });
  }
}
