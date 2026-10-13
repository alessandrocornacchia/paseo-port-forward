import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet } from "react-native";

export function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 16 : 24, gap: 12, maxWidth: 960 },
    stack: { gap: 8 },
    title: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
    text: { color: colors.foreground, fontSize: 14 },
    muted: { color: colors.foregroundMuted, fontSize: 13 },
    danger: { color: colors.statusDanger, fontSize: 13 },
    port: { color: colors.foreground, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
    card: {
      gap: 6,
      padding: 12,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
    },
    row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    spacer: { flexGrow: 1 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { color: colors.foreground, fontSize: 13 },
    chipTextActive: { color: colors.accentForeground, fontSize: 13 },
    button: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 6,
      backgroundColor: colors.surface2,
    },
    buttonPrimary: { backgroundColor: colors.accent },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.foreground, fontSize: 13 },
    buttonPrimaryText: { color: colors.accentForeground, fontSize: 13 },
  });
}

export type Styles = ReturnType<typeof makeStyles>;
