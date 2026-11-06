import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useScheduleAlertToasts } from "./alerts";

export const SCHEDULES_SCREEN_ID = "schedules";

/** The Schedules row beside Bots. It's always mounted, so it also shows the failure toasts. */
export function SchedulesSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  useScheduleAlertToasts();
  return <SidebarRow icon="CalendarClock" active={currentScreen?.screenId === SCHEDULES_SCREEN_ID} onPress={() => openScreen({ screenId: SCHEDULES_SCREEN_ID })} />;
}
