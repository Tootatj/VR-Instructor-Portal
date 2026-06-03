// OneBonsai grid view — Phase 4.5.
//
// Two modes:
//   - Grid mode: 3×2 tiles of the current page of sessions for this tenant.
//     Only the visible page is actually subscribed to Agora video (the
//     "subscribe-only-visible" optimisation from the conceptual chat). Audio
//     is not subscribed in grid mode — would be a cacophony.
//   - Focus mode: one session expanded fills the stage, side panel shows
//     command deck. Audio is subscribed in focus mode (and the instructor
//     mic may publish on demand).
//
// Architecture:
//   - One Agora client per visible tile + one for the focused session. Each
//     client joins its own channel. This is the multi-channel pattern from
//     the conceptual chat.
//   - Sessions list comes from `/api/sessions` on first load, then live via
//     `sessions:changed` over Socket.IO.
//   - Tokens are minted per-channel via `POST /api/token`.

// ---------- state -----------------------------------------------------------
const PAGE_SIZE = 6;

const state = {
  appId: null,
  tenantId: null,
  sessions: [],          // full list, server-sorted by startedAt asc
  currentPage: 1,
  tileClients: new Map(),  // code -> { client, videoTrack, videoMount, durationTimer }
  focused: null,           // { code, client, videoTrack, audioTrack, micTrack? }
};

// ---------- DOM refs --------------------------------------------------------
const connIndicator    = document.getElementById('conn-indicator');
const sessionCountEl   = document.getElementById('session-count');
const tileGridEl       = document.getElementById('tile-grid');
const emptyStateEl     = document.getElementById('empty-state');
const prevBtn          = document.getElementById('prev-page-btn');
const nextBtn          = document.getElementById('next-page-btn');
const pageIndicator    = document.getElementById('page-indicator');

const gridView         = document.getElementById('grid-view');
const focusView        = document.getElementById('focus-view');
const focusVideoMount  = document.getElementById('focus-video');
const focusStatus      = document.getElementById('focus-status');
const focusScenario    = document.getElementById('focus-scenario');
const focusTrainee     = document.getElementById('focus-trainee');
const focusCode        = document.getElementById('focus-code');
const focusDuration    = document.getElementById('focus-duration');
const focusSource      = document.getElementById('focus-source');
const backBtn          = document.getElementById('back-to-grid-btn');

const speakerToggle    = document.getElementById('speaker-toggle');
const micToggle        = document.getElementById('mic-toggle');
const volumeSlider     = document.getElementById('volume-slider');
const volumeValue      = document.getElementById('volume-value');

const commandLog       = document.getElementById('command-log');

// ---------- boot ------------------------------------------------------------
boot().catch((err) => {
  console.error('[grid] boot failed', err);
  setConn('error', `Boot failed: ${err.message ?? err}`);
});

async function boot() {
  setConn('connecting', 'Loading config…');
  const cfg = await fetch('/api/config').then(r => r.json());
  state.appId = cfg.appId;
  state.tenantId = cfg.defaultTenantId;
  if (!state.appId) {
    setConn('error', 'AGORA_APP_ID missing on server (.env)');
    return;
  }

  // Initial sessions list via REST (works even before socket connects).
  const initial = await fetch(
    `/api/sessions?tenantId=${encodeURIComponent(state.tenantId)}&page=1&pageSize=999`
  ).then(r => r.json());
  state.sessions = initial.sessions ?? [];

  // Then connect Socket.IO for live updates.
  setConn('connecting', 'Connecting to signaling…');
  const socket = io({ path: '/socket.io' });
  socket.on('connect', async () => {
    const ack = await emitWithAck(socket, 'instructor:subscribe-tenant', {
      tenantId: state.tenantId,
    });
    if (!ack?.ok) {
      setConn('error', `subscribe failed: ${ack?.error ?? 'unknown'}`);
      return;
    }
    state.sessions = ack.sessions ?? state.sessions;
    setConn('connected', `Live · tenant ${state.tenantId}`);
    rerender();
  });
  socket.on('sessions:changed', ({ sessions }) => {
    state.sessions = sessions ?? [];
    rerender();
  });
  socket.on('disconnect', () => {
    setConn('error', 'Signaling disconnected — retrying…');
  });

  // Wire pagination + focus + audio controls.
  prevBtn.addEventListener('click', () => {
    state.currentPage = Math.max(1, state.currentPage - 1);
    rerender();
  });
  nextBtn.addEventListener('click', () => {
    state.currentPage = Math.min(totalPages(), state.currentPage + 1);
    rerender();
  });
  backBtn.addEventListener('click', () => exitFocusMode().catch(console.error));
  wireAudioControls();
  wireCommandDeck(socket);

  rerender();
}

