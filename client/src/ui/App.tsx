import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientAction, PrivatePlayerState, RoomSnapshot } from '../../../shared/types';

const AVATARS = ['🦊', '🐸', '🐼', '🦉', '🐙', '🦝', '🐧', '🐯', '🦋', '🐨', '🐳', '🐰'];
const TOKEN_KEY = 'mystery-club-token';
const ROOM_KEY = 'mystery-club-room';
const NAME_KEY = 'mystery-club-name';
const STAGES = ['clue', 'discussion', 'vote', 'guess', 'reveal', 'match_over'] as const;
const TITLES: Record<string, string> = { lobby: 'The secret meeting', clue: 'Drop a clue', discussion: 'Compare notes', vote: 'Make your pick', guess: 'One last guess', reveal: 'The reveal', match_over: 'Case closed!' };
const INSTRUCTIONS: Record<string, string> = {
  lobby: 'Gather 3–20 players. One player will be bluffing — can your crew spot them?',
  clue: 'Everyone gives one short clue about the secret word. Keep it subtle. The impostor has to blend in!',
  discussion: 'Read the clues, talk it out, and use the room chat. No secret word spoilers!',
  vote: 'Choose one player you think is the impostor. Your vote locks when you send it.',
  guess: 'The crew caught you. Guess the secret word to steal the round!',
  reveal: 'The mystery is solved. Check your points, then play another round.',
  match_over: 'First to 10 points wins. Start a fresh match when your crew is ready.',
};

