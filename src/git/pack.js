'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { GitXRayError } = require('./locator.js');

// ─── Constants ────────────────────────────────────────────────────────────────

// IDX v2 magic bytes: 0xff 0x74 0x4f 0x63 (first 4 bytes)
const IDX_V2_MAGIC = Buffer.from([0xff, 0x74, 0x4f, 0x63]);

// PACK file magic bytes: 'PACK' (ASCII)
const PACK_MAGIC = Buffer.from('PACK', 'ascii');

// Git pack object type codes
const OBJ_COMMIT  = 1;
const OBJ_TREE    = 2;
const OBJ_BLOB    = 3;
const OBJ_TAG     = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

// Map type code → type string
const TYPE_NAMES = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]:   'tree',
  [OBJ_BLOB]:   'blob',
  [OBJ_TAG]:    'tag',
};

// Maximum delta chain depth to prevent infinite recursion
const MAX_DELTA_DEPTH = 50;

// ─── Pack Discovery ───────────────────────────────────────────────────────────

/**
 * Discover all packfile/index pairs in a git directory.
 * Scans .git/objects/pack/ for matching .pack + .idx files.
 *
 * @param {string} gitDir — path to the .git directory
 * @returns {{ idxPath: string, packPath: string }[]}
 */
function discoverPackFiles(gitDir) {
  const packDir = path.join(gitDir, 'objects', 'pack');

  if (!fs.existsSync(packDir)) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(packDir);
  } catch {
    return [];
  }

  // Collect all .pack files, then verify matching .idx exists
  const packs = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pack')) continue;

    const baseName = entry.slice(0, -5); // strip '.pack'
    const idxName = baseName + '.idx';

    const packPath = path.join(packDir, entry);
    const idxPath = path.join(packDir, idxName);

    if (fs.existsSync(idxPath)) {
      packs.push({ idxPath, packPath });
    }
    // If .idx is missing, skip silently — we can't efficiently look up objects
  }

  return packs;
}

// ─── IDX v2 Parser ────────────────────────────────────────────────────────────

/**
 * Parse a Git IDX v2 file into a lookup structure.
 *
 * IDX v2 layout:
 *   [0..3]     Magic: ff 74 4f 63
 *   [4..7]     Version: 00 00 00 02
 *   [8..1031]  Fanout table: 256 × 4-byte big-endian uint32
 *              fanout[i] = cumulative count of objects with first byte <= i
 *              fanout[255] = total object count
 *   [1032..]   SHA-1 table: N × 20 bytes (sorted)
 *   [..]       CRC32 table: N × 4 bytes (we skip this)
 *   [..]       Offset table: N × 4 bytes
 *              If MSB is set, the remaining 31 bits index into the large offset table
 *   [..]       Large offset table: M × 8 bytes (only if any offset > 2^31)
 *
 * @param {string} idxPath — path to the .idx file
 * @returns {ParsedIdx}
 */
function parseIdx(idxPath) {
  let buf;
  try {
    buf = fs.readFileSync(idxPath);
  } catch (err) {
    throw new GitXRayError(`Failed to read IDX file ${idxPath}: ${err.message}`);
  }

  // Validate minimum size: magic(4) + version(4) + fanout(1024) = 1032
  if (buf.length < 1032) {
    throw new GitXRayError(`IDX file too small: ${idxPath} (${buf.length} bytes)`);
  }

  // Validate magic
  if (!buf.subarray(0, 4).equals(IDX_V2_MAGIC)) {
    throw new GitXRayError(
      `Unsupported IDX format in ${idxPath}: expected v2 magic (ff744f63), ` +
      `got ${buf.subarray(0, 4).toString('hex')}`
    );
  }

  // Validate version
  const version = buf.readUInt32BE(4);
  if (version !== 2) {
    throw new GitXRayError(
      `Unsupported IDX version ${version} in ${idxPath} (only v2 is supported)`
    );
  }

  // Read fanout table (256 entries, 4 bytes each, at offset 8)
  const fanout = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    fanout[i] = buf.readUInt32BE(8 + i * 4);
  }

  const objectCount = fanout[255];

  // Compute section offsets
  const shaTableOffset = 1032;                                    // after fanout
  const crc32TableOffset = shaTableOffset + objectCount * 20;     // after SHA-1s
  const offsetTableOffset = crc32TableOffset + objectCount * 4;   // after CRC32s
  const largeOffsetTableOffset = offsetTableOffset + objectCount * 4;

  // Validate buffer size is large enough for all sections
  const minSize = offsetTableOffset + objectCount * 4;
  if (buf.length < minSize) {
    throw new GitXRayError(
      `IDX file ${idxPath} is truncated: expected at least ${minSize} bytes, got ${buf.length}`
    );
  }

  return {
    buffer: buf,
    fanout,
    objectCount,
    shaTableOffset,
    offsetTableOffset,
    largeOffsetTableOffset,
    idxPath,
  };
}

