/* global luxon */
(() => {
  // ===== Luxon or fallback =====
  let DateTime, luxonOK = false;
  if (window.luxon && window.luxon.DateTime) {
    DateTime = window.luxon.DateTime;
    luxonOK = true;
  }

  // ===== CONFIG =====
  // Schedules live in your Gist (RAW URL)
  const SCHEDULES_URL =
    'https://gist.githubusercontent.com/andrewharris-netizen/f731d56672883762b9ba4c3b9b588b38/raw/43130bfa0fb630016e50ee23d7b8a3106124d83f/gistfile1.txt';

  const SCHOOL_TZ = 'America/Chicago';
  const SCHOOL_HOURS = { start: '07:00', end: '17:00' }; // for dim overlay
  const FLASH_MS = 5000;        // flash duration on timer end
  const FLASH_SWAP_MS = 250;    // color swap interval

  const UI = {
    bg: '#000000',
    fg: '#ffffff',
    flashA: '#ffffff',
    flashB: '#e00000'
  };

  // ===== STATE =====
  let schedules = {};          // modes -> blocks
  let modesOrder = [];
  let activeMode = 'Regular';
  const nineWeeksPair = ['Nine Weeks A (1/3/5/7)', 'Nine Weeks B (2/4/5/6)'];

  let timerEnd = null;         // Luxon DateTime OR native Date
  let flashUntil = null;       // same type as timerEnd
  let flashToggle = false;

  let volume = 0.6;
  let muted = false;

  let simOffsetMs = 0;         // simulation offset relative to real now()

  // WebAudio
  let audioCtx = null;
  let gainNode = null;
  let audioReady = false;

  // ===== DOM =====
  const el = (id) => document.getElementById(id);
  const timeEl = el('time');
  const dateEl = el('date');
  const modeTagEl = el('modeTag');
  const simTagEl = el('simTag');
  const currEl = el('currentPeriod');
  const nextEl = el('nextBell');
  const tableEl = el('scheduleTable');
  const countdownOverlay = el('countdownOverlay');
  const countdownText = el('countdownText');
  const flashOverlay = el('flashOverlay');
  const dimOverlay = el('dimOverlay');
  const reloadBtn = el('reloadBtn');
  const fullscreenBtn = el('fullscreenBtn');
  const toastContainer = el('toastContainer');
  const audioGateBtn = el('audioGate');

  // ===== Toast helpers =====
  function showToast(msg, ms = 2000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function hideAudioGate() {
    audioGateBtn.classList.add('hidden');
  }

  // ===== Audio helpers =====
  function ensureAudio() {
    if (audioReady) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(audioCtx.destination);
    audioReady = true;
    hideAudioGate();
  }

  function beep(freq = 880, ms = 180) {
    if (!audioReady || muted) return;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const g = audioCtx.createGain();
    g.gain.value = volume;

    osc.connect(g).connect(gainNode);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  }

  // ===== Time helpers (Luxon + fallback) =====
  function parseHHMM(str) {
    const [h, m] = str.split(':').map(Number);
    return { h, m };
  }

  function nowReal() {
    // Real time in central / local depending on luxon availability
    if (luxonOK) return DateTime.now().setZone(SCHOOL_TZ);
    return new Date();
  }

  function now() {
    // Simulated "now"
    if (luxonOK) {
      return nowReal().plus({ milliseconds: simOffsetMs });
    } else {
      return new Date(nowReal().getTime() + simOffsetMs);
    }
  }

  function addSeconds(t, secs) {
    if (luxonOK) return t.plus({ seconds: secs });
    return new Date(t.getTime() + secs * 1000);
  }

  function addMillis(t, ms) {
    if (luxonOK) return t.plus({ milliseconds: ms });
    return new Date(t.getTime() + ms);
  }

  function secondsBetween(a, b) {
    if (!a || !b) return 0;
    if (luxonOK) return b.diff(a, 'seconds').seconds;
    return (b.getTime() - a.getTime()) / 1000;
  }

  function fmtClock(t) {
    if (luxonOK) return t.toFormat('h:mm:ss a');
    return t.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit'
    });
  }

  function fmtDate(t) {
    if (luxonOK) return t.toFormat('EEE, LLL dd, yyyy');
    return t.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: '2-digit', year: 'numeric'
    });
  }

  function fmtHM(t) {
    if (luxonOK) return t.toFormat('h:mm a');
    return t.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit'
    });
  }

  function mmss(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function todayRange() {
    const n = now();
    const startParts = parseHHMM(SCHOOL_HOURS.start);
    const endParts = parseHHMM(SCHOOL_HOURS.end);

    if (luxonOK) {
      const start = n.set({
        hour: startParts.h,
        minute: startParts.m,
        second: 0,
        millisecond: 0
      });
      const end = n.set({
        hour: endParts.h,
        minute: endParts.m,
        second: 0,
        millisecond: 0
      });
      return { start, end };
    } else {
      const year = n.getFullYear();
      const month = n.getMonth();
      const day = n.getDate();
      const start = new Date(year, month, day, startParts.h, startParts.m, 0, 0);
      const end = new Date(year, month, day, endParts.h, endParts.m, 0, 0);
      return { start, end };
    }
  }

  // ===== Schedule building & status =====
  function buildBlocksFor(modeName) {
    const list = (schedules[modeName] || []);
    const n = now();

    if (luxonOK) {
      const blocks = list.map(({ label, start, end }) => {
        const s = parseHHMM(start);
        const e = parseHHMM(end);
        let sdt = n.set({
          hour: s.h, minute: s.m, second: 0, millisecond: 0
        });
        let edt = n.set({
          hour: e.h, minute: e.m, second: 0, millisecond: 0
        });
        if (edt <= sdt) edt = sdt.plus({ minutes: 1 });
        return { sdt, edt, label };
      }).sort((a, b) => a.sdt - b.sdt);
      return blocks;
    } else {
      const year = n.getFullYear();
      const month = n.getMonth();
      const day = n.getDate();
      const blocks = list.map(({ label, start, end }) => {
        const s = parseHHMM(start);
        const e = parseHHMM(end);
        const sdt = new Date(year, month, day, s.h, s.m, 0, 0);
        let edt = new Date(year, month, day, e.h, e.m, 0, 0);
        if (edt <= sdt) edt = new Date(sdt.getTime() + 60 * 1000);
        return { sdt, edt, label };
      }).sort((a, b) => a.sdt - b.sdt);
      return blocks;
    }
  }

  function scheduleStatus(n, blocks) {
    if (!blocks.length) return { state: 'noschedule' };

    for (let i = 0; i < blocks.length; i++) {
      const { sdt, edt, label } = blocks[i];

      if (n >= sdt && n < edt) {
        const next = blocks[i + 1];
        return {
          state: 'in_period',
          current: label,
          nextBell: edt,
          nextBellLabel: `End of ${label}`,
          nextPeriodLabel: next ? next.label : null
        };
      }

      if (n < sdt) {
        const prev = blocks[i - 1];
        if (!prev || prev.edt <= n) {
          return {
            state: 'passing',
            current: 'Passing Period',
            nextBell: sdt,
            nextBellLabel: `${label} begins`,
            nextPeriodLabel: label
          };
        }
      }
    }

    // after last block
    return { state: 'noschedule' };
  }

function updateTabTitle(stat, n) {
  if (!stat || !stat.nextBell) {
    document.title = 'School Bell Clock';
    return;
  }

  const seconds = secondsBetween(n, stat.nextBell);
  const remaining = mmss(seconds);

  if (stat.state === 'in_period') {
    document.title = `⏰ ${remaining} left — ${stat.current}`;
  } else if (stat.state === 'passing') {
    document.title = `⏳ ${remaining} to ${stat.nextPeriodLabel}`;
  } else {
    document.title = 'School Bell Clock';
  }
}


  // ===== Render helpers =====
  function renderClock(n) {
    timeEl.textContent = fmtClock(n);
    dateEl.textContent = fmtDate(n);
  }

  function renderModeTag() {
    modeTagEl.textContent = `Mode: ${activeMode}`;
  }

  function renderScheduleTable(blocks, n) {
    tableEl.innerHTML = '';
    let activeIndex = -1;

    blocks.forEach((b, i) => {
      if (n >= b.sdt && n < b.edt) activeIndex = i;
    });

    blocks.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === activeIndex ? ' active' : '');

      const c1 = document.createElement('div');
      const c2 = document.createElement('div');
      c1.className = 'cell label';
      c2.className = 'cell time';

      c1.textContent = b.label;

      const sFmt = fmtHM(b.sdt);
      const eFmt = fmtHM(b.edt);
      c2.textContent = `${sFmt}–${eFmt}`;

      row.appendChild(c1);
      row.appendChild(c2);
      tableEl.appendChild(row);
    });
  }

  function renderCenter(stat, n) {
    if (!stat || stat.state === 'noschedule') {
      currEl.textContent = 'No school schedule active';
      nextEl.textContent = '';
      return;
    }

    currEl.textContent = stat.current || '';

    if (stat.nextBell) {
      const seconds = secondsBetween(n, stat.nextBell);
      const bellStr = fmtHM(stat.nextBell);
      nextEl.textContent = `Next bell: ${bellStr} • ${mmss(seconds)}`;
    } else {
      nextEl.textContent = '';
    }
  }

  function setDim(n) {
    const { start, end } = todayRange();
    const inHours = n >= start && n <= end;
    dimOverlay.classList.toggle('hidden', inHours);
  }

  function showCountdown(text) {
    countdownText.textContent = text;
    countdownOverlay.classList.remove('hidden');
  }

  function hideCountdown() {
    countdownOverlay.classList.add('hidden');
  }

  function setFlashLayer(n) {
    const inFlash = flashUntil && n < flashUntil;
    if (!inFlash) {
      flashOverlay.classList.add('hidden');
      return;
    }
    flashOverlay.classList.remove('hidden');
    flashToggle = !flashToggle;
    countdownText.style.color = flashToggle ? UI.flashA : UI.flashB;
  }

  // ===== MAIN LOOP =====
  function loop() {
    const n = now();
    renderClock(n);
    setDim(n);

    const blocks = buildBlocksFor(activeMode);
    const stat = scheduleStatus(n, blocks);
    updateTabTitle(stat, n);

    // If a bell occurs during a timer → cancel timer and return bell view
    if (timerEnd && stat.nextBell && n >= stat.nextBell) {
      timerEnd = null;
      flashUntil = null;
      hideCountdown();
      showToast('Timer canceled (bell)');
    }

    // Timer + flash logic
    if (flashUntil && n < flashUntil) {
      showCountdown('0:00');
      setFlashLayer(n);
    } else if (timerEnd) {
      const sec = secondsBetween(n, timerEnd);
      if (sec <= 0) {
        // Time's up: play chime + start flash
        beep();
        flashUntil = addMillis(n, FLASH_MS);
        timerEnd = null;
        countdownText.style.color = UI.flashA;
        showCountdown('0:00');
      } else {
        countdownText.style.color = UI.fg;
        showCountdown(mmss(sec));
      }
    } else {
      hideCountdown();
      countdownText.style.color = UI.fg;
    }

    // Normal content
    renderCenter(stat, n);
    renderScheduleTable(blocks, n);
    simTagEl.textContent = simOffsetMs ? 'SIM TIME' : '';

    requestAnimationFrame(loop);
  }

  // ===== Controls =====
  function startTimer(seconds) {
    const n = now();
    timerEnd = addSeconds(n, seconds);
    flashUntil = null;
    showToast(`Timer: ${mmss(seconds)}`);
    ensureAudio();
    beep(660, 120); // confirm chirp
  }

  function cancelTimer() {
    timerEnd = null;
    flashUntil = null;
    hideCountdown();
    showToast('Timer canceled');
  }

  function toggleNineWeeks() {
    if (activeMode === nineWeeksPair[0]) {
      activeMode = nineWeeksPair[1];
    } else if (activeMode === nineWeeksPair[1]) {
      activeMode = nineWeeksPair[0];
    } else {
      activeMode = nineWeeksPair[0];
    }
    renderModeTag();
    showToast(activeMode);
  }

  function cycleMode() {
    if (!modesOrder.length) return;
    const i = modesOrder.indexOf(activeMode);
    const j = (i + 1) % modesOrder.length;
    activeMode = modesOrder[j];
    renderModeTag();
    showToast(`Mode: ${activeMode}`);
  }

  function keyHandler(e) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    switch (e.key) {
      case 'Escape':
        document.exitFullscreen?.();
        break;

      // Modes
      case 'r': case 'R':
        if (schedules['Regular']) {
          activeMode = 'Regular';
          renderModeTag();
          showToast('Mode: Regular');
        }
        break;
      case 'p': case 'P':
        if (schedules['Pep Rally']) {
          activeMode = 'Pep Rally';
          renderModeTag();
          showToast('Mode: Pep Rally');
        }
        break;
      case 'e': case 'E':
        if (schedules['Early Release']) {
          activeMode = 'Early Release';
          renderModeTag();
          showToast('Mode: Early Release');
        }
        break;
      case 't': case 'T':
        toggleNineWeeks();
        break;
      case 's': case 'S':
        cycleMode();
        break;

      // Timers
      case '1':
        startTimer(30);
        break;
      case '5':
        startTimer(300);
        break;
      case '0':
        startTimer(600);
        break;
      case 'Backspace':
        cancelTimer();
        break;

      // Audio
      case 'm': case 'M':
        muted = !muted;
        showToast(muted ? 'Muted' : 'Unmuted');
        break;
      case '+': case '=':
        volume = Math.min(1, volume + 0.1);
        if (gainNode) gainNode.gain.value = volume;
        showToast(`Volume: ${Math.round(volume * 100)}%`);
        break;
      case '-':
        volume = Math.max(0, volume - 0.1);
        if (gainNode) gainNode.gain.value = volume;
        showToast(`Volume: ${Math.round(volume * 100)}%`);
        break;

      // Simulation controls
      case ']':
        simOffsetMs += 5 * 60 * 1000;
        showToast(`Sim +5m → ${fmtClock(now())}`);
        break;
      case '[':
        simOffsetMs -= 5 * 60 * 1000;
        showToast(`Sim -5m → ${fmtClock(now())}`);
        break;
      case '\\':
        simOffsetMs = 0;
        showToast('Sim reset');
        break;
      case 'n': case 'N': {
        const n = now();
        const stat = scheduleStatus(n, buildBlocksFor(activeMode));
        if (stat.nextBell) {
          const target = luxonOK
            ? stat.nextBell.minus({ seconds: 5 })
            : new Date(stat.nextBell.getTime() - 5000);

          const realNow = nowReal();
          simOffsetMs = luxonOK
            ? target.diff(realNow, 'milliseconds').milliseconds
            : (target.getTime() - realNow.getTime());

          showToast(`Jump → ${fmtClock(target)}`);
        } else {
          showToast('No next bell in this mode');
        }
        break;
      }

      // Fullscreen shortcut
      case 'f': case 'F':
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.();
        } else {
          document.exitFullscreen?.();
        }
        break;
    }
  }

  // ===== Fetch schedules =====
  async function fetchSchedules() {
    const url = SCHEDULES_URL + (SCHEDULES_URL.includes('?') ? '&' : '?') + 'cachebust=' + Date.now();
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      showToast(`Fetch failed: ${e.message}`, 5000);
      throw e;
    }
    if (!res.ok) {
      const msg = `Fetch schedules failed: ${res.status} ${res.statusText}`;
      showToast(msg, 5000);
      throw new Error(msg);
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      showToast(`Bad JSON: ${e.message}`, 5000);
      throw e;
    }

    schedules = data.modes ? data.modes : data;
    modesOrder = Object.keys(schedules);

    if (!modesOrder.length) {
      const msg = 'No modes found in schedules.json';
      showToast(msg, 5000);
      throw new Error(msg);
    }
    if (!schedules[activeMode]) activeMode = modesOrder[0];

    renderModeTag();
    showToast('Schedules loaded');
  }

  // ===== Init =====
  reloadBtn.addEventListener('click', async () => {
    try {
      await fetchSchedules();
    } catch (err) {
      console.error(err);
    }
  });

  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    }
  });

  window.addEventListener('keydown', keyHandler);

  // Browser audio policy: require one user gesture
  ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(evt => {
    window.addEventListener(
      evt,
      () => {
        if (!audioReady) {
          try {
            ensureAudio();
            audioCtx.resume?.();
          } catch {}
        }
      },
      { once: true }
    );
  });

  audioGateBtn.addEventListener('click', () => {
    ensureAudio();
    audioCtx.resume?.();
  });

  // Start
  (async () => {
    try {
      await fetchSchedules();
    } catch (err) {
      console.error(err);
    }
    renderModeTag();
    requestAnimationFrame(loop);
  })();
})();
