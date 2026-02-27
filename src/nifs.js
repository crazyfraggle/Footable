'use strict';

/**
 * NIFS (Norsk & Internasjonal Fotballstatistikk) API client.
 *
 * Base URL: https://api.nifs.no
 *
 * Key endpoints:
 *   GET /tournaments                                        - list all tournaments
 *   GET /tournaments/{tournamentId}/stages                  - list stages (seasons) for a tournament
 *   GET /tournaments/{tournamentId}/stages/{stageId}/matches - list matches for a stage
 *   GET /matches/{matchId}                                  - get match details
 *   GET /matches/{matchId}/incidents                        - get match incidents (goals, cards, etc.)
 *
 * Known tournament IDs:
 *   5  = Eliteserien (Norwegian Premier League)
 *   6  = 1. divisjon (Norwegian First Division)
 *
 * Known stage IDs for Eliteserien:
 *   682936 = 2020 season
 *   684880 = 2022 season
 */

const BASE_URL = 'https://api.nifs.no';

/**
 * Make a GET request to the NIFS API.
 * @param {string} path - API path (without base URL)
 * @returns {Promise<any>} parsed JSON response
 */
async function nifsGet(path) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Footable/1.0 (https://github.com/crazyfraggle/Footable)',
    },
  });
  if (!response.ok) {
    throw new Error(`NIFS API ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * Get all tournaments available on NIFS.
 * @returns {Promise<Array>}
 */
async function getTournaments() {
  return nifsGet('/tournaments');
}

/**
 * Get all stages (seasons) for a tournament.
 * @param {string|number} tournamentId
 * @returns {Promise<Array>}
 */
async function getStages(tournamentId) {
  return nifsGet(`/tournaments/${tournamentId}/stages`);
}

/**
 * Get all matches for a given tournament stage.
 * @param {string|number} tournamentId
 * @param {string|number} stageId
 * @returns {Promise<Array<Match>>}
 */
async function getMatches(tournamentId, stageId) {
  return nifsGet(`/tournaments/${tournamentId}/stages/${stageId}/matches/`);
}

/**
 * Get a single match's full details.
 * @param {string|number} matchId
 * @returns {Promise<Match>}
 */
async function getMatch(matchId) {
  return nifsGet(`/matches/${matchId}`);
}

/**
 * Get all incidents (goals, cards, substitutions) for a match.
 * @param {string|number} matchId
 * @returns {Promise<Array<Incident>>}
 */
async function getMatchIncidents(matchId) {
  return nifsGet(`/matches/${matchId}/incidents`);
}

module.exports = { getTournaments, getStages, getMatches, getMatch, getMatchIncidents };
