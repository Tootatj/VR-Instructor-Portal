// VR Instructor Portal — Step 1.5 receiver + bidirectional voice.
//
// Receives the trainee's video + audio AND publishes the instructor's
// microphone into the channel so the trainee hears them in-headset.
// Adds three live controls per .cursorrules §2.B.3: mic mute, speaker
// mute, volume slider.
//
// Credentials flow through the form at runtime — nothing is hardcoded
// (per .cursorrules §4.1). Phase 4 replaces the token field with a
// server-minted token from /api/token.

const STORAGE_KEY = 'vrip.mvp.connection';

const form          = document.getElementById('join-form');
const appIdInput    = document.getElementById('app-id');
const channelInput  = document.getElementById('channel');
const tokenInput    = document.getElementById('token');
const joinBtn       = document.getElementById('join-btn');
const leaveBtn      = document.getElementById('leave-btn');
const statusText    = document.getElementById('status-text');
const videoMount    = document.getElementById('remote-video');

const audioControls  = document.getElementById('audio-controls');
const micToggle      = document.getElementById('mic-toggle');
const speakerToggle  = document.getElementById('speaker-toggle');
const volumeSlider   = document.getElementById('volume-slider');
const volumeValue    = document.getElementById('volume-value');

// Snapshot the initial placeholder markup so we can restore it on leave /
// unpublish without rebuilding it in JS.
const placeholderHTML = videoMount.innerHTML;

let client = null;
let currentVideoTrack = null;
let currentAudioTrack = null;   // remote audio (trainee → instructor)
let micTrack = null;            // local audio (instructor → trainee)
let lastVolume = 100;           // remembered between speaker-mute toggles

restorePersistedForm();
wireAudioControls();

function restorePersistedForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved) {
      appIdInput.value   = saved.appId   ?? '';
      channelInput.value = saved.channel ?? '';
      tokenInput.value   = saved.token   ?? '';
    }
  } catch {
    // Corrupt localStorage entry — wipe and continue with empty form.
    localStorage.removeItem(STORAGE_KEY);
  }
}

function setStatus(state, label) {
  statusText.className = `status status--${state}`;
  statusText.textContent = label;
}

function setFormBusy(busy) {
  for (const el of form.querySelectorAll('input, textarea')) {
    el.disabled = busy;
  }
  joinBtn.disabled = busy;
  leaveBtn.disabled = !busy;
}

function attachRemoteVideo(videoTrack) {
  videoMount.innerHTML = '';
  videoTrack.play(videoMount);
  currentVideoTrack = videoTrack;
}

function restorePlaceholder() {
  if (currentVideoTrack) {
    try { currentVideoTrack.stop(); } catch { /* already gone */ }
    currentVideoTrack = null;
  }
  videoMount.innerHTML = placeholderHTML;
}

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

function wireAudioControls() {
  micToggle.addEventListener('click', async () => {
    if (!micTrack) return;
    const nowEnabled = !micTrack.enabled;
    await micTrack.setEnabled(nowEnabled);
    setMicButtonState({ muted: !nowEnabled });
  });

  speakerToggle.addEventListener('click', () => {
    const muted = speakerToggle.dataset.muted === 'true';
    if (muted) {
      // Unmuting: restore the last non-zero volume.
      volumeSlider.value = String(lastVolume);
      volumeValue.textContent = String(lastVolume);
      if (currentAudioTrack) currentAudioTrack.setVolume(lastVolume);
      setSpeakerButtonState({ muted: false });
    } else {
      // Muting: remember the current volume, drop to 0 without moving the slider.
      lastVolume = Number(volumeSlider.value) || 100;
      if (currentAudioTrack) currentAudioTrack.setVolume(0);
      setSpeakerButtonState({ muted: true });
    }
  });

  volumeSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    volumeValue.textContent = String(v);
    lastVolume = v > 0 ? v : lastVolume;
    if (currentAudioTrack) currentAudioTrack.setVolume(v);
    setSpeakerButtonState({ muted: v === 0 });
  });
}

async function join() {
  const appId   = appIdInput.value.trim();
  const channel = channelInput.value.trim();
  const token   = tokenInput.value.trim();

  if (!appId || !channel || !token) {
    setStatus('error', 'App ID, channel, and token are all required.');
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify({ appId, channel, token }));

  setStatus('connecting', `Joining channel "${channel}"…`);
  setFormBusy(true);

  // mode=rtc + codec=h264 mirrors the headset side:
  //   - CHANNEL_PROFILE_COMMUNICATION on the BP side (2026-05-28 entry)
  //     maps to mode=rtc here (symmetric pub/sub, no role gating).
  //   - h264 matches the §1.3 hard-locked mobile-baseline codec choice.
  client = AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' });

  client.on('user-published', async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === 'video') {
      attachRemoteVideo(user.videoTrack);
    } else if (mediaType === 'audio') {
      currentAudioTrack = user.audioTrack;
      const initialVolume = Number(volumeSlider.value) || 100;
      currentAudioTrack.setVolume(initialVolume);
      currentAudioTrack.play();
    }
  });

  client.on('user-unpublished', (_user, mediaType) => {
    if (mediaType === 'video') {
      restorePlaceholder();
    } else if (mediaType === 'audio') {
      currentAudioTrack = null;
    }
  });

  client.on('user-left', () => {
    restorePlaceholder();
    setStatus('connecting', 'Trainee left — waiting for reconnect…');
  });

  client.on('connection-state-change', (curr) => {
    if (curr === 'DISCONNECTED') {
      setStatus('idle', 'Disconnected');
      setFormBusy(false);
    }
  });

  try {
    // uid=null lets Agora SD-RTN assign a fresh integer UID per join.
    await client.join(appId, channel, token, null);
    setStatus('connected', `Connected to "${channel}". Waiting for trainee video…`);

    // Reveal audio controls and try to grab the mic.
    // The mic is best-effort: if the browser denies permission OR no input
    // device exists, we keep the receive path running and just disable the
    // mic button — bidirectional voice silently degrades to receive-only.
    audioControls.hidden = false;
    setSpeakerButtonState({ muted: false });
    try {
      micTrack = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true,   // acoustic echo cancellation
        ANS: true,   // automatic noise suppression
        AGC: true,   // automatic gain control
      });
      await client.publish(micTrack);
      setMicButtonState({ muted: false });
    } catch (err) {
      console.warn('[VRIP] mic publish failed — running receive-only', err);
      micTrack = null;
      setMicButtonState({ unavailable: true });
    }
  } catch (err) {
    console.error('[VRIP] join failed', err);
    setStatus('error', `Join failed: ${err.message ?? err}`);
    setFormBusy(false);
    client = null;
  }
}

async function leave() {
  if (!client) return;
  setStatus('connecting', 'Leaving channel…');
  try {
    restorePlaceholder();
    if (micTrack) {
      try { await client.unpublish(micTrack); } catch { /* already gone */ }
      try { micTrack.close(); } catch { /* already closed */ }
      micTrack = null;
    }
    currentAudioTrack = null;
    await client.leave();
  } catch (err) {
    console.error('[VRIP] leave failed', err);
  } finally {
    client = null;
    audioControls.hidden = true;
    setStatus('idle', 'Idle');
    setFormBusy(false);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  join();
});
leaveBtn.addEventListener('click', leave);

// Best-effort tidy disconnect on tab close so the channel doesn't briefly
// keep a ghost subscriber until Agora's keepalive prunes it.
window.addEventListener('beforeunload', () => {
  if (client) client.leave();
});
