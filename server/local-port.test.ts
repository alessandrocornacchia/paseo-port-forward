import { describe, expect, it } from "vitest";

import { pickLocalPort } from "./local-port";

describe("pickLocalPort", () => {
  it("prefers the remote port number", async () => {
    expect(await pickLocalPort(3000, new Set(), async () => true)).toBe(3000);
  });

  it("falls back to the next free port", async () => {
    const busy = new Set([3000, 3001]);
    expect(await pickLocalPort(3000, new Set(), async (port) => !busy.has(port))).toBe(3002);
  });

  it("skips ports already handed to other forwards", async () => {
    expect(await pickLocalPort(3000, new Set([3000]), async () => true)).toBe(3001);
  });

  it("moves privileged ports above 1024", async () => {
    expect(await pickLocalPort(80, new Set(), async () => true)).toBe(1104);
  });
});
