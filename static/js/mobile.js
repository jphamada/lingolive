// Mobile Microphone Audio Streamer
let ws = null;
let audioContext = null;
let micStream = null;
let scriptNode = null;
let isMuted = false;
let isAudioActive = false;
let wakeLock = null;

// UI Elements
const startOverlay = document.getElementById("startOverlay");
const activateAudioBtn = document.getElementById("activateAudioBtn");
const exitBtn = document.getElementById("exitBtn");

const liveDot = document.getElementById("liveDot");
const liveStatusText = document.getElementById("liveStatusText");
const geminiBadge = document.getElementById("geminiBadge");
const geminiStatusLabel = document.getElementById("geminiStatusLabel");
const latencyVal = document.getElementById("latencyVal");

const deviceName = document.getElementById("deviceName");
const sampleRateBadge = document.getElementById("sampleRateBadge");

const dbfsVal = document.getElementById("dbfsVal");
const meterBarFill = document.getElementById("meterBarFill");
const voiceStatusText = document.getElementById("voiceStatusText");
const eqBars = document.querySelectorAll(".eq-bars .bar");
const bufferStatus = document.getElementById("bufferStatus");

const muteToggleBtn = document.getElementById("muteToggleBtn");
const micIcon = document.getElementById("micIcon");
const micOffIcon = document.getElementById("micOffIcon");
const btnMainLabel = document.getElementById("btnMainLabel");
const btnInstruction = document.getElementById("btnInstruction");

const sessionTitle = document.getElementById("sessionTitle");
const langRouteText = document.getElementById("langRouteText");

let pingStartTime = 0;
let bufferDropCount = 0;

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  setupButtons();
  connectWebSocket();
  requestWakeLock();
});

// Setup Buttons
function setupButtons() {
  activateAudioBtn.addEventListener("click", async () => {
    try {
      await startAudioCapture();
      startOverlay.style.display = "none";
    } catch (err) {
      alert("Error accediendo al micrófono: " + err.message + "\nAsegúrate de otorgar permisos.");
      console.error(err);
    }
  });

  muteToggleBtn.addEventListener("click", () => {
    if (!isAudioActive) return;
    toggleMute();
  });

  exitBtn.addEventListener("click", () => {
    if (confirm("¿Deseas volver al panel de control?")) {
      window.location.href = "/";
    }
  });
}

// Request Screen Wake Lock so phone doesn't sleep on stage
async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      console.log("Screen Wake Lock active.");
    } catch (err) {
      console.warn("Wake Lock error:", err);
    }
  }
}

// Audio Capture Setup
async function startAudioCapture() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.resume();

  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1,
    },
  };

  micStream = await navigator.mediaDevices.getUserMedia(constraints);
  isAudioActive = true;

  // Detect device name
  const tracks = micStream.getAudioTracks();
  if (tracks.length > 0) {
    const label = tracks[0].label || "Micrófono del Celular";
    deviceName.textContent = label;
  }

  const actualSampleRate = audioContext.sampleRate;
  sampleRateBadge.querySelector("span").textContent = `${Math.round(actualSampleRate / 1000)} kHz`;

  // Setup Web Audio graph
  const sourceNode = audioContext.createMediaStreamSource(micStream);
  
  // Buffer size 2048 or 4096 gives ~45-90ms chunks
  const bufferSize = 2048;
  scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  scriptNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);

    // Calculate RMS & dBFS
    let sum = 0;
    for (let i = 0; i < inputData.length; i++) {
      sum += inputData[i] * inputData[i];
    }
    const rms = Math.sqrt(sum / inputData.length);
    const db = rms > 0.00001 ? 20 * Math.log10(rms) : -60.0;
    const clampedDb = Math.max(-60, Math.min(0, db));

    updateAudioMeters(clampedDb);

    if (isMuted || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Downsample to 16000 Hz if needed
    const pcm16 = downsampleTo16k(inputData, audioContext.sampleRate);

    // Send binary PCM chunk to backend
    try {
      ws.send(pcm16.buffer);
    } catch (e) {
      bufferDropCount++;
      bufferStatus.textContent = `Buffers: ${bufferDropCount} drops`;
    }
  };

  sourceNode.connect(scriptNode);
  scriptNode.connect(audioContext.destination);

  updateStatus(true);
}

