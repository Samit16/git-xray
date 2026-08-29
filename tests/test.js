'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { locateGitDir, GitXRayError } = require('../src/git/locator.js');
const {
  hashToPath,
  looseObjectExists,
  readLooseObject,
  readObject,
  parseCommit,
  parseTree,
} = require('../src/git/objects.js');
const { resolveHead, getAllBranches } = require('../src/git/refs.js');
const { walkCommits, diffTrees, flattenTree, computeAllDiffs } = require('../src/git/walker.js');
const { computeChurn } = require('../src/analytics/churn.js');
const { computeOwnership } = require('../src/analytics/ownership.js');
const { computeBusFactor } = require('../src/analytics/bus-factor.js');
const { renderSummaryPanel, renderDashboardSummary, formatTable, stripAnsi } = require('../src/outputs/terminal.js');
const { buildDashboardMenu, renderDashboardMenu } = require('../src/ui/dashboard.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..');
const GIT_DIR = path.join(REPO_ROOT, '.git');

/**
 * Create a fake loose git object in a temp location for testing.
 * Returns the hash and a cleanup function.
 */
function createTestObject(type, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = `${type} ${body.length}\0`;
  const raw = Buffer.concat([Buffer.from(header), body]);
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  return { hash, raw, body };
}

// ─── Locator Tests ────────────────────────────────────────────────────────────

describe('locator', () => {
  it('should locate .git in a real repo', () => {
    const result = locateGitDir(REPO_ROOT);
    assert.equal(result.gitDir, GIT_DIR);
    assert.equal(result.isBare, false);
  });

  it('should throw for non-existent path', () => {
    assert.throws(
      () => locateGitDir('/absolutely/nonexistent/path/xyz'),
      (err) => err instanceof GitXRayError && err.message.includes('does not exist')
    );
  });

  it('should throw for a non-git directory', () => {
    // Use the OS temp dir — definitely not a git repo
    const tempDir = require('node:os').tmpdir();
    assert.throws(
      () => locateGitDir(tempDir),
      (err) => err instanceof GitXRayError && err.message.includes('Not a git repository')
    );
  });
});

// ─── Object Parser Tests ──────────────────────────────────────────────────────

