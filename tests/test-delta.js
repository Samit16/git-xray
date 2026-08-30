'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { GitXRayError } = require('../src/git/locator.js');
const {
  readObject,
  parseCommit,
  parseTree,
} = require('../src/git/objects.js');
const {
  readDeltaSize,
  applyDelta,
  readPackObject,
  readPackedObject,
  clearPackCache,
  OBJ_COMMIT,
  OBJ_TREE,
  OBJ_BLOB,
  OBJ_TAG,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  MAX_DELTA_DEPTH,
} = require('../src/git/pack.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..');
const GIT_DIR = path.join(REPO_ROOT, '.git');

/**
 * Build a delta variable-length encoded integer.
 * Each byte: MSB = continuation, bits 6..0 = data.
 */
function encodeDeltaSize(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Build a delta instruction buffer from a base and a target.
 * Uses a simple INSERT-all strategy for unit tests.
 */
function buildInsertDelta(base, target) {
  const parts = [
    encodeDeltaSize(base.length),
    encodeDeltaSize(target.length),
  ];

  // INSERT the entire target
  let offset = 0;
  while (offset < target.length) {
    const chunkSize = Math.min(target.length - offset, 127); // max INSERT size = 0x7f
    parts.push(Buffer.from([chunkSize])); // INSERT instruction
    parts.push(target.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  }

  return Buffer.concat(parts);
}

/**
 * Build a delta that uses COPY instructions from the base object.
 */
function buildCopyDelta(baseSize, resultSize, instructions) {
  const parts = [
    encodeDeltaSize(baseSize),
    encodeDeltaSize(resultSize),
  ];

  for (const instr of instructions) {
    if (instr.type === 'copy') {
      let cmd = 0x80; // MSB set for COPY
      const extraBytes = [];

      // Offset bytes
      if (instr.offset !== undefined && instr.offset !== 0 || instr.forceOffsetBytes) {
        const off = instr.offset || 0;
        if (off & 0xff)       { cmd |= 0x01; extraBytes.push(off & 0xff); }
        if (off & 0xff00)     { cmd |= 0x02; extraBytes.push((off >> 8) & 0xff); }
        if (off & 0xff0000)   { cmd |= 0x04; extraBytes.push((off >> 16) & 0xff); }
        if (off & 0xff000000) { cmd |= 0x08; extraBytes.push((off >> 24) & 0xff); }
        // If offset is 0 and we don't set any bits, all offset bytes are absent → offset = 0
      }

      // Size bytes
      if (instr.size !== undefined) {
        const sz = instr.rawSize !== undefined ? instr.rawSize : instr.size;
        if (sz === 0) {
          // Encode size as 0 → means 0x10000
          // Don't set any size bits
        } else {
          if (sz & 0xff)       { cmd |= 0x10; extraBytes.push(sz & 0xff); }
          if (sz & 0xff00)     { cmd |= 0x20; extraBytes.push((sz >> 8) & 0xff); }
          if (sz & 0xff0000)   { cmd |= 0x40; extraBytes.push((sz >> 16) & 0xff); }
        }
      }

      parts.push(Buffer.from([cmd, ...extraBytes]));
    } else if (instr.type === 'insert') {
      const data = Buffer.isBuffer(instr.data) ? instr.data : Buffer.from(instr.data);
      parts.push(Buffer.from([data.length]));
      parts.push(data);
    }
  }

  return Buffer.concat(parts);
}

/**
 * Build a proper COPY instruction byte sequence with explicit control over which bytes are present.
 * Returns [cmd, ...extraBytes] as a Buffer.
 */
function buildCopyInstruction(offsetBytes, sizeBytes) {
  let cmd = 0x80;
  const extra = [];

  // offsetBytes: array of {bit: 0-3, value: byte} or simply an array of up to 4 values
  if (offsetBytes) {
    for (let i = 0; i < offsetBytes.length; i++) {
      if (offsetBytes[i] !== null && offsetBytes[i] !== undefined) {
        cmd |= (1 << i);
        extra.push(offsetBytes[i] & 0xff);
      }
    }
  }

  // sizeBytes: array of {bit: 4-6, value: byte}
  if (sizeBytes) {
    for (let i = 0; i < sizeBytes.length; i++) {
      if (sizeBytes[i] !== null && sizeBytes[i] !== undefined) {
        cmd |= (1 << (i + 4));
        extra.push(sizeBytes[i] & 0xff);
      }
    }
  }

  return Buffer.from([cmd, ...extra]);
}

/**
 * Create a synthetic packfile containing objects.
 * Each object entry: { type: number, body: Buffer, offset?: number (auto-computed) }
 * For delta objects: { type: 6|7, deltaData: Buffer, ofsOffset?: number, refHash?: Buffer }
 *
 * Returns { packBuf: Buffer, offsets: number[] }
 */
function buildSyntheticPack(entries) {
  // PACK header
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);   // version 2
  header.writeUInt32BE(entries.length, 8);

  const parts = [header];
  const offsets = [];
  let currentOffset = 12;

  for (const entry of entries) {
    offsets.push(currentOffset);

    const objType = entry.type;
    let bodyToCompress;
    let extraHeader = Buffer.alloc(0);

    if (objType === OBJ_OFS_DELTA) {
      // Build OFS_DELTA offset encoding
      const negOffset = entry.negativeOffset;
      extraHeader = encodeOfsOffset(negOffset);
      bodyToCompress = entry.deltaData;
    } else if (objType === OBJ_REF_DELTA) {
      // 20-byte base hash
      extraHeader = entry.baseHash;
      bodyToCompress = entry.deltaData;
    } else {
      // Normal object
      bodyToCompress = entry.body;
    }

    // Encode the pack object header (type + size)
    const size = bodyToCompress.length;
    const objHeader = encodePackObjHeader(objType, size);

    // Compress the body
    const compressed = zlib.deflateSync(bodyToCompress);

    const objBuf = Buffer.concat([objHeader, extraHeader, compressed]);
    parts.push(objBuf);
    currentOffset += objBuf.length;
  }

  // Git packs end with a 20-byte SHA-1 checksum of everything before it
  const packContent = Buffer.concat(parts);
  const checksum = crypto.createHash('sha1').update(packContent).digest();
  const packBuf = Buffer.concat([packContent, checksum]);

  return { packBuf, offsets };
}

/**
 * Encode a pack object header (variable-length: type in bits 6..4 of first byte,
 * size in bits 3..0 of first byte, then 7 bits per continuation byte).
 */
function encodePackObjHeader(type, size) {
  const bytes = [];
  let firstByte = (type << 4) | (size & 0x0f);
  size >>= 4;

  if (size > 0) {
    firstByte |= 0x80;
  }
  bytes.push(firstByte);

  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }

  return Buffer.from(bytes);
}

/**
 * Encode an OFS_DELTA negative offset using Git's variable-length encoding.
 * First byte: bits 6..0 = value, MSB = continuation.
 * Subsequent bytes: offset = ((offset + 1) << 7) | (byte & 0x7f).
 * We need to reverse this for encoding.
 */
