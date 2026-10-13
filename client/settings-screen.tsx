import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useHosts } from "@getpaseo/plugin/client";
import {
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { ScrollView, Text } from "react-native";

import { parsePortList } from "../shared/settings";
import { usePortSettings } from "./use-port-settings";

export function PortSettingsScreen({ host, theme }: PluginSurfaceProps) {
  const { state, values, update, setTarget } = usePortSettings();
  const remotes = useHosts().filter((candidate) => candidate.serverId !== host.id);

  if (!values) {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>
        {state.status === "loading" ? "Loading…" : "error" in state ? state.error : ""}
      </Text>
    );
  }

  return (
    <ScrollView automaticallyAdjustKeyboardInsets>
      <SettingsSection title="SSH targets">
        {remotes.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>No remote hosts configured.</Text>
        ) : null}
        {remotes.map((remote) => (
          <SettingsInput
            key={remote.serverId}
            label={remote.label}
            hint={`user@host or a ~/.ssh/config alias for ${remote.serverId}`}
            initialValue={values.targets[remote.serverId] ?? ""}
            placeholder="not forwarded"
            onChangeText={(text) => void setTarget(remote.serverId, text)}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Forwarding">
        <SettingsSwitch
          label="Auto-forward"
          hint="Forward new ports automatically on every host with an SSH target, and remove the forward when the remote port closes."
          value={values.autoForward}
          onValueChange={(autoForward) => void update((current) => ({ ...current, autoForward }))}
        />
        <SettingsInput
          label="Ignored ports"
          hint="Never auto-forwarded. Separate with commas or spaces."
          initialValue={values.ignorePorts.join(", ")}
          onChangeText={(text) =>
            void update((current) => ({ ...current, ignorePorts: parsePortList(text) }))
          }
        />
        <SettingsInput
          label="Auto-forward poll interval (seconds)"
          initialValue={String(values.pollSeconds)}
          onChangeText={(text) => {
            const pollSeconds = Number(text);
            if (Number.isInteger(pollSeconds) && pollSeconds >= 1 && pollSeconds <= 60) {
              void update((current) => ({ ...current, pollSeconds }));
            }
          }}
        />
      </SettingsSection>
    </ScrollView>
  );
}
