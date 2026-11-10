import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Forward } from "../shared/contracts";
import { defaultPortSettings, type PortSettings } from "../shared/settings";
import { PortManager } from "./manager";
import type { HostSession } from "./ssh";

const fixture = readFileSync(new URL("./fixtures/linux-scan.txt", import.meta.url), "utf8");

interface ForwardCall {
  localPort: number;
  connectHost: string;
  remotePort: number;
}

class FakeHostSession {
  running = false;
  readonly forwardCalls: ForwardCall[] = [];
  readonly cancelCalls: ForwardCall[] = [];
  private exitListener: ((error: string) => void) | null = null;

  constructor(
    readonly serverId: string,
    readonly target: string,
    private readonly scanOutput: string,
  ) {}

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  onExit(listener: (error: string) => void): () => void {
    this.exitListener = listener;
    return () => {
      this.exitListener = null;
    };
  }

  simulateExit(error: string): void {
    this.running = false;
    this.exitListener?.(error);
  }

  async exec(): Promise<string> {
    return this.scanOutput;
  }

  async forward(localPort: number, connectHost: string, remotePort: number): Promise<void> {
    this.forwardCalls.push({ localPort, connectHost, remotePort });
  }

  async cancel(localPort: number, connectHost: string, remotePort: number): Promise<void> {
    this.cancelCalls.push({ localPort, connectHost, remotePort });
  }

  killNow(): void {
    this.running = false;
  }
}

const managers: PortManager[] = [];

function createManager(): { manager: PortManager; sessions: FakeHostSession[] } {
  const sessions: FakeHostSession[] = [];
  const manager = new PortManager(
    () => {},
    (serverId, target) => {
      const session = new FakeHostSession(
        serverId,
        target,
        fixture.replaceAll("srv_RVCaSQhbaNyq", "host-a"),
      );
      sessions.push(session);
      return session as unknown as HostSession;
    },
  );
  managers.push(manager);
  return { manager, sessions };
}

function settings(fixedForwards: PortSettings["fixedForwards"]): PortSettings {
  return {
    ...defaultPortSettings(),
    targets: { "host-a": "dev@example" },
    fixedForwards,
  };
}

function forward(state: { forwards: Forward[] }, remotePort: number): Forward {
  const result = state.forwards.find((candidate) => candidate.remotePort === remotePort);
  if (!result) throw new Error(`Missing forward for remote port ${remotePort}`);
  return result;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.useRealTimers();
});

describe("fixed forwards", () => {
  it("forwards an unscanned Docker port to the exact local port and survives pruning", async () => {
    vi.useFakeTimers();
    const { manager, sessions } = createManager();
    manager.applySettings(settings({ "host-a": [{ remotePort: 80, localPort: 8080 }] }));
    await manager.reconcileNow();

    let state = await manager.state("host-a");
    expect(state.ports.some((port) => port.port === 80)).toBe(false);
    expect(forward(state, 80)).toMatchObject({
      localPort: 8080,
      connectHost: "127.0.0.1",
      status: "active",
      auto: false,
      fixed: true,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await manager.reconcileNow();
    state = await manager.state("host-a");
    expect(forward(state, 80).status).toBe("active");
    expect(sessions[0]?.forwardCalls).toEqual([
      { localPort: 8080, connectHost: "127.0.0.1", remotePort: 80 },
    ]);
  });

  it("reapplies the exact fixed mapping after the SSH master reconnects", async () => {
    vi.useFakeTimers();
    const { manager, sessions } = createManager();
    manager.applySettings(settings({ "host-a": [{ remotePort: 80, localPort: 8080 }] }));
    await manager.reconcileNow();
    expect(sessions).toHaveLength(1);

    sessions[0]?.simulateExit("master exited");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.forwardCalls).toEqual([
      { localPort: 8080, connectHost: "127.0.0.1", remotePort: 80 },
    ]);
    expect(forward(await manager.state("host-a"), 80)).toMatchObject({
      localPort: 8080,
      status: "active",
      fixed: true,
    });
  });

  it("reports a local-port conflict without stealing the conflicting forward", async () => {
    const { manager, sessions } = createManager();
    manager.applySettings(
      settings({
        "host-a": [
          { remotePort: 80, localPort: 8080 },
          { remotePort: 5173, localPort: 8080 },
        ],
      }),
    );
    await manager.reconcileNow();

    const state = await manager.state("host-a");
    expect(forward(state, 80)).toMatchObject({ localPort: 8080, status: "active" });
    expect(forward(state, 5173)).toMatchObject({
      localPort: 8080,
      status: "error",
      error: expect.stringContaining("Local port 8080"),
    });
    expect(sessions[0]?.forwardCalls).toEqual([
      { localPort: 8080, connectHost: "127.0.0.1", remotePort: 80 },
    ]);
    expect(sessions[0]?.cancelCalls).toEqual([]);
  });

  it("cancels the obsolete forward when a fixed mapping changes", async () => {
    const { manager, sessions } = createManager();
    manager.applySettings(settings({ "host-a": [{ remotePort: 80, localPort: 8080 }] }));
    await manager.reconcileNow();

    manager.applySettings(settings({ "host-a": [{ remotePort: 5173, localPort: 5173 }] }));
    await manager.reconcileNow();

    const state = await manager.state("host-a");
    expect(state.forwards).toHaveLength(1);
    expect(forward(state, 5173)).toMatchObject({ localPort: 5173, status: "active", fixed: true });
    expect(sessions[0]?.cancelCalls).toEqual([
      { localPort: 8080, connectHost: "127.0.0.1", remotePort: 80 },
    ]);
  });

  it("cancels a removed fixed mapping", async () => {
    const { manager, sessions } = createManager();
    manager.applySettings(settings({ "host-a": [{ remotePort: 80, localPort: 8080 }] }));
    await manager.reconcileNow();

    manager.applySettings(settings({}));
    await manager.reconcileNow();

    const state = await manager.state("host-a");
    expect(state.forwards).toEqual([]);
    expect(sessions[0]?.cancelCalls).toEqual([
      { localPort: 8080, connectHost: "127.0.0.1", remotePort: 80 },
    ]);
  });
});
