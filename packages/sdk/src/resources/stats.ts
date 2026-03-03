import { HttpClient } from '../http.js';
import type { Stats } from '../types.js';

export class StatsResource {
  constructor(private http: HttpClient) {}

  async get(): Promise<Stats> {
    return this.http.get<Stats>('/api/stats');
  }
}
