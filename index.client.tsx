import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

import { PortsScreen } from "./client/ports-screen";
import { PortSettingsScreen } from "./client/settings-screen";

function PortsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Cable"
      active={currentScreen?.screenId === "ports"}
      onPress={() => openScreen({ screenId: "ports" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "ports", title: "Ports", Component: PortsScreen });
  client.addSidebarHeaderItem({ id: "ports", title: "Ports", Component: PortsSidebarItem });
  client.addSettingsScreen({
    id: "ports",
    title: "Port forwarding",
    icon: "Cable",
    Component: PortSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-ports",
    title: "Open Ports",
    icon: "Cable",
    keywords: ["ports", "forward", "ssh", "localhost", "tunnel"],
    context: "global",
    onSelect(context) {
      context.openScreen({ screenId: "ports" });
    },
  });
  return () => {};
}
