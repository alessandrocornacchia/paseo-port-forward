import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { analyzeScan, connectHostFor, decodeProcAddress, parseScanOutput } from "./scan";

const fixture = readFileSync(new URL("./fixtures/linux-scan.txt", import.meta.url), "utf8");

describe("decodeProcAddress", () => {
  it("decodes IPv4 little-endian addresses", () => {
    expect(decodeProcAddress("tcp", "0100007F:0BB8")).toEqual({ address: "127.0.0.1", port: 3000 });
    expect(decodeProcAddress("tcp", "00000000:1A6F")).toEqual({ address: "0.0.0.0", port: 6767 });
  });

  it("decodes IPv6 wildcard, loopback and v4-mapped addresses", () => {
    expect(decodeProcAddress("tcp6", "00000000000000000000000000000000:1435")).toEqual({
      address: "::",
      port: 5173,
    });
    expect(decodeProcAddress("tcp6", "00000000000000000000000001000000:1F90")).toEqual({
      address: "::1",
      port: 8080,
    });
    expect(decodeProcAddress("tcp6", "0000000000000000FFFF00000100007F:0050")).toEqual({
      address: "127.0.0.1",
      port: 80,
    });
  });
});

describe("connectHostFor", () => {
  it("maps wildcard and loopback binds to loopback and keeps specific addresses", () => {
    expect(connectHostFor("0.0.0.0")).toBe("127.0.0.1");
    expect(connectHostFor("127.0.0.1")).toBe("127.0.0.1");
    expect(connectHostFor("::")).toBe("localhost");
    expect(connectHostFor("::1")).toBe("[::1]");
    expect(connectHostFor("10.0.0.5")).toBe("10.0.0.5");
  });
});

describe("analyzeScan on a real Linux remote", () => {
  const raw = parseScanOutput(fixture);

  it("parses every section", () => {
    expect(raw.complete).toBe(true);
    expect(raw.pidFile).toEqual({ pid: 29, serverId: "srv_RVCaSQhbaNyq", listen: "127.0.0.1:6767" });
    expect(raw.listen.map((socket) => socket.port).sort((a, b) => a - b)).toEqual([
      22, 22, 3000, 5173, 6767, 9999, 41665,
    ]);
  });

  it("keeps only ports opened under Paseo terminals and agents", () => {
    const { ports } = analyzeScan(raw);
    expect(ports.map((port) => port.port)).toEqual([3000, 5173]);
    expect(ports[0]).toMatchObject({ process: "python3", agentId: null, cwd: "/home/dev/proj" });
    expect(ports[1]).toMatchObject({
      bind: "::",
      connectHost: "localhost",
      agentId: "agent-fake-123",
      cwd: "/home/dev/proj",
    });
  });

  it("returns nothing without a pid file", () => {
    expect(analyzeScan({ ...raw, pidFile: null }).ports).toEqual([]);
  });

  it("drops output that never reached the end marker", () => {
    expect(parseScanOutput(fixture.replace("@end", "")).complete).toBe(false);
  });
});
