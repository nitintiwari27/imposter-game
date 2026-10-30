export type Phase = 'lobby' | 'clue' | 'discussion' | 'vote' | 'guess' | 'reveal' | 'match_over';

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: number;
  online: boolean;
  score: number;
  isHost: boolean;
  hasClue: boolean;
  hasVoted: boolean;
}

export interface PublicClue { playerId: string; text: string }
export interface ChatMessage { id: string; playerId: string; name: string; text: string; at: number; system?: boolean }
export interface PublicVote { voterId: string; targetId: string }

export interface RoomSnapshot {
  code: string;
  phase: Phase;
  players: PublicPlayer[];
  clues: PublicClue[];
  chat: ChatMessage[];
  votes: PublicVote[];
  deadline: number | null;
  round: number;
  maxPlayers: number;
  wordCategory: string | null;
  reveal: null | { impostorId: string; word: string; caught: boolean; guess: string | null; guessCorrect: boolean | null; winners: string[]; tied: boolean };
  matchWinnerIds: string[];
}

export interface PrivatePlayerState { role: 'crew' | 'impostor' | null; word: string | null; clue: string | null; vote: string | null }

export type ClientAction =
  | { type: 'create'; name: string; token: string }
  | { type: 'join'; code: string; name: string; token: string }
  | { type: 'resume'; code: string; token: string }
  | { type: 'start' }
  | { type: 'clue'; text: string }
  | { type: 'chat'; text: string }
  | { type: 'vote'; targetId: string }
  | { type: 'guess'; text: string }
  | { type: 'rematch' };
