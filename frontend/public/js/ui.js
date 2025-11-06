

// UI wiring converted from EmulatorUI.kt + MainActivity.kt
// Keeps identical semantics, event names, and control flow.
// - Toggles: connect/stream/mute/visibility/voice
// - Device list preference for XR-1238
// - Messages (urgent), transcripts (partial/final)
// - Battery push event & 12s telemetry (when connected)

import { SignalingClient } from './signaling.js';
import WebRtcStreamer from './device.js';
import TelemetryReporter from './telemetry.js';
import { Message, appendMessage } from './messages.js';


// ----------------- Constants (parity) -----------------
const ANDROID_XR_ID = (window.XR_DEVICE_ID || 'XR-1234');
const DEFAULT_DESKTOP_ID = (window.XR_OPERATOR_ID || 'XR-1238');
const SERVER_URL = (window.SIGNAL_URL || location.origin);

// Speech settings
const PARTIAL_THROTTLE_MS = 800;

// ----------------- Elements -----------------
const elStatus = document.getElementById('status');
const elChip = document.getElementById('chipLastCmd');
const elBtnConnect = document.getElementById('btnConnect');
const elBtnStream = document.getElementById('btnStream');
const elBtnMute = document.getElementById('btnMute');
const elBtnVideo = document.getElementById('btnVideo');
const elBtnVoice = document.getElementById('btnVoice');
const elBtnStartRec = document.getElementById('btnStartRec');
const elBtnStopRec = document.getElementById('btnStopRec');
const elPreview = document.getElementById('preview');
const elNoStream = document.getElementById('noStream');
const elMsgList = document.getElementById('msgList');
const elMsgInput = document.getElementById('msgInput');
const elChkUrgent = document.getElementById('chkUrgent');
const elBtnSend = document.getElementById('btnSend');

// ----------------- State -----------------
let signaling = null;
let streamer = null;
let telemetry = null;

let isServerConnected = false;
let userWantsConnected = false;
let streamActive = false;
let micMuted = true;
let videoVisible = true;
let isListening = false;
let lastRecognizedCommand = '';

let connectedDesktops = []; // XR IDs
let hadDesktops = false;

// note-taking
let recordingActive = false;
let noteBuffer = '';
let lastPartialSentAt = 0;

// battery push timer (90s)
let batteryTimer = null;
const BATTERY_PUSH_MS = 90_000;

// ----------------- Helpers -----------------
function nowIso() { return new Date().toISOString(); }

// Use signaling's queued send if available; fallback to raw socket emit
function emitSafe(event, data) {
    try {
        if (signaling && typeof signaling._send === 'function') {
            signaling._send(event, data);
        } else {
            signaling?.socket?.emit(event, data);
        }
    } catch (e) {
        console.warn('[SIGNAL][fallback emit] failed', event, e);
    }
}


// ---- Persistence (localStorage) ----
const STORAGE_KEY = 'xr-pwa-ui-state.v1';
let persistedState = {
    messages: [],             // { sender, text, timestamp, xrId, urgent }
    connectedDesktops: [],    // e.g. ['XR-1238']
    selectedDesktopId: null,  // last stream target
    micMuted: true,
    userWantsConnected: false
};
let _rehydrating = false, _saveTimer = null;
function saveState(throttleMs = 300) {
    if (_rehydrating) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState)); } catch { }
    }, throttleMs);
}
function persistNow() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState)); } catch { } }
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        for (const k of Object.keys(persistedState)) if (k in parsed) persistedState[k] = parsed[k];
    } catch { }
}

