// ------------------------bolt------------ dashboard.js (DROP-IN) ------------------------------------

// Fixed XR IDs shown on the dashboard
const XR_LEFT = 'XR-1234';  // XR VISION
const XR_RIGHT = 'XR-1238';  // XR DOCK

const STATIC_BATTERY_LEFT = 83;

// ===== A) Per-device WebRTC quality cache =====
const XR_ANDROID = 'XR-1234';   // Android (left)
const XR_DOCK = 'XR-1238';   // Dock (right)

const qualityStore = new Map(); // id -> { ts:[], jitter:[], rtt:[], loss:[], kbps:[] }
function getQ(id) {
  if (!qualityStore.has(id)) {
    qualityStore.set(id, { ts: [], jitter: [], rtt: [], loss: [], kbps: [] });
  }
  return qualityStore.get(id);
}
let currentDetailId = null; // which device the modal is showing


// ---------------- Icons (unchanged) ----------------
const Icon = {
  pen: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
  battery(pct = 0) {
    const w = Math.max(0, Math.min(18, Math.round((pct / 100) * 18)));
    return `<svg viewBox="0 0 28 16" width="22" height="16" fill="none" stroke="white" stroke-width="2">
      <rect x="1" y="3" width="22" height="10" rx="2"></rect>
      <rect x="23" y="6" width="3" height="4" rx="1" fill="white"></rect>
      <rect x="3" y="5" width="${w}" height="6" fill="white"></rect>
    </svg>`;
  }
};

// ------------- Status chip with explicit colors -------------
function chip(text, state) {
  // state: 'available' (green) | 'connecting' (amber) | 'busy' (red)
  const colors = {
    available: '#16a34a',  // green-600
    connecting: '#f59e0b', // amber-500
    busy: '#dc2626'        // red-600
  };
  const bg = colors[state] || '#6b7280';
  return `<div class="chip"
              style="background:${bg};color:#fff;font-size:12px;padding:6px 8px;border-radius:6px;white-space:nowrap;">
            ${text}
          </div>`;
}

// ---------------- Presence & pairing state ----------------
const onlineDevices = new Map(); // xrId -> { xrId, deviceName }
const activePairs = new Set(); // "XR-1234|XR-1238"
const batteryState = new Map();
// NEW: telemetry store
const telemetry = new Map(); // xrId -> latest telemetry record

// ---- Streaming state (UI-only) ----
const lastQuality = new Map();  // xrId -> { ts, bitrateKbps }
const STREAMING_FRESH_MS = 6000; // 2 ticks at ~3s

function isStreaming(xrId) {
  const q = lastQuality.get(xrId);
  if (!q) return false;
  const fresh = (Date.now() - q.ts) < STREAMING_FRESH_MS;
  return fresh && (q.bitrateKbps || 0) > 0; // only green when real video is flowing
}


// Toggle the green border on the center "Connection" box
function updateConnBorder() {
  const box = document.getElementById('conn-box');
  if (!box) return;

  // We key the green ring off the DOCK (XR_RIGHT) by default
  const streaming = isStreaming(typeof XR_RIGHT !== 'undefined' ? XR_RIGHT : 'XR-1238');

  // If you use Tailwind rings:
  box.classList.toggle('ring-2', streaming);
  box.classList.toggle('ring-green-500', streaming);
  box.classList.toggle('ring-offset-0', streaming);

  // If you don't use Tailwind, use a CSS class instead:
  // box.classList.toggle('conn--streaming', streaming);
}

// ===== Live date/time stamp (top-right above "Scribe") =====
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
function formatStamp() {
  const d = new Date();

  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' }).toUpperCase();
  const day = d.getDate();
  const month = d.toLocaleDateString('en-GB', { month: 'long' }).toUpperCase();
  const year = d.getFullYear();

  // ⏰ Add live time (HH:MM, 12-hour with AM/PM)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `${weekday} ${day}${ordinal(day)} ${month} ${year} · ${time}`;
}
function paintNowStamp() {
  const el = document.getElementById('nowStamp');
  if (el) el.textContent = formatStamp();
}



// Gate first paint until both initial snapshots arrive
let gotInitialDevices = false;
let gotInitialPairs = false;

function renderIfReady() {
  // Only block the very first paint; after both arrive once, render freely.
  if (!gotInitialDevices || !gotInitialPairs) return;
  renderDevices();
}