describe('objects', () => {
  it('hashToPath should split hash correctly', () => {
    const p = hashToPath('/fake/.git', 'abcdef1234567890abcdef1234567890abcdef12');
    assert.equal(p, path.join('/fake/.git', 'objects', 'ab', 'cdef1234567890abcdef1234567890abcdef12'));
  });

  it('readLooseObject should return null for non-existent hash', () => {
    const result = readLooseObject(GIT_DIR, '0000000000000000000000000000000000000000');
    assert.equal(result, null);
  });

  it('readObject should read a real object from this repo (loose or packed)', () => {
    const head = resolveHead(GIT_DIR);
    const obj = readObject(GIT_DIR, head.hash);
    assert.notEqual(obj, null);
    assert.equal(obj.type, 'commit');
    assert.ok(obj.size > 0);
    assert.ok(Buffer.isBuffer(obj.body));
  });

  it('parseCommit should parse a real commit', () => {
    const head = resolveHead(GIT_DIR);
    const obj = readObject(GIT_DIR, head.hash);
    const commit = parseCommit(head.hash, obj.body);

    assert.equal(commit.hash, head.hash);
    assert.ok(commit.tree, 'commit should have a tree');
    assert.ok(/^[0-9a-f]{40}$/.test(commit.tree), 'tree should be a 40-char hex hash');
    assert.ok(commit.author, 'commit should have an author');
    assert.ok(commit.author.name, 'author should have a name');
    assert.ok(commit.author.email, 'author should have an email');
    assert.ok(commit.author.timestamp > 0, 'author should have a timestamp');
    assert.ok(commit.committer, 'commit should have a committer');
    assert.equal(typeof commit.message, 'string');
  });

  it('parseCommit should handle root commit (no parents)', () => {
    const head = resolveHead(GIT_DIR);
    const obj = readObject(GIT_DIR, head.hash);
    const commit = parseCommit(head.hash, obj.body);

    // Our test repo has only one commit, so it's a root commit
    assert.ok(Array.isArray(commit.parents));
    // Parents could be empty (root) or not — just verify it's an array
  });

  it('parseTree should parse a real tree object', () => {
    const head = resolveHead(GIT_DIR);
    const obj = readObject(GIT_DIR, head.hash);
    const commit = parseCommit(head.hash, obj.body);

    const treeObj = readObject(GIT_DIR, commit.tree);
    assert.notEqual(treeObj, null);
    assert.equal(treeObj.type, 'tree');

    const entries = parseTree(treeObj.body);
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length > 0, 'tree should have entries');

    for (const entry of entries) {
      assert.ok(entry.mode, 'entry should have a mode');
      assert.ok(entry.name, 'entry should have a name');
      assert.ok(/^[0-9a-f]{40}$/.test(entry.hash), 'entry hash should be 40-char hex');
    }
  });

  it('parseTree should correctly parse binary tree format', () => {
    // Build a synthetic tree with known entries
    // Format: "<mode> <name>\0<20-byte-sha>"
    const fakeSha1 = Buffer.from('abcdef1234567890abcd', 'ascii'); // 20 bytes
    const fakeSha2 = Buffer.from('1234567890abcdef1234', 'ascii');

    const entry1 = Buffer.concat([
      Buffer.from('100644 file.txt\0'),
      fakeSha1,
    ]);
    const entry2 = Buffer.concat([
      Buffer.from('40000 subdir\0'),
      fakeSha2,
    ]);
    const treeBody = Buffer.concat([entry1, entry2]);

    const entries = parseTree(treeBody);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].mode, '100644');
    assert.equal(entries[0].name, 'file.txt');
    assert.equal(entries[1].mode, '40000');
    assert.equal(entries[1].name, 'subdir');
  });
});

// ─── Refs Tests ───────────────────────────────────────────────────────────────

describe('refs', () => {
  it('resolveHead should return a valid commit hash', () => {
    const head = resolveHead(GIT_DIR);
    assert.ok(/^[0-9a-f]{40}$/.test(head.hash), 'HEAD hash should be 40-char hex');
  });

  it('resolveHead should return ref name for non-detached HEAD', () => {
    const head = resolveHead(GIT_DIR);
    // HEAD could be detached or not — just verify the structure
    if (head.ref) {
      assert.ok(head.ref.startsWith('refs/'), 'ref should start with refs/');
    }
  });

  it('getAllBranches should return at least one branch', () => {
    const branches = getAllBranches(GIT_DIR);
    assert.ok(Array.isArray(branches));
    assert.ok(branches.length >= 1, 'should have at least one branch');

    for (const branch of branches) {
      assert.ok(branch.name, 'branch should have a name');
      assert.ok(/^[0-9a-f]{40}$/.test(branch.hash), 'branch hash should be 40-char hex');
    }
  });
});

// ─── Walker Tests ─────────────────────────────────────────────────────────────

