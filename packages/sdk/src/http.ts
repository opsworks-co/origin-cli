import { OriginError, OriginAuthError } from './errors.js';

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
}

export class HttpClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      if (res.status === 401) throw new OriginAuthError();
      const errorBody = await res.json().catch(() => ({}));
      throw new OriginError(
        errorBody.error || `Request failed with status ${res.status}`,
        res.status,
        errorBody
      );
    }

    return res.json() as Promise<T>;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: any): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: any): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
