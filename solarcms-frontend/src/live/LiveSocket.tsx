/**
 * The application's **one** WebSocket (§5.2, Guardrail 12).
 *
 * Nine Inverter tiles must not open nine sockets, so the socket lives here and
 * components subscribe through the context. Two consequences worth stating:
 *
 * - **Rooms are assigned by the server** (I-8). There is no client-side
 *   subscribe message and a room cannot be requested. If a Plant's data is not
 *   arriving, the User is not assigned to it — that is the answer, not a bug.
 * - **The socket is a supplement, not a source** (§5.2). Current state is loaded
 *   over REST first; this only updates it. A tab opened during a broker outage
 *   must still show the last known values with their age.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getTokens } from "@/api/tokens";
import { LiveControlSchema, LiveFrameSchema, type LiveFrame } from "@/api/schemas";
import { useAuth } from "@/auth/AuthProvider";

export interface DeviceLiveState {
  deviceId: number;
  plantId: number;
  /** Keyed by tag_id. Join against /catalog/tags for code and unit (§5.1). */
  values: Record<number, number>;
  /** Server-stamped instant of the batch; staleness is measured from it. */
  at: string;
}

export type SocketStatus =
  | "connecting"
  | "open"
  | "closed"
  /** Connected, but the token entitles the User to no Plants at all. */
  | "no_rooms";

interface LiveContextValue {
  status: SocketStatus;
  rooms: string[];
  /** Latest frame per Device. Read through `useLiveDevice`, not directly. */
  devices: Record<number, DeviceLiveState>;
  lastMessageAt: number | null;
}

const LiveContext = createContext<LiveContextValue>({
  status: "closed",
  rooms: [],
  devices: {},
  lastMessageAt: null,
});

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** Exponential with jitter: a restarting API must not be met by every tab at once. */
function backoffDelay(attempt: number): number {
  const capped = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return capped / 2 + Math.random() * (capped / 2);
}

function socketUrl(token: string): string {
  const configured = import.meta.env.VITE_WS_BASE as string | undefined;
  const origin =
    configured && configured.length > 0
      ? configured
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  // ⚠ The token lands in server logs because it is a query parameter. That is
  // why this always reads the *current access* token — short-lived, and never
  // the refresh token (§5.1).
  return `${origin}/ws/live?token=${encodeURIComponent(token)}`;
}

export function LiveSocketProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status: authStatus, me } = useAuth();
  const [status, setStatus] = useState<SocketStatus>("closed");
  const [rooms, setRooms] = useState<string[]>([]);
  const [devices, setDevices] = useState<Record<number, DeviceLiveState>>({});
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const closedByUsRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    const token = getTokens()?.access_token;
    if (!token) {
      setStatus("closed");
      return;
    }

    closedByUsRef.current = false;
    setStatus("connecting");
    const socket = new WebSocket(socketUrl(token));
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setStatus("open");
    };

    socket.onmessage = (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const control = LiveControlSchema.safeParse(payload);
      if (control.success) {
        if (control.data.type === "subscribed") {
          setRooms(control.data.rooms);
          setStatus(control.data.rooms.length === 0 ? "no_rooms" : "open");
        } else {
          setRooms([]);
          setStatus("no_rooms");
        }
        return;
      }

      const frame = LiveFrameSchema.safeParse(payload);
      if (!frame.success) return;
      applyFrame(frame.data);
    };

    const applyFrame = (frame: LiveFrame) => {
      setLastMessageAt(Date.now());
      setDevices((previous) => {
        const existing = previous[frame.device_id];
        // Merge rather than replace: a batch carries only the Tags that were
        // published in it, and a Device throttles its Tags independently.
        const values: Record<number, number> = { ...(existing?.values ?? {}) };
        for (const [tagId, value] of Object.entries(frame.values)) {
          values[Number(tagId)] = value;
        }
        return {
          ...previous,
          [frame.device_id]: {
            deviceId: frame.device_id,
            plantId: frame.plant_id,
            values,
            at: frame.at,
          },
        };
      });
    };

    socket.onclose = () => {
      socketRef.current = null;
      if (closedByUsRef.current) {
        setStatus("closed");
        return;
      }
      setStatus("closed");
      const delay = backoffDelay(attemptRef.current);
      attemptRef.current += 1;
      clearTimer();
      // Reconnect reads a fresh access token rather than reusing a long-lived
      // one, which is the other half of the query-string caveat above.
      timerRef.current = window.setTimeout(connect, delay);
    };

    socket.onerror = () => {
      // onclose always follows; the reconnect is scheduled there so it is
      // scheduled exactly once.
      socket.close();
    };
  }, [clearTimer]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      closedByUsRef.current = true;
      clearTimer();
      socketRef.current?.close();
      socketRef.current = null;
      setDevices({});
      setRooms([]);
      setStatus("closed");
      return;
    }

    // Reconnect on a Client switch as well as on login: the previous socket's
    // rooms belong to the previous Client, and its frames must not survive.
    setDevices({});
    attemptRef.current = 0;
    connect();

    return () => {
      closedByUsRef.current = true;
      clearTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [authStatus, me?.client_id, connect, clearTimer]);

  const value = useMemo<LiveContextValue>(
    () => ({ status, rooms, devices, lastMessageAt }),
    [status, rooms, devices, lastMessageAt],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLiveSocket(): LiveContextValue {
  return useContext(LiveContext);
}
