// Admin Control Panel Logic
let ws = null;
let sessionRunning = false;
let sessionStartTime = null;
let timerInterval = null;

// DOM Elements
const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const sessionTimer = document.getElementById("sessionTimer");
const toggleSessionBtn = document.getElementById("toggleSessionBtn");
const toggleSessionText = document.getElementById("toggleSessionText");
const iconPlay = toggleSessionBtn.querySelector(".icon-play");
const iconStop = toggleSessionBtn.querySelector(".icon-stop");
const clearScreenBtn = document.getElementById("clearScreenBtn");
const openProjectionBtn = document.getElementById("openProjectionBtn");
const swapLangsBtn = document.getElementById("swapLangsBtn");

// Network & 3 Devices elements
const networkIpBadge = document.getElementById("networkIpBadge");
const sourceMobileBtn = document.getElementById("sourceMobileBtn");
const sourceComputerBtn = document.getElementById("sourceComputerBtn");
const mobileUrlInput = document.getElementById("mobileUrlInput");
const projectionUrlInput = document.getElementById("projectionUrlInput");
const mobileStatusBadge = document.getElementById("mobileStatusBadge");
const projectionStatusBadge = document.getElementById("projectionStatusBadge");
const qrBox = document.getElementById("qrBox");
const qrTitle = document.getElementById("qrTitle");
const qrImgWrapper = document.getElementById("qrImgWrapper");
const closeQrBtn = document.getElementById("closeQrBtn");
const deviceSelectGroup = document.getElementById("deviceSelectGroup");

// Audio & Languages
const inputLangSelect = document.getElementById("inputLang");
const targetLangSelect = document.getElementById("targetLang");
const deviceSelect = document.getElementById("deviceSelect");
const playAudioToggle = document.getElementById("playAudioToggle");

const vuBar = document.getElementById("vuBar");
const audioLevelPct = document.getElementById("audioLevelPct");

// Projection controls
const bgColorPicker = document.getElementById("bgColorPicker");
const textColorPicker = document.getElementById("textColorPicker");
const fontSizeRange = document.getElementById("fontSizeRange");
const fontSizeVal = document.getElementById("fontSizeVal");
const displayModeSelect = document.getElementById("displayModeSelect");
const eventTitleInput = document.getElementById("eventTitleInput");
const showTitleToggle = document.getElementById("showTitleToggle");
const showClockToggle = document.getElementById("showClockToggle");

// Monitor elements
const simScreen = document.getElementById("simScreen");
const simTitle = document.getElementById("simTitle");
const simTextContainer = document.getElementById("simTextContainer");
const originalTranscriptBox = document.getElementById("originalTranscriptBox");
const historyList = document.getElementById("historyList");
const copyTranslationBtn = document.getElementById("copyTranslationBtn");

// Active state & phrases
let activeAudioSource = "mobile"; // "mobile" or "computer"
let recentTranslationPhrases = [];
let fullTranslationAccum = "";
let currentOriginalText = "";
let serverUrls = {};

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  await loadLanguages();
  await loadAudioDevices();
  await loadInitialConfig();
  connectWebSocket();
  setupEventListeners();
});

// Load supported languages
async function loadLanguages() {
  try {
    const res = await fetch("/api/languages");
    const data = await res.json();

    // Populate input languages
    inputLangSelect.innerHTML = data.input_languages
      .map(l => `<option value="${l.code}">${l.flag} ${l.name}</option>`)
      .join("");

    // Populate target languages
    targetLangSelect.innerHTML = data.target_languages
      .map(l => `<option value="${l.code}">${l.flag} ${l.name}</option>`)
      .join("");

    inputLangSelect.value = "auto";
    targetLangSelect.value = "es";
  } catch (err) {
    console.error("Error loading languages:", err);
  }
}

