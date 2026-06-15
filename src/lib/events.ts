// RALD PayRald Core — Event bus publisher
// Publishes to events.rald.cloud using machine JWT (30s TTL).
// Non-blocking — publish failures are logged but never thrown.
// LILCKY STUDIO LIMITED

import { signMachineJwt } from "./auth";

export async function publishEvent(p: {
  eventType:      string;
  source:         string;
  userId?:        string;
  payload:        Record<string, unknown>;
  machineSecret:  string;
  eventBusUrl?:   string;
}): Promise<void> {
  const url = (p.eventBusUrl ?? "https://events.rald.cloud").replace(/\/$/, "");
  try {
    const jwt = await signMachineJwt(p.machineSecret, p.source);
    const res = await fetch(`${url}/events`, {
      method:  "POST",
      headers: {
        "Content-Type":     "application/json",
        "Authorization":    `Bearer ${jwt}`,
        "X-Source-Service": p.source,
      },
      body: JSON.stringify({
        event_type:  p.eventType,
        source:      p.source,
        user_id:     p.userId ?? null,
        payload:     p.payload,
        metadata:    {},
        environment: "production",
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[${p.source}] event-bus ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[${p.source}] event-bus publish failed: ${String(err)}`);
  }
}
