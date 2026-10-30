import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIo, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import type { ClientAction, PrivatePlayerState, RoomSnapshot } from '../shared/types';

process.env.PORT = '0';
process.env.GAME_TIMING_SCALE = '0.001';

type TestClient = { socket: Socket; room: RoomSnapshot | null; private: PrivatePlayerState | null; token: string; id: string; events: RoomSnapshot[] };
const clients: TestClient[] = [];
let server: typeof import('../server/index.js');
let baseUrl = '';

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(predicate: () => boolean, message: string, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${message}`);
    await delay(5);
  }
}
async function makeClient(): Promise<TestClient> {
  const socket = clientIo(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 1_000 });
  const client: TestClient = { socket, room: null, private: null, token: randomUUID() + randomUUID(), id: '', events: [] };
  socket.on('room', room => { client.room = room; client.events.push(room); });
  socket.on('private', state => { client.private = state; });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  clients.push(client);
  return client;
}
function send(client: TestClient, action: ClientAction) { client.socket.emit('action', action); }
async function create(client: TestClient, name: string) {
  const session = new Promise<{ roomCode: string; token: string; playerId: string }>(resolve => client.socket.once('session', resolve));
  send(client, { type: 'create', name, token: client.token });
  const info = await session; client.token = info.token; client.id = info.playerId;
  return info;
}
async function join(client: TestClient, code: string, name: string) {
  const session = new Promise<{ roomCode: string; token: string; playerId: string }>(resolve => client.socket.once('session', resolve));
  send(client, { type: 'join', code, name, token: client.token });
  const info = await session; client.token = info.token; client.id = info.playerId;
  return info;
}
async function expectError(client: TestClient, action: ClientAction, contains: string) {
  const received = new Promise<{ message: string }>(resolve => client.socket.once('gameError', resolve));
  send(client, action);
  expect((await received).message).toContain(contains);
}

beforeAll(async () => {
  server = await import('../server/index.js');
  await new Promise<void>(resolve => server.httpServer.listening ? resolve() : server.httpServer.once('listening', resolve));
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The test server did not bind a TCP port.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const client of clients) client.socket.disconnect();
  if (server?.io) await new Promise<void>(resolve => server.io.close(() => resolve()));
});

describe('real-time multiplayer game', () => {
  it('keeps three clients in sync through private roles, clues, chat, voting, scoring, and rematch', async () => {
    const [host, playerB, playerC] = await Promise.all([makeClient(), makeClient(), makeClient()]);
    const info = await create(host, 'Maple');
    await Promise.all([join(playerB, info.roomCode, 'Pip'), join(playerC, info.roomCode, 'Moss')]);
    await until(() => [host, playerB, playerC].every(c => c.room?.players.length === 3), 'all three lobby screens update');

    send(host, { type: 'start' });
    await until(() => [host, playerB, playerC].every(c => c.room?.phase === 'clue' && c.private?.role), 'private roles reach each player');
    const privateCards = [host, playerB, playerC].map(c => c.private!);
    expect(privateCards.filter(card => card.role === 'impostor')).toHaveLength(1);
    const word = privateCards.find(card => card.role === 'crew')!.word!;
    expect(privateCards.filter(card => card.role === 'crew').every(card => card.word === word)).toBe(true);
    expect(privateCards.find(card => card.role === 'impostor')!.word).toBeNull();
    for (const client of [host, playerB, playerC]) {
      const cluePhase = client.events.find(event => event.phase === 'clue')!;
      expect(JSON.stringify(cluePhase)).not.toContain(word);
      expect(cluePhase.players.every(player => !('role' in player))).toBe(true);
    }

    for (const [i, client] of [host, playerB, playerC].entries()) send(client, { type: 'clue', text: `mystery clue ${i}` });
    await until(() => [host, playerB, playerC].every(c => c.room?.phase === 'discussion' && c.room.clues.length === 3), 'clues synchronize');
    send(playerB, { type: 'chat', text: 'I have a theory.' });
    await until(() => [host, playerB, playerC].every(c => c.room?.chat.some(m => m.text === 'I have a theory.')), 'chat synchronizes');
    await until(() => [host, playerB, playerC].every(c => c.room?.phase === 'vote'), 'server timer advances to voting');
    const impostorIndex = privateCards.findIndex(card => card.role === 'impostor');
    const players = [host, playerB, playerC];
    const crewIndexes = [0, 1, 2].filter(i => i !== impostorIndex);
    const impostorId = players[impostorIndex].id;
    const crewVoter = players[crewIndexes[0]];
    send(crewVoter, { type: 'vote', targetId: impostorId });
    await until(() => crewVoter.room?.players.find(p => p.id === crewVoter.id)?.hasVoted, 'first vote locks');
    await expectError(crewVoter, { type: 'vote', targetId: impostorId }, 'already locked');
    expect(crewVoter.room?.votes).toHaveLength(0);
    for (const i of crewIndexes.slice(1)) send(players[i], { type: 'vote', targetId: impostorId });
    send(players[impostorIndex], { type: 'vote', targetId: players[crewIndexes[0]].id });
    await until(() => [host, playerB, playerC].every(c => c.room?.phase === 'guess'), 'vote resolves for every screen');
    const wordInServer = server.rooms.get(info.roomCode)!.word!;
    send(players[impostorIndex], { type: 'guess', text: `${wordInServer}!` });
    await until(() => [host, playerB, playerC].every(c => c.room?.phase === 'reveal' && c.room.reveal), 'guess and final reveal sync');
    expect(host.room!.reveal!.caught).toBe(true);
    expect(host.room!.reveal!.guessCorrect).toBe(false);
    expect(host.room!.reveal!.word).toBe(word);
    for (const i of crewIndexes) expect(players[i].room!.players.find(p => p.id === players[i].id)!.score).toBe(3);
    expect(players[impostorIndex].room!.players.find(p => p.id === players[impostorIndex].id)!.score).toBe(0);

    const oldWord = host.room!.reveal!.word;
    send(host, { type: 'rematch' });
    await until(() => [host, playerB, playerC].every(c => c.room?.phase === 'clue' && c.room.round === 2), 'rematch starts');
    const freshWord = [host, playerB, playerC].find(c => c.private?.role === 'crew')!.private!.word;
    expect(freshWord).not.toBe(oldWord);
  }, 10_000);

  it('rejects duplicate nicknames and player 21, and transfers host on disconnect', async () => {
    const host = await makeClient();
    const created = await create(host, 'HostOne');
    const second = await makeClient(); await join(second, created.roomCode, 'Guest01');
    const duplicate = await makeClient(); await expectError(duplicate, { type: 'join', code: created.roomCode, name: 'guest01', token: duplicate.token }, 'already in this room');
    duplicate.socket.disconnect();

    const extra: TestClient[] = [];
    for (let i = 2; i < 20; i++) { const c = await makeClient(); extra.push(c); await join(c, created.roomCode, `Guest${String(i).padStart(2, '0')}`); }
    await until(() => host.room?.players.length === 20 && second.room?.players.length === 20, 'room capacity reaches 20');
    const twentyFirst = await makeClient();
    await expectError(twentyFirst, { type: 'join', code: created.roomCode, name: 'Overflow', token: twentyFirst.token }, '20-player limit');
    twentyFirst.socket.disconnect();

    host.socket.disconnect();
    await until(() => second.room?.players.find(p => p.id === second.id)?.isHost, 'host ownership transfers to an online player');
    expect(second.room!.players.filter(p => p.isHost)).toHaveLength(1);
  }, 10_000);
});