/**
 * Look up a SHA-1 hash in a parsed IDX file.
 * Uses the fanout table to narrow the search range, then binary searches.
 *
 * @param {ParsedIdx} idx — parsed IDX data
 * @param {string} hash — 40-char hex SHA-1
 * @returns {number|null} — pack offset, or null if not found
 */
function idxLookup(idx, hash) {
  const hashBuf = Buffer.from(hash, 'hex');
  const firstByte = hashBuf[0];

  // Use fanout to get the range of entries with this first byte
  const lo = firstByte === 0 ? 0 : idx.fanout[firstByte - 1];
  const hi = idx.fanout[firstByte];

  if (lo >= hi) {
    return null; // No objects with this first byte
  }

  // Binary search within the SHA-1 table
  let left = lo;
  let right = hi - 1;

  while (left <= right) {
    const mid = (left + right) >>> 1;
    const entrySha = idx.buffer.subarray(
      idx.shaTableOffset + mid * 20,
      idx.shaTableOffset + mid * 20 + 20
    );

    const cmp = Buffer.compare(hashBuf, entrySha);
    if (cmp === 0) {
      // Found — read the pack offset
      return readPackOffset(idx, mid);
    } else if (cmp < 0) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null; // Not found
}

/**
 * Read the pack offset for entry at index `entryIndex` from the IDX offset table.
 * Handles large offsets (MSB set → index into 8-byte large offset table).
 *
 * @param {ParsedIdx} idx
 * @param {number} entryIndex
 * @returns {number}
 */
function readPackOffset(idx, entryIndex) {
  const rawOffset = idx.buffer.readUInt32BE(
    idx.offsetTableOffset + entryIndex * 4
  );

  // If MSB is set, the remaining 31 bits are an index into the large offset table
  if (rawOffset & 0x80000000) {
    const largeIdx = rawOffset & 0x7fffffff;
    const largeOffset = idx.largeOffsetTableOffset + largeIdx * 8;

    // Read 8-byte big-endian offset
    // Node's readBigUInt64BE returns a BigInt; convert to Number
    // (safe for offsets up to ~9 PB which is well beyond any real packfile)
    const hi32 = idx.buffer.readUInt32BE(largeOffset);
    const lo32 = idx.buffer.readUInt32BE(largeOffset + 4);
    return hi32 * 0x100000000 + lo32;
  }

  return rawOffset;
}

// ─── Pack Object Reader ───────────────────────────────────────────────────────

/**
 * Read and validate a PACK file header.
 *
 * PACK header layout:
 *   [0..3]   Magic: 'PACK' (ASCII)
 *   [4..7]   Version: 2 or 3 (big-endian uint32)
 *   [8..11]  Object count (big-endian uint32)
 *
 * @param {Buffer} buf — pack file buffer (at least first 12 bytes)
 * @param {string} packPath — for error messages
 * @returns {{ version: number, objectCount: number }}
 */
function readPackHeader(buf, packPath) {
  if (buf.length < 12) {
    throw new GitXRayError(`PACK file too small: ${packPath} (${buf.length} bytes)`);
  }

  if (!buf.subarray(0, 4).equals(PACK_MAGIC)) {
    throw new GitXRayError(
      `Invalid PACK magic in ${packPath}: expected 'PACK', got '${buf.subarray(0, 4).toString('ascii')}'`
    );
  }

  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new GitXRayError(
      `Unsupported PACK version ${version} in ${packPath} (only v2/v3 supported)`
    );
  }

  const objectCount = buf.readUInt32BE(8);
  return { version, objectCount };
}

