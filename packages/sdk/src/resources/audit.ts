import { HttpClient } from '../http.js';
import type { AuditListParams, AuditEntry } from '../types.js';

export class AuditResource {
  constructor(private http: HttpClient) {}

  async list(params?: AuditListParams): Promise<{ entries: AuditEntry[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.action) query.set('action', params.action);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.http.get(`/api/audit${qs ? `?${qs}` : ''}`);
  }
}
