/* global luxon */
(() => {
  // =========================================================
  // TIMEZONE / LUXON
  // =========================================================

  let DateTime;
  let luxonOK = false;

  if (window.luxon && window.luxon.DateTime) {
    DateTime = window.luxon.DateTime;
    luxonOK = true;
  }

  // =========================================================
  // CONFIG
  // =========================================================

  const SCHEDULES_URL =
    'https://gist.githubusercontent.com/andrewharris-netizen/f731d56672883762b9ba4c3b9b588b38/raw/gistfile1.txt';

  const SCHOOL_TZ = 'America/Chicago';
  const SCHOOL_HOURS = { start: '07:00', end: '17:00' };

  const TEN_TEN_MINUTES = 10;
  const HIDE_NEXT_BELL_LAST_SECONDS = 60;

  const TIMER_FLASH_MS = 5000;
  const TIMER_FLASH_SWAP_MS = 250;
  const CUSTOM_TIMER_MIN = 1;
  const CUSTOM_TIMER_MAX = 120;

  const WEATHER = {
    enabled: true,
    lat: 32.7767,
    lon: -96.7970,
    refreshMinutes: 10
  };

  // =========================================================
  // STATE
  // =========================================================

  let schedules = {};
  let modesOrder = [];
  let activeMode = 'Regular';

  const nineWeeksA = 'Nine Weeks A (1/3/5/7)';
  const nineWeeksB = 'Nine Weeks B (2/4/5/6)';

  const lunchOrder = ['A', 'B', 'C', 'D'];
  let selectedLunch = loadSavedLunch();

  let simOffsetMs = 0;

  let timerPanelOpen = false;
  let timerEnd = null;
  let timerBellCutoff = null;
  let timerFlashUntil = null;
  let timerFlashToggle = false;
  let lastTimerFlashSwapMs = 0;
  let customTimerMinutes = 7;

  let volume = 0.6;
  let muted = false;
  let audioCtx = null;
  let gainNode = null;
  let audioReady = false;

  let lastWeatherText = 'Weather: --';
  let lastWeatherCode = null;
  let lastWeatherFetchMs = 0;

  // =========================================================
  // DOM
  // =========================================================

  const el = (id) => document.getElementById(id);

  const appEl = el('app');

  const timeEl = el('time');
  const dateEl = el('date');
  const modeTagEl = el('modeTag');
  const lunchTagEl = el('lunchTag');
  const simTagEl = el('simTag');
  const timerTagEl = el('timerTag');

  const currEl = el('currentPeriod');
  const tenTenBadgeEl = el('tenTenBadge');
  const lunchStatusEl = el('lunchStatus');
  const nextEl = el('nextBell');

  const scheduleTableEl = el('scheduleTable');

  const timerPanelEl = el('timerPanel');
  const closeTimerBtn = el('closeTimerBtn');
  const timerChooserEl = el('timerChooser');
  const timerRunningStateEl = el('timerRunningState');
  const timerRunningLabelEl = el('timerRunningLabel');
  const timerDisplayEl = el('timerDisplay');

  const customTimerBtn = el('customTimerBtn');
  const customTimerEditorEl = el('customTimerEditor');
  const customMinusBtn = el('customMinusBtn');
  const customPlusBtn = el('customPlusBtn');
  const customTimeDisplayEl = el('customTimeDisplay');
  const startCustomTimerBtn = el('startCustomTimerBtn');

  const addMinuteBtn = el('addMinuteBtn');
  const cancelTimerBtn = el('cancelTimerBtn');

  const reloadBtn = el('reloadBtn');
  const fullscreenBtn = el('fullscreenBtn');

  const weatherEl = el('weather');
  const weatherIconEl = el('weatherIcon');
  const weatherTextEl = el('weatherText');

  const toastContainer = el('toastContainer');
  const dimOverlay = el('dimOverlay');
  const audioGateBtn = el('audioGate');

  // =========================================================
  // LOCAL STORAGE
  // =========================================================

  function loadSavedLunch() {
    try {
      const saved = localStorage.getItem('selectedLunch');
      return lunchOrder.includes(saved) ? saved : 'A';
    } catch {
      return 'A';
    }
  }

  function saveLunch() {
    try {
      localStorage.setItem('selectedLunch', selectedLunch);
    } catch {
      // Persistence is optional.
    }
  }

  // =========================================================
  // TOASTS
  // =========================================================

  function showToast(message, ms = 2000) {
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => toast.remove(), ms);
  }

  // =========================================================
  // AUDIO
  // =========================================================

  function ensureAudio() {
    if (audioReady) return;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    audioCtx = new AudioContextCtor();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(audioCtx.destination);
    audioReady = true;

    audioGateBtn?.classList.add('hidden');
  }

  function beep(freq = 880, ms = 180) {
    if (!audioReady || muted || !audioCtx || !gainNode) return;

    const osc = audioCtx.createOscillator();
    const toneGain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;
    toneGain.gain.value = 1;

    osc.connect(toneGain).connect(gainNode);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  }

  // =========================================================
  // TIME HELPERS
  // =========================================================

  function parseHHMM(value) {
    const [h, m] = value.split(':').map(Number);
    return { h, m };
  }

  function nowReal() {
    if (luxonOK) return DateTime.now().setZone(SCHOOL_TZ);
    return new Date();
  }

  function now() {
    if (luxonOK) return nowReal().plus({ milliseconds: simOffsetMs });
    return new Date(nowReal().getTime() + simOffsetMs);
  }

  function addSeconds(t, seconds) {
    if (luxonOK) return t.plus({ seconds });
    return new Date(t.getTime() + seconds * 1000);
  }

  function addMinutes(t, minutes) {
    if (luxonOK) return t.plus({ minutes });
    return new Date(t.getTime() + minutes * 60000);
  }

  function subtractMinutes(t, minutes) {
    if (luxonOK) return t.minus({ minutes });
    return new Date(t.getTime() - minutes * 60000);
  }

  function addMillis(t, milliseconds) {
    if (luxonOK) return t.plus({ milliseconds });
    return new Date(t.getTime() + milliseconds);
  }

  function secondsBetween(a, b) {
    if (!a || !b) return 0;
    if (luxonOK) return b.diff(a, 'seconds').seconds;
    return (b.getTime() - a.getTime()) / 1000;
  }

  function fmtClock(t) {
    if (luxonOK) return t.toFormat('h:mm:ss a');
    return t.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function fmtDate(t) {
    if (luxonOK) return t.toFormat('EEE, LLL dd, yyyy');
    return t.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      year: 'numeric'
    });
  }

  function fmtHM(t) {
    if (luxonOK) return t.toFormat('h:mm a');
    return t.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function mmss(seconds) {
    const whole = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(whole / 60);
    const secs = whole % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function todayRange() {
    const n = now();
    const start = parseHHMM(SCHOOL_HOURS.start);
    const end = parseHHMM(SCHOOL_HOURS.end);

    if (luxonOK) {
      return {
        start: n.set({ hour: start.h, minute: start.m, second: 0, millisecond: 0 }),
        end: n.set({ hour: end.h, minute: end.m, second: 0, millisecond: 0 })
      };
    }

    return {
      start: new Date(n.getFullYear(), n.getMonth(), n.getDate(), start.h, start.m, 0, 0),
      end: new Date(n.getFullYear(), n.getMonth(), n.getDate(), end.h, end.m, 0, 0)
    };
  }

  // =========================================================
  // SCHEDULES
  // =========================================================

  function getModeData(modeName) {
    return schedules[modeName] || null;
  }

  function getPeriodList(modeName) {
    const mode = getModeData(modeName);
    if (!mode) return [];

    // Backward compatibility with the original array-only Gist format.
    if (Array.isArray(mode)) return mode;
    return mode.periods || [];
  }

  function buildBlocksFor(modeName) {
    const list = getPeriodList(modeName);
    const n = now();

    if (luxonOK) {
      return list.map(({ label, start, end }) => {
        const s = parseHHMM(start);
        const e = parseHHMM(end);

        const sdt = n.set({ hour: s.h, minute: s.m, second: 0, millisecond: 0 });
        let edt = n.set({ hour: e.h, minute: e.m, second: 0, millisecond: 0 });

        if (edt <= sdt) edt = sdt.plus({ minutes: 1 });
        return { label, sdt, edt };
      }).sort((a, b) => a.sdt - b.sdt);
    }

    const year = n.getFullYear();
    const month = n.getMonth();
    const day = n.getDate();

    return list.map(({ label, start, end }) => {
      const s = parseHHMM(start);
      const e = parseHHMM(end);

      const sdt = new Date(year, month, day, s.h, s.m, 0, 0);
      let edt = new Date(year, month, day, e.h, e.m, 0, 0);

      if (edt <= sdt) edt = new Date(sdt.getTime() + 60000);
      return { label, sdt, edt };
    }).sort((a, b) => a.sdt - b.sdt);
  }

  function scheduleStatus(n, blocks) {
    if (!blocks.length) return { state: 'noschedule' };

    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];

      if (n >= block.sdt && n < block.edt) {
        const next = blocks[i + 1] || null;
        return {
          state: 'in_period',
          current: block.label,
          currentStart: block.sdt,
          currentEnd: block.edt,
          nextBell: block.edt,
          nextPeriodLabel: next ? next.label : null
        };
      }

      if (n < block.sdt) {
        const previous = blocks[i - 1] || null;

        if (!previous || previous.edt <= n) {
          return {
            state: 'passing',
            current: 'Passing Period',
            nextBell: block.sdt,
            nextPeriodLabel: block.label
          };
        }
      }
    }

    return { state: 'noschedule' };
  }

  function isClassPeriodLabel(label) {
    return /^(1st|2nd|3rd|4th|5th|6th|7th)\s+Period$/i.test(label || '');
  }

  // =========================================================
  // 10/10 RULE
  // =========================================================

  function isTenTenActive(stat, n) {
    if (
      !stat ||
      stat.state !== 'in_period' ||
      !isClassPeriodLabel(stat.current) ||
      !stat.currentStart ||
      !stat.currentEnd
    ) {
      return false;
    }

    const firstTenEnds = addMinutes(stat.currentStart, TEN_TEN_MINUTES);
    const lastTenStarts = subtractMinutes(stat.currentEnd, TEN_TEN_MINUTES);

    return (
      (n >= stat.currentStart && n < firstTenEnds) ||
      (n >= lastTenStarts && n < stat.currentEnd)
    );
  }

  // =========================================================
  // LUNCH
  // =========================================================

  function getLunchesForMode(modeName) {
    const mode = getModeData(modeName);
    if (!mode || Array.isArray(mode) || !mode.lunches) return {};
    return mode.lunches;
  }

  function modeHasLunchChoices(modeName) {
    return Object.keys(getLunchesForMode(modeName)).length > 0;
  }

  function getSelectedLunchData(modeName) {
    return getLunchesForMode(modeName)[selectedLunch] || null;
  }

  function buildLunchBlock(modeName) {
    const lunch = getSelectedLunchData(modeName);
    if (!lunch) return null;

    const n = now();
    const s = parseHHMM(lunch.start);
    const e = parseHHMM(lunch.end);

    if (luxonOK) {
      return {
        label: `${selectedLunch} Lunch`,
        sdt: n.set({ hour: s.h, minute: s.m, second: 0, millisecond: 0 }),
        edt: n.set({ hour: e.h, minute: e.m, second: 0, millisecond: 0 })
      };
    }

    return {
      label: `${selectedLunch} Lunch`,
      sdt: new Date(n.getFullYear(), n.getMonth(), n.getDate(), s.h, s.m, 0, 0),
      edt: new Date(n.getFullYear(), n.getMonth(), n.getDate(), e.h, e.m, 0, 0)
    };
  }

  function getLunchStatus(n) {
    const lunch = buildLunchBlock(activeMode);
    if (!lunch) return { state: 'none' };

    if (n < lunch.sdt) return { state: 'upcoming', ...lunch };
    if (n >= lunch.sdt && n < lunch.edt) return { state: 'active', ...lunch };
    return { state: 'finished', ...lunch };
  }

  function cycleLunch() {
    const currentIndex = lunchOrder.indexOf(selectedLunch);
    selectedLunch = lunchOrder[(currentIndex + 1) % lunchOrder.length];
    saveLunch();
    renderLunchTag();
    showToast(`Lunch: ${selectedLunch}`);
  }

  // =========================================================
  // TIMER PANEL
  // =========================================================

  function openTimerPanel() {
    timerPanelOpen = true;
    appEl?.classList.add('timer-open');
    timerPanelEl?.classList.remove('hidden');
    renderTimerPanel(now());
  }

  function closeTimerPanel() {
    timerPanelOpen = false;
    appEl?.classList.remove('timer-open');
    timerPanelEl?.classList.add('hidden');
    renderTimerTag(now());
  }

  function toggleTimerPanel() {
    if (timerPanelOpen) closeTimerPanel();
    else openTimerPanel();
  }

  function setCustomTimerMinutes(value) {
    customTimerMinutes = Math.max(CUSTOM_TIMER_MIN, Math.min(CUSTOM_TIMER_MAX, value));
    renderCustomTimerDisplay();
  }

  function renderCustomTimerDisplay() {
    if (!customTimeDisplayEl) return;
    customTimeDisplayEl.textContent = `${customTimerMinutes}:00`;
  }

  function startTimer(seconds) {
    const n = now();
    const blocks = buildBlocksFor(activeMode);
    const stat = scheduleStatus(n, blocks);

    timerEnd = addSeconds(n, seconds);
    timerFlashUntil = null;
    timerFlashToggle = false;
    timerBellCutoff = stat.nextBell || null;

    openTimerPanel();
    ensureAudio();
    audioCtx?.resume?.();
    beep(660, 110);

    showToast(`Timer started: ${mmss(seconds)}`);
  }

  function addOneMinuteToTimer() {
    const n = now();

    if (timerFlashUntil && n < timerFlashUntil) {
      timerFlashUntil = null;
      timerEnd = addSeconds(n, 60);
    } else if (timerEnd) {
      timerEnd = addSeconds(timerEnd, 60);
    } else {
      timerEnd = addSeconds(n, 60);
    }

    const stat = scheduleStatus(n, buildBlocksFor(activeMode));
    timerBellCutoff = stat.nextBell || null;

    openTimerPanel();
    showToast('+1 minute');
  }

  function cancelTimer(showMessage = true) {
    timerEnd = null;
    timerBellCutoff = null;
    timerFlashUntil = null;
    timerFlashToggle = false;
    timerPanelEl?.classList.remove('timerFlashA', 'timerFlashB');

    if (showMessage) showToast('Timer canceled');
    renderTimerPanel(now());
    renderTimerTag(now());
  }

  function finishTimer(n) {
    timerEnd = null;
    timerBellCutoff = null;
    timerFlashUntil = addMillis(n, TIMER_FLASH_MS);
    timerFlashToggle = false;
    lastTimerFlashSwapMs = 0;

    openTimerPanel();
    ensureAudio();
    audioCtx?.resume?.();
    beep(880, 300);
  }

  function renderTimerTag(n) {
    if (!timerTagEl) return;

    const isFlashing = timerFlashUntil && n < timerFlashUntil;

    if (timerPanelOpen || (!timerEnd && !isFlashing)) {
      timerTagEl.classList.add('hidden');
      return;
    }

    timerTagEl.classList.remove('hidden');

    if (isFlashing) {
      timerTagEl.textContent = 'Timer 0:00';
      return;
    }

    timerTagEl.textContent = `Timer ${mmss(secondsBetween(n, timerEnd))}`;
  }

  function renderTimerPanel(n) {
    if (!timerPanelEl) return;

    const isFlashing = timerFlashUntil && n < timerFlashUntil;
    const isRunning = Boolean(timerEnd) || Boolean(isFlashing);

    timerChooserEl?.classList.toggle('hidden', isRunning);
    timerRunningStateEl?.classList.toggle('hidden', !isRunning);

    if (!isRunning) {
      timerPanelEl.classList.remove('timerFlashA', 'timerFlashB');
      if (timerRunningLabelEl) timerRunningLabelEl.textContent = 'TIMER RUNNING';
      return;
    }

    if (isFlashing) {
      if (timerDisplayEl) timerDisplayEl.textContent = '0:00';
      if (timerRunningLabelEl) timerRunningLabelEl.textContent = 'TIME';

      const currentMs = Date.now();
      if (currentMs - lastTimerFlashSwapMs >= TIMER_FLASH_SWAP_MS) {
        timerFlashToggle = !timerFlashToggle;
        lastTimerFlashSwapMs = currentMs;
      }

      timerPanelEl.classList.toggle('timerFlashA', timerFlashToggle);
      timerPanelEl.classList.toggle('timerFlashB', !timerFlashToggle);
      return;
    }

    timerPanelEl.classList.remove('timerFlashA', 'timerFlashB');

    if (timerRunningLabelEl) timerRunningLabelEl.textContent = 'TIMER RUNNING';
    if (timerDisplayEl) timerDisplayEl.textContent = mmss(secondsBetween(n, timerEnd));
  }

  // =========================================================
  // MODE CONTROLS
  // =========================================================

  function setActiveMode(modeName) {
    if (!schedules[modeName]) {
      showToast(`Schedule not found: ${modeName}`);
      return;
    }

    activeMode = modeName;
    renderModeTag();
    renderLunchTag();
    updateTabTitleMinutes();
    showToast(`Mode: ${modeName}`);
  }

  // =========================================================
  // SIMULATION
  // =========================================================

  function returnToNow() {
    simOffsetMs = 0;
    renderSimTag();
    updateTabTitleMinutes();
    showToast(`Now: ${fmtClock(now())}`);
  }

  function jumpToNextBell() {
    const n = now();
    const stat = scheduleStatus(n, buildBlocksFor(activeMode));

    if (!stat.nextBell) {
      showToast('No next bell in this mode');
      return;
    }

    const target = luxonOK
      ? stat.nextBell.minus({ seconds: 5 })
      : new Date(stat.nextBell.getTime() - 5000);

    const actualNow = nowReal();

    simOffsetMs = luxonOK
      ? target.diff(actualNow, 'milliseconds').milliseconds
      : target.getTime() - actualNow.getTime();

    renderSimTag();
    updateTabTitleMinutes();
    showToast(`Next bell test: ${fmtClock(target)}`);
  }

  // =========================================================
  // RENDER CLOCK / STATUS
  // =========================================================

  function renderClock(n) {
    if (timeEl) timeEl.textContent = fmtClock(n);
    if (dateEl) dateEl.textContent = fmtDate(n);
  }

  function renderModeTag() {
    if (modeTagEl) modeTagEl.textContent = `Mode: ${activeMode}`;
  }

  function renderLunchTag() {
    if (!lunchTagEl) return;

    if (!modeHasLunchChoices(activeMode)) {
      lunchTagEl.classList.add('hidden');
      return;
    }

    lunchTagEl.classList.remove('hidden');
    lunchTagEl.textContent = `Lunch: ${selectedLunch}`;
  }

  function renderSimTag() {
    if (!simTagEl) return;
    simTagEl.classList.toggle('hidden', simOffsetMs === 0);
    simTagEl.textContent = simOffsetMs === 0 ? '' : 'SIM TIME';
  }

  function renderTenTenBadge(active) {
    tenTenBadgeEl?.classList.toggle('hidden', !active);
  }

  function renderLunchStatus(n, stat) {
    if (!lunchStatusEl) return;

    const lunch = getLunchStatus(n);

    if (lunch.state === 'none' || lunch.state === 'finished') {
      lunchStatusEl.textContent = '';
      lunchStatusEl.classList.add('hidden');
      return;
    }

    if (lunch.state === 'active') {
      lunchStatusEl.textContent = `${lunch.label} • ends in ${mmss(secondsBetween(n, lunch.edt))}`;
      lunchStatusEl.classList.remove('hidden');
      return;
    }

    if (
      lunch.state === 'upcoming' &&
      stat &&
      stat.state === 'in_period' &&
      stat.current === '5th Period'
    ) {
      lunchStatusEl.textContent = `${lunch.label} in ${mmss(secondsBetween(n, lunch.sdt))}`;
      lunchStatusEl.classList.remove('hidden');
      return;
    }

    lunchStatusEl.textContent = '';
    lunchStatusEl.classList.add('hidden');
  }

  function renderCenter(stat, n) {
    if (!stat || stat.state === 'noschedule') {
      if (currEl) currEl.textContent = 'No school schedule active';
      if (nextEl) nextEl.textContent = '';
      renderTenTenBadge(false);
      renderLunchStatus(n, stat);
      return;
    }

    if (currEl) currEl.textContent = stat.current || '';

    renderTenTenBadge(isTenTenActive(stat, n));
    renderLunchStatus(n, stat);

    if (!nextEl || !stat.nextBell) {
      if (nextEl) nextEl.textContent = '';
      return;
    }

    const seconds = secondsBetween(n, stat.nextBell);

    if (stat.state === 'in_period' && seconds <= HIDE_NEXT_BELL_LAST_SECONDS) {
      nextEl.textContent = '';
      return;
    }

    nextEl.textContent = `Next bell: ${fmtHM(stat.nextBell)} • ${mmss(seconds)}`;
  }

  function renderScheduleTable(blocks, n) {
    if (!scheduleTableEl) return;

    const periods = blocks.filter((block) => isClassPeriodLabel(block.label));
    scheduleTableEl.innerHTML = '';
    scheduleTableEl.style.setProperty('--schedule-count', String(Math.max(1, periods.length)));

    periods.forEach((block) => {
      const row = document.createElement('div');
      row.className = 'row';

      if (n >= block.sdt && n < block.edt) row.classList.add('active');

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = block.label.replace(' Period', '');

      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = `${fmtHM(block.sdt)}–${fmtHM(block.edt)}`;

      row.appendChild(label);
      row.appendChild(time);
      scheduleTableEl.appendChild(row);
    });
  }

  function setDim(n) {
    if (!dimOverlay) return;
    const { start, end } = todayRange();
    const inSchoolHours = n >= start && n <= end;
    dimOverlay.classList.toggle('hidden', inSchoolHours);
  }

  // =========================================================
  // TAB TITLE
  // =========================================================

  function updateTabTitleMinutes() {
    const n = now();
    const stat = scheduleStatus(n, buildBlocksFor(activeMode));

    if (!stat || !stat.nextBell) {
      document.title = 'School Bell Clock';
      return;
    }

    const minutes = Math.max(0, Math.ceil(secondsBetween(n, stat.nextBell) / 60));

    if (stat.state === 'in_period') {
      document.title = `⏰ ${minutes} min left — ${stat.current}`;
    } else if (stat.state === 'passing') {
      document.title = `⏳ ${minutes} min to ${stat.nextPeriodLabel}`;
    } else {
      document.title = 'School Bell Clock';
    }
  }

  function startTabTitleMinuteTicker() {
    updateTabTitleMinutes();

    const msToNextMinute = 60000 - (Date.now() % 60000);

    setTimeout(() => {
      updateTabTitleMinutes();
      setInterval(updateTabTitleMinutes, 60000);
    }, msToNextMinute);
  }

  // =========================================================
  // WEATHER
  // =========================================================

  function wmoToText(code) {
    const descriptions = {
      0: 'Clear',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Cloudy',
      45: 'Fog',
      48: 'Fog',
      51: 'Drizzle',
      53: 'Drizzle',
      55: 'Drizzle',
      56: 'Freezing drizzle',
      57: 'Freezing drizzle',
      61: 'Rain',
      63: 'Rain',
      65: 'Heavy rain',
      66: 'Freezing rain',
      67: 'Freezing rain',
      71: 'Snow',
      73: 'Snow',
      75: 'Heavy snow',
      77: 'Snow grains',
      80: 'Showers',
      81: 'Showers',
      82: 'Heavy showers',
      85: 'Snow showers',
      86: 'Heavy snow showers',
      95: 'Thunder',
      96: 'Thunder + hail',
      99: 'Thunder + hail'
    };

    return descriptions[code] || 'Weather';
  }

  function codeToIconKind(code) {
    if (code === 0) return 'clear';
    if (code === 1 || code === 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }

  function svgIcon(kind) {
    switch (kind) {
      case 'clear':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2"></path><path d="M12 20v2"></path>
            <path d="M2 12h2"></path><path d="M20 12h2"></path>
            <path d="M4.9 4.9l1.4 1.4"></path><path d="M17.7 17.7l1.4 1.4"></path>
            <path d="M19.1 4.9l-1.4 1.4"></path><path d="M6.3 17.7l-1.4 1.4"></path>
          </svg>`;

      case 'partly':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="8" cy="10" r="3"></circle>
            <path d="M8 3v1.5"></path><path d="M3 10h1.5"></path>
            <path d="M12.5 10H14"></path><path d="M5.3 5.3l1.1 1.1"></path>
            <path d="M6 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 1.7A3.3 3.3 0 0 0 6 18z"></path>
          </svg>`;

      case 'rain':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 16h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>
            <path d="M8 18l-1 2"></path><path d="M12 18l-1 2"></path><path d="M16 18l-1 2"></path>
          </svg>`;

      case 'snow':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 16h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>
            <circle cx="9" cy="19" r="0.8"></circle><circle cx="12" cy="19" r="0.8"></circle><circle cx="15" cy="19" r="0.8"></circle>
          </svg>`;

      case 'thunder':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 16h10a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>
            <path d="M12 16l-2 4h2l-1 3 4-6h-2l1-1z"></path>
          </svg>`;

      case 'fog':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 13h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 13z"></path>
            <path d="M4 17h16"></path><path d="M6 20h12"></path>
          </svg>`;

      default:
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 18h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 18z"></path>
          </svg>`;
    }
  }

  async function fetchWeather(force = false) {
    if (!WEATHER.enabled || !weatherEl || !weatherTextEl || !weatherIconEl) return;

    const nowMs = Date.now();
    const refreshMs = WEATHER.refreshMinutes * 60 * 1000;

    if (!force && nowMs - lastWeatherFetchMs < refreshMs) return;
    lastWeatherFetchMs = nowMs;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(WEATHER.lat)}` +
      `&longitude=${encodeURIComponent(WEATHER.lon)}` +
      `&current=temperature_2m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum` +
      `&temperature_unit=fahrenheit` +
      `&timezone=${encodeURIComponent(SCHOOL_TZ)}`;

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Weather ${response.status}`);

      const data = await response.json();
      const temp = data?.current?.temperature_2m;
      const code = data?.current?.weather_code;
      const high = data?.daily?.temperature_2m_max?.[0];
      const low = data?.daily?.temperature_2m_min?.[0];
      const pop = data?.daily?.precipitation_probability_max?.[0];
      const snowCm = data?.daily?.snowfall_sum?.[0];
      const snowInches = typeof snowCm === 'number' ? snowCm / 2.54 : null;

      const parts = [];
      const condition = wmoToText(code);

      if (typeof temp === 'number') parts.push(`${Math.round(temp)}°F ${condition}`);
      else parts.push(condition);

      if (typeof high === 'number' && typeof low === 'number') {
        parts.push(`H ${Math.round(high)}° / L ${Math.round(low)}°`);
      }

      if (typeof pop === 'number') parts.push(`PoP ${Math.round(pop)}%`);
      if (typeof snowInches === 'number' && snowInches > 0.05) {
        parts.push(`Snow ${snowInches.toFixed(1)}"`);
      }

      lastWeatherText = parts.join(' • ');
      lastWeatherCode = code;

      weatherTextEl.textContent = lastWeatherText;
      weatherIconEl.innerHTML = svgIcon(codeToIconKind(code));
    } catch (error) {
      console.warn('Weather unavailable:', error);
      weatherTextEl.textContent = lastWeatherText;

      if (lastWeatherCode !== null) {
        weatherIconEl.innerHTML = svgIcon(codeToIconKind(lastWeatherCode));
      }
    }
  }

  // =========================================================
  // FETCH SCHEDULES
  // =========================================================

  async function fetchSchedules() {
    const separator = SCHEDULES_URL.includes('?') ? '&' : '?';
    const url = `${SCHEDULES_URL}${separator}cachebust=${Date.now()}`;

    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Fetch schedules failed: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const data = JSON.parse(text);

    schedules = data.modes ? data.modes : data;
    modesOrder = Object.keys(schedules);

    if (!modesOrder.length) throw new Error('No schedule modes found');
    if (!schedules[activeMode]) activeMode = modesOrder[0];

    renderModeTag();
    renderLunchTag();
    updateTabTitleMinutes();
    showToast('Schedules loaded');
  }

  // =========================================================
  // KEYBOARD
  // =========================================================

  function keyHandler(event) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    switch (event.key) {
      case 'r':
      case 'R':
        setActiveMode('Regular');
        break;

      case 'p':
      case 'P':
        setActiveMode('Pep Rally');
        break;

      case 'e':
      case 'E':
        setActiveMode('Early Release');
        break;

      case 'a':
      case 'A':
        setActiveMode(nineWeeksA);
        break;

      case 'b':
      case 'B':
        setActiveMode(nineWeeksB);
        break;

      case 'l':
      case 'L':
        cycleLunch();
        break;

      case 't':
      case 'T':
        toggleTimerPanel();
        break;

      case 'n':
      case 'N':
        returnToNow();
        break;

      case 'j':
      case 'J':
        jumpToNextBell();
        break;

      case 'm':
      case 'M':
        muted = !muted;
        showToast(muted ? 'Muted' : 'Unmuted');
        break;

      case 'f':
      case 'F':
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
        break;

      case 'Escape':
        if (timerPanelOpen) {
          event.preventDefault();
          closeTimerPanel();
        }
        break;
    }
  }

  // =========================================================
  // MAIN LOOP
  // =========================================================

  function loop() {
    const n = now();
    const blocks = buildBlocksFor(activeMode);
    const stat = scheduleStatus(n, blocks);

    renderClock(n);
    renderCenter(stat, n);
    renderScheduleTable(blocks, n);
    renderSimTag();
    setDim(n);

    if (timerEnd && timerBellCutoff && n >= timerBellCutoff) {
      cancelTimer(false);
      closeTimerPanel();
      showToast('Timer canceled at bell');
    }

    if (timerEnd && secondsBetween(n, timerEnd) <= 0) {
      finishTimer(n);
    }

    if (timerFlashUntil && n >= timerFlashUntil) {
      timerFlashUntil = null;
      timerPanelEl?.classList.remove('timerFlashA', 'timerFlashB');
    }

    if (timerPanelOpen) renderTimerPanel(n);
    renderTimerTag(n);

    requestAnimationFrame(loop);
  }

  // =========================================================
  // EVENTS
  // =========================================================

  document.querySelectorAll('.timerPreset').forEach((button) => {
    button.addEventListener('click', () => {
      const seconds = Number(button.dataset.seconds);
      if (Number.isFinite(seconds) && seconds > 0) startTimer(seconds);
    });
  });

  closeTimerBtn?.addEventListener('click', closeTimerPanel);
  timerTagEl?.addEventListener('click', openTimerPanel);

  customTimerBtn?.addEventListener('click', () => {
    customTimerEditorEl?.classList.toggle('hidden');
  });

  customMinusBtn?.addEventListener('click', () => {
    setCustomTimerMinutes(customTimerMinutes - 1);
  });

  customPlusBtn?.addEventListener('click', () => {
    setCustomTimerMinutes(customTimerMinutes + 1);
  });

  startCustomTimerBtn?.addEventListener('click', () => {
    startTimer(customTimerMinutes * 60);
  });

  addMinuteBtn?.addEventListener('click', addOneMinuteToTimer);
  cancelTimerBtn?.addEventListener('click', () => cancelTimer(true));

  reloadBtn?.addEventListener('click', async () => {
    try {
      await fetchSchedules();
    } catch (error) {
      console.error(error);
      showToast(error.message, 5000);
    }
  });

  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  window.addEventListener('keydown', keyHandler);

  ['click', 'keydown', 'pointerdown', 'touchstart'].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      if (!audioReady) {
        try {
          ensureAudio();
          audioCtx?.resume?.();
        } catch {
          // Ignore browser audio unlock failures.
        }
      }
    }, { once: true });
  });

  audioGateBtn?.addEventListener('click', () => {
    ensureAudio();
    audioCtx?.resume?.();
  });

  // =========================================================
  // STARTUP
  // =========================================================

  renderCustomTimerDisplay();
  renderSimTag();
  renderModeTag();
  renderLunchTag();

  (async () => {
    try {
      await fetchSchedules();
    } catch (error) {
      console.error(error);
      showToast(error.message, 5000);
    }

    startTabTitleMinuteTicker();

    if (WEATHER.enabled) {
      weatherTextEl.textContent = 'Weather: loading…';
      fetchWeather(true);
      setInterval(() => fetchWeather(false), WEATHER.refreshMinutes * 60 * 1000);
    }

    requestAnimationFrame(loop);
  })();
})();