/**
 * Read a pack object at a given offset within a pack buffer.
 *
 * Pack object header encoding (variable-length):
 *   First byte:  MSB = continuation bit
 *                bits 6..4 = object type (3 bits)
 *                bits 3..0 = size (low 4 bits)
 *   Subsequent bytes: MSB = continuation, bits 6..0 = size (next 7 bits each)
 *
 * After the header, the data is zlib-compressed (for normal objects).
 *
 * @param {Buffer} packBuf — entire pack file buffer
 * @param {number} offset — byte offset of this object within the pack
 * @param {string} packPath — for error messages
 * @param {Function} resolveBase — function(gitDir, hash) for REF_DELTA base resolution
 * @param {string} gitDir — for REF_DELTA base resolution
 * @param {Set} [visiting] — set of offsets currently being resolved (cycle detection)
 * @param {number} [depth] — current delta chain depth
 * @returns {{ type: string, size: number, body: Buffer }}
 */
function readPackObject(packBuf, offset, packPath, resolveBase, gitDir, visiting, depth) {
  if (!visiting) visiting = new Set();
  if (!depth) depth = 0;

  if (depth > MAX_DELTA_DEPTH) {
    throw new GitXRayError(
      `Delta chain too deep (>${MAX_DELTA_DEPTH}) at offset ${offset} in ${packPath}`
    );
  }

  if (offset < 12 || offset >= packBuf.length) {
    throw new GitXRayError(
      `Invalid pack offset ${offset} in ${packPath} (file size: ${packBuf.length})`
    );
  }

  // Parse the variable-length object header
  let byte = packBuf[offset];
  const objType = (byte >> 4) & 0x07;  // bits 6..4
  let size = byte & 0x0f;              // bits 3..0
  let shift = 4;
  let pos = offset + 1;

  while (byte & 0x80) {  // continuation bit
    if (pos >= packBuf.length) {
      throw new GitXRayError(
        `Truncated object header at offset ${offset} in ${packPath}`
      );
    }
    byte = packBuf[pos++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }

  // Handle by object type
  if (objType >= OBJ_COMMIT && objType <= OBJ_TAG) {
    // Normal object — decompress zlib data
    return readNormalPackObject(packBuf, pos, objType, size, offset, packPath);
  }

  if (objType === OBJ_OFS_DELTA) {
    return readOfsDelta(packBuf, pos, offset, size, packPath, resolveBase, gitDir, visiting, depth);
  }

  if (objType === OBJ_REF_DELTA) {
    return readRefDelta(packBuf, pos, offset, size, packPath, resolveBase, gitDir, visiting, depth);
  }

  throw new GitXRayError(
    `Unknown pack object type ${objType} at offset ${offset} in ${packPath}`
  );
}

/**
 * Read a normal (non-delta) packed object.
 * Decompresses the zlib data starting at `dataOffset`.
 *
 * @param {Buffer} packBuf
 * @param {number} dataOffset — start of zlib-compressed data
 * @param {number} objType — type code (1-4)
 * @param {number} expectedSize — declared size from header
 * @param {number} objOffset — original object offset (for error messages)
 * @param {string} packPath
 * @returns {{ type: string, size: number, body: Buffer }}
 */
function readNormalPackObject(packBuf, dataOffset, objType, expectedSize, objOffset, packPath) {
  const typeName = TYPE_NAMES[objType];
  if (!typeName) {
    throw new GitXRayError(
      `Unknown normal object type ${objType} at offset ${objOffset} in ${packPath}`
    );
  }

  let body;
  try {
    // Decompress from dataOffset to end of buffer — zlib will stop at the
    // end of the compressed stream automatically
    body = zlib.inflateSync(packBuf.subarray(dataOffset));
  } catch (err) {
    throw new GitXRayError(
      `Failed to decompress pack object at offset ${objOffset} in ${packPath}: ${err.message}`
    );
  }

  if (body.length !== expectedSize) {
    throw new GitXRayError(
      `Pack object size mismatch at offset ${objOffset} in ${packPath}: ` +
      `header says ${expectedSize}, decompressed ${body.length}`
    );
  }

  return { type: typeName, size: body.length, body };
}

// ─── Delta Support (stubs for Checkpoint 2, full impl in Checkpoint 3) ──────

/**
 * Read an OFS_DELTA object. The delta identifies its base via a negative
 * offset from the current object's position in the pack.
 *
 * OFS_DELTA offset encoding (variable-length, after the object header):
 *   First byte: bits 6..0 = offset value (7 bits), MSB = continuation
 *   Subsequent bytes: each adds 7 more bits, but with +1 bias:
 *     offset = ((offset + 1) << 7) | (byte & 0x7f)
 *
 * After the offset, the remaining data is the zlib-compressed delta.
 */
function readOfsDelta(packBuf, pos, objOffset, deltaSize, packPath, resolveBase, gitDir, visiting, depth) {
  // Decode the variable-length negative offset
  let byte = packBuf[pos++];
  let baseOffset = byte & 0x7f;

  while (byte & 0x80) {
    if (pos >= packBuf.length) {
      throw new GitXRayError(
        `Truncated OFS_DELTA offset at offset ${objOffset} in ${packPath}`
      );
    }
    byte = packBuf[pos++];
    // The +1 bias is critical for Git's encoding
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }

  const basePackOffset = objOffset - baseOffset;
  if (basePackOffset < 12) {
    throw new GitXRayError(
      `OFS_DELTA at offset ${objOffset} points to invalid base offset ${basePackOffset} in ${packPath}`
    );
  }

  // Cycle detection
  if (visiting.has(basePackOffset)) {
    throw new GitXRayError(
      `Circular OFS_DELTA reference detected at offset ${objOffset} in ${packPath}`
    );
  }

  visiting.add(objOffset);

  // Recursively resolve the base object from the pack
  const baseObj = readPackObject(packBuf, basePackOffset, packPath, resolveBase, gitDir, visiting, depth + 1);

  // Decompress the delta instructions
  let deltaData;
  try {
    deltaData = zlib.inflateSync(packBuf.subarray(pos));
  } catch (err) {
    throw new GitXRayError(
      `Failed to decompress OFS_DELTA data at offset ${objOffset} in ${packPath}: ${err.message}`
    );
  }

  // Apply delta to reconstruct the target object
  const resultBody = applyDelta(baseObj.body, deltaData, objOffset, packPath);

  return { type: baseObj.type, size: resultBody.length, body: resultBody };
}

/**
 * Read a REF_DELTA object. The delta identifies its base via a 20-byte SHA-1.
 * The base object may be anywhere (loose, in this pack, or in another pack).
 */
function readRefDelta(packBuf, pos, objOffset, deltaSize, packPath, resolveBase, gitDir, visiting, depth) {
  // Read the 20-byte base SHA-1
  if (pos + 20 > packBuf.length) {
    throw new GitXRayError(
      `Truncated REF_DELTA base hash at offset ${objOffset} in ${packPath}`
    );
  }

  const baseHash = packBuf.subarray(pos, pos + 20).toString('hex');
  pos += 20;

  // Resolve the base object via the general readObject path
  if (!resolveBase) {
    throw new GitXRayError(
      `REF_DELTA at offset ${objOffset} in ${packPath} requires base ${baseHash} but no resolver provided`
    );
  }

  const baseObj = resolveBase(gitDir, baseHash, depth + 1);
  if (!baseObj) {
    throw new GitXRayError(
      `REF_DELTA at offset ${objOffset} in ${packPath}: base object ${baseHash} not found`
    );
  }

  // Decompress the delta instructions
  let deltaData;
  try {
    deltaData = zlib.inflateSync(packBuf.subarray(pos));
  } catch (err) {
    throw new GitXRayError(
      `Failed to decompress REF_DELTA data at offset ${objOffset} in ${packPath}: ${err.message}`
    );
  }

  // Apply delta
  const resultBody = applyDelta(baseObj.body, deltaData, objOffset, packPath);

  return { type: baseObj.type, size: resultBody.length, body: resultBody };
}

// ─── Delta Instruction Decoder ────────────────────────────────────────────────

/**
 * Read a variable-length size from delta data.
 * Used for base size and result size at the start of delta instructions.
 *
 * Encoding: each byte contributes 7 bits; MSB = continuation.
 *
 * @param {Buffer} buf
 * @param {number} pos — current position
 * @returns {{ value: number, pos: number }} — the decoded value and new position
 */
function readDeltaSize(buf, pos) {
  let value = 0;
  let shift = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pos >= buf.length) {
      return { value, pos };
    }
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }

  return { value, pos };
}