function avatar(index: number) { return AVATARS[index % AVATARS.length] ?? '🕵️'; }
function makeToken() {
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) return existing;
  const token = crypto.randomUUID() + crypto.randomUUID();
  localStorage.setItem(TOKEN_KEY, token);
  return token;
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [selfId, setSelfId] = useState('');
  const [privateState, setPrivateState] = useState<PrivatePlayerState>({ role: null, word: null, clue: null, vote: null });
  const [name, setName] = useState(localStorage.getItem(NAME_KEY) ?? '');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [clueInput, setClueInput] = useState('');
  const [guessInput, setGuessInput] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const me = room?.players.find(player => player.id === selfId);
  const amHost = !!me?.isHost;
  const sortedPlayers = useMemo(() => room ? [...room.players].sort((a, b) => b.score - a.score) : [], [room]);

  useEffect(() => {
    const socket = io({ autoConnect: false, reconnectionAttempts: Infinity, reconnectionDelay: 500, reconnectionDelayMax: 4_000, timeout: 12_000 });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      const savedRoom = localStorage.getItem(ROOM_KEY);
      const token = localStorage.getItem(TOKEN_KEY);
      if (savedRoom && token) socket.emit('action', { type: 'resume', code: savedRoom, token } satisfies ClientAction);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('room', (next: RoomSnapshot) => setRoom(next));
    socket.on('private', (state: PrivatePlayerState) => setPrivateState(state));
    socket.on('session', (session: { roomCode: string; token: string; playerId: string }) => {
      localStorage.setItem(ROOM_KEY, session.roomCode); localStorage.setItem(TOKEN_KEY, session.token);
      setRoomCode(session.roomCode); setSelfId(session.playerId); setError('');
    });
    socket.on('gameError', (event: { message: string }) => setError(event.message));
    socket.connect();
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(room?.deadline ? Math.max(0, Math.ceil((room.deadline - Date.now()) / 1_000)) : 0), 300);
    return () => window.clearInterval(timer);
  }, [room?.deadline]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [room?.chat.length]);

  const send = (action: ClientAction) => {
    setError('');
    socketRef.current?.emit('action', action);
  };
  const cleanIdentity = () => {
    const clean = name.trim();
    if (!clean) { setError('Choose a nickname first.'); return null; }
    localStorage.setItem(NAME_KEY, clean); setName(clean); return clean;
  };
  const createRoom = () => {
    const nick = cleanIdentity(); if (!nick) return;
    setRoom(null); localStorage.removeItem(ROOM_KEY);
    send({ type: 'create', name: nick, token: makeToken() });
  };
  const joinRoom = () => {
    const nick = cleanIdentity(); if (!nick) return;
    if (roomCode.trim().length !== 6) { setError('Room codes have 6 characters.'); return; }
    localStorage.removeItem(ROOM_KEY);
    send({ type: 'join', code: roomCode, name: nick, token: makeToken() });
  };
  const leaveRoom = () => {
    localStorage.removeItem(ROOM_KEY); setRoom(null); setSelfId(''); setPrivateState({ role: null, word: null, clue: null, vote: null }); setRoomCode('');
    socketRef.current?.disconnect(); socketRef.current?.connect();
  };
  const playChime = () => {
    if (muted) return;
    try { const ctx = new AudioContext(); const oscillator = ctx.createOscillator(); const gain = ctx.createGain(); oscillator.connect(gain); gain.connect(ctx.destination); oscillator.frequency.value = 620; gain.gain.setValueAtTime(.06, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .16); oscillator.start(); oscillator.stop(ctx.currentTime + .16); oscillator.onended = () => void ctx.close(); } catch { /* Sound is optional on unsupported devices. */ }
  };

  if (!room) return <Landing name={name} setName={setName} roomCode={roomCode} setRoomCode={setRoomCode} onCreate={createRoom} onJoin={joinRoom} connected={connected} error={error} onRules={() => setShowRules(true)} showRules={showRules} onCloseRules={() => setShowRules(false)} />;

  const stage = room.phase;
  const progress = STAGES.indexOf(stage as typeof STAGES[number]);
  const voteCount = room.players.filter(player => player.hasVoted).length;
  const clueCount = room.players.filter(player => player.hasClue).length;
  const reveal = room.reveal;

  return <main className="shell game-shell">
    <header className="topbar"><a className="brand" href="#home" onClick={e => { e.preventDefault(); leaveRoom(); }}><span className="brand-mark">✦</span><span>MYSTERY CLUB</span></a><div className={`connection ${connected ? 'online' : ''}`}><span className="connection-dot" />{connected ? 'Connected' : 'Reconnecting…'}</div><button className="icon-button" onClick={() => setMuted(v => !v)} title={muted ? 'Turn sounds on' : 'Mute sounds'} aria-label={muted ? 'Turn sounds on' : 'Mute sounds'}>{muted ? '🔇' : '🔔'}</button><button className="quiet-button rules-button" onClick={() => setShowRules(true)}>How to play</button></header>
    <div className="room-banner"><div><span className="eyebrow">YOUR MYSTERY ROOM</span><div className="room-code-row"><strong className="room-code">{room.code}</strong><button className="copy-button" onClick={() => { void navigator.clipboard?.writeText(room.code); setError('Room code copied!'); window.setTimeout(() => setError(''), 1_800); }}>Copy code</button></div></div><span className="round-chip">ROUND {Math.max(room.round, 0)}</span></div>

    <nav className="phase-track" aria-label="Round progress">{STAGES.filter(item => item !== 'guess').map((item, index) => { const currentStep = progress > 3 ? 3 : progress; const stepIndex = item === 'clue' ? 0 : item === 'discussion' ? 1 : item === 'vote' ? 2 : item === 'reveal' ? 3 : 4; return <div key={item} className={`phase-step ${stage === item || (stage === 'guess' && item === 'vote') ? 'current' : ''} ${currentStep > stepIndex ? 'complete' : ''}`}><span className="phase-dot">{currentStep > stepIndex ? '✓' : stepIndex + 1}</span><span>{item === 'match_over' ? 'Winner' : item === 'reveal' ? 'Reveal' : item === 'discussion' ? 'Discuss' : item === 'clue' ? 'Clue' : 'Vote'}</span></div>; })}</nav>

    <div className="game-grid">
      <section className="main-column">
        <section className={`mission-card phase-${stage}`}>
          <div className="mission-top"><div className="phase-icon">{stage === 'lobby' ? '🕵️' : stage === 'clue' ? '✍️' : stage === 'discussion' ? '💬' : stage === 'vote' ? '🗳️' : stage === 'guess' ? '🎯' : stage === 'match_over' ? '🏆' : '✨'}</div>{room.deadline && <div className="countdown"><span className="countdown-pulse" />{formatTime(seconds)}</div>}</div>
          <span className="eyebrow">{stage === 'lobby' ? 'GET THE CREW TOGETHER' : stage === 'match_over' ? 'MYSTERY SOLVED' : `ROUND ${room.round} · ${stage.toUpperCase()}`}</span>
          <h1>{TITLES[room.phase]}</h1><p>{INSTRUCTIONS[room.phase]}</p>
          {stage === 'lobby' && <div className="lobby-controls">{amHost ? <button className="primary-button" disabled={room.players.length < 3} onClick={() => send({ type: 'start' })}>{room.players.length < 3 ? `Need ${3 - room.players.length} more players` : 'Start the mystery'} <span>→</span></button> : <div className="waiting-note"><span className="sparkle">✦</span>Waiting for {room.players.find(p => p.isHost)?.name ?? 'the host'} to start…</div>}<p className="host-note">{amHost ? 'You’re the host. Share your code and start when 3+ players arrive.' : 'Share the room code with your crew to get started.'}</p></div>}
          {stage === 'clue' && <div className="secret-card"><div className="secret-label"><span>YOUR SECRET CARD</span><span className="card-lock">PRIVATE</span></div>{privateState.role === 'impostor' ? <><strong className="secret-word impostor-word">You’re the impostor <span>😈</span></strong><span className="secret-hint">Your category is <b>{room.wordCategory}</b>. Blend in!</span></> : <><strong className="secret-word">{privateState.word ?? '••••••••'}</strong><span className="secret-hint">Category: <b>{room.wordCategory}</b>. Don’t say the word!</span></>}</div>}
          {stage === 'clue' && <form className="action-form" onSubmit={e => { e.preventDefault(); send({ type: 'clue', text: clueInput }); setClueInput(''); }}><label htmlFor="clue">Your one short clue <span>{privateState.clue ? 'LOCKED IN' : 'UP TO 60 CHARACTERS'}</span></label><div className="form-row"><input id="clue" maxLength={60} placeholder="A hint that proves you know…" value={privateState.clue ?? clueInput} disabled={!!privateState.clue} onChange={e => setClueInput(e.target.value)} /><button className="primary-button compact" disabled={!!privateState.clue || !clueInput.trim()}>{privateState.clue ? 'Submitted ✓' : 'Lock it in'}</button></div><div className="clue-progress">{clueCount} of {room.players.length} clues in</div></form>}
          {stage === 'discussion' && <div className="clue-wall"><div className="section-label">THE CLUE BOARD <span>{room.clues.length} CLUES</span></div><div className="clue-list">{room.clues.map((clue, i) => { const player = room.players.find(p => p.id === clue.playerId); return <div className="clue-note" key={clue.playerId}><span className="avatar tiny">{avatar(player?.avatar ?? i)}</span><div><span className="clue-author">{player?.name ?? 'Player'}</span><p>“{clue.text}”</p></div></div>; })}</div><div className="chat-panel"><div className="section-label">ROOM CHAT <span>BE KIND, BE CLEVER</span></div><div className="chat-messages">{room.chat.filter(message => message.playerId !== 'system').slice(-30).map(message => <div key={message.id} className={`chat-message ${message.playerId === selfId ? 'mine' : ''}`}><span className="chat-name">{message.playerId === selfId ? 'You' : message.name}</span><span>{message.text}</span></div>)}<div ref={chatEnd} /></div><form className="chat-form" onSubmit={e => { e.preventDefault(); if (chatInput.trim()) { send({ type: 'chat', text: chatInput }); setChatInput(''); } }}><input aria-label="Write a chat message" maxLength={180} placeholder="Share your theory…" value={chatInput} onChange={e => setChatInput(e.target.value)} /><button aria-label="Send message">↗</button></form></div></div>}
          {stage === 'vote' && <div className="vote-area"><div className="section-label">WHO’S ACTING SUSPICIOUS? <span>{voteCount}/{room.players.length} VOTES</span></div><div className="vote-grid">{room.players.filter(p => p.id !== selfId).map(player => <button key={player.id} className={`vote-card ${privateState.vote === player.id ? 'selected' : ''}`} disabled={!!privateState.vote} onClick={() => send({ type: 'vote', targetId: player.id })}><span className="avatar">{avatar(player.avatar)}</span><span className="vote-name">{player.name}</span>{privateState.vote === player.id && <span className="vote-check">✓</span>}</button>)}</div>{privateState.vote && <div className="waiting-note vote-wait"><span className="sparkle">✦</span>Your vote is locked. Waiting for the crew…</div>}</div>}
          {stage === 'guess' && <form className="action-form guess-form" onSubmit={e => { e.preventDefault(); if (guessInput.trim()) { send({ type: 'guess', text: guessInput }); setGuessInput(''); } }}><label htmlFor="guess">Your final guess <span>ONE SHOT</span></label><div className="form-row"><input id="guess" maxLength={40} placeholder="What was the secret word?" value={guessInput} onChange={e => setGuessInput(e.target.value)} disabled={privateState.role !== 'impostor'} /><button className="primary-button compact">Make a guess</button></div><p className="guess-help">A correct guess gives the impostor 3 points. No pressure 😅</p></form>}
          {(stage === 'reveal' || stage === 'match_over') && reveal && <RevealCard room={room} reveal={reveal} selfId={selfId} />}
          {stage === 'reveal' && <div className="round-again"><span className="waiting-note"><span className="sparkle">✦</span>{amHost ? 'Ready for another round?' : 'The host can start another round any time.'}</span>{amHost && <button className="primary-button compact" onClick={() => { playChime(); send({ type: 'rematch' }); }}>Next round <span>→</span></button>}</div>}
          {stage === 'match_over' && <div className="round-again"><span className="waiting-note"><span className="sparkle">🏆</span>{amHost ? 'Play another match with this crew?' : 'Waiting for the host to start a new match.'}</span>{amHost && <button className="primary-button compact" onClick={() => send({ type: 'rematch' })}>Play again <span>↻</span></button>}</div>}
          {error && <div className={`inline-message ${error.includes('copied') ? 'success-message' : ''}`} role="status">{error}</div>}
        </section>
        <Leaderboard room={room} players={sortedPlayers} />
      </section>
      <aside className="side-column"><PlayerList room={room} selfId={selfId} /><RecentActivity room={room} /></aside>
    </div>
    <footer className="site-footer"><span>Made for a good mystery & a great group chat.</span><button className="footer-link" onClick={() => setShowRules(true)}>Rules & scoring</button><span>Rooms support 3–20 players</span></footer>
    {showRules && <RulesModal onClose={() => setShowRules(false)} />}
  </main>;
}

