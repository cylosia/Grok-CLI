export type ThemeName = "grok-neon" | "aider-dark" | "light" | "midnight";

export interface Theme {
  name: ThemeName;
  colors: {
    background: string;
    foreground: string;
    accent: string;
    success: string;
    error: string;
    muted: string;
  };
}

export const themes: Record<ThemeName, Theme> = {
  "grok-neon": {
    name: "grok-neon",
    colors: {
      background: "#0a0a0a",
      foreground: "#ffffff",
      accent: "#00f5ff",
      success: "#22ff88",
      error: "#ff4488",
      muted: "#666666"
    }
  },
  "aider-dark": {
    name: "aider-dark",
    colors: { /* perfect Aider match */ background: "#111111", ... }
  },
  // ... other themes
};

export function getTheme(name: ThemeName): Theme {
  return themes[name] || themes["grok-neon"];
}
