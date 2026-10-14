# 🎙️ Live Event Translator (Arquitectura en 3 Dispositivos)

Sistema profesional de **traducción simultánea en tiempo real para eventos**, dividido en **3 dispositivos independientes** conectados sobre la red local Wi-Fi con **HTTPS**:

```
 ┌────────────────────────┐      Audio PCM 16kHz      ┌─────────────────────────┐
 │  1. CELULAR ESCENARIO  │ ────────────────────────> │  2. COMPUTADORA BACKEND │
 │       (/mic)           │        (WebSocket)        │   (Operador / Gemini)   │
 └────────────────────────┘                           └────────────┬────────────┘
                                                                   │
                                                Traducción         │
                                                en Tiempo Real     │
                                                                   ▼
                                                      ┌─────────────────────────┐
                                                      │ 3. PANTALLA PROYECCIÓN  │
                                                      │      (/projection)      │
                                                      └─────────────────────────┘
```

---

## 📱 Los 3 Dispositivos y sus URLs Dedicadas

| # | Dispositivo | URL | Función |
|---|---|---|---|
| **1** | **Celular en Escenario** | `https://<TU-IP>:8000/mic` | Se coloca en el atril o escenario junto al orador. Captura el audio en vivo, muestra medidor **dBFS**, visualizador de **VOZ ACTIVA**, botón de silenciar y transmite el sonido por WebSocket. |
| **2** | **Panel del Operador (Laptop)** | `https://<TU-IP>:8000/` | Pantalla de control del técnico/traductor. Configura idiomas, visualiza códigos QR para conectar el celular, monitorea transcripción y controla la proyección. |
| **3** | **Pantalla de Proyección (Beamer/LED)** | `https://<TU-IP>:8000/projection` | Laptop o display conectado al proyector de sala. Fondo sólido de alto contraste con subtítulos fluidos en pantalla completa (tecla **`F`**). |

---

## ⚡ Cómo Iniciar la Aplicación

Ejecuta en la terminal de tu computadora:

```bash
./run.sh
```

El servidor detectará automáticamente la dirección IP local de tu red (ej. `192.168.0.220`) y habilitará el protocolo **HTTPS** con certificados SSL locales para que los navegadores móviles (iOS Safari / Android Chrome) concedan acceso al micrófono sin restricciones.

---

## 📋 Guía Paso a Paso para el Evento

1. **Abrir el Panel de Control:**
   - En la laptop del técnico, se abrirá automáticamente `https://localhost:8000/` (o abre `https://<TU-IP>:8000/`).
   - Si el navegador te advierte del certificado autofirmado local, haz clic en **Avanzado -> Continuar**.

2. **Conectar el Celular en el Escenario:**
   - En el panel de control, en la tarjeta **"Dispositivos en Escenario"**, haz clic en el botón **`QR`** del Celular.
   - Con el celular conectado a la misma red Wi-Fi, abre la cámara y escanea el código QR (o abre `https://<TU-IP>:8000/mic`).
   - Pulsa **"ACTIVAR MICRÓFONO"**.
   - Verás la interfaz profesional con el medidor **-17.0 dBFS**, el visualizador de voz y el botón táctil de **Silenciar**.

3. **Abrir la Pantalla de Proyección:**
   - En la pantalla secundaria o computadora conectada al proyector, abre `https://<TU-IP>:8000/projection`.
   - Presiona la tecla **`F`** o haz **doble clic** para pantalla completa.

4. **Iniciar la Traducción:**
   - En el panel de control, verifica que la fuente de audio seleccionada sea **"📱 Celular en Escenario"**.
   - Elige los idiomas (ej. Inglés a Español).
   - Presiona **"INICIAR TRADUCCIÓN"**.
   - ¡El orador hablará frente al celular y la audiencia leerá la traducción simultánea en el proyector en tiempo real!
