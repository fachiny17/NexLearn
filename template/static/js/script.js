// ── Bootstrap ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
    initializeApp();
});

// ── State ──────────────────────────────────────────────────────────────────────
let mediaRecorder       = null;
let isRecording         = false;
let isPaused            = false;
let recordingTimer      = null;
let recordingStartTime  = null;
let pendingStream       = null;
let connectingTimer     = null;
let connectingStartTime = null;

// ── Socket.IO setup ────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });
window.socket = socket;

socket.on('connect', () => {
    console.log('Socket connected. Session ID:', socket.id);
    window.sessionId = socket.id;
});

socket.on('disconnect', () => {
    console.warn('Socket disconnected.');
    if (isRecording) stopRecording(false);   // clean up UI if connection drops
});

// ── Transcription updates ──────────────────────────────────────────────────────
socket.on('transcription_update', (data) => {
    const el = document.getElementById('transcription-text');
    if (!el) return;

    // Always trust full_text from server — it is the ground truth
    if (data.full_text !== undefined) {
        el.textContent = data.full_text;
    }

    updateWordCount();

    if (data.language) {
        const langEl = document.getElementById('detected-language');
        if (langEl) langEl.textContent = data.language.toUpperCase();
        langEl.style.display = 'inline';
    }
});

// Fired when server acknowledges stop and sends the final full text
socket.on('recording_stopped', (data) => {
    console.log('Server confirmed stop. Language:', data.language);
    if (data.full_text) {
        const el = document.getElementById('transcription-text');
        if (el) el.textContent = data.full_text;
        updateWordCount();
    }
});

socket.on('recording_started', (data) => {
    if (data.status === 'error') {
        showNotification(data.error || 'Failed to start transcription', 'error');
        // Also clean up the stream and reset UI
        if (pendingStream) {
            pendingStream.getTracks().forEach(t => t.stop());
            pendingStream = null;
        }
        showLiveSection(false);
        setRecordingStatus('');
        isRecording = false;
        return;
    }
    // success case
    if (pendingStream) {
        _startMediaRecorder(pendingStream);
        pendingStream = null;
    }
});

socket.on('recording_paused',  () => console.log('Server confirmed pause.'));
socket.on('recording_resumed', () => console.log('Server confirmed resume.'));

socket.on('chunk_received', (data) => {
});

// ── Summary result ─────────────────────────────────────────────────────────────
socket.on('summary_result', (data) => {
    const btn = document.getElementById('generate-summary-btn');
    resetButton(btn, btn?._originalHTML);

    if (data.success) {
        showSummaryModal(data.summary);
        showNotification('Summary generated!', 'success');
    } else {
        showNotification(data.error || 'Could not generate summary', 'error');
    }
});

// ── Download data (client-side file save) ─────────────────────────────────────
socket.on('download_data', (data) => {
    if (!data.success) {
        showNotification(data.error || 'Download failed', 'error');
        return;
    }
    triggerClientDownload(data.content, data.filename);
});

// ── General socket errors ──────────────────────────────────────────────────────
socket.on('error', (data) => {
    showNotification(data.message || 'An error occurred', 'error');
});

// ── Main init ──────────────────────────────────────────────────────────────────
function initializeApp() {
    setupRecordingControls();
    setupActionButtons();
}

// ── Recording controls ─────────────────────────────────────────────────────────
function setupRecordingControls() {
    const startBtn    = document.getElementById('start-recording-btn');
    const stopBtn     = document.getElementById('stop-recording-btn');
    const cancelBtn   = document.getElementById('cancel-recording-btn');
    const pauseBtn    = document.getElementById('pause-btn');
    const stopSaveBtn = document.getElementById('stop-btn');

    // ── START ────────────────────────────────────────────────────────────────
    startBtn?.addEventListener('click', async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            showNotification('Audio recording is not supported in this browser.', 'error');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            beginRecording(stream);
        } catch (err) {
            console.error('Mic access denied:', err);
            showNotification('Could not access microphone. Check browser permissions.', 'error');
        }
    });

    // ── STOP (from live transcription card) ──────────────────────────────────
    stopBtn?.addEventListener('click', () => stopRecording(true));

    // ── STOP & SAVE (alias — same behaviour) ─────────────────────────────────
    stopSaveBtn?.addEventListener('click', () => stopRecording(true));

    // ── CANCEL ───────────────────────────────────────────────────────────────
    cancelBtn?.addEventListener('click', () => {
        stopRecording(false);           // false = don't save / notify server
        showNotification('Recording cancelled.', 'info');
    });

    // ── PAUSE / RESUME ───────────────────────────────────────────────────────
    pauseBtn?.addEventListener('click', () => {
        if (!isRecording) return;

        if (isPaused) {

            isPaused = false;
            mediaRecorder?.resume();
            socket.emit('resume_recording');
            pauseBtn.innerHTML = pauseIcon() + ' Pause';
            toggleVisualizerAnimation(false);
            showNotification('Recording resumed.', 'info');
        } else {
            mediaRecorder?.pause();
            isPaused = true;
            socket.emit('pause_recording');
            pauseBtn.innerHTML = resumeIcon() + ' Resume';
            toggleVisualizerAnimation(true);
            showNotification('Recording paused.', 'info');
        }
    });
}

