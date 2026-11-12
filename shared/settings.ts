import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_IGNORE_PORTS = [22, 5432, 6379];

const PortNumberSchema = z.number().int().min(1).max(65535);

export const FixedForwardSchema = z.object({
  remotePort: PortNumberSchema,
  localPort: PortNumberSchema,
});
export type FixedForward = z.infer<typeof FixedForwardSchema>;

export const PortSettingsSchema = z.object({
  /** Paseo host serverId → SSH destination (`user@host` or a `~/.ssh/config` alias). */
  targets: z.record(z.string(), z.string()).default({}),
  /** Paseo host serverId → persistent remote/local port mappings. */
  fixedForwards: z.record(z.string(), z.array(FixedForwardSchema)).default({}),
  autoForward: z.boolean().default(false),
  ignorePorts: z.array(PortNumberSchema).default(DEFAULT_IGNORE_PORTS),
  /** Background scan interval while auto-forwarding, in seconds. */
  pollSeconds: z.number().int().min(1).max(60).default(5),
});

export type PortSettings = z.output<typeof PortSettingsSchema>;

export const portSettings = defineSettings({
  id: "ports",
  scope: "host",
  version: 1,
  schema: PortSettingsSchema,
});

export function defaultPortSettings(): PortSettings {
  return PortSettingsSchema.parse({});
}

/** "22, 5432 6379" → [22, 5432, 6379]; anything that is not a valid port is dropped. */
export function parsePortList(text: string): number[] {
  const ports = text
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** "80:8080, 5173:5173" → typed mappings; invalid entries are dropped. */
export function parseFixedForwardList(text: string): FixedForward[] {
  const mappings = new Map<number, FixedForward>();
  for (const part of text.split(/[\s,]+/)) {
    const match = /^(\d+):(\d+)$/.exec(part);
    if (!match) continue;
    const remotePort = Number(match[1]);
    const localPort = Number(match[2]);
    if (![remotePort, localPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
      continue;
    }
    mappings.set(remotePort, { remotePort, localPort });
  }
  return [...mappings.values()].sort((a, b) => a.remotePort - b.remotePort);
}

export function formatFixedForwardList(mappings: FixedForward[]): string {
  return mappings.map(({ remotePort, localPort }) => `${remotePort}:${localPort}`).join(", ");
}
