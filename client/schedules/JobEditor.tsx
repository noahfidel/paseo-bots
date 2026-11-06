import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { describeLaunchdSpec, launchdCreateRpc, launchdUpdateRpc, parseTimes, specFromSchedule, type LaunchdJobSpec, type LaunchdScheduleSpec, type ScheduleItem } from "../../shared/schedules";
import { errorText, nativeTokens } from "../native";
import { Button, InputField, SheetActions, TextAreaField } from "../panel/controls";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type EditorTarget = { mode: "create" } | { mode: "edit"; item: ScheduleItem };

/** Create or edit a launchd job: name, command, schedule and PATH. Saving writes the plist and reloads it. */
export function JobEditor({ colors, target, onClose, onSaved }: { colors: Colors; target: EditorTarget; onClose(): void; onSaved(): void }) {
  const create = useRpc(launchdCreateRpc);
  const update = useRpc(launchdUpdateRpc);
  const existing = target.mode === "edit" ? target.item.launchd : undefined;
  const initial: LaunchdScheduleSpec = (existing && specFromSchedule(existing.schedule)) ?? { type: "interval", minutes: 60 };
  const [name, setName] = useState(target.mode === "edit" ? target.item.name : "");
  const [command, setCommand] = useState(existing?.command ?? "");
  const [kind, setKind] = useState<LaunchdScheduleSpec["type"]>(initial.type);
  const [minutes, setMinutes] = useState(initial.type === "interval" ? String(initial.minutes) : "60");
  const [times, setTimes] = useState(initial.type === "calendar" ? initial.times.join(", ") : "09:00");
  const [weekdays, setWeekdays] = useState<number[]>(initial.type === "calendar" ? initial.weekdays : []);
  const [path, setPath] = useState(existing?.path ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unmanaged = existing !== undefined && !existing.managed;
  const replacesSchedule = existing !== undefined && specFromSchedule(existing.schedule) === null;

  const schedule = (): LaunchdScheduleSpec | string => {
    if (kind === "interval") {
      const value = Number(minutes);
      return Number.isInteger(value) && value >= 1 && value <= 10_080 ? { type: "interval", minutes: value } : "Minutes must be a whole number from 1 to 10080.";
    }
    const parsed = parseTimes(times);
    return parsed.ok ? { type: "calendar", times: parsed.times, weekdays } : parsed.error;
  };
  const preview = schedule();

  const save = async () => {
    const built = schedule();
    if (typeof built === "string") return setError(built);
    if (!name.trim() || !command.trim()) return setError("Give the job a name and a command.");
    const spec: LaunchdJobSpec = { name: name.trim(), command: command.trim(), schedule: built, path: path.trim() || null };
    setSaving(true);
    setError(null);
    try {
      if (target.mode === "edit") await update({ id: target.item.id, spec });
      else await create(spec);
      onSaved();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const tokens = nativeTokens(colors);
  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.accent : tokens.surface3 }}
    >
      <Text style={{ fontSize: ui(12), color: on ? colors.accentForeground : colors.foreground }}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal title={target.mode === "edit" ? "Edit launchd job" : "New launchd job"} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <InputField colors={colors} label="Name" initialValue={name} onChangeText={setName} placeholder="Nightly backup" />
        <TextAreaField
          colors={colors}
          label="Command"
          hint={unmanaged ? "This job was written by hand; saving runs this command through the Schedules runner instead." : "Run with /bin/zsh -lc, so anything a shell takes works."}
          value={command}
          onChangeText={setCommand}
          monospace
          minHeight={72}
        />
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <Text style={{ color: colors.foreground, fontSize: ui(14) }}>Schedule</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {chip("Every N minutes", kind === "interval", () => setKind("interval"))}
            {chip("Daily or weekly at set times", kind === "calendar", () => setKind("calendar"))}
          </View>
          {replacesSchedule ? <Text style={{ color: colors.statusWarning, fontSize: ui(12) }}>This job's current schedule ({existing!.schedule.description}) can't be edited here; saving replaces it.</Text> : null}
        </View>
        {kind === "interval" ? (
          <InputField key="minutes" colors={colors} label="Every how many minutes" initialValue={minutes} onChangeText={setMinutes} keyboardType="number-pad" />
        ) : (
          <>
            <InputField key="times" colors={colors} label="Times" hint="24-hour, separated by commas: 09:00, 17:30" initialValue={times} onChangeText={setTimes} />
            <View style={{ paddingHorizontal: 16, gap: 8 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>Days (none picked = every day)</Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {WEEKDAYS.map((label, day) =>
                  chip(label, weekdays.includes(day), () => setWeekdays((current) => (current.includes(day) ? current.filter((entry) => entry !== day) : [...current, day].sort()))),
                )}
              </View>
            </View>
          </>
        )}
        <Text style={{ paddingHorizontal: 16, color: typeof preview === "string" ? colors.statusDanger : colors.foregroundMuted, fontSize: ui(12) }}>
          {typeof preview === "string" ? preview : describeLaunchdSpec(preview)}
        </Text>
        <InputField
          colors={colors}
          label="PATH"
          hint="Leave empty to use your login shell's PATH, as it is when you save."
          initialValue={path}
          onChangeText={setPath}
          placeholder="/opt/homebrew/bin:/usr/bin:/bin"
          monospace
          autoCapitalize="none"
          autoCorrect={false}
        />
        {error ? <Text style={{ paddingHorizontal: 16, color: colors.statusDanger, fontSize: ui(13) }}>{error}</Text> : null}
        <SheetActions>
          <Button colors={colors} label="Cancel" variant="ghost" onPress={onClose} />
          <Button colors={colors} label={target.mode === "edit" ? "Save and reload" : "Create job"} variant="default" loading={saving} onPress={() => void save()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
