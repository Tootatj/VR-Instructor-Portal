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
//   - 2026-06-15: per-app dashboard panels. The focused session's `appId`
//     drives dynamic-import of `apps/<appId>.js`. Live state transitions
//     arrive as `session:state-changed` events and are forwarded to the
//     per-app module's update() hook. See public/js/apps/README.md.

import {
  mountAppPanel,
  updateAppPanel,
  unmountAppPanel,
} from './apps/_loader.js';

// ---------- state -----------------------------------------------------------
const PAGE_SIZE = 6;

const state = {
  appId: null,
  tenantId: null,
  sessions: [],          // full list, server-sorted by startedAt asc
  currentPage: 1,
  tileClients: new Map(),  // code -> { client, videoTrack, videoMount, durationTimer }
  focused: null,           // { code, client, videoTrack, audioTrack, micTrack? }
  // Phase 1 Agora cost-exposure (Devlog 2026-06-11): when the browser tab
  // is hidden (lock screen / other tab / minimised window), unsubscribe
  // from every remote video & audio track and disable the focused-mode
  // mic. Re-subscribe on visibility return. This cuts the "instructor
  // tabs away and forgets" minute leak — see the audit entry in Devlog
  // for the per-day cost numbers. Suspended state guards against double
  // unsubscribe/resubscribe if visibilitychange fires twice in a row.
  suspended: false,
};

// ---------- DOM refs --------------------------------------------------------
const connIndicator    = document.getElementById('conn-indicator');
const sessionCountEl   = document.getElementById('session-count');
const tileGridEl       = document.getElementById('tile-grid');
const emptyStateEl     = document.getElementById('empty-state');
const prevBtn          = document.getElementById('prev-page-btn');
const nextBtn          = document.getElementById('next-page-btn');
const pageIndicator    = document.getElementById('page-indicator');

const instructorChip   = document.getElementById('instructor-chip');
const instructorTenant = document.getElementById('instructor-tenant');
const instructorName   = document.getElementById('instructor-name');
const logoutBtn        = document.getElementById('logout-btn');

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
const focusAppPanel    = document.getElementById('focus-app-panel');

// Module-scoped socket reference. Captured once in boot() so per-app
// command dispatch (built around mountAppPanel's sendCommand callback)
// can reach the socket without threading it through enterFocusMode().
let socketRef = null;

// ---------- boot ------------------------------------------------------------
boot().catch((err) => {
  console.error('[grid] boot failed', err);
  setConn('error', `Boot failed: ${err.message ?? err}`);
});

