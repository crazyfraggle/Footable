/* ── Footable – frontend application ──────────────────────────────── */
'use strict';

// ── Constants ───────────────────────────────────────────────────────
const VIRTUAL_MATCH_MINUTES = 120; // each match simulates 2 × 60 min
const DEFAULT_MATCH_DURATION_S = 10; // seconds of animation per match at speed 1×

// ── DOM refs ────────────────────────────────────────────────────────
const tournamentSelect = document.getElementById('tournamentSelect');
const stageSelect = document.getElementById('stageSelect');
const loadBtn = document.getElementById('loadBtn');
const demoBtn = document.getElementById('demoBtn');
const loadingSection = document.getElementById('loadingSection');
const loadingMsg = document.getElementById('loadingMsg');
const loadingBar = document.getElementById('loadingBar');
const controls = document.getElementById('controls');
const tableSection = document.getElementById('tableSection');
const tableTitle = document.getElementById('tableTitle');
const tableBody = document.getElementById('tableBody');
const playBtn = document.getElementById('playBtn');
const resetBtn = document.getElementById('resetBtn');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');
const scrubber = document.getElementById('scrubber');
const matchInfo = document.getElementById('matchInfo');
const fixedBar = document.getElementById('fixedBar');
const fixedRound = document.getElementById('fixedRound');
const fixedMinute = document.getElementById('fixedMinute');
const fixedProgress = document.getElementById('fixedProgress');

// ── Application state ───────────────────────────────────────────────
let timeline = null;    // { teams, matches, groups }
let teamsById = {};     // id → team
let matchesById = {};   // id → match

// Animation state
let playing = false;
let rafId = null;
let animStartTime = null;   // performance.now() when animation started for current group
let groupOffset = 0;        // total virtual time elapsed before current group (minutes)
let groupIndex = 0;         // index into timeline.groups
let virtualMinute = 0;      // current position in the overall timeline (minutes)
let totalVirtualMinutes = 0;// total virtual minutes for the whole season

// Running standings – recalculated from scratch each render frame
// teamsById contains canonical team list; table rows are keyed by team id

// ── Startup: load tournament list ───────────────────────────────────
(async function init() {
  try {
    const tournaments = await apiFetch('/api/tournaments');
    tournamentSelect.innerHTML = '';
    if (!Array.isArray(tournaments) || tournaments.length === 0) {
      tournamentSelect.innerHTML = '<option value="">No data</option>';
      return;
    }
    for (const t of tournaments) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name ?? `Tournament ${t.id}`;
      tournamentSelect.appendChild(opt);
    }
    tournamentSelect.disabled = false;
    tournamentSelect.dispatchEvent(new Event('change'));
  } catch (err) {
    tournamentSelect.innerHTML = '<option value="">— unavailable —</option>';
    tournamentSelect.title = `Could not reach api.nifs.no: ${err.message}`;
  }
})();

// ── Tournament change → load stages ─────────────────────────────────
tournamentSelect.addEventListener('change', async () => {
  const tid = tournamentSelect.value;
  stageSelect.innerHTML = '<option value="">Loading…</option>';
  stageSelect.disabled = true;
  loadBtn.disabled = true;
  if (!tid) return;
  try {
    const stages = await apiFetch(`/api/stages?tournamentId=${encodeURIComponent(tid)}`);
    stageSelect.innerHTML = '';
    if (!Array.isArray(stages) || stages.length === 0) {
      stageSelect.innerHTML = '<option value="">No seasons</option>';
      return;
    }
    // Sort stages descending by year (most recent first), then by name
    stages.sort((a, b) => (b.yearStart ?? 0) - (a.yearStart ?? 0) || String(b.name ?? b.id).localeCompare(String(a.name ?? a.id)));
    for (const s of stages) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.fullName ?? (s.yearStart ? `${s.name ?? 'Season'} ${s.yearStart}` : (s.name ?? `Stage ${s.id}`));
      stageSelect.appendChild(opt);
    }
    stageSelect.disabled = false;
    loadBtn.disabled = false;
  } catch (err) {
    stageSelect.innerHTML = `<option value="">Error: ${err.message}</option>`;
  }
});

