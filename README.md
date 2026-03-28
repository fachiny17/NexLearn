# NexLearn — AI Voice Transcription System

> Real-time speech-to-text for classrooms, powered by Deepgram Nova-3 and Flask.

NexLearn captures a teacher's voice through the browser microphone and transcribes it live as students watch. No file uploads, no delays just speak and see the words appear in real time. Transcriptions and summaries can be downloaded instantly as text files.

---

## Features

- **Live transcription** — Audio streams directly from the browser to Deepgram via WebSocket. Words appear on screen within seconds of being spoken.
- **Interim + final results** — Interim results show words as they're detected; final results lock them in with punctuation and smart formatting.
- **Auto language detection** — Deepgram detects the spoken language automatically and displays it as a badge during recording.
- **Pause / Resume** — Recording can be paused and resumed without losing any transcribed text.
- **Two-phase timer** — A connecting clock shows how long the Deepgram handshake takes. Once live, a separate recording timer starts from zero.
- **Summary generation** — Extracts a concise summary from the transcribed text on demand.
- **Download** — Export the full transcription or summary as a `.txt` file directly from the browser.
- **Multi-client sessions** — Each browser tab gets its own isolated session. Multiple users can record simultaneously without interference.
- **Animated UI** — Starfield background, audio visualizer bars, glowing cards, and smooth transitions throughout.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, Flask, Flask-SocketIO, Gevent |
| Transcription | Deepgram Nova-3 (live WebSocket) |
| Frontend | Vanilla JS, Socket.IO client |
| Audio | Browser MediaRecorder API (WebM/Opus) |
| Deployment | Render |

---

## Project Structure

```
NexLearn/
├── app.py               # Flask server, Socket.IO event handlers, session management
├── features.py          # DeepgramSession — manages the live WebSocket connection
├── templates/
│   └── index.html       # Main UI
├── static/
│   ├── css/
│   │   └── style.css    # All styles, animations, responsive layout
│   └── js/
│       └── script.js    # Socket.IO client, recording lifecycle, UI logic
├── requirements.txt
├── .env.example
└── test.py              # Local mic test (standalone, no browser needed)
```

---

## Getting Started

### Prerequisites

- Python 3.10+
- A [Deepgram](https://console.deepgram.com) account — free tier includes enough credits to get started

### 1. Clone the repository

```bash
git clone https://github.com/your-username/nexlearn.git
cd nexlearn
```

### 2. Create and activate a virtual environment

```bash
python3 -m venv venv
source venv/bin/activate        # macOS / Linux
venv\Scripts\activate           # Windows
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Set up environment variables

```bash
cp .env.example .env
```

Open `.env` and add your Deepgram API key:

```
DEEPGRAM_API_KEY=your_deepgram_api_key_here
```

### 5. Run the server

```bash
python3 app.py
```

Visit `http://localhost:5000` in your browser.

---

## How It Works

1. User clicks **Start Recording** — the browser requests microphone access.
2. The client emits `start_recording` over Socket.IO. The server spawns a background thread and opens a Deepgram WebSocket connection.
3. Once Deepgram confirms the connection, the server emits `recording_started` back to the client.
4. The browser's `MediaRecorder` starts capturing audio in 2-second WebM chunks.
5. Each chunk is sent to the server via Socket.IO, which prepends the EBML header (required for Deepgram to parse every chunk as a valid WebM stream) and forwards it to Deepgram.
6. Deepgram streams transcription results back. Interim results update the UI in real time; final results are appended to the session's full text.
7. On stop, the final transcription is returned to the client and the Deepgram connection is closed cleanly.

---

## Deployment (Render)

1. Push the project to a GitHub repository.
2. Create a new **Web Service** on [Render](https://render.com) and connect the repository.
3. Set the following:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn -k gevent -w 1 app:app`
4. Under **Environment**, add:
   ```
   DEEPGRAM_API_KEY=your_deepgram_api_key_here
   ```
5. Deploy.

> **Note:** Use `gunicorn -k gevent -w 1` — a single gevent worker is required for Socket.IO to work correctly. Multiple workers will cause WebSocket connections to fail.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEEPGRAM_API_KEY` | Yes | Your Deepgram API key from [console.deepgram.com](https://console.deepgram.com) |
| `PORT` | No | Server port (defaults to `5000`) |

---

## Local Mic Test

To test Deepgram transcription directly from your system microphone without a browser:

```bash
python3 test.py
```

Speak into your microphone. Press `Ctrl+C` to stop.

---

## Known Limitations

- Summaries are extractive (first 5 sentences). An LLM-powered summary can be plugged into the `generate_summary` handler in `app.py`.
- Session data is stored in memory. Restarting the server clears all transcriptions.
- Free Render instances spin down after inactivity. The first page load after a period of inactivity may be slow.

---

## License

MIT