import os
import io
import json
import logging
from datetime import datetime
from typing import Dict, List, Any, Optional

import qrcode
import qrcode.image.svg
from urllib.parse import parse_qs
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, Response, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from translator import LiveTranslator, get_audio_devices, INPUT_LANGUAGES, LANGUAGES
from ssl_cert import ensure_ssl_certs, get_local_ip
from auth import (
    is_authenticated,
    verify_login,
    verify_auth_token,
    generate_auth_token,
    is_auth_enabled,
    COOKIE_NAME,
    ADMIN_USERNAME,
)

# Load environment variables
load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("app")

app = FastAPI(title="Live Event Translation", version="2.0.0")

# Mount static files directory
os.makedirs("static/css", exist_ok=True)
os.makedirs("static/js", exist_ok=True)
os.makedirs("templates", exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")

# Network & Server configuration
PORT = int(os.getenv("PORT", 8000))
LOCAL_IP = ensure_ssl_certs()

DEFAULT_API_KEY = os.getenv("GEMINI_API_KEY", "")

state = {
    "api_key": DEFAULT_API_KEY,
    "input_lang": "auto",
    "target_lang": "es",
    "device_index": None,
    "play_audio": False,
    "audio_source": "mobile",  # "mobile" (on-stage phone) or "computer" (local mic)
    "status": "stopped",       # stopped, connecting, live, error
    "error_message": None,
    "started_at": None,
    "mobile_connected": False,
    "mobile_muted": False,
    "local_ip": LOCAL_IP,
    "port": PORT,
    "auth_enabled": is_auth_enabled(),
    "auth_token": generate_auth_token() if is_auth_enabled() else "",
    "urls": {
        "mobile": f"https://{LOCAL_IP}:{PORT}/mic",
        "projection": f"https://{LOCAL_IP}:{PORT}/projection",
        "admin": f"https://{LOCAL_IP}:{PORT}/",
    },
}

# Projection style configuration
projection_config = {
    "bg_color": "#000000",
    "text_color": "#FFFFFF",
    "font_size": 52,
    "font_family": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    "alignment": "center",
    "display_mode": "subtitles",  # "subtitles", "teleprompter", "ticker"
    "text_shadow": True,
    "event_title": "Traducción Simultánea en Vivo",
    "show_title": False,
    "show_clock": False,
}

# In-memory history for transcript export
transcript_history: List[Dict[str, Any]] = []

# Active LiveTranslator instance
active_translator: Optional[LiveTranslator] = None


class ConnectionManager:
    def __init__(self):
        self.admin_websockets: List[WebSocket] = []
        self.projection_websockets: List[WebSocket] = []
        self.mobile_websockets: List[WebSocket] = []

    async def connect_admin(self, ws: WebSocket):
        await ws.accept()
        self.admin_websockets.append(ws)

    def disconnect_admin(self, ws: WebSocket):
        if ws in self.admin_websockets:
            self.admin_websockets.remove(ws)

    async def connect_projection(self, ws: WebSocket):
        await ws.accept()
        self.projection_websockets.append(ws)

    def disconnect_projection(self, ws: WebSocket):
        if ws in self.projection_websockets:
            self.projection_websockets.remove(ws)

    async def connect_mobile(self, ws: WebSocket):
        await ws.accept()
        self.mobile_websockets.append(ws)

    def disconnect_mobile(self, ws: WebSocket):
        if ws in self.mobile_websockets:
            self.mobile_websockets.remove(ws)

    async def broadcast_to_admins(self, message: Dict[str, Any]):
        for ws in list(self.admin_websockets):
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect_admin(ws)

    async def broadcast_to_projections(self, message: Dict[str, Any]):
        for ws in list(self.projection_websockets):
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect_projection(ws)

    async def broadcast_to_mobiles(self, message: Dict[str, Any]):
        for ws in list(self.mobile_websockets):
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect_mobile(ws)

    async def broadcast_all(self, message: Dict[str, Any]):
        await self.broadcast_to_admins(message)
        await self.broadcast_to_projections(message)
        await self.broadcast_to_mobiles(message)


manager = ConnectionManager()


# Callback handlers for LiveTranslator
async def on_translation_received(data: Dict[str, Any]):
    text = data.get("text", "")
    finished = data.get("finished", False)
    timestamp = datetime.now().strftime("%H:%M:%S")

    entry = {
        "type": "translation",
        "text": text,
        "finished": finished,
        "timestamp": timestamp,
    }
    transcript_history.append(entry)

    # Broadcast to projection screens
    await manager.broadcast_to_projections({
        "type": "translation_chunk",
        "text": text,
        "finished": finished,
        "timestamp": timestamp,
    })

    # Broadcast to admin control panels
    await manager.broadcast_to_admins({
        "type": "translation_chunk",
        "text": text,
        "finished": finished,
        "timestamp": timestamp,
    })


async def on_original_received(data: Dict[str, Any]):
    text = data.get("text", "")
    finished = data.get("finished", False)
    timestamp = datetime.now().strftime("%H:%M:%S")

    entry = {
        "type": "original",
        "text": text,
        "finished": finished,
        "timestamp": timestamp,
    }
    transcript_history.append(entry)

    # Broadcast to admin panels for monitoring
    await manager.broadcast_to_admins({
        "type": "original_chunk",
        "text": text,
        "finished": finished,
        "timestamp": timestamp,
    })


async def on_audio_level_received(level: int):
    await manager.broadcast_to_admins({
        "type": "audio_level",
        "level": level,
    })


async def on_status_changed(status: str, error: Optional[str] = None):
    state["status"] = status
    state["error_message"] = error
    if status == "live":
        state["started_at"] = datetime.now().strftime("%H:%M:%S")

    await manager.broadcast_all({
        "type": "status_update",
        "status": status,
        "error": error,
        "started_at": state["started_at"],
    })


# Authentication Routes
@app.get("/login", response_class=HTMLResponse)
async def serve_login(request: Request):
    if is_authenticated(request):
        next_url = request.query_params.get("next", "/") or "/"
        return RedirectResponse(url=next_url, status_code=303)
    with open("templates/login.html", "r", encoding="utf-8") as f:
        return f.read()


@app.post("/login")
async def handle_login(request: Request):
    body = (await request.body()).decode("utf-8")
    data = parse_qs(body)
    username = data.get("username", [""])[0]
    password = data.get("password", [""])[0]
    next_url = data.get("next", ["/"])[0] or "/"

    if verify_login(username, password):
        response = RedirectResponse(url=next_url, status_code=303)
        response.set_cookie(
            key=COOKIE_NAME,
            value=generate_auth_token(),
            httponly=True,
            max_age=60 * 60 * 24 * 7,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
        return response

    return RedirectResponse(url=f"/login?error=1&next={next_url}", status_code=303)


@app.get("/logout")
async def handle_logout():
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(COOKIE_NAME)
    return response


# HTML Page Routes (Separation of 3 devices)
@app.get("/", response_class=HTMLResponse)
@app.get("/admin", response_class=HTMLResponse)
async def serve_admin_panel(request: Request):
    """Device 1: Operator / Technician Control Panel"""
    if not is_authenticated(request):
        return RedirectResponse(url="/login?next=/", status_code=303)
    with open("templates/index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.get("/mic", response_class=HTMLResponse)
@app.get("/mobile", response_class=HTMLResponse)
async def serve_mobile_mic(request: Request):
    """Device 2: On-stage Smartphone Microphone Capture App"""
    if not is_authenticated(request):
        return RedirectResponse(url=f"/login?next={request.url.path}", status_code=303)
    
    token = request.query_params.get("token")
    with open("templates/mobile.html", "r", encoding="utf-8") as f:
        html = f.read()
    response = HTMLResponse(content=html)
    if token and verify_auth_token(token):
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            httponly=True,
            max_age=60 * 60 * 24 * 7,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
    return response


@app.get("/projection", response_class=HTMLResponse)
async def serve_projection_screen(request: Request):
    """Device 3: Event Beamer / LED Wall Projection Subtitle Screen"""
    if not is_authenticated(request):
        return RedirectResponse(url=f"/login?next={request.url.path}", status_code=303)

    token = request.query_params.get("token")
    with open("templates/projection.html", "r", encoding="utf-8") as f:
        html = f.read()
    response = HTMLResponse(content=html)
    if token and verify_auth_token(token):
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            httponly=True,
            max_age=60 * 60 * 24 * 7,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
    return response


# QR Code Generator Endpoint
@app.get("/api/qr")
async def get_qr_code(url: str = Query(...)):
    """Generates an SVG QR code for fast mobile and projection connection."""
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


# REST API Endpoints
@app.get("/api/devices")
async def list_devices():
    return {"devices": get_audio_devices()}


@app.get("/api/languages")
async def list_languages():
    return {
        "input_languages": INPUT_LANGUAGES,
        "target_languages": LANGUAGES,
    }


@app.get("/api/config")
async def get_config():
    return {
        "state": state,
        "projection_config": projection_config,
    }


class StartRequest(BaseModel):
    input_lang: Optional[str] = None
    target_lang: Optional[str] = None
    device_index: Optional[int] = None
    play_audio: Optional[bool] = None
    audio_source: Optional[str] = None
    api_key: Optional[str] = None


@app.post("/api/start")
async def start_translation(req: StartRequest, request: Request):
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    global active_translator

    if req.input_lang:
        state["input_lang"] = req.input_lang
    if req.target_lang:
        state["target_lang"] = req.target_lang
    if req.device_index is not None:
        state["device_index"] = req.device_index if req.device_index >= 0 else None
    if req.play_audio is not None:
        state["play_audio"] = req.play_audio
    if req.audio_source:
        state["audio_source"] = req.audio_source
    if req.api_key:
        state["api_key"] = req.api_key.strip()

    if active_translator and active_translator.is_running:
        await active_translator.stop()

    active_translator = LiveTranslator(
        api_key=state["api_key"],
        input_lang=state["input_lang"],
        target_lang=state["target_lang"],
        device_index=state["device_index"],
        play_audio=state["play_audio"],
        audio_source=state["audio_source"],
    )

    active_translator.on_translation = on_translation_received
    active_translator.on_original = on_original_received
    active_translator.on_level = on_audio_level_received
    active_translator.on_status = on_status_changed

    await active_translator.start()
    return {"ok": True, "state": state}


@app.post("/api/stop")
async def stop_translation(request: Request):
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    global active_translator
    if active_translator and active_translator.is_running:
        await active_translator.stop()
        active_translator = None
    state["status"] = "stopped"
    state["error_message"] = None
    await manager.broadcast_all({
        "type": "status_update",
        "status": "stopped",
        "error": None,
    })
    return {"ok": True, "state": state}


@app.post("/api/clear")
async def clear_projection(request: Request):
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    await manager.broadcast_to_projections({"type": "clear_screen"})
    await manager.broadcast_to_admins({"type": "screen_cleared"})
    return {"ok": True}


class StyleRequest(BaseModel):
    bg_color: Optional[str] = None
    text_color: Optional[str] = None
    font_size: Optional[int] = None
    font_family: Optional[str] = None
    alignment: Optional[str] = None
    display_mode: Optional[str] = None
    text_shadow: Optional[bool] = None
    event_title: Optional[str] = None
    show_title: Optional[bool] = None
    show_clock: Optional[bool] = None


@app.post("/api/config/projection")
async def update_projection_config(req: StyleRequest, request: Request):
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    req_dict = req.model_dump(exclude_none=True)
    projection_config.update(req_dict)

    await manager.broadcast_all({
        "type": "config_update",
        "config": projection_config,
        "state": state,
    })
    return {"ok": True, "config": projection_config}


@app.get("/api/history")
async def get_history():
    return {"history": transcript_history}


@app.get("/api/export")
async def export_transcript():
    lines = [
        f"=== REPORTE DE TRADUCCIÓN SIMULTÁNEA ===",
        f"Fecha: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Fuente de Audio: {state['audio_source'].upper()}",
        f"Idioma Origen: {state['input_lang']}",
        f"Idioma Destino: {state['target_lang']}",
        f"=" * 40,
        "",
    ]
    for item in transcript_history:
        prefix = "[TRADUCCIÓN]" if item["type"] == "translation" else "[ORIGINAL]"
        lines.append(f"{item['timestamp']} {prefix} {item['text']}")

    return PlainTextResponse(
        "\n".join(lines),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=transcripcion_evento.txt"},
    )


# WebSocket Endpoints
@app.websocket("/ws/admin")
async def websocket_admin(websocket: WebSocket):
    if not is_authenticated(websocket):
        await websocket.close(code=4401)
        return
    await manager.connect_admin(websocket)
    # Send initial state
    await websocket.send_json({
        "type": "init",
        "state": state,
        "config": projection_config,
    })
    try:
        while True:
            raw_data = await websocket.receive_text()
            data = json.loads(raw_data)
            action = data.get("action")
            if action == "clear":
                await clear_projection(websocket)
    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)
    except Exception as e:
        logger.warning(f"Admin websocket error: {e}")
        manager.disconnect_admin(websocket)


@app.websocket("/ws/projection")
async def websocket_projection(websocket: WebSocket):
    if not is_authenticated(websocket):
        await websocket.close(code=4401)
        return
    await manager.connect_projection(websocket)
    # Send initial config to projection screen
    await websocket.send_json({
        "type": "init",
        "config": projection_config,
        "status": state["status"],
    })
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_projection(websocket)
    except Exception as e:
        logger.warning(f"Projection websocket error: {e}")
        manager.disconnect_projection(websocket)


@app.websocket("/ws/mic")
async def websocket_mobile_mic(websocket: WebSocket):
    """Handles binary PCM audio streaming and controls from on-stage smartphone."""
    if not is_authenticated(websocket):
        await websocket.close(code=4401)
        return
    await manager.connect_mobile(websocket)
    state["mobile_connected"] = True

    logger.info("Mobile device connected to /ws/mic")
    await manager.broadcast_to_admins({
        "type": "mobile_status",
        "connected": True,
        "muted": state["mobile_muted"],
    })

    # Send initial config to mobile
    await websocket.send_json({
        "type": "init",
        "config": projection_config,
        "state": state,
    })

    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message and message["bytes"]:
                # Binary audio chunk from mobile microphone
                pcm_data = message["bytes"]
                if active_translator and active_translator.is_running and state["audio_source"] == "mobile":
                    await active_translator.push_audio_chunk(pcm_data)

            elif "text" in message and message["text"]:
                # JSON control message
                try:
                    payload = json.loads(message["text"])
                    msg_type = payload.get("type")
                    if msg_type == "ping":
                        await websocket.send_json({"type": "pong"})
                    elif msg_type == "mute_state":
                        state["mobile_muted"] = bool(payload.get("muted", False))
                        await manager.broadcast_to_admins({
                            "type": "mobile_status",
                            "connected": True,
                            "muted": state["mobile_muted"],
                        })
                except Exception:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Mobile websocket error: {e}")
    finally:
        manager.disconnect_mobile(websocket)
        state["mobile_connected"] = len(manager.mobile_websockets) > 0
        logger.info("Mobile device disconnected from /ws/mic")
        await manager.broadcast_to_admins({
            "type": "mobile_status",
            "connected": state["mobile_connected"],
            "muted": state["mobile_muted"],
        })


if __name__ == "__main__":
    import uvicorn

    # Cloud platforms (Railway, Render, Fly.io) terminate SSL at their reverse proxy.
    is_cloud = bool(
        os.getenv("RAILWAY_ENVIRONMENT")
        or os.getenv("RENDER")
        or os.getenv("FLY_APP_NAME")
        or os.getenv("DYNO")
    )

    ssl_kwargs = {}
    scheme = "http"
    if not is_cloud and os.path.exists("key.pem") and os.path.exists("cert.pem") and os.getenv("NO_SSL", "0") != "1":
        ssl_kwargs = {
            "ssl_keyfile": "key.pem",
            "ssl_certfile": "cert.pem",
        }
        scheme = "https"

    logger.info("=" * 60)
    logger.info(f"  🚀 LIVE EVENT SIMULTANEOUS TRANSLATOR ({scheme.upper()})")
    logger.info("=" * 60)
    logger.info(f"  📱 CELULAR (Micrófono Escenario):  {scheme}://{LOCAL_IP}:{PORT}/mic")
    logger.info(f"  🖥️ PROYECTOR (Pantalla Evento):     {scheme}://{LOCAL_IP}:{PORT}/projection")
    logger.info(f"  🎛️ OPERADOR (Panel de Control):     {scheme}://{LOCAL_IP}:{PORT}/")
    logger.info("=" * 60)

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=PORT,
        reload=False,
        **ssl_kwargs,
    )