async function boot() {
  setConn('connecting', 'Loading config…');

  // Phase 6 (Devlog 2026-06-04): tenant scope comes from the instructor
  // session cookie, not from /api/config. The server's auth gate already
  // redirected anonymous users to /login.html, but if our cookie expired
  // mid-session (or we landed here via back-button after logout) /api/me
  // will 401 and we hard-redirect.
  const meRes = await fetch('/api/instructor/me', { credentials: 'same-origin' });
  if (meRes.status === 401) {
    window.location.replace('/login.html');
    return;
  }
  if (!meRes.ok) {
    setConn('error', `/api/instructor/me failed (${meRes.status})`);
    return;
  }
  const me = await meRes.json();
  state.tenantId = me.tenantId;
  renderInstructorChip(me);
  wireLogout();

  // Agora App ID is still public-ish config (it gets sent to Agora SD-RTN
  // on join anyway); keep using /api/config for that single value.
  const cfg = await fetch('/api/config').then(r => r.json());
  state.appId = cfg.appId;
  if (!state.appId) {
    setConn('error', 'AGORA_APP_ID missing on server (.env)');
    return;
  }

  // Initial sessions list via REST (works even before socket connects).
  // No tenantId in the URL — the server reads it from the session cookie.
  const initial = await fetch(
    `/api/sessions?page=1&pageSize=999`,
    { credentials: 'same-origin' }
  ).then(r => r.json());
  state.sessions = initial.sessions ?? [];

  // Then connect Socket.IO for live updates. The session cookie travels
  // automatically on the handshake (same-origin), so the server's
  // io.use(attachInstructorToSocket) hook reads it and the subscribe
  // handler can ignore any tenantId the client tries to send.
  setConn('connecting', 'Connecting to signaling…');
  const socket = io({ path: '/socket.io', withCredentials: true });
  socketRef = socket;
  socket.on('connect', async () => {
    const ack = await emitWithAck(socket, 'instructor:subscribe-tenant', {});
    if (!ack?.ok) {
      // 401-equivalent: cookie expired/invalid on the socket — kick to
      // login so the next reconnect picks up a fresh session.
      if (ack?.error === 'instructor login required') {
        window.location.replace('/login.html');
        return;
      }
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
  // 2026-06-15 per-app interactive control plane (docs/state-updates.md).
  // Server fans this out whenever a headset publishes EmitStateUpdate.
  // We patch the matching session in state.sessions so the snapshot
  // stays authoritative (e.g. for re-focus after switching tiles), then
  // forward to the active per-app module so its update() hook can
  // re-render. The grid view itself doesn't re-render on state changes —
  // tile metadata (scenario/trainee/video) is unaffected by per-app state.
  socket.on('session:state-changed', (evt) => {
    const idx = state.sessions.findIndex((s) => s.code === evt.code);
    if (idx >= 0) {
      const merged = {
        ...state.sessions[idx],
        appId: evt.appId ?? state.sessions[idx].appId,
        appVersion: evt.appVersion ?? state.sessions[idx].appVersion,
        currentState: {
          name: evt.state,
          data: evt.data,
          updatedAt: evt.updatedAt,
          ...(evt.seq !== undefined ? { seq: evt.seq } : {}),
        },
      };
      state.sessions[idx] = merged;
      // If this is the focused session, push the update to the per-app
      // panel. Otherwise it's just a background snapshot refresh.
      if (state.focused?.code === evt.code) {
        updateAppPanel(merged);
      }
    }
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
    if (state.suspended) return;         // tab is hidden — defer to resume
    await subscribeAndPlayTileVideo(entry, user);
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

// Phase 1 Agora cost-exposure: factored out of the user-published handler so
// the visibilitychange resume path can reuse the same subscribe+render logic.
// Always called from a context where state.suspended is already false.
async function subscribeAndPlayTileVideo(entry, user) {
  await entry.client.subscribe(user, 'video');
  entry.videoTrack = user.videoTrack;
  entry.videoMount.innerHTML = '';
  user.videoTrack.play(entry.videoMount, { fit: 'cover' });
  entry.statusEl.className = 'tile__status status status--connected';
  entry.statusEl.textContent = 'Live';
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

  // Per-app panel. Awaited so a slow dynamic-import (first focus per
  // appId per page-load) doesn't race the Agora join below — both are
  // independent, but keeping the panel-mount synchronous-feeling makes
  // the UI predictable. Errors during mount fall back internally;
  // grid.js never sees them.
  mountAppPanel({
    container: focusAppPanel,
    session,
    sendCommand: makeFocusCommandSender(),
    logCommand,
  }).catch((err) => {
    // Already handled inside the loader (it falls back to _fallback.js),
    // but log here too so the dashboard console shows it under the focus-
    // mode context where it's relevant.
    console.warn('[grid] per-app panel mount failed', err);
  });

  const tokenInfo = await fetchToken(session.code, 'publisher');
  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });
  state.focused.client = client;

  client.on('user-published', async (user, mediaType) => {
    if (state.suspended) return;    // tab hidden — defer to resume
    await subscribeAndPlayFocusTrack(user, mediaType);
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

  // Tear down the per-app panel after the Agora teardown so any
  // in-flight commands the panel might emit during unmount still have
  // a live socket (they shouldn't — but defence in depth).
  unmountAppPanel();

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

// 2026-06-15 per-app interactive control plane. Build the sendCommand
// callback that per-app modules (apps/<appId>.js) call to dispatch a
// command. Auto-injects the focused session's `code` and logs the
// outcome to the command log — per-app modules never touch the socket
// directly. Returned as a factory so the closure captures the focused
// code AT THE TIME OF FOCUS, not at panel-mount time (defence against
// the focused session changing under the panel; in practice focus
// switch always unmounts + re-mounts the panel, so this never differs,
// but the factory keeps the contract obvious).
function makeFocusCommandSender() {
  const code = state.focused?.code ?? null;
  return async (command, payload = {}) => {
    if (!socketRef) {
      logCommand(`✗ ${command}: socket not ready`, 'error');
      return { ok: false, error: 'socket not ready' };
    }
    if (!code) {
      logCommand(`✗ ${command}: no focused session`, 'error');
      return { ok: false, error: 'no focused session' };
    }
    const fullPayload = { ...payload, command, code };
    const ack = await emitWithAck(socketRef, 'instructor:command', fullPayload);
    if (ack?.ok) {
      logCommand(`→ ${command} (code ${code})`, 'ok');
    } else {
      logCommand(`✗ ${command}: ${ack?.error ?? 'failed'}`, 'error');
    }
    return ack;
  };
}

// ---------- instructor header (Phase 6) -------------------------------------
function renderInstructorChip({ tenantDisplayName, instructorName: name, tenantId }) {
  instructorTenant.textContent = tenantDisplayName ?? tenantId ?? '—';
  instructorName.textContent   = name ?? 'Anonymous';
  instructorChip.hidden = false;
  logoutBtn.hidden = false;
}

function wireLogout() {
  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/api/instructor/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch (err) {
      // Logout is best-effort — even if the request fails the cookie
      // will eventually expire. Redirect anyway.
      console.warn('[grid] logout request failed', err);
    } finally {
      window.location.replace('/login.html');
    }
  });
}

// ---------- focus subscribe helper (used by user-published + resume) --------
// Always called from a context where state.suspended is already false.
async function subscribeAndPlayFocusTrack(user, mediaType) {
  if (!state.focused) return;
  await state.focused.client.subscribe(user, mediaType);
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
}

// ---------- visibility-aware subscription suspend ---------------------------
// Phase 1 Agora cost-exposure (Devlog 2026-06-11). When the tab is hidden
// (other tab, locked screen, minimised window) we unsubscribe from every
// remote track on every client and disable the focused-mode mic. Staying
// joined to the channel — only the subscriptions go away — means resume
// latency is ~500 ms (a `subscribe()` round-trip), not a full re-join +
// token-mint. On resume we iterate each client's currently-published remote
// users and re-subscribe to whatever's actually flowing.
//
// We do NOT pause publishing (the headset side keeps publishing into the
// channel — that's the headset's HMD-worn-state monitor's job to handle).
// We only stop SUBSCRIBING, which is what Agora bills the dashboard side
// for in this role. Mic is disabled rather than unpublished because re-
// enabling is instantaneous; re-publish would re-prompt for mic perms on
// some browsers.
async function suspendSubscriptions() {
  if (state.suspended) return;
  state.suspended = true;

  for (const [, entry] of state.tileClients) {
    try { entry.videoTrack?.stop(); } catch { /* ignore */ }
    entry.videoTrack = null;
    for (const user of entry.client.remoteUsers ?? []) {
      if (user.videoTrack) {
        try { await entry.client.unsubscribe(user, 'video'); } catch { /* ignore */ }
      }
    }
    entry.videoMount.innerHTML =
      '<div class="tile__placeholder">Paused (tab hidden)</div>';
    entry.statusEl.className = 'tile__status status status--connecting';
    entry.statusEl.textContent = 'Paused';
  }

  if (state.focused) {
    const f = state.focused;
    try { f.videoTrack?.stop(); } catch { /* ignore */ }
    f.videoTrack = null;
    try { f.audioTrack?.stop(); } catch { /* ignore */ }
    f.audioTrack = null;
    for (const user of f.client?.remoteUsers ?? []) {
      if (user.videoTrack) {
        try { await f.client.unsubscribe(user, 'video'); } catch { /* ignore */ }
      }
      if (user.audioTrack) {
        try { await f.client.unsubscribe(user, 'audio'); } catch { /* ignore */ }
      }
    }
    if (f.micTrack && f.micTrack.enabled) {
      try { await f.micTrack.setEnabled(false); } catch { /* ignore */ }
      setMicButtonState({ muted: true });
    }
    focusVideoMount.innerHTML =
      '<div class="tile__placeholder">Paused (tab hidden)</div>';
    focusStatus.className = 'status status--connecting';
    focusStatus.textContent = 'Paused (tab hidden)';
  }
}

async function resumeSubscriptions() {
  if (!state.suspended) return;
  state.suspended = false;

  for (const [, entry] of state.tileClients) {
    for (const user of entry.client.remoteUsers ?? []) {
      if (user.hasVideo) {
        try {
          await subscribeAndPlayTileVideo(entry, user);
        } catch (err) {
          console.warn('[grid] tile resume failed', err);
        }
      }
    }
  }

  if (state.focused) {
    const f = state.focused;
    for (const user of f.client?.remoteUsers ?? []) {
      if (user.hasVideo) {
        try { await subscribeAndPlayFocusTrack(user, 'video'); }
        catch (err) { console.warn('[grid] focus video resume failed', err); }
      }
      if (user.hasAudio) {
        try { await subscribeAndPlayFocusTrack(user, 'audio'); }
        catch (err) { console.warn('[grid] focus audio resume failed', err); }
      }
    }
    // Restore focus-status indicator. We can re-derive the channel from the
    // focused state's code without another token round-trip.
    focusStatus.className = 'status status--connected';
    focusStatus.textContent = `Connected · session ${f.code}`;
    // Note: we intentionally do NOT auto-unmute the mic — the instructor
    // explicitly muted it (implicitly, by hiding the tab); they can
    // re-enable it via the mic toggle when they're back.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    suspendSubscriptions().catch((err) =>
      console.error('[grid] suspend failed', err));
  } else if (document.visibilityState === 'visible') {
    resumeSubscriptions().catch((err) =>
      console.error('[grid] resume failed', err));
  }
});

// ---------- cleanup ---------------------------------------------------------
window.addEventListener('beforeunload', () => {
  for (const [c, e] of state.tileClients) teardownTileClient(c, e);
  if (state.focused) {
    try { state.focused.client?.leave(); } catch { /* ignore */ }
  }
});