// Helper: battery icon + % text next to it
function batteryMarkup(xrId) {
  const st = batteryState.get(xrId);
  const pct = (st && typeof st.pct === 'number') ? st.pct : null;

  const svg = Icon.battery(pct ?? 0);
  const num = (pct === null) ? '' : `<span class="text-white/90 text-sm">${pct}%</span>`;
  const title = (pct === null) ? 'Battery'
    : `Battery: ${pct}%${st?.charging ? ' (charging)' : ''}`;

  // NOTE: this uses the "battery-btn" class you added in dashboard.html CSS
  return `<div class="icon-btn battery-btn" title="${title}">${svg}${num}</div>`;
}

function inAnyPair(xrId) {
  for (const key of activePairs) {
    if (key.split('|').includes(xrId)) return true;
  }
  return false;
}

// ------- Connection state logic -------
function computeState(xrId) {
  const online = onlineDevices.has(xrId);
  const partner = xrId === XR_LEFT ? XR_RIGHT : XR_LEFT;
  const partnerOnline = onlineDevices.has(partner);
  const pairKey = [xrId, partner].sort().join('|');
  const paired = activePairs.has(pairKey);

  if (!online) return 'busy';        // 🔴 red - device is offline

  // 🟢 green - show green if BOTH devices are online (regardless of formal pairing status)
  // This fixes the race condition where devices connect but pairing event arrives slightly delayed
  if (paired || (online && partnerOnline)) return 'available';

  return 'connecting';               // 🟠 amber - device online but partner not yet online
}

// ---- Cache last connection metrics so the box never goes blank ----
function paintConnMetricsFromCache() {
  const dockId = (typeof XR_RIGHT !== 'undefined' && XR_RIGHT) ? XR_RIGHT : 'XR-1238';
  const q = lastQuality.get(dockId);
  if (!q) return;

  const setNumber = (id, val, suffix = '') => {
    if (!Number.isFinite(val)) return; // do NOT overwrite with blanks
    const el = document.getElementById(id);
    if (el) el.textContent = `${val.toFixed(1)}${suffix}`;
  };

  setNumber('metricJitter', q.jitterMs, ' ms');
  setNumber('metricLoss', q.lossPct, ' %');
  setNumber('metricRtt', q.rttMs, ' ms');
}

// ------- Telemetry helpers (NEW) -------
function barsGlyph(n) {
  if (!Number.isFinite(n)) return '';
  const glyphs = ['▁', '▂', '▃', '▅', '█']; // 0..4
  return ' ' + glyphs[Math.max(0, Math.min(4, n))];
}

function renderNetBadges(xrId) {
  const t = telemetry.get(xrId);
  if (!t) return '';
  if (t.connType === 'wifi') {
    const bits = ['WIFI'];

    // 👉 Only include dBm if it's not 0/null
    if (Number.isFinite(t.wifiDbm) && t.wifiDbm !== 0) {
      bits.push(`${t.wifiDbm} dBm`);
    }

    // Always show Mbps if available
    if (Number.isFinite(t.wifiMbps)) {
      bits.push(`${t.wifiMbps} Mbps`);
    }

    if (Number.isFinite(t.wifiBars)) {
      bits.push(barsGlyph(t.wifiBars));
    }

    return `<div class="text-white/70 text-xs font-medium mt-0.5">${bits.join(' · ')}</div>`;
  }

  if (t.connType === 'cellular') {
    const bits = ['CELLULAR'];
    if (Number.isFinite(t.cellDbm)) bits.push(`${t.cellDbm} dBm`);
    if (Number.isFinite(t.cellBars)) bits.push(barsGlyph(t.cellBars));
    // ✅ Use generic netDownMbps instead of cellMbps
    const mbps = Number.isFinite(t.cellMbps) ? t.cellMbps : t.netDownMbps;
    if (Number.isFinite(mbps)) bits.push(`${mbps} Mbps`);
    return `<div class="text-white/70 text-xs font-medium mt-0.5">${bits.join(' · ')}</div>`;
  }

  if (t.connType === 'ethernet') return `<div class="text-white/70 text-xs font-medium mt-0.5">ETHERNET</div>`;
  if (t.connType === 'none') return `<div class="text-white/70 text-xs font-medium mt-0.5">OFFLINE</div>`;
  return `<div class="text-white/70 text-xs font-medium mt-0.5">${String(t.connType).toUpperCase()}</div>`;
}


