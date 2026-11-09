/**
 * Tiny in-process pub/sub used by Server-Sent Events.
 * Channels: `queue:<departmentId>` and `user:<userId>`.
 * For multi-node deployments swap for Redis pub/sub (same interface).
 */
export interface EventPayload {
  type: string;
  data: unknown;
  at: string;
}

type Listener = (payload: EventPayload) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(channel: string, listener: Listener): () => void {
  const set = channels.get(channel) ?? new Set<Listener>();
  set.add(listener);
  channels.set(channel, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) channels.delete(channel);
  };
}

export function publish(channel: string, type: string, data: unknown) {
  const payload: EventPayload = { type, data, at: new Date().toISOString() };
  const set = channels.get(channel);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(payload);
    } catch {
      /* listener errors must not break publishers */
    }
  }
}

export function subscriberCount(channel: string): number {
  return channels.get(channel)?.size ?? 0;
}

export function resetChannels() {
  channels.clear();
}
