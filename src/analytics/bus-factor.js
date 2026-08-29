'use strict';

/**
 * Compute bus-factor — flag files where one author owns more than threshold% of commits.
 * These are the "if they leave, we're in trouble" files.
 *
 * @param {OwnershipEntry[]} ownershipData — from computeOwnership()
 * @param {number} threshold — percentage threshold (default 80)
 * @returns {BusFactorEntry[]} — sorted by risk (highest percentage first)
 */
function computeBusFactor(ownershipData, threshold = 80) {
  const results = [];

  for (const entry of ownershipData) {
    if (entry.distinctAuthors === 0) continue;

    const topAuthor = entry.authors[0];
    const atRisk = topAuthor.percentage >= threshold;

    results.push({
      path: entry.path,
      topAuthor: topAuthor.name,
      topAuthorPercentage: topAuthor.percentage,
      distinctAuthors: entry.distinctAuthors,
      atRisk,
    });
  }

  // Sort: at-risk files first, then by percentage descending
  return results.sort((a, b) => {
    if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
    return b.topAuthorPercentage - a.topAuthorPercentage;
  });
}

module.exports = { computeBusFactor };