// ---- Auto-reload on disconnect (safe + interval-guarded) ----
const AUTO_RELOAD_ON_DISCONNECT = true;
const AUTO_RELOAD_ONLY_MANUAL = false;        // set true to reload only when user clicked Disconnect
const RELOAD_GRACE_MS = 2000;
const MIN_RELOAD_INTERVAL_MS = 15000;
function scheduleAutoReload(reason = 'unknown') {
    if (!AUTO_RELOAD_ON_DISCONNECT) return;
    if (AUTO_RELOAD_ONLY_MANUAL && !(signaling?._manualClose)) return;

    const now = Date.now();
    const last = Number(sessionStorage.getItem('lastAutoReloadTs') || 0);
    if (now - last < MIN_RELOAD_INTERVAL_MS) {
        console.warn('[AUTO-RELOAD] Skipping (interval guard).', { sinceMs: now - last });
        return;
    }
    sessionStorage.setItem('lastAutoReloadTs', String(now));
    console.log('[AUTO-RELOAD] Scheduling reload in', RELOAD_GRACE_MS, 'ms; reason:', reason);

    setTimeout(() => {
        // flush state just before reload
        try { persistNow(); } catch { }
        if (document.visibilityState === 'hidden') {
            const once = () => {
                if (document.visibilityState === 'visible') {
                    document.removeEventListener('visibilitychange', once);
                    try { persistNow(); } catch { }
                    location.reload();
                }
            };
            document.addEventListener('visibilitychange', once);
            return;
        }
        location.reload();
    }, RELOAD_GRACE_MS);
}


function msg(sender, text) {
    const m = new Message({ sender, text, timestamp: nowIso(), xrId: ANDROID_XR_ID, urgent: false });
    appendMessage(elMsgList, m);
    elMsgList.scrollTop = elMsgList.scrollHeight;

    // ⬇️ add this block
    try {
        const N = 200; // cap to avoid storage bloat
        persistedState.messages.push({ sender, text, timestamp: m.timestamp, xrId: ANDROID_XR_ID, urgent: false });
        if (persistedState.messages.length > N) {
            persistedState.messages = persistedState.messages.slice(-N);
        }
        saveState();
    } catch { }
}

function setStatus(connected) {
    elStatus.textContent = connected ? 'Status: Connected' : 'Status: Disconnected';
    elStatus.classList.toggle('status-connected', connected);
    elStatus.classList.toggle('status-disconnected', !connected);

    elBtnConnect.textContent = connected ? 'Disconnect' : 'Connect';
    elBtnStream.textContent = streamActive ? 'Stop Stream' : 'Start Stream';
    elBtnMute.textContent = micMuted ? 'Unmute' : 'Mute';
    elBtnVideo.textContent = videoVisible ? 'Hide Video' : 'Show Video';
    elBtnVoice.textContent = isListening ? 'Stop Voice' : 'Start Voice';

    // preview placeholder
    elNoStream.hidden = !!streamActive;
}

// Apply mic state locally (mirrors Android's handleControlCommand)
function applyMute(wantMuted) {
    const s = ensureStreamer();
    try {
        if (wantMuted) {
            s.mute();           // disable audio tracks (do not stop)
            micMuted = true;

            // ✅ add these two lines right after setting micMuted = true
            persistedState.micMuted = micMuted;
            saveState();
            startVoiceRecognition();
            msg('System', 'Microphone muted.');
        } else {
            stopVoiceRecognition();
            // may need to reacquire mic; unmute() is async
            Promise.resolve(s.unmute()).catch(() => msg('System', 'Failed to unmute mic'));
            micMuted = false;
            // ✅ add these two lines right after setting micMuted = false
            persistedState.micMuted = micMuted;
            saveState();
            msg('System', 'Microphone unmuted.');
        }
    } catch { }
    setStatus(isServerConnected);
}


function preferDesktop(listPairs) {
    const ids = listPairs.map(p => p[1]);
    connectedDesktops = [];
    if (ids.includes(DEFAULT_DESKTOP_ID)) connectedDesktops.push(DEFAULT_DESKTOP_ID);
    else connectedDesktops.push(...ids);
    // ✅ Persist connected desktop list to localStorage
    persistedState.connectedDesktops = connectedDesktops.slice();
    saveState();
}

