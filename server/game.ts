import { randomInt, randomUUID } from 'node:crypto';
import type { ChatMessage, Phase, PrivatePlayerState, PublicClue, RoomSnapshot } from '../shared/types.js';

export type Player = {
  id: string; token: string; name: string; avatar: number; score: number; online: boolean; isHost: boolean;
  socketId: string; lastSeen: number; role: 'crew' | 'impostor' | null; clue: string | null; vote: string | null;
};
export type Reveal = NonNullable<RoomSnapshot['reveal']>;
export type Room = {
  code: string; players: Map<string, Player>; phase: Phase; word: string | null; category: string | null;
  previousWord: string | null; round: number; deadline: number | null; clues: PublicClue[]; chat: ChatMessage[]; reveal: Reveal | null;
  winnerIds: string[]; timer: ReturnType<typeof setTimeout> | null; touchedAt: number;
};

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 20;
export const SCORE_TO_WIN = 10;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WORDS: Record<string, string[]> = {
  'Food & drink': ['Pancakes', 'Watermelon', 'Popcorn', 'Sushi', 'Lemonade', 'Cupcake', 'Tacos', 'Hot chocolate', 'Pretzel', 'Mango'],
  'Places & things': ['Aquarium', 'Roller coaster', 'Treehouse', 'Lighthouse', 'Snow globe', 'Skateboard', 'Planetarium', 'Campfire', 'Telescope', 'Waterfall'],
  'Animals & nature': ['Penguin', 'Octopus', 'Chameleon', 'Hummingbird', 'Jellyfish', 'Pinecone', 'Butterfly', 'Koala', 'Cactus', 'Dolphin'],
};
const CATEGORIES = Object.keys(WORDS);
let onRoomChange: ((room: Room) => void) | null = null;
export function setRoomChangeHandler(handler: (room: Room) => void): void { onRoomChange = handler; }

export function createRoom(name: string, token: string, socketId: string): Room {
  const code = makeCode();
  const now = Date.now();
  const host: Player = { id: randomUUID(), token, name: cleanName(name), avatar: randomInt(0, 12), score: 0, online: true, isHost: true, socketId, lastSeen: now, role: null, clue: null, vote: null };
  const room: Room = { code, players: new Map([[host.id, host]]), phase: 'lobby', word: null, category: null, previousWord: null, round: 0, deadline: null, clues: [], chat: [], reveal: null, winnerIds: [], timer: null, touchedAt: now };
  system(room, `${host.name} opened the mystery room.`);
  return room;
}

export function makeCode(occupied: (code: string) => boolean = () => false): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!occupied(code)) return code;
  }
  throw new Error('Could not reserve a room code. Try again.');
}

export function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a nickname to play.');
  const name = value.trim().replace(/\s+/g, '');
  if (!name || name.length > 16 || !/^[\p{L}\p{N}_-]+$/u.test(name)) throw new Error('Use 1–16 letters, numbers, _ or - for your nickname.');
  return name;
}

export function addPlayer(room: Room, name: string, token: string, socketId: string): Player {
  if (room.phase !== 'lobby' && room.phase !== 'reveal' && room.phase !== 'match_over') throw new Error('This round is already underway.');
  if (room.players.size >= MAX_PLAYERS) throw new Error('This room has reached its 20-player limit.');
  const normalized = cleanName(name).toLocaleLowerCase();
  const collision = [...room.players.values()].find(p => p.name.toLocaleLowerCase() === normalized && p.token !== token);
  if (collision) throw new Error('That nickname is already in this room. Try another.');
  const existing = [...room.players.values()].find(p => p.token === token);
  if (existing) {
    existing.online = true; existing.socketId = socketId; existing.lastSeen = Date.now();
    room.touchedAt = Date.now(); return existing;
  }
  const player: Player = { id: randomUUID(), token, name: cleanName(name), avatar: randomInt(0, 12), score: 0, online: true, isHost: false, socketId, lastSeen: Date.now(), role: null, clue: null, vote: null };
  room.players.set(player.id, player);
  room.touchedAt = Date.now(); system(room, `${player.name} joined the room.`);
  return player;
}

export function reconnect(room: Room, token: string, socketId: string): Player {
  const player = [...room.players.values()].find(p => p.token === token);
  if (!player) throw new Error('Your seat could not be found. Ask the host to invite you again.');
  player.online = true; player.socketId = socketId; player.lastSeen = Date.now(); room.touchedAt = Date.now();
  return player;
}

