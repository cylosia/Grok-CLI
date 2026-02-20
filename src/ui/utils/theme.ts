/**
 * Grok CLI v2.0 Theming System
 * Central theme engine with semantic tokens
 * Supports hot-reloading and command palette switching
 */

export type ThemeName = "grok-neon" | "aider-dark" | "light" | "midnight";

export interface ThemeColors {
  background: string;
  foreground: string;
  accent: string;
  success: string;
  error: string;
  muted: string;
  border: string;
  selection: string;
}

export interface Theme {
  name: ThemeName;
  displayName: string;
  colors: ThemeColors;
  isDark: boolean;
}

export const themes: Record<ThemeName, Theme> = {
  "grok-neon": {
    name: "grok-neon",
    displayName: "Grok Neon",
    isDark: true,
    colors: {
      background: "#0a0a0a",
      foreground: "#ffffff",
      accent: "#00f5ff",
      success: "#22ff88",
      error: "#ff4488",
      muted: "#888888",
      border: "#333333",
      selection: "#00f5ff33"
    }
  },

  "aider-dark": {
    name: "aider-dark",
    displayName: "Aider Dark",
    isDark: true,
    colors: {
      background: "#111111",
      foreground: "#eeeeee",
      accent: "#00ccff",
      success: "#44ffaa",
      error: "#ff5555",
      muted: "#777777",
      border: "#444444",
      selection: "#00ccff33"
    }
  },

  "midnight": {
    name: "midnight",
    displayName: "Midnight",
    isDark: true,
    colors: {
      background: "#0f172a",
      foreground: "#e2e8f0",
      accent: "#67e8f9",
      success: "#86efac",
      error: "#f87171",
      muted: "#64748b",
      border: "#334155",
      selection: "#67e8f933"
    }
  },

  "light": {
    name: "light",
    displayName: "Light",
    isDark: false,
    colors: {
      background: "#fafafa",
      foreground: "#111111",
      accent: "#0066ff",
      success: "#008800",
      error: "#cc0000",
      muted: "#666666",
      border: "#dddddd",
      selection: "#0066ff22"
    }
  }
};

export function getTheme(name: ThemeName): Theme {
  return themes[name] || themes["grok-neon"];
}

export function getThemeByDisplayName(displayName: string): Theme | undefined {
  return Object.values(themes).find(t => t.displayName === displayName);
}
