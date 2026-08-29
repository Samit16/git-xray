'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { GitXRayError } = require('./locator.js');
const { readPackedObject, clearPackCache } = require('./pack.js');

/**
 * Convert a hex SHA-1 hash to its loose object file path.
 * @param {string} gitDir — path to the .git directory
 * @param {string} hash — 40-char hex SHA-1
 * @returns {string} — absolute path to the loose object file
 */
function hashToPath(gitDir, hash) {
  return path.join(gitDir, 'objects', hash.slice(0, 2), hash.slice(2));
}

/**
 * Check if a loose object exists for the given hash.
 * @param {string} gitDir
 * @param {string} hash
 * @returns {boolean}
 */
function looseObjectExists(gitDir, hash) {
  return fs.existsSync(hashToPath(gitDir, hash));
}

/**
 * Read and inflate a loose git object from disk.
 *
 * Loose object format (after zlib inflate):
 *   <type> <size>\0<content>
 *
 * @param {string} gitDir
 * @param {string} hash — 40-char hex SHA-1
 * @returns {{ type: string, size: number, body: Buffer }}
 */
function readLooseObject(gitDir, hash) {
  const objPath = hashToPath(gitDir, hash);

  if (!fs.existsSync(objPath)) {
    return null; // Object not found as loose — likely packed
  }

  let raw;
  try {
    const compressed = fs.readFileSync(objPath);
    raw = zlib.inflateSync(compressed);
  } catch (err) {
    throw new GitXRayError(
      `Failed to read/inflate object ${hash}: ${err.message}`
    );
  }

  // Verify SHA-1 integrity
  const actualHash = crypto.createHash('sha1').update(raw).digest('hex');
  if (actualHash !== hash) {
    throw new GitXRayError(
      `Object ${hash} failed integrity check (computed ${actualHash})`
    );
  }

  // Parse header: "<type> <size>\0"
  const nullIdx = raw.indexOf(0);
  if (nullIdx === -1) {
    throw new GitXRayError(`Malformed object ${hash}: missing null byte`);
  }

  const header = raw.subarray(0, nullIdx).toString('utf8');
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx === -1) {
    throw new GitXRayError(`Malformed object header in ${hash}: "${header}"`);
  }

  const type = header.slice(0, spaceIdx);
  const size = parseInt(header.slice(spaceIdx + 1), 10);
  const body = raw.subarray(nullIdx + 1);

  if (body.length !== size) {
    throw new GitXRayError(
      `Object ${hash} size mismatch: header says ${size}, body is ${body.length}`
    );
  }

  return { type, size, body };
}

/**
 * Parse a commit object body into structured data.
 *
 * Commit format (text, after the header):
 *   tree <tree-sha>\n
 *   parent <parent-sha>\n        (zero or more)
 *   author <name> <email> <ts> <tz>\n
 *   committer <name> <email> <ts> <tz>\n
 *   [gpgsig ...]\n               (optional, skip)
 *   \n
 *   <commit message>
 *
 * @param {string} hash — the commit's own hash
 * @param {Buffer} body — raw commit body (after type/size header)
 * @returns {ParsedCommit}
 */
function parseCommit(hash, body) {
  // Decode as UTF-8 with latin1 fallback
  let text;
  try {
    text = body.toString('utf8');
  } catch {
    text = body.toString('latin1');
  }

  const result = {
    hash,
    tree: null,
    parents: [],
    author: null,
    committer: null,
    message: '',
  };

  // Split header block from message at the first blank line
  const blankLineIdx = text.indexOf('\n\n');

  let headerBlock, messageBlock;
  if (blankLineIdx === -1) {
    // Edge case: commit with no message
    headerBlock = text;
    messageBlock = '';
  } else {
    headerBlock = text.slice(0, blankLineIdx);
    messageBlock = text.slice(blankLineIdx + 2);
  }

  result.message = messageBlock.trimEnd();

  // Parse header lines, handling multi-line fields (gpgsig)
  const lines = headerBlock.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('tree ')) {
      result.tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      result.parents.push(line.slice(7).trim());
    } else if (line.startsWith('author ')) {
      result.author = parseAuthorLine(line.slice(7));
    } else if (line.startsWith('committer ')) {
      result.committer = parseAuthorLine(line.slice(10));
    } else if (line.startsWith('gpgsig ') || line.startsWith('mergetag ')) {
      // Skip multi-line PGP signature / mergetag — continues while next line starts with space
      i++;
      while (i < lines.length && lines[i].startsWith(' ')) {
        i++;
      }
      continue; // Don't increment i again
    }
    // Ignore unknown header fields silently (encoding, etc.)
    i++;
  }

  if (!result.tree) {
    throw new GitXRayError(`Commit ${hash} missing tree field`);
  }

  return result;
}