function setConn(state, label) {
  connIndicator.className = `status status--${state}`;
  connIndicator.textContent = label;
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

// ---------- render ----------------------------------------------------------
function totalPages() {
  return Math.max(1, Math.ceil(state.sessions.length / PAGE_SIZE));
}

function visibleSessions() {
  const start = (state.currentPage - 1) * PAGE_SIZE;
  return state.sessions.slice(start, start + PAGE_SIZE);
}

function rerender() {
  // Clamp current page if sessions shrank below it.
  if (state.currentPage > totalPages()) state.currentPage = totalPages();

  sessionCountEl.textContent = String(state.sessions.length);
  pageIndicator.textContent = `Page ${state.currentPage} of ${totalPages()}`;
  prevBtn.disabled = state.currentPage <= 1;
  nextBtn.disabled = state.currentPage >= totalPages();

  if (state.sessions.length === 0) {
    emptyStateEl.hidden = false;
  } else {
    emptyStateEl.hidden = true;
  }

  // If the focused session disappeared, exit focus mode.
  if (state.focused && !state.sessions.find(s => s.code === state.focused.code)) {
    exitFocusMode().catch(console.error);
  }

  if (!focusView.hidden) {
    // While focused, the grid is hidden — don't churn its tiles. Just
    // refresh focused-tile metadata (e.g., the session's running duration).
    refreshFocusMeta();
    return;
  }

  syncTiles(visibleSessions());
}

function syncTiles(sessions) {
  const wanted = new Set(sessions.map(s => s.code));

  // Tear down tiles that are no longer in the visible page.
  for (const [code, entry] of [...state.tileClients.entries()]) {
    if (!wanted.has(code)) {
      teardownTileClient(code, entry);
    }
  }

  // Remove any DOM nodes that don't belong to a wanted session
  // (re-render is destructive only when the set changes).
  for (const node of [...tileGridEl.querySelectorAll('.tile')]) {
    if (!wanted.has(node.dataset.code)) node.remove();
  }

  for (const session of sessions) {
    let node = tileGridEl.querySelector(`.tile[data-code="${session.code}"]`);
    if (!node) {
      node = renderTile(session);
      tileGridEl.appendChild(node);
    } else {
      updateTileMeta(node, session);
    }

    // Ensure an Agora client exists for this tile. The DOM node and the
    // client lifecycles are independent: entering focus mode tears down
    // every tile client (to free bandwidth) but deliberately leaves DOM
    // nodes in place so exit-focus restores instantly. On the rerender
    // after exit-focus, the DOM is here but the client isn't — recreate.
    // Also covers the "ensureTileClient threw last time" retry case.
    if (!state.tileClients.has(session.code)) {
      const videoMount = node.querySelector('.tile__video');
      videoMount.innerHTML = '<div class="tile__placeholder">Connecting…</div>';
      const statusEl = node.querySelector('.tile__status');
      statusEl.className = 'tile__status status status--connecting';
      statusEl.textContent = '…';

      ensureTileClient(session).catch((err) => {
        console.error(`[grid] tile client for ${session.code} failed`, err);
        statusEl.className = 'tile__status status status--error';
        statusEl.textContent = 'Stream error';
      });
    }
  }
}

function renderTile(session) {
  const node = document.createElement('article');
  node.className = 'tile';
  node.dataset.code = session.code;
  node.tabIndex = 0;
  node.innerHTML = `
    <div class="tile__video">
      <div class="tile__placeholder">Connecting…</div>
    </div>
    <div class="tile__footer">
      <div class="tile__labels">
        <span class="tile__scenario"></span>
        <span class="tile__trainee"></span>
      </div>
      <span class="tile__status status status--connecting">…</span>
    </div>
    <span class="tile__source-pill"></span>
  `;
  updateTileMeta(node, session);

  node.addEventListener('click', () => enterFocusMode(session.code).catch(console.error));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      enterFocusMode(session.code).catch(console.error);
    }
  });
  return node;
}

function updateTileMeta(node, session) {
  node.querySelector('.tile__scenario').textContent = session.scenario ?? 'Unknown scenario';
  node.querySelector('.tile__trainee').textContent  = session.traineeName ?? 'Anonymous trainee';
  const pill = node.querySelector('.tile__source-pill');
  pill.textContent = session.source === 'faker' ? 'FAKER' : 'LIVE';
  pill.dataset.source = session.source ?? 'headset';
}

