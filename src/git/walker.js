'use strict';

const { readObject, parseCommit, parseTree } = require('./objects.js');

/**
 * Walk the commit graph via BFS from one or more starting hashes.
 * Returns commits in reverse-chronological order (newest first).
 *
 * Uses readObject() which transparently handles both loose and packed objects.
 * Tracks how many objects could not be read (genuinely missing/corrupt).
 *
 * @param {string} gitDir
 * @param {string[]} startHashes — branch tips to start from
 * @returns {{ commits: ParsedCommit[], skippedCount: number }}
 */
function walkCommits(gitDir, startHashes) {
  const visited = new Set();
  const commits = [];
  const queue = [...startHashes];
  let skippedCount = 0;

  while (queue.length > 0) {
    const hash = queue.shift();

    if (visited.has(hash)) continue;
    visited.add(hash);

    const obj = readObject(gitDir, hash);
    if (!obj) {
      // Object genuinely missing (not loose, not in any pack)
      skippedCount++;
      continue;
    }

    if (obj.type !== 'commit') continue;

    let commit;
    try {
      commit = parseCommit(hash, obj.body);
    } catch {
      // Corrupted commit — skip it
      continue;
    }

    commits.push(commit);

    // Enqueue parent commits
    for (const parentHash of commit.parents) {
      if (!visited.has(parentHash)) {
        queue.push(parentHash);
      }
    }
  }

  // Sort by author timestamp descending (newest first)
  commits.sort((a, b) => b.author.timestamp - a.author.timestamp);

  return { commits, packedCount: skippedCount };
}

/**
 * Diff two tree SHA-1s recursively to find changed file paths.
 *
 * Strategy: flatten both trees into { path → hash } maps, then compare.
 * This is simpler and more correct than trying to walk both trees in parallel.
 *
 * For merge commits, we diff against the first parent only (standard convention).
 *
 * @param {string} gitDir
 * @param {string|null} oldTreeHash — parent's root tree (null for root commits)
 * @param {string} newTreeHash — this commit's root tree
 * @returns {{ added: string[], modified: string[], deleted: string[] }}
 */
function diffTrees(gitDir, oldTreeHash, newTreeHash) {
  const oldFiles = oldTreeHash ? flattenTree(gitDir, oldTreeHash, '') : new Map();
  const newFiles = flattenTree(gitDir, newTreeHash, '');

  const added = [];
  const modified = [];
  const deleted = [];

  // Check for added/modified files
  for (const [filePath, newHash] of newFiles) {
    if (!oldFiles.has(filePath)) {
      added.push(filePath);
    } else if (oldFiles.get(filePath) !== newHash) {
      modified.push(filePath);
    }
  }

  // Check for deleted files
  for (const [filePath] of oldFiles) {
    if (!newFiles.has(filePath)) {
      deleted.push(filePath);
    }
  }

  return { added, modified, deleted };
}

/**
 * Recursively flatten a tree object into a map of { filePath → blobHash }.
 * Only includes file entries (blobs), not subtrees.
 *
 * @param {string} gitDir
 * @param {string} treeHash
 * @param {string} prefix — current directory prefix (e.g., "src/git/")
 * @returns {Map<string, string>}
 */
function flattenTree(gitDir, treeHash, prefix) {
  const result = new Map();

  const obj = readObject(gitDir, treeHash);
  if (!obj || obj.type !== 'tree') {
    return result; // Not found or not a tree — skip silently
  }

  const entries = parseTree(obj.body);

  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.mode === '40000' || entry.mode === '040000') {
      // Subdirectory — recurse
      const subEntries = flattenTree(gitDir, entry.hash, fullPath);
      for (const [k, v] of subEntries) {
        result.set(k, v);
      }
    } else {
      // File (blob, symlink, submodule, etc.)
      result.set(fullPath, entry.hash);
    }
  }

  return result;
}

/**
 * For each commit, compute which files were changed (added/modified/deleted)
 * by diffing its tree against the first parent's tree.
 *
 * Root commits (no parents) are diffed against an empty tree.
 *
 * @param {string} gitDir
 * @param {ParsedCommit[]} commits — commits from walkCommits()
 * @returns {Map<string, { added: string[], modified: string[], deleted: string[] }>}
 *   — keyed by commit hash
 */
function computeAllDiffs(gitDir, commits) {
  const diffs = new Map();

  // Build a lookup from hash → commit for quick parent resolution
  const commitMap = new Map();
  for (const c of commits) {
    commitMap.set(c.hash, c);
  }

  for (const commit of commits) {
    // Use first parent for diffs (standard --first-parent convention for merges)
    let parentTreeHash = null;
    if (commit.parents.length > 0) {
      const parentCommit = commitMap.get(commit.parents[0]);
      if (parentCommit) {
        parentTreeHash = parentCommit.tree;
      } else {
        // Parent is packed — we can't diff, record empty diff
        diffs.set(commit.hash, { added: [], modified: [], deleted: [] });
        continue;
      }
    }

    try {
      const diff = diffTrees(gitDir, parentTreeHash, commit.tree);
      diffs.set(commit.hash, diff);
    } catch {
      // If tree parsing fails, record empty diff rather than crashing
      diffs.set(commit.hash, { added: [], modified: [], deleted: [] });
    }
  }

  return diffs;
}

module.exports = { walkCommits, diffTrees, flattenTree, computeAllDiffs };