// function renderSysPills(xrId) {
//   const t = telemetry.get(xrId);
//   if (!t) return '';

//   // We only show what we have; nothing breaks if a field is missing
//   let ram = '--';
//   if (Number.isFinite(t.memUsedMb) && Number.isFinite(t.memTotalMb) && t.memTotalMb > 0) {
//     ram = `${Math.round((t.memUsedMb / t.memTotalMb) * 100)}%`; // RAM %
//   }
//   const temp = Number.isFinite(t.deviceTempC) ? `${Math.round(t.deviceTempC)}°C` : null;

//   return `
//     <div class="mt-0.5 flex gap-2 text-[11px] text-white/80">
//       <span class="px-2 py-[2px] rounded bg-white/10">RAM ${ram}</span>
//       ${temp ? `<span class="px-2 py-[2px] rounded bg-white/10">TEMP ${temp}</span>` : ``}
//     </div>
//   `;
// }

// ↓↓↓ ADD directly after renderNetBadges(xrId)
function renderSysPills(xrId) {
  const t = telemetry.get(xrId);
  if (!t) return '';

  // Show only when values are meaningful (Android APK sends these; browsers don't).
  const validRam =
    Number.isFinite(t.memUsedMb) &&
    Number.isFinite(t.memTotalMb) &&
    t.memTotalMb >= 128 &&         // ignore bogus/unknown totals
    t.memUsedMb > 0 &&
    t.memUsedMb <= t.memTotalMb;   // sane percentage (1–100)

  const validTemp =
    Number.isFinite(t.deviceTempC) &&
    t.deviceTempC >= 15 &&         // typical device temps (°C)
    t.deviceTempC <= 90;

  // Browser/PWA usually fails both checks → hide the pills entirely.
  if (!validRam && !validTemp) return '';

  const pills = [];
  if (validRam) {
    const pct = Math.round((t.memUsedMb / t.memTotalMb) * 100);
    pills.push(
      `<span class="px-2 py-0.5 rounded bg-white/10 text-white/80 text-[11px]">RAM — ${pct}%</span>`
    );
  }
  if (validTemp) {
    const c = Math.round(t.deviceTempC);
    pills.push(
      `<span class="px-2 py-0.5 rounded bg-white/10 text-white/80 text-[11px]">TEMP — ${c}°C</span>`
    );
  }

  return `<div class="flex gap-2 mt-1">${pills.join('')}</div>`;
}







// --- Signal strength helpers (0..4 like Android) ---
function rssiToBars(dbm) {               // Wi-Fi RSSI thresholds
  if (!Number.isFinite(dbm)) return null;
  if (dbm <= -85) return 0;
  if (dbm <= -75) return 1;
  if (dbm <= -67) return 2;
  if (dbm <= -60) return 3;
  return 4; // > -60 dBm
}

function cellDbmToBars(dbm) {            // LTE/5G typical thresholds
  if (!Number.isFinite(dbm)) return null;
  if (dbm <= -110) return 0;
  if (dbm <= -100) return 1;
  if (dbm <= -90) return 2;
  if (dbm <= -80) return 3;
  return 4; // > -80 dBm
}

function getBarsFor(xrId) {
  const t = telemetry.get(xrId);
  if (!t) return null;

  if (t.connType === 'wifi') {
    let bars = Number.isFinite(t.wifiBars) ? t.wifiBars : rssiToBars(t.wifiDbm);
    if (!Number.isFinite(bars)) return null;
    return { bars: Math.max(0, Math.min(4, Math.round(bars))), label: 'WIFI' };
  }
  if (t.connType === 'cellular') {
    let bars = Number.isFinite(t.cellBars) ? t.cellBars : cellDbmToBars(t.cellDbm);
    if (!Number.isFinite(bars)) return null;
    return { bars: Math.max(0, Math.min(4, Math.round(bars))), label: 'CELL' };
  }
  return null;
}

