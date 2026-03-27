import os
import asyncio
import threading
from dotenv import load_dotenv
from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveTranscriptionEvents,
    LiveOptions,
)

load_dotenv()

class DeepgramSession:
    """
    Manages a single Deepgram live‑transcription WebSocket connection
    for real‑time audio streaming.
    """

    def __init__(self, on_transcript, on_error=None, language="en-US"):
        """
        :param on_transcript: Callback that receives (text, language, is_final)
        :param on_error:      Optional callback that receives an error message string
        :param language:      Primary language code, e.g. "en-US"
        """
        self._on_transcript = on_transcript
        self._on_error = on_error
        self._language = language

        # Asyncio objects and thread
        self._loop = None
        self._dg_connection = None
        self._thread = None
        self._ready = threading.Event()      # Signals that connection is ready
        self._connected = False
        self._stop_requested = False
        self._start_error = None

    # ------------------------------------------------------------------
    # Public API (thread‑safe)
    # ------------------------------------------------------------------
    def start(self, timeout=15):
        """
        Starts the background thread and establishes the WebSocket connection.
        Returns True on success, False on failure (with error printed).
        """
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

        # Wait until the connection is ready or an error occurs
        self._ready.wait(timeout=timeout)

        if not self._connected:
            error_msg = self._start_error or "Deepgram connection timed out"
            print(f"[Deepgram] Connection failed: {error_msg}")
            if self._on_error:
                self._on_error(error_msg)
            return False
        return True

    def send(self, audio_bytes: bytes):
        """Send a chunk of audio (bytes) to Deepgram."""
        if not self._connected or self._stop_requested:
            return
        if self._loop and not self._loop.is_closed():
            asyncio.run_coroutine_threadsafe(
                self._async_send(audio_bytes), self._loop
            )

    def stop(self):
        """Gracefully closes the WebSocket connection and stops the background thread."""
        self._stop_requested = True

    @property
    def is_connected(self):
        return self._connected and not self._stop_requested

    # ------------------------------------------------------------------
    # Internal asyncio logic (runs in a separate thread)
    # ------------------------------------------------------------------
    def _run_loop(self):
        """Entry point for the background thread: creates an asyncio loop and runs _connect."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect())
        except Exception as e:
            self._start_error = str(e)
            self._ready.set()
        finally:
            self._loop.close()

    async def _connect(self):
        """Async part: establishes the WebSocket connection and handles events."""
        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            self._start_error = "DEEPGRAM_API_KEY not set in .env file"
            self._ready.set()
            return

        print(f"[Deepgram] Connecting (key: {api_key[:8]}...)")

        # Create Deepgram client with keepalive enabled
        config = DeepgramClientOptions(options={"keepalive": "true"})
        client = DeepgramClient(api_key, config)
        self._dg_connection = client.listen.asynclive.v("1")

        # --- Event handlers (these run inside the asyncio thread) ---
        async def on_open(client, open_evt, **kwargs):
            self._connected = True
            self._ready.set()
            print("[Deepgram] WebSocket open ✓")

        async def on_message(client, result, **kwargs):
            # Extract the transcript from the Deepgram result
            try:
                sentence = result.channel.alternatives[0].transcript
            except (AttributeError, IndexError):
                return
            if not sentence:
                return

            is_final = result.is_final
            detected_lang = getattr(result, "detected_language", None) or self._language
            self._on_transcript(sentence, detected_lang, is_final)

        async def on_error(client, error, **kwargs):
            error_msg = str(error)
            print(f"[Deepgram] Error: {error_msg!r}")
            if not self._connected:
                self._start_error = error_msg
                self._ready.set()
            if self._on_error:
                self._on_error(error_msg)


        async def on_close(client, **kwargs):
            print(f"[Deepgram] WebSocket closed")

        # Register handlers
        self._dg_connection.on(LiveTranscriptionEvents.Open, on_open)
        self._dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        self._dg_connection.on(LiveTranscriptionEvents.Error, on_error)
        self._dg_connection.on(LiveTranscriptionEvents.Close, on_close)


        options = LiveOptions(
            model="nova-3",
            language=self._language,
            punctuate=True,
            smart_format=True,
            interim_results=True,
        )
        print("[Deepgram] Starting stream (model=nova-3, WebM/Opus auto-detect)")

        # Actually start the connection (this is the WebSocket handshake)
        started = await self._dg_connection.start(options)

        if not started:
            self._start_error = "Deepgram rejected the WebSocket upgrade - check your API key or plan."
            self._ready.set()
            return

        # Keep the connection alive until stop() is called
        while not self._stop_requested:
            await asyncio.sleep(0.05)

        # Clean shutdown: close the connection if it exists
        if self._dg_connection:
            await self._dg_connection.finish()
            self._connected = False
        print("[Deepgram] Connection closed cleanly")

    async def _async_send(self, audio_bytes: bytes):
        """Internal async helper to send audio (called from send())."""
        if self._dg_connection and self._connected:
            await self._dg_connection.send(audio_bytes)