// ── Core recording lifecycle ───────────────────────────────────────────────────
function beginRecording(stream) {
    // Clear previous transcript
    const transcriptionEl = document.getElementById('transcription-text');
    if (transcriptionEl) transcriptionEl.textContent = '';
    updateWordCount();

    isRecording = true;
    isPaused    = false;

    pendingStream = stream;
    socket.emit('start_recording');

    // Show the live UI immediately with a "connecting" state
    showLiveSection(true);
    startConnectingTimer();
    showNotification('Connecting to transcription service...', 'info');
}


// ── Internal: actually starts the MediaRecorder once server is ready ──────────
function _startMediaRecorder(stream) {
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
 
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.connected && !isPaused) {
            socket.emit('audio_chunk', event.data);
        }
    };
 
    mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
    };
 
    mediaRecorder.start(2000);
    startRecordingTimer();   // ← real timer starts NOW — Deepgram is connected
    showNotification('Recording started! Transcribing live...', 'success');
    console.log('MediaRecorder started (2000ms timeslice).');
}


function stopRecording(save = true) {
    if (!isRecording) return;
 
    isRecording = false;
    isPaused    = false;
 
    if (pendingStream) {
        pendingStream.getTracks().forEach(t => t.stop());
        pendingStream = null;
    }
 
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
 
    clearInterval(recordingTimer);
    clearInterval(connectingTimer);
    recordingTimer      = null;
    connectingTimer     = null;
    connectingStartTime = null;

    const statusBar = document.getElementById('recording-status-bar');
    if (statusBar) statusBar.style.display = 'none';

    // Reset all timer elements for the next session
    const label   = document.getElementById('recording-status-label');
    const connDur = document.getElementById('connecting-duration');
    const divider = document.getElementById('timer-divider');
    const recDur  = document.getElementById('recording-duration');
    if (label)   label.textContent     = 'Connecting...';
    if (connDur) { connDur.textContent = '00:00'; connDur.style.display = 'inline'; }
    if (divider) divider.style.display = 'none';
    if (recDur)  { recDur.textContent  = '00:00'; recDur.style.display  = 'none'; }
 
    socket.emit('stop_recording');
 
    if (save) {
        showNotification('Recording stopped and saved.', 'success');
    }
 
    showLiveSection(false);
    setRecordingStatus('');
 
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.innerHTML = pauseIcon() + ' Pause';
    toggleVisualizerAnimation(false);
}

// ── Action buttons (Summary / Download) ───────────────────────────────────────
function setupActionButtons() {
    const summaryBtn      = document.getElementById('generate-summary-btn');
    const dlTranscriptBtn = document.getElementById('download-transcription-btn');
    const dlSummaryBtn    = document.getElementById('download-summary-btn');

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            document.body.classList.toggle('light-theme');
            const sunIcon  = themeToggle.querySelector('.sun-icon');
            const moonIcon = themeToggle.querySelector('.moon-icon');
            if (sunIcon)  sunIcon.classList.toggle('hidden');
            if (moonIcon) moonIcon.classList.toggle('hidden');
        });
    }

    // Generate Summary
    summaryBtn?.addEventListener('click', () => {
        summaryBtn._originalHTML = summaryBtn.innerHTML;
        summaryBtn.disabled = true;
        summaryBtn.innerHTML = spinnerIcon() + ' Generating...';
        socket.emit('generate_summary');
    });

    // Download Transcription
    dlTranscriptBtn?.addEventListener('click', () => {
        const text = document.getElementById('transcription-text')?.textContent?.trim();
        if (!text) {
            showNotification('No transcription to download yet.', 'error');
            return;
        }
        socket.emit('download_transcription');
    });

    // Download Summary
    dlSummaryBtn?.addEventListener('click', () => {
        socket.emit('download_summary');
    });
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
function showLiveSection(show) {
    const uploadSection          = document.getElementById('upload-section');
    const liveTranscriptionSection = document.getElementById('live-transcription-section');
    const startBtn               = document.getElementById('start-recording-btn');
    const stopBtn                = document.getElementById('stop-recording-btn');
    const cancelBtn              = document.getElementById('cancel-recording-btn');

    if (show) {
        uploadSection?.style && (uploadSection.style.display = 'none');
        liveTranscriptionSection?.style && (liveTranscriptionSection.style.display = 'block');
        if (startBtn)  startBtn.style.display  = 'none';
        if (stopBtn)   stopBtn.style.display   = 'inline-flex';
        if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    } else {
        uploadSection?.style && (uploadSection.style.display = 'block');
        liveTranscriptionSection?.style && (liveTranscriptionSection.style.display = 'none');
        if (startBtn)  startBtn.style.display  = 'flex';
        if (stopBtn)   stopBtn.style.display   = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
    }
}

