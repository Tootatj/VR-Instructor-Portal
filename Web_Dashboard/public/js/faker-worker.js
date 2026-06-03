// OneBonsai Session Faker — canvas drawer (Web Worker).
//
// Runs the procedural animation in a Worker so the canvas keeps producing
// frames even when the faker's popup is backgrounded. The main thread
// keeps Agora + signaling; the worker owns the OffscreenCanvas + the
// draw loop + the "command received" overlay state.
//
// Why a worker:
//   - Chrome throttles requestAnimationFrame / setInterval on the main
//     thread of background tabs to ~1 Hz. captureStream then publishes a
//     frozen frame, Agora eventually marks the publisher as silent, and
//     the grid tile flips to "Waiting for video".
//   - Workers are NOT throttled the same way (the tab having an active
//     WebRTC publisher keeps the tab from being fully frozen). A worker
//     setInterval ticks at full rate, the OffscreenCanvas keeps drawing,
//     the main-thread captureStream keeps publishing fresh frames.
//
// Messaging protocol (main → worker):
//   { type: 'init', canvas, width, height, scenario, traineeName, code }
//   { type: 'command', cmd }                          ← forwarded headset:command
//   { type: 'stop' }                                  ← teardown

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;
let scenario = '';
let traineeName = '';
let code = '';
let hue = 0;
let startedAt = 0;
let lastCommand = null;
let lastCommandAt = 0;
let paused = false;
let timerId = 0;

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'init') {
    canvas = msg.canvas;
    width = msg.width;
    height = msg.height;
    scenario = msg.scenario;
    traineeName = msg.traineeName;
    code = msg.code;
    hue = (Number(code) * 47) % 360;
    startedAt = performance.now();
    ctx = canvas.getContext('2d');
    // 30 fps target. Workers ticking faster than 30 Hz waste CPU + battery
    // for a stream Agora is only sampling at 24 fps anyway.
    timerId = setInterval(drawFrame, 1000 / 30);
    drawFrame();   // paint the first frame immediately so the captureStream
                   // has content before Agora publishes.
  } else if (msg.type === 'command') {
    lastCommand = msg.cmd;
    lastCommandAt = performance.now();
    if (msg.cmd?.command === 'pause_simulation') {
      paused = Boolean(msg.cmd.value);
    }
  } else if (msg.type === 'stop') {
    if (timerId) clearInterval(timerId);
    timerId = 0;
  }
};

function drawFrame() {
  if (!ctx) return;
  const t = (performance.now() - startedAt) / 1000;

  const drift = (t * 8) % 360;
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, `hsl(${(hue + drift) % 360}, 55%, 28%)`);
  g.addColorStop(1, `hsl(${(hue + drift + 120) % 360}, 65%, 14%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const horizonY = height * 0.62 + Math.sin(t * 0.4) * 12;
  ctx.moveTo(0, horizonY);
  ctx.lineTo(width, horizonY);
  ctx.stroke();

  const dotX = width / 2 + Math.cos(t * 1.3) * width * 0.3;
  const dotY = horizonY - 30 - Math.abs(Math.sin(t * 2.2)) * 60;
  ctx.fillStyle = `hsl(${(hue + 60) % 360}, 90%, 70%)`;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, width, 80);
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
  ctx.fillText(`${mins}:${secs}`, width - 18, height - 30);
  ctx.textAlign = 'left';

  if (lastCommand && performance.now() - lastCommandAt < 2500) {
    const alpha = 1 - (performance.now() - lastCommandAt) / 2500;
    ctx.fillStyle = `rgba(255, 200, 0, ${alpha * 0.85})`;
    ctx.fillRect(width / 2 - 200, height / 2 - 28, 400, 56);
    ctx.fillStyle = '#000';
    ctx.font = '600 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(formatCommand(lastCommand), width / 2, height / 2 - 8);
    ctx.textAlign = 'left';
  }

  if (paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.font = '700 42px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', width / 2, height / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }
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
