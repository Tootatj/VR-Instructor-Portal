// OneBonsai Session Faker.
//
// Lets us populate the instructor grid view with synthetic VR sessions for
// UX testing. Each faker:
//   1. Connects to the Phase 4 Socket.IO server.
//   2. Emits `headset:register { code, tenantId, scenario, traineeName, source:'faker' }`.
//   3. Fetches a publisher token via POST /api/token.
//   4. Joins the Agora channel as a custom video publisher.
//   5. Generates a canvas-based animated video (no webcam permission needed).
//   6. Renders any incoming `headset:command` event as an overlay so the
//      command round-trip is verifiable end-to-end.
//
// Spawn many: open this page with `?spawn=N` to launch N popups, each a
// single faker with a pre-canned scenario from PRESETS below.

// ---------- preset scenarios for the spawn launcher --------------------------
const PRESETS = [
  { scenario: 'Fire Training',         trainee: 'Trainee 47' },
  { scenario: 'Forklift Sim',          trainee: 'Trainee 12' },
  { scenario: 'Confined Space Rescue', trainee: 'Trainee 31' },
  { scenario: 'Electrical Lockout',    trainee: 'Trainee 88' },
  { scenario: 'Fall Arrest Drill',     trainee: 'Trainee 14' },
  { scenario: 'Hazmat Response',       trainee: 'Trainee 62' },
  { scenario: 'Confined Crane Op',     trainee: 'Trainee 23' },
  { scenario: 'Welding Safety',        trainee: 'Trainee 75' },
];

// ---------- launcher mode ----------------------------------------------------
// If ?spawn=N is in the URL, open N popups and don't run the single-faker
// page itself (hide its UI).
const urlParams = new URLSearchParams(window.location.search);
const spawnCount = Number(urlParams.get('spawn')) || 0;

if (spawnCount > 0) {
  runLauncher(spawnCount);
} else {
  runSingleFaker();
}

