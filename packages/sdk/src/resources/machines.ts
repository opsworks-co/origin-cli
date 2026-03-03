import { HttpClient } from '../http.js';
import type { Machine } from '../types.js';

export class MachinesResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Machine[]> {
    return this.http.get<Machine[]>('/api/machines');
  }

  async register(data: { hostname: string; machineId: string; detectedTools?: string[] }): Promise<Machine> {
    return this.http.post<Machine>('/api/machines', data);
  }
}
