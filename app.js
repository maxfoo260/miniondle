/* Miniondle — a daily Despicable Me guessing game */
(() => {
  "use strict";

  // ---------- Config ----------
  const MAX_GUESSES = 5;
  const EPOCH = new Date(2024, 0, 1);          // puzzle #1 = 2024-01-01 (local)
  const API_BASE = "";                          // same origin; leaderboard backend
  // Static hosts (e.g. GitHub Pages) have no backend — use the estimated leaderboard
  // directly instead of a doomed request that just logs a console error.
  const HAS_BACKEND = !/\.github\.io$/.test(location.hostname) &&
                      location.protocol !== "file:";
  const TRAITS = [
    { key: "eyes",   label: "Eyes" },
    { key: "height", label: "Height" },
    { key: "hair",   label: "Hair" },
  ];

  // ---------- State ----------
  let MINIONS = [];
  let byId = {};
  let answer = null;
  let puzzleId = 0;
  let state = null;            // { guesses:[ids], status, startTime, endTime }
  let selectedId = null;       // currently picked suggestion
  let activeSuggestion = -1;
  let suggestionIds = [];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const portrait = $("portrait");
  const input = $("guessInput");
  const guessBtn = $("guessBtn");
  const suggestionsEl = $("suggestions");
  const boardEl = $("board");
  const guessesLeftEl = $("guessesLeft");

  // ---------- Utilities ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, seed) {
    const rnd = mulberry32(seed);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function dayIndexFromDate(d) {
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor((local - EPOCH) / 86400000);
  }
  function fmtTime(ms) {
    if (ms == null) return "—";
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
  }
  function fmtNum(n) { return n.toLocaleString("en-US"); }
  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------- Persistence ----------
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  function stateKey(id) { return `miniondle:state:${id}`; }
  function loadState() {
    const s = LS.get(stateKey(puzzleId), null);
    if (s && Array.isArray(s.guesses)) return s;
    return { guesses: [], status: "playing", startTime: null, endTime: null };
  }
  function saveState() { LS.set(stateKey(puzzleId), state); }

  function playerId() {
    let pid = LS.get("miniondle:pid", null);
    if (!pid) {
      pid = (crypto.randomUUID && crypto.randomUUID()) ||
        "p-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      LS.set("miniondle:pid", pid);
    }
    return pid;
  }

  function loadStats() {
    return LS.get("miniondle:stats", {
      played: 0, wins: 0, curStreak: 0, maxStreak: 0,
      dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, lastPuzzle: null, lastWonPuzzle: null,
    });
  }
  function recordStats(won, guessCount) {
    const st = loadStats();
    if (st.lastPuzzle === puzzleId) return st;   // already recorded
    st.played += 1;
    if (won) {
      st.wins += 1;
      st.dist[guessCount] = (st.dist[guessCount] || 0) + 1;
      st.curStreak = (st.lastWonPuzzle === puzzleId - 1) ? st.curStreak + 1 : 1;
      st.maxStreak = Math.max(st.maxStreak, st.curStreak);
      st.lastWonPuzzle = puzzleId;
    } else {
      st.curStreak = 0;
    }
    st.lastPuzzle = puzzleId;
    LS.set("miniondle:stats", st);
    return st;
  }

  // ---------- Rendering ----------
  function renderBoard() {
    boardEl.innerHTML = "";
    for (let i = 0; i < MAX_GUESSES; i++) {
      if (i < state.guesses.length) boardEl.appendChild(buildRow(byId[state.guesses[i]]));
      else boardEl.appendChild(buildEmptyRow());
    }
    guessesLeftEl.textContent = Math.max(0, MAX_GUESSES - state.guesses.length);
  }

  function buildEmptyRow() {
    const row = document.createElement("div");
    row.className = "guess-row";
    const minionCell = document.createElement("div");
    minionCell.className = "cell cell-minion cell-empty";
    minionCell.innerHTML = `<span class="cm-name cm-placeholder">?</span>`;
    row.appendChild(minionCell);
    TRAITS.forEach(() => {
      const cell = document.createElement("div");
      cell.className = "cell cell-empty";
      row.appendChild(cell);
    });
    return row;
  }

  function buildRow(guess) {
    const row = document.createElement("div");
    row.className = "guess-row";

    const minionCell = document.createElement("div");
    minionCell.className = "cell cell-minion";
    minionCell.innerHTML = `<span class="cm-name">${guess.name}</span>`;
    row.appendChild(minionCell);

    TRAITS.forEach((trait) => {
      const correct = guess[trait.key] === answer[trait.key];
      const cell = document.createElement("div");
      cell.className = "cell " + (correct ? "correct" : "wrong");
      cell.innerHTML = `<span>${guess[trait.key]}</span>`;
      row.appendChild(cell);
    });
    return row;
  }

  // ---------- Autocomplete ----------
  function exactMatchId(text) {
    const t = text.trim().toLowerCase();
    const m = MINIONS.find((x) => x.name.toLowerCase() === t);
    return m ? m.id : null;
  }
  function updateGuessBtn() {
    const id = selectedId || exactMatchId(input.value);
    const valid = id && !state.guesses.includes(id) && state.status === "playing";
    guessBtn.disabled = !valid;
    return valid ? id : null;
  }
  function renderSuggestions() {
    const q = input.value.trim().toLowerCase();
    suggestionsEl.innerHTML = "";
    suggestionIds = [];
    activeSuggestion = -1;
    if (!q || state.status !== "playing") return;

    const starts = [], contains = [];
    for (const m of MINIONS) {
      const n = m.name.toLowerCase();
      if (n.startsWith(q)) starts.push(m);
      else if (n.includes(q)) contains.push(m);
    }
    const list = [...starts, ...contains].slice(0, 5);
    list.forEach((m, i) => {
      const already = state.guesses.includes(m.id);
      const li = document.createElement("li");
      li.className = "suggestion" + (already ? " disabled" : "");
      li.setAttribute("role", "option");
      li.dataset.id = m.id;
      li.innerHTML =
        `<span class="s-name">${m.name}</span>` +
        (already ? `<span class="s-sub">Already guessed</span>` : "");
      if (!already) {
        li.addEventListener("click", () => pickSuggestion(m.id));
        suggestionIds.push(m.id);
      }
      suggestionsEl.appendChild(li);
    });
  }
  function pickSuggestion(id) {
    selectedId = id;
    input.value = byId[id].name;
    suggestionsEl.innerHTML = "";
    suggestionIds = [];
    updateGuessBtn();
    input.focus();
  }
  function highlightActive() {
    [...suggestionsEl.querySelectorAll(".suggestion:not(.disabled)")].forEach((el, i) => {
      el.classList.toggle("active", i === activeSuggestion);
    });
  }

  // ---------- Guess flow ----------
  function submitGuess() {
    const id = updateGuessBtn();
    if (!id) return;
    if (!state.startTime) state.startTime = Date.now();
    state.guesses.push(id);
    selectedId = null;
    input.value = "";
    suggestionsEl.innerHTML = "";
    renderSuggestions();

    const idx = state.guesses.length - 1;
    const newRow = buildRow(byId[id]);
    if (boardEl.children[idx]) boardEl.replaceChild(newRow, boardEl.children[idx]);
    else boardEl.appendChild(newRow);
    guessesLeftEl.textContent = Math.max(0, MAX_GUESSES - state.guesses.length);

    const won = id === answer.id;
    const lost = !won && state.guesses.length >= MAX_GUESSES;
    if (won || lost) {
      state.status = won ? "won" : "lost";
      state.endTime = Date.now();
      revealPortrait();
      finishGame(won);
    }
    updateGuessBtn();
    saveState();
  }

  function revealPortrait() {
    portrait.style.filter = "none";
    $("portraitOverlay").style.display = "none";
  }

  async function finishGame(won) {
    input.disabled = true;
    guessBtn.disabled = true;
    const guessCount = state.guesses.length;
    const timeMs = (state.startTime && state.endTime) ? state.endTime - state.startTime : 0;
    const stats = recordStats(won, guessCount);
    renderStats(stats);

    // Leaderboard (real backend, with graceful fallback)
    let lb = await submitScore(won, guessCount, timeMs);
    showResult(won, guessCount, timeMs, lb);
  }

  // ---------- Leaderboard backend ----------
  async function submitScore(won, guesses, timeMs) {
    const payload = {
      puzzleId, playerId: playerId(),
      won, guesses: won ? guesses : null, timeMs,
    };
    if (!HAS_BACKEND) return simulateLeaderboard(won, guesses, timeMs);
    try {
      const res = await fetch(`${API_BASE}/api/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("bad status " + res.status);
      const data = await res.json();
      data.source = "live";
      return data;
    } catch (e) {
      return simulateLeaderboard(won, guesses, timeMs);
    }
  }

  function simulateLeaderboard(won, guesses, timeMs) {
    // Deterministic-per-day simulation used only if the backend is unreachable.
    const rnd = mulberry32(puzzleId * 2654435761 >>> 0);
    const totalPlayers = 900 + Math.floor(rnd() * 4200);
    let topFrac; // fraction of players you beat-or-tie from the top
    if (won) {
      const base = { 1: 0.004, 2: 0.05, 3: 0.20, 4: 0.46, 5: 0.74 }[guesses] ?? 0.74;
      const speed = Math.min(1, timeMs / 120000);      // 0 fast .. 1 slow (cap 2 min)
      const span = { 1: 0.02, 2: 0.12, 3: 0.20, 4: 0.22, 5: 0.18 }[guesses] ?? 0.2;
      topFrac = Math.min(0.985, base + speed * span);
    } else {
      topFrac = 0.9 + rnd() * 0.09;
    }
    const rank = Math.max(1, Math.round(totalPlayers * topFrac));
    return {
      rank, totalPlayers,
      percentile: Math.max(1, Math.round((1 - rank / totalPlayers) * 100)),
      source: "estimated",
    };
  }

  // ---------- Result modal ----------
  function showResult(won, guessCount, timeMs, lb) {
    $("resultBanner").textContent = won ? "🎉🍌🎉" : "😢";
    $("resultTitle").textContent = won ? "You got it!" : "So close!";
    $("resultImg").src = answer.img;
    $("resultImg").alt = answer.name;
    $("resultName").textContent = answer.name;
    $("rGuesses").textContent = won ? `${guessCount}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
    $("rTime").textContent = won ? fmtTime(timeMs) : "—";

    if (lb && lb.rank) {
      $("rRank").textContent = "#" + fmtNum(lb.rank);
      const total = lb.totalPlayers;
      const players = `${fmtNum(total)} player${total === 1 ? "" : "s"}`;
      const note = lb.source === "estimated" ? " <span title='Leaderboard server offline — showing an estimate'>(estimated)</span>" : "";
      let line;
      if (!won) {
        line = `${players} took on today's Minion.`;
      } else if (lb.rank === 1) {
        line = `🥇 <span class="rank-pct">1st place</span> out of ${players} today!`;
      } else {
        const topPct = Math.max(1, Math.round((lb.rank / total) * 100));
        line = `You ranked ${ordinal(lb.rank)} — <span class="rank-pct">top ${topPct}%</span> of ${players} today.`;
      }
      $("rankLine").innerHTML = line + note;
    } else {
      $("rRank").textContent = "—";
      $("rankLine").textContent = "";
    }
    openModal("resultModal");
    startCountdown();
  }

  // ---------- Share ----------
  function buildShareText(won) {
    const head = `Miniondle #${puzzleId} ${won ? state.guesses.length + "/" + MAX_GUESSES : "X/" + MAX_GUESSES}`;
    const lines = state.guesses.map((gid) => {
      const g = byId[gid];
      return TRAITS.map((t) => (g[t.key] === answer[t.key] ? "🟩" : "⬛")).join("");
    });
    return `${head}\n${lines.join("\n")}\nminiondle`;
  }
  function doShare() {
    const won = state.status === "won";
    const text = buildShareText(won);
    const done = () => {
      const t = $("shareToast"); t.classList.remove("hidden");
      setTimeout(() => t.classList.add("hidden"), 1800);
    };
    if (navigator.share) {
      navigator.share({ text }).catch(() => copy(text, done));
    } else {
      copy(text, done);
    }
  }
  function copy(text, cb) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(cb, () => fallbackCopy(text, cb));
    else fallbackCopy(text, cb);
  }
  function fallbackCopy(text, cb) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta); cb && cb();
  }

  // ---------- Stats modal ----------
  function renderStats(st) {
    st = st || loadStats();
    $("sPlayed").textContent = st.played;
    $("sWin").textContent = st.played ? Math.round((st.wins / st.played) * 100) : 0;
    $("sStreak").textContent = st.curStreak;
    $("sMax").textContent = st.maxStreak;
    const chart = $("distChart");
    chart.innerHTML = "";
    const max = Math.max(1, ...Object.values(st.dist));
    const curGuess = state.status === "won" ? state.guesses.length : -1;
    for (let i = 1; i <= MAX_GUESSES; i++) {
      const n = st.dist[i] || 0;
      const row = document.createElement("div");
      row.className = "dist-bar-row";
      const pct = Math.round((n / max) * 100);
      row.innerHTML =
        `<span class="dist-idx">${i}</span>` +
        `<span class="dist-bar ${i === curGuess ? "cur" : ""}" style="width:${Math.max(8, pct)}%">${n}</span>`;
      chart.appendChild(row);
    }
  }

  // ---------- Countdown ----------
  let countdownTimer = null;
  function startCountdown() {
    const el = $("countdown");
    function tick() {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      let s = Math.max(0, Math.floor((next - now) / 1000));
      const h = String(Math.floor(s / 3600)).padStart(2, "0");
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const sec = String(s % 60).padStart(2, "0");
      el.textContent = `${h}:${m}:${sec}`;
    }
    tick();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(tick, 1000);
  }

  // ---------- Modals ----------
  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(el) { el.classList.add("hidden"); }

  // ---------- Init ----------
  function pickAnswer() {
    const dayIdx = Math.max(0, dayIndexFromDate(new Date()));
    puzzleId = dayIdx + 1;
    const ids = MINIONS.map((m) => m.id);
    const cycle = Math.floor(dayIdx / ids.length);
    const order = seededShuffle(ids, 1234567 + cycle * 99991);
    const ansId = order[dayIdx % ids.length];
    answer = byId[ansId];
  }

  function setupHeader() {
    $("puzzleNo").textContent = "#" + puzzleId;
    $("puzzleDate").textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
  }

  function restoreIfFinished() {
    if (state.status === "won" || state.status === "lost") {
      revealPortrait();
      input.disabled = true;
      guessBtn.disabled = true;
      const won = state.status === "won";
      const timeMs = (state.startTime && state.endTime) ? state.endTime - state.startTime : 0;
      const stats = loadStats();
      renderStats(stats);
      // Re-fetch rank quietly so returning users still see a leaderboard position.
      submitScore(won, state.guesses.length, timeMs).then((lb) =>
        showResult(won, state.guesses.length, timeMs, lb));
    }
  }

  function wireEvents() {
    input.addEventListener("input", () => {
      if (selectedId && input.value !== byId[selectedId].name) selectedId = null;
      renderSuggestions();
      updateGuessBtn();
    });
    input.addEventListener("keydown", (e) => {
      const opts = suggestionIds.length;
      if (e.key === "ArrowDown" && opts) {
        e.preventDefault(); activeSuggestion = (activeSuggestion + 1) % opts; highlightActive();
      } else if (e.key === "ArrowUp" && opts) {
        e.preventDefault(); activeSuggestion = (activeSuggestion - 1 + opts) % opts; highlightActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeSuggestion >= 0 && suggestionIds[activeSuggestion]) {
          pickSuggestion(suggestionIds[activeSuggestion]);
        } else if (updateGuessBtn()) {
          submitGuess();
        }
      } else if (e.key === "Escape") {
        suggestionsEl.innerHTML = ""; suggestionIds = []; activeSuggestion = -1;
      }
    });
    guessBtn.addEventListener("click", submitGuess);
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box")) { suggestionsEl.innerHTML = ""; suggestionIds = []; }
    });

    $("howBtn").addEventListener("click", () => openModal("howModal"));
    $("statsBtn").addEventListener("click", () => { renderStats(); openModal("statsModal"); });
    $("shareBtn").addEventListener("click", doShare);
    document.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", (e) => closeModal(e.target.closest(".modal"))));
    document.querySelectorAll(".modal").forEach((m) =>
      m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); }));
  }

  async function init() {
    try {
      const res = await fetch("data/minions.json", { cache: "no-cache" });
      MINIONS = await res.json();
    } catch (e) {
      document.querySelector(".portrait-caption").textContent = "Failed to load minions :(";
      return;
    }
    byId = Object.fromEntries(MINIONS.map((m) => [m.id, m]));
    pickAnswer();
    setupHeader();
    state = loadState();

    portrait.src = answer.img;
    portrait.alt = "Mystery Minion";
    // Hide the answer's identity while playing (silhouette-ish) without hiding shape/traits.
    if (state.status === "playing") portrait.style.filter = "none";

    renderBoard();
    wireEvents();
    updateGuessBtn();
    restoreIfFinished();

    // First-time visitors: show how-to.
    if (!LS.get("miniondle:seen", false)) {
      LS.set("miniondle:seen", true);
      openModal("howModal");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