// ----------------- Signaling wiring (parity) -----------------
function createSignaling() {
    signaling = new SignalingClient({
        serverUrl: SERVER_URL,
        deviceName: 'XR-Web',
        xrId: ANDROID_XR_ID
    });

    signaling.listener = {
        onConnected: () => {
            isServerConnected = true;
            setStatus(true);
            msg('System', 'Connected to server');

            // start 12s telemetry
            telemetry = new TelemetryReporter({
                xrId: ANDROID_XR_ID,
                sendJson: (event, payload) => emitSafe(event, payload),

                periodMs: 12_000
            });
            telemetry.start();

            // battery push
            startBatteryTicker();
        },

        onDisconnected: () => {
            isServerConnected = false;

            // ⬇️ add these two lines
            userWantsConnected = false;      // prevent auto-reconnect after a manual disconnect

            setStatus(false);
            msg('System', 'Disconnected from server');

            telemetry?.stop(); telemetry = null;
            stopBatteryTicker();

            if (streamActive) {
                streamActive = false;
                streamer?.stopStreaming().catch(() => { });

                msg('System', 'Stream stopped.');
            }

            // Ensure camera is off even if we weren't "streaming"
            try { ensureStreamer().stopCamera(); } catch { }
            // Only disable reconnection if this was a *manual* disconnect
            if (signaling?._manualClose) {
                try { signaling.setReconnectionEnabled(false); } catch { }
            }

            // ✅ AUTO-RELOAD block — add right here
            console.log('[AUTO-RELOAD] onDisconnected hook firing', { manualClose: signaling?._manualClose });
            try { persistNow(); } catch { }
            if (!streamActive) { // optional guard—skip reload during active stream cuts if you prefer
                scheduleAutoReload(signaling?._manualClose ? 'user' : 'network');
            }
        },

        // Same "signal" handling as MainActivity.kt
        onSignal: (type, from, _to, data) => {
            if (type === 'offer') {
                console.debug('Ignoring unexpected OFFER (web device is the offerer).');
                return;
            }
            if (type === 'answer') {
                streamer?.onRemoteAnswerReceived(data, from);
                return;
            }
            if (type === 'ice-candidate') {
                streamer?.onRemoteIceCandidate(data, from);
                return;
            }
            console.debug('Unhandled signal type:', type);
        },

        // NEW: respond when Dock asks us to send a fresh offer
        onControl: (c) => {
            const cmd = String(c?.command || c?.action || '').toLowerCase();
            if (cmd === 'request_offer') {
                ensureStreamer();
                const to = DEFAULT_DESKTOP_ID; // e.g., 'XR-1238'
                streamer.sendOfferTo(to).catch(console.error);
                return;                                    // <— KEEP this return
            }

            // ⬇️ INSERT THESE TWO LINES *RIGHT HERE*, before the closing brace of onControl
            if (cmd === 'mute') { applyMute(true); return; }
            if (cmd === 'unmute') { applyMute(false); return; }
        },


        onDeviceListUpdated: (listPairs) => {
            preferDesktop(listPairs);

            const hadBefore = hadDesktops;
            hadDesktops = connectedDesktops.length > 0;

            if (!hadBefore && hadDesktops)
                msg('System', "A desktop connected! Tap 'Start Stream' to begin streaming.");

            if (isServerConnected && connectedDesktops.includes(DEFAULT_DESKTOP_ID) && !hadBefore) {
                msg('System', `System [${ANDROID_XR_ID}] is connected to Desktop [${DEFAULT_DESKTOP_ID}]`);
            }

            if (!hadDesktops && streamActive) {
                streamActive = false;
                streamer?.stopStreaming().catch(() => { });
                setStatus(isServerConnected);
                msg('System', 'All desktops disconnected. Stopped streaming.');

                // If stream already running and our preferred desktop is present, (re)send an offer
                if (streamActive && isServerConnected && connectedDesktops.includes(DEFAULT_DESKTOP_ID)) {
                    ensureStreamer();
                    const to = (signaling?.currentDesktopId || DEFAULT_DESKTOP_ID);

                    // ✅ Persist the last selected desktop ID
                    persistedState.selectedDesktopId = to;
                    saveState();
                    streamer.sendOfferTo(to).catch(() => { });
                }

            }
        },
        onServerMessage: (event, payload) => {
            if (event === 'peer_left') {
                const id = (payload?.xrId || '').toUpperCase();
                if (id === DEFAULT_DESKTOP_ID) {
                    msg('System', `Desktop [${DEFAULT_DESKTOP_ID}] left the room (${payload?.roomId || ''}).`);
                    connectedDesktops = connectedDesktops.filter(x => x.toUpperCase() !== DEFAULT_DESKTOP_ID);
                    if (streamActive) {
                        streamActive = false;
                        streamer?.stopStreaming().catch(() => { });
                        setStatus(isServerConnected);
                        msg('System', 'Stream stopped (desktop disconnected).');
                    }
                }
                return;
            }

            if (event === 'desktop_disconnected') {
                const id = (payload?.xrId || DEFAULT_DESKTOP_ID).toUpperCase();
                msg('System', `Desktop [${id}] disconnected.`);
                connectedDesktops = connectedDesktops.filter(x => x.toUpperCase() !== id);
                if (streamActive) {
                    streamActive = false;
                    streamer?.stopStreaming().catch(() => { });
                    setStatus(isServerConnected);
                    msg('System', 'Stream stopped (desktop disconnected).');
                }
                return;
            }

            if (event !== 'message') return;

            // Render normal message (skip "transcript" like Android UI)
            const type = payload?.type || '';
            if (type === 'transcript') return;

            const sender = payload?.sender || payload?.from || 'server';
            const text = payload?.text || payload?.message || payload?.data || JSON.stringify(payload);
            const timestamp = payload?.timestamp || nowIso();
            const xrId = payload?.xrId || (payload?.from || 'server');
            const urgent = !!(payload?.urgent || (payload?.priority === 'urgent'));

            appendMessage(elMsgList, new Message({ sender, text, timestamp, xrId, urgent }));
            elMsgList.scrollTop = elMsgList.scrollHeight;
        }
    }; // <-- close signaling.listener object

    signaling.connect();
}


