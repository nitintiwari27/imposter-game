import express from 'express';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientAction } from '../shared/types.js';
import { addPlayer, createRoom, hostOf, makeCode, postChat, privateState, reconnect, removeExpiredPlayers, setHost, setRoomChangeHandler, snapshot, startRound, submitClue, submitGuess, submitVote, type Player, type Room } from './game.js';

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));
const httpServer = createServer(app);
const allowedOrigin = process.env.CLIENT_ORIGIN;
const io = new Server(httpServer, {
  cors: allowedOrigin ? { origin: allowedOrigin, credentials: true } : undefined,
  pingInterval: 20_000, pingTimeout: 25_000,
  maxHttpBufferSize: 32_000,
});
const rooms = new Map<string, Room>();
const playersBySocket = new Map<string, { room: Room; playerId: string }>();

function broadcast(room: Room): void {
  room.touchedAt = Date.now();
  io.to(room.code).emit('room', snapshot(room));
  for (const player of room.players.values()) if (player.online) {
    io.to(player.socketId).emit('private', privateState(room, player));
  }
}
setRoomChangeHandler(broadcast);
function connectPlayer(socket: Socket, room: Room, player: Player): void {
  socket.join(room.code);
  playersBySocket.set(socket.id, { room, playerId: player.id });
  socket.emit('session', { roomCode: room.code, token: player.token, playerId: player.id });
  broadcast(room);
}
function error(socket: Socket, message: string): void { socket.emit('gameError', { message }); }
function getPlayer(socket: Socket): { room: Room; player: Player } | null {
  const ref = playersBySocket.get(socket.id);
  if (!ref) return null;
  const player = ref.room.players.get(ref.playerId);
  if (!player || player.socketId !== socket.id) return null;
  return { room: ref.room, player };
}

io.on('connection', socket => {
  socket.on('action', (action: ClientAction) => {
    try {
      if (!action || typeof action !== 'object' || !('type' in action)) throw new Error('That action could not be understood.');
      if (action.type === 'create') {
        if (typeof action.token !== 'string' || action.token.length < 24 || action.token.length > 100) throw new Error('Refresh the page and try again.');
        const room = createRoom(action.name, action.token, socket.id);
        if (rooms.has(room.code)) room.code = makeCode(code => rooms.has(code));
        const player = [...room.players.values()][0];
        rooms.set(room.code, room);
        connectPlayer(socket, room, player);
        return;
      }
      if (action.type === 'join') {
        if (typeof action.code !== 'string' || typeof action.token !== 'string' || action.token.length < 24 || action.token.length > 100) throw new Error('Enter a room code and nickname.');
        const code = action.code.trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) throw new Error('Room not found. Check the code and try again.');
        const player = addPlayer(room, action.name, action.token, socket.id);
        if (![...room.players.values()].some(p => p.isHost && p.online)) setHost(room, player.id);
        connectPlayer(socket, room, player); return;
      }
      if (action.type === 'resume') {
        if (typeof action.code !== 'string' || typeof action.token !== 'string') throw new Error('Could not reconnect. Refresh and rejoin with the room code.');
        const room = rooms.get(action.code.trim().toUpperCase());
        if (!room) throw new Error('That room has closed. Ask the host to make a new room.');
        const player = reconnect(room, action.token, socket.id);
        connectPlayer(socket, room, player); return;
      }
      const current = getPlayer(socket);
      if (!current) throw new Error('Join or create a room before playing.');
      const { room, player } = current;
      switch (action.type) {
        case 'start':
          if (hostOf(room)?.id !== player.id) throw new Error('Only the host can start a round.');
          startRound(room); break;
        case 'clue': submitClue(room, player, action.text); break;
        case 'chat': postChat(room, player, action.text); break;
        case 'vote': submitVote(room, player, action.targetId); break;
        case 'guess': submitGuess(room, player, action.text); break;
        case 'rematch':
          if (hostOf(room)?.id !== player.id) throw new Error('Only the host can start a rematch.');
          startRound(room, room.phase === 'match_over'); break;
        default: throw new Error('That move is not available.');
      }
      broadcast(room);
    } catch (caught) { error(socket, caught instanceof Error ? caught.message : 'Something went wrong. Please try again.'); }
  });

  socket.on('disconnect', () => {
    const ref = playersBySocket.get(socket.id);
    playersBySocket.delete(socket.id);
    if (!ref) return;
    const player = ref.room.players.get(ref.playerId);
    if (!player || player.socketId !== socket.id) return;
    player.online = false; player.lastSeen = Date.now();
    const nextHost = [...ref.room.players.values()].find(p => p.online);
    if (player.isHost && nextHost) setHost(ref.room, nextHost.id);
    broadcast(ref.room);
  });
});

const cleanup = setInterval(() => {
  for (const [code, room] of rooms) {
    removeExpiredPlayers(room);
    if (!room.players.size || Date.now() - room.touchedAt > 30 * 60_000) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 30_000);
cleanup.unref();

if (process.env.NODE_ENV === 'production') {
  const here = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(resolve(here, '../../dist'), { maxAge: '1h', index: false }));
  app.get('*path', (_req, res) => res.sendFile(resolve(here, '../../dist/index.html')));
}

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, '0.0.0.0', () => console.log(`Who's the Impostor? listening on ${port}`));

export { httpServer, io, rooms };
