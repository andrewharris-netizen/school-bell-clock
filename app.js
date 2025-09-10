/* global luxon */
(() => {
  const { DateTime, Interval } = luxon;

  // ====== CONFIG ======
  // Set this to your RAW Gist URL (best CORS behavior) or keep local 'schedules.json' while testing.
  const SCHEDULES_URL = 'schedules.json'; // <-- replace with your Gist raw URL when ready
  const SCHOOL_TZ = 'America/Chicago';
  const SCHOOL_HOURS = { start: '07:00', end: '17:00' }; // dim outside these
  const FLASH_MS = 5000; // flash time on timer end
  const FLASH_SWAP_MS = 250; // red/white swap period
  const UI = {
    bg: '#000', fg: '#fff', flashA: '#ffffff', flashB: '#e00000'
  };

  // ====== STATE ======
  let schedules = {};          // fetched JSON object
  let modesOrder = [];         // ["Regular", "Pep Rally", ...]
  let activeMode = 'Regular';  // current mode name
  let nineWeeksPair = ['Nine Weeks A (1/3/5/7)', 'Nine Weeks B (2/4/5/6)'];

  let timerEnd = null;         // DateTime in SCHOOL_TZ
  let flashUntil = null;       // DateTime
  let flashToggle = false;

  let volume = 0.6;
  let muted = false;

  let simOffsetMs = 0;         // simulation offset in ms
  let audioReady = false;

  // WebAudio beep
  let audioCtx = null, gainNode = null;
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

  // ====== DOM ======
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

  function showToast(msg, ms = 2000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  function hideAudioGate() { audioGateBtn.classList.add('hidden'); }

  // ====== SCHEDULES FETCH ======
  async function fetchSchedules() {
    const url = SCHEDULES_URL + (SCHEDULES_URL.includes('?') ? '&' : '?') + 'cachebust=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Fetch schedules failed: ${res.status}`);
    const data = await res.json();
    schedules = data.modes ? data.modes : data; // allow either top-level or under "modes"
    // Build order (prefer standard names)
    modesOrder = Object.keys(schedules);
    if (modesOrder.length === 0) throw new Error('No modes found in schedules.json');

    // If the current active mode doesn't exist, fall back to the first.
    if (!schedules[activeMode]) {
      activeMode = modesOrder[0];
    }
    showToast('Schedules loaded');
    renderModeTag();
  }

  // ====== TIME HELPERS ======
  const parseHHMM = (str) => {
    const [h, m] = str.split(':').map(Number);
    return { h, m };
  };
  function now() {
    // central time with simulation offset
    return DateTime.now().setZone(SCHOOL_TZ).plus({ milliseconds: simOffsetMs });
  }
  function todayRange() {
    const n = now();
    const s = parseHHMM(SCHOOL_HOURS.start);
    const e = parseHHMM(SCHOOL_HOURS.end);
    const start = n.set({ hour: s.h, minute: s.m, second: 0, millisecond: 0 });
    const end = n.set({ hour: e.h, minute: e.m, second: 0, millisecond: 0 });
    return { start, end };
  }
  function buildBlocksFor(modeName) {
    const list = schedules[modeName] || [];
    const n = now();
    const blocks = list.map(({ label, start, end }) => {
      const s = parseHHMM(start), e = parseHHMM(end);
      let sdt = n.set({ hour: s.h, minute: s.m, second: 0, millisecond: 0 });
      let edt = n.set({ hour: e.h, minute: e.m, second: 0, millisecond: 0 });
      if (edt <= sdt) edt = sdt.plus({ minutes: 1 });
      return { sdt, edt, label };
    }).sort((a,b) => a.sdt - b.sdt);
    return blocks;
  }
  function scheduleStatus(n, blocks) {
    if (!blocks.length) return { state: 'noschedule' };
    for (let i = 0; i < blocks.length; i++) {
      const { sdt, edt, label } = blocks[i];
      if (n >= sdt && n < edt) {
        const next = blocks[i+1];
        return {
          state: 'in_period',
          current: label,
          nextBell: edt,
          nextBellLabel: `End of ${label}`,
          nextPeriodLabel: next ? next.label : null
        };
      }
      if (n < sdt) {
        const prev = blocks[i-1];
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
    // after last
    if (n >= blocks[blocks.length - 1].edt) return { state: 'noschedule' };
    return { state: 'noschedule' };
  }

  // ====== RENDER ======
  function mmss(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${String(r).padStart(2,'0')}`;
  }
  function renderClock(n) {
    timeEl.textContent = n.toFormat('h:mm:ss a');
    dateEl.textContent = n.toFormat('EEE, LLL dd, yyyy');
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
      c2.textContent = `${b.sdt.toFormat('h:mm a')}–${b.edt.toFormat('h:mm a')}`;
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
      const seconds = stat.nextBell.diff(n, 'seconds').seconds;
      nextEl.textContent = `Next bell: ${stat.nextBell.toFormat('h:mm a')} • ${mmss(seconds)}`;
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
    // toggle color
    flashToggle = !flashToggle;
    flashOverlay.style.background = flashToggle ? 'transparent'
      : 'transparent'; // we draw text only; background stays transparent
    // We flash by swapping the countdownText color instead (simpler):
    countdownText.style.color = flashToggle ? UI.flashA : UI.flashB;
  }

  // ====== MAIN LOOP ======
  function loop() {
    const n = now();
    renderClock(n);
    setDim(n);

    const blocks = buildBlocksFor(activeMode);
    const stat = scheduleStatus(n, blocks);

    // If a bell happens during a timer → cancel timer and return bell view
    if (timerEnd && stat.nextBell && n >= stat.nextBell) {
      timerEnd = null; flashUntil = null; hideCountdown();
      showToast('Timer canceled (bell)');
    }

    // Timer / flash handling
    if (flashUntil && n < flashUntil) {
      // display 0:00 flashing
      showCountdown('0:00');
      setFlashLayer(n);
    } else if (timerEnd) {
      const sec = timerEnd.diff(n, 'seconds').seconds;
      if (sec <= 0) {
        // time's up
        beep();
        flashUntil = n.plus({ milliseconds: FLASH_MS });
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

    // Normal view content (when no countdown overlay)
    renderCenter(stat, n);
    renderScheduleTable(blocks, n);
    simTagEl.textContent = simOffsetMs ? 'SIM TIME' : '';

    // schedule another tick
    requestAnimationFrame(loop);
  }

  // ====== CONTROLS ======
  function startTimer(seconds) {
    const n = now();
    timerEnd = n.plus({ seconds });
    flashUntil = null;
    showToast(`Timer: ${mmss(seconds)}`);
    ensureAudio(); // unlock if not already
    beep(660, 120); // small confirm chirp
  }
  function cancelTimer() {
    timerEnd = null;
    flashUntil = null;
    hideCountdown();
    showToast('Timer canceled');
  }

  function toggleNineWeeks() {
    if (activeMode === nineWeeksPair[0]) activeMode = nineWeeksPair[1];
    else if (activeMode === nineWeeksPair[1]) activeMode = nineWeeksPair[0];
    else activeMode = nineWeeksPair[0];
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
    // ignore when focused in an input (we have none, but just in case)
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    switch (e.key) {
      case 'Escape': document.exitFullscreen?.(); break;
      case 'r': case 'R': if (schedules['Regular']) { activeMode = 'Regular'; renderModeTag(); showToast('Mode: Regular'); } break;
      case 'p': case 'P': if (schedules['Pep Rally']) { activeMode = 'Pep Rally'; renderModeTag(); showToast('Mode: Pep Rally'); } break;
      case 'e': case 'E': if (schedules['Early Release']) { activeMode = 'Early Release'; renderModeTag(); showToast('Mode: Early Release'); } break;
      case 't': case 'T': toggleNineWeeks(); break;
      case 's': case 'S': cycleMode(); break;

      case '1': startTimer(30); break;
      case '5': startTimer(300); break;
      case '0': startTimer(600); break;
      case 'Backspace': cancelTimer(); break;

      case 'm': case 'M': muted = !muted; showToast(muted ? 'Muted' : 'Unmuted'); break;
      case '+': case '=': volume = Math.min(1, volume + 0.1); if (gainNode) gainNode.gain.value = volume; showToast(`Volume: ${Math.round(volume*100)}%`); break;
      case '-': volume = Math.max(0, volume - 0.1); if (gainNode) gainNode.gain.value = volume; showToast(`Volume: ${Math.round(volume*100)}%`); break;

      // Simulation
      case ']': simOffsetMs += 5*60*1000; showToast(`Sim +5m → ${now().toFormat('h:mm:ss a')}`); break;
      case '[': simOffsetMs -= 5*60*1000; showToast(`Sim -5m → ${now().toFormat('h:mm:ss a')}`); break;
      case '\\': simOffsetMs = 0; showToast('Sim reset'); break;
      case 'n': case 'N': {
        const n = now();
        const stat = scheduleStatus(n, buildBlocksFor(activeMode));
        if (stat.nextBell) {
          const target = stat.nextBell.minus({ seconds: 5 });
          const realNow = DateTime.now().setZone(SCHOOL_TZ);
          simOffsetMs = target.diff(realNow, 'milliseconds').milliseconds;
          showToast(`Jump → ${target.toFormat('h:mm:ss a')}`);
        } else showToast('No next bell in this mode');
      } break;

      case 'f': case 'F':
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
        break;
    }
  }

  // ====== INIT ======
  reloadBtn.addEventListener('click', async () => {
    try { await fetchSchedules(); } catch (e) { showToast(e.message, 3500); }
  });
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  });
  window.addEventListener('keydown', keyHandler);

  // Browser audio policy: require a user gesture once
  ['click','keydown','pointerdown','touchstart'].forEach(evt => {
    window.addEventListener(evt, () => {
      if (!audioReady) {
        try { ensureAudio(); audioCtx.resume?.(); } catch {}
      }
    }, { once: true });
  });
  audioGateBtn.addEventListener('click', () => { ensureAudio(); audioCtx.resume?.(); });

  // Start
  (async () => {
    try { await fetchSchedules(); } catch (e) { showToast(e.message, 4000); }
    renderModeTag();
    requestAnimationFrame(loop);
  })();
})();
