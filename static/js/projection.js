// Dedicated Event Projection Window Logic
let ws = null;
let currentConfig = {
  bg_color: "#000000",
  text_color: "#FFFFFF",
  font_size: 52,
  alignment: "center",
  display_mode: "subtitles",
  event_title: "",
  show_title: false,
  show_clock: false,
};

// State
let phrases = [];
let teleprompterBuffer = "";
let clockTimer = null;
let idleMouseTimer = null;

// DOM Elements
const body = document.getElementById("projectionBody");
const textContainer = document.getElementById("textContainer");
const emptyNotice = document.getElementById("emptyNotice");
const eventTitle = document.getElementById("eventTitle");
const clockDisplay = document.getElementById("clockDisplay");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const iconEnterFs = document.getElementById("iconEnterFs");
const iconExitFs = document.getElementById("iconExitFs");
const floatingControls = document.getElementById("floatingControls");

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  connectWebSocket();
  setupFullscreen();
  setupIdleCursor();
  setupClock();
});

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/projection`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to Projection WebSocket");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error("Error parsing WS message:", e);
    }
  };

  ws.onclose = () => {
    console.warn("Projection WebSocket closed. Reconnecting in 2s...");
    setTimeout(connectWebSocket, 2000);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case "init":
      if (msg.config) applyConfig(msg.config);
      break;

    case "config_update":
      if (msg.config) applyConfig(msg.config);
      break;

    case "translation_chunk":
      handleTranslationChunk(msg.text, msg.finished);
      break;

    case "clear_screen":
      clearScreen();
      break;
  }
}

function applyConfig(cfg) {
  Object.assign(currentConfig, cfg);

  // Background color
  if (cfg.bg_color) {
    body.style.backgroundColor = cfg.bg_color;
  }

  // Text color
  if (cfg.text_color) {
    body.style.color = cfg.text_color;
    document.documentElement.style.setProperty("--text-color", cfg.text_color);
  }

  // Font size
  if (cfg.font_size) {
    document.documentElement.style.setProperty("--font-size", `${cfg.font_size}px`);
  }

  // Alignment
  if (cfg.alignment) {
    body.classList.remove("align-center", "align-left");
    body.classList.add(`align-${cfg.alignment}`);
  }

  // Display mode
  if (cfg.display_mode) {
    body.classList.remove("mode-subtitles", "mode-teleprompter", "mode-ticker");
    body.classList.add(`mode-${cfg.display_mode}`);
  }

  // Event title
  if (cfg.event_title !== undefined) {
    eventTitle.textContent = cfg.event_title;
  }
  if (cfg.show_title !== undefined) {
    eventTitle.style.display = cfg.show_title ? "block" : "none";
  }

  // Clock
  if (cfg.show_clock !== undefined) {
    clockDisplay.style.display = cfg.show_clock ? "block" : "none";
  }
}

function handleTranslationChunk(text, finished) {
  if (emptyNotice && emptyNotice.parentNode) {
    emptyNotice.remove();
  }

  if (currentConfig.display_mode === "teleprompter") {
    teleprompterBuffer += text;
    textContainer.innerHTML = `<div class="teleprompter-text">${teleprompterBuffer}</div>`;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    return;
  }

  // Subtitle / Default mode
  if (phrases.length === 0) {
    phrases.push(text);
  } else {
    const lastIdx = phrases.length - 1;
    phrases[lastIdx] += text;

    // Check sentence boundary
    if (finished || text.includes(".") || text.includes("?") || text.includes("!")) {
      if (phrases.length >= 3) {
        phrases.shift();
      }
      phrases.push("");
    }
  }

  renderSubtitles();
}

function renderSubtitles() {
  const nonEmpty = phrases.filter(p => p.trim().length > 0);
  if (nonEmpty.length === 0) return;

  textContainer.innerHTML = nonEmpty
    .map((phrase, idx) => {
      const isLatest = idx === nonEmpty.length - 1;
      return `<div class="subtitle-line ${isLatest ? "subtitle-active" : "subtitle-dimmed"}">${phrase}</div>`;
    })
    .join("");
}

function clearScreen() {
  phrases = [];
  teleprompterBuffer = "";
  textContainer.innerHTML = `
    <div id="emptyNotice" class="empty-notice">
      <div class="pulsing-circle"></div>
      <div class="empty-text">Traducción Simultánea en Vivo</div>
    </div>
  `;
}

// Fullscreen Handling
function setupFullscreen() {
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn("Fullscreen request error:", err);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  fullscreenBtn.addEventListener("click", toggleFullscreen);

  // Double click anywhere on screen
  document.addEventListener("dblclick", toggleFullscreen);

  // Keyboard shortcut 'F' or 'F11'
  document.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
      toggleFullscreen();
    }
    if (e.key === "c" || e.key === "C") {
      clearScreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    iconEnterFs.style.display = isFs ? "none" : "block";
    iconExitFs.style.display = isFs ? "block" : "none";
  });
}

// Inactive mouse cursor hiding
function setupIdleCursor() {
  function onMouseMove() {
    document.body.style.cursor = "default";
    floatingControls.classList.add("force-visible");

    if (idleMouseTimer) clearTimeout(idleMouseTimer);
    idleMouseTimer = setTimeout(() => {
      document.body.style.cursor = "none";
      floatingControls.classList.remove("force-visible");
    }, 2500);
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mousedown", onMouseMove);
}

// Clock updates
function setupClock() {
  function updateTime() {
    const now = new Date();
    const hrs = String(now.getHours()).padStart(2, "0");
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    clockDisplay.textContent = `${hrs}:${mins}:${secs}`;
  }
  updateTime();
  clockTimer = setInterval(updateTime, 1000);
}