// Minimal SVG bars (5 columns). Active bars are bright; inactive are dim.
function renderSignalBars(xrId) {
  const s = getBarsFor(xrId);
  if (!s) return '';

  const n = s.bars; // 0..4
  const svg = Array.from({ length: 5 }, (_, i) => {
    const h = 3 + i * 2.2;               // increasing bar heights
    const x = i * 7;
    const y = 14 - h;
    const fill = i <= n ? '#ffffff' : 'rgba(255,255,255,0.35)';
    return `<rect x="${x}" y="${y}" width="5" height="${h}" rx="1" fill="${fill}"></rect>`;
  }).join('');

  // inline style so you don’t need CSS changes
  return `
    <div class="sigbars" style="display:flex;align-items:center" title="${s.label} signal: ${n}/4">
      <svg width="36" height="14" viewBox="0 0 36 14" aria-label="${s.label} signal ${n} of 4">
        ${svg}
      </svg>
    </div>
  `;
}

// ===== C) Connection tiles filler (Android left + Dock right) =====
function latest(id) {
  const q = qualityStore.get(id);
  if (!q || !q.ts.length) return null;
  const i = q.ts.length - 1;
  return { jitter: q.jitter[i], loss: q.loss[i], rtt: q.rtt[i] };
}

function renderConnectionTiles() {
  fillConn('left-connection-box', latest(XR_ANDROID)); // Android
  fillConn('right-connection-box', latest(XR_DOCK));    // Dock
}

function fillConn(containerId, d) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const jitterEl = el.querySelector('.jitter');
  const lossEl = el.querySelector('.loss');
  const rttEl = el.querySelector('.rtt');

  if (jitterEl) jitterEl.textContent = d ? `${Math.round(d.jitter || 0)} ms` : '--';
  if (lossEl) lossEl.textContent = d ? `${(d.loss || 0).toFixed(1)} %` : '--';
  if (rttEl) rttEl.textContent = d ? `${Math.round(d.rtt || 0)} ms` : '--';
}


// ===== Painter for center Connection box =====
function setNum(id, val, suffix = '') {
  const el = document.getElementById(id);
  if (!el) return;
  if (!Number.isFinite(val)) return; // never overwrite with blanks
  el.textContent = `${(typeof val === 'number' ? val : Number(val)).toFixed(1)}${suffix}`;
}

function paintCenterBox() {
  // Android (left)
  const a = latest(XR_ANDROID);
  if (a) {
    setNum('metricJitterLeft', a.jitter, ' ms');
    setNum('metricLossLeft', a.loss, ' %');
    setNum('metricRttLeft', a.rtt, ' ms');
  }

  // Dock (right)
  const d = latest(XR_DOCK);
  if (d) {
    setNum('metricJitterRight', d.jitter, ' ms');
    setNum('metricLossRight', d.loss, ' %');
    setNum('metricRttRight', d.rtt, ' ms');
  }
}



// ------- Rows -------
function buildRows() {
  // ✅ Independent states
  const leftState = computeState(XR_LEFT);
  const rightState = computeState(XR_RIGHT);

  // Live battery % for XR-1234 (left). Falls back to STATIC_BATTERY_LEFT.
  const st = batteryState.get(XR_LEFT);
  const batteryPct = (st && typeof st.pct === 'number') ? st.pct : STATIC_BATTERY_LEFT;

  return [
    {
      label: 'Provider 1',
      left: { text: `XR VISION : ${XR_LEFT.replace('XR-', '')}`, state: leftState, battery: batteryPct },
      scribe: 'Scribe 1',
      right: { text: `XR VISION DOCK : ${XR_RIGHT.replace('XR-', '')}`, state: rightState }
    }
  ];
}

