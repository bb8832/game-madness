import { get, put } from '@vercel/blob';
import { createHash, randomBytes } from 'node:crypto';

const KEY = 'game-madness/state.json';
const MAX_PER_PERSON = 3;
const MAX_GAMES = 32;

const fresh = () => ({ phase: 'submit', deadline: null, hostHash: null, ideas: [], games: [], bracketId: null, ballots: {} });
const sha = s => createHash('sha256').update(String(s)).digest('hex');
const rid = () => randomBytes(5).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function phaseOf(st) {
  if (st.phase === 'vote' && st.deadline && new Date(st.deadline) <= new Date()) return 'closed';
  return st.phase;
}

// Replays a ballot through the bracket. Returns the champion if the votes form a complete, valid bracket.
function walk(ids, votes) {
  let size = 1; while (size < ids.length) size *= 2;
  const half = size / 2; let round = [];
  for (let i = 0; i < half; i++) round.push([ids[i] ?? null, ids[half + i] ?? null]);
  const q = [...votes];
  while (true) {
    const wins = [];
    for (const [a, b] of round) {
      if (!(a && b)) { wins.push(a || b); continue; }
      const v = q.shift();
      if (v !== a && v !== b) return null;
      wins.push(v);
    }
    if (wins.length === 1) return q.length ? null : wins[0];
    round = [];
    for (let i = 0; i < wins.length; i += 2) round.push([wins[i], wins[i + 1]]);
  }
}

async function load() {
  let r;
  try { r = await get(KEY, { access: 'private', useCache: false }); }
  catch (e) { if (/not.?found/i.test(e?.name + ' ' + e?.message)) return { st: fresh(), etag: null }; throw e; }
  if (!r || r.statusCode !== 200) return { st: fresh(), etag: null };
  const text = await new Response(r.stream).text();
  return { st: { ...fresh(), ...JSON.parse(text) }, etag: r.blob.etag };
}

async function mutate(fn) {
  for (let i = 0; i < 8; i++) {
    const { st, etag } = await load();
    const err = fn(st);
    if (err) return { error: err, st };
    try {
      await put(KEY, JSON.stringify(st), {
        access: 'private', allowOverwrite: true, addRandomSuffix: false,
        contentType: 'application/json', ...(etag ? { ifMatch: etag } : {}),
      });
      return { st };
    } catch (e) {
      if (/precondition/i.test(e?.name + ' ' + e?.message)) { await sleep(40 + Math.random() * 250); continue; }
      throw e;
    }
  }
  return { error: 'Lots of people are voting at once. Try again in a second.' };
}

function tally(st) {
  const t = {};
  for (const g of st.games) t[g.id] = { id: g.id, name: g.name, votes: 0, champs: 0 };
  let ballots = 0;
  for (const b of Object.values(st.ballots)) {
    if (b.bracket !== st.bracketId) continue;
    ballots++;
    for (const id of b.votes) if (t[id]) t[id].votes++;
    if (t[b.champion]) t[b.champion].champs++;
  }
  const list = Object.values(t).sort((a, b) => b.votes - a.votes || b.champs - a.champs || a.name.localeCompare(b.name));
  return { list, ballots };
}

