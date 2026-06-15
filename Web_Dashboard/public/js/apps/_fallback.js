// Fallback per-app module for sessions whose appId doesn't resolve to a
// real module (either the headset didn't declare an appId at all, or the
// declared appId has no corresponding apps/<appId>.js file).
//
// Renders a small "no per-app controls available" notice so the focus
// panel isn't empty. The instructor can still use the generic command
// deck below this panel (pause / reset / change_environment / trigger).

export default {
  appId: '_fallback',
  displayName: 'Generic VR session',

  mount({ container, session }) {
    const appId = session?.appId ?? null;

    const root = document.createElement('div');
    root.className = 'focus-app-panel__fallback';

    const heading = document.createElement('h3');
    heading.className = 'command-deck__title';
    heading.textContent = appId ? `${appId} (no UI module)` : 'Generic VR session';
    root.appendChild(heading);

    const body = document.createElement('p');
    body.className = 'focus-app-panel__fallback-body';
    body.textContent = appId
      ? `No per-app dashboard module is registered for appId "${appId}". ` +
        `Use the generic controls below, or add ` +
        `Web_Dashboard/public/js/apps/${appId}.js to enable app-specific UI.`
      : `This session's headset did not declare an appId. Use the generic ` +
        `controls below.`;
    root.appendChild(body);

    container.appendChild(root);

    // No update() / unmount() — the message is static and the container
    // cleanup the loader does on unmount is sufficient.
    return {};
  },
};