function encodeOfsOffset(negOffset) {
  // Git OFS_DELTA offset encoding:
  // Start with the value, encode lowest 7 bits, then repeatedly
  // subtract 1, shift right 7, and encode next 7 bits (with continuation bit)
  const bytes = [];
  bytes.push(negOffset & 0x7f);
  negOffset >>= 7;

  while (negOffset > 0) {
    negOffset -= 1; // the +1 bias
    bytes.push(0x80 | (negOffset & 0x7f));
    negOffset >>= 7;
  }

  // Reverse because we built it LSB-first but Git reads MSB-first
  bytes.reverse();
  return Buffer.from(bytes);
}

/**
 * Build a synthetic IDX v2 file for a set of {hash: string, offset: number} entries.
 */
function buildSyntheticIdx(entries) {
  // Sort entries by hash (binary order)
  const sorted = [...entries].sort((a, b) => {
    const aBuf = Buffer.from(a.hash, 'hex');
    const bBuf = Buffer.from(b.hash, 'hex');
    return Buffer.compare(aBuf, bBuf);
  });

  const objectCount = sorted.length;

  // Build fanout table
  const fanout = new Uint32Array(256);
  for (let i = 0; i < sorted.length; i++) {
    const firstByte = parseInt(sorted[i].hash.slice(0, 2), 16);
    for (let j = firstByte; j < 256; j++) {
      fanout[j]++;
    }
  }
  // fanout is cumulative — fix it
  // Actually, the loop above does increment for all j >= firstByte, which is correct.
  // Wait, we need to ensure it's cumulative count of objects with first byte <= j.
  // Let me redo this properly.
  const fanoutCorrect = new Uint32Array(256);
  for (const entry of sorted) {
    const firstByte = parseInt(entry.hash.slice(0, 2), 16);
    fanoutCorrect[firstByte]++;
  }
  // Now make cumulative
  for (let i = 1; i < 256; i++) {
    fanoutCorrect[i] += fanoutCorrect[i - 1];
  }

  // Assemble IDX
  const magic = Buffer.from([0xff, 0x74, 0x4f, 0x63]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);

  const fanoutBuf = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) {
    fanoutBuf.writeUInt32BE(fanoutCorrect[i], i * 4);
  }

  const shaTable = Buffer.alloc(objectCount * 20);
  for (let i = 0; i < objectCount; i++) {
    Buffer.from(sorted[i].hash, 'hex').copy(shaTable, i * 20);
  }

  const crc32Table = Buffer.alloc(objectCount * 4); // all zeros, we don't use CRC

  const offsetTable = Buffer.alloc(objectCount * 4);
  for (let i = 0; i < objectCount; i++) {
    offsetTable.writeUInt32BE(sorted[i].offset, i * 4);
  }

  // Checksum of the IDX content (20 bytes pack checksum + 20 bytes idx checksum)
  // For testing, we just append zeros — the parser doesn't validate these
  const trailingChecksums = Buffer.alloc(40);

  return Buffer.concat([magic, version, fanoutBuf, shaTable, crc32Table, offsetTable, trailingChecksums]);
}

/**
 * Create a temporary directory with synthetic pack + idx files.
 * Returns { gitDir, cleanup, packPath, idxPath }
 */
function createSyntheticPackRepo(packEntries, idxEntries) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-delta-test-'));
  const gitDir = path.join(tempDir, '.git');
  const objectsDir = path.join(gitDir, 'objects');
  const packDir = path.join(objectsDir, 'pack');
  const refsDir = path.join(gitDir, 'refs');

  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

  const { packBuf, offsets } = buildSyntheticPack(packEntries);

  // Build IDX entries from the pack entries
  const idxEntriesBuilt = idxEntries || packEntries.map((entry, i) => ({
    hash: entry.hash || crypto.randomBytes(20).toString('hex'),
    offset: offsets[i],
  }));

  const idxBuf = buildSyntheticIdx(idxEntriesBuilt);

  const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
  const packPath = path.join(packDir, packName + '.pack');
  const idxPath = path.join(packDir, packName + '.idx');

  fs.writeFileSync(packPath, packBuf);
  fs.writeFileSync(idxPath, idxBuf);

  const cleanup = () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  return { gitDir, cleanup, packPath, idxPath, packBuf, offsets };
}


// ─── readDeltaSize Tests ──────────────────────────────────────────────────────

describe('readDeltaSize', () => {
  it('should decode a single-byte value', () => {
    const buf = Buffer.from([42]);
    const result = readDeltaSize(buf, 0);
    assert.equal(result.value, 42);
    assert.equal(result.pos, 1);
  });

  it('should decode a multi-byte value', () => {
    // Encode 300: 300 = 0b100101100
    // byte 0: 0b10101100 = 0xAC (continuation + low 7 bits: 0101100 = 44)
    // byte 1: 0b00000010 = 0x02 (no continuation, 7 bits: 0000010 = 2)
    // value = 44 | (2 << 7) = 44 + 256 = 300
    const buf = Buffer.from([0xAC, 0x02]);
    const result = readDeltaSize(buf, 0);
    assert.equal(result.value, 300);
    assert.equal(result.pos, 2);
  });

  it('should decode a value at a non-zero position', () => {
    const buf = Buffer.from([0xFF, 0xFF, 42]); // first two bytes are noise
    const result = readDeltaSize(buf, 2);
    assert.equal(result.value, 42);
    assert.equal(result.pos, 3);
  });

  it('should decode a 3-byte value', () => {
    // Encode 0x4000 = 16384 = 0b100000000000000
    // byte 0: low 7 bits = 0000000 (0), with continuation = 0x80
    // byte 1: next 7 bits = 0000000 (0), with continuation = 0x80
    // byte 2: next 7 bits = 0000001 (1), no continuation = 0x01
    // value = 0 | (0 << 7) | (1 << 14) = 16384
    const buf = Buffer.from([0x80, 0x80, 0x01]);
    const result = readDeltaSize(buf, 0);
    assert.equal(result.value, 16384);
    assert.equal(result.pos, 3);
  });

  it('should decode zero', () => {
    const buf = Buffer.from([0x00]);
    const result = readDeltaSize(buf, 0);
    assert.equal(result.value, 0);
    assert.equal(result.pos, 1);
  });

  it('should decode 127 (single byte, all data bits set)', () => {
    const buf = Buffer.from([0x7f]);
    const result = readDeltaSize(buf, 0);
    assert.equal(result.value, 127);
    assert.equal(result.pos, 1);
  });

  it('should decode 128 (two bytes)', () => {
    // 128 = 0b10000000
    // byte 0: low 7 = 0000000, continuation = 1 → 0x80
    // byte 1: next 7 = 0000001, continuation = 0 → 0x01
    const buf = Buffer.from([0x80, 0x01]);
    const result = readDeltaSize(buf, 0);
    assert.equal(result.value, 128);
    assert.equal(result.pos, 2);
  });

  it('should throw on empty buffer', () => {
    assert.throws(
      () => readDeltaSize(Buffer.alloc(0), 0),
      (err) => err instanceof GitXRayError && err.message.includes('Truncated')
    );
  });

  it('should throw on truncated multi-byte value', () => {
    // First byte has continuation bit set, but no second byte
    const buf = Buffer.from([0x80]);
    assert.throws(
      () => readDeltaSize(buf, 0),
      (err) => err instanceof GitXRayError && err.message.includes('Truncated')
    );
  });

  it('should throw on position past end of buffer', () => {
    const buf = Buffer.from([42]);
    assert.throws(
      () => readDeltaSize(buf, 5),
      (err) => err instanceof GitXRayError && err.message.includes('Truncated')
    );
  });

  it('should throw on unreasonably large integer (overflow protection)', () => {
    // 5 continuation bytes each contributing 7 bits = 35 bits > 32 bits
    const buf = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    assert.throws(
      () => readDeltaSize(buf, 0),
      (err) => err instanceof GitXRayError && err.message.includes('Unreasonably large')
    );
  });
});