/**
 * Apply a Git delta to a base object to produce the result object.
 *
 * Delta format:
 *   1. Base object size (variable-length encoded)
 *   2. Result object size (variable-length encoded)
 *   3. Instruction stream:
 *      - If MSB = 0: INSERT instruction
 *        Next (byte & 0x7f) bytes are literal data to insert.
 *        A size of 0 is invalid.
 *      - If MSB = 1: COPY instruction
 *        The lower 7 bits indicate which offset/size bytes follow:
 *        bits 0-3: offset bytes (1, 2, 3, 4 → byte positions 0, 8, 16, 24)
 *        bits 4-6: size bytes (1, 2, 3 → byte positions 0, 8, 16)
 *        If encoded size is 0, it means 0x10000 (65536).
 *
 * @param {Buffer} base — base object body
 * @param {Buffer} delta — decompressed delta instruction data
 * @param {number} objOffset — pack offset (for error messages)
 * @param {string} packPath — for error messages
 * @returns {Buffer} — reconstructed result object body
 */
function applyDelta(base, delta, objOffset, packPath) {
  let pos = 0;

  // Read base size
  const baseSizeResult = readDeltaSize(delta, pos);
  pos = baseSizeResult.pos;
  const declaredBaseSize = baseSizeResult.value;

  // Read result size
  const resultSizeResult = readDeltaSize(delta, pos);
  pos = resultSizeResult.pos;
  const declaredResultSize = resultSizeResult.value;

  // Validate base size
  if (declaredBaseSize !== base.length) {
    throw new GitXRayError(
      `Delta base size mismatch at offset ${objOffset} in ${packPath}: ` +
      `delta says ${declaredBaseSize}, actual base is ${base.length}`
    );
  }

  // Pre-allocate result buffer
  const result = Buffer.allocUnsafe(declaredResultSize);
  let resultPos = 0;

  // Process instruction stream
  while (pos < delta.length) {
    const cmd = delta[pos++];

    if (cmd & 0x80) {
      // COPY instruction — copy bytes from base object
      let copyOffset = 0;
      let copySize = 0;

      // Read offset bytes (bits 0-3 of cmd indicate which bytes are present)
      if (cmd & 0x01) copyOffset  = delta[pos++];
      if (cmd & 0x02) copyOffset |= delta[pos++] << 8;
      if (cmd & 0x04) copyOffset |= delta[pos++] << 16;
      if (cmd & 0x08) copyOffset |= delta[pos++] << 24;

      // Read size bytes (bits 4-6 of cmd indicate which bytes are present)
      if (cmd & 0x10) copySize  = delta[pos++];
      if (cmd & 0x20) copySize |= delta[pos++] << 8;
      if (cmd & 0x40) copySize |= delta[pos++] << 16;

      // Size of 0 means 0x10000 (65536) per Git spec
      if (copySize === 0) copySize = 0x10000;

      // Bounds check
      if (copyOffset + copySize > base.length) {
        throw new GitXRayError(
          `Delta COPY out of bounds at offset ${objOffset} in ${packPath}: ` +
          `copying ${copySize} bytes from base offset ${copyOffset}, but base is ${base.length} bytes`
        );
      }

      base.copy(result, resultPos, copyOffset, copyOffset + copySize);
      resultPos += copySize;

    } else if (cmd > 0) {
      // INSERT instruction — insert literal bytes from delta
      const insertSize = cmd; // lower 7 bits (MSB is 0, so cmd IS the size)

      if (pos + insertSize > delta.length) {
        throw new GitXRayError(
          `Delta INSERT truncated at offset ${objOffset} in ${packPath}: ` +
          `wants ${insertSize} bytes but only ${delta.length - pos} remain`
        );
      }

      delta.copy(result, resultPos, pos, pos + insertSize);
      pos += insertSize;
      resultPos += insertSize;

    } else {
      // cmd === 0: reserved/invalid instruction
      throw new GitXRayError(
        `Invalid delta instruction (0x00) at offset ${objOffset} in ${packPath}`
      );
    }
  }

  // Validate result size
  if (resultPos !== declaredResultSize) {
    throw new GitXRayError(
      `Delta result size mismatch at offset ${objOffset} in ${packPath}: ` +
      `declared ${declaredResultSize}, reconstructed ${resultPos}`
    );
  }

  return result;
}

