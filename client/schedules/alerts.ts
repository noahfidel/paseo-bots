import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useSyncExternalStore } from "react";
import { KIND_LABELS, type Alert } from "../../shared/schedules";

// Failure alerts for the Schedules screen. The client entry polls
// `bots.schedules.alerts` (which hands each new failure out once) and parks the
// answers here; toasts need a hook, so the Schedules sidebar row and screen
// drain the queue into toasts while either is mounted. Draining removes, so a
// failure is toasted once even with both mounted.

const POLL_MS = 60_000;

let pending: Alert[] = [];
const listeners = new Set<() => void>();
let version = 0;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function drain(): Alert[] {
  const taken = pending;
  pending = [];
  return taken;
}

export function alertText(alert: Alert): string {
  return `${KIND_LABELS[alert.kind]} "${alert.name}" failed: ${alert.failure}`;
}

/** Starts the poll; the returned cleanup stops it. */
export function startScheduleAlerts(fetchAlerts: () => Promise<{ alerts: Alert[] }>, intervalMs = POLL_MS): () => void {
  let stopped = false;
  let busy = false;
  let lastWarning: string | null = null;
  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const { alerts } = await fetchAlerts();
      lastWarning = null;
      if (!stopped && alerts.length > 0) {
        pending = [...pending, ...alerts];
        publish();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text !== lastWarning) console.warn(`paseo-bots: couldn't check schedules for failures: ${text}`);
      lastWarning = text;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void poll(), intervalMs);
  void poll();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Shows any parked failure alerts as toasts. Mount it wherever Schedules UI is always present. */
export function useScheduleAlertToasts(): void {
  const toast = useToast();
  const current = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    for (const alert of drain()) toast.show(alertText(alert), { variant: "error", durationMs: 10_000 });
  }, [current, toast]);
}
