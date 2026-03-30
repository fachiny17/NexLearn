from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import os
import threading
from datetime import datetime
from features import DeepgramSession

app = Flask(
    __name__,
    static_folder='template/static',
    static_url_path='/static',
    template_folder='templates'
)

app.config['SECRET_KEY'] = 'your-secret-key-here'
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    max_size=10_000_000,
    async_mode='threading'
)

# ── Per-client session store ───────────────────────────────────────────────────
sessions = {}


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


# ── Socket.IO event handlers ───────────────────────────────────────────────────
@socketio.on('connect')
def handle_connect():
    session_id = request.sid
    sessions[session_id] = {
        'text': '',
        'summary': '',
        'language': None,
        'is_recording': False,
        'paused': False,
        'dg_session': None,
        'dg_starting': False,
    }
    print(f"[+] Connected: {session_id}")
    emit('connected', {'session_id': session_id})


@socketio.on('disconnect')
def handle_disconnect():
    session_id = request.sid
    session = sessions.pop(session_id, None)
    if session and session['dg_session']:
        session['dg_session'].stop()
    print(f"Disconnected: {session_id}")


@socketio.on('start_recording')
def handle_start_recording():
    session_id = request.sid
    session = sessions.get(session_id)
    if session is None:
        return

    # Stop any leftover Deepgram session
    if session['dg_session']:
        session['dg_session'].stop()

    session.update({
        'is_recording': True,
        'dg_starting': True,
        'paused': False,
        'start_time': datetime.now(),
        'text': '',
        'language': None,
        'chunk_index': 0,
        'dg_session': None,
        'webm_header': None,
    })

    def on_transcript(text: str, language: str, is_final: bool):
        current = sessions.get(session_id)
        if current is None or not current['is_recording']:
            return

        if is_final:
            current['text'] = (current['text'] + ' ' + text).strip()
        current['language'] = language

        socketio.emit('transcription_update', {
            'text': text.strip(),
            'full_text': (current['text'] + ' ' + text).strip() if not is_final else current['text'],
            'language': language,
            'is_final': is_final,
            'timestamp': datetime.now().isoformat()
        }, room=session_id)

    def on_dg_error(message: str):
        socketio.emit('transcription_error', {
            'error': message
        }, room=session_id)


    def _start_dg():
        current = sessions.get(session_id)
        if current is None:
            return

        dg = DeepgramSession(on_transcript=on_transcript, on_error=on_dg_error)
        ok = dg.start()   # blocks here — but now on its own thread

        if not ok:
            if current:
                current['is_recording'] = False
                current['dg_starting'] = False
            socketio.emit('recording_started', {
                'status': 'error',
                'error': 'Could not connect to Deepgram. Check your API key and network.'
            }, room=session_id)
            return

        # If stop_recording arrived while we were connecting, honour it
        if not current.get('is_recording'):
            dg.stop()
            current['dg_starting'] = False
            print(f"[!] start_recording: stop arrived before handshake finished — aborting: {session_id}")
            return

        current['dg_session'] = dg
        current['dg_starting'] = False
        socketio.emit('recording_started', {'status': 'success'}, room=session_id)
        print(f"[•] Recording started: {session_id}")

    threading.Thread(target=_start_dg, daemon=True).start()
    # Return immediately — the client gets 'recording_started' once DG is ready


@socketio.on('stop_recording')
def handle_stop_recording():
    session_id = request.sid
    session = sessions.get(session_id)
    if session is None:
        return

    # Signal intent to stop — _start_dg checks this flag after connecting
    session['is_recording'] = False

    if session['dg_session']:
        session['dg_session'].stop()
        session['dg_session'] = None

    emit('recording_stopped', {
        'status': 'success',
        'full_text': session['text'],
        'language': session.get('language')
    })
    print(f"[■] Recording stopped: {session_id}")


@socketio.on('pause_recording')
def handle_pause_recording():
    session_id = request.sid
    session = sessions.get(session_id)
    if session:
        session['paused'] = True
        emit('recording_paused', {'status': 'success'})


@socketio.on('resume_recording')
def handle_resume_recording():
    session_id = request.sid
    session = sessions.get(session_id)
    if session:
        session['paused'] = False
        emit('recording_resumed', {'status': 'success'})


@socketio.on('audio_chunk')
def handle_audio_chunk(data):
    
    session_id = request.sid
    session = sessions.get(session_id)

    if not (session and session['is_recording'] and not session['paused']):
        emit('chunk_received', {'status': 'skipped'})
        return

    # Deepgram may still be connecting — drop chunk rather than crash
    if session.get('dg_starting'):
        emit('chunk_received', {'status': 'connecting'})
        return

    dg = session.get('dg_session')
    if not dg or not dg.is_connected:
        emit('chunk_received', {'status': 'no_connection'})
        return

    try:
        chunk_bytes = bytes(data)
        chunk_index = session['chunk_index']

        if chunk_index == 0:
            # First chunk contains the EBML header — save it
            session['webm_header'] = chunk_bytes
            blob = chunk_bytes
        else:
            # Prepend header so Deepgram sees a valid WebM on every chunk
            blob = session['webm_header'] + chunk_bytes

        session['chunk_index'] += 1
        dg.send(blob)
        emit('chunk_received', {'status': 'sent'})

    except Exception as e:
        print(f"[{session_id}] audio_chunk error: {e}")
        emit('chunk_received', {'status': 'error', 'detail': str(e)})


@socketio.on('generate_summary')
def handle_generate_summary():
    session_id = request.sid
    session = sessions.get(session_id)

    if session is None:
        emit('summary_result', {'success': False, 'error': 'Session not found'})
        return

    text = session.get('text', '').strip()
    if not text:
        emit('summary_result', {'success': False, 'error': 'No transcription available yet'})
        return

    # Simple extractive placeholder — replace with an LLM call as needed
    sentences = [s.strip() for s in text.split('.') if s.strip()]
    summary = '. '.join(sentences[:5])
    if summary and not summary.endswith('.'):
        summary += '.'

    session['summary'] = summary
    emit('summary_result', {'success': True, 'summary': summary})


@socketio.on('download_transcription')
def handle_download_transcription():
    session_id = request.sid
    session = sessions.get(session_id)
    if session is None:
        emit('download_data', {'success': False, 'error': 'Session not found'})
        return

    text = session.get('text', '').strip()
    if not text:
        emit('download_data', {'success': False, 'error': 'No transcription available'})
        return

    emit('download_data', {
        'success': True,
        'type': 'transcription',
        'content': text,
        'filename': 'transcription.txt'
    })


@socketio.on('download_summary')
def handle_download_summary():
    session_id = request.sid
    session = sessions.get(session_id)
    if session is None:
        emit('download_data', {'success': False, 'error': 'Session not found'})
        return

    summary = session.get('summary', '').strip()
    if not summary:
        emit('download_data', {'success': False, 'error': 'No summary available — generate one first'})
        return

    emit('download_data', {
        'success': True,
        'type': 'summary',
        'content': summary,
        'filename': 'summary.txt'
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, debug=True, host='0.0.0.0', port=port)