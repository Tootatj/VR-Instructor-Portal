// Per-app dashboard module loader (2026-06-15).
//
// Owns the lifecycle for the focused session's per-app panel. Called by
// grid.js on focus enter / state-changed / focus exit; isolates the
// per-app concerns from the rest of grid.js so that file doesn't grow
// every time a new VR app gets a custom dashboard.
//
// Loader contract + per-app module shape: see ./README.md.

import fallbackModule from './_fallback.js';

// Cache of resolved per-app modules keyed by appId. ES dynamic import is
// already cached by the browser, but we also cache the resolved module
// reference so we don't re-await the same import on every focus switch.
const moduleCache = new Map();

// Active controller (returned by the current per-app module's mount()).
// Exactly one controller at a time — focus is single-session.
let activeController = null;
let activeAppId = null;     // for diagnostics + same-app-no-remount optimisation
let activeContainer = null; // remembered for unmount cleanup

/**
 * Mount a per-app panel for a session entering focus mode.
 *
 * @param {object} args
 * @param {HTMLElement} args.container - The #focus-app-panel element.
 * @param {object}      args.session - Session snapshot (code, appId, currentState, ...).
 * @param {Function}    args.sendCommand - async (command, payload?) => ack
 *                                         from grid.js; code already wired.
 * @param {Function}    args.logCommand - (message, kind) => void.
 */
export async function mountAppPanel({ container, session, sendCommand, logCommand }) {
  // Always tear down any previous mount before starting a new one (focus
  // could in theory switch directly between two different appIds via the
  // back-button → other-tile flow; safer to never leak a stale controller).
  unmountAppPanel();

  activeContainer = container;
  const appId = session?.appId ?? null;

  // Load the per-app module (or fallback). Errors during import or mount
  // collapse cleanly to the fallback so a single broken module never
  // breaks the dashboard.
  let mod;
  try {
    mod = await resolveModule(appId);
  } catch (err) {
    console.warn(`[apps] failed to load module for appId="${appId}"`, err);
    mod = fallbackModule;
  }

  try {
    container.replaceChildren(); // safety — empty before mount
    activeController = mod.mount({ container, session, sendCommand, logCommand }) ?? {};
    activeAppId = mod.appId ?? appId ?? '(none)';
    console.log(`[apps] mounted ${activeAppId} for code=${session?.code}`);
  } catch (err) {
    console.error(`[apps] module "${appId}" mount() threw — falling back`, err);
    container.replaceChildren();
    activeController = fallbackModule.mount({ container, session, sendCommand, logCommand }) ?? {};
    activeAppId = '_fallback';
  }
}

/**
 * Forward a live state-update to the active per-app module. If the
 * module didn't expose update(), no-op (some modules render once and
 * don't need live updates).
 */
export function updateAppPanel(updatedSession) {
  if (!activeController) return;
  if (typeof activeController.update !== 'function') return;
  try {
    activeController.update(updatedSession);
  } catch (err) {
    console.error(`[apps] ${activeAppId}.update() threw`, err);
    // We intentionally don't auto-fallback here — the module is already
    // mounted and partially functional; tearing it down on a single
    // update() failure is more disruptive than the original error.
  }
}

/**
 * Tear down the active controller. Idempotent; safe to call without a
 * prior mount.
 */
export function unmountAppPanel() {
  if (activeController) {
    try {
      if (typeof activeController.unmount === 'function') {
        activeController.unmount();
      }
    } catch (err) {
      console.warn(`[apps] ${activeAppId}.unmount() threw — continuing`, err);
    }
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
  }
  activeController = null;
  activeAppId = null;
  activeContainer = null;
}

// ---------- module resolution ----------------------------------------------

async function resolveModule(appId) {
  if (!appId) return fallbackModule;

  // Guard against path-traversal / weird characters before constructing the
  // import URL. The server already enforces APP_ID_PATTERN on register; this
  // is defence-in-depth in case a malformed session object somehow leaks
  // through (e.g. a future bug in listSessionsForTenant).
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(appId)) {
    console.warn(`[apps] rejecting malformed appId "${appId}" — using fallback`);
    return fallbackModule;
  }

  if (moduleCache.has(appId)) {
    return moduleCache.get(appId);
  }

  // Dynamic import — relative to this file's URL. Browsers resolve to
  // /js/apps/<appId>.js. A 404 throws an SyntaxError-shaped error from
  // the import; we catch it in the caller and fall back.
  const mod = await import(`./${appId}.js`);
  const def = mod?.default;
  if (!def || typeof def.mount !== 'function') {
    throw new Error(`module ${appId}.js has no default export with mount()`);
  }
  moduleCache.set(appId, def);
  return def;
}