// ---------- per-tile Agora clients ------------------------------------------
async function ensureTileClient(session) {
  if (state.tileClients.has(session.code)) return;

  const tokenInfo = await fetchToken(session.code, 'subscriber');
  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });

  const tileNode = tileGridEl.querySelector(`.tile[data-code="${session.code}"]`);
  if (!tileNode) {
    // Tile was removed before we got the token; abort gracefully.
    return;
  }
  const videoMount = tileNode.querySelector('.tile__video');
  const statusEl = tileNode.querySelector('.tile__status');

  const entry = { client, videoTrack: null, videoMount, statusEl };
  state.tileClients.set(session.code, entry);

  client.on('user-published', async (user, mediaType) => {
    if (mediaType !== 'video') return;   // grid never plays audio
    await client.subscribe(user, mediaType);
    entry.videoTrack = user.videoTrack;
    videoMount.innerHTML = '';
    user.videoTrack.play(videoMount, { fit: 'cover' });
    statusEl.className = 'tile__status status status--connected';
    statusEl.textContent = 'Live';
  });
  client.on('user-unpublished', (_user, mediaType) => {
    if (mediaType === 'video') {
      try { entry.videoTrack?.stop(); } catch { /* ignore */ }
      entry.videoTrack = null;
      videoMount.innerHTML = '<div class="tile__placeholder">Waiting for video…</div>';
      statusEl.className = 'tile__status status status--connecting';
      statusEl.textContent = 'Waiting';
    }
  });

  await client.join(state.appId, tokenInfo.channel, tokenInfo.token, null);
}

function teardownTileClient(code, entry) {
  state.tileClients.delete(code);
  try { entry.videoTrack?.stop(); } catch { /* ignore */ }
  try { entry.client?.leave(); } catch { /* ignore */ }
}

async function fetchToken(code, role) {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, role, uid: 0 }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`/api/token ${res.status}: ${errBody.error ?? res.statusText}`);
  }
  return await res.json();
}

// ---------- focus mode ------------------------------------------------------
async function enterFocusMode(code) {
  const session = state.sessions.find(s => s.code === code);
  if (!session) return;

  // Tear down ALL tile clients (they're now hidden). This frees up Agora
  // bandwidth + CPU for the focused session and avoids the browser eagerly
  // pausing background video tracks.
  for (const [c, entry] of [...state.tileClients.entries()]) {
    teardownTileClient(c, entry);
  }

  // Swap views
  gridView.hidden = true;
  focusView.hidden = false;
  focusStatus.className = 'status status--connecting';
  focusStatus.textContent = 'Connecting…';
  focusScenario.textContent = session.scenario ?? 'Unknown scenario';
  focusTrainee.textContent  = session.traineeName ?? 'Anonymous trainee';
  focusCode.textContent     = `code ${session.code}`;
  focusSource.textContent   = session.source === 'faker' ? 'FAKER' : 'LIVE';
  focusSource.dataset.source = session.source ?? 'headset';
  focusVideoMount.innerHTML = '';

  state.focused = {
    code: session.code,
    client: null,
    videoTrack: null,
    audioTrack: null,
    micTrack: null,
    startedAt: session.startedAt,
    durationTimer: setInterval(refreshFocusMeta, 1000),
  };
  refreshFocusMeta();

  const tokenInfo = await fetchToken(session.code, 'publisher');
  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });
  state.focused.client = client;

  client.on('user-published', async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === 'video') {
      state.focused.videoTrack = user.videoTrack;
      focusVideoMount.innerHTML = '';
      user.videoTrack.play(focusVideoMount, { fit: 'contain' });
    } else if (mediaType === 'audio') {
      state.focused.audioTrack = user.audioTrack;
      const initVol = Number(volumeSlider.value) || 100;
      user.audioTrack.setVolume(initVol);
      user.audioTrack.play();
    }
  });
  client.on('user-unpublished', (_user, mediaType) => {
    if (mediaType === 'video') {
      try { state.focused.videoTrack?.stop(); } catch { /* ignore */ }
      state.focused.videoTrack = null;
      focusVideoMount.innerHTML = '<div class="tile__placeholder">Waiting for video…</div>';
    } else if (mediaType === 'audio') {
      state.focused.audioTrack = null;
    }
  });

  await client.join(state.appId, tokenInfo.channel, tokenInfo.token, null);
  focusStatus.className = 'status status--connected';
  focusStatus.textContent = `Connected · ${tokenInfo.channel}`;

  // Try to grab the instructor mic — best-effort, same shape as the single
  // session view. Speaker controls also become operational here.
  try {
    state.focused.micTrack = await AgoraRTC.createMicrophoneAudioTrack({
      AEC: true, ANS: true, AGC: true,
    });
    await client.publish(state.focused.micTrack);
    setMicButtonState({ muted: false });
  } catch (err) {
    console.warn('[grid] mic publish failed — receive-only focus', err);
    state.focused.micTrack = null;
    setMicButtonState({ unavailable: true });
  }
}

