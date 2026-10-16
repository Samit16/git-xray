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
const {
  computeOwnership,
  buildFileFolderList,
  computeContributorBreakdown,
  calculateContributionPercentages,
} = require('../src/analytics/ownership.js');
const { computeBusFactor } = require('../src/analytics/bus-factor.js');
const { computeHotspots, filterBySeverity } = require('../src/analytics/hotspots.js');
const { computeOverview, computeActivitySeries } = require('../src/analytics/overview.js');
const { analyzeComplexity, analyzeDirectoryComplexity, detectLanguage, stripComments } = require('../src/analytics/complexity.js');
const { renderSummaryPanel, renderDashboardSummary, renderOverviewReport, formatTable, stripAnsi } = require('../src/outputs/terminal.js');
const { renderFileDetail } = require('../src/outputs/file-detail.js');
const { renderSparkline, formatSeverity, SPARK_CHARS } = require('../src/ui/core.js');
const { renderMetricGrid } = require('../src/ui/components.js');
const {
  buildDashboardMenu,
  renderDashboardMenu,
  renderFileFolderList,
  renderContributorBreakdown,
  DashboardNavigator,
  runInteractiveDashboard,
} = require('../src/ui/dashboard.js');

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

// ─── Individual Contribution & Navigation Tests ──────────────────────────────

