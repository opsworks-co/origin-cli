import { HttpClient } from '../http.js';
import type { Notification, NotificationListParams, NotificationListResponse } from '../types.js';

export class NotificationsResource {
  constructor(private http: HttpClient) {}

  async list(params?: NotificationListParams): Promise<NotificationListResponse> {
    const query = new URLSearchParams();
    if (params?.unread) query.set('unread', 'true');
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.http.get(`/api/notifications${qs ? `?${qs}` : ''}`);
  }

  async unreadCount(): Promise<{ count: number }> {
    return this.http.get('/api/notifications/unread-count');
  }

  async markRead(id: string): Promise<Notification> {
    return this.http.put<Notification>(`/api/notifications/${id}/read`);
  }

  async markAllRead(): Promise<{ success: boolean }> {
    return this.http.put('/api/notifications/read-all');
  }
}
