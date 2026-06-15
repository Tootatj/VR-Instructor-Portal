// VR Fire Training — instructor dashboard panel (2026-06-15).
//
// State machine + command list documented in:
//   ../../../docs/state-updates.md#appid-vrft-vr-fire-training
//   ../../../docs/commands.md#appid-vrft-vr-fire-training
//
// States (published by the headset via EmitStateUpdate):
//   - boot            → "App initialising" placeholder
//   - hub             → level picker (level list comes from data.available_levels)
//   - level_loading   → "Loading <level>…" spinner
//   - level_active    → in-level controls (return to hub + live metadata)
//   - level_complete  → outcome summary + return-to-hub
//
// Commands sent by this panel (validated server-side in commands.js):
//   - load_level    { level_id: string }   — valid in hub / level_complete
//   - return_to_hub {}                     — valid in level_active / level_complete

export default {
  appId: 'VRFT',
  displayName: 'VR Fire Training',

  mount({ container, session, sendCommand, logCommand }) {
    // Single root element so update() can swap inner content without
    // disturbing the loader's container reference.
    const root = document.createElement('div');
    root.className = 'focus-app-panel__vrft';
    container.appendChild(root);

    const title = document.createElement('h3');
    title.className = 'command-deck__title';
    title.textContent = 'VR Fire Training';
    root.appendChild(title);

    const stateLabel = document.createElement('p');
    stateLabel.className = 'focus-app-panel__state-label';
    root.appendChild(stateLabel);

    const body = document.createElement('div');
    body.className = 'focus-app-panel__body';
    root.appendChild(body);

    // First render — current state may be null if the headset hasn't
    // emitted yet. renderState handles that case.
    renderState(session);

    function renderState(s) {
      const cs = s?.currentState ?? null;
      const stateName = cs?.name ?? null;
      const data = cs?.data ?? {};

      stateLabel.textContent = stateName
        ? `State: ${stateName}`
        : 'State: (waiting for first state update from headset…)';

      body.replaceChildren();

      if (!stateName) {
        const hint = document.createElement('p');
        hint.className = 'focus-app-panel__hint';
        hint.textContent =
          'The headset has not yet published a state. The level picker ' +
          'will appear once the user reaches the hub.';
        body.appendChild(hint);
        return;
      }

      switch (stateName) {
        case 'boot':
          renderBoot(body);
          break;
        case 'hub':
          renderHub(body, data, sendCommand, logCommand);
          break;
        case 'level_loading':
          renderLevelLoading(body, data);
          break;
        case 'level_active':
          renderLevelActive(body, data, sendCommand);
          break;
        case 'level_complete':
          renderLevelComplete(body, data, sendCommand);
          break;
        default:
          renderUnknown(body, stateName, data);
      }
    }

    return {
      update(updatedSession) {
        renderState(updatedSession);
      },
    };
  },
};

// ---------- per-state renderers --------------------------------------------

function renderBoot(body) {
  const p = document.createElement('p');
  p.className = 'focus-app-panel__hint';
  p.textContent = 'App is initialising on the headset. Hub controls will appear shortly.';
  body.appendChild(p);
}

function renderHub(body, data, sendCommand, logCommand) {
  const intro = document.createElement('p');
  intro.className = 'focus-app-panel__hint';
  intro.textContent = 'Trainee is in the hub. Select a scenario to load:';
  body.appendChild(intro);

  const levels = Array.isArray(data?.available_levels) ? data.available_levels : [];

  if (levels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'focus-app-panel__hint';
    empty.textContent =
      'The headset reported hub state but did not publish any available levels. ' +
      'Check that the VR app populates data.available_levels in its hub state update.';
    body.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'command-form';

  for (const level of levels) {
    // Defensive — the VR app could send malformed entries. Skip rather
    // than render an unclickable button.
    if (!level || typeof level.id !== 'string' || level.id.length === 0) continue;
    const displayName = typeof level.display_name === 'string' && level.display_name.length > 0
      ? level.display_name
      : level.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'command-btn';
    btn.dataset.levelId = level.id;
    btn.innerHTML = `
      <span class="command-btn__label">Load: ${escapeHtml(displayName)}</span>
      <span class="command-btn__hint">load_level · ${escapeHtml(level.id)}</span>
    `;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const ack = await sendCommand('load_level', { level_id: level.id });
      // The VR app's subsequent state-update will move us out of hub
      // automatically — but if the command was rejected (ack.ok false)
      // re-enable the button so the instructor can try again.
      if (!ack?.ok) {
        btn.disabled = false;
      }
    });
    list.appendChild(btn);
  }

  body.appendChild(list);
}

