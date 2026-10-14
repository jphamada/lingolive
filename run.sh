#!/bin/bash
# Live Event Simultaneous Translation Launcher (3 Devices + HTTPS)

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Ensure venv exists
if [ ! -d ".venv" ]; then
    echo "Creando entorno virtual..."
    python3 -m venv .venv
    CFLAGS="-I/opt/homebrew/include" LDFLAGS="-L/opt/homebrew/lib" .venv/bin/pip install google-genai pyaudio fastapi uvicorn websockets python-dotenv qrcode
fi

# Liberar el puerto 8000 automáticamente si quedó tomado por una ejecución previa
EXISTING_PID=$(lsof -ti :8000 2>/dev/null)
if [ -n "$EXISTING_PID" ]; then
    echo "Liberando puerto 8000 (proceso $EXISTING_PID)..."
    kill -9 $EXISTING_PID 2>/dev/null || true
    sleep 0.5
fi

# Detect Local IP
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")

echo "================================================================="
echo "  🚀 INICIANDO APP DE TRADUCCIÓN SIMULTÁNEA (3 DISPOSITIVOS)"
echo "================================================================="
echo "  📱 1. CELULAR ESCENARIO (Micrófono):  https://$LOCAL_IP:8000/mic"
echo "  🖥️ 2. PROYECTOR (Subtítulos en Vivo): https://$LOCAL_IP:8000/projection"
echo "  🎛️ 3. OPERADOR (Panel de Control):    https://$LOCAL_IP:8000/"
echo "================================================================="
echo "  Nota: Abre https://$LOCAL_IP:8000/ en tu navegador."
echo "  En el primer acceso en móvil, acepta el certificado local SSL."
echo "================================================================="

# Open operator dashboard after 1.5 seconds in background
(sleep 1.5 && open "https://localhost:8000/") &

# Run server with HTTPS
exec .venv/bin/python app.py
