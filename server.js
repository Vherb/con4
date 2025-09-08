const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

class ConnectFourGame {
  constructor(rows = 6, cols = 7) {
    this.rows = rows; this.cols = cols;
    this.board = Array.from({ length: rows }, () => Array(cols).fill(null));
    this.currentPlayer = 'Player 1';
    this.winner = null;
  }
  makeMove(col) {
    if (this.winner) return false;
    if (col < 0 || col >= this.cols) return false;
    let row = this.rows - 1;
    while (row >= 0 && this.board[row][col] !== null) row--;
    if (row < 0) return false;
    this.board[row][col] = this.currentPlayer;
    if (this.#checkWin(row, col)) this.winner = this.currentPlayer;
    else this.currentPlayer = this.currentPlayer === 'Player 1' ? 'Player 2' : 'Player 1';
    return { row, col };
  }
  #checkWin(r, c) {
    const P = this.board[r][c];
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for (const [dr,dc] of dirs) {
      let count = 1;
      for (const s of [-1,1]) {
        let rr=r+dr*s, cc=c+dc*s;
        while (rr>=0&&rr<this.rows&&cc>=0&&cc<this.cols&&this.board[rr][cc]===P) {
          count++; rr+=dr*s; cc+=dc*s;
        }
      }
      if (count>=4) return true;
    }
    return false;
  }
}

/* ---------- Color helpers ---------- */
function normalizeColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : null;
}
function pickAlternateColor(taken) {
  const palette = ['#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#f97316','#111827','#6b7280'];
  const t = (taken || '').toLowerCase();
  return palette.find(p => p.toLowerCase() !== t) || '#3b82f6';
}

/* ---------- Avatar helpers ---------- */
const ALLOWED_AVATARS = new Set([
  'rocket','ninja','wizard','robot','ghost','dragon',
  'knight','alien','unicorn','pirate','fox','panda'
]);
function normalizeAvatar(a) {
  if (typeof a !== 'string') return null;
  const id = a.trim().toLowerCase();
  return ALLOWED_AVATARS.has(id) ? id : null;
}

/* ---------- Server setup ---------- */
const PORT = process.env.PORT || 3001;
const app = express();
app.use(cors());