// ── Load button ──────────────────────────────────────────────────────
loadBtn.addEventListener('click', () => {
  const tid = tournamentSelect.value;
  const sid = stageSelect.value;
  if (!tid || !sid) return;
  loadTimeline(tid, sid);
});

// ── Demo button ──────────────────────────────────────────────────────
demoBtn.addEventListener('click', () => {
  loadSSE('/api/demo', 'Demo season – Eliteserien-style (10 teams, 9 rounds)');
});

// ── Load timeline via SSE ────────────────────────────────────────────
function loadTimeline(tournamentId, stageId) {
  const url = `/api/timeline?tournamentId=${encodeURIComponent(tournamentId)}&stageId=${encodeURIComponent(stageId)}`;
  const title = `${tournamentSelect.options[tournamentSelect.selectedIndex]?.textContent ?? ''} – ${stageSelect.options[stageSelect.selectedIndex]?.textContent ?? ''}`;
  loadSSE(url, title);
}

function loadSSE(url, title) {
  stopAnimation();
  controls.classList.add('hidden');
  tableSection.classList.add('hidden');
  loadingSection.classList.remove('hidden');
  loadingMsg.textContent = 'Connecting…';
  loadingBar.value = 0;
  loadingBar.max = 1;

  const es = new EventSource(url);

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'progress') {
      loadingMsg.textContent = msg.message ?? `Loading matches (${msg.loaded}/${msg.total})…`;
      if (msg.total > 0) {
        loadingBar.max = msg.total;
        loadingBar.value = msg.loaded;
      }
    } else if (msg.type === 'complete') {
      es.close();
      loadingSection.classList.add('hidden');
      tableTitle.textContent = title;
      initTimeline(msg.data);
    } else if (msg.type === 'error') {
      es.close();
      loadingMsg.textContent = `Error: ${msg.message}`;
    }
  };

  es.onerror = () => {
    es.close();
    loadingMsg.textContent = 'Connection error. Check that the server is running.';
  };
}

// ── Initialise timeline data ─────────────────────────────────────────
function initTimeline(data) {
  timeline = data;
  teamsById = {};
  matchesById = {};

  for (const t of data.teams) teamsById[t.id] = t;
  for (const m of data.matches) matchesById[m.id] = m;

  // Each group contributes VIRTUAL_MATCH_MINUTES to the timeline
  totalVirtualMinutes = data.groups.length * VIRTUAL_MATCH_MINUTES;

  resetAnimation();
  renderTable(computeStandings(0));
  controls.classList.remove('hidden');
  tableSection.classList.remove('hidden');
  fixedBar.classList.remove('hidden');
}

// ── Standings calculator ─────────────────────────────────────────────
/**
 * Compute standings at a given virtual minute (0 … totalVirtualMinutes).
 *
 * Virtual minutes run 0–120 per group sequentially.
 * Within a group, all matches in that group run concurrently over 0–120 min.
 */
function computeStandings(vm) {
  if (!timeline) return [];

  // Build a map of team stats
  const stats = {};
  for (const t of timeline.teams) {
    stats[t.id] = { id: t.id, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, played: 0 };
  }

  // Determine which groups are fully done and which is current
  const groupsDone = Math.floor(vm / VIRTUAL_MATCH_MINUTES);
  const minuteWithinGroup = vm % VIRTUAL_MATCH_MINUTES;
  const liveScores = {}; // teamId -> score string e.g. "1–0"

  for (let gi = 0; gi < timeline.groups.length; gi++) {
    const group = timeline.groups[gi];
    if (gi < groupsDone) {
      // Full result for all matches in this group
      for (const mid of group.matchIds) {
        const m = matchesById[mid];
        if (!m) continue;
        applyMatchResult(stats, m, m.homeScore90, m.awayScore90);
      }
    } else if (gi === groupsDone) {
      // Partial result: apply goals up to minuteWithinGroup
      for (const mid of group.matchIds) {
        const m = matchesById[mid];
        if (!m) continue;
        let hs = 0, as = 0;
        for (const g of m.goals) {
          if (g.minute <= minuteWithinGroup) {
            if (g.teamId === m.homeTeamId) hs++;
            else as++;
          }
        }
        applyMatchResult(stats, m, hs, as);
        liveScores[m.homeTeamId] = `${hs}–${as}`;
        liveScores[m.awayTeamId] = `${as}–${hs}`;
      }
    }
    // gi > groupsDone: not started yet
  }

  // Build sorted array
  const rows = Object.values(stats).map((s) => ({
    ...s,
    gd: s.gf - s.ga,
    live: liveScores[s.id] ?? null,
  }));
  rows.sort((a, b) =>
    b.pts - a.pts ||
    b.gd  - a.gd  ||
    b.gf  - a.gf  ||
    String(teamsById[a.id]?.name ?? a.id).localeCompare(String(teamsById[b.id]?.name ?? b.id))
  );
  return rows;
}