function Landing({ name, setName, roomCode, setRoomCode, onCreate, onJoin, connected, error, onRules, showRules, onCloseRules }: { name: string; setName: (v: string) => void; roomCode: string; setRoomCode: (v: string) => void; onCreate: () => void; onJoin: () => void; connected: boolean; error: string; onRules: () => void; showRules: boolean; onCloseRules: () => void }) {
  return <main className="shell landing-shell"><header className="topbar"><a className="brand" href="#top"><span className="brand-mark">✦</span><span>MYSTERY CLUB</span></a><div className={`connection ${connected ? 'online' : ''}`}><span className="connection-dot" />{connected ? 'Ready to play' : 'Connecting…'}</div><button className="quiet-button" onClick={onRules}>How to play</button></header>
    <section className="hero-grid"><div className="hero-copy"><div className="game-pill"><span className="live-dot" /> A REAL-TIME PARTY GAME <span className="pill-sparkle">✧</span></div><h1>One word.<br /><em>One liar.</em><br />Can you catch them?</h1><p className="hero-description">Drop clues, read the room, and unmask the impostor before they fool your whole crew.</p><div className="hero-social"><div className="avatar-stack"><span>🦊</span><span>🐸</span><span>🐼</span><span>🦉</span></div><span>3–20 friends · one room code</span></div></div><div className="hero-art" aria-label="Cartoon detective magnifying glass illustration"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="spotlight"><span>✦</span></div><div className="detective-card"><span className="art-corner top-left"/><span className="art-corner top-right"/><span className="art-corner bottom-left"/><span className="art-corner bottom-right"/><span className="detective-emoji">🕵️</span><span className="detective-label">WHO’S THE IMPOSTOR?</span><span className="tiny-stars">✦ &nbsp; ✧ &nbsp; ✦</span></div><div className="clue-bubble bubble-one">“Sounds fishy…”</div><div className="clue-bubble bubble-two">👀</div><div className="hero-stamp">CASE<br /><b>OPEN</b></div></div></section>
    <section className="join-panel"><div className="join-heading"><span className="eyebrow">YOUR SEAT AT THE TABLE</span><h2>Ready to investigate?</h2><p>Pick a nickname, then start a room or join your crew.</p></div><div className="join-fields"><label className="field-wrap"><span>YOUR NICKNAME</span><input aria-label="Your nickname" maxLength={16} placeholder="e.g. SneakyFox" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onCreate(); }} /></label><label className="field-wrap code-field"><span>ROOM CODE <small>IF YOU HAVE ONE</small></span><input aria-label="Room code" maxLength={6} placeholder="ABC123" value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={e => { if (e.key === 'Enter') onJoin(); }} /></label></div><div className="join-actions"><button className="primary-button" onClick={onCreate}>Create a room <span>→</span></button><button className="outline-button" onClick={onJoin}>Join a room</button></div>{error && <div className="inline-message" role="status">{error}</div>}<div className="privacy-note"><span>🔒</span> No account, no downloads — just your crew and a good mystery.</div></section>
    <section className="how-it-works"><div className="eyebrow">EASY TO LEARN, FUN TO BLUFF</div><div className="steps-row"><div className="how-step"><span className="step-emoji">🗝️</span><div><b>Get your secret</b><p>Everyone gets a word. Except the impostor.</p></div></div><span className="step-arrow">→</span><div className="how-step"><span className="step-emoji">💬</span><div><b>Drop a clue</b><p>One hint each, then talk through the mystery.</p></div></div><span className="step-arrow">→</span><div className="how-step"><span className="step-emoji">🕵️</span><div><b>Find the liar</b><p>Vote, reveal, and see who fooled the crew.</p></div></div></div></section>
    <footer className="site-footer"><span>A little mystery goes a long way.</span><button className="footer-link" onClick={onRules}>Full rules & scoring</button><span>Made for 3–20 players</span></footer>{showRules && <RulesModal onClose={onCloseRules} />}
  </main>;
}