function ensureStreamer() {
    if (streamer) return streamer;
    streamer = new WebRtcStreamer({ signaling, androidXrId: ANDROID_XR_ID });
    streamer.attachVideo(elPreview);
    return streamer;
}

// ----------------- Controls -----------------
// Connect / Disconnect
elBtnConnect.addEventListener('click', async () => {
    // Prefer the client’s own state if available; fall back to our flag
    const connected = (typeof signaling?.isConnectedNow === 'function')
        ? signaling.isConnectedNow()
        : !!isServerConnected;

    if (connected) {
        userWantsConnected = false;
        // ✅ persist disconnect intent
        persistedState.userWantsConnected = false;
        saveState();
        msg('System', 'Disconnecting…');

        // stop stream first so peers close cleanly
        try {
            if (streamActive) { await ensureStreamer().stopStreaming(); streamActive = false; }
        } catch { }

        connectedDesktops = [];
        hadDesktops = false;

        // NEW: true manual disconnect (disables reconnection)
        if (typeof signaling?.disconnect === 'function') signaling.disconnect('user');
        else if (typeof signaling?.close === 'function') signaling.close();

        // reflect immediately; onDisconnected will also run
        isServerConnected = false;

        setStatus(false);
        return;
    }

    // Not connected → connect
    userWantsConnected = true;
    persistedState.userWantsConnected = true;   // ✅ add
    saveState();                                 // ✅ add
    msg('System', 'Connecting…');
    createSignaling();     // wires listeners and calls signaling.connect()
    ensureStreamer();      // bind preview element
});


