import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { getPaseoClient, openExternalUrl, useHosts, useRpc } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import {
  forwardRpc,
  stateRpc,
  testConnectionRpc,
  unforwardRpc,
  type Forward,
  type PortsState,
  type RemotePort,
} from "../shared/contracts";
import { makeStyles, type Styles } from "./styles";
import { usePortSettings } from "./use-port-settings";
import { canCopy, copyText } from "./web";

const POLL_MS = 2_000;

export function PortsScreen({ theme, layout, host, params }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const hosts = useHosts();
  // This plugin runs on the laptop daemon; every other configured host is a remote.
  const remotes = hosts.filter((candidate) => candidate.serverId !== host.id);
  const [picked, setPicked] = useState<string | null>(params.serverId ?? null);
  const selected = remotes.find((remote) => remote.serverId === picked) ?? remotes[0] ?? null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Ports</Text>
      <Text style={styles.muted}>
        Ports opened by agents and terminals on your remote Paseo hosts, forwarded to this
        machine's localhost over your own SSH connection.
      </Text>
      {remotes.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.text}>No remote hosts.</Text>
          <Text style={styles.muted}>
            Add a remote Paseo host in the app. Ports on {host.label} itself need no forwarding.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.chips}>
            {remotes.map((remote) => (
              <Pressable
                key={remote.serverId}
                accessibilityRole="button"
                onPress={() => setPicked(remote.serverId)}
                style={[styles.chip, remote.serverId === selected?.serverId && styles.chipActive]}
              >
                <Text
                  style={
                    remote.serverId === selected?.serverId ? styles.chipTextActive : styles.chipText
                  }
                >
                  {remote.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {selected ? (
            <HostPorts
              key={selected.serverId}
              serverId={selected.serverId}
              label={selected.label}
              styles={styles}
              theme={theme}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

interface HostPortsProps {
  serverId: string;
  label: string;
  styles: Styles;
  theme: PluginTheme;
}

function HostPorts({ serverId, label, styles, theme }: HostPortsProps) {
  const { values, setTarget } = usePortSettings();
  const target = values?.targets[serverId] ?? null;
  const [editing, setEditing] = useState(false);

  if (!values) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (!target || editing) {
    return (
      <TargetForm
        serverId={serverId}
        label={label}
        initial={target ?? ""}
        styles={styles}
        onSave={async (next) => {
          await setTarget(serverId, next);
          setEditing(false);
        }}
        onCancel={target ? () => setEditing(false) : null}
      />
    );
  }
  return (
    <PortList
      serverId={serverId}
      styles={styles}
      theme={theme}
      onEditTarget={() => setEditing(true)}
    />
  );
}

interface TargetFormProps {
  serverId: string;
  label: string;
  initial: string;
  styles: Styles;
  onSave(target: string): Promise<void>;
  onCancel: (() => void) | null;
}

function TargetForm({ serverId, label, initial, styles, onSave, onCancel }: TargetFormProps) {
  const [draft, setDraft] = useState(initial);
  const test = useMutation({ mutationFn: useRpc(testConnectionRpc) });
  const result = test.data;
  return (
    <View style={styles.card}>
      <Text style={styles.text}>Configure SSH target for {label}</Text>
      <Text style={styles.muted}>
        Forwarding uses your own SSH (keys, agent and ~/.ssh/config). Enter user@host or an alias
        from ~/.ssh/config. Password prompts are not supported.
      </Text>
      <SettingsInput
        label="SSH target"
        initialValue={initial}
        placeholder="ubuntu@gpu-box"
        onChangeText={setDraft}
        error={result && !result.ok ? result.error : null}
        {...(result?.ok ? { hint: `Verified: this is Paseo host ${result.remoteServerId}` } : {})}
      />
      <View style={styles.row}>
        <Button
          styles={styles}
          label={test.isPending ? "Testing…" : "Test connection"}
          disabled={!draft.trim() || test.isPending}
          onPress={() => test.mutate({ serverId, target: draft.trim() })}
        />
        <Button
          styles={styles}
          primary
          label="Save"
          disabled={!draft.trim()}
          onPress={() => void onSave(draft)}
        />
        {onCancel ? <Button styles={styles} label="Cancel" onPress={onCancel} /> : null}
      </View>
    </View>
  );
}

interface PortListProps {
  serverId: string;
  styles: Styles;
  theme: PluginTheme;
  onEditTarget(): void;
}

function PortList({ serverId, styles, theme, onEditTarget }: PortListProps) {
  const loadState = useRpc(stateRpc);
  const forward = useRpc(forwardRpc);
  const unforward = useRpc(unforwardRpc);
  const queryClient = useQueryClient();
  const queryKey = ["ports", serverId];
  const query = useQuery({
    queryKey,
    queryFn: () => loadState({ serverId }),
    refetchInterval: POLL_MS,
  });
  const agentTitles = useAgentTitles(serverId);
  const toggle = useMutation({
    mutationFn: async ({ port, on }: { port: number; on: boolean }) => {
      if (on) await forward({ serverId, remotePort: port });
      else await unforward({ serverId, remotePort: port });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const state = query.data;
  if (!state) {
    return (
      <View style={styles.card}>
        {query.error ? (
          <Text style={styles.danger}>{String(query.error)}</Text>
        ) : (
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        )}
      </View>
    );
  }

  const forwards = new Map(state.forwards.map((item) => [item.remotePort, item]));
  // Forwards whose remote port has closed stay listed so they can be stopped.
  const orphaned = state.forwards.filter(
    (item) => !state.ports.some((port) => port.port === item.remotePort),
  );

  return (
    <View style={styles.stack}>
      <SshHeader state={state} styles={styles} theme={theme} onEditTarget={onEditTarget} />
      {toggle.error ? <Text style={styles.danger}>{String(toggle.error)}</Text> : null}
      {state.ports.length === 0 && orphaned.length === 0 && !state.scanError ? (
        <View style={styles.card}>
          <Text style={styles.text}>No ports yet.</Text>
          <Text style={styles.muted}>
            This tab shows TCP ports opened by Paseo agents and terminals on this host. Start a dev
            server from an agent or a terminal and it appears here within a few seconds.
          </Text>
        </View>
      ) : null}
      {state.ports.map((port) => (
        <PortRow
          key={port.port}
          port={port}
          forward={forwards.get(port.port) ?? null}
          agentTitle={port.agentId ? (agentTitles[port.agentId] ?? null) : null}
          busy={toggle.isPending && toggle.variables?.port === port.port}
          styles={styles}
          theme={theme}
          onToggle={(on) => toggle.mutate({ port: port.port, on })}
        />
      ))}
      {orphaned.map((item) => (
        <PortRow
          key={`closed-${item.remotePort}`}
          port={null}
          forward={item}
          agentTitle={null}
          busy={toggle.isPending && toggle.variables?.port === item.remotePort}
          styles={styles}
          theme={theme}
          onToggle={() => toggle.mutate({ port: item.remotePort, on: false })}
        />
      ))}
    </View>
  );
}

function SshHeader({
  state,
  styles,
  theme,
  onEditTarget,
}: {
  state: PortsState;
  styles: Styles;
  theme: PluginTheme;
  onEditTarget(): void;
}) {
  const { ssh } = state;
  const color =
    ssh.state === "connected"
      ? theme.colors.statusSuccess
      : ssh.state === "error"
        ? theme.colors.statusDanger
        : theme.colors.statusWarning;
  const error = ssh.error ?? state.scanError;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.text}>
          SSH {ssh.state} · {ssh.target}
        </Text>
        <View style={styles.spacer} />
        <Button styles={styles} label="Change target" onPress={onEditTarget} />
      </View>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}

interface PortRowProps {
  port: RemotePort | null;
  forward: Forward | null;
  agentTitle: string | null;
  busy: boolean;
  styles: Styles;
  theme: PluginTheme;
  onToggle(on: boolean): void;
}

function PortRow({ port, forward, agentTitle, busy, styles, theme, onToggle }: PortRowProps) {
  const remotePort = port?.port ?? forward?.remotePort ?? 0;
  const url = forward ? `http://localhost:${forward.localPort}` : null;
  const active = forward?.status === "active";
  const dot = !forward
    ? theme.colors.border
    : active
      ? theme.colors.statusSuccess
      : theme.colors.statusDanger;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={styles.port}>{remotePort}</Text>
        <Text style={styles.muted}>{port ? port.bind : "closed on remote"}</Text>
        {url ? <Text style={styles.text}>→ localhost:{forward?.localPort}</Text> : null}
        {forward?.auto ? <Text style={styles.muted}>auto</Text> : null}
        <View style={styles.spacer} />
        {url && active ? (
          <>
            <Button styles={styles} label="Open" onPress={() => void openExternalUrl(url)} />
            {canCopy() ? (
              <Button styles={styles} label="Copy URL" onPress={() => void copyText(url)} />
            ) : null}
          </>
        ) : null}
        <Button
          styles={styles}
          primary={!forward}
          disabled={busy}
          label={busy ? "…" : forward ? "Stop" : "Forward"}
          onPress={() => onToggle(!forward)}
        />
      </View>
      {port ? (
        <Text style={styles.muted} numberOfLines={1}>
          {port.process} (pid {port.pid})
          {port.agentId ? ` · agent ${agentTitle ?? port.agentId.slice(0, 8)}` : " · terminal"}
          {port.cwd ? ` · ${port.cwd}` : ""}
        </Text>
      ) : null}
      {forward?.error ? <Text style={styles.danger}>{forward.error}</Text> : null}
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  primary,
  styles,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, primary && styles.buttonPrimary, disabled && styles.buttonDisabled]}
    >
      <Text style={primary ? styles.buttonPrimaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/** Agent titles on the remote host, best effort: ids still render if the host is offline. */
function useAgentTitles(serverId: string): Record<string, string> {
  const query = useQuery({
    queryKey: ["agent-titles", serverId],
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const result = await getPaseoClient(serverId).agents.list();
      const titles: Record<string, string> = {};
      for (const entry of result.entries) {
        if (entry.agent.title) titles[entry.agent.id] = entry.agent.title;
      }
      return titles;
    },
  });
  return query.data ?? {};
}