function runLauncher(count) {
  document.getElementById('single-mode').hidden = true;
  document.getElementById('launcher').hidden = true;

  const tenantId = urlParams.get('tenant') ?? 'onebonsai';
  const launched = [];
  for (let i = 0; i < count; i += 1) {
    const preset = PRESETS[i % PRESETS.length];
    const code = randomCode();
    // index-suffix the trainee name so spawn-of-9 doesn't have two "Trainee 47"s
    const traineeName = i < PRESETS.length
      ? preset.trainee
      : `${preset.trainee} (${Math.floor(i / PRESETS.length) + 1})`;

    const params = new URLSearchParams({
      tenant: tenantId,
      code,
      scenario: preset.scenario,
      trainee: traineeName,
      auto: '1',
    });
    const url = `/faker.html?${params.toString()}`;
    const features = `popup,width=520,height=720,left=${100 + i * 30},top=${100 + i * 30}`;
    const win = window.open(url, `faker-${code}`, features);
    if (win) launched.push({ code, scenario: preset.scenario, traineeName });
  }

  document.body.innerHTML = `
    <main class="faker">
      <section class="faker__panel">
        <h1 class="faker__title">Spawned ${launched.length} sessions</h1>
        <p class="faker__hint">
          Each session opened in its own popup. Close a popup to drop that
          session from the grid. Close this tab to keep them all running.
        </p>
        <ul class="faker__list">
          ${launched.map(s => `
            <li><code>${s.code}</code> — ${escapeHtml(s.scenario)} / ${escapeHtml(s.traineeName)}</li>
          `).join('')}
        </ul>
        <p class="faker__hint">
          If you only see a few popups, your browser blocked the rest. Look
          for a "popups blocked" icon in the address bar.
        </p>
      </section>
    </main>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- single-faker mode ------------------------------------------------
function runSingleFaker() {
  const form           = document.getElementById('faker-form');
  const tenantInput    = document.getElementById('tenant-input');
  const codeInput      = document.getElementById('code-input');
  const scenarioInput  = document.getElementById('scenario-input');
  const traineeInput   = document.getElementById('trainee-input');
  const startBtn       = document.getElementById('start-btn');
  const stopBtn        = document.getElementById('stop-btn');
  const statusText     = document.getElementById('status-text');
  const previewCanvas  = document.getElementById('preview-canvas');

  const stubInput = document.getElementById('stub-mode');

  // Spawned-popup deep-link: prefill from URL params and auto-start.
  if (urlParams.has('tenant'))   tenantInput.value   = urlParams.get('tenant');
  if (urlParams.has('code'))     codeInput.value     = urlParams.get('code');
  if (urlParams.has('scenario')) scenarioInput.value = urlParams.get('scenario');
  if (urlParams.has('trainee'))  traineeInput.value  = urlParams.get('trainee');
  if (urlParams.get('stub') === '1') stubInput.checked = true;

  let session = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session) return;

    const code = codeInput.value.trim() || randomCode();
    codeInput.value = code;

    const opts = {
      tenantId:    tenantInput.value.trim(),
      code,
      scenario:    scenarioInput.value.trim(),
      traineeName: traineeInput.value.trim(),
      stub:        stubInput.checked,
      canvas:      previewCanvas,
      onStatus:    (state, msg) => setStatus(statusText, state, msg),
    };

    startBtn.disabled = true;
    stopBtn.disabled = false;
    for (const el of form.querySelectorAll('input')) el.disabled = true;

    try {
      session = await startFakerSession(opts);
    } catch (err) {
      console.error('[faker] start failed', err);
      setStatus(statusText, 'error', `Start failed: ${err.message ?? err}`);
      session = null;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      for (const el of form.querySelectorAll('input')) el.disabled = false;
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (!session) return;
    await session.stop();
    session = null;
    setStatus(statusText, 'idle', 'Idle');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    for (const el of form.querySelectorAll('input')) el.disabled = false;
  });

  // Best-effort tidy disconnect on tab close so the grid sees us leave.
  window.addEventListener('beforeunload', () => {
    if (session) session.stop();
  });

  // Auto-start when spawned from the launcher.
  if (urlParams.get('auto') === '1') {
    requestAnimationFrame(() => form.dispatchEvent(new Event('submit')));
  }
}

function setStatus(el, state, label) {
  el.className = `status status--${state}`;
  el.textContent = label;
}

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ---------- the core faker session -------------------------------------------
async function startFakerSession({ tenantId, code, scenario, traineeName, stub = false, canvas, onStatus }) {
  onStatus?.('connecting', 'Connecting to signaling server…');

  // --- 1) signaling: register as a fake headset --------------------------
  const socket = io({ path: '/socket.io' });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  // Stub mode tags itself as 'headset' (not 'faker') so the grid view's
  // LIVE/FAKER pill correctly says LIVE — a real headset is on this code.
  const registerAck = await emitWithAck(socket, 'headset:register', {
    code, tenantId, scenario, traineeName,
    source: stub ? 'headset' : 'faker',
  });
  if (!registerAck?.ok) {
    throw new Error(`headset:register rejected: ${registerAck?.error ?? 'unknown'}`);
  }

  // Stub mode short-circuits before Agora: we hold the Socket.IO connection
  // open so the room stays in the registry (when this tab closes, the room
  // is pruned, exactly as if a real headset disconnected from signaling).
  // The actual video for this channel comes from the real VR app.
  if (stub) {
    // Optional: paint the canvas with a clear "stub mode" indicator so it's
    // visually distinct from active fakers.
    paintStubPlaceholder(canvas, scenario, traineeName, code);

    socket.on('headset:command', (cmd) => {
      console.log(`[faker-stub ${code}] command received (forwarded to real headset by server):`, cmd);
    });

    onStatus?.('connected', `Stub for code ${code} — real headset publishes the video`);
    return {
      async stop() { socket.disconnect(); },
    };
  }

  // --- 2) token: fetch a publisher token via REST -------------------------
  onStatus?.('connecting', 'Fetching publisher token…');
  const tokenRes = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, role: 'publisher', uid: 0 }),
  });
  if (!tokenRes.ok) {
    const errBody = await tokenRes.json().catch(() => ({}));
    throw new Error(`/api/token ${tokenRes.status}: ${errBody.error ?? tokenRes.statusText}`);
  }
  const { appId, token, channel } = await tokenRes.json();

  // --- 3) canvas video stream --------------------------------------------
  // 24 fps is plenty for a fake VR feed; h264 encoder cost stays trivial.
  //
  // CRITICAL ORDER: captureStream() MUST be called BEFORE
  // transferControlToOffscreen(). Once control is transferred to the worker,
  // the main-thread canvas can't be re-contexted, but a previously-created
  // captureStream keeps pulling frames from whatever the OffscreenCanvas
  // draws. Reversing the order throws "InvalidStateError".
  const stream = canvas.captureStream(24);
  const mediaTrack = stream.getVideoTracks()[0];

  // Start drawing BEFORE Agora publishes so the first encoded frame is
  // already real content (not a black frame the trainee would see briefly).
  //
  // The drawer runs in a Web Worker so frame production is NOT throttled
  // when the faker's popup is backgrounded. Main-thread requestAnimationFrame
  // is clamped to ~1 Hz in background tabs in Chrome; the captureStream then
  // publishes a frozen frame, Agora marks the publisher as silent, and the
  // grid tile flips to "Waiting for video". Workers don't get the same
  // throttling treatment (especially with active WebRTC media on the page).
  const drawer = startCanvasDrawer({ canvas, scenario, traineeName, code });

  // --- 4) Agora join + publish -------------------------------------------
  onStatus?.('connecting', `Joining Agora channel "${channel}"…`);
  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });
  await client.join(appId, channel, token, null);

  const videoTrack = AgoraRTC.createCustomVideoTrack({
    mediaStreamTrack: mediaTrack,
    // Bitrate caps mirror the headset-side push budget so the grid view
    // sees fakers and real Quests as roughly equivalent visual load.
    bitrateMin: 400,
    bitrateMax: 1200,
  });
  await client.publish(videoTrack);

  onStatus?.('connected', `Live as ${traineeName} (code ${code})`);

  // --- 5) listen for instructor commands ----------------------------------
  socket.on('headset:command', (cmd) => {
    console.log(`[faker ${code}] command received:`, cmd);
    drawer.handleCommand(cmd);
  });

  return {
    async stop() {
      try { await client.unpublish(videoTrack); } catch { /* ignore */ }
      try { videoTrack.close(); } catch { /* ignore */ }
      try { await client.leave(); } catch { /* ignore */ }
      drawer.stop();
      socket.disconnect();
    },
  };
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response) => resolve(response));
  });
}

// ---------- canvas drawer ----------------------------------------------------
// Hands the canvas to a Web Worker (OffscreenCanvas) so frame production
// is not throttled when the faker's popup is backgrounded. Falls back to
// in-page rAF if the browser doesn't support OffscreenCanvas (rare in
// modern Chromium / Firefox / Safari 16.4+).
//
// IMPORTANT: caller must have already called `canvas.captureStream()`
// BEFORE invoking this — once transferControlToOffscreen() runs, the main
// thread can no longer create a context on the canvas. The captureStream
// keeps pulling frames from whatever the OffscreenCanvas draws.
function startCanvasDrawer({ canvas, scenario, traineeName, code }) {
  const supported =
    typeof canvas.transferControlToOffscreen === 'function' &&
    typeof Worker !== 'undefined';

  if (supported) {
    return startWorkerDrawer({ canvas, scenario, traineeName, code });
  }

  console.warn('[faker] OffscreenCanvas not supported, falling back to main-thread drawer');
  return startMainThreadDrawer({ canvas, scenario, traineeName, code });
}

function startWorkerDrawer({ canvas, scenario, traineeName, code }) {
  const width = canvas.width;
  const height = canvas.height;
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker('/js/faker-worker.js');

  worker.postMessage(
    { type: 'init', canvas: offscreen, width, height, scenario, traineeName, code },
    [offscreen]   // transfer ownership of the OffscreenCanvas to the worker
  );

  return {
    handleCommand(cmd) {
      worker.postMessage({ type: 'command', cmd });
    },
    stop() {
      worker.postMessage({ type: 'stop' });
      // Give the worker a tick to clear its setInterval before terminate,
      // otherwise we sometimes see a "canvas detached" warning in DevTools.
      setTimeout(() => worker.terminate(), 50);
    },
  };
}

// Fallback: in-thread rAF drawer. Will freeze in background popups but
// kept for browsers without OffscreenCanvas support.
function startMainThreadDrawer({ canvas, scenario, traineeName, code }) {
  const ctx = canvas.getContext('2d');
  const startedAt = performance.now();
  let lastCommand = null;
  let lastCommandAt = 0;
  let paused = false;
  const hue = (Number(code) * 47) % 360;

  let raf = 0;
  function frame() {
    const t = (performance.now() - startedAt) / 1000;
    const drift = (t * 8) % 360;
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, `hsl(${(hue + drift) % 360}, 55%, 28%)`);
    g.addColorStop(1, `hsl(${(hue + drift + 120) % 360}, 65%, 14%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const horizonY = canvas.height * 0.62 + Math.sin(t * 0.4) * 12;
    ctx.moveTo(0, horizonY);
    ctx.lineTo(canvas.width, horizonY);
    ctx.stroke();

    const dotX = canvas.width / 2 + Math.cos(t * 1.3) * canvas.width * 0.3;
    const dotY = horizonY - 30 - Math.abs(Math.sin(t * 2.2)) * 60;
    ctx.fillStyle = `hsl(${(hue + 60) % 360}, 90%, 70%)`;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvas.width, 80);
    ctx.fillStyle = '#fff';
    ctx.font = '600 28px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(scenario, 18, 14);
    ctx.font = '400 16px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`${traineeName}  ·  code ${code}`, 18, 48);

    const mins = String(Math.floor(t / 60)).padStart(2, '0');
    const secs = String(Math.floor(t % 60)).padStart(2, '0');
    ctx.font = '500 18px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'right';
    ctx.fillText(`${mins}:${secs}`, canvas.width - 18, canvas.height - 30);
    ctx.textAlign = 'left';

    if (lastCommand && performance.now() - lastCommandAt < 2500) {
      const alpha = 1 - (performance.now() - lastCommandAt) / 2500;
      ctx.fillStyle = `rgba(255, 200, 0, ${alpha * 0.85})`;
      ctx.fillRect(canvas.width / 2 - 200, canvas.height / 2 - 28, 400, 56);
      ctx.fillStyle = '#000';
      ctx.font = '600 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(formatCommand(lastCommand), canvas.width / 2, canvas.height / 2 - 8);
      ctx.textAlign = 'left';
    }

    if (paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '700 42px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    handleCommand(cmd) {
      lastCommand = cmd;
      lastCommandAt = performance.now();
      if (cmd.command === 'pause_simulation') paused = Boolean(cmd.value);
    },
    stop() {
      cancelAnimationFrame(raf);
    },
  };
}

function paintStubPlaceholder(canvas, scenario, traineeName, code) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#444';
  ctx.font = '600 32px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('STUB MODE', canvas.width / 2, canvas.height / 2 - 30);

  ctx.fillStyle = '#888';
  ctx.font = '400 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(`${scenario} · ${traineeName}`, canvas.width / 2, canvas.height / 2 + 10);
  ctx.fillText(`code ${code} — real headset publishes video`, canvas.width / 2, canvas.height / 2 + 35);
}

function formatCommand(cmd) {
  switch (cmd.command) {
    case 'pause_simulation':    return cmd.value ? 'PAUSE' : 'RESUME';
    case 'change_environment':  return `MAP → ${cmd.map_name}`;
    case 'trigger_event':       return `EVENT → ${cmd.event_type}`;
    case 'reset_user_position': return 'RESET POSITION';
    default:                    return cmd.command;
  }
}
