'use strict';

/**
 * Compute per-file ownership — which authors touched each file and how much.
 *
 * @param {ParsedCommit[]} commits
 * @param {Map<string, { added: string[], modified: string[], deleted: string[] }>} diffs
 * @returns {OwnershipEntry[]} — sorted by path
 */
function computeOwnership(commits, diffs) {
  // path → { authorKey → { name, email, commits, lastTimestamp } }
  const fileAuthors = new Map();

  for (const commit of commits) {
    const diff = diffs.get(commit.hash);
    if (!diff) continue;

    const authorKey = `${commit.author.name} <${commit.author.email}>`;
    const touchedFiles = [...diff.added, ...diff.modified];
    // Note: we don't count deletes toward ownership — if a file is deleted,
    // it doesn't exist anymore, so ownership is moot.

    for (const filePath of touchedFiles) {
      if (!fileAuthors.has(filePath)) {
        fileAuthors.set(filePath, new Map());
      }
      const authors = fileAuthors.get(filePath);

      if (!authors.has(authorKey)) {
        authors.set(authorKey, {
          name: commit.author.name,
          email: commit.author.email,
          commits: 0,
          lastTimestamp: 0,
        });
      }

      const entry = authors.get(authorKey);
      entry.commits++;
      entry.lastTimestamp = Math.max(entry.lastTimestamp, commit.author.timestamp);
    }
  }

  // Convert to output format
  const results = [];

  for (const [filePath, authorMap] of fileAuthors) {
    const totalCommits = Array.from(authorMap.values()).reduce(
      (sum, a) => sum + a.commits,
      0
    );

    const authors = Array.from(authorMap.values())
      .map((a) => ({
        name: a.name,
        email: a.email,
        commits: a.commits,
        percentage: (a.commits / totalCommits) * 100,
      }))
      .sort((a, b) => b.commits - a.commits);

    const lastTouched = Math.max(
      ...Array.from(authorMap.values()).map((a) => a.lastTimestamp)
    );

    results.push({
      path: filePath,
      authors,
      primaryAuthor: {
        name: authors[0].name,
        percentage: authors[0].percentage,
      },
      distinctAuthors: authors.length,
      lastTouched,
    });
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { computeOwnership };