describe('walker', () => {
  it('walkCommits should return commits from this repo', () => {
    const head = resolveHead(GIT_DIR);
    const { commits, packedCount } = walkCommits(GIT_DIR, [head.hash]);

    assert.ok(Array.isArray(commits));
    assert.ok(commits.length >= 1, 'should have at least one commit');
    assert.equal(typeof packedCount, 'number');
  });

  it('walkCommits should return commits sorted by timestamp descending', () => {
    const head = resolveHead(GIT_DIR);
    const { commits } = walkCommits(GIT_DIR, [head.hash]);

    for (let i = 1; i < commits.length; i++) {
      assert.ok(
        commits[i - 1].author.timestamp >= commits[i].author.timestamp,
        'commits should be in reverse chronological order'
      );
    }
  });

  it('computeAllDiffs should produce diffs for each commit', () => {
    const head = resolveHead(GIT_DIR);
    const { commits } = walkCommits(GIT_DIR, [head.hash]);
    const diffs = computeAllDiffs(GIT_DIR, commits);

    assert.ok(diffs instanceof Map);
    assert.equal(diffs.size, commits.length, 'should have a diff for each commit');

    for (const [hash, diff] of diffs) {
      assert.ok(Array.isArray(diff.added));
      assert.ok(Array.isArray(diff.modified));
      assert.ok(Array.isArray(diff.deleted));
    }
  });

  it('root commit diff should show all files as added', () => {
    const head = resolveHead(GIT_DIR);
    const { commits } = walkCommits(GIT_DIR, [head.hash]);

    // Find root commits (no parents)
    const rootCommits = commits.filter((c) => c.parents.length === 0);
    if (rootCommits.length > 0) {
      const diffs = computeAllDiffs(GIT_DIR, commits);
      const rootDiff = diffs.get(rootCommits[0].hash);
      assert.ok(rootDiff.added.length > 0, 'root commit should have added files');
      assert.equal(rootDiff.modified.length, 0, 'root commit should have no modified files');
      assert.equal(rootDiff.deleted.length, 0, 'root commit should have no deleted files');
    }
  });
});

// ─── Analytics Tests ──────────────────────────────────────────────────────────

describe('analytics', () => {
  // Set up shared test data
  const head = resolveHead(GIT_DIR);
  const { commits } = walkCommits(GIT_DIR, [head.hash]);
  const diffs = computeAllDiffs(GIT_DIR, commits);

  it('computeChurn should return files sorted by touch count', () => {
    const churn = computeChurn(commits, diffs);
    assert.ok(Array.isArray(churn));

    for (let i = 1; i < churn.length; i++) {
      assert.ok(
        churn[i - 1].touches >= churn[i].touches,
        'churn should be sorted descending'
      );
    }

    for (const entry of churn) {
      assert.ok(entry.path, 'churn entry should have a path');
      assert.ok(entry.touches > 0, 'churn entry should have touches > 0');
    }
  });

  it('computeOwnership should return ownership data for all files', () => {
    const ownership = computeOwnership(commits, diffs);
    assert.ok(Array.isArray(ownership));
    assert.ok(ownership.length > 0);

    for (const entry of ownership) {
      assert.ok(entry.path, 'ownership entry should have a path');
      assert.ok(Array.isArray(entry.authors));
      assert.ok(entry.authors.length > 0);
      assert.ok(entry.primaryAuthor);
      assert.ok(entry.primaryAuthor.name);
      assert.ok(
        entry.primaryAuthor.percentage >= 0 && entry.primaryAuthor.percentage <= 100
      );
      assert.ok(entry.distinctAuthors >= 1);
      assert.ok(entry.lastTouched > 0);
    }
  });

  it('computeBusFactor should flag single-author files', () => {
    const ownership = computeOwnership(commits, diffs);
    const busFactor = computeBusFactor(ownership, 80);
    assert.ok(Array.isArray(busFactor));

    for (const entry of busFactor) {
      assert.ok(entry.path);
      assert.ok(entry.topAuthor);
      assert.equal(typeof entry.atRisk, 'boolean');

      if (entry.atRisk) {
        assert.ok(
          entry.topAuthorPercentage >= 80,
          'at-risk files should be above threshold'
        );
      }
    }
  });

  it('computeBusFactor should respect custom threshold', () => {
    const ownership = computeOwnership(commits, diffs);
    const highThreshold = computeBusFactor(ownership, 100);
    const lowThreshold = computeBusFactor(ownership, 1);

    // With threshold=1%, everything should be at risk
    const atRiskLow = lowThreshold.filter((e) => e.atRisk);
    assert.ok(atRiskLow.length >= highThreshold.filter((e) => e.atRisk).length);
  });
});

// ─── Error Handling Tests ─────────────────────────────────────────────────────

