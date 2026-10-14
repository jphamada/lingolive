import os
import math
import struct
import asyncio
import logging
from typing import Optional, Callable, Dict, Any, List

try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
    FORMAT = pyaudio.paInt16
except Exception:
    pyaudio = None
    PYAUDIO_AVAILABLE = False
    FORMAT = 2  # paInt16

from google import genai
from google.genai import types

logger = logging.getLogger("translator")

CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024
MODEL = "models/gemini-3.5-live-translate-preview"

# Supported language codes and names
LANGUAGES = [
    {"code": "es", "name": "Español", "flag": "🇪🇸"},
    {"code": "en", "name": "English", "flag": "🇺🇸"},
    {"code": "pt", "name": "Português", "flag": "🇧🇷"},
    {"code": "fr", "name": "Français", "flag": "🇫🇷"},
    {"code": "de", "name": "Deutsch", "flag": "🇩🇪"},
    {"code": "it", "name": "Italiano", "flag": "🇮🇹"},
    {"code": "zh", "name": "中文 (Chino)", "flag": "🇨🇳"},
    {"code": "ja", "name": "日本語 (Japonés)", "flag": "🇯🇵"},
    {"code": "ko", "name": "한국어 (Coreano)", "flag": "🇰🇷"},
    {"code": "ru", "name": "Русский (Ruso)", "flag": "🇷🇺"},
    {"code": "ar", "name": "العربية (Árabe)", "flag": "🇸🇦"},
    {"code": "hi", "name": "हिन्दी (Hindi)", "flag": "🇮🇳"},
]

INPUT_LANGUAGES = [
    {"code": "auto", "name": "Detección Automática", "flag": "🌐"},
] + LANGUAGES


def get_audio_devices() -> List[Dict[str, Any]]:
    """List available audio input devices."""
    if not PYAUDIO_AVAILABLE:
        return []
    pya = pyaudio.PyAudio()
    devices = []
    default_index = None
    try:
        default_info = pya.get_default_input_device_info()
        default_index = default_info.get("index")
    except Exception:
        pass

    try:
        for i in range(pya.get_device_count()):
            try:
                info = pya.get_device_info_by_index(i)
                if info.get("maxInputChannels", 0) > 0:
                    devices.append({
                        "index": info["index"],
                        "name": info["name"],
                        "channels": info["maxInputChannels"],
                        "defaultSampleRate": int(info["defaultSampleRate"]),
                        "isDefault": info["index"] == default_index,
                    })
            except Exception:
                continue
    finally:
        pya.terminate()
    return devices


def calculate_rms(pcm_data: bytes) -> int:
    """Calculate RMS volume level from 0 to 100 for VU meter."""
    if not pcm_data:
        return 0
    count = len(pcm_data) // 2
    if count == 0:
        return 0
    format_str = f"<{count}h"
    try:
        shorts = struct.unpack(format_str, pcm_data)
        sum_squares = sum(s * s for s in shorts)
        rms = math.sqrt(sum_squares / count)
        # Normalize to 0-100 scale (typical speech RMS is 500-8000)
        level = int(min(100, (rms / 3000.0) * 100))
        return level
    except Exception:
        return 0


