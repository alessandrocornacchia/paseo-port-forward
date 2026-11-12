/**
 * Paseo plugin contract: runs the server entry against a fake host typed as the SDK's own
 * `PluginServerContext`, so `npm run typecheck` flags SDK contract drift and the assertions
 * flag a plugin that no longer registers what the client expects.
 */
import type { SettingsDefinition } from "@getpaseo/plugin";
import type {
  PluginHandlerContext,
  PluginServerContext,
  PluginSettings,
  PluginSettingsState,
} from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZodType, output as ZodOutput } from "zod";

import contribute from "../index.server";
import { pingRpc, stateRpc } from "../shared/contracts";
import { portSettings } from "../shared/settings";

// The real sweep kills ssh masters under /tmp/paseo-pf-<uid>, including a live plugin's.
vi.mock("../server/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/ssh")>()),
  sweepStaleSockets: vi.fn(async () => {}),
}));

/**
 * The slice of the host API this plugin uses. Typing the fake against it (instead of the whole
 * `PluginServerContext`) keeps additive SDK changes from breaking the test, while a removed or
 * changed `registerSettings`/`handle` still fails typecheck. Anything else throws at runtime.
 */
type UsedHost = Pick<PluginServerContext, "registerSettings" | "handle">;
type Handler = (input: unknown, context: PluginHandlerContext) => unknown;

function fakeHost() {
  const settings: Parameters<UsedHost["registerSettings"]>[0][] = [];
  const listeners = new Set<(state: PluginSettingsState<ZodType>) => void | Promise<void>>();
  const handlers = new Map<string, { input: ZodType; handler: Handler }>();

  const used: UsedHost = {
    registerSettings<Schema extends ZodType>(
      definition: SettingsDefinition<Schema>,
    ): PluginSettings<Schema> {
      settings.push(definition);
      const state: PluginSettingsState<Schema> = {
        status: "ready",
        revision: "1",
        values: definition.schema.parse({}),
      };
      return {
        read: async () => state,
        subscribe(listener) {
          const wrapped = listener as (state: PluginSettingsState<ZodType>) => void;
          listeners.add(wrapped);
          return () => void listeners.delete(wrapped);
        },
      };
    },
    handle(contract, handler) {
      expect(handlers.has(contract.name), `duplicate handler ${contract.name}`).toBe(false);
      handlers.set(contract.name, { input: contract.input, handler: handler as Handler });
    },
  };
  const server = new Proxy(used, {
    get(target, key) {
      if (key in target) return target[key as keyof UsedHost];
      return () => {
        throw new Error(`unexpected host API call: ${String(key)}`);
      };
    },
  }) as PluginServerContext;

  /** Calls a registered handler the way the host does: validated input in, validated output out. */
  async function call<C extends { name: string; output: ZodType }>(contract: C, input: unknown) {
    const entry = handlers.get(contract.name);
    if (!entry) throw new Error(`no handler for ${contract.name}`);
    const context = {} as PluginHandlerContext; // no handler here touches `paseo`
    const output = await entry.handler(entry.input.parse(input), context);
    return contract.output.parse(output) as ZodOutput<C["output"]>;
  }

  return { server, settings, listeners, handlers, call };
}

describe("paseo server contract", () => {
  let cleanup: (() => void | Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("registers the port settings and every RPC the client calls", async () => {
    const host = fakeHost();
    cleanup = contribute(host.server);

    expect(typeof cleanup).toBe("function");
    expect(host.settings).toEqual([portSettings]);
    expect(host.listeners.size).toBe(1);
    expect([...host.handlers.keys()].sort()).toEqual([
      "ports.forward",
      "ports.ping",
      "ports.state",
      "ports.test-connection",
      "ports.unforward",
    ]);
  });

  it("answers ping and state with outputs that match their contracts", async () => {
    const host = fakeHost();
    cleanup = contribute(host.server);

    expect(await host.call(pingRpc, {})).toMatchObject({ pong: true, pid: process.pid });

    const state = await host.call(stateRpc, { serverId: "srv-1" });
    expect(state.ssh).toEqual({ state: "unmapped", target: null, error: null, remoteServerId: null });
    expect(state.ports).toEqual([]);
    expect(state.forwards).toEqual([]);
  });

  it("unsubscribes from settings on cleanup", async () => {
    const host = fakeHost();
    const dispose = contribute(host.server);
    await dispose();
    expect(host.listeners.size).toBe(0);
  });
});