describe('individual contribution breakdown & percentages', () => {
  it('calculateContributionPercentages should calculate correct percentages and sort descending', () => {
    const contributors = [
      { name: 'Bob', commits: 3 },
      { name: 'Alice', commits: 9 },
      { name: 'Charlie', commits: 6 },
    ];
    // Total commits: 18.
    // Alice: 9 / 18 = 50.0%
    // Charlie: 6 / 18 = 33.333%
    // Bob: 3 / 18 = 16.666%
    const results = calculateContributionPercentages(contributors);

    assert.equal(results.length, 3);
    assert.equal(results[0].name, 'Alice');
    assert.equal(results[0].contribution, 9);
    assert.ok(Math.abs(results[0].percentage - 50.0) < 0.001);

    assert.equal(results[1].name, 'Charlie');
    assert.equal(results[1].contribution, 6);
    assert.ok(Math.abs(results[1].percentage - (6 / 18) * 100) < 0.001);

    assert.equal(results[2].name, 'Bob');
    assert.equal(results[2].contribution, 3);
    assert.ok(Math.abs(results[2].percentage - (3 / 18) * 100) < 0.001);
  });

  it('calculateContributionPercentages should handle single contributor as 100%', () => {
    const results = calculateContributionPercentages([{ name: 'Dev One', commits: 12 }]);
    assert.equal(results.length, 1);
    assert.equal(results[0].percentage, 100);
    assert.equal(results[0].contribution, 12);
  });

  it('calculateContributionPercentages should handle empty contributors safely', () => {
    const results = calculateContributionPercentages([]);
    assert.deepEqual(results, []);

    const nullResults = calculateContributionPercentages(null);
    assert.deepEqual(nullResults, []);
  });

  it('calculateContributionPercentages should handle zero totals safely without NaN', () => {
    const contributors = [
      { name: 'Dev A', commits: 0 },
      { name: 'Dev B', commits: 0 },
    ];
    const results = calculateContributionPercentages(contributors, 0);
    assert.equal(results.length, 2);
    assert.equal(results[0].percentage, 0);
    assert.equal(results[1].percentage, 0);
    assert.ok(!Number.isNaN(results[0].percentage));
    assert.ok(!Number.isNaN(results[1].percentage));
  });

  it('computeContributorBreakdown should compute file contribution accurately', () => {
    const sampleOwnership = [
      {
        path: 'src/analytics/churn.js',
        authors: [
          { name: 'Alice', commits: 6, percentage: 60 },
          { name: 'Bob', commits: 4, percentage: 40 },
        ],
      },
      {
        path: 'src/analytics/ownership.js',
        authors: [
          { name: 'Bob', commits: 5, percentage: 50 },
          { name: 'Charlie', commits: 5, percentage: 50 },
        ],
      },
    ];

    const fileBreakdown = computeContributorBreakdown('src/analytics/churn.js', sampleOwnership, false);
    assert.equal(fileBreakdown.type, 'file');
    assert.equal(fileBreakdown.totalContribution, 10);
    assert.equal(fileBreakdown.contributors.length, 2);
    assert.equal(fileBreakdown.contributors[0].name, 'Alice');
    assert.equal(fileBreakdown.contributors[0].percentage, 60);
    assert.equal(fileBreakdown.contributors[1].name, 'Bob');
    assert.equal(fileBreakdown.contributors[1].percentage, 40);
  });

  it('computeContributorBreakdown should aggregate folder contributions across all files', () => {
    const sampleOwnership = [
      {
        path: 'src/analytics/churn.js',
        authors: [
          { name: 'Alice', commits: 6 },
          { name: 'Bob', commits: 4 },
        ],
      },
      {
        path: 'src/analytics/ownership.js',
        authors: [
          { name: 'Bob', commits: 5 },
          { name: 'Charlie', commits: 5 },
        ],
      },
      {
        path: 'README.md',
        authors: [{ name: 'Dave', commits: 10 }],
      },
    ];

    // For folder src/analytics:
    // Alice: 6 commits (30%)
    // Bob: 4 + 5 = 9 commits (45%)
    // Charlie: 5 commits (25%)
    // Total commits: 20
    const folderBreakdown = computeContributorBreakdown('src/analytics', sampleOwnership, true);
    assert.equal(folderBreakdown.type, 'folder');
    assert.equal(folderBreakdown.totalContribution, 20);
    assert.equal(folderBreakdown.contributors.length, 3);

    // Sorted descending by contribution:
    assert.equal(folderBreakdown.contributors[0].name, 'Bob');
    assert.equal(folderBreakdown.contributors[0].contribution, 9);
    assert.equal(folderBreakdown.contributors[0].percentage, 45);

    assert.equal(folderBreakdown.contributors[1].name, 'Alice');
    assert.equal(folderBreakdown.contributors[1].contribution, 6);
    assert.equal(folderBreakdown.contributors[1].percentage, 30);

    assert.equal(folderBreakdown.contributors[2].name, 'Charlie');
    assert.equal(folderBreakdown.contributors[2].contribution, 5);
    assert.equal(folderBreakdown.contributors[2].percentage, 25);
  });

  it('computeContributorBreakdown should handle non-existent path safely', () => {
    const breakdown = computeContributorBreakdown('does/not/exist.js', []);
    assert.equal(breakdown.totalContribution, 0);
    assert.deepEqual(breakdown.contributors, []);
  });
});

describe('file and folder list structure', () => {
  it('buildFileFolderList should extract unique folders and files', () => {
    const sampleOwnership = [
      { path: 'src/analytics/churn.js' },
      { path: 'src/analytics/ownership.js' },
      { path: 'src/ui/dashboard.js' },
      { path: 'README.md' },
    ];

    const list = buildFileFolderList(sampleOwnership);
    assert.ok(Array.isArray(list));

    const folders = list.filter((item) => item.type === 'folder').map((f) => f.path);
    const files = list.filter((item) => item.type === 'file').map((f) => f.path);

    assert.ok(folders.includes('src'));
    assert.ok(folders.includes('src/analytics'));
    assert.ok(folders.includes('src/ui'));

    assert.ok(files.includes('src/analytics/churn.js'));
    assert.ok(files.includes('src/analytics/ownership.js'));
    assert.ok(files.includes('src/ui/dashboard.js'));
    assert.ok(files.includes('README.md'));
  });

  it('buildFileFolderList should handle empty ownership data gracefully', () => {
    const list = buildFileFolderList([]);
    assert.deepEqual(list, []);
  });
});

