/* Miniondle backend: static file server + global daily leaderboard.
 * Zero dependencies — runs with `node server/server.js`.
 *
 * Data is persisted to server/data/scores.json:
 *   { "<puzzleId>": { "<playerId>": { won, guesses, timeMs, ts } } }
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const PORT = process.env.PORT || 3000;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let scores = {};
try {
  scores = JSON.parse(fs.readFileSync(SCORES_FILE, "utf8"));
} catch {
  scores = {};
}
let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    fs.writeFile(SCORES_FILE, JSON.stringify(scores), (err) => {
      if (err) console.error("save error", err);
    });
  }, 200);
}

// ---------- scoring ----------
// Lower is better. Winners always beat non-winners. Then fewer guesses, then faster.
function scoreValue(e) {
  if (!e.won) return 1e15 + (e.timeMs || 0);
  return (e.guesses || 5) * 1e9 + (e.timeMs || 0);
}

function rankFor(puzzleId, playerId) {
  const board = scores[puzzleId] || {};
  const ids = Object.keys(board);
  const total = ids.length;
  const me = board[playerId];
  const myScore = scoreValue(me);
  let better = 0;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let wins = 0;
  for (const id of ids) {
    const e = board[id];
    if (e.won) { wins++; if (dist[e.guesses] != null) dist[e.guesses]++; }
    if (scoreValue(e) < myScore) better++;
  }
  const rank = better + 1;
  return {
    rank,
    totalPlayers: total,
    percentile: total ? Math.round(((total - rank) / total) * 100) : 0,
    distribution: dist,
    winRate: total ? Math.round((wins / total) * 100) : 0,
  };
}

// ---------- helpers ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------- API ----------
async function handleScore(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: "invalid json" });
  }
  const puzzleId = String(parseInt(payload.puzzleId, 10));
  const playerId = String(payload.playerId || "").slice(0, 80);
  if (!playerId || puzzleId === "NaN") {
    return sendJSON(res, 400, { error: "missing puzzleId/playerId" });
  }
  const entry = {
    won: !!payload.won,
    guesses: payload.won ? Math.min(5, Math.max(1, parseInt(payload.guesses, 10) || 5)) : null,
    timeMs: Math.max(0, Math.min(86400000, parseInt(payload.timeMs, 10) || 0)),
    ts: Date.now(),
  };
  scores[puzzleId] = scores[puzzleId] || {};
  const prev = scores[puzzleId][playerId];
  // keep the player's best attempt
  if (!prev || scoreValue(entry) < scoreValue(prev)) {
    scores[puzzleId][playerId] = entry;
    persist();
  }
  return sendJSON(res, 200, rankFor(puzzleId, playerId));
}

function handleLeaderboard(res, puzzleId) {
  const board = scores[puzzleId] || {};
  const entries = Object.values(board);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let wins = 0;
  const winners = [];
  for (const e of entries) {
    if (e.won) { wins++; if (dist[e.guesses] != null) dist[e.guesses]++; winners.push(e); }
  }
  winners.sort((a, b) => scoreValue(a) - scoreValue(b));
  const top = winners.slice(0, 10).map((e, i) => ({
    rank: i + 1, guesses: e.guesses, timeMs: e.timeMs,
  }));
  return sendJSON(res, 200, {
    puzzleId: Number(puzzleId),
    totalPlayers: entries.length,
    winRate: entries.length ? Math.round((wins / entries.length) * 100) : 0,
    distribution: dist,
    top,
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  if (url.pathname === "/api/score" && req.method === "POST") {
    return handleScore(req, res);
  }
  if (url.pathname === "/api/leaderboard" && req.method === "GET") {
    const pid = String(parseInt(url.searchParams.get("puzzleId"), 10));
    if (pid === "NaN") return sendJSON(res, 400, { error: "missing puzzleId" });
    return handleLeaderboard(res, pid);
  }
  if (url.pathname === "/api/health") {
    return sendJSON(res, 200, { ok: true, puzzles: Object.keys(scores).length });
  }
  if (req.method === "GET") return serveStatic(req, res, url.pathname);
  res.writeHead(405); res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Miniondle running at http://localhost:${PORT}`);
});
