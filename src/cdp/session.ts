/**
 * Long-lived CDP sessions for tools that need event streaming
 * (breakpoint, tail_logs). Each session is identified by an ID
 * and buffers events the agent can later drain.
 */
import CDP from "chrome-remote-interface";
import { randomUUID } from "node:crypto";
import { connect, type TargetSelector } from "./client.ts";

export interface BufferedEvent {
  ts: number;
  kind: string;
  payload: unknown;
}

export interface Session {
  id: string;
  kind: "breakpoint" | "logs";
  client: CDP.Client;
  events: BufferedEvent[];
  closed: boolean;
  meta: Record<string, unknown>;
}

const sessions = new Map<string, Session>();

export async function openSession(
  kind: Session["kind"],
  sel: TargetSelector,
  meta: Record<string, unknown> = {}
): Promise<Session> {
  const client = await connect(sel);
  const session: Session = {
    id: randomUUID(),
    kind,
    client,
    events: [],
    closed: false,
    meta,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function pushEvent(session: Session, kind: string, payload: unknown) {
  if (session.closed) return;
  session.events.push({ ts: Date.now(), kind, payload });
  // Cap buffer to avoid runaway memory.
  if (session.events.length > 10_000) {
    session.events.splice(0, session.events.length - 10_000);
  }
}

export function drainEvents(session: Session): BufferedEvent[] {
  const out = session.events.splice(0);
  return out;
}

export async function closeSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  session.closed = true;
  try {
    await session.client.close();
  } catch {
    // ignore
  }
  sessions.delete(id);
  return true;
}

export function listSessions(): Array<Pick<Session, "id" | "kind" | "meta">> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    kind: s.kind,
    meta: s.meta,
  }));
}