// Render
function rowHTML({ label, left, scribe, right }) {
  const leftChip = `<button class="device-chip" data-xr="${XR_LEFT}">${chip(left.text, left.state)}</button>`;
  const rightChip = `<button class="device-chip" data-xr="${XR_RIGHT}">${chip(right.text, right.state)}</button>`;

  return `
  <div class="grid grid-cols-12 gap-3 md:gap-4 items-center">
    <div class="col-span-12 md:col-span-2 text-white/90 text-base md:text-lg">${label}</div>

    <!-- LEFT: Android card -->
    <div class="col-span-12 md:col-span-4 flex flex-col md:pl-6">
      <div class="flex items-center gap-3">
        ${leftChip}
        <div class="flex gap-2">
          <button class="icon-btn" title="Edit">${Icon.pen}</button>
          ${renderSignalBars(XR_LEFT)}
          ${batteryMarkup(XR_LEFT)}
        </div>
      </div>
      ${renderNetBadges(XR_LEFT)}
      ${renderSysPills(XR_LEFT)}   <!-- NEW: Android-only RAM/TEMP pills -->


      
    </div>


    <!-- Center: Connection Quality (Android left | Dock right) -->
<div class="col-span-12 md:col-span-2">
  <div id="conn-box" class="rounded-xl bg-white/5 border border-white/10 p-3 md:p-3.5 ring-0">
    
    <div class="grid grid-cols-2 gap-3">
      <!-- ANDROID (left) -->
      <div class="pr-2 border-r border-white/20">
        <div class="grid grid-cols-3 gap-2 text-sm text-white/90 text-left">
          <div><div class="text-[10px] text-white/60">J</div><div id="metricJitterLeft">—</div></div>
          <div><div class="text-[10px] text-white/60">L</div><div id="metricLossLeft">—</div></div>
          <div><div class="text-[10px] text-white/60">R</div><div id="metricRttLeft">—</div></div>
        </div>
      </div>

      <!-- DOCK (right) -->
      <div class="pl-2">
        <div class="grid grid-cols-3 gap-2 text-sm text-white/90 text-right">
          <div><div class="text-[10px] text-white/60">J</div><div id="metricJitterRight">—</div></div>
          <div><div class="text-[10px] text-white/60">L</div><div id="metricLossRight">—</div></div>
          <div><div class="text-[10px] text-white/60">R</div><div id="metricRttRight">—</div></div>
        </div>
      </div>
    </div>
  </div>
</div>





    

    <!-- RIGHT: Dock card -->
    <div class="col-span-12 md:col-span-4 flex flex-col items-end">
      <div class="flex items-center justify-end gap-3">
        <div class="text-white/90 text-base md:text-lg mr-20 pr-2">${scribe}</div><!-- ✅ matched size --> 
        ${rightChip}
        <div class="flex gap-2">
          <button class="icon-btn" title="Edit">${Icon.pen}</button>
          ${renderSignalBars(XR_RIGHT)}
          <button class="icon-btn" title="Message">${Icon.mail}</button>
        </div>
      </div>
      ${renderNetBadges(XR_RIGHT)}
      

      
    </div>
  </div>
  <div class="border-b divider"></div>`;
}


function renderDevices() {
  const el = document.getElementById('rows');
  if (!el) return;
  el.innerHTML = buildRows().map(rowHTML).join('');

  // Keep metrics visible between updates
  paintConnMetricsFromCache();
  updateConnBorder();
  renderConnectionTiles();   // 🔸 add this line
  paintCenterBox();        // ← keep this


  // After first successful render, stop gating future renders
  gotInitialDevices = true;
  gotInitialPairs = true;
}


// ---------------- Socket wiring ----------------
let socket = null;

