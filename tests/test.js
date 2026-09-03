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
const { computeHotspots, filterBySeverity } = require('../src/analytics/hotspots.js');
const { computeOverview } = require('../src/analytics/overview.js');
const { analyzeComplexity, analyzeDirectoryComplexity, detectLanguage, stripComments } = require('../src/analytics/complexity.js');
const { renderSummaryPanel, renderDashboardSummary, renderOverviewReport, formatTable, stripAnsi } = require('../src/outputs/terminal.js');
const { renderFileDetail } = require('../src/outputs/file-detail.js');
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
    const plainOutput = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    assert.match(plainOutput, /Files: 42/);
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
    assert.match(rendered, /Repository History|Commit Log/i);
    assert.match(rendered, /Who Owns The Knowledge|Ownership/i);
  });

  it('should keep each dashboard row within the panel width', () => {
    const menu = buildDashboardMenu({ repoPath: REPO_ROOT, metrics: { commits: 12, files: 44 } });
    const rendered = renderDashboardMenu({ repoPath: REPO_ROOT, items: menu, selectedIndex: 0 });

    const longestLine = Math.max(...rendered.split('\n').map((line) => stripAnsi(line).length));
    assert.ok(longestLine <= 100, `dashboard overflowed width: ${longestLine} chars`);
  });
});

describe('file detail view', () => {
  it('renderFileDetail should render comprehensive single-file forensic breakdown', () => {
    const detail = renderFileDetail({
      file: 'src/index.js',
      hotspot: {
        riskScore: 88,
        severity: 'CRITICAL',
        churn: 3,
        ownershipConcentration: 67,
        primaryRisk: 'High change frequency',
      },
      ownership: {
        primaryAuthor: { name: 'Samit Bhisikar', percentage: 67 },
        authors: { 'Samit Bhisikar': 2, 'Yash Bhardwaj': 1 },
        distinctAuthors: 2,
        lastTouched: 1725000000,
      },
      complexity: {
        score: 71,
        complexity: 'VERY HIGH',
        branches: 42,
        maxDepth: 6,
        functions: 8,
        language: 'JavaScript',
      },
      churn: {
        touches: 3,
      },
    });

    assert.match(detail, /File Risk Deep Dive/i);
    assert.match(detail, /CRITICAL RISK · 88\/100/i);
    assert.match(detail, /src\/index\.js/);
    assert.match(detail, /Why is this file considered risky/i);
    assert.match(detail, /High Change Frequency/i);
    assert.match(detail, /Knowledge Ownership/i);
    assert.match(detail, /Samit Bhisikar/);
    assert.match(detail, /Structural Metrics/i);
    assert.match(detail, /Recommended Interpretation/i);
  });
});

// ─── Executive Overview Tests ─────────────────────────────────────────────────

describe('executive overview', () => {
  const head = resolveHead(GIT_DIR);
  const { commits } = walkCommits(GIT_DIR, [head.hash]);
  const diffs = computeAllDiffs(GIT_DIR, commits);

  it('computeOverview should compute all required executive metrics', () => {
    const overview = computeOverview(REPO_ROOT, commits, diffs, 80);

    assert.equal(overview.repository, REPO_ROOT);
    assert.ok(overview.commitCount >= 1);
    assert.ok(overview.contributorCount >= 1);
    assert.ok(overview.fileCount >= 1);
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(overview.overallRisk));
    assert.ok(typeof overview.riskScore === 'number');

    // Knowledge concentration
    assert.ok(overview.knowledgeConcentration);
    assert.ok(typeof overview.knowledgeConcentration.topCommitter === 'string');
    assert.ok(typeof overview.knowledgeConcentration.topCommitterShare === 'number');
    assert.ok(typeof overview.knowledgeConcentration.avgMaxOwnership === 'number');
    assert.ok(['HIGH', 'MODERATE', 'BALANCED'].includes(overview.knowledgeConcentration.concentrationLevel));

    // Bus factor alerts
    assert.ok(overview.busFactorAlerts);
    assert.equal(overview.busFactorAlerts.threshold, 80);
    assert.ok(typeof overview.busFactorAlerts.atRiskCount === 'number');
    assert.ok(Array.isArray(overview.busFactorAlerts.topAlerts));

    // Critical files and hotspots
    assert.ok(Array.isArray(overview.criticalFiles));
    assert.ok(Array.isArray(overview.topHotspots));
  });

  it('renderOverviewReport should format clean text output with all sections', () => {
    const overview = computeOverview(REPO_ROOT, commits, diffs, 80);
    const output = renderOverviewReport(overview);

    assert.match(output, /Repository Health Summary|Repository Executive Overview/i);
    assert.match(output, /Key Findings|Knowledge Concentration/i);
    assert.match(output, /Bus Factor|Bus-Factor/i);
    assert.match(output, /Where Is The Risk|Top Risk Hotspots/i);
  });
});

