/**
 * Per-host state: the SSH master, the last scan, and active forwards. Everything here
 * stays in this daemon's memory and is never sent to a remote host.
 */
import type { Forward, PortsState, RemotePort, SshStatus } from "../shared/contracts";
import { defaultPortSettings, type PortSettings } from "../shared/settings";
import { pickLocalPort } from "./local-port";
import { analyzeScan, parseScanOutput, SCAN_SCRIPT } from "./scan";
import { HostSession } from "./ssh";

/** A scan younger than this answers `state` without touching the remote. */
const SCAN_FRESH_MS = 1_500;
/** After a failed scan or connect, wait this long before trying again on a `state` call. */
const ERROR_RETRY_MS = 5_000;
/** Close a master nobody has looked at for this long, unless it carries forwards. */
const IDLE_MS = 120_000;
const MAX_BACKOFF_MS = 30_000;

interface HostEntry {
  serverId: string;
  session: HostSession | null;
  ssh: SshStatus;
  ports: RemotePort[];
  scannedAt: number | null;
  scanError: string | null;
  scanning: Promise<void> | null;
  connecting: Promise<void> | null;
  forwards: Map<number, Forward>;
  lastTouched: number;
  backoffMs: number;
  reconnectTimer: NodeJS.Timeout | null;
}

export class PortManager {
  private hosts = new Map<string, HostEntry>();
  private settings: PortSettings = defaultPortSettings();
  private timers: NodeJS.Timeout[] = [];
  private autoTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private ticking = false;

  constructor(private readonly log: (message: string) => void = console.log) {
    this.timers.push(setInterval(() => void this.reapIdle(), 15_000));
    this.scheduleTick();
  }

  applySettings(settings: PortSettings): void {
    const previous = this.settings;
    this.settings = settings;
    for (const entry of this.hosts.values()) {
      const target = settings.targets[entry.serverId]?.trim() || null;
      if (target !== entry.ssh.target) {
        this.log(`[port-forward] target for ${entry.serverId} changed to ${target ?? "(none)"}`);
        void this.closeHost(entry, target === null ? "unmapped" : "idle");
        entry.ssh = { ...entry.ssh, target, state: target ? "idle" : "unmapped", error: null };
      }
    }
    if (previous.pollSeconds !== settings.pollSeconds) this.scheduleTick();
    if (!previous.autoForward && settings.autoForward) void this.tick();
  }

  private entry(serverId: string): HostEntry {
    let entry = this.hosts.get(serverId);
    if (!entry) {
      const target = this.settings.targets[serverId]?.trim() || null;
      entry = {
        serverId,
        session: null,
        ssh: {
          state: target ? "idle" : "unmapped",
          target,
          error: null,
          remoteServerId: null,
        },
        ports: [],
        scannedAt: null,
        scanError: null,
        scanning: null,
        connecting: null,
        forwards: new Map(),
        lastTouched: Date.now(),
        backoffMs: 1_000,
        reconnectTimer: null,
      };
      this.hosts.set(serverId, entry);
    }
    return entry;
  }

  private ensureConnected(entry: HostEntry): Promise<void> {
    const target = entry.ssh.target;
    if (!target) return Promise.reject(new Error("No SSH target configured for this host"));
    if (entry.session?.running && entry.ssh.state === "connected") return Promise.resolve();
    if (entry.connecting) return entry.connecting;
    const session = new HostSession(entry.serverId, target);
    entry.session = session;
    entry.ssh = { ...entry.ssh, state: "connecting", error: null };
    entry.connecting = session
      .start()
      .then(async () => {
        if (this.disposed) {
          await session.stop();
          return;
        }
        entry.ssh = { ...entry.ssh, state: "connected", error: null };
        entry.backoffMs = 1_000;
        session.onExit((error) => this.onMasterExit(entry, session, error));
        this.log(`[port-forward] connected to ${target} for ${entry.serverId}`);
        await this.reapplyForwards(entry);
      })
      .catch((error: unknown) => {
        entry.session = null;
        entry.ssh = { ...entry.ssh, state: "error", error: message(error) };
        throw error;
      })
      .finally(() => {
        entry.connecting = null;
      });
    return entry.connecting;
  }

  private onMasterExit(entry: HostEntry, session: HostSession, error: string): void {
    if (entry.session !== session || this.disposed) return;
    entry.session = null;
    entry.ssh = { ...entry.ssh, state: "error", error: `Connection lost: ${error}` };
    for (const forward of entry.forwards.values()) {
      forward.status = "error";
      forward.error = "SSH connection lost; reconnecting";
    }
    this.log(`[port-forward] master for ${entry.serverId} exited: ${error}`);
    if (entry.forwards.size > 0 || this.settings.autoForward) this.scheduleReconnect(entry);
  }