function renderLevelLoading(body, data) {
  const p = document.createElement('p');
  p.className = 'focus-app-panel__hint';
  const levelId = typeof data?.level_id === 'string' ? data.level_id : 'level';
  p.textContent = `Loading ${levelId}… The headset is preparing the scenario.`;
  body.appendChild(p);
}

function renderLevelActive(body, data, sendCommand) {
  const levelDisplay =
    (typeof data?.level_display_name === 'string' && data.level_display_name) ||
    (typeof data?.level_id === 'string' && data.level_id) ||
    'current level';

  const heading = document.createElement('p');
  heading.className = 'focus-app-panel__hint';
  heading.textContent = `Trainee is in: ${levelDisplay}`;
  body.appendChild(heading);

  // Optional in-level metadata published by the VR app (elapsed, step,
  // etc.). Render whatever's there as a small chip list — keeps the
  // panel useful even if the VR app's data shape evolves.
  const metaChips = buildMetadataChips(data, ['level_id', 'level_display_name']);
  if (metaChips) {
    body.appendChild(metaChips);
  }

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'command-btn';
  back.innerHTML = `
    <span class="command-btn__label">Return to hub</span>
    <span class="command-btn__hint">return_to_hub</span>
  `;
  back.addEventListener('click', async () => {
    back.disabled = true;
    const ack = await sendCommand('return_to_hub');
    if (!ack?.ok) back.disabled = false;
  });
  body.appendChild(back);
}

function renderLevelComplete(body, data, sendCommand) {
  const levelDisplay =
    (typeof data?.level_display_name === 'string' && data.level_display_name) ||
    (typeof data?.level_id === 'string' && data.level_id) ||
    'level';

  const outcome = typeof data?.outcome === 'string' ? data.outcome : 'completed';
  const heading = document.createElement('p');
  heading.className = 'focus-app-panel__hint';
  heading.textContent = `${levelDisplay}: ${outcome}`;
  body.appendChild(heading);

  const metaChips = buildMetadataChips(data, ['level_id', 'level_display_name', 'outcome']);
  if (metaChips) {
    body.appendChild(metaChips);
  }

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'command-btn';
  back.innerHTML = `
    <span class="command-btn__label">Return to hub</span>
    <span class="command-btn__hint">return_to_hub</span>
  `;
  back.addEventListener('click', async () => {
    back.disabled = true;
    const ack = await sendCommand('return_to_hub');
    if (!ack?.ok) back.disabled = false;
  });
  body.appendChild(back);
}

function renderUnknown(body, stateName, data) {
  const p = document.createElement('p');
  p.className = 'focus-app-panel__hint';
  p.textContent =
    `Unknown VRFT state "${stateName}". The VR app published a state ` +
    `this dashboard module doesn't recognise — likely a newer VRFT build. ` +
    `Update apps/VRFT.js to render this state, or add a default case.`;
  body.appendChild(p);

  // Surface the raw data so a developer debugging can see what's coming
  // through without diving into devtools.
  if (data && Object.keys(data).length > 0) {
    const pre = document.createElement('pre');
    pre.className = 'focus-app-panel__raw';
    pre.textContent = JSON.stringify(data, null, 2);
    body.appendChild(pre);
  }
}

// ---------- helpers --------------------------------------------------------

function buildMetadataChips(data, excludeKeys) {
  if (!data || typeof data !== 'object') return null;
  const exclude = new Set(excludeKeys);
  const entries = Object.entries(data).filter(([k, v]) =>
    !exclude.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  );
  if (entries.length === 0) return null;
  const wrap = document.createElement('p');
  wrap.className = 'focus-view__chips';
  for (const [k, v] of entries) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${k}: ${v}`;
    wrap.appendChild(chip);
  }
  return wrap;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