// ── Phase 1: Connecting clock ──────────────────────────────────────────────────
// Starts the moment the user clicks record. Shows how long the handshake takes.
function startConnectingTimer() {
    const statusBar = document.getElementById('recording-status-bar');
    const label     = document.getElementById('recording-status-label');
    const connDur   = document.getElementById('connecting-duration');

    if (statusBar) statusBar.style.display = 'flex';
    if (label)     label.textContent       = 'Connecting...';
    if (connDur)   connDur.style.display   = 'inline';

    connectingStartTime = Date.now();
    connectingTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - connectingStartTime) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        if (connDur) connDur.textContent = `${minutes}:${seconds}`;
    }, 1000);
}

// ── Phase 2: Real recording timer ──────────────────────────────────────────────
// Starts only after Deepgram confirms a successful connection.
function startRecordingTimer() {
    // Kill the connecting clock
    clearInterval(connectingTimer);
    connectingTimer = null;

    const label   = document.getElementById('recording-status-label');
    const connDur = document.getElementById('connecting-duration');
    const divider = document.getElementById('timer-divider');
    const recDur  = document.getElementById('recording-duration');

    // Swap UI: hide connecting clock, show real timer
    if (label)   label.textContent     = 'Recording';
    if (connDur) connDur.style.display = 'none';
    if (divider) divider.style.display = 'inline';
    if (recDur)  recDur.style.display  = 'inline';

    recordingStartTime = Date.now();

    let pausedAt    = 0;
    let totalPaused = 0;

    recordingTimer = setInterval(() => {
        if (!isRecording) return;

        if (isPaused) {
            if (!pausedAt) pausedAt = Date.now();
            return;
        }

        if (pausedAt) {
            totalPaused += Date.now() - pausedAt;
            pausedAt = 0;
        }

        const elapsed = Math.floor((Date.now() - recordingStartTime - totalPaused) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        if (recDur) recDur.textContent = `${minutes}:${seconds}`;
    }, 1000);
}

function setRecordingStatus(msg) {
    const el = document.getElementById('recording-status');
    if (el) el.textContent = msg;
}

function updateWordCount() {
    const transcriptionEl = document.getElementById('transcription-text');
    const wordCountEl     = document.getElementById('word-count');
    if (!transcriptionEl || !wordCountEl) return;
    const words = transcriptionEl.textContent.trim().split(/\s+/).filter(Boolean);
    wordCountEl.textContent = words.length;
}

function toggleVisualizerAnimation(paused) {
    document.querySelectorAll('.bar').forEach(bar => {
        bar.style.animationPlayState = paused ? 'paused' : 'running';
    });
}

function resetButton(btn, originalHTML) {
    if (!btn) return;
    btn.disabled = false;
    if (originalHTML) btn.innerHTML = originalHTML;
}

// ── Client-side file download ──────────────────────────────────────────────────
function triggerClientDownload(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── SVG icon helpers ───────────────────────────────────────────────────────────
function pauseIcon() {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="4" y="3" width="3" height="10" fill="currentColor"/>
        <rect x="9" y="3" width="3" height="10" fill="currentColor"/>
    </svg>`;
}

function resumeIcon() {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 3L12 8L4 13V3Z" fill="currentColor"/>
    </svg>`;
}

function spinnerIcon() {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="spinning">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2"
            stroke-dasharray="10" fill="none"/>
    </svg>`;
}

// ── Notifications ──────────────────────────────────────────────────────────────
function showNotification(message, type = 'info') {
    document.querySelector('.notification')?.remove();

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <div class="notification-content">
            <div class="notification-icon">${getNotificationIcon(type)}</div>
            <span>${message}</span>
        </div>`;

    const style = document.createElement('style');
    style.textContent = `
        .notification {
            position: fixed; top: 100px; right: 30px;
            background: var(--bg-card); border: 1px solid var(--border-color);
            border-radius: 12px; padding: 16px 24px;
            backdrop-filter: blur(20px);
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            z-index: 1000;
            animation: slideInRight 0.4s ease-out, slideOutRight 0.4s ease-in 2.6s;
            animation-fill-mode: forwards;
        }
        .notification-content { display:flex; align-items:center; gap:12px; }
        .notification-icon { width:24px; height:24px; display:flex; align-items:center; justify-content:center; }
        .notification-success { border-color: rgba(0,255,136,0.5); }
        .notification-error   { border-color: rgba(255,77,109,0.5); }
        .notification-info    { border-color: rgba(0,212,255,0.5); }
        .spinning { animation: spin 1s linear infinite; }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes slideInRight  { from{opacity:0;transform:translateX(100px)} to{opacity:1;transform:translateX(0)} }
        @keyframes slideOutRight { from{opacity:1;transform:translateX(0)} to{opacity:0;transform:translateX(100px)} }
    `;

    document.head.appendChild(style);
    document.body.appendChild(notification);
    setTimeout(() => { notification.remove(); style.remove(); }, 3000);
}

function getNotificationIcon(type) {
    const icons = {
        success: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
            stroke="#00ff88" stroke-width="2"/></svg>`,
        error: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 8V12M12 16H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
            stroke="#ff4d6d" stroke-width="2"/></svg>`,
        info: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 16V12M12 8H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
            stroke="#00d4ff" stroke-width="2"/></svg>`
    };
    return icons[type] || icons.info;
}

// ── Summary modal ──────────────────────────────────────────────────────────────
function showSummaryModal(summary) {
    document.querySelector('.modal-overlay')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h2>Generated Summary</h2>
                <button class="modal-close">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2"/>
                    </svg>
                </button>
            </div>
            <div class="modal-body"><p>${summary}</p></div>
            <div class="modal-footer">
                <button class="btn btn-secondary modal-close-btn">Close</button>
                <button class="btn btn-action copy-btn">Copy Summary</button>
            </div>
        </div>`;

    const style = document.createElement('style');
    style.textContent = `
        .modal-overlay {
            position:fixed; inset:0;
            background:rgba(10,14,26,0.8); backdrop-filter:blur(10px);
            display:flex; align-items:center; justify-content:center;
            z-index:2000; animation:fadeIn 0.3s ease-out;
        }
        .modal {
            background:var(--bg-secondary); border:1px solid var(--border-glow);
            border-radius:20px; max-width:600px; width:90%; max-height:80vh;
            overflow:hidden; animation:scaleIn 0.4s ease-out;
            box-shadow:0 20px 60px rgba(0,212,255,0.3);
        }
        .modal-header { display:flex; justify-content:space-between; align-items:center; padding:24px 30px; border-bottom:1px solid var(--border-color); }
        .modal-header h2 { font-family:'Orbitron',sans-serif; font-size:24px; font-weight:700; }
        .modal-close { background:transparent; border:none; color:var(--text-secondary); cursor:pointer; transition:all 0.3s; padding:5px; }
        .modal-close:hover { color:var(--accent-cyan); transform:rotate(90deg); }
        .modal-body { padding:30px; overflow-y:auto; max-height:400px; }
        .modal-body p { line-height:1.8; font-size:16px; }
        .modal-footer { display:flex; gap:15px; padding:20px 30px; border-top:1px solid var(--border-color); justify-content:flex-end; }
        @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes scaleIn { from{opacity:0;transform:scale(0.9)} to{opacity:1;transform:scale(1)} }
    `;

    document.head.appendChild(style);
    document.body.appendChild(modal);

    const closeModal = () => { modal.remove(); style.remove(); };
    modal.querySelector('.modal-close').addEventListener('click', closeModal);
    modal.querySelector('.modal-close-btn').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    modal.querySelector('.copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(summary).then(() =>
            showNotification('Summary copied to clipboard!', 'success')
        );
    });
}

// ── Smooth scrolling ───────────────────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        document.querySelector(this.getAttribute('href'))
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
});