// Load microphone input devices
async function loadAudioDevices() {
  try {
    const res = await fetch("/api/devices");
    const data = await res.json();

    if (!data.devices || data.devices.length === 0) {
      deviceSelect.innerHTML = `<option value="-1">Micrófono predeterminado del sistema</option>`;
      return;
    }

    deviceSelect.innerHTML = [
      `<option value="-1">🎙️ Predeterminado del sistema</option>`,
      ...data.devices.map(d => 
        `<option value="${d.index}">${d.isDefault ? "⭐ " : ""}${d.name} (${d.channels} ch)</option>`
      )
    ].join("");
  } catch (err) {
    console.error("Error loading audio devices:", err);
  }
}

// Load initial config from server
async function loadInitialConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();

    if (data.state) {
      if (data.state.input_lang) inputLangSelect.value = data.state.input_lang;
      if (data.state.target_lang) targetLangSelect.value = data.state.target_lang;
      if (data.state.play_audio !== undefined) playAudioToggle.checked = data.state.play_audio;
      if (data.state.audio_source) setAudioSource(data.state.audio_source);

      const logoutBtn = document.getElementById("logoutBtn");
      if (data.state.auth_enabled && logoutBtn) {
        logoutBtn.style.display = "inline-flex";
      }

      if (data.state.urls) {
        const tokenSuffix = (data.state.auth_enabled && data.state.auth_token)
          ? `?token=${encodeURIComponent(data.state.auth_token)}`
          : "";
        serverUrls = {
          mobile: `${window.location.origin}/mic${tokenSuffix}`,
          projection: `${window.location.origin}/projection${tokenSuffix}`,
          admin: `${window.location.origin}/`,
        };
        mobileUrlInput.value = serverUrls.mobile;
        projectionUrlInput.value = serverUrls.projection;
      }
      if (data.state.local_ip) {
        networkIpBadge.textContent = window.location.hostname;
      }
      updateMobileStatus(data.state.mobile_connected, data.state.mobile_muted);
      updateStatus(data.state.status);
    }

    if (data.projection_config) {
      applyProjectionConfigToUI(data.projection_config);
    }
  } catch (err) {
    console.error("Error loading config:", err);
  }
}

