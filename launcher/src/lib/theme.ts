// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

export type ThemeId = "neon-aurora" | "emerald" | "inferno" | "stealth" | "deep-ocean" | "void";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  tagline: string;
  logo: string;
  primaryColor: string;
  swatches: string[];
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "neon-aurora",
    name: "Neon Aurora",
    tagline: "Signature cosmic violet & teal aurora glow",
    logo: "/themes/neon-aurora.png",
    primaryColor: "#8b5cf6",
    swatches: ["#8b5cf6", "#a855f7", "#38bdf8", "#00f5d4"],
  },
  {
    id: "emerald",
    name: "Emerald",
    tagline: "Verdant jade radiance, bioluminescent flora & crystalline emerald",
    logo: "/themes/emerald.png",
    primaryColor: "#00C878",
    swatches: ["#39FFAA", "#00C878", "#008F5B", "#00513D", "#002D25"],
  },
  {
    id: "inferno",
    name: "Inferno",
    tagline: "Solar flare, molten amber & volcanic crimson",
    logo: "/themes/inferno.png",
    primaryColor: "#ff6500",
    swatches: ["#ffe600", "#ffb000", "#ff6500", "#e60012", "#ff1744"],
  },
  {
    id: "stealth",
    name: "Stealth",
    tagline: "Matte carbon, brushed titanium & sleek monochrome",
    logo: "/themes/stealth.png",
    primaryColor: "#e5e7eb",
    swatches: ["#e5e7eb", "#9ca3af", "#3a3f46", "#17191d", "#08090b"],
  },
  {
    id: "deep-ocean",
    name: "Deep Ocean",
    tagline: "Abyssal cobalt, neon electric blue & azure depth",
    logo: "/themes/deep-ocean.png",
    primaryColor: "#0066ff",
    swatches: ["#00d9ff", "#0066ff", "#102a72"],
  },
  {
    id: "void",
    name: "Void",
    tagline: "Astral nebula, ultraviolet pulse & dimensional rift",
    logo: "/themes/void.png",
    primaryColor: "#c026ff",
    swatches: ["#f03cff", "#c026ff", "#7b2cff", "#32105f"],
  },
];

export function getThemeDefinition(id?: string): ThemeDefinition {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function getThemeLogo(id?: string): string {
  return getThemeDefinition(id).logo;
}