// Downsample Float32 buffer to 16kHz 16-bit PCM
function downsampleTo16k(input, fromRate) {
  const targetRate = 16000;
  if (fromRate === targetRate) {
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm;
  }

  const ratio = fromRate / targetRate;
  const newLength = Math.round(input.length / ratio);
  const pcm = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const idx = Math.floor(i * ratio);
    const s = Math.max(-1, Math.min(1, input[idx] || 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return pcm;
}

// Update dBFS text, VU meter, and Equalizer animation
function updateAudioMeters(db) {
  dbfsVal.textContent = `${db.toFixed(1)} dBFS`;

  // Scale from -60 dB (0%) to 0 dB (100%)
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meterBarFill.style.width = `${pct}%`;

  const isVoiceActive = db > -38 && !isMuted;
  if (isVoiceActive) {
    voiceStatusText.classList.remove("silent");
    voiceStatusText.textContent = "VOZ ACTIVA";
  } else {
    voiceStatusText.classList.add("silent");
    voiceStatusText.textContent = isMuted ? "SILENCIADO" : "EN ESPERA";
  }

  // Animate EQ bars
  eqBars.forEach((bar, index) => {
    if (isMuted || db < -55) {
      bar.style.height = "6px";
    } else {
      const variance = (index % 2 === 0 ? 1.2 : 0.85);
      const barHeight = Math.max(6, Math.min(44, (pct * 0.44 * variance)));
      bar.style.height = `${barHeight}px`;
    }
  });
}

// Toggle Mute
function toggleMute() {
  isMuted = !isMuted;

  if (isMuted) {
    muteToggleBtn.className = "hero-mic-btn btn-muted";
    micIcon.style.display = "none";
    micOffIcon.style.display = "block";
    btnMainLabel.textContent = "En Silencio • Reactivar";
    btnInstruction.textContent = "El micrófono está silenciado. Presiona para transmitir.";
    voiceStatusText.classList.add("silent");
    voiceStatusText.textContent = "SILENCIADO";
    meterBarFill.style.width = "0%";
    dbfsVal.textContent = "-∞ dBFS";
  } else {
    muteToggleBtn.className = "hero-mic-btn btn-active";
    micIcon.style.display = "block";
    micOffIcon.style.display = "none";
    btnMainLabel.textContent = "Micrófono Activo • Silenciar";
    btnInstruction.textContent = "Presiona para mutear el canal instantáneamente";
  }

  // Notify backend of mute state
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mute_state", muted: isMuted }));
  }
}

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/mic`;

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("Mobile Mic WebSocket connected.");
    geminiStatusLabel.textContent = "Gemini Live Conectado";
    startPingInterval();
  };

  ws.onmessage = (event) => {
    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      }
    } catch (e) {
      console.error("WS error:", e);
    }
  };

  ws.onclose = () => {
    console.warn("Mobile WebSocket closed. Reconnecting in 2s...");
    geminiStatusLabel.textContent = "Reconectando...";
    setTimeout(connectWebSocket, 2000);
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "pong": {
      const rtt = Math.max(12, Math.round(performance.now() - pingStartTime));
      latencyVal.textContent = `${rtt}ms`;
      break;
    }
    case "init":
    case "config_update": {
      if (msg.config) {
        if (msg.config.event_title) sessionTitle.textContent = msg.config.event_title;
      }
      if (msg.state) {
        const inLang = (msg.state.input_lang || "AUTO").toUpperCase();
        const outLang = (msg.state.target_lang || "ES").toUpperCase();
        langRouteText.textContent = `${inLang} → ${outLang}`;
      }
      break;
    }
  }
}

function startPingInterval() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      pingStartTime = performance.now();
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 2500);
}

function updateStatus(active) {
  if (active) {
    liveDot.style.backgroundColor = "#34d399";
    liveStatusText.textContent = "EN VIVO";
  } else {
    liveDot.style.backgroundColor = "#ef4444";
    liveStatusText.textContent = "DETENIDO";
  }
}