function setAudioSource(source) {
  activeAudioSource = source;
  if (source === "mobile") {
    sourceMobileBtn.classList.add("active");
    sourceComputerBtn.classList.remove("active");
    deviceSelectGroup.style.display = "none";
  } else {
    sourceComputerBtn.classList.add("active");
    sourceMobileBtn.classList.remove("active");
    deviceSelectGroup.style.display = "flex";
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Audio source tabs
  sourceMobileBtn.addEventListener("click", () => setAudioSource("mobile"));
  sourceComputerBtn.addEventListener("click", () => setAudioSource("computer"));

  // QR Code buttons
  document.querySelectorAll(".show-qr-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.getAttribute("data-url");
      const url = type === "mobile" ? serverUrls.mobile : serverUrls.projection;
      const title = type === "mobile" 
        ? "📱 Escanear con el Celular del Escenario" 
        : "🖥️ Escanear para Pantalla de Proyección";
      showQrCode(url, title);
    });
  });

  closeQrBtn.addEventListener("click", () => {
    qrBox.style.display = "none";
  });

  // Copy URL buttons
  document.querySelectorAll(".copy-url-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.getAttribute("data-url");
      const url = type === "mobile" ? serverUrls.mobile : serverUrls.projection;
      navigator.clipboard.writeText(url);
      btn.style.color = "#34d399";
      setTimeout(() => { btn.style.color = ""; }, 1500);
    });
  });

  // Start / Stop session
  toggleSessionBtn.addEventListener("click", toggleSession);

  // Clear screen
  clearScreenBtn.addEventListener("click", async () => {
    await fetch("/api/clear", { method: "POST" });
    clearLocalScreen();
  });

  // Open Projection Window
  openProjectionBtn.addEventListener("click", () => {
    const win = window.open(
      "/projection",
      "ProyeccionEvento",
      "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no,resizable=yes"
    );
    if (win) win.focus();
  });

  // Swap languages
  swapLangsBtn.addEventListener("click", () => {
    const currentIn = inputLangSelect.value;
    const currentTgt = targetLangSelect.value;
    if (currentIn !== "auto") {
      inputLangSelect.value = currentTgt;
      targetLangSelect.value = currentIn;
    }
  });

  // Color preset buttons
  document.querySelectorAll(".color-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".color-preset").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const color = btn.getAttribute("data-color");
      bgColorPicker.value = color;
      updateProjectionConfig({ bg_color: color });
    });
  });

  bgColorPicker.addEventListener("input", (e) => {
    document.querySelectorAll(".color-preset").forEach(b => b.classList.remove("active"));
    updateProjectionConfig({ bg_color: e.target.value });
  });

  // Text color presets
  document.querySelectorAll(".text-color-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".text-color-preset").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const color = btn.getAttribute("data-color");
      textColorPicker.value = color;
      updateProjectionConfig({ text_color: color });
    });
  });

  textColorPicker.addEventListener("input", (e) => {
    document.querySelectorAll(".text-color-preset").forEach(b => b.classList.remove("active"));
    updateProjectionConfig({ text_color: e.target.value });
  });

  // Font size slider
  fontSizeRange.addEventListener("input", (e) => {
    fontSizeVal.textContent = `${e.target.value}px`;
    updateProjectionConfig({ font_size: parseInt(e.target.value) });
  });

  // Display mode
  displayModeSelect.addEventListener("change", (e) => {
    updateProjectionConfig({ display_mode: e.target.value });
  });

  // Text Alignment buttons
  document.querySelectorAll(".btn-toggle[data-align]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-toggle[data-align]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      updateProjectionConfig({ alignment: btn.getAttribute("data-align") });
    });
  });

  // Title and Clock
  eventTitleInput.addEventListener("input", (e) => {
    updateProjectionConfig({ event_title: e.target.value });
  });

  showTitleToggle.addEventListener("change", (e) => {
    updateProjectionConfig({ show_title: e.target.checked });
  });

  showClockToggle.addEventListener("change", (e) => {
    updateProjectionConfig({ show_clock: e.target.checked });
  });

  // Copy current translation
  copyTranslationBtn.addEventListener("click", () => {
    if (fullTranslationAccum) {
      navigator.clipboard.writeText(fullTranslationAccum);
      copyTranslationBtn.querySelector("span").textContent = "¡Copiado!";
      setTimeout(() => {
        copyTranslationBtn.querySelector("span").textContent = "Copiar";
      }, 1500);
    }
  });
}

async function showQrCode(url, title) {
  qrTitle.textContent = title;
  qrImgWrapper.innerHTML = `<span style="color:#666;font-size:0.8rem;">Cargando QR...</span>`;
  qrBox.style.display = "flex";

  try {
    const res = await fetch(`/api/qr?url=${encodeURIComponent(url)}`);
    const svgText = await res.text();
    qrImgWrapper.innerHTML = svgText;
  } catch (err) {
    qrImgWrapper.innerHTML = `<span style="color:red;">Error cargando QR</span>`;
  }
}

// Toggle Session (Start / Stop)
async function toggleSession() {
  if (sessionRunning) {
    toggleSessionBtn.disabled = true;
    try {
      await fetch("/api/stop", { method: "POST" });
    } finally {
      toggleSessionBtn.disabled = false;
    }
  } else {
    toggleSessionBtn.disabled = true;
    try {
      const payload = {
        input_lang: inputLangSelect.value,
        target_lang: targetLangSelect.value,
        device_index: parseInt(deviceSelect.value),
        play_audio: playAudioToggle.checked,
        audio_source: activeAudioSource,
      };
      await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Error starting translation:", err);
      alert("Error al iniciar la traducción: " + err);
    } finally {
      toggleSessionBtn.disabled = false;
    }
  }
}

// Send projection config update
async function updateProjectionConfig(partialConfig) {
  applyProjectionConfigToSimulator(partialConfig);
  try {
    await fetch("/api/config/projection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partialConfig),
    });
  } catch (err) {
    console.error("Error updating projection config:", err);
  }
}