function view(st, voter, isHost) {
  const phase = phaseOf(st);
  const { list, ballots } = tally(st);
  const mine = st.ballots[voter];
  return {
    phase, deadline: st.deadline, bracketId: st.bracketId, games: st.games,
    hostClaimed: !!st.hostHash, isHost,
    ideas: st.ideas.map(i => ({ id: i.id, name: i.name, pitch: i.pitch, author: i.author, mine: i.by === voter })),
    myBallot: mine && mine.bracket === st.bracketId ? { votes: mine.votes, champion: mine.champion } : null,
    ballots,
    results: phase === 'closed' || isHost ? list : null,
    now: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const voter = clean(req.headers['x-voter'], 40);
  const hostPass = String(req.headers['x-host'] || '');
  if (!/^[a-z0-9]{12,40}$/i.test(voter)) return res.status(400).json({ error: 'Reload the page and try again.' });

  try {
    if (req.method === 'GET') {
      const { st } = await load();
      const isHost = !!st.hostHash && !!hostPass && sha(hostPass) === st.hostHash;
      return res.status(200).json(view(st, voter, isHost));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const a = body.action;
    let isHost = false;

    const out = await mutate(st => {
      isHost = !!st.hostHash && !!hostPass && sha(hostPass) === st.hostHash;
      const phase = phaseOf(st);
      const needHost = () => (isHost ? null : 'Only the host can do that.');
      const futureDeadline = () => {
        const d = new Date(body.deadline);
        if (isNaN(d)) return 'Pick an end time.';
        if (d <= new Date()) return 'Pick an end time in the future.';
        st.deadline = d.toISOString(); return null;
      };

      switch (a) {
        case 'claimHost': {
          if (st.hostHash) return 'This bracket already has a host.';
          const p = String(body.pass || '');
          if (p.length < 6) return 'Use a passcode with at least 6 characters.';
          st.hostHash = sha(p); isHost = true; return null;
        }
        case 'pitch': {
          if (phase !== 'submit') return 'Pitches are closed.';
          const name = clean(body.name, 60), pitch = clean(body.pitch, 140), author = clean(body.author, 30);
          if (!name) return 'Give your game a name.';
          if (st.ideas.filter(i => i.by === voter).length >= MAX_PER_PERSON) return `You can pitch up to ${MAX_PER_PERSON} games.`;
          if (st.ideas.length >= MAX_GAMES) return `The bracket is full at ${MAX_GAMES} games.`;
          if (st.ideas.some(i => i.name.toLowerCase() === name.toLowerCase())) return `"${name}" is already in the list.`;
          st.ideas.push({ id: rid(), name, pitch, author, by: voter, at: Date.now() }); return null;
        }
        case 'unpitch': {
          if (phase !== 'submit') return 'Pitches are locked.';
          const idea = st.ideas.find(i => i.id === body.id);
          if (!idea) return null;
          if (idea.by !== voter && !isHost) return 'You can only remove your own pitch.';
          st.ideas = st.ideas.filter(i => i.id !== body.id); return null;
        }
        case 'ballot': {
          if (phase !== 'vote') return phase === 'closed' ? 'Voting is closed.' : 'Voting has not started yet.';
          if (body.bracketId !== st.bracketId) return 'The bracket changed. Reload and fill it in again.';
          const votes = Array.isArray(body.votes) ? body.votes.map(String) : [];
          const champ = walk(st.games.map(g => g.id), votes);
          if (!champ) return 'That bracket is incomplete. Reload and try again.';
          st.ballots[voter] = { bracket: st.bracketId, votes, champion: champ, at: Date.now() }; return null;
        }
        case 'deadline': return needHost() || futureDeadline();
        case 'lock': {
          const e = needHost() || (phase !== 'submit' ? 'Voting already started.' : null) || (st.ideas.length < 2 ? 'Needs at least 2 games.' : null) || futureDeadline();
          if (e) return e;
          const g = st.ideas.map(({ id, name, pitch }) => ({ id, name, pitch }));
          for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; }
          st.games = g; st.bracketId = rid(); st.ballots = {}; st.phase = 'vote'; return null;
        }
        case 'close': { const e = needHost(); if (e) return e; st.phase = 'closed'; return null; }
        case 'reopenVote': {
          const e = needHost() || (!st.games.length ? 'There is no bracket yet.' : null) || futureDeadline();
          if (e) return e; st.phase = 'vote'; return null;
        }
        case 'reopenPitch': {
          const e = needHost(); if (e) return e;
          st.phase = 'submit'; st.games = []; st.bracketId = null; st.ballots = {}; return null;
        }
        default: return 'Unknown action.';
      }
    });

    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(200).json(view(out.st, voter, isHost));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Couldn't reach the vote storage. Try again in a moment." });
  }
}