  private scheduleReconnect(entry: HostEntry): void {
    if (entry.reconnectTimer || this.disposed) return;
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      this.ensureConnected(entry).catch(() => this.scheduleReconnect(entry));
    }, delay);
  }

  private async reapplyForwards(entry: HostEntry): Promise<void> {
    for (const forward of entry.forwards.values()) {
      try {
        await entry.session?.forward(forward.localPort, forward.connectHost, forward.remotePort);
        forward.status = "active";
        forward.error = null;
      } catch (error) {
        forward.status = "error";
        forward.error = message(error);
      }
    }
  }

  private scan(entry: HostEntry, force = false): Promise<void> {
    const freshFor = entry.scanError ? ERROR_RETRY_MS : SCAN_FRESH_MS;
    if (!force && entry.scannedAt && Date.now() - entry.scannedAt < freshFor) {
      return Promise.resolve();
    }
    if (entry.scanning) return entry.scanning;
    entry.scanning = (async () => {
      try {
        await this.ensureConnected(entry);
        const output = await entry.session!.exec(SCAN_SCRIPT);
        const raw = parseScanOutput(output);
        if (!raw.complete) throw new Error("Port scan output was truncated");
        const result = analyzeScan(raw);
        entry.ssh = { ...entry.ssh, remoteServerId: result.pidFile?.serverId ?? null };
        if (!result.pidFile) {
          throw new Error("No Paseo daemon found on the remote (~/.paseo/paseo.pid is missing)");
        }
        if (result.pidFile.serverId && result.pidFile.serverId !== entry.serverId) {
          entry.ports = [];
          throw new Error(
            `SSH target is Paseo host ${result.pidFile.serverId}, not ${entry.serverId}. ` +
              "Check the SSH target for this host.",
          );
        }
        entry.ports = result.ports;
        entry.scanError = null;
        await this.pruneClosed(entry);
      } catch (error) {
        entry.scanError = message(error);
      } finally {
        entry.scannedAt = Date.now();
        entry.scanning = null;
      }
    })();
    return entry.scanning;
  }

  /** Drop forwards, manual or auto, whose remote port no longer listens. Only after a good scan. */
  private async pruneClosed(entry: HostEntry): Promise<void> {
    const open = new Set(entry.ports.map((port) => port.port));
    for (const forward of [...entry.forwards.values()]) {
      if (open.has(forward.remotePort)) continue;
      this.log(`[port-forward] ${entry.serverId}: remote port ${forward.remotePort} closed`);
      await this.unforward(entry.serverId, forward.remotePort);
    }
  }

  private verified(entry: HostEntry): boolean {
    return entry.ssh.remoteServerId === entry.serverId;
  }

  async state(serverId: string): Promise<PortsState> {
    const entry = this.entry(serverId);
    entry.lastTouched = Date.now();
    if (entry.ssh.target) {
      // The first call waits for a result; later ones answer from the last scan and refresh behind.
      const pending = this.scan(entry);
      if (entry.scannedAt === null || entry.ssh.state === "idle") await pending;
    }
    return snapshot(entry);
  }

  async forward(serverId: string, remotePort: number, auto = false): Promise<Forward> {
    const entry = this.entry(serverId);
    entry.lastTouched = Date.now();
    const existing = entry.forwards.get(remotePort);
    if (existing?.status === "active") return { ...existing };
    await this.scan(entry, true);
    if (!this.verified(entry)) {
      throw new Error(entry.scanError ?? "The remote host's identity could not be verified");
    }
    const port = entry.ports.find((candidate) => candidate.port === remotePort);
    const connectHost = port?.connectHost ?? existing?.connectHost ?? "127.0.0.1";
    const taken = new Set<number>();
    for (const host of this.hosts.values()) {
      for (const forward of host.forwards.values()) taken.add(forward.localPort);
    }
    if (existing) taken.delete(existing.localPort);
    const localPort = existing?.localPort ?? (await pickLocalPort(remotePort, taken));
    const forward: Forward = {
      serverId,
      remotePort,
      connectHost,
      localPort,
      status: "active",
      error: null,
      auto,
    };
    try {
      await entry.session!.forward(localPort, connectHost, remotePort);
    } catch (error) {
      forward.status = "error";
      forward.error = message(error);
      if (!existing) throw error;
    }
    entry.forwards.set(remotePort, forward);
    this.log(
      `[port-forward] ${serverId}: localhost:${localPort} → ${connectHost}:${remotePort}${auto ? " (auto)" : ""}`,
    );
    return { ...forward };
  }

  async unforward(serverId: string, remotePort: number): Promise<boolean> {
    const entry = this.hosts.get(serverId);
    const forward = entry?.forwards.get(remotePort);
    if (!entry || !forward) return false;
    entry.forwards.delete(remotePort);
    if (entry.session?.running) {
      await entry.session
        .cancel(forward.localPort, forward.connectHost, forward.remotePort)
        .catch((error: unknown) => this.log(`[port-forward] cancel failed: ${message(error)}`));
    }
    this.log(`[port-forward] ${serverId}: stopped localhost:${forward.localPort}`);
    return true;
  }

  async testConnection(
    serverId: string,
    target?: string,
  ): Promise<{ ok: boolean; remoteServerId: string | null; error: string | null }> {
    const resolved = target?.trim() || this.settings.targets[serverId]?.trim();
    if (!resolved) return { ok: false, remoteServerId: null, error: "No SSH target configured" };
    const session = new HostSession(`${serverId}-test`, resolved);
    try {
      await session.start();
      const raw = parseScanOutput(await session.exec(SCAN_SCRIPT));
      const remoteServerId = raw.pidFile?.serverId ?? null;
      if (!raw.pidFile) {
        return { ok: false, remoteServerId, error: "Connected, but no Paseo daemon was found there" };
      }
      if (remoteServerId !== serverId) {
        return {
          ok: false,
          remoteServerId,
          error: `Connected, but that machine is Paseo host ${remoteServerId}, not ${serverId}`,
        };
      }
      return { ok: true, remoteServerId, error: null };
    } catch (error) {
      return { ok: false, remoteServerId: null, error: message(error) };
    } finally {
      await session.stop();
    }
  }

  /** Background scan, whether or not the Ports screen is open. */
  private scheduleTick(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    if (this.disposed) return;
    this.autoTimer = setInterval(() => void this.tick(), this.settings.pollSeconds * 1000);
  }

  /**
   * Every host with forwards is rescanned so closed remote ports drop their forward (see
   * `pruneClosed`); with auto-forward on, every host with a target is scanned and new ports
   * are forwarded.
   */
  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      const auto = this.settings.autoForward;
      const ignore = new Set(this.settings.ignorePorts);
      const serverIds = new Set([...this.hosts.values()].filter((e) => e.forwards.size > 0).map((e) => e.serverId));
      if (auto) {
        for (const [serverId, target] of Object.entries(this.settings.targets)) {
          if (target.trim()) serverIds.add(serverId);
        }
      }
      for (const serverId of serverIds) {
        const entry = this.entry(serverId);
        // A dropped master is the reconnect timer's job; don't spawn ssh here for manual-only hosts.
        if (!auto && !entry.session?.running) continue;
        await this.scan(entry);
        if (!auto || !this.verified(entry) || entry.scanError) continue;
        for (const port of entry.ports) {
          if (ignore.has(port.port) || entry.forwards.has(port.port)) continue;
          await this.forward(serverId, port.port, true).catch((error: unknown) =>
            this.log(`[port-forward] auto-forward of ${port.port} failed: ${message(error)}`),
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const entry of this.hosts.values()) {
      if (!entry.session?.running || entry.forwards.size > 0 || this.settings.autoForward) continue;
      if (now - entry.lastTouched < IDLE_MS) continue;
      this.log(`[port-forward] closing idle connection for ${entry.serverId}`);
      await this.closeHost(entry, "idle");
    }
  }

  private async closeHost(entry: HostEntry, state: SshStatus["state"]): Promise<void> {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    const session = entry.session;
    entry.session = null;
    if (session) {
      for (const forward of entry.forwards.values()) {
        await session
          .cancel(forward.localPort, forward.connectHost, forward.remotePort)
          .catch(() => {});
      }
      await session.stop();
    }
    entry.forwards.clear();
    entry.ports = [];
    entry.scannedAt = null;
    entry.ssh = { ...entry.ssh, state, error: null, remoteServerId: null };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    if (this.autoTimer) clearInterval(this.autoTimer);
    await Promise.all([...this.hosts.values()].map((entry) => this.closeHost(entry, "idle")));
    this.hosts.clear();
  }

  /** For process exit, where nothing async runs. */
  killAll(): void {
    for (const entry of this.hosts.values()) entry.session?.killNow();
  }
}

function snapshot(entry: HostEntry): PortsState {
  return {
    ssh: { ...entry.ssh },
    ports: entry.ports.map((port) => ({ ...port })),
    forwards: [...entry.forwards.values()].map((forward) => ({ ...forward })),
    scannedAt: entry.scannedAt ? new Date(entry.scannedAt).toISOString() : null,
    scanError: entry.scanError,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