elBtnStream.addEventListener('click', async () => {
    if (!isServerConnected) { msg('System', 'Not connected'); return; }
    if (streamActive) {
        streamActive = false;
        await ensureStreamer().stopStreaming();
        micMuted = true;
        setStatus(true);
        msg('System', 'Stream stopped.');

        // Tell the Dock to blank out *now* (no waiting for ICE/TURN timeouts)
        try {
            const to = (signaling?.currentDesktopId || DEFAULT_DESKTOP_ID);
            // ✅ persist last selected desktop even on stop (keeps continuity)
            persistedState.selectedDesktopId = to;
            saveState();
            emitSafe('control', { from: ANDROID_XR_ID, to, command: 'stop_stream', action: 'stop_stream' });

        } catch { }

        // Also turn off the local camera immediately
        try { ensureStreamer().stopCamera(); } catch { }

        // Cancel any offer retry timer you may have started
        if (window.__offerRetryTimer) {
            clearTimeout(window.__offerRetryTimer);
            window.__offerRetryTimer = null;
        }

    } else {
        if (connectedDesktops.length === 0) { msg('System', 'No desktops available for streaming.'); return; }
        await signaling?.waitUntilConnected?.(); // ensure signaling is live
        streamActive = true;
        await ensureStreamer().startStreaming(connectedDesktops);
        micMuted = true;
        ensureStreamer().mute();
        setStatus(true);
        msg('System', "Stream started (muted by default). Say 'unmute' to unmute.");

        // Immediately push an SDP offer to the Dock (device is the offerer)
        ensureStreamer();
        const to = (signaling?.currentDesktopId || DEFAULT_DESKTOP_ID);
        // ✅ persist last selected desktop
        persistedState.selectedDesktopId = to;
        saveState();
        streamer.sendOfferTo(to).catch(console.error);

        // Optional: retry once in case the Dock wasn't ready yet
        if (window.__offerRetryTimer) clearTimeout(window.__offerRetryTimer);
        window.__offerRetryTimer = setTimeout(() => {
            if (streamActive && signaling?.isConnectedNow?.()) {
                streamer.sendOfferTo(to).catch(() => { });
            }
        }, 4000);

    }
});

elBtnMute.addEventListener('click', async () => {
    if (!isServerConnected || !streamActive) {
        msg('System', 'Stream not active');
        return;
    }

    // Decide desired state from UI's own source of truth
    const wantMuted = !micMuted;
    const command = wantMuted ? 'mute' : 'unmute';

    // 1) Apply locally immediately (Android parity)
    applyMute(wantMuted);

    // 2) Notify connected desktops (same as voice path)
    for (const targetId of connectedDesktops) {
        emitSafe('control', { from: ANDROID_XR_ID, to: targetId, command, action: command });
    }
});




elBtnVideo.addEventListener('click', () => {
    if (!isServerConnected || !streamActive) { msg('System', 'Stream not active'); return; }
    if (videoVisible) {
        videoVisible = false;
        ensureStreamer().hideVideo();
    } else {
        videoVisible = true;
        ensureStreamer().showVideo();
    }
    setStatus(true);
});

// ----------------- Voice + Notes (partial/final transcripts) -----------------
let SR = null, rec = null, speechIntentLang = 'en-US';

function setupSR() {
    SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    if (!SR) return false;
    rec = new SR();
    rec.lang = speechIntentLang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
        let interim = '';
        let finalTxt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript.toLowerCase().trim();
            if (e.results[i].isFinal) finalTxt += (finalTxt ? ' ' : '') + t;
            else interim += (interim ? ' ' : '') + t;
        }

        if (interim && recordingActive) {
            const now = Date.now();
            if (now - lastPartialSentAt > PARTIAL_THROTTLE_MS) {
                lastPartialSentAt = now;
                sendTranscript(interim, false);
            }
        }

        if (finalTxt) {
            lastRecognizedCommand = finalTxt;
            elChip.textContent = `Heard: ${finalTxt}`;
            elChip.hidden = false;

            if (/\bcreate\b/.test(finalTxt)) {
                onStopRecordingNote();
                return;
            } else if (recordingActive) {
                // buffer note only; send once at stop
                noteBuffer += (noteBuffer ? ' ' : '') + finalTxt;
            } else {
                processVoiceCommand(finalTxt);
            }
        }
    };
    rec.onerror = () => {
        if (isListening) try { rec.start(); } catch { }
    };
    rec.onend = () => {
        if (isListening) try { rec.start(); } catch { }
    };
    return true;
}

