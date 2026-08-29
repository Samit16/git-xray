'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Locate the .git directory for a given repository path.
 *
 * Handles:
 * - Standard repos: <path>/.git/ is a directory
 * - Worktrees: <path>/.git is a file containing "gitdir: <actual-path>"
 * - Bare repos: <path> itself contains HEAD, objects/, refs/
 * - Missing/invalid: throws with a clean message
 *
 * @param {string} repoPath — path to the repository root (or bare repo)
 * @returns {{ gitDir: string, isBare: boolean }} — absolute path to the git directory
 */
function locateGitDir(repoPath) {
  const absPath = path.resolve(repoPath);

  if (!fs.existsSync(absPath)) {
    throw new GitXRayError(`Path does not exist: ${absPath}`);
  }

  const dotGitPath = path.join(absPath, '.git');

  // Case 1: .git is a directory (standard repo)
  if (fs.existsSync(dotGitPath)) {
    const stat = fs.statSync(dotGitPath);

    if (stat.isDirectory()) {
      validateGitDir(dotGitPath);
      return { gitDir: dotGitPath, isBare: false };
    }

    // Case 2: .git is a file (worktree or submodule)
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) {
        throw new GitXRayError(
          `.git file exists but has unexpected format: ${dotGitPath}`
        );
      }
      const resolvedGitDir = path.resolve(absPath, match[1]);
      if (!fs.existsSync(resolvedGitDir)) {
        throw new GitXRayError(
          `.git file points to non-existent directory: ${resolvedGitDir}`
        );
      }
      validateGitDir(resolvedGitDir);
      return { gitDir: resolvedGitDir, isBare: false };
    }
  }

  // Case 3: bare repo — the path itself is the git dir
  if (isBareRepo(absPath)) {
    return { gitDir: absPath, isBare: true };
  }

  throw new GitXRayError(
    `Not a git repository (or any parent up to filesystem root): ${absPath}`
  );
}

/**
 * Validate that a git directory has the minimum required structure.
 * @param {string} gitDir
 */
function validateGitDir(gitDir) {
  const headPath = path.join(gitDir, 'HEAD');
  if (!fs.existsSync(headPath)) {
    throw new GitXRayError(
      `Invalid git directory (missing HEAD): ${gitDir}`
    );
  }

  const objectsPath = path.join(gitDir, 'objects');
  if (!fs.existsSync(objectsPath)) {
    throw new GitXRayError(
      `Invalid git directory (missing objects/): ${gitDir}`
    );
  }
}

/**
 * Check if a directory looks like a bare git repo.
 * Bare repos have HEAD, objects/, and refs/ at the top level (no .git subdir).
 * @param {string} dirPath
 * @returns {boolean}
 */
function isBareRepo(dirPath) {
  return (
    fs.existsSync(path.join(dirPath, 'HEAD')) &&
    fs.existsSync(path.join(dirPath, 'objects')) &&
    fs.existsSync(path.join(dirPath, 'refs'))
  );
}

/**
 * Custom error class for Git X-Ray user-facing errors.
 * These produce clean messages without stack traces.
 */
class GitXRayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitXRayError';
  }
}

module.exports = { locateGitDir, GitXRayError };
