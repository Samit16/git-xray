'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GitXRayError } = require('./locator.js');

/**
 * Read HEAD and resolve it to a commit SHA-1.
 *
 * HEAD can be:
 * 1. A symbolic ref: "ref: refs/heads/main\n" → follow the ref
 * 2. A detached HEAD: "abc123...\n" → direct SHA-1
 *
 * @param {string} gitDir — path to the .git directory
 * @returns {{ hash: string, ref: string|null }} — commit hash + ref name (null if detached)
 */
function resolveHead(gitDir) {
  const headPath = path.join(gitDir, 'HEAD');

  if (!fs.existsSync(headPath)) {
    throw new GitXRayError(`HEAD file not found: ${headPath}`);
  }

  const content = fs.readFileSync(headPath, 'utf8').trim();

  // Case 1: symbolic ref
  if (content.startsWith('ref: ')) {
    const refName = content.slice(5).trim();
    const hash = resolveRef(gitDir, refName);
    if (!hash) {
      throw new GitXRayError(
        `HEAD points to ${refName} which cannot be resolved (empty repo or broken ref)`
      );
    }
    return { hash, ref: refName };
  }

  // Case 2: detached HEAD (direct hash)
  if (/^[0-9a-f]{40}$/i.test(content)) {
    return { hash: content.toLowerCase(), ref: null };
  }

  throw new GitXRayError(`Unexpected HEAD format: "${content}"`);
}

/**
 * Resolve a ref name (e.g., "refs/heads/main") to a SHA-1 hash.
 * Checks loose ref files first, then falls back to packed-refs.
 *
 * @param {string} gitDir
 * @param {string} refName — e.g., "refs/heads/main"
 * @returns {string|null} — 40-char hex SHA-1, or null if unresolvable
 */
function resolveRef(gitDir, refName) {
  // Try loose ref first
  const refPath = path.join(gitDir, refName);
  if (fs.existsSync(refPath)) {
    const content = fs.readFileSync(refPath, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(content)) {
      return content.toLowerCase();
    }
    // Could be another symbolic ref (rare but possible)
    if (content.startsWith('ref: ')) {
      return resolveRef(gitDir, content.slice(5).trim());
    }
  }

  // Try packed-refs
  return resolveFromPackedRefs(gitDir, refName);
}

/**
 * Look up a ref in the packed-refs file.
 *
 * packed-refs format:
 *   # comment lines
 *   <sha1> <refname>
 *   ^<sha1>           (peel line — points to the dereferenced object for tags)
 *
 * @param {string} gitDir
 * @param {string} refName
 * @returns {string|null}
 */
function resolveFromPackedRefs(gitDir, refName) {
  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (!fs.existsSync(packedRefsPath)) {
    return null;
  }

  const content = fs.readFileSync(packedRefsPath, 'utf8');
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip comments and peel lines
    if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === refName) {
      return parts[0].toLowerCase();
    }
  }

  return null;
}

/**
 * Get all branch tips (refs/heads/*) as { name, hash } pairs.
 * Reads from both loose refs and packed-refs.
 *
 * @param {string} gitDir
 * @returns {{ name: string, hash: string }[]}
 */
function getAllBranches(gitDir) {
  const branches = new Map(); // refName → hash (Map deduplicates loose vs packed)

  // 1. Read loose refs from refs/heads/
  const headsDir = path.join(gitDir, 'refs', 'heads');
  if (fs.existsSync(headsDir)) {
    walkRefsDir(headsDir, 'refs/heads', branches);
  }

  // 2. Read packed-refs for any branches not already found
  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (fs.existsSync(packedRefsPath)) {
    const content = fs.readFileSync(packedRefsPath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1].startsWith('refs/heads/')) {
        // Loose refs take precedence — only add if not already present
        if (!branches.has(parts[1])) {
          branches.set(parts[1], parts[0].toLowerCase());
        }
      }
    }
  }

  return Array.from(branches.entries()).map(([name, hash]) => ({
    name: name.replace('refs/heads/', ''),
    hash,
  }));
}

/**
 * Recursively walk a refs directory to collect all refs.
 * @param {string} dirPath — absolute path to the directory
 * @param {string} prefix — ref prefix (e.g., "refs/heads")
 * @param {Map<string, string>} result — accumulated results
 */
function walkRefsDir(dirPath, prefix, result) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const refName = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      walkRefsDir(fullPath, refName, result);
    } else if (entry.isFile()) {
      try {
        const hash = fs.readFileSync(fullPath, 'utf8').trim();
        if (/^[0-9a-f]{40}$/i.test(hash)) {
          result.set(refName, hash.toLowerCase());
        }
      } catch {
        // Skip unreadable ref files
      }
    }
  }
}

module.exports = { resolveHead, resolveRef, getAllBranches };