app.get('/', (_req, res) => res.send('Connect Four WS server running'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let nextRoomId = 1;
const waiting = new Set();
const rooms = new Map();
const state = new WeakMap();
const isOpen = ws => ws && ws.readyState === WebSocket.OPEN;

function send(ws, payload){ if (isOpen(ws)) { try{ ws.send(JSON.stringify(payload)); }catch{} } }
function broadcast(room, payload){ for (const ws of room.players) send(ws, payload); }

/* ---------- Waiting helpers ---------- */
function addToWaiting(ws){ if (!isOpen(ws)) return false; waiting.add(ws); return true; }
function takePair(){
  for (const ws of [...waiting]) if (!isOpen(ws)) waiting.delete(ws);
  const live = [...waiting];
  if (live.length < 2) return null;
  const a = live[0], b = live.find(x => x !== a);
  if (!b) return null;
  waiting.delete(a); waiting.delete(b);
  return [a,b];
}

/* ---------- Countdown lifecycle ---------- */
function startCountdown(roomId){
  const room = rooms.get(roomId);
  if (!room) return;
  room.countdownValue = 5;

  // send individualized "paired" to each side with you: 1|2
  const [a,b] = room.players;
  send(a, { type:'paired', you: 1, usernames: room.usernames, colors: room.colors, avatars: room.avatars });
  send(b, { type:'paired', you: 2, usernames: room.usernames, colors: room.colors, avatars: room.avatars });

  // tick
  room.countdownTimer = setInterval(() => {
    const r = rooms.get(roomId); if (!r) return;
    const bothUp = r.players.every(isOpen);
    if (!bothUp) { cancelCountdown(roomId, true); return; }

    // broadcast value then decrement
    broadcast(r, { type:'countdown', value: r.countdownValue });
    r.countdownValue -= 1;

    if (r.countdownValue <= 0) {
      clearInterval(r.countdownTimer); r.countdownTimer = null;
      const start = {
        type:'startGame',
        currentPlayer: r.game.currentPlayer,
        usernames: r.usernames,
        colors: r.colors,
        avatars: r.avatars
      };
      const [pA,pB] = r.players;
      send(pA, { ...start, playerNumber:1 });
      send(pB, { ...start, playerNumber:2 });
      r.countdownValue = null;
    }
  }, 1000);

  // also push first tick (5) immediately
  broadcast(room, { type:'countdown', value: room.countdownValue });
}
function cancelCountdown(roomId, notifyOpponent){
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.countdownTimer) { clearInterval(room.countdownTimer); room.countdownTimer = null; }
  room.countdownValue = null;
  if (notifyOpponent) {
    for (const ws of room.players) if (isOpen(ws)) send(ws, { type:'opponentLeft' });
  }
  destroyRoom(roomId);
}

/* ---------- Rooms ---------- */
function createRoom(a,b){
  if (!isOpen(a)||!isOpen(b)||a===b) return;
  const id = nextRoomId++;
  const game = new ConnectFourGame();

  const stA = state.get(a) || {};
  const stB = state.get(b) || {};

  // usernames (default to P1/P2 for robustness)
  const nameA = (stA.username || 'Player 1').toString().slice(0, 40) || 'Player 1';
  const nameB = (stB.username || 'Player 2').toString().slice(0, 40) || 'Player 2';
  const usernames = { 'Player 1': nameA, 'Player 2': nameB };

  // colors, ensure distinct
  let colA = normalizeColor(stA.desiredColor) || '#ef4444';
  let colB = normalizeColor(stB.desiredColor) || '#3b82f6';
  if (colB.toLowerCase() === colA.toLowerCase()) colB = pickAlternateColor(colA);
  const colors = { 'Player 1': colA, 'Player 2': colB };

  // avatars (use chosen; fallback per-side but different)
  const avA = normalizeAvatar(stA.avatar) || 'rocket';
  const avB = normalizeAvatar(stB.avatar) || 'ninja';
  const avatars = { 'Player 1': avA, 'Player 2': avB };

  rooms.set(id, { id, game, players:[a,b], colors, usernames, avatars, rematchVotes: new Set(), countdownTimer: null, countdownValue: null });

  state.set(a, { ...stA, roomId:id, playerNumber:1, alive:true });
  state.set(b, { ...stB, roomId:id, playerNumber:2, alive:true });

  startCountdown(id);
}

function destroyRoom(id){
  const room = rooms.get(id); if (!room) return;
  if (room.countdownTimer) { clearInterval(room.countdownTimer); room.countdownTimer = null; }
  for (const ws of room.players) {
    const st = state.get(ws); if (st) { delete st.roomId; delete st.playerNumber; }
  }
  rooms.delete(id);
}

function disconnect(ws){
  waiting.delete(ws);
  const st = state.get(ws);
  if (st?.roomId){
    cancelCountdown(st.roomId, true); // ends room + notifies opponent
  }
  state.delete(ws);
}

/* ---------- Heartbeat ---------- */
setInterval(() => {
  for (const ws of wss.clients) {
    const st = state.get(ws) || {};
    if (st.alive === false) { try{ ws.terminate(); }catch{} disconnect(ws); continue; }
    st.alive = true; state.set(ws, st);
    try{ ws.ping(); }catch{}
  }
  for (const ws of [...waiting]) if (!isOpen(ws)) waiting.delete(ws);
}, 30000);

/* ---------- Socket events ---------- */
wss.on('connection', (ws) => {
  state.set(ws, { alive:true });
  ws.on('pong', () => { const st = state.get(ws); if (st) st.alive = true; });

  ws.on('message', (raw) => {
    let data; try{ data = JSON.parse(raw.toString()); } catch { return; }
    const st = state.get(ws) || {};

    switch (data.type) {
      case 'joinGame': {
        if (st.roomId) return;
        const username = (data.username || '').toString().slice(0, 40);
        const color = normalizeColor(data.color) || null;
        const avatar = normalizeAvatar(data.avatar) || null;
        st.username = username;
        st.desiredColor = color;
        st.avatar = avatar;
        state.set(ws, st);

        addToWaiting(ws);
        send(ws, { type:'queued' });
        const pair = takePair();
        if (pair) createRoom(pair[0], pair[1]);
        break;
      }

      case 'makeMove': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        if (room.countdownValue != null) return; // ignore during countdown
        const sender = st.playerNumber === 1 ? 'Player 1' : 'Player 2';
        if (room.game.currentPlayer !== sender) return;
        const result = room.game.makeMove(data.col);
        if (result) {
          broadcast(room, {
            type:'gameUpdate',
            board: room.game.board,
            currentPlayer: room.game.currentPlayer,
            winner: room.game.winner || null,
            lastMove: result
          });
        }
        break;
      }

      case 'resetGame': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        room.game = new ConnectFourGame();
        room.rematchVotes = new Set();
        broadcast(room, { type:'resetAck' });
        break;
      }

      case 'rematchVote': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        if (!room.rematchVotes) room.rematchVotes = new Set();
        room.rematchVotes.add(st.playerNumber);
        broadcast(room, { type:'rematchUpdate', count: room.rematchVotes.size });
        if (room.rematchVotes.size >= 2) {
          room.game = new ConnectFourGame();
          room.rematchVotes = new Set();
          broadcast(room, { type:'rematchStart' });
        }
        break;
      }

      case 'leaveGame': {
        waiting.delete(ws);
        const s = state.get(ws);
        if (s?.roomId) cancelCountdown(s.roomId, true);
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => disconnect(ws));
  ws.on('error', () => disconnect(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WS server listening on http://0.0.0.0:${PORT}`);
});