function PlayerList({ room, selfId }: { room: RoomSnapshot; selfId: string }) {
  return <section className="panel players-panel"><div className="panel-heading"><div><span className="eyebrow">THE CREW</span><h2>Players <span className="player-count">{room.players.length}<span>/{room.maxPlayers}</span></span></h2></div><span className="crew-icon">👥</span></div><div className="player-list">{room.players.map(player => <div className="player-row" key={player.id}><span className="avatar">{avatar(player.avatar)}</span><span className="player-nick">{player.name}{player.id === selfId && <small>YOU</small>}</span>{player.isHost && <span className="host-tag">HOST</span>}<span className={`status-dot ${player.online ? 'is-online' : ''}`} title={player.online ? 'Online' : 'Reconnecting'} />{room.phase === 'clue' && <span className={`ready-indicator ${player.hasClue ? 'ready' : ''}`} title={player.hasClue ? 'Clue submitted' : 'Writing a clue'}>{player.hasClue ? '✓' : '·'}</span>}{room.phase === 'vote' && <span className={`ready-indicator ${player.hasVoted ? 'ready' : ''}`} title={player.hasVoted ? 'Vote submitted' : 'Thinking'}>{player.hasVoted ? '✓' : '·'}</span>}</div>)}</div>{room.phase === 'lobby' && <div className="invite-box"><span>INVITE YOUR CREW</span><button onClick={() => void navigator.clipboard?.writeText(room.code)}>Copy room code <span>↗</span></button></div>}</section>;
}