function applyProjectionConfigToUI(cfg) {
  if (cfg.bg_color) {
    bgColorPicker.value = cfg.bg_color;
    document.querySelectorAll(".color-preset").forEach(b => {
      b.classList.toggle("active", b.getAttribute("data-color").toLowerCase() === cfg.bg_color.toLowerCase());
    });
  }
  if (cfg.text_color) {
    textColorPicker.value = cfg.text_color;
    document.querySelectorAll(".text-color-preset").forEach(b => {
      b.classList.toggle("active", b.getAttribute("data-color").toLowerCase() === cfg.text_color.toLowerCase());
    });
  }
  if (cfg.font_size) {
    fontSizeRange.value = cfg.font_size;
    fontSizeVal.textContent = `${cfg.font_size}px`;
  }
  if (cfg.display_mode) {
    displayModeSelect.value = cfg.display_mode;
  }
  if (cfg.alignment) {
    document.querySelectorAll(".btn-toggle[data-align]").forEach(b => {
      b.classList.toggle("active", b.getAttribute("data-align") === cfg.alignment);
    });
  }
  if (cfg.event_title !== undefined) {
    eventTitleInput.value = cfg.event_title;
  }
  if (cfg.show_title !== undefined) {
    showTitleToggle.checked = cfg.show_title;
  }
  if (cfg.show_clock !== undefined) {
    showClockToggle.checked = cfg.show_clock;
  }

  applyProjectionConfigToSimulator(cfg);
}