function applyMatchResult(stats, m, hs, as) {
  const h = stats[m.homeTeamId];
  const a = stats[m.awayTeamId];
  if (!h || !a) return;
  h.gf += hs; h.ga += as; h.played++;
  a.gf += as; a.ga += hs; a.played++;
  if (hs > as)       { h.pts += 3; h.w++; a.l++; }
  else if (hs < as)  { a.pts += 3; a.w++; h.l++; }
  else                { h.pts++; a.pts++; h.d++; a.d++; }
}


// ── Table rendering ──────────────────────────────────────────────────
let prevPositions = {}; // teamId → rowIndex

function renderTable(rows) {
  const tbody = tableBody;
  const rowHeight = 48; // must match --row-h in CSS

  // Create or reuse row elements (keyed by team id)
  const existingRows = {};
  for (const el of tbody.querySelectorAll('.table-row')) {
    existingRows[el.dataset.teamId] = el;
  }

  const rowsToRemove = new Set(Object.keys(existingRows));

  rows.forEach((row, i) => {
    const tid = String(row.id);
    rowsToRemove.delete(tid);
    const team = teamsById[row.id];
    const name = team?.name ?? `Team ${row.id}`;
    const gdClass = row.gd > 0 ? 'gd-pos' : row.gd < 0 ? 'gd-neg' : '';

    let el = existingRows[tid];
    if (!el) {
      el = document.createElement('div');
      el.className = 'table-row';
      el.dataset.teamId = tid;
      el.style.top = `${i * rowHeight}px`;
      el.innerHTML = rowHTML(i + 1, name, row, gdClass);
      tbody.appendChild(el);
    } else {
      // Update content
      el.className = `table-row pos-${i + 1 <= 3 ? i + 1 : 'other'}`;
      el.innerHTML = rowHTML(i + 1, name, row, gdClass);
      // Animate vertical position change
      el.style.top = `${i * rowHeight}px`;

      // Flash if position changed
      const prev = prevPositions[tid];
      if (prev !== undefined && prev !== i) {
        el.classList.add('goal-flash');
        el.addEventListener('animationend', () => el.classList.remove('goal-flash'), { once: true });
      }
    }
    // Set position class for gold / silver medal, and live highlight
    el.className = `table-row ${i < 3 ? `pos-${i + 1}` : ''} ${row.live != null ? 'playing' : ''}`.trim();
    el.style.top = `${i * rowHeight}px`;

    prevPositions[tid] = i;
  });

  // Remove rows for teams no longer in standings
  for (const tid of rowsToRemove) {
    existingRows[tid]?.remove();
  }

  // Size the tbody wrapper so it takes the right amount of space
  tbody.style.height = `${rows.length * rowHeight}px`;
}

function rowHTML(pos, name, row, gdClass) {
  const liveBadge = row.live != null ? `<span class="live-badge">${row.live}</span>` : '';
  return `
    <div class="cell"><span class="pos-badge">${pos}</span></div>
    <div class="cell">${escHtml(name)}${liveBadge}</div>
    <div class="cell">${row.played}</div>
    <div class="cell">${row.w}</div>
    <div class="cell">${row.d}</div>
    <div class="cell">${row.l}</div>
    <div class="cell">${row.gf}</div>
    <div class="cell">${row.ga}</div>
    <div class="cell ${gdClass}">${row.gd >= 0 ? '+' : ''}${row.gd}</div>
    <div class="cell pts-cell">${row.pts}</div>
  `;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Animation engine ─────────────────────────────────────────────────
/**
 * The animation maps virtual minutes to real time:
 *   speed × DEFAULT_MATCH_DURATION_S seconds per VIRTUAL_MATCH_MINUTES
 *   → virtual minutes per second = VIRTUAL_MATCH_MINUTES / (DEFAULT_MATCH_DURATION_S / speed)
 *
 * At speed=1: 120 virtual min in 10 s = 12 vmin/s
 */
function vminPerSecond() {
  const speed = parseFloat(speedSlider.value);
  return (VIRTUAL_MATCH_MINUTES / DEFAULT_MATCH_DURATION_S) * speed;
}

function resetAnimation() {
  stopAnimation();
  virtualMinute = 0;
  prevPositions = {};
  scrubber.value = 0;
  updateMatchInfo(0);
  playBtn.textContent = '▶ Play';
  playing = false;
}

function stopAnimation() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  playing = false;
}