function Leaderboard({ room, players }: { room: RoomSnapshot; players: RoomSnapshot['players'] }) {
  return <section className="panel leaderboard"><div className="panel-heading"><div><span className="eyebrow">THE SCOREBOARD</span><h2>Leaderboard</h2></div><span className="score-target">FIRST TO 10 WINS</span></div><div className="leaderboard-head"><span>PLAYER</span><span>POINTS</span></div>{players.map((player, index) => <div className={`leader-row ${index === 0 && player.score > 0 ? 'leading' : ''}`} key={player.id}><span className="rank">{player.score > 0 && index === 0 ? '👑' : String(index + 1).padStart(2, '0')}</span><span className="avatar small">{avatar(player.avatar)}</span><span className="leader-name">{player.name}</span><div className="score-track"><span style={{ width: `${Math.min(100, player.score * 10)}%` }} /></div><strong className="score-value">{player.score}</strong></div>)}{!room.players.length && <div className="empty-state">Your crew’s score will show up here.</div>}<div className="score-footnote">Correct vote <b>+1</b> · Catch the impostor <b>+2</b> for the crew · Escape <b>+2</b> · Correct secret-word guess <b>+3</b></div></section>;
}

function RecentActivity({ room }: { room: RoomSnapshot }) {
  const messages = room.chat.filter(message => message.system).slice(-4).reverse();
  return <section className="panel activity-panel"><div className="eyebrow">CASE NOTES</div><div className="activity-list">{messages.length ? messages.map(message => <div className="activity-row" key={message.id}><span>✦</span><p>{message.text}</p></div>) : <p className="empty-state">Room updates appear here.</p>}</div><div className="phase-legend"><span><i className="legend-dot clue-dot"/> clues</span><span><i className="legend-dot vote-dot"/> votes</span><span><i className="legend-dot reveal-dot"/> reveal</span></div></section>;
}

