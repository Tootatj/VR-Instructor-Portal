# Per-app dashboard modules

Each VR application that wants a custom instructor panel ships a module
in this directory named `<appId>.js`, where `<appId>` matches the
identifier the headset declares in `headset:register` (see
[`../../../docs/state-updates.md`](../../../docs/state-updates.md#application-identity)).

When an instructor opens a session's focus view, `_loader.js` looks up
the room's `appId` from the session metadata, dynamic-imports
`./<appId>.js`, mounts it into the `#focus-app-panel` container, and
forwards live `session:state-changed` events to the module's `update()`
hook. Sessions without an `appId` (or whose module fails to load) get
the [`_fallback.js`](./_fallback.js) panel — a small "no per-app UI"
notice that keeps the focus view non-empty.

## Module shape

Every per-app module is an ES module with a default export of this shape:

```js
// apps/VRFT.js
export default {
  // Required. Must match the appId declared in headset:register.
  appId: 'VRFT',

  // Optional. Used in the fallback panel + status logging. Defaults to appId.
  displayName: 'VR Fire Training',

  /**
   * Called ONCE when a session of this appId enters focus mode.
   * Set up DOM in the provided container and return a controller.
   *
   * @param {object} ctx
   * @param {HTMLElement} ctx.container - Empty container to render into.
   * @param {object}      ctx.session - The current session snapshot
   *                                    (code, appId, appVersion, currentState, ...).
   * @param {Function}    ctx.sendCommand - async (commandName, payload?) => ack.
   *                                        The current session's `code` is
   *                                        auto-injected; `command` is the
   *                                        passed name. Logs to the command
   *                                        log via ctx.logCommand for you.
   * @param {Function}    ctx.logCommand - (message, kind) => void. kind is
   *                                       'ok' | 'error' | 'info'.
   * @returns {{
   *   update?(session): void,   // Called when state-changed events arrive.
   *   unmount?(): void,         // Called when leaving focus or app switch.
   * }}
   */
  mount({ container, session, sendCommand, logCommand }) {
    // ... initial render ...

    return {
      update(updatedSession) {
        // re-render based on updatedSession.currentState
      },
      unmount() {
        // free timers / detach listeners (DOM cleanup is automatic).
      },
    };
  },
};
```

`update()` and `unmount()` are optional. If omitted, state changes simply
re-call `mount()` (DOM-replace strategy — fine for small panels) and
unmount tears down by replacing the container's children with nothing.

## Conventions

- **Use the existing CSS classes** (`command-btn`, `field`, `chip`, `status`, etc.) so the panel matches the dashboard's visual language. Add new classes only when truly app-specific.
- **Never directly call `socket.emit`** — always go through `ctx.sendCommand`. That function handles the `code` injection, the ack wait, the command-log entry, and the tenant-scope guarantee for you.
- **Don't store DOM references outside the controller closure.** A new mount call creates a new closure; stale references from a previous mount will leak.
- **Treat `session.currentState` as possibly null** on first mount. The headset may not have published any state yet when the instructor opens the tile — show a "Waiting for app state…" placeholder until the first `update()` call.
- **Don't subscribe to other socket events** from a per-app module. State changes arrive via `update()`; new server-emitted events (e.g. a future `session:event`) should be plumbed through the loader, not bypassed by per-app code.
- **Each VR app's command set lives in `Web_Dashboard/src/commands.js`'s `APP_COMMAND_VALIDATORS[appId]`** — the server validates every command against that map. A per-app module that emits a command not registered there will get rejected with an `unknown command` ack.

## Adding a new VR app

1. Document the state machine + command list in [`docs/state-updates.md`](../../../docs/state-updates.md#per-app-state-machine-conventions) and [`docs/commands.md`](../../../docs/commands.md#app-specific-commands).
2. Add the per-app validator block to `Web_Dashboard/src/commands.js`'s `APP_COMMAND_VALIDATORS`.
3. Create `<appId>.js` in this directory following the shape above.
4. Implement the VR-side state-update emissions + command handlers in the VR project.

No changes needed to `_loader.js`, `_fallback.js`, or `grid.js` — the
loader picks up new modules by appId automatically.

## See also

- [`../../../docs/state-updates.md`](../../../docs/state-updates.md) — wire protocol for the headset → server → web direction.
- [`../../../docs/commands.md`](../../../docs/commands.md) — wire protocol for the web → server → headset direction.
- [`_loader.js`](./_loader.js) — implementation of the dynamic load / mount / update / unmount lifecycle.
- [`_fallback.js`](./_fallback.js) — the default panel for unknown / missing appIds.
- [`VRFT.js`](./VRFT.js) — the first concrete per-app module; copy this as the starting point for a new app.