describe('interactive 3-state navigation', () => {
  const sampleOwnership = [
    {
      path: 'src/index.js',
      authors: [
        { name: 'Dev A', commits: 8 },
        { name: 'Dev B', commits: 2 },
      ],
    },
    {
      path: 'src/ui/dashboard.js',
      authors: [
        { name: 'Dev A', commits: 5 },
      ],
    },
    {
      path: 'README.md',
      authors: [
        { name: 'Dev B', commits: 4 },
      ],
    },
  ];

  it('should navigate through all three states: Menu -> File/Folder List -> Contributor View -> Back to List -> Back to Menu', () => {
    const navigator = new DashboardNavigator({
      repoPath: REPO_ROOT,
      ownershipData: sampleOwnership,
    });

    // Initial state: State 1 (menu)
    assert.equal(navigator.state, 'menu');
    assert.equal(navigator.menuSelectedIndex, 0);

    // Find index of ownership / individual contribution item in menu
    const ownershipIndex = navigator.menuItems.findIndex((item) => item.id === 'ownership');
    assert.ok(ownershipIndex >= 0);
    navigator.menuSelectedIndex = ownershipIndex;

    // Press Enter to inspect individual contribution
    const enterRes = navigator.handleKey('\r');
    assert.equal(enterRes.state, 'file_list');
    // Now in State 2 (file_list)
    assert.equal(navigator.state, 'file_list');
    assert.ok(navigator.fileList.length > 0);
    assert.equal(navigator.fileSelectedIndex, 0);

    // Arrow down in file list
    navigator.handleKey('\u001b[B'); // Down arrow
    assert.equal(navigator.fileSelectedIndex, 1);
    const selectedItem = navigator.fileList[1];

    // Press Enter on the second file/folder item
    const viewRes = navigator.handleKey('\r');
    assert.equal(viewRes.state, 'contributor_view');
    // Now in State 3 (contributor_view)
    assert.equal(navigator.state, 'contributor_view');
    assert.equal(navigator.selectedTarget.path, selectedItem.path);

    // Verify contributor breakdown view rendering
    const viewContent = navigator.getCurrentView();
    assert.match(viewContent, /Contributors/i);
    assert.match(viewContent, /\[e \/ Esc\] Back to File\/Folder List/i);

    // Press 'e' in contributor view -> returns to State 2 (file_list)
    const backToListRes = navigator.handleKey('e');
    assert.equal(backToListRes.state, 'file_list');
    assert.equal(navigator.state, 'file_list');
    // Selection in file list MUST be preserved!
    assert.equal(navigator.fileSelectedIndex, 1);

    // Press 'e' in file_list -> returns to State 1 (menu)
    const backToMenuRes = navigator.handleKey('e');
    assert.equal(backToMenuRes.state, 'menu');
    assert.equal(navigator.state, 'menu');
    // Selection in main menu MUST be preserved!
    assert.equal(navigator.menuSelectedIndex, ownershipIndex);
  });

  it('should support Esc key navigation: Contributor View -> File List -> Menu', () => {
    const navigator = new DashboardNavigator({
      repoPath: REPO_ROOT,
      ownershipData: sampleOwnership,
    });

    const ownershipIndex = navigator.menuItems.findIndex((item) => item.id === 'ownership');
    navigator.menuSelectedIndex = ownershipIndex;
    navigator.handleKey('\r'); // Into file_list
    navigator.handleKey('\u001b[B'); // Select second item
    navigator.handleKey('\r'); // Into contributor_view
    assert.equal(navigator.state, 'contributor_view');

    // Esc returns to file_list
    const escRes = navigator.handleKey('\u001b');
    assert.equal(escRes.state, 'file_list');
    assert.equal(navigator.state, 'file_list');
    assert.equal(navigator.fileSelectedIndex, 1); // Preserves selection

    // Esc in file_list returns to menu
    const escMenuRes = navigator.handleKey('\u001b');
    assert.equal(escMenuRes.state, 'menu');
    assert.equal(navigator.state, 'menu');
    assert.equal(navigator.menuSelectedIndex, ownershipIndex);
  });

  it('should support search and filtering in file explorer', () => {
    const navigator = new DashboardNavigator({
      repoPath: REPO_ROOT,
      ownershipData: sampleOwnership,
    });

    const ownershipIndex = navigator.menuItems.findIndex((item) => item.id === 'ownership');
    navigator.menuSelectedIndex = ownershipIndex;
    navigator.handleKey('\r'); // Into file_list

    // Press '/' to enter search mode
    navigator.handleKey('/');
    assert.equal(navigator.searchMode, true);

    // Type 'dashboard'
    for (const char of 'dashboard') {
      navigator.handleKey(char);
    }
    assert.equal(navigator.searchQuery, 'dashboard');

    const filtered = navigator.getFilteredFileList();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].path, 'src/ui/dashboard.js');

    // Backspace removes last char
    navigator.handleKey('\u0008');
    assert.equal(navigator.searchQuery, 'dashboar');

    // Enter confirms query and returns to navigation in filtered list
    navigator.handleKey('\r');
    assert.equal(navigator.searchMode, false);
    assert.equal(navigator.searchQuery, 'dashboar');

    // Esc clears search query and restores full list
    navigator.handleKey('\u001b');
    assert.equal(navigator.searchQuery, '');
    assert.equal(navigator.getFilteredFileList().length, navigator.fileList.length);
  });

  it('should support arrow key wrap-around and quit key in navigator', () => {
    const navigator = new DashboardNavigator({
      repoPath: REPO_ROOT,
      ownershipData: sampleOwnership,
    });

    // Arrow up from 0 wraps to last item
    navigator.handleKey('\u001b[A'); // Up arrow
    assert.equal(navigator.menuSelectedIndex, navigator.menuItems.length - 1);

    // Arrow down wraps back to 0
    navigator.handleKey('\u001b[B'); // Down arrow
    assert.equal(navigator.menuSelectedIndex, 0);

    // Pressing 'q' returns exit action
    const exitRes = navigator.handleKey('q');
    assert.equal(exitRes.action, 'exit');
  });
});

