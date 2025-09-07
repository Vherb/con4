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
    return { row, col }; // return coordinates of the placed chip
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
  const palette = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#111827'];
  const t = (taken || '').toLowerCase();
  return palette.find(p => p.toLowerCase() !== t) || '#3b82f6';
}

/* ---------- Server setup ---------- */
const PORT = process.env.PORT || 3001;
const app = express();
app.use(cors());

app.get('/', (_req, res) => res.send('Connect Four WS server running'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/stats', (_req, res) => res.json({
  waitingCount: waiting.size,
  rooms: [...rooms.keys()],
  clients: wss ? wss.clients.size : 0
}));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let nextRoomId = 1;
const waiting = new Set();
const rooms = new Map();
const state = new WeakMap();
const isOpen = ws => ws && ws.readyState === WebSocket.OPEN;

/* ---------- Helpers ---------- */
function addToWaiting(ws){ if (!isOpen(ws)) return false; waiting.add(ws); return true; }
function takePair(){
  // Purge closed sockets first
  for (const ws of [...waiting]) if (!isOpen(ws)) waiting.delete(ws);
  const live = [...waiting];
  if (live.length < 2) return null;
  const a = live[0], b = live.find(x => x !== a);
  if (!b) return null;
  waiting.delete(a); waiting.delete(b);
  return [a,b];
}

function broadcast(room, payload){
  const msg = JSON.stringify(payload);
  for (const ws of room.players) if (isOpen(ws)) { try{ ws.send(msg); }catch{} }
}

function createRoom(a,b){
  if (!isOpen(a)||!isOpen(b)||a===b) return;
  const id = nextRoomId++;
  const game = new ConnectFourGame();

  const stA = state.get(a) || {};
  const stB = state.get(b) || {};

  // ----- Names (temporary usernames) -----
  const nameA = (stA.username || 'Player 1').toString().slice(0, 40) || 'Player 1';
  const nameB = (stB.username || 'Player 2').toString().slice(0, 40) || 'Player 2';
  const usernames = { 'Player 1': nameA, 'Player 2': nameB };

  // ----- Colors (guarantee distinct) -----
  let colA = normalizeColor(stA.desiredColor) || '#ef4444'; // default P1 red
  let colB = normalizeColor(stB.desiredColor) || '#3b82f6'; // default P2 blue
  if (colB.toLowerCase() === colA.toLowerCase()) colB = pickAlternateColor(colA);
  const colors = { 'Player 1': colA, 'Player 2': colB };

  rooms.set(id, { id, game, players:[a,b], colors, rematchVotes: new Set(), usernames });

  state.set(a, { ...stA, roomId:id, playerNumber:1, alive:true });
  state.set(b, { ...stB, roomId:id, playerNumber:2, alive:true });

  const payload = {
    type:'startGame',
    currentPlayer: game.currentPlayer,
    usernames,           // 👈 both names to both players
    colors               // 👈 both colors to both players
  };

  try{ a.send(JSON.stringify({ ...payload, playerNumber:1 })); }catch{}
  try{ b.send(JSON.stringify({ ...payload, playerNumber:2 })); }catch{}
}

function destroyRoom(id){
  const room = rooms.get(id); if (!room) return;
  for (const ws of room.players) {
    const st = state.get(ws); if (st) { delete st.roomId; delete st.playerNumber; }
    try{ ws.send(JSON.stringify({ type:'end' })); }catch{}
  }
  rooms.delete(id);
}

function disconnect(ws){
  waiting.delete(ws);
  const st = state.get(ws);
  if (st?.roomId){
    const room = rooms.get(st.roomId);
    if (room){
      for (const other of room.players) if (other!==ws && isOpen(other)) {
        try{ other.send(JSON.stringify({ type:'opponentLeft' })); }catch{}
      }
      destroyRoom(st.roomId);
    }
  }
  state.delete(ws);
}

/* ---------- Heartbeat + waiting purge ---------- */
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
        st.username = username;
        st.desiredColor = color;
        state.set(ws, st);

        addToWaiting(ws);
        try{ ws.send(JSON.stringify({ type:'queued' })); }catch{}
        const pair = takePair();
        if (pair) createRoom(pair[0], pair[1]);
        break;
      }

      case 'makeMove': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        const sender = st.playerNumber === 1 ? 'Player 1' : 'Player 2';
        if (room.game.currentPlayer !== sender) return;
        const result = room.game.makeMove(data.col);
        if (result) {
          broadcast(room, {
            type:'gameUpdate',
            board: room.game.board,
            currentPlayer: room.game.currentPlayer,
            winner: room.game.winner || null,
            lastMove: result // {row,col}
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

      /* ----- Simple rematch voting: 2/2 => new game ----- */
      case 'rematchVote': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        if (!room.rematchVotes) room.rematchVotes = new Set();
        room.rematchVotes.add(st.playerNumber);
        broadcast(room, { type:'rematchUpdate', count: room.rematchVotes.size });
        if (room.rematchVotes.size >= 2) {
          room.game = new ConnectFourGame();
          room.rematchVotes = new Set();
          broadcast(room, { type: 'rematchStart' });
        }
        break;
      }

      /* Optional: allow renaming mid-match and broadcast to both players */
      case 'updateName': {
        const newName = (data.username || '').toString().slice(0, 40);
        st.username = newName || '';
        state.set(ws, st);
        if (st.roomId) {
          const room = rooms.get(st.roomId);
          if (room) {
            const names = { ...room.usernames };
            const role = st.playerNumber === 1 ? 'Player 1' : 'Player 2';
            names[role] = newName || (role === 'Player 1' ? 'Player 1' : 'Player 2');
            room.usernames = names;
            broadcast(room, { type:'usernames', usernames: names });
          }
        }
        break;
      }

      /* Graceful leave */
      case 'leaveGame': {
        waiting.delete(ws);
        const s = state.get(ws);
        if (s?.roomId) {
          const room = rooms.get(s.roomId);
          if (room) {
            for (const other of room.players) if (other!==ws && isOpen(other)) {
              try{ other.send(JSON.stringify({ type:'opponentLeft' })); }catch{}
            }
            destroyRoom(s.roomId);
          }
        }
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
