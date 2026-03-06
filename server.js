'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const nifs = require('./src/nifs');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, '.cache');

// Ensure cache directory exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Cache helpers ────────────────────────────────────────────────────────────

function cachePath(key) {
  return path.join(CACHE_DIR, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function readCache(key, maxAgeMs) {
  const p = cachePath(key);
  if (!fs.existsSync(p)) return null;
  const age = Date.now() - fs.statSync(p).mtimeMs;
  if (age > maxAgeMs) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  fs.writeFileSync(cachePath(key), JSON.stringify(data));
}

// Wrap a NIFS call with file-based caching.
async function cached(key, maxAgeMs, fn) {
  const hit = readCache(key, maxAgeMs);
  if (hit !== null) return hit;
  const data = await fn();
  writeCache(key, data);
  return data;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── Timeline builder ────────────────────────────────────────────────────────

/**
 * Determine whether a match's result is available (i.e. the match is finished).
 */
function isCompleted(match) {
  // matchStatusId 6 = fullTime in NIFS
  if (match.matchStatusId !== undefined) return match.matchStatusId === 6;
  const hs = match.result;
  return hs && hs.homeScore90 !== null && hs.homeScore90 !== undefined;
}

/**
 * Extract goal incidents from raw incidents array.
 * Returns [{minute, isOwnGoal, teamId}]
 */
function extractGoals(incidents, homeTeamId, awayTeamId) {
  if (!Array.isArray(incidents)) return [];
  return incidents
    .filter((inc) => {
      const t = String(inc.incidentTypeId ?? inc.type ?? '');
      // NIFS incident type IDs: 1 = goal, 2 = own goal, others = cards/subs
      return t === '1' || t === '2' || t === 'goal' || t === 'ownGoal';
    })
    .map((inc) => {
      const minute = parseInt(inc.minute ?? inc.elapsedTime ?? 0, 10);
      const isOwnGoal =
        String(inc.incidentTypeId ?? inc.type ?? '') === '2' ||
        String(inc.type ?? '').toLowerCase().includes('own');
      // For own goals, the scoring team is the opponent of the team committing it
      const rawTeamId = inc.teamId ?? inc.team?.id;
      let teamId;
      if (isOwnGoal) {
        teamId = rawTeamId === homeTeamId ? awayTeamId : homeTeamId;
      } else {
        teamId = rawTeamId;
      }
      return { minute, isOwnGoal, teamId };
    })
    .filter((g) => g.minute >= 0 && g.minute <= 150)
    .sort((a, b) => a.minute - b.minute);
}

/**
 * Build the full timeline data structure from an array of enriched matches.
 *
 * Each match must have a `.incidents` property (array, may be empty).
 *
 * Returns:
 * {
 *   teams: [{id, name, shortName}],
 *   matches: [{id, homeTeamId, awayTeamId, timestamp, round,
 *              homeScore90, awayScore90, goals:[{minute,teamId}]}],
 *   groups: [{matchIds:[]}]   // matches grouped by concurrency
 * }
 */
function buildTimeline(enrichedMatches) {
  // Only keep completed matches with a known start time
  const completed = enrichedMatches.filter(
    (m) => m.timestamp && isCompleted(m)
  );

  // Sort by start time
  completed.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Collect unique teams
  const teamsMap = new Map();
  for (const m of completed) {
    const ht = m.homeTeam;
    const at = m.awayTeam;
    if (ht && !teamsMap.has(ht.id)) teamsMap.set(ht.id, { id: ht.id, name: ht.name, shortName: ht.shortName || ht.name });
    if (at && !teamsMap.has(at.id)) teamsMap.set(at.id, { id: at.id, name: at.name, shortName: at.shortName || at.name });
  }

  const matches = completed.map((m) => {
    const homeId = m.homeTeam?.id;
    const awayId = m.awayTeam?.id;
    const goals = extractGoals(m.incidents, homeId, awayId);
    return {
      id: m.id,
      homeTeamId: homeId,
      awayTeamId: awayId,
      timestamp: m.timestamp,
      round: m.round,
      homeScore90: m.result?.homeScore90 ?? 0,
      awayScore90: m.result?.awayScore90 ?? 0,
      goals,
    };
  });

  // Group matches that start within 3 hours of the group's first match
  const groups = [];
  let groupStart = null;
  let currentGroup = [];
  for (const m of matches) {
    const t = new Date(m.timestamp).getTime();
    if (groupStart === null || t - groupStart > 3 * HOUR) {
      if (currentGroup.length) groups.push({ matchIds: currentGroup.map((x) => x.id) });
      currentGroup = [m];
      groupStart = t;
    } else {
      currentGroup.push(m);
    }
  }
  if (currentGroup.length) groups.push({ matchIds: currentGroup.map((x) => x.id) });

  return {
    teams: Array.from(teamsMap.values()),
    matches,
    groups,
  };
}

// ─── API routes ───────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /api/demo
 *
 * Returns a synthetic timeline for a fictitious 10-team mini-season,
 * useful when api.nifs.no is unreachable or for offline development.
 * Emitted as a single SSE 'complete' event.
 */
app.get('/api/demo', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const teams = [
    { id: 1, name: 'Rosenborg', shortName: 'RBK' },
    { id: 2, name: 'Bodø/Glimt', shortName: 'BOD' },
    { id: 3, name: 'Molde', shortName: 'MOL' },
    { id: 4, name: 'Brann', shortName: 'BRN' },
    { id: 5, name: 'Viking', shortName: 'VIK' },
    { id: 6, name: 'Vålerenga', shortName: 'VIF' },
    { id: 7, name: 'Stabæk', shortName: 'STB' },
    { id: 8, name: 'Tromsø', shortName: 'TIL' },
    { id: 9, name: 'Lillestrøm', shortName: 'LSK' },
    { id: 10, name: 'Fredrikstad', shortName: 'FFK' },
  ];

  // Generate a round-robin fixture list (10 teams × 9 rounds = 45 matches, 5 per round)
  const fixtures = [];
  const ids = teams.map((t) => t.id);
  for (let round = 0; round < ids.length - 1; round++) {
    const roundFixtures = [];
    for (let i = 0; i < ids.length / 2; i++) {
      roundFixtures.push([ids[i], ids[ids.length - 1 - i]]);
    }
    fixtures.push(roundFixtures);
    // Rotate all but the first element
    ids.splice(1, 0, ids.pop());
  }

  // Seed-based pseudo-random for reproducibility
  let seed = 42;
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }
  function randInt(n) { return Math.floor(rand() * n); }

  const matches = [];
  const groups = [];
  const baseDate = new Date('2024-04-07T16:00:00');

  for (let ri = 0; ri < fixtures.length; ri++) {
    const roundDate = new Date(baseDate.getTime() + ri * 7 * 24 * 3600 * 1000);
    const groupMatchIds = [];

    for (const [homeId, awayId] of fixtures[ri]) {
      const matchId = matches.length + 1;
      const totalGoals = randInt(6); // 0–5 goals per match
      const goals = [];
      const usedMinutes = new Set();
      for (let g = 0; g < totalGoals; g++) {
        let min;
        do { min = 1 + randInt(119); } while (usedMinutes.has(min));
        usedMinutes.add(min);
        const scoringTeam = rand() < 0.55 ? homeId : awayId; // slight home advantage
        goals.push({ minute: min, teamId: scoringTeam, isOwnGoal: false });
      }
      goals.sort((a, b) => a.minute - b.minute);

      const homeScore90 = goals.filter((g) => g.teamId === homeId).length;
      const awayScore90 = goals.filter((g) => g.teamId === awayId).length;

      matches.push({
        id: matchId,
        homeTeamId: homeId,
        awayTeamId: awayId,
        timestamp: roundDate.toISOString(),
        round: ri + 1,
        homeScore90,
        awayScore90,
        goals,
      });
      groupMatchIds.push(matchId);
    }
    groups.push({ matchIds: groupMatchIds });
  }

  const data = { teams, matches, groups };
  res.write(`data: ${JSON.stringify({ type: 'complete', data })}\n\n`);
  res.end();
});

/** GET /api/tournaments — list all NIFS tournaments */
app.get('/api/tournaments', async (req, res) => {
  try {
    const data = await cached('tournaments', DAY, () => nifs.getTournaments());
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** GET /api/stages?tournamentId= — list seasons/stages for a tournament */
app.get('/api/stages', async (req, res) => {
  const { tournamentId } = req.query;
  if (!tournamentId) return res.status(400).json({ error: 'tournamentId required' });
  try {
    const data = await cached(`stages_${tournamentId}`, DAY, () =>
      nifs.getStages(tournamentId)
    );
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/timeline?tournamentId=&stageId=
 *
 * Returns a Server-Sent Events stream that emits:
 *   { type: 'progress', loaded: N, total: M }   — while loading incidents
 *   { type: 'complete', data: <timeline> }       — final result
 *   { type: 'error', message: '...' }            — on failure
 */
app.get('/api/timeline', async (req, res) => {
  const { tournamentId, stageId } = req.query;
  if (!tournamentId || !stageId)
    return res.status(400).json({ error: 'tournamentId and stageId required' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    // Check full timeline cache first (1 hour)
    const cacheKey = `timeline_${tournamentId}_${stageId}`;
    const cached_result = readCache(cacheKey, HOUR);
    if (cached_result) {
      send({ type: 'complete', data: cached_result });
      return res.end();
    }

    // Fetch match list
    send({ type: 'progress', loaded: 0, total: 0, message: 'Fetching match list…' });
    const matches = await cached(`matches_${tournamentId}_${stageId}`, 30 * 60 * 1000, () =>
      nifs.getMatches(tournamentId, stageId)
    );

    const completedMatches = Array.isArray(matches)
      ? matches.filter((m) => m.timestamp && isCompleted(m))
      : [];

    send({ type: 'progress', loaded: 0, total: completedMatches.length, message: `Loading ${completedMatches.length} matches…` });

    // Fetch incidents for each completed match
    const enriched = [];
    for (let i = 0; i < completedMatches.length; i++) {
      const m = completedMatches[i];
      try {
        const incidents = await cached(`incidents_${m.id}`, 30 * DAY, () =>
          nifs.getMatchIncidents(m.id)
        );
        enriched.push({ ...m, incidents: Array.isArray(incidents) ? incidents : [] });
      } catch {
        enriched.push({ ...m, incidents: [] });
      }

      if (i % 10 === 9 || i === completedMatches.length - 1) {
        send({ type: 'progress', loaded: i + 1, total: completedMatches.length });
        // Small yield to keep the connection alive and avoid rate-limiting
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const timeline = buildTimeline(enriched);
    writeCache(cacheKey, timeline);
    send({ type: 'complete', data: timeline });
    res.end();
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const addrs = ['localhost'];
    for (const iface of Object.values(nets)) {
      for (const { family, internal, address } of iface) {
        if (family === 'IPv4' && !internal) addrs.push(address);
      }
    }
    addrs.forEach(a => console.log(`  http://${a}:${PORT}`));
  });
}

module.exports = { buildTimeline, extractGoals, isCompleted, app }; // for tests