function startAnimation() {
  if (playing) return;
  if (virtualMinute >= totalVirtualMinutes) resetAnimation();
  playing = true;
  playBtn.textContent = '⏸ Pause';
  animStartTime = performance.now() - (virtualMinute / vminPerSecond()) * 1000;
  rafId = requestAnimationFrame(animFrame);
}

function animFrame(now) {
  if (!playing) return;
  const elapsedS = (now - animStartTime) / 1000;
  const vm = elapsedS * vminPerSecond();

  if (vm >= totalVirtualMinutes) {
    virtualMinute = totalVirtualMinutes;
    renderTable(computeStandings(virtualMinute));
    scrubber.value = 1;
    updateMatchInfo(virtualMinute);
    stopAnimation();
    playBtn.textContent = '▶ Play';
    return;
  }

  virtualMinute = vm;
  scrubber.value = vm / totalVirtualMinutes;
  updateMatchInfo(vm);
  renderTable(computeStandings(vm));
  rafId = requestAnimationFrame(animFrame);
}

function updateMatchInfo(vm) {
  if (!timeline) return;
  const gi = Math.min(Math.floor(vm / VIRTUAL_MATCH_MINUTES), timeline.groups.length - 1);
  const group = timeline.groups[gi];
  if (!group) { matchInfo.textContent = ''; return; }
  const firstMatch = matchesById[group.matchIds[0]];
  const date = firstMatch ? firstMatch.timestamp.slice(0, 10) : '';
  const minInGroup = Math.min(Math.floor(vm % VIRTUAL_MATCH_MINUTES), 120);
  const half = minInGroup <= 60 ? '1st half' : '2nd half';
  const dispMin = minInGroup <= 60 ? minInGroup : minInGroup - 60;
  const roundText = `Round ${gi + 1} of ${timeline.groups.length}  ·  ${date}  ·  ${half} ${dispMin}'`;
  matchInfo.textContent = roundText;

  // Count fully completed matches
  const groupsDone = Math.floor(vm / VIRTUAL_MATCH_MINUTES);
  let played = 0;
  for (let i = 0; i < groupsDone && i < timeline.groups.length; i++) {
    played += timeline.groups[i].matchIds.length;
  }
  const total = timeline.matches.length;
  fixedRound.textContent = `Rd ${gi + 1} / ${timeline.groups.length}  ·  ${date}`;
  fixedMinute.textContent = `${half} ${dispMin}'`;
  fixedProgress.textContent = `${played} / ${total} matches`;
}

// ── Control event listeners ──────────────────────────────────────────
playBtn.addEventListener('click', () => {
  if (playing) {
    stopAnimation();
    playBtn.textContent = '▶ Play';
  } else {
    startAnimation();
  }
});

resetBtn.addEventListener('click', () => {
  resetAnimation();
  if (timeline) renderTable(computeStandings(0));
});

speedSlider.addEventListener('input', () => {
  speedLabel.textContent = `${parseFloat(speedSlider.value)}×`;
  if (playing) {
    // Recalibrate start time so the current position is preserved
    animStartTime = performance.now() - (virtualMinute / vminPerSecond()) * 1000;
  }
});

scrubber.addEventListener('input', () => {
  const wasPlaying = playing;
  stopAnimation();
  virtualMinute = parseFloat(scrubber.value) * totalVirtualMinutes;
  updateMatchInfo(virtualMinute);
  renderTable(computeStandings(virtualMinute));
  if (wasPlaying) startAnimation();
});

// ── Utility ──────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
