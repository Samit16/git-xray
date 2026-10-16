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

/**
 * Normalize a repository path (use forward slashes, trim trailing slashes).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Extract all unique directories from a list of file paths.
 *
 * @param {string[]} filePaths
 * @returns {string[]} sorted folder paths
 */
function extractFolders(filePaths) {
  const folderSet = new Set();
  for (const rawPath of filePaths) {
    const p = normalizePath(rawPath);
    const parts = p.split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      folderSet.add(current);
    }
  }
  return Array.from(folderSet).sort((a, b) => a.localeCompare(b));
}

/**
 * Build a structured file and folder list from ownership data.
 *
 * @param {OwnershipEntry[]} ownershipData
 * @returns {Array<{ type: 'folder'|'file', path: string, name: string }>}
 */
function buildFileFolderList(ownershipData = []) {
  if (!Array.isArray(ownershipData) || ownershipData.length === 0) {
    return [];
  }

  const filePaths = Array.from(
    new Set(
      ownershipData
        .map((e) => normalizePath(typeof e === 'string' ? e : e?.path))
        .filter(Boolean)
    )
  );

  const folders = extractFolders(filePaths);

  const items = [
    ...folders.map((f) => ({ type: 'folder', path: f, name: f })),
    ...filePaths.map((f) => ({ type: 'file', path: f, name: f })),
  ];

  return items.sort((a, b) => {
    const keyA = a.type === 'folder' ? `${a.path}/` : a.path;
    const keyB = b.type === 'folder' ? `${b.path}/` : b.path;
    return keyA.localeCompare(keyB);
  });
}

/**
 * Calculate contribution percentages for a list of contributors,
 * handling zero totals and empty arrays safely, and sorting by descending contribution.
 *
 * @param {Array<{ name: string, email?: string, contribution?: number, commits?: number }>} contributors
 * @param {number} [total] - optional explicit total measured contribution
 * @returns {Array<{ name: string, email?: string, contribution: number, commits: number, percentage: number }>}
 */
function calculateContributionPercentages(contributors = [], total) {
  if (!Array.isArray(contributors) || contributors.length === 0) {
    return [];
  }

  const safeTotal =
    typeof total === 'number'
      ? total
      : contributors.reduce((sum, c) => sum + (c.contribution ?? c.commits ?? 0), 0);

  const results = contributors.map((c) => {
    const count = c.contribution ?? c.commits ?? 0;
    const percentage = safeTotal > 0 ? (count / safeTotal) * 100 : 0;
    return {
      name: c.name || 'Unknown',
      email: c.email || '',
      contribution: count,
      commits: count,
      percentage,
    };
  });

  return results.sort(
    (a, b) => b.contribution - a.contribution || a.name.localeCompare(b.name)
  );
}

/**
 * Compute the contributor breakdown for a given file or folder path.
 *
 * @param {string} targetPath - file or folder path
 * @param {OwnershipEntry[]} ownershipData
 * @param {boolean} [isFolder] - optional explicit type flag
 * @returns {{ path: string, type: 'folder'|'file', totalContribution: number, totalCommits: number, contributors: Array }}
 */
function computeContributorBreakdown(targetPath, ownershipData = [], isFolder) {
  const normTarget = normalizePath(targetPath);
  const safeData = Array.isArray(ownershipData) ? ownershipData : [];

  // Determine if target is a folder if not explicitly specified
  const effectiveIsFolder =
    typeof isFolder === 'boolean'
      ? isFolder
      : normTarget === '' ||
        normTarget === '.' ||
        safeData.some((e) => {
          const p = normalizePath(e?.path);
          return p !== normTarget && p.startsWith(`${normTarget}/`);
        });

  // Filter matching file entries
  const matchingEntries = safeData.filter((e) => {
    const p = normalizePath(e?.path);
    if (!p) return false;
    if (effectiveIsFolder) {
      if (normTarget === '' || normTarget === '.') return true;
      return p === normTarget || p.startsWith(`${normTarget}/`);
    }
    return p === normTarget;
  });

  // Aggregate author contributions and track last active timestamp
  let lastTimestamp = 0;
  const authorMap = new Map();
  for (const entry of matchingEntries) {
    if (entry.lastTouched && entry.lastTouched > lastTimestamp) {
      lastTimestamp = entry.lastTouched;
    }
    if (!entry.authors || !Array.isArray(entry.authors)) continue;
    for (const a of entry.authors) {
      const name = a.name || 'Unknown';
      const key = `${name} <${a.email || ''}>`;
      if (!authorMap.has(key)) {
        authorMap.set(key, {
          name,
          email: a.email || '',
          contribution: 0,
        });
      }
      const item = authorMap.get(key);
      const commits = typeof a.commits === 'number' ? a.commits : (a.contribution || 0);
      item.contribution += commits;
    }
  }

  const rawContributors = Array.from(authorMap.values());
  const totalContribution = rawContributors.reduce((sum, c) => sum + c.contribution, 0);
  const contributors = calculateContributionPercentages(rawContributors, totalContribution);

  return {
    path: normTarget,
    type: effectiveIsFolder ? 'folder' : 'file',
    totalContribution,
    totalCommits: totalContribution,
    contributors,
    leadingContributor: contributors[0] ? contributors[0].name : 'None',
    leadingPercentage: contributors[0] ? contributors[0].percentage : 0,
    distinctAuthors: contributors.length,
    lastTouched: lastTimestamp > 0 ? new Date(lastTimestamp * 1000).toISOString().slice(0, 10) : null,
    metric: 'Commit touches across Git history (edit frequency)',
  };
}

module.exports = {
  computeOwnership,
  normalizePath,
  extractFolders,
  buildFileFolderList,
  calculateContributionPercentages,
  computeContributorBreakdown,
};
