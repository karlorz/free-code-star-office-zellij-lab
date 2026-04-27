const encoder = new TextEncoder();

export const SSE_REPLAY_CAPACITY = 64;
const SSE_MAX_BUFFERED_MESSAGES = 32;

export let sseEventSeq = 0;
export let sseClientSeq = 0;
export const sseClients = new Map<number, { controller: ReadableStreamDefaultController; buffered: number; connectedAt: number }>();
export const sseEventLog: { id: number; event: string; payload: unknown }[] = [];

export function incrementSseEventSeq(): number {
  return ++sseEventSeq;
}

export function incrementSseClientSeq(): number {
  return ++sseClientSeq;
}

export function formatSSE(data: unknown, event?: string, id?: number): Uint8Array {
  const parts: string[] = [];
  if (id !== undefined) parts.push(`id: ${id}`);
  if (event) parts.push(`event: ${event}`);
  parts.push(`retry: 3000`);
  parts.push(`data: ${JSON.stringify(data)}`);
  parts.push("", "");
  return encoder.encode(parts.join("\n"));
}

export function broadcastSSE(
  event: string,
  payload: unknown,
  metrics: { sseBroadcasts: number },
  server?: { publish: (topic: string, msg: string) => void },
): number {
  const id = incrementSseEventSeq();
  metrics.sseBroadcasts++;
  return broadcastSSEWithId(id, event, payload, server);
}

export function broadcastSSEWithId(
  id: number,
  event: string,
  payload: unknown,
  server?: { publish: (topic: string, msg: string) => void },
): number {
  const entry = { id, event, payload };
  sseEventLog.push(entry);
  if (sseEventLog.length > SSE_REPLAY_CAPACITY) sseEventLog.shift();
  const message = formatSSE(payload, event, id);
  for (const [cid, client] of sseClients) {
    try {
      client.controller.enqueue(message);
      const ds = client.controller.desiredSize;
      if (ds !== null && ds <= 0) {
        client.buffered++;
      }
      if (client.buffered > SSE_MAX_BUFFERED_MESSAGES) {
        console.warn(`[bridge] dropping slow SSE client ${cid} (${client.buffered} buffered, desiredSize=${ds})`);
        try {
          client.controller.enqueue(formatSSE({ reason: "backpressure", bufferedMessages: client.buffered }, "backpressure"));
          client.controller.close();
        } catch {}
        sseClients.delete(cid);
      }
    } catch {
      sseClients.delete(cid);
    }
  }
  if (server) {
    try {
      server.publish("bridge-events", JSON.stringify({ type: event, id, data: payload }));
    } catch {}
  }
  return id;
}
