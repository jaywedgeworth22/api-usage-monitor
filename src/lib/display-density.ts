"use client";

import { useEffect, useState } from "react";

/**
 * Global display-density preference: "comfortable" (today's look, and the
 * default so existing users see no change) vs "compact" (reduced row
 * padding/height, secondary detail lines collapsed - but never removed
 * outright, see each surface's `title`/`<details>` fallback).
 *
 * Persisted to localStorage under DISPLAY_DENSITY_STORAGE_KEY and mirrored
 * onto <html> as a `density-<value>` class (see the inline script in
 * layout.tsx, which applies the stored value before hydration to avoid a
 * flash of the wrong density, and Nav.tsx, which owns the visible toggle).
 */
export type DisplayDensity = "compact" | "comfortable";

export const DISPLAY_DENSITY_STORAGE_KEY = "display-density";
export const DISPLAY_DENSITY_DEFAULT: DisplayDensity = "comfortable";

/** Same-tab change notification - the browser's `storage` event only fires
 * in *other* tabs, so components reading the preference (ProviderTable,
 * ProviderCard, the provider detail page, ...) need this to react
 * immediately when Nav's toggle changes it in the current tab. */
const DISPLAY_DENSITY_EVENT = "display-density-change";

function isDisplayDensity(value: unknown): value is DisplayDensity {
  return value === "compact" || value === "comfortable";
}

/** Safe to call during SSR - returns the default without touching `window`. */
export function getStoredDisplayDensity(): DisplayDensity {
  if (typeof window === "undefined") return DISPLAY_DENSITY_DEFAULT;
  try {
    const stored = window.localStorage.getItem(DISPLAY_DENSITY_STORAGE_KEY);
    return isDisplayDensity(stored) ? stored : DISPLAY_DENSITY_DEFAULT;
  } catch {
    return DISPLAY_DENSITY_DEFAULT;
  }
}

/** Persists the preference, syncs the <html> class, and notifies other
 * mounted components in this tab via DISPLAY_DENSITY_EVENT. */
export function setStoredDisplayDensity(density: DisplayDensity): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISPLAY_DENSITY_STORAGE_KEY, density);
  } catch {
    // Private browsing / quota exceeded - the DOM class and in-memory state
    // below still update for this session, it just won't persist.
  }
  document.documentElement.classList.remove("density-compact", "density-comfortable");
  document.documentElement.classList.add(`density-${density}`);
  window.dispatchEvent(new CustomEvent(DISPLAY_DENSITY_EVENT, { detail: density }));
}

/**
 * Reads the current display-density preference. Always starts at
 * DISPLAY_DENSITY_DEFAULT ("comfortable") on the server and on first client
 * render - matching the pre-hydration DOM the inline layout.tsx script
 * produces for non-default cases only after that script runs - so React
 * never sees a server/client markup mismatch; the real stored value (if
 * any) is applied a moment later in the effect below, same pattern as
 * Nav.tsx's `mounted` flag elsewhere in this file tree.
 */
export function useDisplayDensity(): DisplayDensity {
  const [density, setDensity] = useState<DisplayDensity>(DISPLAY_DENSITY_DEFAULT);

  useEffect(() => {
    setDensity(getStoredDisplayDensity());

    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isDisplayDensity(detail)) setDensity(detail);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== DISPLAY_DENSITY_STORAGE_KEY) return;
      setDensity(isDisplayDensity(event.newValue) ? event.newValue : DISPLAY_DENSITY_DEFAULT);
    };

    window.addEventListener(DISPLAY_DENSITY_EVENT, handleChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(DISPLAY_DENSITY_EVENT, handleChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return density;
}