// ─── High-Level Packed Object Reader ──────────────────────────────────────────

// Cache parsed IDX files to avoid re-parsing for every object lookup
let _idxCache = null;
let _idxCacheGitDir = null;
let _packBufCache = new Map();

/**
 * Get or create cached IDX data for a gitDir.
 * @param {string} gitDir
 * @returns {{ idx: ParsedIdx, packPath: string }[]}
 */
function getPackIndices(gitDir) {
  if (_idxCacheGitDir === gitDir && _idxCache) {
    return _idxCache;
  }

  const packFiles = discoverPackFiles(gitDir);
  const indices = [];

  for (const { idxPath, packPath } of packFiles) {
    try {
      const idx = parseIdx(idxPath);
      indices.push({ idx, packPath });
    } catch (err) {
      // If an IDX is malformed, skip it but don't crash the whole analysis
      if (err instanceof GitXRayError) {
        continue;
      }
      throw err;
    }
  }

  _idxCache = indices;
  _idxCacheGitDir = gitDir;
  return indices;
}

/**
 * Get or cache a pack file buffer.
 * @param {string} packPath
 * @returns {Buffer}
 */
function getPackBuffer(packPath) {
  if (_packBufCache.has(packPath)) {
    return _packBufCache.get(packPath);
  }

  let buf;
  try {
    buf = fs.readFileSync(packPath);
  } catch (err) {
    throw new GitXRayError(`Failed to read pack file ${packPath}: ${err.message}`);
  }

  // Validate pack header
  readPackHeader(buf, packPath);

  _packBufCache.set(packPath, buf);
  return buf;
}