export function startRound(room: Room, resetScores = false): void {
  if (room.players.size < MIN_PLAYERS) throw new Error('At least 3 players are needed to start.');
  if (room.phase !== 'lobby' && room.phase !== 'reveal' && room.phase !== 'match_over') throw new Error('This round is already in progress.');
  if (resetScores) for (const player of room.players.values()) player.score = 0;
  const players = [...room.players.values()];
  const impostor = players[randomInt(players.length)];
  const category = CATEGORIES[randomInt(CATEGORIES.length)];
  const options = WORDS[category];
  let word = options[randomInt(options.length)];
  if (word === room.previousWord) word = options[(options.indexOf(word) + 1) % options.length];
  room.word = word;
  room.previousWord = word;
  room.category = category;
  room.round++;
  room.phase = 'clue'; room.deadline = Date.now() + 60_000; room.clues = []; room.reveal = null; room.winnerIds = [];
  for (const player of players) { player.role = player.id === impostor.id ? 'impostor' : 'crew'; player.clue = null; player.vote = null; }
  system(room, `Round ${room.round} is on! Check your secret card.`);
  schedule(room, 60_000, () => beginDiscussion(room));
}

export function submitClue(room: Room, player: Player, text: unknown): void {
  requirePhase(room, 'clue');
  if (player.clue !== null) throw new Error('Your clue is already locked in.');
  const clue = cleanText(text, 60, 'Keep your clue between 1 and 60 characters.');
  player.clue = clue;
  room.clues.push({ playerId: player.id, text: clue });
  if ([...room.players.values()].every(p => p.clue !== null)) beginDiscussion(room);
}

export function postChat(room: Room, player: Player, text: unknown): void {
  if (!['discussion', 'clue'].includes(room.phase)) throw new Error('Chat opens during clue time and discussion.');
  if (room.chat.filter(m => !m.system && m.playerId === player.id && Date.now() - m.at < 10_000).length >= 5) throw new Error('Slow down for a moment before sending another message.');
  room.chat.push({ id: randomUUID(), playerId: player.id, name: player.name, text: cleanText(text, 180, 'Chat messages can be up to 180 characters.'), at: Date.now() });
  room.chat = room.chat.slice(-100);
}

export function submitVote(room: Room, player: Player, targetId: unknown): void {
  requirePhase(room, 'vote');
  if (player.vote !== null) throw new Error('Your vote is already locked in.');
  if (typeof targetId !== 'string' || targetId === player.id || !room.players.has(targetId)) throw new Error('Choose another player to vote for.');
  player.vote = targetId;
  if ([...room.players.values()].every(p => p.vote !== null)) resolveVotes(room);
}

export function submitGuess(room: Room, player: Player, text: unknown): void {
  requirePhase(room, 'guess');
  if (player.role !== 'impostor') throw new Error('Only the impostor can guess the word.');
  finishRound(room, cleanText(text, 40, 'Keep your guess under 40 characters.'));
}

export function resolveVotes(room: Room): void {
  if (room.phase !== 'vote') return;
  clearTimer(room);
  const counts = new Map<string, number>();
  for (const p of room.players.values()) if (p.vote) counts.set(p.vote, (counts.get(p.vote) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  const top = [...counts.entries()].filter(([, count]) => count === max && max > 0).map(([id]) => id);
  const impostor = [...room.players.values()].find(p => p.role === 'impostor');
  const caught = !!impostor && top.length === 1 && top[0] === impostor.id;
  const tied = top.length > 1;
  const guessDeadline = caught ? Date.now() + 25_000 : null;
  room.reveal = { impostorId: impostor?.id ?? '', word: room.word ?? '', caught, guess: null, guessCorrect: null, winners: [], tied };
  room.deadline = guessDeadline;
  if (caught) {
    room.phase = 'guess'; system(room, `${impostor?.name} was caught! They have one guess.`);
    schedule(room, 25_000, () => finishRound(room, null));
  } else {
    room.phase = 'reveal'; settleScores(room, false, false); system(room, tied ? 'The vote was tied. The impostor got away!' : 'The impostor got away!');
    schedule(room, 4_000, () => finishReveal(room));
  }
}

export function finishRound(room: Room, guess: string | null): void {
  if (room.phase !== 'guess' || !room.reveal) return;
  clearTimer(room);
  const correct = typeof guess === 'string' && guess.trim().toLocaleLowerCase() === room.reveal.word.toLocaleLowerCase();
  room.reveal.guess = guess;
  room.reveal.guessCorrect = correct;
  room.phase = 'reveal'; room.deadline = null;
  settleScores(room, true, correct);
  system(room, correct ? 'The impostor guessed the word and stole the win!' : 'The crew caught the impostor!');
  schedule(room, 4_000, () => finishReveal(room));
}

export function snapshot(room: Room): RoomSnapshot {
  const reveal = room.reveal && ['reveal', 'match_over'].includes(room.phase) ? room.reveal : null;
  return {
    code: room.code, phase: room.phase,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, online: p.online, score: p.score, isHost: p.id === hostOf(room)?.id, hasClue: p.clue !== null, hasVoted: p.vote !== null })),
    clues: room.phase === 'clue' ? [] : room.clues,
    chat: room.chat.slice(-100), votes: ['reveal', 'match_over'].includes(room.phase) ? [...room.players.values()].filter(p => p.vote).map(p => ({ voterId: p.id, targetId: p.vote! })) : [],
    deadline: room.deadline, round: room.round, maxPlayers: MAX_PLAYERS, wordCategory: room.phase === 'lobby' ? null : room.category,
    reveal: reveal ? { ...reveal } : null,
    matchWinnerIds: room.phase === 'match_over' ? room.winnerIds : [],
  };
}