/**
 * Parse an author/committer line.
 * Format: "Name <email> timestamp timezone"
 * Example: "Alice <alice@example.com> 1625000000 +0530"
 *
 * @param {string} line
 * @returns {{ name: string, email: string, timestamp: number, tz: string }}
 */
function parseAuthorLine(line) {
  // Match: everything up to < as name, then email in <>, then timestamp and tz
  const match = line.match(/^(.+?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})$/);
  if (!match) {
    // Fallback for malformed author lines
    return { name: line.trim(), email: '', timestamp: 0, tz: '+0000' };
  }

  return {
    name: match[1].trim(),
    email: match[2],
    timestamp: parseInt(match[3], 10),
    tz: match[4],
  };
}

/**
 * Parse a tree object body into an array of entries.
 *
 * Tree object binary format (repeated, NO delimiters between entries):
 *   <mode> <name>\0<20-byte-sha1>
 *
 * Where:
 * - mode is ASCII digits (e.g., "100644", "40000")
 * - name is the filename (UTF-8)
 * - The null byte terminates the name
 * - Immediately followed by 20 raw bytes of SHA-1 (NOT hex-encoded)
 *
 * @param {Buffer} body — raw tree body (after type/size header)
 * @returns {TreeEntry[]}
 */
function parseTree(body) {
  const entries = [];
  let offset = 0;

  while (offset < body.length) {
    // Find the space between mode and name
    const spaceIdx = body.indexOf(0x20, offset); // ASCII space
    if (spaceIdx === -1) {
      break; // Malformed, stop
    }
    const mode = body.subarray(offset, spaceIdx).toString('ascii');

    // Find the null byte after the name
    const nullIdx = body.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) {
      break; // Malformed, stop
    }
    const name = body.subarray(spaceIdx + 1, nullIdx).toString('utf8');

    // Read 20 raw bytes of SHA-1 hash
    const hashStart = nullIdx + 1;
    const hashEnd = hashStart + 20;
    if (hashEnd > body.length) {
      break; // Truncated
    }
    const hash = body.subarray(hashStart, hashEnd).toString('hex');

    entries.push({ mode, name, hash });
    offset = hashEnd;
  }

  return entries;
}

/**
 * Storage-agnostic object reader.
 * Tries to read the object as a loose object first. If not found,
 * searches all packfiles via IDX lookup.
 *
 * This is the primary API that the rest of Git X-Ray should use
 * for generic object access. readLooseObject() remains available
 * for callers that specifically need loose-only semantics.
 *
 * @param {string} gitDir — path to the .git directory
 * @param {string} hash — 40-char hex SHA-1
 * @param {number} [_depth] — internal: current delta chain depth (for REF_DELTA recursion)
 * @returns {{ type: string, size: number, body: Buffer } | null}
 */
function readObject(gitDir, hash, _depth) {
  // 1. Try loose object first (fast path)
  const loose = readLooseObject(gitDir, hash);
  if (loose) return loose;

  // 2. Try packed objects — pass readObject itself as the REF_DELTA resolver
  // so that REF_DELTA bases can be resolved from any storage location
  return readPackedObject(gitDir, hash, readObject, _depth || 0);
}

module.exports = {
  hashToPath,
  looseObjectExists,
  readLooseObject,
  readObject,
  parseCommit,
  parseTree,
  clearPackCache,
};