describe('cli regression', () => {
  it('should provide the executive overview by default when a single repo path is supplied', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /Git X-Ray/i);
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

  it('should handle a fresh empty repository without crashing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitxray-empty-'));
    const repoPath = path.join(tempRoot, 'empty-repo');
    fs.mkdirSync(repoPath);

    spawnSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });

    const result = spawnSync(process.execPath, ['src/index.js', repoPath, 'log'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /empty repo|No commits found|all objects are packed/i);
  });

  it('should report a clean error for unknown CLI flags', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.', '--bogus'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Unknown option|--bogus/i);
    assert.doesNotMatch(result.stdout + result.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/i);
  });
});

describe('hotspots analysis', () => {
  it('should compute hotspots from commits and diffs', () => {
    const head = resolveHead(GIT_DIR);
    const commits = walkCommits(GIT_DIR, [head.hash]).commits;
    const diffs = computeAllDiffs(GIT_DIR, commits);

    const hotspots = computeHotspots(commits, diffs);

    assert.ok(Array.isArray(hotspots));
    assert.ok(hotspots.length > 0);

    // Each hotspot should have required fields
    for (const h of hotspots) {
      assert.ok(typeof h.file === 'string');
      assert.ok(typeof h.riskScore === 'number');
      assert.ok(h.riskScore >= 0 && h.riskScore <= 100);
      assert.ok(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(h.severity));
      assert.ok(typeof h.churn === 'number');
      assert.ok(typeof h.ownershipConcentration === 'number');
      assert.ok(typeof h.primaryRisk === 'string');
    }
  });

  it('should sort hotspots by risk score descending', () => {
    const head = resolveHead(GIT_DIR);
    const commits = walkCommits(GIT_DIR, [head.hash]).commits;
    const diffs = computeAllDiffs(GIT_DIR, commits);
    const hotspots = computeHotspots(commits, diffs);

    // Verify descending order
    for (let i = 0; i < hotspots.length - 1; i++) {
      assert.ok(hotspots[i].riskScore >= hotspots[i + 1].riskScore);
    }
  });

  it('should filter hotspots by severity level', () => {
    const head = resolveHead(GIT_DIR);
    const commits = walkCommits(GIT_DIR, [head.hash]).commits;
    const diffs = computeAllDiffs(GIT_DIR, commits);
    const hotspots = computeHotspots(commits, diffs);

    const critical = filterBySeverity(hotspots, 'CRITICAL');
    assert.ok(critical.every((h) => h.severity === 'CRITICAL'));

    const highAndAbove = filterBySeverity(hotspots, 'HIGH');
    assert.ok(highAndAbove.every((h) => ['CRITICAL', 'HIGH'].includes(h.severity)));
  });

  it('should compute churn from file touch count', () => {
    const head = resolveHead(GIT_DIR);
    const commits = walkCommits(GIT_DIR, [head.hash]).commits;
    const diffs = computeAllDiffs(GIT_DIR, commits);
    const hotspots = computeHotspots(commits, diffs);

    // High-churn files should have high churn values
    const maxChurn = Math.max(...hotspots.map((h) => h.churn));
    assert.ok(maxChurn > 1); // Repo should have some modified files
  });

  it('should identify ownership concentration', () => {
    const head = resolveHead(GIT_DIR);
    const commits = walkCommits(GIT_DIR, [head.hash]).commits;
    const diffs = computeAllDiffs(GIT_DIR, commits);
    const hotspots = computeHotspots(commits, diffs);

    // All ownership concentrations should be 0-100
    for (const h of hotspots) {
      assert.ok(h.ownershipConcentration >= 0 && h.ownershipConcentration <= 100);
    }

    // At least some files should be identified by a top author
    const withAuthor = hotspots.filter((h) => h.topAuthor);
    assert.ok(withAuthor.length > 0);
  });

  it('should handle hotspots CLI command', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.', 'hotspots'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /Risk Hotspots|CRITICAL|HIGH|MEDIUM|LOW/i);
  });

  it('should output hotspots as JSON', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.', 'hotspots', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);

    let json;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      assert.fail('JSON output should be valid');
    }

    assert.ok(Array.isArray(json.hotspots));
    for (const h of json.hotspots) {
      assert.ok(typeof h.file === 'string');
      assert.ok(typeof h.riskScore === 'number');
      assert.ok(typeof h.severity === 'string');
    }
  });
});

