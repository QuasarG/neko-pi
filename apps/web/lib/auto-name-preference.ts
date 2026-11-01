const STORAGE_KEY = "pi-auto-name-sessions";

/**
 * R49 (user order): the "Generate title" button is gone — a session names
 * itself after its first query instead. The switch lives in Settings › Chat;
 * ON by default so the button's behaviour simply became automatic.
 */
export function isAutoNameSessionsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAutoNameSessionsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Nothing was saved; the current value stands.
  }
}