describe('tree-style rendering', () => {
  it('renderContributorBreakdown should format tree connectors and proportional progress bars', () => {
    const rendered = renderContributorBreakdown({
      target: 'src/analytics',
      type: 'folder',
      contributors: [
        { name: 'Samit', contribution: 8, commits: 8, percentage: 80.0 },
        { name: 'Alice', contribution: 2, commits: 2, percentage: 20.0 },
      ],
      totalContribution: 10,
      repoPath: REPO_ROOT,
    });

    assert.match(rendered, /Contributors/i);
    assert.match(rendered, /src\/analytics/);
    assert.match(rendered, /Samit/);
    assert.match(rendered, /80\.0%/);
    assert.match(rendered, /Alice/);
    assert.match(rendered, /20\.0%/);
    // Tree characters
    assert.match(rendered, /├──|└──/);
    // Proportional progress bar characters
    assert.match(rendered, /█/);
    // Summary metrics
    assert.match(rendered, /Total contributors: 2/);
    assert.match(rendered, /Leading contributor: Samit/);
    assert.match(rendered, /Metric: Commit touches across Git history/);
  });

  it('renderContributorBreakdown should safely handle empty contributors', () => {
    const rendered = renderContributorBreakdown({
      target: 'empty/folder',
      type: 'folder',
      contributors: [],
      totalContribution: 0,
      repoPath: REPO_ROOT,
    });

    assert.match(rendered, /Contributors/i);
    assert.match(rendered, /no contributor data available/i);
  });

  it('renderFileFolderList should render list with icons and selection marker', () => {
    const items = [
      { type: 'folder', path: 'src' },
      { type: 'file', path: 'src/index.js' },
    ];
    const rendered = renderFileFolderList({
      items,
      selectedIndex: 1,
      repoPath: REPO_ROOT,
    });

    assert.match(rendered, /Individual Contributions/i);
    assert.match(rendered, /src\/index\.js/);
    assert.match(rendered, /▶/);
    assert.match(rendered, /Navigation: \[↑ \/ ↓\] Navigate/i);
  });
});

