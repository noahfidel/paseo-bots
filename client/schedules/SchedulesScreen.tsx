import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { routineRunNowRpc } from "../../shared/rpc";
import {
  filterChoices,
  filterSchedules,
  KIND_LABELS,
  parseScheduleFilter,
  resolveScheduleFilter,
  SCHEDULE_FILTER_EMPTY,
  launchdDeleteRpc,
  launchdLogRpc,
  launchdRunRpc,
  launchdSetEnabledRpc,
  paseoLogsRpc,
  paseoPauseRpc,
  paseoResumeRpc,
  paseoRunOnceRpc,
  relativeTime,
  schedulesListRpc,
  type ScheduleFilter,
  type ScheduleItem,
  type ScheduleKind,
} from "../../shared/schedules";
import { readItem, writeItem } from "../chat/composer/storage";
import { CONTENT_MAX_WIDTH, confirmDialog, errorText, MONO_FONT, nativeTokens } from "../native";
import { Alert, Button, CardNote, StatusBadge, type BadgeVariant } from "../panel/controls";
import { ui } from "../typography";
import { useBotSettings } from "../useBotSettings";
import { useScheduleAlertToasts } from "./alerts";
import { JobEditor, type EditorTarget } from "./JobEditor";

type Colors = PluginTheme["colors"];
const LIST_KEY = ["paseo-bots", "schedules"];
/** Per device (localStorage on web and desktop, AsyncStorage on phones), not in the bot settings. */
const FILTER_STORAGE_KEY = "@paseo-bots:schedules-filter";

const KIND_VARIANT: Record<ScheduleKind, BadgeVariant> = { routine: "success", launchd: "warning", paseo: "muted" };

function statusOf(item: ScheduleItem): { label: string; variant: BadgeVariant } | null {
  if (item.running) return { label: "Running", variant: "warning" };
  if (item.paused) return { label: "Paused", variant: "muted" };
  if (item.lastRun?.status === "failed") return { label: "Failed", variant: "error" };
  return null;
}

function lastRunText(item: ScheduleItem, now: Date): string {
  const run = item.lastRun;
  if (!run) return "Never run";
  const words = { succeeded: "Succeeded", failed: "Failed", running: "Running since", skipped: "Skipped" }[run.status];
  return `${words} ${relativeTime(run.at, now)}`;
}

