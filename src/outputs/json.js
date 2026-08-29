'use strict';

/**
 * Format data as JSON for the --json flag.
 *
 * @param {any} data — structured data to serialize
 * @returns {string}
 */
function formatJSON(data) {
  return JSON.stringify(data, null, 2);
}

module.exports = { formatJSON };