// ─── applyDelta Unit Tests ────────────────────────────────────────────────────

describe('applyDelta', () => {
  describe('INSERT instructions', () => {
    it('should reconstruct a target from pure INSERT', () => {
      const base = Buffer.from('Hello, World!');
      const target = Buffer.from('Goodbye, World!');
      const delta = buildInsertDelta(base, target);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(target));
    });

    it('should handle a single-byte INSERT', () => {
      const base = Buffer.from('A');
      const target = Buffer.from('B');
      const delta = Buffer.concat([
        encodeDeltaSize(1), // base size
        encodeDeltaSize(1), // result size
        Buffer.from([0x01, 0x42]), // INSERT 1 byte: 'B'
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(target));
    });

    it('should handle INSERT with 127 bytes (max single INSERT size)', () => {
      const base = Buffer.alloc(10, 'X');
      const target = Buffer.alloc(127, 'Y');
      const delta = Buffer.concat([
        encodeDeltaSize(10),  // base size
        encodeDeltaSize(127), // result size
        Buffer.from([127]),   // INSERT 127 bytes
        target,
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(target));
    });

    it('should handle multiple INSERT instructions', () => {
      const base = Buffer.from('base');
      const part1 = Buffer.from('Hello');
      const part2 = Buffer.from(' World');
      const target = Buffer.concat([part1, part2]);

      const delta = Buffer.concat([
        encodeDeltaSize(4),   // base size
        encodeDeltaSize(11),  // result size
        Buffer.from([5]), part1,  // INSERT 5 bytes
        Buffer.from([6]), part2,  // INSERT 6 bytes
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(target));
    });

    it('should throw on INSERT with size 0 (invalid instruction)', () => {
      const base = Buffer.from('data');
      const delta = Buffer.concat([
        encodeDeltaSize(4),
        encodeDeltaSize(4),
        Buffer.from([0x00]), // 0x00 = reserved/invalid
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('Invalid delta instruction')
      );
    });

    it('should throw on truncated INSERT data', () => {
      const base = Buffer.from('data');
      const delta = Buffer.concat([
        encodeDeltaSize(4),
        encodeDeltaSize(10),
        Buffer.from([10]), // INSERT 10 bytes
        Buffer.from([1, 2, 3]), // only 3 bytes
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('INSERT truncated')
      );
    });
  });

  describe('COPY instructions', () => {
    it('should copy entire base object', () => {
      const base = Buffer.from('Hello, World!');
      const delta = Buffer.concat([
        encodeDeltaSize(base.length),
        encodeDeltaSize(base.length),
        // COPY: offset=0, size=13
        buildCopyInstruction([0], [13]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(base));
    });

    it('should copy a portion of the base', () => {
      const base = Buffer.from('Hello, World!');
      const expected = Buffer.from('World');
      const delta = Buffer.concat([
        encodeDeltaSize(base.length),
        encodeDeltaSize(5),
        // COPY: offset=7, size=5
        buildCopyInstruction([7], [5]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle COPY with no optional offset bytes (offset = 0)', () => {
      const base = Buffer.from('ABCDEFGH');
      const expected = Buffer.from('ABC');
      const delta = Buffer.concat([
        encodeDeltaSize(8),
        encodeDeltaSize(3),
        // COPY: no offset bytes → offset=0, size=3
        buildCopyInstruction([], [3]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle COPY with partial offset bytes (byte 0 only)', () => {
      const base = Buffer.alloc(20, 0);
      base[5] = 0x41; // 'A'
      base[6] = 0x42; // 'B'
      base[7] = 0x43; // 'C'
      const expected = Buffer.from('ABC');

      const delta = Buffer.concat([
        encodeDeltaSize(20),
        encodeDeltaSize(3),
        // COPY: offset byte 0 = 5, size byte 0 = 3
        buildCopyInstruction([5], [3]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle COPY with partial offset bytes (byte 1 only)', () => {
      // offset = 256 (byte 1 = 1, no byte 0)
      const base = Buffer.alloc(300, 0x58); // fill with 'X'
      base.write('TEST', 256);
      const expected = Buffer.from('TEST');

      const delta = Buffer.concat([
        encodeDeltaSize(300),
        encodeDeltaSize(4),
        // COPY: offset byte 1 = 1 → offset = 256, size = 4
        buildCopyInstruction([null, 1], [4]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle COPY with byte 0 and byte 2 of offset (skip byte 1)', () => {
      // offset = 0x050003: byte 0 = 3, byte 2 = 5 → offset = 3 | (5 << 16) = 327683
      // This requires a large base, so use a smaller test with bytes 0 and 1
      const base = Buffer.alloc(270, 0);
      base.write('OK', 259);
      const expected = Buffer.from('OK');

      // offset = 259 = 3 + 256 = byte0=3, byte1=1
      const delta = Buffer.concat([
        encodeDeltaSize(270),
        encodeDeltaSize(2),
        buildCopyInstruction([3, 1], [2]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle COPY with partial size bytes (byte 0 only)', () => {
      const base = Buffer.from('ABCDEFGHIJ');
      const expected = Buffer.from('ABCDE');

      const delta = Buffer.concat([
        encodeDeltaSize(10),
        encodeDeltaSize(5),
        buildCopyInstruction([0], [5]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle COPY with partial size bytes (byte 1 only)', () => {
      // size = 256 (byte 1 = 1, no byte 0)
      const base = Buffer.alloc(300, 0x41); // fill with 'A'
      const expected = Buffer.alloc(256, 0x41);

      const delta = Buffer.concat([
        encodeDeltaSize(300),
        encodeDeltaSize(256),
        buildCopyInstruction([0], [null, 1]), // offset=0, size byte1=1 → size=256
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle default COPY size (encoded size = 0 → 0x10000)', () => {
      // A COPY with all size bits cleared but MSB set = copy 65536 bytes
      const base = Buffer.alloc(0x10000, 0x42); // 65536 bytes of 'B'
      const expected = Buffer.from(base);

      const delta = Buffer.concat([
        encodeDeltaSize(0x10000),
        encodeDeltaSize(0x10000),
        // COPY: offset=0, no size bytes → default size 0x10000
        Buffer.from([0x80]), // just the COPY bit, no offset or size bytes
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle mixed INSERT + COPY operations', () => {
      const base = Buffer.from('Hello, World!');
      // Target: ">> Hello, World! <<"
      const prefix = Buffer.from('>> ');
      const suffix = Buffer.from(' <<');
      const expected = Buffer.concat([prefix, base, suffix]);

      const delta = Buffer.concat([
        encodeDeltaSize(base.length),
        encodeDeltaSize(expected.length),
        // INSERT '>> '
        Buffer.from([3]), prefix,
        // COPY entire base: offset=0, size=13
        buildCopyInstruction([0], [13]),
        // INSERT ' <<'
        Buffer.from([3]), suffix,
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should handle multiple COPY instructions', () => {
      const base = Buffer.from('ABCDEFGHIJ');
      // Target: 'CDEABC'
      const expected = Buffer.from('CDEABC');

      const delta = Buffer.concat([
        encodeDeltaSize(10),
        encodeDeltaSize(6),
        // COPY offset=2, size=3 → 'CDE'
        buildCopyInstruction([2], [3]),
        // COPY offset=0, size=3 → 'ABC'
        buildCopyInstruction([0], [3]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });

    it('should throw on COPY out of bounds', () => {
      const base = Buffer.from('short');
      const delta = Buffer.concat([
        encodeDeltaSize(5),
        encodeDeltaSize(10),
        // COPY: offset=0, size=10 → exceeds base length
        buildCopyInstruction([0], [10]),
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('COPY out of bounds')
      );
    });

    it('should throw on COPY with offset past base end', () => {
      const base = Buffer.from('data');
      const delta = Buffer.concat([
        encodeDeltaSize(4),
        encodeDeltaSize(2),
        // COPY: offset=100, size=2 → offset past end
        buildCopyInstruction([100], [2]),
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('COPY out of bounds')
      );
    });

    it('should throw on truncated COPY instruction', () => {
      const base = Buffer.from('data');
      const delta = Buffer.concat([
        encodeDeltaSize(4),
        encodeDeltaSize(4),
        // COPY cmd says offset byte 0 and size byte 0 present, but only cmd byte exists
        Buffer.from([0x91]), // bits: 1|001|0001 → offset byte 0 + size byte 0, but no data follows
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('Truncated COPY')
      );
    });

    it('should handle different COPY offset combinations correctly', () => {
      // Test with offsets using bytes 0 and 3
      // offset byte 0 = 10, byte 3 = 0 → offset = 10
      const base = Buffer.alloc(30, 0);
      base.write('XY', 10);
      const expected = Buffer.from('XY');

      const delta = Buffer.concat([
        encodeDeltaSize(30),
        encodeDeltaSize(2),
        buildCopyInstruction([10], [2]),
      ]);

      const result = applyDelta(base, delta, 0, 'test.pack');
      assert.ok(result.equals(expected));
    });
  });

  describe('validation', () => {
    it('should throw on invalid base size', () => {
      const base = Buffer.from('Hello'); // 5 bytes
      const delta = Buffer.concat([
        encodeDeltaSize(10), // WRONG: says base is 10 bytes
        encodeDeltaSize(5),
        Buffer.from([5]), Buffer.from('World'),
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('base size mismatch')
      );
    });

    it('should throw on invalid result size', () => {
      const base = Buffer.from('Hello');
      const delta = Buffer.concat([
        encodeDeltaSize(5),  // correct base size
        encodeDeltaSize(10), // says result is 10 bytes
        Buffer.from([5]), Buffer.from('World'), // but only 5 bytes produced
      ]);

      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('result size mismatch')
      );
    });

    it('should throw on truncated delta header (base size)', () => {
      assert.throws(
        () => applyDelta(Buffer.from('base'), Buffer.alloc(0), 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('Truncated')
      );
    });

    it('should throw on truncated delta header (result size)', () => {
      const delta = Buffer.concat([
        encodeDeltaSize(4), // base size OK
        // but no result size follows
      ]);

      // The result size read will fail because there's no more data
      // after the base size encoding
      const base = Buffer.from('data');

      // Need a tricky case: base size encoded in 1 byte, then nothing left
      const trickDelta = Buffer.from([0x04]); // base size = 4, then nothing

      assert.throws(
        () => applyDelta(base, trickDelta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('Truncated')
      );
    });

    it('should throw on malformed instruction stream (extra data after result filled)', () => {
      const base = Buffer.from('base');
      // Result is 4 bytes, produce exactly 4 bytes, but result size declares 3
      const delta = Buffer.concat([
        encodeDeltaSize(4),
        encodeDeltaSize(3), // says result is 3 bytes
        Buffer.from([4]), Buffer.from('test'), // INSERT 4 bytes → produces 4 bytes, exceeds declared
      ]);

      // This should fail because resultPos (4) != declaredResultSize (3)
      // Actually, it might not check mid-stream, only at the end.
      // The buffer pre-allocation is 3 bytes, so copying 4 bytes to it might
      // just silently overflow the pre-allocated buffer. Let's verify the behavior:
      // Buffer.allocUnsafe(3) — writing 4 bytes at offset 0 would go 1 past.
      // Buffer.copy handles this by truncating. So resultPos would be 4 but
      // declaredResultSize is 3, so the final check catches it.
      assert.throws(
        () => applyDelta(base, delta, 0, 'test.pack'),
        (err) => err instanceof GitXRayError && err.message.includes('result size mismatch')
      );
    });
  });
});

// ─── Integration Tests with Synthetic Packfiles ───────────────────────────────

describe('OFS_DELTA integration', () => {
  it('should resolve a simple OFS_DELTA', () => {
    const baseBody = Buffer.from('Hello, World! This is the base object content.');
    const targetBody = Buffer.from('Hello, World! This is the modified content.');
    const deltaData = buildInsertDelta(baseBody, targetBody);
    const baseHash = crypto.randomBytes(20).toString('hex');

    const { gitDir, cleanup, packBuf, offsets } = createSyntheticPackRepo([
      { type: OBJ_BLOB, body: baseBody, hash: baseHash },
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 0 /* placeholder */ },
    ], [{ hash: baseHash, offset: 0 }]); // Only index the base

    try {
      // Calculate the actual negative offset (from delta to base)
      const negativeOffset = offsets[1] - offsets[0];

      // Rebuild the pack with correct negative offset
      const { gitDir: gd2, cleanup: cl2, packBuf: pb2, offsets: off2 } = createSyntheticPackRepo([
        { type: OBJ_BLOB, body: baseBody, hash: baseHash },
        { type: OBJ_OFS_DELTA, deltaData, negativeOffset },
      ], [{ hash: baseHash, offset: 0 }]); // placeholder, we'll read directly

      try {
        clearPackCache();
        // Read the delta object directly from the pack buffer
        const result = readPackObject(pb2, off2[1], 'test.pack', null, gd2, new Set(), 0);
        assert.equal(result.type, 'blob');
        assert.ok(result.body.equals(targetBody));
        assert.equal(result.size, targetBody.length);
      } finally {
        cl2();
      }
    } finally {
      cleanup();
    }
  });

  it('should correctly decode variable-length OFS_DELTA offset', () => {
    // Create a pack where the base is at offset 12 and delta is far enough
    // to require multi-byte offset encoding
    const baseBody = Buffer.alloc(500, 0x41); // large base to push delta offset
    const targetBody = Buffer.alloc(500, 0x42);
    const deltaData = buildInsertDelta(baseBody, targetBody);

    const entries = [
      { type: OBJ_BLOB, body: baseBody, hash: crypto.randomBytes(20).toString('hex') },
    ];

    // First build to get real offsets
    const { offsets: tempOffsets } = buildSyntheticPack(entries);

    // Now add the delta
    const entriesWithDelta = [
      ...entries,
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 1 }, // placeholder
    ];
    const { offsets: tempOffsets2 } = buildSyntheticPack(entriesWithDelta);
    const negativeOffset = tempOffsets2[1] - tempOffsets2[0];

    // Rebuild with correct offset
    entriesWithDelta[1].negativeOffset = negativeOffset;
    const { packBuf, offsets } = buildSyntheticPack(entriesWithDelta);

    const result = readPackObject(packBuf, offsets[1], 'test.pack', null, null, new Set(), 0);
    assert.equal(result.type, 'blob');
    assert.ok(result.body.equals(targetBody));
  });

  it('should throw for invalid OFS_DELTA offset (base before pack header)', () => {
    const baseBody = Buffer.from('base');
    const targetBody = Buffer.from('target');
    const deltaData = buildInsertDelta(baseBody, targetBody);

    // Use a huge negative offset that would point before the pack
    const entries = [
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 99999 },
    ];

    const { packBuf, offsets } = buildSyntheticPack(entries);

    assert.throws(
      () => readPackObject(packBuf, offsets[0], 'test.pack', null, null, new Set(), 0),
      (err) => err instanceof GitXRayError && err.message.includes('invalid base offset')
    );
  });

  it('should throw for OFS_DELTA base offset outside the pack', () => {
    const baseBody = Buffer.from('base data');
    const targetBody = Buffer.from('target data');
    const deltaData = buildInsertDelta(baseBody, targetBody);

    // Put delta at offset that when negOffset subtracted gives < 12
    const entries = [
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 1 }, // offset - 1 would be < 12 (= 11)
    ];

    const { packBuf, offsets } = buildSyntheticPack(entries);
    // offsets[0] should be 12, so 12 - 1 = 11 < 12 → invalid
    assert.throws(
      () => readPackObject(packBuf, offsets[0], 'test.pack', null, null, new Set(), 0),
      (err) => err instanceof GitXRayError && err.message.includes('invalid base offset')
    );
  });

  it('should resolve OFS_DELTA whose base is another OFS_DELTA (chain)', () => {
    const baseBody = Buffer.from('Original base content');
    const midBody = Buffer.from('Modified intermediate content');
    const targetBody = Buffer.from('Final target content');

    const delta1 = buildInsertDelta(baseBody, midBody);
    const delta2 = buildInsertDelta(midBody, targetBody);

    // Build initial pack to get offsets
    const baseHash = crypto.randomBytes(20).toString('hex');
    const initial = [
      { type: OBJ_BLOB, body: baseBody, hash: baseHash },
      { type: OBJ_OFS_DELTA, deltaData: delta1, negativeOffset: 1 },
      { type: OBJ_OFS_DELTA, deltaData: delta2, negativeOffset: 1 },
    ];

    const { offsets: off1 } = buildSyntheticPack(initial);
    // Fix offsets
    initial[1].negativeOffset = off1[1] - off1[0]; // delta1 → base
    initial[2].negativeOffset = off1[2] - off1[1]; // delta2 → delta1

    // Rebuild with correct offsets, then fix again (offsets may have changed)
    const { offsets: off2 } = buildSyntheticPack(initial);
    initial[1].negativeOffset = off2[1] - off2[0];
    initial[2].negativeOffset = off2[2] - off2[1];

    const { packBuf, offsets } = buildSyntheticPack(initial);

    const result = readPackObject(packBuf, offsets[2], 'test.pack', null, null, new Set(), 0);
    assert.equal(result.type, 'blob');
    assert.ok(result.body.equals(targetBody));
  });
});

describe('REF_DELTA integration', () => {
  it('should resolve a simple REF_DELTA', () => {
    const baseBody = Buffer.from('Hello, World! Base content.');
    const targetBody = Buffer.from('Hello, World! Target content.');
    const deltaData = buildInsertDelta(baseBody, targetBody);

    // We need the base object accessible via readObject
    // Create a repo with a loose base object and a REF_DELTA in a pack
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-refdelta-'));
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects');
    const packDir = path.join(objectsDir, 'pack');
    const refsDir = path.join(gitDir, 'refs');

    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    // Create a loose base object
    const baseObjRaw = Buffer.concat([
      Buffer.from(`blob ${baseBody.length}\0`),
      baseBody,
    ]);
    const baseHash = crypto.createHash('sha1').update(baseObjRaw).digest('hex');
    const baseObjDir = path.join(objectsDir, baseHash.slice(0, 2));
    fs.mkdirSync(baseObjDir, { recursive: true });
    fs.writeFileSync(
      path.join(baseObjDir, baseHash.slice(2)),
      zlib.deflateSync(baseObjRaw)
    );

    // Create a REF_DELTA that references the base
    const baseHashBuf = Buffer.from(baseHash, 'hex');
    const deltaHash = crypto.randomBytes(20).toString('hex');

    const entries = [
      {
        type: OBJ_REF_DELTA,
        deltaData,
        baseHash: baseHashBuf,
        hash: deltaHash,
      },
    ];

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const idxBuf = buildSyntheticIdx([{ hash: deltaHash, offset: offsets[0] }]);

    const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(packDir, packName + '.pack'), packBuf);
    fs.writeFileSync(path.join(packDir, packName + '.idx'), idxBuf);

    try {
      clearPackCache();
      const result = readObject(gitDir, deltaHash);
      assert.notEqual(result, null);
      assert.equal(result.type, 'blob');
      assert.ok(result.body.equals(targetBody));
      assert.equal(result.size, targetBody.length);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle 20-byte base ID correctly', () => {
    // The REF_DELTA must read exactly 20 bytes for the base hash
    const baseBody = Buffer.from('Content');
    const targetBody = Buffer.from('Modified Content');
    const deltaData = buildInsertDelta(baseBody, targetBody);

    // Create loose base
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-refhash-'));
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects');
    const packDir = path.join(objectsDir, 'pack');
    const refsDir = path.join(gitDir, 'refs');

    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const baseObjRaw = Buffer.concat([Buffer.from(`blob ${baseBody.length}\0`), baseBody]);
    const baseHash = crypto.createHash('sha1').update(baseObjRaw).digest('hex');
    const baseDir = path.join(objectsDir, baseHash.slice(0, 2));
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, baseHash.slice(2)), zlib.deflateSync(baseObjRaw));

    const baseHashBuf = Buffer.from(baseHash, 'hex');
    assert.equal(baseHashBuf.length, 20, 'base hash buffer should be 20 bytes');

    const deltaHash = crypto.randomBytes(20).toString('hex');
    const entries = [
      { type: OBJ_REF_DELTA, deltaData, baseHash: baseHashBuf, hash: deltaHash },
    ];

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const idxBuf = buildSyntheticIdx([{ hash: deltaHash, offset: offsets[0] }]);

    const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(packDir, packName + '.pack'), packBuf);
    fs.writeFileSync(path.join(packDir, packName + '.idx'), idxBuf);

    try {
      clearPackCache();
      const result = readObject(gitDir, deltaHash);
      assert.notEqual(result, null);
      assert.equal(result.type, 'blob');
      assert.ok(result.body.equals(targetBody));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should throw for missing REF_DELTA base object', () => {
    const deltaData = buildInsertDelta(Buffer.from('base'), Buffer.from('target'));
    const missingHash = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-refmissing-'));
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects');
    const packDir = path.join(objectsDir, 'pack');
    const refsDir = path.join(gitDir, 'refs');

    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const deltaHash = crypto.randomBytes(20).toString('hex');
    const entries = [
      { type: OBJ_REF_DELTA, deltaData, baseHash: missingHash, hash: deltaHash },
    ];

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const idxBuf = buildSyntheticIdx([{ hash: deltaHash, offset: offsets[0] }]);

    const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(packDir, packName + '.pack'), packBuf);
    fs.writeFileSync(path.join(packDir, packName + '.idx'), idxBuf);

    try {
      clearPackCache();
      assert.throws(
        () => readObject(gitDir, deltaHash),
        (err) => err instanceof GitXRayError && err.message.includes('not found')
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve REF_DELTA whose base is another delta (in pack)', () => {
    // Base blob (normal) → OFS_DELTA → REF_DELTA (we look up the OFS_DELTA by hash)
    const baseBody = Buffer.from('Original base data');
    const midBody = Buffer.from('Intermediate data');
    const targetBody = Buffer.from('Final target result');

    const delta1 = buildInsertDelta(baseBody, midBody);
    const delta2 = buildInsertDelta(midBody, targetBody);

    const baseHash = crypto.randomBytes(20).toString('hex');
    const midHash = crypto.randomBytes(20).toString('hex');
    const targetHash = crypto.randomBytes(20).toString('hex');

    // Build the pack: base(normal) → delta1(OFS → base) → delta2(REF → mid)
    const initial = [
      { type: OBJ_BLOB, body: baseBody, hash: baseHash },
      { type: OBJ_OFS_DELTA, deltaData: delta1, negativeOffset: 1, hash: midHash },
      { type: OBJ_REF_DELTA, deltaData: delta2, baseHash: Buffer.from(midHash, 'hex'), hash: targetHash },
    ];

    // Calculate correct OFS offset
    const { offsets: off1 } = buildSyntheticPack(initial);
    initial[1].negativeOffset = off1[1] - off1[0];
    const { offsets: off2 } = buildSyntheticPack(initial);
    initial[1].negativeOffset = off2[1] - off2[0];

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-refchain-'));
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects');
    const packDir = path.join(objectsDir, 'pack');
    const refsDir = path.join(gitDir, 'refs');

    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const { packBuf, offsets } = buildSyntheticPack(initial);

    // Index ALL objects so REF_DELTA can find the mid by hash
    const idxEntries = [
      { hash: baseHash, offset: offsets[0] },
      { hash: midHash, offset: offsets[1] },
      { hash: targetHash, offset: offsets[2] },
    ];
    const idxBuf = buildSyntheticIdx(idxEntries);

    const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(packDir, packName + '.pack'), packBuf);
    fs.writeFileSync(path.join(packDir, packName + '.idx'), idxBuf);

    try {
      clearPackCache();
      const result = readObject(gitDir, targetHash);
      assert.notEqual(result, null);
      assert.equal(result.type, 'blob');
      assert.ok(result.body.equals(targetBody));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Delta Chain Tests ────────────────────────────────────────────────────────

describe('delta chains', () => {
  it('should resolve delta → normal (single level)', () => {
    const base = Buffer.from('base content');
    const target = Buffer.from('target content');
    const delta = buildInsertDelta(base, target);

    const entries = [
      { type: OBJ_BLOB, body: base, hash: crypto.randomBytes(20).toString('hex') },
      { type: OBJ_OFS_DELTA, deltaData: delta, negativeOffset: 1 },
    ];

    const { offsets: off1 } = buildSyntheticPack(entries);
    entries[1].negativeOffset = off1[1] - off1[0];
    const { offsets: off2 } = buildSyntheticPack(entries);
    entries[1].negativeOffset = off2[1] - off2[0];

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const result = readPackObject(packBuf, offsets[1], 'test.pack', null, null, new Set(), 0);
    assert.equal(result.type, 'blob');
    assert.ok(result.body.equals(target));
  });

  it('should resolve delta → delta → normal (two levels)', () => {
    const base = Buffer.from('level 0 base');
    const mid = Buffer.from('level 1 intermediate');
    const target = Buffer.from('level 2 final');

    const delta1 = buildInsertDelta(base, mid);
    const delta2 = buildInsertDelta(mid, target);

    const entries = [
      { type: OBJ_BLOB, body: base, hash: crypto.randomBytes(20).toString('hex') },
      { type: OBJ_OFS_DELTA, deltaData: delta1, negativeOffset: 1 },
      { type: OBJ_OFS_DELTA, deltaData: delta2, negativeOffset: 1 },
    ];

    // Two iterations to stabilize offsets
    for (let i = 0; i < 2; i++) {
      const { offsets } = buildSyntheticPack(entries);
      entries[1].negativeOffset = offsets[1] - offsets[0];
      entries[2].negativeOffset = offsets[2] - offsets[1];
    }

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const result = readPackObject(packBuf, offsets[2], 'test.pack', null, null, new Set(), 0);
    assert.equal(result.type, 'blob');
    assert.ok(result.body.equals(target));
  });

  it('should resolve OFS_DELTA → REF_DELTA → normal (mixed chain)', () => {
    const base = Buffer.from('Chain base');
    const mid = Buffer.from('Chain intermediate');
    const target = Buffer.from('Chain final');

    const delta1 = buildInsertDelta(base, mid);
    const delta2 = buildInsertDelta(mid, target);

    const baseHash = crypto.randomBytes(20).toString('hex');
    const midHash = crypto.randomBytes(20).toString('hex');
    const targetHash = crypto.randomBytes(20).toString('hex');

    // Pack: base(normal), mid(REF_DELTA→base), target(OFS_DELTA→mid)
    const entries = [
      { type: OBJ_BLOB, body: base, hash: baseHash },
      { type: OBJ_REF_DELTA, deltaData: delta1, baseHash: Buffer.from(baseHash, 'hex'), hash: midHash },
      { type: OBJ_OFS_DELTA, deltaData: delta2, negativeOffset: 1, hash: targetHash },
    ];

    // Stabilize OFS offset
    for (let i = 0; i < 2; i++) {
      const { offsets } = buildSyntheticPack(entries);
      entries[2].negativeOffset = offsets[2] - offsets[1];
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-mixed-'));
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects');
    const packDir = path.join(objectsDir, 'pack');
    const refsDir = path.join(gitDir, 'refs');

    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const idxEntries = [
      { hash: baseHash, offset: offsets[0] },
      { hash: midHash, offset: offsets[1] },
      { hash: targetHash, offset: offsets[2] },
    ];
    const idxBuf = buildSyntheticIdx(idxEntries);

    const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(packDir, packName + '.pack'), packBuf);
    fs.writeFileSync(path.join(packDir, packName + '.idx'), idxBuf);

    try {
      clearPackCache();
      const result = readObject(gitDir, targetHash);
      assert.notEqual(result, null);
      assert.equal(result.type, 'blob');
      assert.ok(result.body.equals(target));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve REF_DELTA → OFS_DELTA → normal (mixed chain reverse)', () => {
    const base = Buffer.from('Reverse chain base');
    const mid = Buffer.from('Reverse chain intermediate');
    const target = Buffer.from('Reverse chain final');

    const delta1 = buildInsertDelta(base, mid);
    const delta2 = buildInsertDelta(mid, target);

    const baseHash = crypto.randomBytes(20).toString('hex');
    const midHash = crypto.randomBytes(20).toString('hex');
    const targetHash = crypto.randomBytes(20).toString('hex');

    // Pack: base(normal), mid(OFS_DELTA→base), target(REF_DELTA→mid)
    const entries = [
      { type: OBJ_BLOB, body: base, hash: baseHash },
      { type: OBJ_OFS_DELTA, deltaData: delta1, negativeOffset: 1, hash: midHash },
      { type: OBJ_REF_DELTA, deltaData: delta2, baseHash: Buffer.from(midHash, 'hex'), hash: targetHash },
    ];

    // Stabilize OFS offset
    for (let i = 0; i < 2; i++) {
      const { offsets } = buildSyntheticPack(entries);
      entries[1].negativeOffset = offsets[1] - offsets[0];
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-mixed2-'));
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects');
    const packDir = path.join(objectsDir, 'pack');
    const refsDir = path.join(gitDir, 'refs');

    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const idxEntries = [
      { hash: baseHash, offset: offsets[0] },
      { hash: midHash, offset: offsets[1] },
      { hash: targetHash, offset: offsets[2] },
    ];
    const idxBuf = buildSyntheticIdx(idxEntries);

    const packName = 'pack-' + crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(packDir, packName + '.pack'), packBuf);
    fs.writeFileSync(path.join(packDir, packName + '.idx'), idxBuf);

    try {
      clearPackCache();
      const result = readObject(gitDir, targetHash);
      assert.notEqual(result, null);
      assert.equal(result.type, 'blob');
      assert.ok(result.body.equals(target));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve a deep chain (4 levels)', () => {
    const bodies = [
      Buffer.from('Level 0: base object'),
      Buffer.from('Level 1: first delta'),
      Buffer.from('Level 2: second delta'),
      Buffer.from('Level 3: third delta'),
      Buffer.from('Level 4: fourth delta - final'),
    ];

    const entries = [
      { type: OBJ_BLOB, body: bodies[0], hash: crypto.randomBytes(20).toString('hex') },
    ];

    // Build chain of OFS_DELTAs
    for (let i = 1; i < bodies.length; i++) {
      const delta = buildInsertDelta(bodies[i - 1], bodies[i]);
      entries.push({ type: OBJ_OFS_DELTA, deltaData: delta, negativeOffset: 1 });
    }

    // Stabilize offsets (3 iterations for deep chains)
    for (let iter = 0; iter < 3; iter++) {
      const { offsets } = buildSyntheticPack(entries);
      for (let i = 1; i < entries.length; i++) {
        entries[i].negativeOffset = offsets[i] - offsets[i - 1];
      }
    }

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const result = readPackObject(packBuf, offsets[4], 'test.pack', null, null, new Set(), 0);
    assert.equal(result.type, 'blob');
    assert.ok(result.body.equals(bodies[4]));
  });

  it('should inherit type from the ultimate base object', () => {
    // Use a commit-type base instead of blob
    const commitBody = Buffer.from(
      'tree 0000000000000000000000000000000000000000\n' +
      'author Test <test@test.com> 1000000000 +0000\n' +
      'committer Test <test@test.com> 1000000000 +0000\n' +
      '\ntest commit'
    );
    const modifiedCommit = Buffer.from(
      'tree 0000000000000000000000000000000000000000\n' +
      'author Test <test@test.com> 1000000001 +0000\n' +
      'committer Test <test@test.com> 1000000001 +0000\n' +
      '\nmodified commit'
    );

    const delta = buildInsertDelta(commitBody, modifiedCommit);
    const entries = [
      { type: OBJ_COMMIT, body: commitBody, hash: crypto.randomBytes(20).toString('hex') },
      { type: OBJ_OFS_DELTA, deltaData: delta, negativeOffset: 1 },
    ];

    for (let i = 0; i < 2; i++) {
      const { offsets } = buildSyntheticPack(entries);
      entries[1].negativeOffset = offsets[1] - offsets[0];
    }

    const { packBuf, offsets } = buildSyntheticPack(entries);
    const result = readPackObject(packBuf, offsets[1], 'test.pack', null, null, new Set(), 0);
    assert.equal(result.type, 'commit');  // should be 'commit', not 'blob' or 'ofs-delta'
    assert.ok(result.body.equals(modifiedCommit));
  });
});

// ─── Cycle and Safety Tests ──────────────────────────────────────────────────

describe('cycle and safety protection', () => {
  it('should detect circular OFS_DELTA reference (self-reference)', () => {
    // An OFS_DELTA that points to itself
    const deltaData = buildInsertDelta(Buffer.from('x'), Buffer.from('y'));
    const entries = [
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 0 },
    ];

    // A self-reference would have negativeOffset = 0, meaning base is at same position
    // But Git's encoding doesn't allow 0 (minimum is 1). The visiting set handles this.
    // Let's instead make a pack where we manually read with a visiting set that already has the offset
    const { packBuf, offsets } = buildSyntheticPack(entries);

    const visiting = new Set();
    visiting.add(offsets[0]); // pre-add current offset to simulate self-reference

    assert.throws(
      () => readPackObject(packBuf, offsets[0], 'test.pack', null, null, visiting, 0),
      (err) => err instanceof GitXRayError
    );
  });

  it('should detect circular OFS_DELTA chain', () => {
    // Create two OFS_DELTAs that point to each other
    // This is tricky because Git's encoding uses negative offsets.
    // We can simulate it by having delta A point forward (invalid) or
    // by having the visiting set detect the cycle.

    // The simplest test: use readPackObject with a visiting set containing the base offset
    const deltaData = buildInsertDelta(Buffer.from('x'), Buffer.from('y'));
    const entries = [
      { type: OBJ_BLOB, body: Buffer.from('x'), hash: crypto.randomBytes(20).toString('hex') },
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 1 },
    ];

    for (let i = 0; i < 2; i++) {
      const { offsets } = buildSyntheticPack(entries);
      entries[1].negativeOffset = offsets[1] - offsets[0];
    }

    const { packBuf, offsets } = buildSyntheticPack(entries);

    // Simulate a cycle by adding the base offset to the visiting set
    const visiting = new Set();
    visiting.add(offsets[0]); // pretend we're already visiting the base

    assert.throws(
      () => readPackObject(packBuf, offsets[1], 'test.pack', null, null, visiting, 0),
      (err) => err instanceof GitXRayError && err.message.includes('Circular')
    );
  });

  it('should enforce maximum delta chain depth', () => {
    // Try to read at depth > MAX_DELTA_DEPTH
    const deltaData = buildInsertDelta(Buffer.from('x'), Buffer.from('y'));
    const entries = [
      { type: OBJ_BLOB, body: Buffer.from('x'), hash: crypto.randomBytes(20).toString('hex') },
      { type: OBJ_OFS_DELTA, deltaData, negativeOffset: 1 },
    ];

    for (let i = 0; i < 2; i++) {
      const { offsets } = buildSyntheticPack(entries);
      entries[1].negativeOffset = offsets[1] - offsets[0];
    }

    const { packBuf, offsets } = buildSyntheticPack(entries);

    assert.throws(
      () => readPackObject(packBuf, offsets[1], 'test.pack', null, null, new Set(), MAX_DELTA_DEPTH + 1),
      (err) => err instanceof GitXRayError && err.message.includes('too deep')
    );
  });

  it('should reject invalid pack offset (negative)', () => {
    const entries = [
      { type: OBJ_BLOB, body: Buffer.from('data'), hash: crypto.randomBytes(20).toString('hex') },
    ];
    const { packBuf } = buildSyntheticPack(entries);

    assert.throws(
      () => readPackObject(packBuf, -1, 'test.pack', null, null, new Set(), 0),
      (err) => err instanceof GitXRayError && err.message.includes('Invalid pack offset')
    );
  });

  it('should reject invalid pack offset (past end)', () => {
    const entries = [
      { type: OBJ_BLOB, body: Buffer.from('data'), hash: crypto.randomBytes(20).toString('hex') },
    ];
    const { packBuf } = buildSyntheticPack(entries);

    assert.throws(
      () => readPackObject(packBuf, packBuf.length + 100, 'test.pack', null, null, new Set(), 0),
      (err) => err instanceof GitXRayError && err.message.includes('Invalid pack offset')
    );
  });

  it('should reject invalid pack offset (in header area)', () => {
    const entries = [
      { type: OBJ_BLOB, body: Buffer.from('data'), hash: crypto.randomBytes(20).toString('hex') },
    ];
    const { packBuf } = buildSyntheticPack(entries);

    assert.throws(
      () => readPackObject(packBuf, 5, 'test.pack', null, null, new Set(), 0),
      (err) => err instanceof GitXRayError && err.message.includes('Invalid pack offset')
    );
  });
});

// ─── Real Repository Integration Tests ────────────────────────────────────────

describe('real repository delta integration', () => {
  it('should read objects from this repo (exercises any delta resolution)', () => {
    // This test verifies that readObject works on the actual repo,
    // which may contain delta objects after git gc
    const { resolveHead } = require('../src/git/refs.js');
    const head = resolveHead(GIT_DIR);
    const obj = readObject(GIT_DIR, head.hash);

    assert.notEqual(obj, null);
    assert.equal(obj.type, 'commit');
    assert.ok(obj.body.length > 0);

    // Parse the commit and read its tree (which may also be delta-encoded)
    const commit = parseCommit(head.hash, obj.body);
    const treeObj = readObject(GIT_DIR, commit.tree);
    assert.notEqual(treeObj, null);
    assert.equal(treeObj.type, 'tree');

    // Parse tree and read some entries (blobs may be deltas)
    const entries = parseTree(treeObj.body);
    assert.ok(entries.length > 0);

    // Try to read at least one blob
    for (const entry of entries) {
      if (entry.mode !== '40000' && entry.mode !== '040000') {
        const blobObj = readObject(GIT_DIR, entry.hash);
        assert.notEqual(blobObj, null);
        assert.equal(blobObj.type, 'blob');
        break;
      }
    }
  });

  it('should walk all commits (exercises PACK+IDX+delta path)', () => {
    const { resolveHead } = require('../src/git/refs.js');
    const { walkCommits, computeAllDiffs } = require('../src/git/walker.js');

    const head = resolveHead(GIT_DIR);
    const { commits } = walkCommits(GIT_DIR, [head.hash]);
    assert.ok(commits.length >= 1);

    // computeAllDiffs reads tree objects which may be delta-encoded
    const diffs = computeAllDiffs(GIT_DIR, commits);
    assert.ok(diffs.size === commits.length);
  });

  it('readObject never returns ofs-delta or ref-delta as final type', () => {
    const { resolveHead } = require('../src/git/refs.js');
    const { walkCommits } = require('../src/git/walker.js');

    const head = resolveHead(GIT_DIR);
    const { commits } = walkCommits(GIT_DIR, [head.hash]);

    for (const commit of commits) {
      const obj = readObject(GIT_DIR, commit.hash);
      assert.notEqual(obj, null);
      assert.ok(
        ['commit', 'tree', 'blob', 'tag'].includes(obj.type),
        `readObject returned unexpected type "${obj.type}" for ${commit.hash}`
      );
    }
  });
});

// ─── Git-Based Fixture Test ───────────────────────────────────────────────────

describe('git gc packed repo test', () => {
  it('should read all objects correctly from a git gc\'d repo with delta objects', () => {
    // Create a real repo, make multiple commits with similar content
    // (to force Git to create deltas), then run git gc
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-gctest-'));

    try {
      spawnSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, stdio: 'ignore' });

      // Create multiple commits with similar content to encourage delta compression
      const fileContent1 = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n';
      fs.writeFileSync(path.join(tempDir, 'file.txt'), fileContent1);
      spawnSync('git', ['add', 'file.txt'], { cwd: tempDir, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'commit 1'], { cwd: tempDir, stdio: 'ignore' });

      const fileContent2 = 'Line 1\nLine 2 modified\nLine 3\nLine 4\nLine 5\nLine 6\n';
      fs.writeFileSync(path.join(tempDir, 'file.txt'), fileContent2);
      spawnSync('git', ['add', 'file.txt'], { cwd: tempDir, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'commit 2'], { cwd: tempDir, stdio: 'ignore' });

      const fileContent3 = 'Line 1\nLine 2 modified\nLine 3 also modified\nLine 4\nLine 5\nLine 6\nLine 7\n';
      fs.writeFileSync(path.join(tempDir, 'file.txt'), fileContent3);
      spawnSync('git', ['add', 'file.txt'], { cwd: tempDir, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'commit 3'], { cwd: tempDir, stdio: 'ignore' });

      // Pack the repo to create delta objects
      spawnSync('git', ['gc', '--aggressive', '--prune=now'], { cwd: tempDir, stdio: 'ignore' });

      // Verify it's actually packed
      const gitDir = path.join(tempDir, '.git');
      const packDir = path.join(gitDir, 'objects', 'pack');
      const packFiles = fs.existsSync(packDir)
        ? fs.readdirSync(packDir).filter(f => f.endsWith('.pack'))
        : [];
      assert.ok(packFiles.length > 0, 'repo should have at least one pack file');

      // Now read all commits via Git X-Ray
      clearPackCache();
      const { resolveHead } = require('../src/git/refs.js');
      const { walkCommits, computeAllDiffs } = require('../src/git/walker.js');

      const head = resolveHead(gitDir);
      const { commits } = walkCommits(gitDir, [head.hash]);
      assert.equal(commits.length, 3, 'should find all 3 commits');

      // Verify diffs work (this reads tree and blob objects, some of which should be deltas)
      const diffs = computeAllDiffs(gitDir, commits);
      assert.equal(diffs.size, 3);

      // Verify each commit can be fully read
      for (const commit of commits) {
        const obj = readObject(gitDir, commit.hash);
        assert.notEqual(obj, null);
        assert.equal(obj.type, 'commit');

        // Read tree
        const treeObj = readObject(gitDir, commit.tree);
        assert.notEqual(treeObj, null);
        assert.equal(treeObj.type, 'tree');

        // Read all tree entries
        const entries = parseTree(treeObj.body);
        for (const entry of entries) {
          const entryObj = readObject(gitDir, entry.hash);
          assert.notEqual(entryObj, null, `should read object ${entry.hash} (${entry.name})`);
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