/** Bot routines, launchd jobs and Paseo schedules on this host, in one list. */
export function SchedulesScreen({ theme, layout, navigation }: PluginScreenProps) {
  const colors = theme.colors;
  useScheduleAlertToasts();
  const list = useRpc(schedulesListRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: LIST_KEY, queryFn: () => list({}), refetchInterval: 15_000 });
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [savedFilter, setSavedFilter] = useState<ScheduleFilter>("all");
  useEffect(() => {
    let alive = true;
    void readItem(FILTER_STORAGE_KEY).then((raw) => alive && setSavedFilter(parseScheduleFilter(raw)));
    return () => {
      alive = false;
    };
  }, []);
  const chooseFilter = (next: ScheduleFilter) => {
    setSavedFilter(next);
    void writeItem(FILTER_STORAGE_KEY, next);
  };
  const { commit } = useBotSettings();
  const refresh = () => queryClient.invalidateQueries({ queryKey: LIST_KEY });

  const act = async (id: string, done: string | null, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
      if (done) toast.show(done, { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const rpcs = {
    runRoutine: useRpc(routineRunNowRpc),
    runJob: useRpc(launchdRunRpc),
    setJobEnabled: useRpc(launchdSetEnabledRpc),
    deleteJob: useRpc(launchdDeleteRpc),
    pause: useRpc(paseoPauseRpc),
    resume: useRpc(paseoResumeRpc),
    runOnce: useRpc(paseoRunOnceRpc),
  };

  const setRoutineEnabled = (item: ScheduleItem, enabled: boolean) =>
    commit((values) => ({
      ...values,
      bots: values.bots.map((bot) =>
        bot.id === item.routine?.botId ? { ...bot, routines: bot.routines.map((routine) => (routine.id === item.routine?.routineId ? { ...routine, enabled } : routine)) } : bot,
      ),
    })).then((saved) => {
      if (!saved) throw new Error("Couldn't save the routine.");
    });

  const openChat = navigation?.openAgent;
  const actions = (item: ScheduleItem) => {
    const key = (name: string) => `${item.key}:${name}`;
    const button = (name: string, label: string, onPress: () => void, variant: "secondary" | "ghost" | "outline" = "secondary") => (
      <Button key={name} colors={colors} label={label} size="xs" variant={variant} loading={busy === key(name)} disabled={busy !== null && busy !== key(name)} onPress={onPress} />
    );
    const chat = item.lastRun?.agentId && openChat ? button("chat", "Open last chat", () => openChat({ agentId: item.lastRun!.agentId! }), "ghost") : null;
    if (item.kind === "routine" && item.routine) {
      const { botId, routineId } = item.routine;
      return [
        button("toggle", item.paused ? "Resume" : "Pause", () => void act(key("toggle"), null, () => setRoutineEnabled(item, item.paused))),
        button("run", "Run now", () => void act(key("run"), "Started a run", () => rpcs.runRoutine({ botId, routineId }))),
        chat,
      ];
    }
    if (item.kind === "launchd") {
      return [
        button("run", "Run now", () => void act(key("run"), "Started", () => rpcs.runJob({ id: item.id }))),
        button("toggle", item.paused ? "Resume" : "Pause", () => void act(key("toggle"), null, () => rpcs.setJobEnabled({ id: item.id, enabled: item.paused }))),
        button("log", expanded === item.key ? "Hide log" : "Log", () => setExpanded(expanded === item.key ? null : item.key), "ghost"),
        button("edit", "Edit", () => setEditor({ mode: "edit", item }), "ghost"),
        button(
          "delete",
          "Delete",
          () =>
            void confirmDialog({ title: "Delete launchd job", message: `Delete "${item.name}"? Its plist, log and run history go too.`, confirmLabel: "Delete", destructive: true }).then(
              (confirmed) => {
                if (confirmed) void act(key("delete"), "Deleted", () => rpcs.deleteJob({ id: item.id }));
              },
            ),
          "ghost",
        ),
      ];
    }
    const completed = item.paseo?.status === "completed";
    return [
      completed ? null : button("toggle", item.paused ? "Resume" : "Pause", () => void act(key("toggle"), null, () => (item.paused ? rpcs.resume({ id: item.id }) : rpcs.pause({ id: item.id })))),
      button("run", "Run once", () => void act(key("run"), "Started a run", () => rpcs.runOnce({ id: item.id }))),
      button("log", expanded === item.key ? "Hide logs" : "Logs", () => setExpanded(expanded === item.key ? null : item.key), "ghost"),
      chat,
    ];
  };

  const data = query.data;
  const filter = resolveScheduleFilter(savedFilter, data?.launchd.shown ?? true);
  const visible = data ? filterSchedules(data.items, filter) : [];
  const now = new Date();
  const padding = layout.compact ? 16 : 24;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding, gap: 12, width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ flex: 1, minWidth: 160, color: colors.foregroundMuted, fontSize: ui(13) }}>Everything that runs on a timer on this host: bot routines, launchd jobs and Paseo schedules.</Text>
        <Button colors={colors} label="Refresh" size="sm" variant="ghost" icon="RefreshCw" loading={query.isFetching} onPress={() => void refresh()} />
        {data?.launchd.shown ? <Button colors={colors} label="New launchd job" size="sm" variant="default" icon="Plus" onPress={() => setEditor({ mode: "create" })} /> : null}
      </View>
      {data ? (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {filterChoices(data.items, data.launchd.shown).map((choice) => (
            <Button key={choice.value} colors={colors} label={choice.label} size="xs" variant={choice.value === filter ? "default" : "outline"} onPress={() => chooseFilter(choice.value)} />
          ))}
        </View>
      ) : null}
      {query.error ? <Alert colors={colors} variant="error" title="Couldn't load schedules" description={errorText(query.error)} /> : null}
      {data?.paseo.error ? <Alert colors={colors} variant="warning" title="Paseo schedules aren't listed" description={data.paseo.error} /> : null}
      {data?.launchd.error ? <Alert colors={colors} variant="warning" title="launchd jobs aren't listed" description={data.launchd.error} /> : null}
      {!data && !query.error ? <CardNote colors={colors} text="Loading..." loading /> : null}
      {data && visible.length === 0 ? <CardNote colors={colors} text={SCHEDULE_FILTER_EMPTY[filter]} /> : null}
      {visible.map((item) => (
        <ScheduleRow key={item.key} colors={colors} item={item} now={now} actions={actions(item)} expanded={expanded === item.key} openChat={openChat} />
      ))}
      {editor ? (
        <JobEditor
          colors={colors}
          target={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            toast.show("Saved and reloaded", { variant: "success" });
            void refresh();
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function ScheduleRow({
  colors,
  item,
  now,
  actions,
  expanded,
  openChat,
}: {
  colors: Colors;
  item: ScheduleItem;
  now: Date;
  actions: ReactNode[];
  expanded: boolean;
  openChat: ((input: { agentId: string }) => void) | undefined;
}) {
  const status = statusOf(item);
  const tokens = nativeTokens(colors);
  const muted = { color: colors.foregroundMuted, fontSize: ui(12) };
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1, padding: 12, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusBadge colors={colors} label={KIND_LABELS[item.kind]} variant={KIND_VARIANT[item.kind]} />
        <Text style={{ flex: 1, minWidth: 120, color: colors.foreground, fontSize: ui(14), fontWeight: "600" }} numberOfLines={1}>
          {item.name}
        </Text>
        {status ? <StatusBadge colors={colors} label={status.label} variant={status.variant} /> : null}
      </View>
      <Text style={muted}>
        {item.schedule}
        {item.nextRunAt ? ` · next ${relativeTime(item.nextRunAt, now)} (${new Date(item.nextRunAt).toLocaleString()})` : ""}
      </Text>
      <Text style={muted}>
        {lastRunText(item, now)}
        {item.lastRun ? ` (${new Date(item.lastRun.at).toLocaleString()})` : ""}
      </Text>
      {item.failure ? (
        <Text style={{ color: colors.statusDanger, fontSize: ui(12) }} numberOfLines={4}>
          {item.failure}
        </Text>
      ) : null}
      {item.launchd ? (
        <Text style={{ color: tokens.foregroundExtraMuted, fontSize: ui(11), fontFamily: MONO_FONT }} numberOfLines={2}>
          {item.launchd.command}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4 }}>{actions}</View>
      {expanded && item.kind === "launchd" ? <LaunchdLog colors={colors} id={item.id} now={now} /> : null}
      {expanded && item.kind === "paseo" ? <PaseoLogs colors={colors} id={item.id} now={now} openChat={openChat} /> : null}
    </View>
  );
}

function LaunchdLog({ colors, id, now }: { colors: Colors; id: string; now: Date }) {
  const read = useRpc(launchdLogRpc);
  const query = useQuery({ queryKey: [...LIST_KEY, "launchd-log", id], queryFn: () => read({ id }), refetchInterval: 10_000 });
  const muted = { color: colors.foregroundMuted, fontSize: ui(12) };
  if (query.error) return <Text style={{ color: colors.statusDanger, fontSize: ui(12) }}>{errorText(query.error)}</Text>;
  if (!query.data) return <Text style={muted}>Loading...</Text>;
  const { runs, text, truncated, path } = query.data;
  return (
    <View style={{ gap: 8, marginTop: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: ui(13), fontWeight: "600" }}>Run history</Text>
      {runs.length === 0 ? <Text style={muted}>No runs yet.</Text> : null}
      {runs.map((run) => (
        <Text key={run.startedAt} style={{ fontSize: ui(12), color: run.exitCode === 0 ? colors.foregroundMuted : colors.statusDanger }}>
          {new Date(run.startedAt).toLocaleString()} ({relativeTime(run.startedAt, now)}) · exit {run.exitCode} · {(run.durationMs / 1000).toFixed(1)} s
        </Text>
      ))}
      <Text style={{ color: colors.foreground, fontSize: ui(13), fontWeight: "600" }}>Log{truncated ? " (end)" : ""}</Text>
      <ScrollView style={{ maxHeight: 280, backgroundColor: colors.surface2, borderRadius: 6 }} contentContainerStyle={{ padding: 8 }}>
        <Text selectable style={{ color: colors.foreground, fontFamily: MONO_FONT, fontSize: ui(11) }}>
          {text.trim() || "The log is empty."}
        </Text>
      </ScrollView>
      <Text selectable style={{ ...muted, fontSize: ui(11) }}>
        {path}
      </Text>
    </View>
  );
}

function PaseoLogs({ colors, id, now, openChat }: { colors: Colors; id: string; now: Date; openChat: ((input: { agentId: string }) => void) | undefined }) {
  const read = useRpc(paseoLogsRpc);
  const query = useQuery({ queryKey: [...LIST_KEY, "paseo-logs", id], queryFn: () => read({ id }), refetchInterval: 15_000 });
  const muted = { color: colors.foregroundMuted, fontSize: ui(12) };
  if (query.error) return <Text style={{ color: colors.statusDanger, fontSize: ui(12) }}>{errorText(query.error)}</Text>;
  if (!query.data) return <Text style={muted}>Loading...</Text>;
  if (query.data.runs.length === 0) return <Text style={muted}>No runs yet.</Text>;
  return (
    <View style={{ gap: 8, marginTop: 4 }}>
      {query.data.runs.slice(0, 20).map((run) => (
        <View key={run.id} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ fontSize: ui(12), color: run.status === "failed" ? colors.statusDanger : colors.foreground }}>
              {run.status} · {new Date(run.startedAt).toLocaleString()} ({relativeTime(run.startedAt, now)})
            </Text>
            {run.agentId && openChat ? <Button colors={colors} label="Open chat" size="xs" variant="ghost" onPress={() => openChat({ agentId: run.agentId! })} /> : null}
          </View>
          {run.error ? <Text style={{ fontSize: ui(12), color: colors.statusDanger }}>{run.error}</Text> : null}
          {run.output ? (
            <Text style={muted} numberOfLines={3}>
              {run.output}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
