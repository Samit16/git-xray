'use strict';

/**
 * Compute churn — how many commits touched each file.
 *
 * @param {ParsedCommit[]} commits
 * @param {Map<string, { added: string[], modified: string[], deleted: string[] }>} diffs
 * @returns {{ path: string, touches: number }[]} — sorted by touches descending
 */
function computeChurn(commits, diffs) {
  const touchCount = new Map(); // path → count

  for (const commit of commits) {
    const diff = diffs.get(commit.hash);
    if (!diff) continue;

    const touchedFiles = [...diff.added, ...diff.modified, ...diff.deleted];
    for (const filePath of touchedFiles) {
      touchCount.set(filePath, (touchCount.get(filePath) || 0) + 1);
    }
  }

  return Array.from(touchCount.entries())
    .map(([path, touches]) => ({ path, touches }))
    .sort((a, b) => b.touches - a.touches);
}

module.exports = { computeChurn };