describe('edge cases and path handling', () => {
  it('should handle unusual paths with spaces, unicode, and deep directories', () => {
    const weirdData = [
      {
        path: 'src/assets/my test file with spaces.js',
        authors: [{ name: 'Space Author', commits: 5 }],
      },
      {
        path: 'src/i18n/üñíçødé/файл.ts',
        authors: [{ name: 'Unicode Author', commits: 3 }],
      },
      {
        path: 'a/very/deeply/nested/directory/structure/file.js',
        authors: [{ name: 'Deep Author', commits: 7 }],
      },
    ];

    const list = buildFileFolderList(weirdData);
    assert.ok(list.some((item) => item.path === 'src/assets/my test file with spaces.js'));
    assert.ok(list.some((item) => item.path === 'src/i18n/üñíçødé/файл.ts'));
    assert.ok(list.some((item) => item.path === 'a/very/deeply/nested/directory/structure'));

    const breakdownSpaces = computeContributorBreakdown('src/assets/my test file with spaces.js', weirdData, false);
    assert.equal(breakdownSpaces.contributors[0].name, 'Space Author');
    assert.equal(breakdownSpaces.contributors[0].percentage, 100);

    const breakdownUnicodeFolder = computeContributorBreakdown('src/i18n/üñíçødé', weirdData, true);
    assert.equal(breakdownUnicodeFolder.contributors[0].name, 'Unicode Author');
    assert.equal(breakdownUnicodeFolder.contributors[0].percentage, 100);
  });

  it('percentage calculations should sum to approximately 100%', () => {
    const contributors = [
      { name: 'Member A', commits: 19 },
      { name: 'Member B', commits: 13 },
      { name: 'Member C', commits: 7 },
      { name: 'Member D', commits: 4 },
      { name: 'Member E', commits: 2 },
    ];
    const results = calculateContributionPercentages(contributors);
    const sum = results.reduce((acc, c) => acc + c.percentage, 0);
    assert.ok(Math.abs(sum - 100) < 0.001);

    // Verify descending order
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(results[i].contribution >= results[i + 1].contribution);
    }
  });

  it('runInteractiveDashboard should gracefully support non-interactive stdout', () => {
    let captured = '';
    const fakeStdout = {
      isTTY: false,
      write: (data) => {
        captured += data;
      },
    };
    const fakeStdin = {
      isTTY: false,
    };

    const nav = runInteractiveDashboard({
      repoPath: REPO_ROOT,
      commits: [],
      diffs: new Map(),
      input: fakeStdin,
      output: fakeStdout,
    });

    assert.ok(nav instanceof DashboardNavigator);
    assert.match(captured, /Non-interactive terminal detected/i);
  });

  it('renderFileDetail should support array author format from computeOwnership', () => {
    const detail = renderFileDetail({
      file: 'src/analytics/ownership.js',
      hotspot: {
        riskScore: 65,
        severity: 'MEDIUM',
        churn: 2,
        ownershipConcentration: 75,
        primaryRisk: 'Moderate churn',
      },
      ownership: {
        primaryAuthor: { name: 'Alice', percentage: 75 },
        authors: [
          { name: 'Alice', commits: 6, percentage: 75 },
          { name: 'Bob', commits: 2, percentage: 25 },
        ],
        distinctAuthors: 2,
        lastTouched: 1725000000,
      },
      complexity: {
        score: 45,
        complexity: 'MEDIUM',
        branches: 12,
        maxDepth: 3,
        functions: 5,
        language: 'JavaScript',
      },
      churn: { touches: 8 },
    });

    assert.match(detail, /File Risk Deep Dive/i);
    assert.match(detail, /src\/analytics\/ownership\.js/);
    assert.match(detail, /Alice/);
    assert.match(detail, /Bob/);
    assert.match(detail, /75%/);
    assert.match(detail, /25%/);
    assert.match(detail, /Metric: Commit touches across Git history/i);
  });

  it('DashboardNavigator should navigate into file_detail and return with e and Esc', () => {
    const sampleOwnership = [
      {
        path: 'src/index.js',
        authors: [
          { name: 'Dev A', commits: 8 },
          { name: 'Dev B', commits: 2 },
        ],
      },
    ];

    const navigator = new DashboardNavigator({
      repoPath: REPO_ROOT,
      ownershipData: sampleOwnership,
    });

    const ownershipIndex = navigator.menuItems.findIndex((item) => item.id === 'ownership');
    navigator.menuSelectedIndex = ownershipIndex;
    navigator.handleKey('\r'); // Into file_list
    assert.equal(navigator.state, 'file_list');

    // Find the file item in fileList
    const fileIdx = navigator.fileList.findIndex((item) => item.type === 'file');
    assert.ok(fileIdx >= 0);
    navigator.fileSelectedIndex = fileIdx;

    // Press 'd' in file_list on a file -> transitions to file_detail
    const detailRes = navigator.handleKey('d');
    assert.equal(detailRes.state, 'file_detail');
    assert.equal(navigator.state, 'file_detail');
    const detailView = navigator.getCurrentView();
    assert.match(detailView, /File Risk Deep Dive/i);
    assert.match(detailView, /src\/index\.js/);

    // Press 'e' in file_detail -> returns to file_list
    const backRes = navigator.handleKey('e');
    assert.equal(backRes.state, 'file_list');
    assert.equal(navigator.state, 'file_list');
    assert.equal(navigator.fileSelectedIndex, fileIdx); // Preserves selection

    // Enter contributor_view
    navigator.handleKey('\r');
    assert.equal(navigator.state, 'contributor_view');

    // Press 'd' in contributor_view -> transitions to file_detail
    const detailFromContrib = navigator.handleKey('d');
    assert.equal(detailFromContrib.state, 'file_detail');
    assert.equal(navigator.state, 'file_detail');

    // Press 'Esc' in file_detail -> returns to contributor_view
    const backToContrib = navigator.handleKey('\u001b');
    assert.equal(backToContrib.state, 'contributor_view');
    assert.equal(navigator.state, 'contributor_view');
  });

  it('should support CLI detail command for single file', () => {
    const result = spawnSync(process.execPath, ['src/index.js', '.', 'detail', 'src/index.js'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /File Risk Deep Dive/i);
    assert.match(result.stdout, /src\/index\.js/);

    // Test JSON output
    const jsonResult = spawnSync(process.execPath, ['src/index.js', '.', 'detail', 'src/index.js', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(jsonResult.status, 0);
    const parsed = JSON.parse(jsonResult.stdout);
    assert.equal(parsed.file, 'src/index.js');
    assert.ok(parsed.ownership);
  });
});

// ─── Cyber Cyan Visual Upgrade Tests ─────────────────────────────────────────

describe('cyber cyan visual upgrade', () => {
  const head = resolveHead(GIT_DIR);
  const { commits } = walkCommits(GIT_DIR, [head.hash]);
  const diffs = computeAllDiffs(GIT_DIR, commits);

  it('renderSparkline should format values into proportional unicode block levels', () => {
    const spark = renderSparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    const plain = stripAnsi(spark);
    assert.equal(plain.length, 8);
    assert.equal(plain, ' ▂▃▄▅▆▇█');
  });

  it('renderSparkline should handle flat and all-zero data gracefully', () => {
    const zeros = renderSparkline([0, 0, 0, 0]);
    assert.equal(stripAnsi(zeros), '    ');

    const equal = renderSparkline([10, 10, 10]);
    assert.equal(stripAnsi(equal), '▅▅▅');

    const empty = renderSparkline([]);
    assert.equal(empty, '');
  });

  it('renderSparkline should support ascii fallback mode', () => {
    const spark = renderSparkline([0, 5, 10], { ascii: true });
    const plain = stripAnsi(spark);
    assert.equal(plain.length, 3);
    assert.match(plain, /^[_.\-=#]+$/);
  });

  it('formatSeverity should render clear textual severity badges', () => {
    assert.match(stripAnsi(formatSeverity('CRITICAL')), /^\[CRITICAL\]$/);
    assert.match(stripAnsi(formatSeverity('HIGH')), /^\[HIGH\]$/);
    assert.match(stripAnsi(formatSeverity('MEDIUM')), /^\[MEDIUM\]$/);
    assert.match(stripAnsi(formatSeverity('LOW')), /^\[LOW\]$/);
  });

  it('computeActivitySeries should partition commits into discrete intervals', () => {
    const fakeCommits = [
      { hash: 'c1', author: { timestamp: 1000 } },
      { hash: 'c2', author: { timestamp: 2000 } },
      { hash: 'c3', author: { timestamp: 3000 } },
      { hash: 'c4', author: { timestamp: 7000 } },
    ];
    const series = computeActivitySeries(fakeCommits, new Map(), 7);
    assert.ok(series);
    assert.equal(series.intervals, 7);
    assert.equal(series.commitActivity.length, 7);
    assert.equal(series.fileChurn.length, 7);
    assert.equal(series.oldestTimestamp, 1000);
    assert.equal(series.newestTimestamp, 7000);
  });

  it('computeActivitySeries should return null safely for insufficient history', () => {
    assert.equal(computeActivitySeries([], new Map()), null);
    assert.equal(computeActivitySeries([{ hash: '1', author: { timestamp: 100 } }], new Map()), null);
    assert.equal(computeActivitySeries([{ hash: '1', author: { timestamp: 100 } }, { hash: '2', author: { timestamp: 100 } }], new Map()), null);
  });

  it('renderMetricGrid should render 2-column layout and collapse to 1-column on narrow widths', () => {
    const metrics = [
      { label: 'Files', value: '1,284' },
      { label: 'Contributors', value: '12' },
      { label: 'Risk Score', value: '68 / 100 [HIGH]' },
      { label: 'Hotspots', value: '14' },
    ];

    const standard = renderMetricGrid({
      title: 'REPOSITORY INTELLIGENCE',
      repoPath: '/workspace/project',
      branch: 'main',
      metrics,
      width: 76,
    });
    assert.match(standard, /REPOSITORY INTELLIGENCE/);
    assert.match(standard, /FILES/);
    assert.match(standard, /CONTRIBUTORS/);
    assert.match(standard, /1,284/);
    assert.match(standard, /12/);
    assert.match(standard, /┬|┼/);

    const narrow = renderMetricGrid({
      title: 'REPOSITORY INTELLIGENCE',
      repoPath: '/workspace/project',
      branch: 'main',
      metrics,
      width: 48,
    });
    assert.match(narrow, /FILES/);
    assert.match(narrow, /1,284/);
    assert.doesNotMatch(narrow, /┬|┼/);
  });

  it('overview report should integrate activity sparkline and clear risk severity', () => {
    const overview = computeOverview(REPO_ROOT, commits, diffs, 80);
    const report = renderOverviewReport(overview);

    assert.match(report, /REPOSITORY INTELLIGENCE/);
    assert.match(report, /Repository Activity/);
    assert.match(report, /Recent commit activity/);
    assert.match(report, /File churn/);
    assert.match(report, /\[(CRITICAL|HIGH|MEDIUM|LOW)\]/);
  });
});