function startVoiceRecognition() {
    if (!setupSR()) { msg('System', 'Voice API not available in this browser'); return; }
    if (isListening) return;
    isListening = true;
    try { rec.start(); msg('System', 'Voice recognition started'); } catch { msg('System', 'Failed to start voice'); }
    setStatus(isServerConnected);
}

function stopVoiceRecognition() {
    if (!isListening) return;
    isListening = false;
    try { rec.stop(); msg('System', 'Voice recognition stopped'); } catch { msg('System', 'Failed to stop voice recognition'); }
    if (recordingActive) finalizeRecordingNote();
    setStatus(isServerConnected);
}

function processVoiceCommand(cmd) {
    const c = cmd.toLowerCase();

    if (/\bnote\b/.test(c)) { onStartRecordingNote(); return; }
    if (/\bcreate\b/.test(c)) { onStopRecordingNote(); return; }

    if (/\bconnect\b/.test(c)) {
        if (!isServerConnected) elBtnConnect.click(); else msg('Voice', 'Already connected.');
        return;
    }
    if (/\bdisconnect\b/.test(c)) {
        if (isServerConnected) elBtnConnect.click(); else msg('Voice', 'Already disconnected.');
        return;
    }
    if (/\bunmute\b/.test(c)) { if (micMuted) sendControlCommand('unmute'); else msg('Voice', 'Already unmuted.'); return; }
    if (/\bmute\b/.test(c)) { if (!micMuted) sendControlCommand('mute'); else msg('Voice', 'Already muted.'); return; }
    if (/\bstart\b/.test(c)) { sendControlCommand('start_stream'); return; }
    if (/\bstop\b/.test(c)) { sendControlCommand('stop_stream'); return; }
    if (/\bhide\b/.test(c)) { sendControlCommand('hide_video'); return; }
    if (/\bshow\b/.test(c)) { sendControlCommand('show_video'); return; }

    msg('Voice', `Unrecognized command: ${cmd}`);
}

elBtnVoice.addEventListener('click', () => {
    if (isListening) stopVoiceRecognition(); else startVoiceRecognition();
});

// Recording buttons
function onStartRecordingNote() {
    if (recordingActive) return;
    recordingActive = true;
    noteBuffer = '';
    if (!isListening) startVoiceRecognition();
    msg('System', 'Note recording started (say "create" to stop).');
}
function onStopRecordingNote() {
    if (!recordingActive) return;
    finalizeRecordingNote();
    if (isListening) stopVoiceRecognition();
}
function finalizeRecordingNote() {
    recordingActive = false;
    const finalText = noteBuffer.trim();
    msg('System', `Note saved to console (${finalText.length} chars).`);

    if (finalText) sendTranscript(finalText, true);

    // 🚀 Trigger SOAP on Dock/Scribe (action+command for compatibility)
    if (connectedDesktops.length > 0) {
        for (const targetId of connectedDesktops) {
            emitSafe('control', {

                from: ANDROID_XR_ID,
                to: targetId,
                command: 'scribe_flush',
                action: 'scribe_flush'
            });
        }
    }

    noteBuffer = '';
}

elBtnStartRec.addEventListener('click', onStartRecordingNote);
elBtnStopRec.addEventListener('click', onStopRecordingNote);

// Transcript sender (same payload as Android)
async function sendTranscript(text, isFinal) {
    if (!isServerConnected) { msg('System', 'Not connected; transcript not sent.'); return; }
    if (connectedDesktops.length === 0) { msg('System', 'No desktops connected; transcript not sent.'); return; }
    await signaling?.waitUntilConnected?.().catch(() => { });    // <-- INSERT THIS

    const ts = nowIso();
    for (const targetId of connectedDesktops) {
        emitSafe('message', {
            type: 'transcript',
            text,
            final: !!isFinal,
            sender: 'AndroidXR',
            xrId: ANDROID_XR_ID,
            timestamp: ts,
            to: targetId,
            from: ANDROID_XR_ID
        });
    }
}

