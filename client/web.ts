import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const navigator: { clipboard?: { writeText(text: string): Promise<void> } } | undefined;

export function canCopy(): boolean {
  return Platform.OS === "web" && typeof navigator !== "undefined" && !!navigator?.clipboard;
}

export async function copyText(text: string): Promise<void> {
  await navigator?.clipboard?.writeText(text);
}
