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
    return true;
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

function addToWaiting(ws){ if (!isOpen(ws)) return false; waiting.add(ws); return true; }
function takePair(){
  const live = [...waiting].filter(isOpen);
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
function createRoom(a,b, nameA=''){
  if (!isOpen(a)||!isOpen(b)||a===b) return;
  const id = nextRoomId++;
  const game = new ConnectFourGame();
  rooms.set(id, { id, game, players:[a,b] });
  state.set(a, { roomId:id, playerNumber:1, alive:true });
  state.set(b, { roomId:id, playerNumber:2, alive:true });

  try{ a.send(JSON.stringify({ type:'startGame', currentPlayer:game.currentPlayer, playerNumber:1, username:nameA })); }catch{}
  try{ b.send(JSON.stringify({ type:'startGame', currentPlayer:game.currentPlayer, playerNumber:2, username:'' })); }catch{}
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

setInterval(() => {
  for (const ws of wss.clients) {
    const st = state.get(ws) || {};
    if (st.alive === false) { try{ ws.terminate(); }catch{} disconnect(ws); continue; }
    st.alive = true; state.set(ws, st);
    try{ ws.ping(); }catch{}
  }
}, 30000);

wss.on('connection', (ws) => {
  state.set(ws, { alive:true });
  ws.on('pong', () => { const st = state.get(ws); if (st) st.alive = true; });

  ws.on('message', (raw) => {
    let data; try{ data = JSON.parse(raw.toString()); } catch { return; }
    const st = state.get(ws) || {};

    switch (data.type) {
      case 'joinGame': {
        if (st.roomId) return;
        addToWaiting(ws);
        try{ ws.send(JSON.stringify({ type:'queued' })); }catch{}
        const pair = takePair();
        if (pair) createRoom(pair[0], pair[1], data.username || '');
        break;
      }
      case 'makeMove': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        const sender = st.playerNumber === 1 ? 'Player 1' : 'Player 2';
        if (room.game.currentPlayer !== sender) return;
        const ok = room.game.makeMove(data.col);
        if (ok) {
          broadcast(room, {
            type:'gameUpdate',
            board: room.game.board,
            currentPlayer: room.game.currentPlayer,
            winner: room.game.winner || null
          });
        }
        break;
      }
      case 'resetGame': {
        if (!st.roomId) return;
        const room = rooms.get(st.roomId); if (!room) return;
        room.game = new ConnectFourGame();
        broadcast(room, { type:'resetAck' });
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