class LiveTranslator:
    def __init__(
        self,
        api_key: str,
        input_lang: str = "auto",
        target_lang: str = "es",
        device_index: Optional[int] = None,
        play_audio: bool = False,
        audio_source: str = "computer",  # "computer" or "mobile"
    ):
        self.api_key = api_key
        self.input_lang = input_lang
        self.target_lang = target_lang
        self.device_index = device_index
        self.play_audio = play_audio
        self.audio_source = audio_source

        self.is_running = False
        self.pya = None
        self.mic_stream = None
        self.speaker_stream = None

        self.session = None
        self.client = None
        self.loop_task = None

        # Queue for incoming audio chunks (from computer mic or mobile websocket)
        self.audio_in_queue: asyncio.Queue = asyncio.Queue(maxsize=100)

        # Callbacks
        self.on_translation: Optional[Callable[[Dict[str, Any]], Any]] = None
        self.on_original: Optional[Callable[[Dict[str, Any]], Any]] = None
        self.on_level: Optional[Callable[[int], Any]] = None
        self.on_status: Optional[Callable[[str, Optional[str]], Any]] = None

        # Queue for speech audio playback
        self.audio_out_queue: asyncio.Queue = asyncio.Queue()

    async def push_audio_chunk(self, data: bytes):
        """Called when audio chunk arrives from mobile device over WebSocket."""
        if not self.is_running or not data:
            return
        level = calculate_rms(data)
        self._notify_level(level)
        try:
            if self.audio_in_queue.full():
                try:
                    self.audio_in_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            await self.audio_in_queue.put(data)
        except Exception as e:
            logger.warning(f"Error queueing mobile audio chunk: {e}")

    def _notify_status(self, status: str, error: Optional[str] = None):
        if self.on_status:
            try:
                res = self.on_status(status, error)
                if asyncio.iscoroutine(res):
                    asyncio.create_task(res)
            except Exception as e:
                logger.error(f"Error in on_status callback: {e}")

    def _notify_translation(self, text: str, finished: bool = False):
        if self.on_translation:
            try:
                res = self.on_translation({"text": text, "finished": finished})
                if asyncio.iscoroutine(res):
                    asyncio.create_task(res)
            except Exception as e:
                logger.error(f"Error in on_translation callback: {e}")

    def _notify_original(self, text: str, finished: bool = False):
        if self.on_original:
            try:
                res = self.on_original({"text": text, "finished": finished})
                if asyncio.iscoroutine(res):
                    asyncio.create_task(res)
            except Exception as e:
                logger.error(f"Error in on_original callback: {e}")

    def _notify_level(self, level: int):
        if self.on_level:
            try:
                res = self.on_level(level)
                if asyncio.iscoroutine(res):
                    asyncio.create_task(res)
            except Exception:
                pass

    async def start(self):
        """Start the live translation loop."""
        if self.is_running:
            return

        self.is_running = True
        self._notify_status("connecting")

        self.client = genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=self.api_key,
        )

        self.loop_task = asyncio.create_task(self._run_loop())

    async def stop(self):
        """Stop the live translation loop."""
        if not self.is_running:
            return

        self.is_running = False
        self._notify_status("stopping")

        if self.loop_task:
            self.loop_task.cancel()
            try:
                await self.loop_task
            except asyncio.CancelledError:
                pass
            self.loop_task = None

        self._cleanup_audio()
        self._notify_status("stopped")

    def _cleanup_audio(self):
        """Clean up PyAudio streams."""
        try:
            if self.mic_stream:
                self.mic_stream.stop_stream()
                self.mic_stream.close()
                self.mic_stream = None
        except Exception as e:
            logger.warning(f"Error closing mic stream: {e}")

        try:
            if self.speaker_stream:
                self.speaker_stream.stop_stream()
                self.speaker_stream.close()
                self.speaker_stream = None
        except Exception as e:
            logger.warning(f"Error closing speaker stream: {e}")

        try:
            if self.pya:
                self.pya.terminate()
                self.pya = None
        except Exception as e:
            logger.warning(f"Error terminating PyAudio: {e}")

    async def _capture_mic(self, out_queue: asyncio.Queue):
        """Reads audio chunks from the microphone and puts them in out_queue."""
        if not PYAUDIO_AVAILABLE:
            logger.info("PyAudio not available in environment; skipping local mic capture.")
            return

        self.pya = pyaudio.PyAudio()

        input_device_idx = self.device_index
        if input_device_idx is None:
            try:
                def_dev = self.pya.get_default_input_device_info()
                input_device_idx = def_dev["index"]
            except Exception:
                input_device_idx = None

        logger.info(f"Opening microphone input device index: {input_device_idx}")
        self.mic_stream = await asyncio.to_thread(
            self.pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=SEND_SAMPLE_RATE,
            input=True,
            input_device_index=input_device_idx,
            frames_per_buffer=CHUNK_SIZE,
        )

        level_report_counter = 0

        while self.is_running:
            try:
                data = await asyncio.to_thread(
                    self.mic_stream.read,
                    CHUNK_SIZE,
                    exception_on_overflow=False,
                )
                level_report_counter += 1
                if level_report_counter % 3 == 0:  # Report VU level every ~60ms
                    level = calculate_rms(data)
                    self._notify_level(level)

                await out_queue.put(data)
            except Exception as e:
                if self.is_running:
                    logger.error(f"Error reading microphone: {e}")
                break

    async def _send_audio_to_session(self, session, out_queue: asyncio.Queue):
        """Sends audio chunks from out_queue to the Gemini Live session."""
        while self.is_running:
            try:
                data = await out_queue.get()
                await session.send_realtime_input(
                    media=types.Blob(data=data, mime_type="audio/pcm")
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error sending audio chunk to session: {e}")
                break

    async def _receive_from_session(self, session):
        """Receives live translation and transcription from Gemini Live session."""
        while self.is_running:
            try:
                turn = session.receive()
                async for response in turn:
                    if not self.is_running:
                        break

                    if response.server_content:
                        sc = response.server_content

                        # Live translated text (output_transcription)
                        if sc.output_transcription and sc.output_transcription.text:
                            text = sc.output_transcription.text
                            finished = bool(sc.output_transcription.finished)
                            self._notify_translation(text, finished)

                        # Original speech transcription (input_transcription)
                        if sc.input_transcription and sc.input_transcription.text:
                            text = sc.input_transcription.text
                            finished = bool(sc.input_transcription.finished)
                            self._notify_original(text, finished)

                        # Check for interim transcription
                        elif sc.interim_input_transcription and sc.interim_input_transcription.text:
                            text = sc.interim_input_transcription.text
                            self._notify_original(text, False)

                        # Check model_turn parts
                        if sc.model_turn:
                            for part in sc.model_turn.parts:
                                if part.text:
                                    self._notify_translation(part.text, False)
                                if part.inline_data and part.inline_data.data:
                                    if self.play_audio:
                                        self.audio_out_queue.put_nowait(part.inline_data.data)

                        if sc.interrupted:
                            # User interrupted, flush output audio queue
                            while not self.audio_out_queue.empty():
                                try:
                                    self.audio_out_queue.get_nowait()
                                except asyncio.QueueEmpty:
                                    break

            except asyncio.CancelledError:
                break
            except Exception as e:
                if self.is_running:
                    logger.error(f"Error receiving from session: {e}")
                    self._notify_status("error", str(e))
                break

    async def _play_audio_loop(self):
        """Optional task to play synthesized translated speech through speakers."""
        if not self.play_audio or not self.pya:
            return

        try:
            self.speaker_stream = await asyncio.to_thread(
                self.pya.open,
                format=FORMAT,
                channels=CHANNELS,
                rate=RECEIVE_SAMPLE_RATE,
                output=True,
            )
        except Exception as e:
            logger.warning(f"Could not open speaker stream: {e}")
            return

        while self.is_running:
            try:
                audio_bytes = await self.audio_out_queue.get()
                if self.speaker_stream and self.play_audio:
                    await asyncio.to_thread(self.speaker_stream.write, audio_bytes)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Error playing audio: {e}")
                break

    async def _run_loop(self):
        """Main connection and orchestration loop with auto-reconnect."""
        # Find language display names
        src_name = next((l["name"] for l in INPUT_LANGUAGES if l["code"] == self.input_lang), self.input_lang)
        tgt_name = next((l["name"] for l in LANGUAGES if l["code"] == self.target_lang), self.target_lang)

        system_instruction = (
            f"You are a professional simultaneous interpreter at an event. "
            f"Translate spoken speech from {src_name} into {tgt_name} in real time. "
            f"Provide clean, natural, precise translations suitable for live projection on an event screen."
        )

        input_codes = [self.input_lang] if self.input_lang != "auto" else None

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=system_instruction,
            input_audio_transcription=types.AudioTranscriptionConfig(
                language_codes=input_codes,
            ),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            translation_config=types.TranslationConfig(
                target_language_code=self.target_lang,
            ),
        )

        while self.is_running:
            try:
                logger.info(f"Connecting to Gemini Live API ({MODEL})...")
                self._notify_status("connecting")

                async with self.client.aio.live.connect(model=MODEL, config=config) as client_conn:
                    self.session = client_conn
                    self._notify_status("live")
                    logger.info("Connected and live!")

                    async with asyncio.TaskGroup() as tg:
                        if self.audio_source == "computer":
                            tg.create_task(self._capture_mic(self.audio_in_queue))
                        tg.create_task(self._send_audio_to_session(self.session, self.audio_in_queue))
                        tg.create_task(self._receive_from_session(self.session))
                        if self.play_audio:
                            tg.create_task(self._play_audio_loop())

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Session error: {e}")
                self._notify_status("error", str(e))
                if not self.is_running:
                    break
                # Backoff before reconnecting
                await asyncio.sleep(2.0)
            finally:
                self._cleanup_audio()