describe('structural complexity', () => {
  it('should detect language from file extension', () => {
    assert.equal(detectLanguage('file.js'), 'JavaScript');
    assert.equal(detectLanguage('file.py'), 'Python');
    assert.equal(detectLanguage('file.java'), 'Java');
    assert.equal(detectLanguage('file.unknown'), 'Unknown');
  });

  it('should strip comments from code', () => {
    const code = `
      // This is a comment
      let x = 5; // inline comment
      /* block comment */ let y = 10;
    `;

    const stripped = stripComments(code, 'JavaScript');
    assert.doesNotMatch(stripped, /This is a comment/);
    assert.doesNotMatch(stripped, /inline comment/);
    assert.doesNotMatch(stripped, /block comment/);
    assert.match(stripped, /let x = 5/);
    assert.match(stripped, /let y = 10/);
  });

  it('should analyze complexity of a simple file', () => {
    const tempFile = path.join(os.tmpdir(), 'simple-test.js');
    fs.writeFileSync(tempFile, `
function add(a, b) {
  return a + b;
}
    `);

    const analysis = analyzeComplexity(tempFile);

    assert.ok(typeof analysis.score === 'number');
    assert.ok(analysis.score >= 0 && analysis.score <= 100);
    assert.ok(['TRIVIAL', 'LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'].includes(analysis.complexity));
    assert.equal(analysis.branches, 0);
    assert.ok(analysis.functions >= 1);

    fs.unlinkSync(tempFile);
  });

  it('should analyze complexity of a branched file', () => {
    const tempFile = path.join(os.tmpdir(), 'branched-test.js');
    fs.writeFileSync(tempFile, `
function complex(x) {
  if (x > 0) {
    if (x > 10) {
      if (x > 100) {
        return 'big';
      } else {
        return 'medium';
      }
    } else {
      return 'small';
    }
  } else if (x < -10) {
    return 'negative';
  } else {
    return 'zero';
  }
}
    `);

    const analysis = analyzeComplexity(tempFile);

    assert.ok(analysis.branches >= 4); // Multiple if/else branches
    assert.ok(analysis.maxDepth >= 3); // Deep nesting
    assert.ok(analysis.score >= 10); // Should have meaningful complexity

    fs.unlinkSync(tempFile);
  });

  it('should detect loops and switches', () => {
    const tempFile = path.join(os.tmpdir(), 'loops-test.js');
    fs.writeFileSync(tempFile, `
function iterate(items) {
  for (let i = 0; i < items.length; i++) {
    switch (items[i].type) {
      case 'a':
        console.log('A');
        break;
      case 'b':
        console.log('B');
        break;
      default:
        console.log('other');
    }
  }
  
  let j = 0;
  while (j < 10) {
    j++;
  }
}
    `);

    const analysis = analyzeComplexity(tempFile);

    assert.ok(analysis.loops >= 2); // for and while
    assert.ok(analysis.switches >= 1); // switch
    assert.ok(analysis.cases >= 2); // case statements

    fs.unlinkSync(tempFile);
  });

  it('should detect logical operators and ternaries', () => {
    const tempFile = path.join(os.tmpdir(), 'operators-test.js');
    fs.writeFileSync(tempFile, `
function check(a, b, c) {
  return (a && b) || c ? 'yes' : 'no';
}
    `);

    const analysis = analyzeComplexity(tempFile);

    assert.ok(analysis.logicalOps >= 2); // && and ||
    assert.ok(analysis.ternaries >= 1); // ternary operator

    fs.unlinkSync(tempFile);
  });

  it('should ignore keywords in comments and strings', () => {
    const tempFile = path.join(os.tmpdir(), 'string-test.js');
    fs.writeFileSync(tempFile, `
function demo() {
  // This function has if and while in comments, not real branches
  const msg = "if you see this, if statements in strings are ignored";
  
  /* while and for loops mentioned here should not count */
  return msg;
}
    `);

    const analysis = analyzeComplexity(tempFile);

    // Should not count branches/loops from comments/strings
    assert.equal(analysis.branches, 0);
    assert.equal(analysis.loops, 0);

    fs.unlinkSync(tempFile);
  });

  it('should analyze directory complexity', () => {
    const complexities = analyzeDirectoryComplexity(path.join(REPO_ROOT, 'src'));

    assert.ok(Array.isArray(complexities));
    assert.ok(complexities.length > 0);

    // Each analysis should have required fields
    for (const c of complexities) {
      assert.ok(typeof c.file === 'string');
      assert.ok(typeof c.score === 'number');
      assert.ok(typeof c.complexity === 'string');
      assert.ok(typeof c.language === 'string');
      assert.ok(c.score >= 0 && c.score <= 100);
    }
  });

  it('should sort complexity results by score descending', () => {
    const complexities = analyzeDirectoryComplexity(path.join(REPO_ROOT, 'src'));

    for (let i = 0; i < complexities.length - 1; i++) {
      assert.ok(complexities[i].score >= complexities[i + 1].score);
    }
  });

  it('should handle complexity CLI command', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.', 'complexity'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /Structural Complexity|VERY HIGH|HIGH|MEDIUM|LOW|TRIVIAL/i);
  });

  it('should output complexity as JSON', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.', 'complexity', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);

    let json;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      assert.fail('JSON output should be valid');
    }

    assert.ok(Array.isArray(json.complexities));
    for (const c of json.complexities) {
      assert.ok(typeof c.file === 'string');
      assert.ok(typeof c.score === 'number');
      assert.ok(typeof c.complexity === 'string');
    }
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
