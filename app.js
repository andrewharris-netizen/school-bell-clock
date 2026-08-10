/* global luxon */
(() => {
  // =========================================================
  // LUXON / TIMEZONE
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

  // IMPORTANT:
  // This URL does NOT contain a specific Gist revision hash.
  // That means edits to the Gist can be picked up by Reload Schedules.
  const SCHEDULES_URL =
    'https://gist.githubusercontent.com/andrewharris-netizen/f731d56672883762b9ba4c3b9b588b38/raw/gistfile1.txt';

  const SCHOOL_TZ = 'America/Chicago';

  const SCHOOL_HOURS = {
    start: '07:00',
    end: '17:00'
  };

  const FLASH_MS = 5000;
  const FLASH_SWAP_MS = 250;

  // Hide the visible next-bell countdown during the final minute.
  const HIDE_NEXT_BELL_LAST_SECONDS = 60;

  // 10/10 rule
  const TEN_TEN_MINUTES = 10;

  // Weather
  const WEATHER = {
    enabled: true,
    lat: 32.7767,
    lon: -96.7970,
    refreshMinutes: 10
  };

  const UI = {
    fg: '#ffffff',
    flashA: '#ffffff',
    flashB: '#e00000'
  };


  // =========================================================
  // STATE
  // =========================================================

  let schedules = {};
  let modesOrder = [];
  let activeMode = 'Regular';

  const nineWeeksPair = [
    'Nine Weeks A (1/3/5/7)',
    'Nine Weeks B (2/4/5/6)'
  ];

  // Timer
  let timerEnd = null;
  let flashUntil = null;
  let flashToggle = false;
  let lastFlashSwapMs = 0;

  // Audio
  let volume = 0.6;
  let muted = false;
  let audioCtx = null;
  let gainNode = null;
  let audioReady = false;

  // Simulation
  let simOffsetMs = 0;

  // Weather cache
  let lastWeatherText = 'Weather: --';
  let lastWeatherCode = null;
  let lastWeatherFetchMs = 0;

  // Lunch
  const lunchOrder = ['A', 'B', 'C', 'D'];

  let selectedLunch = loadSavedLunch();


  // =========================================================
  // DOM ELEMENTS
  // =========================================================

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

  // These can already exist in HTML, or the script will create them.
  let tenTenBadgeEl = el('tenTenBadge');
  let lunchTagEl = el('lunchTag');
  let lunchStatusEl = el('lunchStatus');


  // =========================================================
  // CREATE OPTIONAL UI ELEMENTS
  // =========================================================

  function createTenTenBadgeIfNeeded() {
    if (tenTenBadgeEl || !currEl) return;

    tenTenBadgeEl = document.createElement('div');
    tenTenBadgeEl.id = 'tenTenBadge';
    tenTenBadgeEl.textContent = '10/10 active — no passes';
    tenTenBadgeEl.classList.add('hidden');

    currEl.insertAdjacentElement('afterend', tenTenBadgeEl);
  }


  function createLunchTagIfNeeded() {
    if (lunchTagEl || !modeTagEl) return;

    lunchTagEl = document.createElement('div');
    lunchTagEl.id = 'lunchTag';
    lunchTagEl.classList.add('hidden');

    modeTagEl.insertAdjacentElement('afterend', lunchTagEl);
  }


  function createLunchStatusIfNeeded() {
    if (lunchStatusEl || !currEl) return;

    lunchStatusEl = document.createElement('div');
    lunchStatusEl.id = 'lunchStatus';
    lunchStatusEl.classList.add('hidden');

    // Keep the 10/10 badge directly underneath Current Period.
    const anchor = tenTenBadgeEl || currEl;

    anchor.insertAdjacentElement('afterend', lunchStatusEl);
  }


  // =========================================================
  // LOCAL STORAGE
  // =========================================================

  function loadSavedLunch() {
    try {
      const saved = localStorage.getItem('selectedLunch');

      if (lunchOrder.includes(saved)) {
        return saved;
      }
    } catch {
      // localStorage may be unavailable in highly restricted browsers.
    }

    return 'A';
  }


  function saveLunch() {
    try {
      localStorage.setItem('selectedLunch', selectedLunch);
    } catch {
      // The app can still work without persistence.
    }
  }


  // =========================================================
  // TOASTS
  // =========================================================

  function showToast(msg, ms = 2000) {
    if (!toastContainer) return;

    const toast = document.createElement('div');

    toast.className = 'toast';
    toast.textContent = msg;

    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, ms);
  }


  // =========================================================
  // AUDIO
  // =========================================================

  function hideAudioGate() {
    audioGateBtn?.classList.add('hidden');
  }


  function ensureAudio() {
    if (audioReady) return;

    const AudioContext =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContext) return;

    audioCtx = new AudioContext();

    gainNode = audioCtx.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(audioCtx.destination);

    audioReady = true;

    hideAudioGate();
  }


  function beep(freq = 880, ms = 180) {
    if (!audioReady || muted || !audioCtx || !gainNode) return;

    const oscillator = audioCtx.createOscillator();
    const toneGain = audioCtx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = freq;

    toneGain.gain.value = 1;

    oscillator
      .connect(toneGain)
      .connect(gainNode);

    oscillator.start();

    oscillator.stop(
      audioCtx.currentTime + ms / 1000
    );
  }


  // =========================================================
  // TIME HELPERS
  // =========================================================

  function parseHHMM(str) {
    const [h, m] = str.split(':').map(Number);

    return {
      h,
      m
    };
  }


  function nowReal() {
    if (luxonOK) {
      return DateTime
        .now()
        .setZone(SCHOOL_TZ);
    }

    return new Date();
  }


  function now() {
    if (luxonOK) {
      return nowReal().plus({
        milliseconds: simOffsetMs
      });
    }

    return new Date(
      nowReal().getTime() + simOffsetMs
    );
  }


  function addSeconds(t, seconds) {
    if (luxonOK) {
      return t.plus({
        seconds
      });
    }

    return new Date(
      t.getTime() + seconds * 1000
    );
  }


  function addMinutes(t, minutes) {
    if (luxonOK) {
      return t.plus({
        minutes
      });
    }

    return new Date(
      t.getTime() + minutes * 60000
    );
  }


  function subtractMinutes(t, minutes) {
    if (luxonOK) {
      return t.minus({
        minutes
      });
    }

    return new Date(
      t.getTime() - minutes * 60000
    );
  }


  function addMillis(t, milliseconds) {
    if (luxonOK) {
      return t.plus({
        milliseconds
      });
    }

    return new Date(
      t.getTime() + milliseconds
    );
  }


  function secondsBetween(a, b) {
    if (!a || !b) return 0;

    if (luxonOK) {
      return b.diff(a, 'seconds').seconds;
    }

    return (
      b.getTime() - a.getTime()
    ) / 1000;
  }


  function fmtClock(t) {
    if (luxonOK) {
      return t.toFormat('h:mm:ss a');
    }

    return t.toLocaleTimeString(
      'en-US',
      {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
      }
    );
  }


  function fmtDate(t) {
    if (luxonOK) {
      return t.toFormat(
        'EEE, LLL dd, yyyy'
      );
    }

    return t.toLocaleDateString(
      'en-US',
      {
        weekday: 'short',
        month: 'short',
        day: '2-digit',
        year: 'numeric'
      }
    );
  }


  function fmtHM(t) {
    if (luxonOK) {
      return t.toFormat('h:mm a');
    }

    return t.toLocaleTimeString(
      'en-US',
      {
        hour: 'numeric',
        minute: '2-digit'
      }
    );
  }


  function mmss(seconds) {
    const total = Math.max(
      0,
      Math.round(seconds)
    );

    const minutes =
      Math.floor(total / 60);

    const remainingSeconds =
      total % 60;

    return (
      `${minutes}:` +
      `${String(remainingSeconds).padStart(2, '0')}`
    );
  }


  function minLeftCeil(seconds) {
    return Math.max(
      0,
      Math.ceil(seconds / 60)
    );
  }


  function todayRange() {
    const n = now();

    const startParts =
      parseHHMM(SCHOOL_HOURS.start);

    const endParts =
      parseHHMM(SCHOOL_HOURS.end);

    if (luxonOK) {
      return {
        start: n.set({
          hour: startParts.h,
          minute: startParts.m,
          second: 0,
          millisecond: 0
        }),

        end: n.set({
          hour: endParts.h,
          minute: endParts.m,
          second: 0,
          millisecond: 0
        })
      };
    }

    return {
      start: new Date(
        n.getFullYear(),
        n.getMonth(),
        n.getDate(),
        startParts.h,
        startParts.m,
        0,
        0
      ),

      end: new Date(
        n.getFullYear(),
        n.getMonth(),
        n.getDate(),
        endParts.h,
        endParts.m,
        0,
        0
      )
    };
  }


  // =========================================================
  // SCHEDULE HELPERS
  // =========================================================

  function getModeData(modeName) {
    return schedules[modeName] || null;
  }


  function getPeriodList(modeName) {
    const mode = getModeData(modeName);

    if (!mode) return [];

    // Backward compatibility with the original JSON.
    if (Array.isArray(mode)) {
      return mode;
    }

    return mode.periods || [];
  }


  function buildBlocksFor(modeName) {
    const list = getPeriodList(modeName);

    const n = now();

    if (luxonOK) {
      return list
        .map(({ label, start, end }) => {
          const s = parseHHMM(start);
          const e = parseHHMM(end);

          const startDate = n.set({
            hour: s.h,
            minute: s.m,
            second: 0,
            millisecond: 0
          });

          let endDate = n.set({
            hour: e.h,
            minute: e.m,
            second: 0,
            millisecond: 0
          });

          if (endDate <= startDate) {
            endDate = startDate.plus({
              minutes: 1
            });
          }

          return {
            label,
            sdt: startDate,
            edt: endDate
          };
        })
        .sort(
          (a, b) => a.sdt - b.sdt
        );
    }

    const year = n.getFullYear();
    const month = n.getMonth();
    const day = n.getDate();

    return list
      .map(({ label, start, end }) => {
        const s = parseHHMM(start);
        const e = parseHHMM(end);

        const startDate = new Date(
          year,
          month,
          day,
          s.h,
          s.m,
          0,
          0
        );

        let endDate = new Date(
          year,
          month,
          day,
          e.h,
          e.m,
          0,
          0
        );

        if (endDate <= startDate) {
          endDate = new Date(
            startDate.getTime() + 60000
          );
        }

        return {
          label,
          sdt: startDate,
          edt: endDate
        };
      })
      .sort(
        (a, b) => a.sdt - b.sdt
      );
  }


  function scheduleStatus(n, blocks) {
    if (!blocks.length) {
      return {
        state: 'noschedule'
      };
    }

    for (
      let i = 0;
      i < blocks.length;
      i++
    ) {
      const {
        sdt,
        edt,
        label
      } = blocks[i];

      // Currently inside a scheduled block.
      if (
        n >= sdt &&
        n < edt
      ) {
        const next =
          blocks[i + 1];

        return {
          state: 'in_period',
          current: label,

          currentStart: sdt,
          currentEnd: edt,

          nextBell: edt,

          nextPeriodLabel:
            next
              ? next.label
              : null
        };
      }

      // Passing period before this block.
      if (n < sdt) {
        const previous =
          blocks[i - 1];

        if (
          !previous ||
          previous.edt <= n
        ) {
          return {
            state: 'passing',
            current:
              'Passing Period',

            nextBell: sdt,

            nextPeriodLabel:
              label
          };
        }
      }
    }

    return {
      state: 'noschedule'
    };
  }


  // =========================================================
  // 10/10 RULE
  // =========================================================

  function isClassPeriodLabel(label) {
    return /^(1st|2nd|3rd|4th|5th|6th|7th)\s+Period$/i
      .test(label || '');
  }


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

    const firstTenEnds =
      addMinutes(
        stat.currentStart,
        TEN_TEN_MINUTES
      );

    const lastTenStarts =
      subtractMinutes(
        stat.currentEnd,
        TEN_TEN_MINUTES
      );

    const firstTen =
      n >= stat.currentStart &&
      n < firstTenEnds;

    const lastTen =
      n >= lastTenStarts &&
      n < stat.currentEnd;

    return firstTen || lastTen;
  }


  function renderTenTenBadge(active) {
    if (!tenTenBadgeEl) return;

    tenTenBadgeEl
      .classList
      .toggle(
        'hidden',
        !active
      );
  }


  // =========================================================
  // LUNCH
  // =========================================================

  function getLunchesForMode(modeName) {
    const mode =
      getModeData(modeName);

    if (
      !mode ||
      Array.isArray(mode) ||
      !mode.lunches
    ) {
      return {};
    }

    return mode.lunches;
  }


  function getSelectedLunchData(modeName) {
    const lunches =
      getLunchesForMode(modeName);

    return lunches[selectedLunch] || null;
  }


  function modeHasLunchChoices(modeName) {
    const lunches =
      getLunchesForMode(modeName);

    return (
      Object.keys(lunches).length > 0
    );
  }


  function buildLunchBlock(modeName) {
    const lunch =
      getSelectedLunchData(modeName);

    if (!lunch) return null;

    const n = now();

    const startParts =
      parseHHMM(lunch.start);

    const endParts =
      parseHHMM(lunch.end);

    if (luxonOK) {
      return {
        label:
          `${selectedLunch} Lunch`,

        sdt: n.set({
          hour: startParts.h,
          minute: startParts.m,
          second: 0,
          millisecond: 0
        }),

        edt: n.set({
          hour: endParts.h,
          minute: endParts.m,
          second: 0,
          millisecond: 0
        })
      };
    }

    return {
      label:
        `${selectedLunch} Lunch`,

      sdt: new Date(
        n.getFullYear(),
        n.getMonth(),
        n.getDate(),
        startParts.h,
        startParts.m,
        0,
        0
      ),

      edt: new Date(
        n.getFullYear(),
        n.getMonth(),
        n.getDate(),
        endParts.h,
        endParts.m,
        0,
        0
      )
    };
  }


  function getLunchStatus(n) {
    const lunch =
      buildLunchBlock(activeMode);

    if (!lunch) {
      return {
        state: 'none'
      };
    }

    if (n < lunch.sdt) {
      return {
        state: 'upcoming',
        ...lunch
      };
    }

    if (
      n >= lunch.sdt &&
      n < lunch.edt
    ) {
      return {
        state: 'active',
        ...lunch
      };
    }

    return {
      state: 'finished',
      ...lunch
    };
  }


  function renderLunchTag() {
    if (!lunchTagEl) return;

    if (
      !modeHasLunchChoices(
        activeMode
      )
    ) {
      lunchTagEl
        .classList
        .add('hidden');

      return;
    }

    lunchTagEl
      .classList
      .remove('hidden');

    lunchTagEl.textContent =
      `Lunch: ${selectedLunch}`;
  }


  function renderLunchStatus(n, stat) {
    if (!lunchStatusEl) return;

    const lunch =
      getLunchStatus(n);

    // No lunch configured.
    if (lunch.state === 'none') {
      hideLunchStatus();
      return;
    }

    // Lunch already ended.
    if (lunch.state === 'finished') {
      hideLunchStatus();
      return;
    }

    // Always show if lunch is currently happening.
    if (lunch.state === 'active') {
      const seconds =
        secondsBetween(
          n,
          lunch.edt
        );

      lunchStatusEl.textContent =
        `${lunch.label} • ends in ${mmss(seconds)}`;

      lunchStatusEl
        .classList
        .remove('hidden');

      return;
    }

    /*
      If lunch is still upcoming, show it only once
      we're actually in 5th Period.

      This prevents the clock from saying:
      "D Lunch in 4 hours"
      during 1st period.
    */
    if (
      lunch.state === 'upcoming' &&
      stat &&
      stat.state === 'in_period' &&
      stat.current === '5th Period'
    ) {
      const seconds =
        secondsBetween(
          n,
          lunch.sdt
        );

      lunchStatusEl.textContent =
        `${lunch.label} in ${mmss(seconds)}`;

      lunchStatusEl
        .classList
        .remove('hidden');

      return;
    }

    hideLunchStatus();
  }


  function hideLunchStatus() {
    if (!lunchStatusEl) return;

    lunchStatusEl.textContent = '';

    lunchStatusEl
      .classList
      .add('hidden');
  }


  function cycleLunch() {
    const currentIndex =
      lunchOrder.indexOf(
        selectedLunch
      );

    selectedLunch =
      lunchOrder[
        (currentIndex + 1) %
        lunchOrder.length
      ];

    saveLunch();

    renderLunchTag();

    showToast(
      `Lunch: ${selectedLunch}`
    );
  }


  // =========================================================
  // TAB TITLE
  // =========================================================

  function updateTabTitleMinutes() {
    const n = now();

    const blocks =
      buildBlocksFor(activeMode);

    const stat =
      scheduleStatus(
        n,
        blocks
      );

    if (
      !stat ||
      !stat.nextBell
    ) {
      document.title =
        'School Bell Clock';

      return;
    }

    const seconds =
      secondsBetween(
        n,
        stat.nextBell
      );

    const minutes =
      minLeftCeil(seconds);

    if (
      stat.state ===
      'in_period'
    ) {
      document.title =
        `⏰ ${minutes} min left — ${stat.current}`;

      return;
    }

    if (
      stat.state ===
      'passing'
    ) {
      document.title =
        `⏳ ${minutes} min to ${stat.nextPeriodLabel}`;

      return;
    }

    document.title =
      'School Bell Clock';
  }


  function startTabTitleMinuteTicker() {
    updateTabTitleMinutes();

    // Align updates with the next clock-minute boundary.
    const msToNextMinute =
      60000 -
      (Date.now() % 60000);

    setTimeout(() => {
      updateTabTitleMinutes();

      setInterval(
        updateTabTitleMinutes,
        60000
      );
    }, msToNextMinute);
  }


  // =========================================================
  // MAIN RENDERING
  // =========================================================

  function renderClock(n) {
    if (timeEl) {
      timeEl.textContent =
        fmtClock(n);
    }

    if (dateEl) {
      dateEl.textContent =
        fmtDate(n);
    }
  }


  function renderModeTag() {
    if (!modeTagEl) return;

    modeTagEl.textContent =
      `Mode: ${activeMode}`;
  }


  function renderScheduleTable(blocks, n) {
    if (!tableEl) return;

    tableEl.innerHTML = '';

    // Bottom schedule strip only shows class periods.
    const periodBlocks =
      blocks.filter(
        block =>
          isClassPeriodLabel(
            block.label
          )
      );

    let activeIndex = -1;

    periodBlocks.forEach(
      (block, index) => {
        if (
          n >= block.sdt &&
          n < block.edt
        ) {
          activeIndex =
            index;
        }
      }
    );

    periodBlocks.forEach(
      (block, index) => {
        const cell =
          document.createElement(
            'div'
          );

        cell.className =
          'row' +
          (
            index === activeIndex
              ? ' active'
              : ''
          );

        const label =
          document.createElement(
            'div'
          );

        label.className =
          'label';

        label.textContent =
          block.label.replace(
            ' Period',
            ''
          );

        const time =
          document.createElement(
            'div'
          );

        time.className =
          'time';

        time.textContent =
          `${fmtHM(block.sdt)}–${fmtHM(block.edt)}`;

        cell.appendChild(label);
        cell.appendChild(time);

        tableEl.appendChild(cell);
      }
    );
  }


  function renderCenter(stat, n) {
    if (
      !stat ||
      stat.state === 'noschedule'
    ) {
      if (currEl) {
        currEl.textContent =
          'No school schedule active';
      }

      if (nextEl) {
        nextEl.textContent = '';
      }

      renderTenTenBadge(false);
      hideLunchStatus();

      return;
    }

    if (currEl) {
      currEl.textContent =
        stat.current || '';
    }

    // 10/10 is based ONLY on the class period.
    const tenTenActive =
      isTenTenActive(
        stat,
        n
      );

    renderTenTenBadge(
      tenTenActive
    );

    // Lunch status is independent of 10/10.
    renderLunchStatus(
      n,
      stat
    );

    if (!nextEl) return;

    if (stat.nextBell) {
      const seconds =
        secondsBetween(
          n,
          stat.nextBell
        );

      const bellTime =
        fmtHM(
          stat.nextBell
        );

      // Hide visible countdown during final minute of class.
      if (
        stat.state === 'in_period' &&
        seconds <=
          HIDE_NEXT_BELL_LAST_SECONDS
      ) {
        nextEl.textContent = '';
      } else {
        nextEl.textContent =
          `Next bell: ${bellTime} • ${mmss(seconds)}`;
      }
    } else {
      nextEl.textContent = '';
    }
  }


  function setDim(n) {
    if (!dimOverlay) return;

    const {
      start,
      end
    } = todayRange();

    const inHours =
      n >= start &&
      n <= end;

    dimOverlay
      .classList
      .toggle(
        'hidden',
        inHours
      );
  }


  // =========================================================
  // TIMER OVERLAY
  // =========================================================

  function showCountdown(text) {
    if (
      !countdownOverlay ||
      !countdownText
    ) {
      return;
    }

    countdownText.textContent =
      text;

    countdownOverlay
      .classList
      .remove('hidden');
  }


  function hideCountdown() {
    countdownOverlay
      ?.classList
      .add('hidden');
  }


  function setFlashLayer(n) {
    if (
      !flashUntil ||
      !(n < flashUntil)
    ) {
      flashOverlay
        ?.classList
        .add('hidden');

      return;
    }

    flashOverlay
      ?.classList
      .remove('hidden');

    const currentMs =
      Date.now();

    if (
      currentMs -
      lastFlashSwapMs >=
      FLASH_SWAP_MS
    ) {
      flashToggle =
        !flashToggle;

      lastFlashSwapMs =
        currentMs;
    }

    if (countdownText) {
      countdownText.style.color =
        flashToggle
          ? UI.flashA
          : UI.flashB;
    }
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

    return (
      descriptions[code] ||
      'Weather'
    );
  }


  function codeToIconKind(code) {
    if (code === 0) {
      return 'clear';
    }

    if (
      code === 1 ||
      code === 2
    ) {
      return 'partly';
    }

    if (code === 3) {
      return 'cloudy';
    }

    if (
      code === 45 ||
      code === 48
    ) {
      return 'fog';
    }

    if (
      (
        code >= 51 &&
        code <= 67
      ) ||
      (
        code >= 80 &&
        code <= 82
      )
    ) {
      return 'rain';
    }

    if (
      (
        code >= 71 &&
        code <= 77
      ) ||
      code === 85 ||
      code === 86
    ) {
      return 'snow';
    }

    if (code >= 95) {
      return 'thunder';
    }

    return 'cloudy';
  }


  function svgIcon(kind) {
    switch (kind) {
      case 'clear':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>

            <path d="M12 2v2"></path>
            <path d="M12 20v2"></path>

            <path d="M2 12h2"></path>
            <path d="M20 12h2"></path>

            <path d="M4.9 4.9l1.4 1.4"></path>
            <path d="M17.7 17.7l1.4 1.4"></path>

            <path d="M19.1 4.9l-1.4 1.4"></path>
            <path d="M6.3 17.7l-1.4 1.4"></path>
          </svg>
        `;

      case 'partly':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="8" cy="10" r="3"></circle>

            <path d="M8 3v1.5"></path>
            <path d="M3 10h1.5"></path>
            <path d="M12.5 10H14"></path>
            <path d="M5.3 5.3l1.1 1.1"></path>

            <path d="M6 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 1.7A3.3 3.3 0 0 0 6 18z"></path>
          </svg>
        `;

      case 'cloudy':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 18h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 18z"></path>
          </svg>
        `;

      case 'rain':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 16h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>

            <path d="M8 18l-1 2"></path>
            <path d="M12 18l-1 2"></path>
            <path d="M16 18l-1 2"></path>
          </svg>
        `;

      case 'snow':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 16h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>

            <circle cx="9" cy="19" r="0.8"></circle>
            <circle cx="12" cy="19" r="0.8"></circle>
            <circle cx="15" cy="19" r="0.8"></circle>
          </svg>
        `;

      case 'thunder':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 16h10a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 16z"></path>

            <path d="M12 16l-2 4h2l-1 3 4-6h-2l1-1z"></path>
          </svg>
        `;

      case 'fog':
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 13h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 13z"></path>

            <path d="M4 17h16"></path>
            <path d="M6 20h12"></path>
          </svg>
        `;

      default:
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 18h11a4 4 0 0 0 .3-8 5.8 5.8 0 0 0-11 .9A3.4 3.4 0 0 0 6 18z"></path>
          </svg>
        `;
    }
  }


  async function fetchWeather() {
    if (
      !WEATHER.enabled ||
      !weatherEl ||
      !weatherTextEl ||
      !weatherIconEl
    ) {
      return;
    }

    const currentMs =
      Date.now();

    const minimumInterval =
      WEATHER.refreshMinutes *
      60 *
      1000;

    if (
      currentMs -
      lastWeatherFetchMs <
      minimumInterval
    ) {
      return;
    }

    lastWeatherFetchMs =
      currentMs;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(WEATHER.lat)}` +
      `&longitude=${encodeURIComponent(WEATHER.lon)}` +
      `&current=temperature_2m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum` +
      `&temperature_unit=fahrenheit` +
      `&timezone=${encodeURIComponent(SCHOOL_TZ)}`;

    try {
      const response =
        await fetch(
          url,
          {
            cache: 'no-store'
          }
        );

      if (!response.ok) {
        throw new Error(
          `Weather ${response.status}`
        );
      }

      const data =
        await response.json();

      const temp =
        data?.current
          ?.temperature_2m;

      const code =
        data?.current
          ?.weather_code;

      const high =
        data?.daily
          ?.temperature_2m_max
          ?.[0];

      const low =
        data?.daily
          ?.temperature_2m_min
          ?.[0];

      const precip =
        data?.daily
          ?.precipitation_probability_max
          ?.[0];

      const snowCm =
        data?.daily
          ?.snowfall_sum
          ?.[0];

      const snowInches =
        typeof snowCm === 'number'
          ? snowCm / 2.54
          : null;

      const condition =
        wmoToText(code);

      const iconKind =
        codeToIconKind(code);

      const parts = [];

      if (
        typeof temp === 'number'
      ) {
        parts.push(
          `${Math.round(temp)}°F ${condition}`
        );
      } else {
        parts.push(condition);
      }

      if (
        typeof high === 'number' &&
        typeof low === 'number'
      ) {
        parts.push(
          `H ${Math.round(high)}° / L ${Math.round(low)}°`
        );
      }

      if (
        typeof precip ===
        'number'
      ) {
        parts.push(
          `PoP ${Math.round(precip)}%`
        );
      }

      if (
        typeof snowInches ===
          'number' &&
        snowInches > 0.05
      ) {
        parts.push(
          `Snow ${snowInches.toFixed(1)}"`
        );
      }

      lastWeatherText =
        parts.join(' • ');

      lastWeatherCode =
        code;

      weatherIconEl.innerHTML =
        svgIcon(iconKind);

      weatherTextEl.textContent =
        lastWeatherText;

    } catch (error) {
      console.warn(
        'Weather unavailable:',
        error
      );

      if (
        lastWeatherCode !== null
      ) {
        weatherIconEl.innerHTML =
          svgIcon(
            codeToIconKind(
              lastWeatherCode
            )
          );
      }

      weatherTextEl.textContent =
        lastWeatherText;
    }
  }


  function renderWeather() {
    if (
      !WEATHER.enabled ||
      !weatherEl ||
      !weatherTextEl ||
      !weatherIconEl
    ) {
      return;
    }

    weatherTextEl.textContent =
      lastWeatherText;

    if (
      lastWeatherCode !== null
    ) {
      weatherIconEl.innerHTML =
        svgIcon(
          codeToIconKind(
            lastWeatherCode
          )
        );
    }
  }


  // =========================================================
  // MODES
  // =========================================================

  function setActiveMode(
    modeName,
    toastMessage = null
  ) {
    if (!schedules[modeName]) {
      return;
    }

    activeMode =
      modeName;

    renderModeTag();
    renderLunchTag();

    updateTabTitleMinutes();

    if (toastMessage) {
      showToast(
        toastMessage
      );
    }
  }


  function toggleNineWeeks() {
    if (
      activeMode ===
      nineWeeksPair[0]
    ) {
      setActiveMode(
        nineWeeksPair[1],
        nineWeeksPair[1]
      );

      return;
    }

    setActiveMode(
      nineWeeksPair[0],
      nineWeeksPair[0]
    );
  }


  function cycleMode() {
    if (!modesOrder.length) {
      return;
    }

    const index =
      modesOrder.indexOf(
        activeMode
      );

    const nextIndex =
      (
        index + 1
      ) %
      modesOrder.length;

    setActiveMode(
      modesOrder[nextIndex],
      `Mode: ${modesOrder[nextIndex]}`
    );
  }


  // =========================================================
  // TIMERS
  // =========================================================

  function startTimer(seconds) {
    const n = now();

    timerEnd =
      addSeconds(
        n,
        seconds
      );

    flashUntil = null;

    showToast(
      `Timer: ${mmss(seconds)}`
    );

    ensureAudio();

    audioCtx?.resume?.();

    // Small acknowledgement chirp.
    beep(
      660,
      120
    );
  }


  function cancelTimer() {
    timerEnd = null;
    flashUntil = null;

    hideCountdown();

    showToast(
      'Timer canceled'
    );
  }


  // =========================================================
  // KEYBOARD CONTROLS
  // =========================================================

  function keyHandler(event) {
    if (
      ['INPUT', 'TEXTAREA']
        .includes(
          document.activeElement
            ?.tagName
        )
    ) {
      return;
    }

    switch (event.key) {

      // ---------------------------------
      // FULLSCREEN
      // ---------------------------------

      case 'Escape':
        document
          .exitFullscreen
          ?.();

        break;


      case 'f':
      case 'F':
        if (
          !document.fullscreenElement
        ) {
          document.documentElement
            .requestFullscreen
            ?.();
        } else {
          document
            .exitFullscreen
            ?.();
        }

        break;


      // ---------------------------------
      // SCHEDULE MODES
      // ---------------------------------

      case 'r':
      case 'R':
        setActiveMode(
          'Regular',
          'Mode: Regular'
        );

        break;


      case 'p':
      case 'P':
        setActiveMode(
          'Pep Rally',
          'Mode: Pep Rally'
        );

        break;


      case 'e':
      case 'E':
        setActiveMode(
          'Early Release',
          'Mode: Early Release'
        );

        break;


      case 't':
      case 'T':
        toggleNineWeeks();
        break;


      case 's':
      case 'S':
        cycleMode();
        break;


      // ---------------------------------
      // LUNCH
      // ---------------------------------

      case 'l':
      case 'L':
        cycleLunch();
        break;


      // ---------------------------------
      // TIMERS
      // ---------------------------------

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
        event.preventDefault();
        cancelTimer();
        break;


      // ---------------------------------
      // AUDIO
      // ---------------------------------

      case 'm':
      case 'M':
        muted = !muted;

        showToast(
          muted
            ? 'Muted'
            : 'Unmuted'
        );

        break;


      case '+':
      case '=':
        volume =
          Math.min(
            1,
            volume + 0.1
          );

        if (gainNode) {
          gainNode.gain.value =
            volume;
        }

        showToast(
          `Volume: ${Math.round(volume * 100)}%`
        );

        break;


      case '-':
        volume =
          Math.max(
            0,
            volume - 0.1
          );

        if (gainNode) {
          gainNode.gain.value =
            volume;
        }

        showToast(
          `Volume: ${Math.round(volume * 100)}%`
        );

        break;


      // ---------------------------------
      // SIMULATION
      // ---------------------------------

      case ']':
        simOffsetMs +=
          5 * 60 * 1000;

        showToast(
          `Sim +5m → ${fmtClock(now())}`
        );

        updateTabTitleMinutes();

        break;


      case '[':
        simOffsetMs -=
          5 * 60 * 1000;

        showToast(
          `Sim -5m → ${fmtClock(now())}`
        );

        updateTabTitleMinutes();

        break;


      case '\\':
        simOffsetMs = 0;

        showToast(
          'Sim reset'
        );

        updateTabTitleMinutes();

        break;


      case 'n':
      case 'N': {
        const simulatedNow =
          now();

        const status =
          scheduleStatus(
            simulatedNow,
            buildBlocksFor(
              activeMode
            )
          );

        if (
          status.nextBell
        ) {
          const target =
            luxonOK
              ? status.nextBell.minus({
                  seconds: 5
                })
              : new Date(
                  status.nextBell
                    .getTime() -
                  5000
                );

          const actualNow =
            nowReal();

          simOffsetMs =
            luxonOK
              ? target.diff(
                  actualNow,
                  'milliseconds'
                ).milliseconds
              : target.getTime() -
                actualNow.getTime();

          showToast(
            `Jump → ${fmtClock(target)}`
          );

          updateTabTitleMinutes();
        } else {
          showToast(
            'No next bell in this mode'
          );
        }

        break;
      }
    }
  }


  // =========================================================
  // FETCH SCHEDULES
  // =========================================================

  async function fetchSchedules() {
    const separator =
      SCHEDULES_URL.includes('?')
        ? '&'
        : '?';

    const url =
      SCHEDULES_URL +
      separator +
      'cachebust=' +
      Date.now();

    let response;

    try {
      response =
        await fetch(
          url,
          {
            cache: 'no-store'
          }
        );
    } catch (error) {
      showToast(
        `Fetch failed: ${error.message}`,
        5000
      );

      throw error;
    }

    if (!response.ok) {
      const message =
        `Fetch schedules failed: ${response.status} ${response.statusText}`;

      showToast(
        message,
        5000
      );

      throw new Error(
        message
      );
    }

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch (error) {
      showToast(
        `Bad schedule JSON: ${error.message}`,
        5000
      );

      throw error;
    }

    schedules =
      data.modes
        ? data.modes
        : data;

    modesOrder =
      Object.keys(
        schedules
      );

    if (!modesOrder.length) {
      const message =
        'No schedule modes found';

      showToast(
        message,
        5000
      );

      throw new Error(
        message
      );
    }

    if (
      !schedules[
        activeMode
      ]
    ) {
      activeMode =
        modesOrder[0];
    }

    renderModeTag();
    renderLunchTag();

    updateTabTitleMinutes();

    showToast(
      'Schedules loaded'
    );
  }


  // =========================================================
  // MAIN LOOP
  // =========================================================

  function loop() {
    const n = now();

    renderClock(n);
    setDim(n);

    const blocks =
      buildBlocksFor(
        activeMode
      );

    const stat =
      scheduleStatus(
        n,
        blocks
      );


    // ---------------------------------
    // TIMER
    // ---------------------------------

    if (
      flashUntil &&
      n < flashUntil
    ) {
      showCountdown(
        '0:00'
      );

      setFlashLayer(n);

    } else if (timerEnd) {
      const seconds =
        secondsBetween(
          n,
          timerEnd
        );

      if (seconds <= 0) {
        beep();

        flashUntil =
          addMillis(
            n,
            FLASH_MS
          );

        timerEnd = null;

        if (countdownText) {
          countdownText.style.color =
            UI.flashA;
        }

        showCountdown(
          '0:00'
        );

      } else {
        if (countdownText) {
          countdownText.style.color =
            UI.fg;
        }

        showCountdown(
          mmss(seconds)
        );
      }

    } else {
      hideCountdown();

      if (countdownText) {
        countdownText.style.color =
          UI.fg;
      }
    }


    // ---------------------------------
    // NORMAL PAGE
    // ---------------------------------

    renderCenter(
      stat,
      n
    );

    renderScheduleTable(
      blocks,
      n
    );

    if (simTagEl) {
      simTagEl.textContent =
        simOffsetMs
          ? 'SIM TIME'
          : '';
    }

    renderWeather();
    fetchWeather();

    requestAnimationFrame(
      loop
    );
  }


  // =========================================================
  // BUTTONS / AUDIO UNLOCK
  // =========================================================

  reloadBtn
    ?.addEventListener(
      'click',
      async () => {
        try {
          await fetchSchedules();
        } catch (error) {
          console.error(
            error
          );
        }
      }
    );


  fullscreenBtn
    ?.addEventListener(
      'click',
      () => {
        if (
          !document.fullscreenElement
        ) {
          document.documentElement
            .requestFullscreen
            ?.();
        }
      }
    );


  window.addEventListener(
    'keydown',
    keyHandler
  );


  [
    'click',
    'keydown',
    'pointerdown',
    'touchstart'
  ].forEach(eventName => {
    window.addEventListener(
      eventName,
      () => {
        if (!audioReady) {
          try {
            ensureAudio();

            audioCtx
              ?.resume
              ?.();
          } catch {
            // Ignore audio unlock errors.
          }
        }
      },
      {
        once: true
      }
    );
  });


  audioGateBtn
    ?.addEventListener(
      'click',
      () => {
        ensureAudio();

        audioCtx
          ?.resume
          ?.();
      }
    );


  // =========================================================
  // STARTUP
  // =========================================================

  createTenTenBadgeIfNeeded();
  createLunchTagIfNeeded();
  createLunchStatusIfNeeded();


  (async () => {
    try {
      await fetchSchedules();
    } catch (error) {
      console.error(
        error
      );
    }

    renderModeTag();
    renderLunchTag();

    startTabTitleMinuteTicker();

    if (
      WEATHER.enabled &&
      weatherEl
    ) {
      lastWeatherText =
        'Weather: loading…';

      renderWeather();
      fetchWeather();
    }

    requestAnimationFrame(
      loop
    );
  })();

})();