async function exitFocusMode() {
  if (!state.focused) {
    focusView.hidden = true;
    gridView.hidden = false;
    rerender();
    return;
  }
  const f = state.focused;
  state.focused = null;
  if (f.durationTimer) clearInterval(f.durationTimer);
  try { f.videoTrack?.stop(); } catch { /* ignore */ }
  try { f.audioTrack?.stop(); } catch { /* ignore */ }
  try {
    if (f.micTrack) {
      try { await f.client?.unpublish(f.micTrack); } catch { /* ignore */ }
      try { f.micTrack.close(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try { await f.client?.leave(); } catch { /* ignore */ }

  focusView.hidden = true;
  gridView.hidden = false;
  rerender();   // re-subscribe to the current page's tiles
}

function refreshFocusMeta() {
  if (!state.focused) return;
  const elapsed = Math.floor((Date.now() - state.focused.startedAt) / 1000);
  const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const secs = String(elapsed % 60).padStart(2, '0');
  focusDuration.textContent = `${mins}:${secs}`;
}

// ---------- audio controls (focus mode only) --------------------------------
function setMicButtonState({ unavailable = false, muted = false } = {}) {
  if (unavailable) {
    micToggle.dataset.unavailable = 'true';
    micToggle.dataset.muted = 'false';
    micToggle.disabled = true;
    micToggle.setAttribute('aria-pressed', 'false');
    micToggle.querySelector('.toggle-btn__label').textContent = 'Mic unavailable';
    return;
  }
  delete micToggle.dataset.unavailable;
  micToggle.disabled = false;
  micToggle.dataset.muted = String(muted);
  micToggle.setAttribute('aria-pressed', String(muted));
  micToggle.querySelector('.toggle-btn__label').textContent = muted ? 'Mic muted' : 'Mic on';
}

function setSpeakerButtonState({ muted = false } = {}) {
  speakerToggle.dataset.muted = String(muted);
  speakerToggle.setAttribute('aria-pressed', String(muted));
  speakerToggle.querySelector('.toggle-btn__label').textContent = muted ? 'Speaker muted' : 'Speaker on';
}

let lastVolume = 100;

function wireAudioControls() {
  micToggle.addEventListener('click', async () => {
    const mic = state.focused?.micTrack;
    if (!mic) return;
    const nowEnabled = !mic.enabled;
    await mic.setEnabled(nowEnabled);
    setMicButtonState({ muted: !nowEnabled });
  });

  speakerToggle.addEventListener('click', () => {
    const muted = speakerToggle.dataset.muted === 'true';
    const audio = state.focused?.audioTrack;
    if (muted) {
      volumeSlider.value = String(lastVolume);
      volumeValue.textContent = String(lastVolume);
      if (audio) audio.setVolume(lastVolume);
      setSpeakerButtonState({ muted: false });
    } else {
      lastVolume = Number(volumeSlider.value) || 100;
      if (audio) audio.setVolume(0);
      setSpeakerButtonState({ muted: true });
    }
  });

  volumeSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    volumeValue.textContent = String(v);
    lastVolume = v > 0 ? v : lastVolume;
    const audio = state.focused?.audioTrack;
    if (audio) audio.setVolume(v);
    setSpeakerButtonState({ muted: v === 0 });
  });
}

// ---------- command deck ----------------------------------------------------
function wireCommandDeck(socket) {
  for (const btn of document.querySelectorAll('.command-btn')) {
    btn.addEventListener('click', async () => {
      if (!state.focused) return;
      const command = btn.dataset.command;
      const payload = { code: state.focused.code, command };

      if (command === 'pause_simulation') {
        payload.value = btn.dataset.value === 'true';
      } else if (command === 'change_environment') {
        const v = document.getElementById('map-name-input').value.trim();
        if (!v) { logCommand(`change_environment: map name required`, 'error'); return; }
        payload.map_name = v;
      } else if (command === 'trigger_event') {
        const v = document.getElementById('event-type-input').value.trim();
        if (!v) { logCommand(`trigger_event: event type required`, 'error'); return; }
        payload.event_type = v;
      }

      const ack = await emitWithAck(socket, 'instructor:command', payload);
      if (ack?.ok) {
        logCommand(`→ ${command} (code ${state.focused.code})`, 'ok');
      } else {
        logCommand(`✗ ${command}: ${ack?.error ?? 'failed'}`, 'error');
      }
    });
  }
}

function logCommand(msg, kind) {
  const line = document.createElement('div');
  line.className = `command-log__line command-log__line--${kind}`;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  commandLog.prepend(line);
  // Keep only the last 12 entries.
  while (commandLog.children.length > 12) commandLog.lastChild.remove();
}

// ---------- cleanup ---------------------------------------------------------
window.addEventListener('beforeunload', () => {
  for (const [c, e] of state.tileClients) teardownTileClient(c, e);
  if (state.focused) {
    try { state.focused.client?.leave(); } catch { /* ignore */ }
  }
});
