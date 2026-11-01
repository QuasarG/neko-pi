import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DARK_THEMES, LIGHT_THEMES, THEME_INIT_SCRIPT, THEME_OPTIONS, isDarkTheme, isThemePreference } from "./theme.ts";

const REMOVED_STORED_VALUES = [null, "", "unknown", "auto", "mist", "lilac", "sand", "rose", "pine", "dusk", "ember", "slate", "contrast-light", "contrast-dark", "zenburn", new Error("Blocked")];

test("first paint restores the three modes and migrates removed palettes to system", () => {
  for (const systemDark of [false, true]) {
    for (const stored of [...THEME_OPTIONS.map(({ id }) => id), ...REMOVED_STORED_VALUES]) {
      const root = { dataset: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
      runInNewContext(THEME_INIT_SCRIPT, {
        localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: root },
      });
      const expected = isThemePreference(stored) && stored !== "system" ? stored : systemDark ? "dark" : "light";
      assert.equal(root.dataset.theme, expected);
      assert.equal(root.dark, isDarkTheme(expected));
    }
  }
});

test("exactly three modes; light and dark each belong to one set", () => {
  assert.deepEqual(THEME_OPTIONS.map(({ id }) => id), ["system", "light", "dark"]);
  assert.deepEqual(LIGHT_THEMES, ["light"]);
  assert.deepEqual(DARK_THEMES, ["dark"]);
  assert.equal(isThemePreference("system") && isThemePreference("light") && isThemePreference("dark"), true);
  assert.equal(isThemePreference("auto"), false);
});