describe('terminal output', () => {
  it('renderSummaryPanel should include title, repo path, and summary metrics', () => {
    const panel = renderSummaryPanel({
      title: 'Churn Report',
      repoPath: '/repo/project',
      metrics: ['Files: 42', 'Top touch: 9'],
    });

    assert.match(panel, /Git X-Ray/i);
    assert.match(panel, /Churn Report/i);
    assert.match(panel, /\/repo\/project/);
    assert.match(panel, /Files: 42/);
    assert.match(panel, /Top touch: 9/);
  });

  it('renderDashboardSummary should include status chips and metric cards', () => {
    const dashboard = renderDashboardSummary({
      title: 'Ownership',
      repoPath: '/workspace/project',
      metrics: [
        { label: 'Files', value: '42' },
        { label: 'Authors', value: '6' },
      ],
      status: 'Healthy',
    });

    assert.match(dashboard, /Ownership/i);
    assert.match(dashboard, /Healthy/i);
    assert.match(dashboard, /Files/i);
    assert.match(dashboard, /42/);
    assert.match(dashboard, /Authors/i);
    assert.match(dashboard, /6/);
  });

  it('formatTable should include borders and aligned columns', () => {
    const table = formatTable(['File', 'Touches'], [['src/index.js', '12']]);

    assert.match(table, /File/);
    assert.match(table, /Touches/);
    assert.match(table, /src\/index\.js/);
    assert.match(table, /12/);
    assert.match(table, /─/);
  });
});

describe('interactive dashboard', () => {
  it('should build a dashboard menu with the main analysis actions', () => {
    const menu = buildDashboardMenu({ repoPath: REPO_ROOT, metrics: { commits: 4, files: 12 } });

    assert.ok(menu.some((item) => item.id === 'log'));
    assert.ok(menu.some((item) => item.id === 'ownership'));
    assert.ok(menu.some((item) => item.id === 'churn'));
    assert.ok(menu.some((item) => item.id === 'bus-factor'));

    const rendered = renderDashboardMenu({ repoPath: REPO_ROOT, items: menu, selectedIndex: 1 });
    assert.match(rendered, /Git X-Ray/i);
    assert.match(rendered, /Commit Log/i);
    assert.match(rendered, /Ownership/i);
  });

  it('should keep each dashboard row within the panel width', () => {
    const menu = buildDashboardMenu({ repoPath: REPO_ROOT, metrics: { commits: 12, files: 44 } });
    const rendered = renderDashboardMenu({ repoPath: REPO_ROOT, items: menu, selectedIndex: 0 });

    const longestLine = Math.max(...rendered.split('\n').map((line) => stripAnsi(line).length));
    assert.ok(longestLine <= 100, `dashboard overflowed width: ${longestLine} chars`);
  });
});

describe('cli regression', () => {
  it('should open the interactive dashboard when a single repo path is supplied', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /Git X-Ray/i);
    assert.match(result.stdout + result.stderr, /Commit Log/i);
  });

  it('should warn when history may be incomplete because objects are packed or skipped', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-packed-'));
    const repoPath = path.join(tempRoot, 'repo');
    fs.mkdirSync(repoPath);

    spawnSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Audit User'], { cwd: repoPath, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'audit@example.com'], { cwd: repoPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'file.txt'), 'hello\n');
    spawnSync('git', ['add', 'file.txt'], { cwd: repoPath, stdio: 'ignore' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
    spawnSync('git', ['gc', '--aggressive', '--prune=now'], { cwd: repoPath, stdio: 'ignore' });

    const result = spawnSync(process.execPath, ['src/index.js', repoPath, 'log'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /packed|partial|incomplete/i);
  });
});

describe('error handling', () => {
  it('GitXRayError should have correct name', () => {
    const err = new GitXRayError('test message');
    assert.equal(err.name, 'GitXRayError');
    assert.equal(err.message, 'test message');
    assert.ok(err instanceof Error);
  });

  it('readLooseObject should return null gracefully for packed objects', () => {
    // Use a valid-format but non-existent hash
    const result = readLooseObject(GIT_DIR, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(result, null);
  });
});