export function privateState(room: Room, player: Player): PrivatePlayerState {
  return { role: player.role, word: player.role === 'crew' ? room.word : null, clue: player.clue, vote: player.vote };
}

export function hostOf(room: Room): Player | undefined { return [...room.players.values()].find(p => p.isHost && p.online) ?? [...room.players.values()].find(p => p.isHost) ?? room.players.values().next().value; }
export function setHost(room: Room, playerId: string): void {
  const selected = room.players.get(playerId);
  if (!selected) return;
  for (const player of room.players.values()) player.isHost = player.id === playerId;
}

export function removeExpiredPlayers(room: Room, maxAge = 120_000): void {
  const now = Date.now();
  for (const player of room.players.values()) if (!player.online && now - player.lastSeen > maxAge) {
    room.players.delete(player.id);
    room.clues = room.clues.filter(c => c.playerId !== player.id);
  }
  if (!room.players.size) { clearTimer(room); room.touchedAt = 0; }
}

function beginDiscussion(room: Room): void {
  if (room.phase !== 'clue') return;
  clearTimer(room); room.phase = 'discussion'; room.deadline = Date.now() + 45_000;
  system(room, 'All clues are in. Discuss what feels suspicious!');
  schedule(room, 45_000, () => beginVoting(room));
}
function beginVoting(room: Room): void {
  if (room.phase !== 'discussion') return;
  clearTimer(room); room.phase = 'vote'; room.deadline = Date.now() + 45_000;
  for (const p of room.players.values()) p.vote = null;
  system(room, 'Time to vote. Choose carefully!');
  schedule(room, 45_000, () => resolveVotes(room));
}
function finishReveal(room: Room): void {
  if (room.phase !== 'reveal') return;
  clearTimer(room);
  const maxScore = Math.max(0, ...[...room.players.values()].map(p => p.score));
  if (maxScore >= SCORE_TO_WIN) {
    room.phase = 'match_over'; room.winnerIds = [...room.players.values()].filter(p => p.score === maxScore).map(p => p.id);
    system(room, `Match over! ${room.winnerIds.length > 1 ? 'A shared victory!' : `${room.players.get(room.winnerIds[0])?.name} wins!`}`);
  } else {
    room.phase = 'reveal'; room.deadline = null;
  }
}
function settleScores(room: Room, wasCaught: boolean, guessCorrect: boolean): void {
  const impostor = [...room.players.values()].find(p => p.role === 'impostor');
  if (!impostor) return;
  const voteCounts = new Map<string, number>();
  for (const p of room.players.values()) if (p.vote) voteCounts.set(p.vote, (voteCounts.get(p.vote) ?? 0) + 1);
  const max = Math.max(0, ...voteCounts.values());
  const top = [...voteCounts.entries()].filter(([, count]) => count === max && max > 0).map(([id]) => id);
  const caught = wasCaught && room.reveal?.caught === true;
  for (const p of room.players.values()) {
    if (p.role === 'impostor') p.score += caught ? (guessCorrect ? 3 : 0) : 2;
    else if (caught) { p.score += 2; if (p.vote === impostor.id) p.score += 1; }
    else if (p.vote && top.length === 1 && top[0] === impostor.id) p.score += 1;
  }
  room.reveal!.winners = caught && !guessCorrect
    ? [...room.players.values()].filter(p => p.role === 'crew').map(p => p.id)
    : [impostor.id];
}
function schedule(room: Room, ms: number, action: () => void): void {
  clearTimer(room);
  const scale = Math.max(0.001, Math.min(1, Number(process.env.GAME_TIMING_SCALE ?? 1)));
  room.timer = setTimeout(() => { action(); onRoomChange?.(room); }, ms * scale);
}
function clearTimer(room: Room): void { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function requirePhase(room: Room, phase: Phase): void { if (room.phase !== phase) throw new Error(`That move is only available during ${phase}.`); }
function cleanText(value: unknown, max: number, error: string): string {
  if (typeof value !== 'string') throw new Error(error);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > max) throw new Error(error);
  return text;
}
function system(room: Room, text: string): void { room.chat.push({ id: randomUUID(), playerId: 'system', name: 'Mystery host', text, at: Date.now(), system: true }); room.chat = room.chat.slice(-100); }
