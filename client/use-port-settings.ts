import { useSettings } from "@getpaseo/plugin/client";
import { useCallback } from "react";

import { portSettings, type PortSettings } from "../shared/settings";

export function usePortSettings() {
  const state = useSettings(portSettings);
  const values = state.status === "ready" ? state.values : null;
  const revision = state.status === "ready" ? state.revision : null;

  const update = useCallback(
    async (patch: (current: PortSettings) => PortSettings) => {
      if (!values || revision === null) return false;
      return state.save(patch(values), revision);
    },
    [state, values, revision],
  );

  const setTarget = useCallback(
    (serverId: string, target: string) =>
      update((current) => {
        const targets = { ...current.targets };
        if (target.trim()) targets[serverId] = target.trim();
        else delete targets[serverId];
        return { ...current, targets };
      }),
    [update],
  );

  return { state, values, update, setTarget };
}
