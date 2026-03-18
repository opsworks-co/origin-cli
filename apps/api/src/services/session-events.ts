import { EventEmitter } from 'events';

const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(100);

export type SessionEventType = 'session:started' | 'session:updated' | 'session:ended' | 'session:reviewed';

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  orgId: string;
  userId?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export function emitSessionEvent(event: SessionEvent) {
  sessionEvents.emit('session', event);
}

export function onSessionEvent(callback: (event: SessionEvent) => void): () => void {
  sessionEvents.on('session', callback);
  return () => { sessionEvents.off('session', callback); };
}

export default sessionEvents;