/**
 * Read an object from packfiles.
 * Searches all IDX files for the hash, then reads from the corresponding pack.
 *
 * @param {string} gitDir — path to the .git directory
 * @param {string} hash — 40-char hex SHA-1
 * @param {Function} [resolveBase] — resolver for REF_DELTA bases (usually readObject)
 * @param {number} [depth] — current delta chain depth
 * @returns {{ type: string, size: number, body: Buffer } | null}
 */
function readPackedObject(gitDir, hash, resolveBase, depth) {
  const indices = getPackIndices(gitDir);

  for (const { idx, packPath } of indices) {
    const offset = idxLookup(idx, hash);
    if (offset === null) continue;

    // Found in this pack — read the object
    const packBuf = getPackBuffer(packPath);
    const visiting = new Set();
    return readPackObject(packBuf, offset, packPath, resolveBase, gitDir, visiting, depth || 0);
  }

  return null; // Not found in any pack
}

/**
 * Clear internal caches. Useful for testing when analyzing multiple repos.
 */
function clearPackCache() {
  _idxCache = null;
  _idxCacheGitDir = null;
  _packBufCache = new Map();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  discoverPackFiles,
  parseIdx,
  idxLookup,
  readPackHeader,
  readPackObject,
  readPackedObject,
  applyDelta,
  clearPackCache,
  // Constants for testing
  OBJ_COMMIT,
  OBJ_TREE,
  OBJ_BLOB,
  OBJ_TAG,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  MAX_DELTA_DEPTH,
};
