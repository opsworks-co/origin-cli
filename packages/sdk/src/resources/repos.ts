import { HttpClient } from '../http.js';
import type { Repo, Commit, CreateRepoParams } from '../types.js';

export class ReposResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Repo[]> {
    return this.http.get<Repo[]>('/api/repos');
  }

  async get(id: string): Promise<Repo> {
    return this.http.get<Repo>(`/api/repos/${id}`);
  }

  async create(params: CreateRepoParams): Promise<Repo> {
    return this.http.post<Repo>('/api/repos', params);
  }

  async update(id: string, params: Partial<CreateRepoParams>): Promise<Repo> {
    return this.http.put<Repo>(`/api/repos/${id}`, params);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`/api/repos/${id}`);
  }

  async sync(id: string): Promise<{ synced: number; total: number }> {
    return this.http.post(`/api/repos/${id}/sync`);
  }

  async commits(id: string): Promise<Commit[]> {
    return this.http.get<Commit[]>(`/api/repos/${id}/commits`);
  }
}