// Fallback to same-origin if the HTML didn't set SOCKET_URL
if (!window.SOCKET_URL) {
  window.SOCKET_URL = window.location.origin;
}
function initSocket() {
  if (!window.io) {
    console.warn('[DASHBOARD] socket.io client missing; showing static view only.');
    // Don't render immediately; no live snapshots available
    return;
  }
  if (socket) return;

  socket = io(window.SOCKET_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    timeout: 10000,
  });


  socket.on('connect', () => {
    try { socket.emit('request_device_list'); } catch { }
  });

  socket.on('device_list', (list = []) => {
    onlineDevices.clear();
    for (const d of list) if (d?.xrId) onlineDevices.set(d.xrId, d);
    gotInitialDevices = true;
    renderIfReady(); // 🔸 first paint waits for pairs too
  });

  // Live battery updates (render immediately; post-first-paint this is fine)
  socket.on('battery_update', ({ xrId, pct, charging }) => {
    batteryState.set(xrId, { pct, charging: !!charging });
    renderDevices();
  });

  socket.on('room_update', ({ pairs = [] } = {}) => {
    activePairs.clear();
    for (const { a, b } of pairs) activePairs.add([a, b].sort().join('|'));
    gotInitialPairs = true;
    renderIfReady(); // 🔸 first paint waits for devices too
  });

  // NEW: telemetry updates
  // socket.on('telemetry_update', (rec = {}) => {
  //   if (rec.xrId) telemetry.set(rec.xrId, rec);
  //   renderDevices();
  // });

  socket.on('telemetry_update', (data = {}) => {
    const deviceId = data.deviceId || data.xrId;     // supports both shapes
    const sample = data.sample || data;          // supports both shapes
    if (deviceId) telemetry.set(deviceId, sample);
    renderDevices();
  });




  // ===== B) Per-device WebRTC quality: update tiles + modal =====
  socket.on('webrtc_quality_update', (payload) => {
    // Server may send: { deviceId, samples } OR an array of { xrId, ... } (legacy)
    // Normalize both shapes into an array of { xrId, ts, jitterMs, rttMs, lossPct, bitrateKbps }
    const items = [];

    if (Array.isArray(payload)) {
      // legacy: array of flat samples
      for (const s of payload) {
        const xrId = s.xrId || s.deviceId;
        if (!xrId) continue;
        items.push({
          xrId,
          ts: s.ts ?? Date.now(),
          jitterMs: s.jitterMs,
          rttMs: s.rttMs,
          lossPct: s.lossPct,
          bitrateKbps: s.bitrateKbps
        });
      }
    } else if (payload && payload.deviceId && Array.isArray(payload.samples)) {
      for (const s of payload.samples) {
        items.push({
          xrId: payload.deviceId,
          ts: s.ts ?? Date.now(),
          jitterMs: s.jitterMs,
          rttMs: s.rttMs,
          lossPct: s.lossPct,
          bitrateKbps: s.bitrateKbps
        });
      }
    } else {
      return; // unknown shape
    }

    // 1) Feed per-device rolling history (cap ~200 points)
    for (const s of items) {
      const q = getQ(s.xrId);
      q.ts.push(s.ts);
      q.jitter.push(s.jitterMs);
      q.rtt.push(s.rttMs);
      q.loss.push(s.lossPct);
      q.kbps.push(s.bitrateKbps);
      if (q.ts.length > 200) { q.ts.shift(); q.jitter.shift(); q.rtt.shift(); q.loss.shift(); q.kbps.shift(); }
    }

    // 2) Update tiles for BOTH devices
    renderConnectionTiles();
    paintCenterBox();        // ← keep this

    // 3) Keep your center Dock box (metricJitter/Loss/RTT) using your existing cache logic
    //    Choose the *latest sample* for Dock and store in lastQuality
    const dockId = (typeof XR_RIGHT !== 'undefined' && XR_RIGHT) ? XR_RIGHT : 'XR-1238';
    // pick the freshest item for this dock id
    const freshestDock = items
      .filter(s => s.xrId === dockId)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];

    if (freshestDock) {
      lastQuality.set(dockId, {
        ts: Date.now(),
        bitrateKbps: Number.isFinite(freshestDock.bitrateKbps) ? freshestDock.bitrateKbps : 0,
        jitterMs: Number.isFinite(freshestDock.jitterMs) ? freshestDock.jitterMs : lastQuality.get(dockId)?.jitterMs ?? null,
        lossPct: Number.isFinite(freshestDock.lossPct) ? freshestDock.lossPct : lastQuality.get(dockId)?.lossPct ?? null,
        rttMs: Number.isFinite(freshestDock.rttMs) ? freshestDock.rttMs : lastQuality.get(dockId)?.rttMs ?? null,
      });
      paintConnMetricsFromCache();
      updateConnBorder();
    }

    // 4) If the detail modal is open for a specific device, push these points to charts
    if (window.__metricsXrId) {
      const forThis = items.filter(s => s.xrId === window.__metricsXrId);
      if (forThis.length && typeof addQualityPoints === 'function' && typeof updateAll === 'function') {
        addQualityPoints(forThis.map(s => ({
          ts: s.ts,
          jitterMs: s.jitterMs,
          rttMs: s.rttMs,
          lossPct: s.lossPct,
          bitrateKbps: s.bitrateKbps
        })));
        updateAll();
      }
    }
  });




  // ---- Detail modal + charts (NEW) ----
  const modal = document.getElementById('detailModal');
  const titleEl = document.getElementById('detailTitle');
  const closeBtn = document.getElementById('detailClose');

  let batteryChart, netChart, bitrateChart, qualityChart;


  function initCharts() {
    if (batteryChart) return;

    const timeOpts = {
      parsing: false,
      spanGaps: true, // keep lines continuous across brief gaps
      elements: {
        // remove point markers (also on hover)
        point: { radius: 0, hoverRadius: 0, hitRadius: 6 }
      },
      plugins: {
        legend: { display: true },
        // safe perf boost when many points stream in
        decimation: { enabled: true, algorithm: 'lttb', samples: 600 }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'minute' } // keep your current unit
        }
      }
    };

    batteryChart = new Chart(document.getElementById('batteryChart'), {
      type: 'line',
      data: { datasets: [{ label: 'Battery %', data: [] }] },
      options: timeOpts
    });

    netChart = new Chart(document.getElementById('netChart'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Down Mbps', data: [] },
          { label: 'Up Mbps', data: [] }
        ]
      },
      options: timeOpts
    });

    bitrateChart = new Chart(document.getElementById('bitrateChart'), {
      type: 'line',
      data: { datasets: [{ label: 'Bitrate kbps', data: [] }] },
      options: timeOpts
    });

    qualityChart = new Chart(document.getElementById('qualityChart'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'Jitter ms', data: [] },
          { label: 'RTT ms', data: [] },
          { label: 'Loss %', data: [] }
        ]
      },
      options: timeOpts
    });
  }


  function openDeviceDetail(xrId, label = xrId) {
    window.__metricsXrId = xrId;
    initCharts();
    titleEl.textContent = `Device Detail – ${label}`;
    [batteryChart, netChart, bitrateChart, qualityChart].forEach(ch => {
      ch.data.datasets.forEach(ds => ds.data = []);
      ch.update();
    });
    socket.emit('metrics_subscribe', { xrId });
    modal.classList.remove('hidden');
  }

  closeBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
    if (window.__metricsXrId) {
      socket.emit('metrics_unsubscribe', { xrId: window.__metricsXrId });
      window.__metricsXrId = null;
    }
  });

  // Snapshot + live points
  socket.on('metrics_snapshot', ({ xrId, telemetry = [], quality = [] }) => {
    if (xrId !== window.__metricsXrId) return;
    addTelemetryPoints(telemetry);
    addQualityPoints(quality);
    updateAll();
  });
  socket.on('metrics_update', ({ xrId, telemetry = [], quality = [] }) => {
    if (xrId !== window.__metricsXrId) return;
    addTelemetryPoints(telemetry);
    addQualityPoints(quality);
    updateAll();
  });

  function addTelemetryPoints(arr) {
    for (const p of arr) {
      const x = p.ts;
      if (Number.isFinite(p.batteryPct)) batteryChart.data.datasets[0].data.push({ x, y: p.batteryPct });
      const down = Number.isFinite(p.wifiMbps) ? p.wifiMbps :
        Number.isFinite(p.netDownMbps) ? p.netDownMbps : null;
      const up = Number.isFinite(p.netUpMbps) ? p.netUpMbps : null;
      if (down != null) netChart.data.datasets[0].data.push({ x, y: down });
      if (up != null) netChart.data.datasets[1].data.push({ x, y: up });
    }
  }
  function addQualityPoints(arr) {
    for (const q of arr) {
      const x = q.ts;
      if (Number.isFinite(q.jitterMs)) qualityChart.data.datasets[0].data.push({ x, y: q.jitterMs });
      if (Number.isFinite(q.rttMs)) qualityChart.data.datasets[1].data.push({ x, y: q.rttMs });
      if (Number.isFinite(q.lossPct)) qualityChart.data.datasets[2].data.push({ x, y: q.lossPct });
      if (Number.isFinite(q.bitrateKbps)) bitrateChart.data.datasets[0].data.push({ x, y: q.bitrateKbps });
    }
  }
  function updateAll() {
    batteryChart.update('none');
    netChart.update('none');
    bitrateChart.update('none');
    qualityChart.update('none');
  }

  // Delegate clicks on any .chip[data-xr]
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.device-chip[data-xr]');
    if (!btn) return;
    const xr = btn.getAttribute('data-xr');
    const label = btn.textContent.trim();
    currentDetailId = xr; // track for parity with A–D plan
    openDeviceDetail(xr, label);
  });

  // ✅ ADD THIS (still inside initSocket, before the closing brace)
  // Re-evaluate the border every second so it auto-clears ~6s after stop/hide
  setInterval(updateConnBorder, 1000);
} // <— end of initSocket()





// ---------------- Boot ----------------
document.addEventListener('DOMContentLoaded', () => {
  // No initial render here—wait for both snapshots to avoid flicker
  initSocket();

  // Paint date after DOM is ready and refresh it
  paintNowStamp();
  setInterval(paintNowStamp, 60 * 1000); // update every minute
});