// ----------------- Control & Chat sending -----------------
function sendControlCommand(command) {
    if (connectedDesktops.length === 0) {
        msg('System', 'No desktops connected to send command'); return;
    }
    for (const targetId of connectedDesktops) {
        signaling.socket?.emit('control', { from: ANDROID_XR_ID, to: targetId, command, action: command });

    }
    // local handling mirrors Android’s immediate UI update:
    if (command === 'start_stream') elBtnStream.click();
    else if (command === 'stop_stream') elBtnStream.click();
    else if (command === 'mute') { if (!micMuted) elBtnMute.click(); }
    else if (command === 'unmute') { if (micMuted) elBtnMute.click(); }
    else if (command === 'hide_video') { if (videoVisible) elBtnVideo.click(); }
    else if (command === 'show_video') { if (!videoVisible) elBtnVideo.click(); }
}

elBtnSend.addEventListener('click', () => {
    const text = (elMsgInput.value || '').trim();
    const urgent = !!elChkUrgent.checked;
    if (!text) return;

    if (connectedDesktops.length === 0) {
        msg('System', 'Message not sent - no desktops connected');
        return;
    }
    const timestamp = nowIso();
    for (const targetId of connectedDesktops) {
        emitSafe('message', {
            type: 'message',
            text,
            sender: 'AndroidXR',
            xrId: ANDROID_XR_ID,
            timestamp,
            urgent,
            to: targetId,
            from: ANDROID_XR_ID
        });
    }
    elMsgInput.value = '';
    elChkUrgent.checked = false;
});

// ----------------- Battery push (every ~90s) -----------------
async function getBatterySnapshot() {
    try {
        if (!navigator.getBattery) return null;
        const b = await navigator.getBattery();
        return { batteryPct: Math.round((b.level ?? 0) * 100), charging: !!b.charging };
    } catch { return null; }
}
function emitBatteryOnce() {
    if (!isServerConnected) return;
    getBatterySnapshot().then(s => {
        if (!s) return;
        emitSafe('battery', {
            xrId: ANDROID_XR_ID,
            batteryPct: s.batteryPct,
            charging: s.charging,
            ts: Date.now()
        });
    });
}
function startBatteryTicker() {
    emitBatteryOnce();
    stopBatteryTicker();
    batteryTimer = setInterval(emitBatteryOnce, BATTERY_PUSH_MS);
}
function stopBatteryTicker() {
    if (batteryTimer) clearInterval(batteryTimer);
    batteryTimer = null;
}

// ----------------- Boot -----------------
loadState();
_rehydrating = true;
try {
    // restore messages
    if (Array.isArray(persistedState.messages)) {
        for (const m of persistedState.messages) {
            // render without re-triggering saves
            appendMessage(elMsgList, new Message({
                sender: m.sender, text: m.text, timestamp: m.timestamp, xrId: m.xrId, urgent: !!m.urgent
            }));
        }
        elMsgList.scrollTop = elMsgList.scrollHeight;
    }
    // restore desktops + selection
    if (Array.isArray(persistedState.connectedDesktops)) {
        connectedDesktops = persistedState.connectedDesktops.slice();
    }
    if (persistedState.selectedDesktopId) {
        if (signaling) signaling.currentDesktopId = persistedState.selectedDesktopId;
    }
    // restore toggles
    micMuted = !!persistedState.micMuted;
    userWantsConnected = !!persistedState.userWantsConnected;
} finally {
    _rehydrating = false;
}

// reflect UI state
setStatus(false);
if (persistedState.messages.length === 0) {
    msg('System', "Disconnected. Tap 'Connect' or say 'connect' to join the server.");
}