function RevealCard({ room, reveal, selfId }: { room: RoomSnapshot; reveal: NonNullable<RoomSnapshot['reveal']>; selfId: string }) {
  const impostor = room.players.find(player => player.id === reveal.impostorId);
  const didWin = reveal.winners.includes(selfId);
  return <div className={`reveal-box ${didWin ? 'win' : 'lose'}`}><div className="reveal-kicker">{reveal.tied ? 'THE CREW COULDN’T AGREE' : reveal.caught ? 'UNMASKED!' : 'THE IMPOSTOR ESCAPED'}</div><div className="reveal-word-row"><div><span className="reveal-label">THE SECRET WORD</span><strong className="revealed-word">{reveal.word}</strong></div><div className="reveal-vs">← ? →</div><div><span className="reveal-label">THE IMPOSTOR</span><strong className="revealed-player"><span>{avatar(impostor?.avatar ?? 0)}</span>{impostor?.name ?? 'Unknown'}</strong></div></div>{reveal.caught && <div className={`guess-result ${reveal.guessCorrect ? 'correct' : ''}`}>{reveal.guess ? <>Their guess: <b>“{reveal.guess}”</b> {reveal.guessCorrect ? '· Got it!' : '· Not quite!'}</> : 'They ran out of time to guess.'}</div>}<div className="result-banner">{didWin ? '🎉 Your side wins this round!' : reveal.caught && !reveal.guessCorrect ? '🕵️ The crew takes this round.' : '🕵️ The impostor takes this round.'}</div></div>;
}

function RulesModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-scrim" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-heading"><button className="modal-close" onClick={onClose} aria-label="Close rules">×</button><span className="eyebrow">THE CASE FILE</span><h2 id="rules-heading">How to play</h2><p>One player is the impostor. Everyone else gets the same secret word and category.</p><ol><li><b>Clue up.</b> Give one short clue about the word. The impostor sees the category and must bluff.</li><li><b>Discuss.</b> Read the clue board, chat with the crew, and spot anything suspicious.</li><li><b>Vote.</b> Pick one player. Votes lock when submitted. A tie means the impostor escapes.</li><li><b>Reveal.</b> If caught, the impostor gets one guess to steal the round.</li></ol><div className="rules-scoring"><h3>Scoring · first to 10 wins</h3><p>Crew: +1 for voting for the impostor; +2 each when the impostor is caught.</p><p>Impostor: +2 for escaping; +3 for a correct secret-word guess after being caught.</p></div><button className="primary-button modal-done" onClick={onClose}>Got it <span>✓</span></button></section></div>;
}

function formatTime(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