function applyProjectionConfigToSimulator(cfg) {
  if (cfg.bg_color) simScreen.style.backgroundColor = cfg.bg_color;
  if (cfg.text_color) simTextContainer.style.color = cfg.text_color;
  if (cfg.alignment) simTextContainer.style.textAlign = cfg.alignment;
  if (cfg.show_title !== undefined) {
    simTitle.style.display = cfg.show_title ? "block" : "none";
  }
  if (cfg.event_title) {
    simTitle.textContent = cfg.event_title;
  }
}

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/admin`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("WebSocket connected to Admin backend");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error("WS Parse error:", e);
    }
  };

  ws.onclose = () => {
    console.warn("WebSocket disconnected. Reconnecting in 2s...");
    setTimeout(connectWebSocket, 2000);
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "status_update":
      updateStatus(msg.status, msg.error);
      break;

    case "mobile_status":
      updateMobileStatus(msg.connected, msg.muted);
      break;

    case "audio_level":
      updateAudioLevel(msg.level);
      break;

    case "translation_chunk":
      handleTranslationChunk(msg.text, msg.finished, msg.timestamp);
      break;

    case "original_chunk":
      handleOriginalChunk(msg.text, msg.finished, msg.timestamp);
      break;

    case "clear_screen":
    case "screen_cleared":
      clearLocalScreen();
      break;

    case "config_update":
      if (msg.config) applyProjectionConfigToSimulator(msg.config);
      break;
  }
}

function updateMobileStatus(connected, muted) {
  if (!connected) {
    mobileStatusBadge.className = "device-status-badge badge-offline";
    mobileStatusBadge.textContent = "Desconectado";
  } else if (muted) {
    mobileStatusBadge.className = "device-status-badge badge-offline";
    mobileStatusBadge.style.color = "#f87171";
    mobileStatusBadge.textContent = "🔇 Silenciado";
  } else {
    mobileStatusBadge.className = "device-status-badge badge-online";
    mobileStatusBadge.textContent = "🟢 Conectado";
  }
}

function updateStatus(status, errorMsg) {
  statusPill.className = "status-pill";
  if (status === "live") {
    statusPill.classList.add("status-live");
    statusText.textContent = "EN VIVO";
    sessionRunning = true;
    toggleSessionBtn.className = "btn btn-hero btn-stop";
    toggleSessionText.textContent = "DETENER TRADUCCIÓN";
    iconPlay.style.display = "none";
    iconStop.style.display = "inline-block";
    startTimer();
  } else if (status === "connecting") {
    statusPill.classList.add("status-connecting");
    statusText.textContent = "CONECTANDO...";
    sessionRunning = false;
    toggleSessionBtn.className = "btn btn-hero btn-start";
    toggleSessionText.textContent = "CONECTANDO...";
    iconPlay.style.display = "inline-block";
    iconStop.style.display = "none";
  } else if (status === "error") {
    statusPill.classList.add("status-stopped");
    statusText.textContent = "ERROR";
    sessionRunning = false;
    toggleSessionBtn.className = "btn btn-hero btn-start";
    toggleSessionText.textContent = "INICIAR TRADUCCIÓN";
    iconPlay.style.display = "inline-block";
    iconStop.style.display = "none";
    stopTimer();
    if (errorMsg) alert("Error en sesión: " + errorMsg);
  } else {
    statusPill.classList.add("status-stopped");
    statusText.textContent = "DETENIDO";
    sessionRunning = false;
    toggleSessionBtn.className = "btn btn-hero btn-start";
    toggleSessionText.textContent = "INICIAR TRADUCCIÓN";
    iconPlay.style.display = "inline-block";
    iconStop.style.display = "none";
    stopTimer();
    updateAudioLevel(0);
  }
}

function updateAudioLevel(level) {
  vuBar.style.width = `${level}%`;
  audioLevelPct.textContent = `${level}%`;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  sessionStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, "0");
    const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    sessionTimer.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function handleTranslationChunk(text, finished, timestamp) {
  fullTranslationAccum += text;

  // Add to recent phrases list
  if (recentTranslationPhrases.length === 0) {
    recentTranslationPhrases.push(text);
  } else {
    const lastIdx = recentTranslationPhrases.length - 1;
    recentTranslationPhrases[lastIdx] += text;
    if (finished || text.includes(".") || text.includes("?") || text.includes("!")) {
      if (recentTranslationPhrases.length > 3) {
        recentTranslationPhrases.shift();
      }
      recentTranslationPhrases.push("");
    }
  }

  renderSimulatorText();
  appendHistory("translation", text, timestamp);
}

function handleOriginalChunk(text, finished, timestamp) {
  currentOriginalText += text;
  originalTranscriptBox.innerHTML = `<span>${currentOriginalText}</span>`;
  originalTranscriptBox.scrollTop = originalTranscriptBox.scrollHeight;
  appendHistory("original", text, timestamp);
}

function renderSimulatorText() {
  const nonEmpty = recentTranslationPhrases.filter(p => p.trim().length > 0);
  if (nonEmpty.length === 0) {
    simTextContainer.innerHTML = `<p class="sim-placeholder">Traducción simultánea activa...</p>`;
    return;
  }

  simTextContainer.innerHTML = nonEmpty
    .map((phrase, idx) => {
      const isLatest = idx === nonEmpty.length - 1;
      return `<div class="${isLatest ? "sim-recent-phrase" : "sim-old-phrase"}">${phrase}</div>`;
    })
    .join("");
}

function clearLocalScreen() {
  recentTranslationPhrases = [];
  fullTranslationAccum = "";
  currentOriginalText = "";
  simTextContainer.innerHTML = `<p class="sim-placeholder">Pantalla del proyector en blanco (limpia)</p>`;
  originalTranscriptBox.innerHTML = `<span class="placeholder-text">Pantalla limpiada. Esperando voz...</span>`;
}

function appendHistory(type, text, timestamp) {
  const empty = historyList.querySelector(".history-empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "history-item";

  const isTrans = type === "translation";
  item.innerHTML = `
    <span class="history-time">${timestamp || ""}</span>
    <span class="history-badge ${isTrans ? "badge-trans" : "badge-orig"}">${isTrans ? "TRAD" : "ORIG"}</span>
    <span class="history-text">${text}</span>
  `;

  historyList.appendChild(item);
  historyList.scrollTop = historyList.scrollHeight;
}
