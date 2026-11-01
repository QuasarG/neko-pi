// ZCode parity: exactly three modes — follow the system, light, dark. The old
// optional palettes (mist, rose, pine, …) are gone; a stored value naming one
// of them falls back to system at first paint and on every later read.
export const THEME_OPTIONS = [
  { id: "system", label: "settings.themeSystem", scheme: null },
  { id: "light", label: "settings.themeLight", scheme: "light" },
  { id: "dark", label: "settings.themeDark", scheme: "dark" },
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]["id"];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const LIGHT_THEMES: readonly ResolvedTheme[] = THEME_OPTIONS.flatMap((option) => (option.scheme === "light" ? [option.id] : []));
export const DARK_THEMES: readonly ResolvedTheme[] = THEME_OPTIONS.flatMap((option) => (option.scheme === "dark" ? [option.id] : []));

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_OPTIONS.some((option) => option.id === value);
}

export function isDarkTheme(theme: ResolvedTheme): boolean {
  return DARK_THEMES.includes(theme);
}

// Apply the saved mode before first paint, including when storage is blocked.
// A removed palette ("mist", the old "auto", anything unknown) resolves as system.
export const THEME_INIT_SCRIPT = `(function(){var t="system";try{var s=localStorage.getItem("pi-theme");if(${JSON.stringify(THEME_OPTIONS.map((option) => option.id))}.includes(s))t=s}catch(e){}if(t==="system")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.classList.toggle("dark",${JSON.stringify(DARK_THEMES)}.includes(t))})();`;
