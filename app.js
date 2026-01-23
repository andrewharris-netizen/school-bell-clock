/* global luxon */
(() => {
  // ===== Luxon or fallback =====
  let DateTime, luxonOK = false;
  if (window.luxon && window.luxon.DateTime) {
    DateTime = window.luxon.DateTime;
    luxonOK = true;
  }

  // ===== CONFIG =====
  const SCHEDULES_URL =
    'https://gist.githubusercontent.com/andrewharris-netizen/f731d56672883762b9ba4c3b9b588b38/raw/43130bfa0fb630016e50ee23d7b8a3106124d83f/gistfile1.txt';

  const SCHOOL_TZ = 'America/Chicago';
  const SCHOOL_HOURS = { start: '07:00', end: '17:00' };
  const FLASH_MS = 5000;
  const FLASH_SWAP_MS = 250;

  // Hide "Next bell" line when <= this many seconds remain in a period
  const HIDE_NEXT_BELL_LAST_SECONDS = 60;

  // Weather (minimal footer)
  const WEATHER = {
    enabled: true,
    // Dallas-ish default; change if you want campus-specific:
    lat: 32.7767,
    lon: -96.7970,
    refreshMinutes: 10
  };

  const UI = {
    fg: '#ffffff',
    flashA: '#ffffff',
    flashB: '#e00000'
  };

  // ===== STATE =====
  let schedules = {};
  let modesOrder = [];
  let activeMode = 'Regular';
  const nineWeeksPair = ['Nine Weeks A (1/3/5/7)', 'Nine Weeks B (2/4/5/6)'];

  let timerEnd = null;
  let flashUntil = null;
  let flashToggle = false;

  let volume = 0.6;
  let muted = false;

  let simOffsetMs = 0;

  // WebAudio
  let audioCtx = null;
  let gainNode = null;
  let audioReady = false;

  // Weather cache
  let lastWeatherText = 'Weather: --';
  let lastWeatherCode = null;
  let lastWeatherFetchMs = 0;

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

  const weatherEl = el('weather');
  const weatherIconEl = el('weatherIcon');
  const weatherTextEl = el('weatherText');

  // ===== Toast =====
  function showToast(msg, ms = 2000) {
    if (!toastContainer) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function hideAudioGate() {
    audioGateBtn?.classList.add('hidden');
  }

  // ===== Audio =====
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

  // ===== Time helpers =====
  function parseHHMM(str) {
    const [h, m] = str.split(':').map(Number);
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
    return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function fmtDate(t) {
    if (luxonOK) return t.toFormat('EEE, LLL dd, yyyy');
    return t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
  }

  function fmtHM(t) {
    if (luxonOK) return t.toFormat('h:mm a');
    return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function mmss(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function minLeftCeil(seconds) {
    return Math.max(0, Math.ceil(seconds / 60));
  }

  function todayRange() {
    const n = now();
    const startParts = parseHHMM(SCHOOL_HOURS.start);
    const endParts = parseHHMM(SCHOOL_HOURS.end);

    if (luxonOK) {
      const start = n.set({ hour: startParts.h, minute: startParts.m, second: 0, millisecond: 0 });
      const end = n.set({ hour: endParts.h, minute: endParts.m, second: 0, millisecond: 0 });
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

  // ===== Schedule logic =====
  function buildBlocksFor(modeName) {
    const list = (schedules[modeName] || []);
    const n = now();

    if (luxonOK) {
      return list.map(({ label, start, end }) => {
        const s = parseHHMM(start);
        const e = parseHHMM(end);
        let sdt = n.set({ hour: s.h, minute: s.m, second: 0, millisecond: 0 });
        let edt = n.set({ hour: e.h, minute: e.m, second: 0, millisecond: 0 });
        if (edt <= sdt) edt = sdt.plus({ minutes: 1 });
        return { sdt, edt, label };
      }).sort((a, b) => a.sdt - b.sdt);
    } else {
      const year = n.getFullYear();
      const month = n.getMonth();
      const day = n.getDate();
      return list.map(({ label, start, end }) => {
        const s = parseHHMM(start);
        const e = parseHHMM(end);
        const sdt = new Date(year, month, day, s.h, s.m, 0, 0);
        let edt = new Date(year, month, day, e.h, e.m, 0, 0);
        if (edt <= sdt) edt = new Date(sdt.getTime() + 60 * 1000);
        return { sdt, edt, label };
      }).sort((a, b) => a.sdt - b.sdt);
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
            nextPeriodLabel: label
          };
        }
      }
    }

    return { state: 'noschedule' };
  }

  // ===== Tab title (minutes only, update every minute) =====
  function updateTabTitleMinutes() {
    const n = now();
    const blocks = buildBlocksFor(activeMode);
    const stat = scheduleStatus(n, blocks);

    if (!stat || !stat.nextBell) {
      document.title = 'School Bell Clock';
      return;
    }

    const sec = secondsBetween(n, stat.nextBell);
    const mins = minLeftCeil(sec);

    if (stat.state === 'in_period') {
      document.title = `⏰ ${mins} min left — ${stat.current}`;
    } else if (stat.state === 'passing') {
      document.title = `⏳ ${mins} min to ${stat.nextPeriodLabel}`;
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
    blocks.forEach((b, i) => { if (n >= b.sdt && n < b.edt) activeIndex = i; });

    blocks.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === activeIndex ? ' active' : '');

      // stacked rows (one column)
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = b.label;

      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = `${fmtHM(b.sdt)}–${fmtHM(b.edt)}`;

      row.appendChild(label);
      row.appendChild(time);
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

      if (stat.state === 'in_period' && seconds <= HIDE_NEXT_BELL_LAST_SECONDS) {
        nextEl.textContent = '';
      } else {
        nextEl.textContent = `Next bell: ${bellStr} • ${mmss(seconds)}`;
      }
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

  // ===== Weather: icon + richer text =====
  function wmoToText(code) {
    const m = {
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
    return m[code] ?? 'Weather';
  }

  function codeToIconKind(code) {
    if (code === 0) return 'clear';
    if (code === 1 || code === 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }

  function svgIcon(kind) {
    // Simple monochrome line icons (stroke only)
    // Keep shapes minimal so it looks clean on TVs.
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
  <path d="M8 3v1.5"></path><path d="M3 10h1.5"></path><path d="M12.5 10H14"></path><path d="M5.3 5.3l1.1 1.1"></path>
  <path d="M6 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 1.7A3.3 3.3 0 0 0 6 18z"></path>
</svg>`;
      case 'cloudy':
        return `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6 18h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 18z"></path>
</svg>`;
      case 'rain':
        return `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6 16h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>
  <path d="M8 18l-1 2"></path>
  <path d="M12 18l-1 2"></path>
  <path d="M16 18l-1 2"></path>
</svg>`;
      case 'snow':
        return `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6 16h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>
  <path d="M9 19h0"></path><path d="M9 19l0 0"></path>
  <path d="M12 19h0"></path><path d="M12 19l0 0"></path>
  <path d="M15 19h0"></path><path d="M15 19l0 0"></path>
  <circle cx="9" cy="19" r="0.8"></circle>
  <circle cx="12" cy="19" r="0.8"></circle>
  <circle cx="15" cy="19" r="0.8"></circle>
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
  <path d="M4 17h16"></path>
  <path d="M6 20h12"></path>
</svg>`;
      default:
        return `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6 18h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 18z"></path>
</svg>`;
    }
  }

  async function fetchWeather() {
    if (!WEATHER.enabled || !weatherEl || !weatherTextEl || !weatherIconEl) return;

    const nowMs = Date.now();
    const minInterval = WEATHER.refreshMinutes * 60 * 1000;
    if (nowMs - lastWeatherFetchMs < minInterval) return;
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
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const data = await res.json();

      const temp = data?.current?.temperature_2m;
      const code = data?.current?.weather_code;

      const hi = data?.daily?.temperature_2m_max?.[0];
      const lo = data?.daily?.temperature_2m_min?.[0];
      const pop = data?.daily?.precipitation_probability_max?.[0];
      const snowCm = data?.daily?.snowfall_sum?.[0]; // Open-Meteo typically returns cm
      const snowIn = (typeof snowCm === 'number') ? (snowCm / 2.54) : null;

      const cond = wmoToText(code);
      const kind = codeToIconKind(code);

      const parts = [];
      if (typeof temp === 'number') parts.push(`${Math.round(temp)}°F ${cond}`);
      else parts.push(cond);

      if (typeof hi === 'number' && typeof lo === 'number') {
        parts.push(`H ${Math.round(hi)}° / L ${Math.round(lo)}°`);
      }

      if (typeof pop === 'number') parts.push(`PoP ${Math.round(pop)}%`);

      if (typeof snowIn === 'number' && snowIn > 0.05) {
        // Show to 0.1" precision
        parts.push(`Snow ${snowIn.toFixed(1)}"`);
      }

      lastWeatherText = parts.join(' • ');
      lastWeatherCode = code;

      weatherIconEl.innerHTML = svgIcon(kind);
      weatherTextEl.textContent = lastWeatherText;
    } catch {
      // Quiet failure: keep last known weather text/icon
      if (lastWeatherCode != null) {
        weatherIconEl.innerHTML = svgIcon(codeToIconKind(lastWeatherCode));
      }
      weatherTextEl.textContent = lastWeatherText;
    }
  }

  function renderWeather() {
    if (!WEATHER.enabled || !weatherEl || !weatherTextEl || !weatherIconEl) return;
    weatherTextEl.textContent = lastWeatherText;
    if (lastWeatherCode != null) {
      weatherIconEl.innerHTML = svgIcon(codeToIconKind(lastWeatherCode));
    }
  }

  // ===== MAIN LOOP =====
  function loop() {
    const n = now();
    renderClock(n);
    setDim(n);

    const blocks = buildBlocksFor(activeMode);
    const stat = scheduleStatus(n, blocks);

    // Bell cancels timer
    if (timerEnd && stat.nextBell && n >= stat.nextBell) {
      timerEnd = null;
      flashUntil = null;
      hideCountdown();
      showToast('Timer canceled (bell)');
    }

    // Timer + flash
    if (flashUntil && n < flashUntil) {
      showCountdown('0:00');
      setFlashLayer(n);
    } else if (timerEnd) {
      const sec = secondsBetween(n, timerEnd);
      if (sec <= 0) {
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

    renderCenter(stat, n);
    renderScheduleTable(blocks, n);
    simTagEl.textContent = simOffsetMs ? 'SIM TIME' : '';

    renderWeather();
    fetchWeather();

    requestAnimationFrame(loop);
  }

  // ===== Controls =====
  function startTimer(seconds) {
    const n = now();
    timerEnd = addSeconds(n, seconds);
    flashUntil = null;
    showToast(`Timer: ${mmss(seconds)}`);
    ensureAudio();
    beep(660, 120);
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
    updateTabTitleMinutes();
  }

  function cycleMode() {
    if (!modesOrder.length) return;
    const i = modesOrder.indexOf(activeMode);
    activeMode = modesOrder[(i + 1) % modesOrder.length];
    renderModeTag();
    showToast(`Mode: ${activeMode}`);
    updateTabTitleMinutes();
  }

  function keyHandler(e) {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    switch (e.key) {
      case 'Escape':
        document.exitFullscreen?.();
        break;

      // Modes
      case 'r': case 'R':
        if (schedules['Regular']) { activeMode = 'Regular'; renderModeTag(); showToast('Mode: Regular'); updateTabTitleMinutes(); }
        break;
      case 'p': case 'P':
        if (schedules['Pep Rally']) { activeMode = 'Pep Rally'; renderModeTag(); showToast('Mode: Pep Rally'); updateTabTitleMinutes(); }
        break;
      case 'e': case 'E':
        if (schedules['Early Release']) { activeMode = 'Early Release'; renderModeTag(); showToast('Mode: Early Release'); updateTabTitleMinutes(); }
        break;
      case 't': case 'T':
        toggleNineWeeks();
        break;
      case 's': case 'S':
        cycleMode();
        break;

      // Timers
      case '1': startTimer(30); break;
      case '5': startTimer(300); break;
      case '0': startTimer(600); break;
      case 'Backspace': cancelTimer(); break;

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

      // Simulation
      case ']':
        simOffsetMs += 5 * 60 * 1000;
        showToast(`Sim +5m → ${fmtClock(now())}`);
        updateTabTitleMinutes();
        break;
      case '[':
        simOffsetMs -= 5 * 60 * 1000;
        showToast(`Sim -5m → ${fmtClock(now())}`);
        updateTabTitleMinutes();
        break;
      case '\\':
        simOffsetMs = 0;
        showToast('Sim reset');
        updateTabTitleMinutes();
        break;
      case 'n': case 'N': {
        const n0 = now();
        const stat0 = scheduleStatus(n0, buildBlocksFor(activeMode));
        if (stat0.nextBell) {
          const target = luxonOK
            ? stat0.nextBell.minus({ seconds: 5 })
            : new Date(stat0.nextBell.getTime() - 5000);

          const realNow = nowReal();
          simOffsetMs = luxonOK
            ? target.diff(realNow, 'milliseconds').milliseconds
            : (target.getTime() - realNow.getTime());

          showToast(`Jump → ${fmtClock(target)}`);
          updateTabTitleMinutes();
        } else {
          showToast('No next bell in this mode');
        }
        break;
      }

      // Fullscreen
      case 'f': case 'F':
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
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
    updateTabTitleMinutes();
  }

  // ===== Init =====
  reloadBtn?.addEventListener('click', async () => {
    try { await fetchSchedules(); } catch (err) { console.error(err); }
  });

  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  });

  window.addEventListener('keydown', keyHandler);

  ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => {
      if (!audioReady) {
        try { ensureAudio(); audioCtx.resume?.(); } catch {}
      }
    }, { once: true });
  });

  audioGateBtn?.addEventListener('click', () => {
    ensureAudio();
    audioCtx.resume?.();
  });

  // Start
  (async () => {
    try { await fetchSchedules(); } catch (err) { console.error(err); }
    renderModeTag();
    startTabTitleMinuteTicker();

    if (WEATHER.enabled && weatherEl) {
      lastWeatherText = 'Weather: loading…';
      renderWeather();
      fetchWeather();
    }

    requestAnimationFrame(loop);
  })();
})();
