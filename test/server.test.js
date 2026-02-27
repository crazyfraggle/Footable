'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Import the pure functions exported from server.js
const { buildTimeline, extractGoals, isCompleted } = require('../server.js');

// ── isCompleted ───────────────────────────────────────────────────────────────

test('isCompleted: returns true for matchStatusId 6 (fullTime)', () => {
  assert.ok(isCompleted({ matchStatusId: 6, result: {}, timestamp: 't' }));
});

test('isCompleted: returns false for matchStatusId 1 (not started)', () => {
  assert.ok(!isCompleted({ matchStatusId: 1, timestamp: 't' }));
});

test('isCompleted: falls back to result.homeScore90 presence', () => {
  assert.ok(isCompleted({ result: { homeScore90: 2, awayScore90: 1 }, timestamp: 't' }));
  assert.ok(!isCompleted({ result: {}, timestamp: 't' }));
});

// ── extractGoals ──────────────────────────────────────────────────────────────

test('extractGoals: extracts goals by incidentTypeId=1', () => {
  const incidents = [
    { incidentTypeId: 1, minute: 23, teamId: 10 },
    { incidentTypeId: 3, minute: 40, teamId: 10 }, // yellow card – ignored
  ];
  const goals = extractGoals(incidents, 10, 20);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].minute, 23);
  assert.equal(goals[0].teamId, 10);
  assert.ok(!goals[0].isOwnGoal);
});

test('extractGoals: own goal credited to opposing team', () => {
  const incidents = [
    { incidentTypeId: 2, minute: 55, teamId: 10 }, // own goal by home team
  ];
  const goals = extractGoals(incidents, 10, 20);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].teamId, 20); // credited to away team
  assert.ok(goals[0].isOwnGoal);
});

test('extractGoals: goals beyond minute 150 are filtered', () => {
  const incidents = [
    { incidentTypeId: 1, minute: 200, teamId: 10 },
  ];
  const goals = extractGoals(incidents, 10, 20);
  assert.equal(goals.length, 0);
});

test('extractGoals: returns [] for non-array input', () => {
  assert.deepEqual(extractGoals(null, 1, 2), []);
  assert.deepEqual(extractGoals(undefined, 1, 2), []);
});

// ── buildTimeline ─────────────────────────────────────────────────────────────

function makeMatch(overrides) {
  return {
    id: 1,
    timestamp: '2024-04-14T16:00:00',
    matchStatusId: 6,
    homeTeam: { id: 10, name: 'Alpha', shortName: 'ALP' },
    awayTeam: { id: 20, name: 'Bravo', shortName: 'BRV' },
    result: { homeScore90: 2, awayScore90: 1 },
    round: 1,
    incidents: [
      { incidentTypeId: 1, minute: 23, teamId: 10 },
      { incidentTypeId: 1, minute: 67, teamId: 20 },
      { incidentTypeId: 1, minute: 89, teamId: 10 },
    ],
    ...overrides,
  };
}

test('buildTimeline: produces correct teams list', () => {
  const tl = buildTimeline([makeMatch()]);
  assert.equal(tl.teams.length, 2);
  const names = tl.teams.map((t) => t.name).sort();
  assert.deepEqual(names, ['Alpha', 'Bravo']);
});

test('buildTimeline: produces correct match with goals', () => {
  const tl = buildTimeline([makeMatch()]);
  assert.equal(tl.matches.length, 1);
  const m = tl.matches[0];
  assert.equal(m.homeTeamId, 10);
  assert.equal(m.awayTeamId, 20);
  assert.equal(m.goals.length, 3);
  // Goals should be sorted by minute
  assert.equal(m.goals[0].minute, 23);
  assert.equal(m.goals[1].minute, 67);
  assert.equal(m.goals[2].minute, 89);
});

test('buildTimeline: groups concurrent matches (< 3 h apart)', () => {
  const m1 = makeMatch({ id: 1, timestamp: '2024-04-14T16:00:00' });
  const m2 = makeMatch({ id: 2, timestamp: '2024-04-14T18:00:00' }); // 2 h later
  const tl = buildTimeline([m1, m2]);
  assert.equal(tl.groups.length, 1);
  assert.equal(tl.groups[0].matchIds.length, 2);
});

test('buildTimeline: separates matches more than 3 h apart into different groups', () => {
  const m1 = makeMatch({ id: 1, timestamp: '2024-04-14T14:00:00' });
  const m2 = makeMatch({ id: 2, timestamp: '2024-04-14T18:00:00' }); // 4 h later
  const tl = buildTimeline([m1, m2]);
  assert.equal(tl.groups.length, 2);
});

test('buildTimeline: skips matches without timestamp', () => {
  const m = makeMatch({ timestamp: null });
  const tl = buildTimeline([m]);
  assert.equal(tl.matches.length, 0);
});

test('buildTimeline: skips incomplete matches', () => {
  const m = makeMatch({ matchStatusId: 1 }); // not finished
  const tl = buildTimeline([m]);
  assert.equal(tl.matches.length, 0);
});

test('buildTimeline: sorts matches chronologically', () => {
  const m1 = makeMatch({ id: 1, timestamp: '2024-05-01T16:00:00' });
  const m2 = makeMatch({ id: 2, timestamp: '2024-04-14T16:00:00' });
  const tl = buildTimeline([m1, m2]);
  assert.equal(tl.matches[0].id, 2); // April before May
  assert.equal(tl.matches[1].id, 1);
});
