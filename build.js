'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname);
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST, 'gitxray.js');

if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST, { recursive: true });
}

function readModule(relPath) {
  const fullPath = path.join(SRC, relPath);
  let content = fs.readFileSync(fullPath, 'utf8');

  content = content.replace(/^#!.*\n/, '');
  content = content.replace(/^['"]use strict['"];?\s*/g, '');
  return content;
}

console.log('Building Git X-Ray standalone bundle...');

const bundle = `#!/usr/bin/env node
'use strict';

// Git X-Ray — Zero-Dependency Standalone Build
// Built with Node.js standard library only.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const util = require('node:util');
const { parseArgs } = require('node:util');

// ==========================================
// 1. Error & Locator Module
// ==========================================
class GitXRayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitXRayError';
  }
}

function locateGitDir(repoPath) {
  const absPath = path.resolve(repoPath);

  if (!fs.existsSync(absPath)) {
    throw new GitXRayError(\`Path does not exist: \${absPath}\`);
  }

  const dotGitPath = path.join(absPath, '.git');

  if (fs.existsSync(dotGitPath)) {
    const stat = fs.statSync(dotGitPath);

    if (stat.isDirectory()) {
      validateGitDir(dotGitPath);
      return { gitDir: dotGitPath, isBare: false };
    }

    if (stat.isFile()) {
      const content = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\\s*(.+)$/);
      if (!match) {
        throw new GitXRayError(
          \`.git file exists but has unexpected format: \${dotGitPath}\`
        );
      }
      const resolvedGitDir = path.resolve(absPath, match[1]);
      if (!fs.existsSync(resolvedGitDir)) {
        throw new GitXRayError(
          \`.git file points to non-existent directory: \${resolvedGitDir}\`
        );
      }
      validateGitDir(resolvedGitDir);
      return { gitDir: resolvedGitDir, isBare: false };
    }
  }

  if (isBareRepo(absPath)) {
    return { gitDir: absPath, isBare: true };
  }

  throw new GitXRayError(
    \`Not a git repository (or any parent up to filesystem root): \${absPath}\`
  );
}

function validateGitDir(gitDir) {
  const headPath = path.join(gitDir, 'HEAD');
  if (!fs.existsSync(headPath)) {
    throw new GitXRayError(
      \`Invalid git directory (missing HEAD): \${gitDir}\`
    );
  }

  const objectsPath = path.join(gitDir, 'objects');
  if (!fs.existsSync(objectsPath)) {
    throw new GitXRayError(
      \`Invalid git directory (missing objects/): \${gitDir}\`
    );
  }
}

function isBareRepo(dirPath) {
  return (
    fs.existsSync(path.join(dirPath, 'HEAD')) &&
    fs.existsSync(path.join(dirPath, 'objects')) &&
    fs.existsSync(path.join(dirPath, 'refs'))
  );
}

// ==========================================
// 2. Object Reader & Parsers
// ==========================================
function hashToPath(gitDir, hash) {
  return path.join(gitDir, 'objects', hash.slice(0, 2), hash.slice(2));
}

function looseObjectExists(gitDir, hash) {
  return fs.existsSync(hashToPath(gitDir, hash));
}

function readLooseObject(gitDir, hash) {
  const objPath = hashToPath(gitDir, hash);

  if (!fs.existsSync(objPath)) {
    return null;
  }

  let raw;
  try {
    const compressed = fs.readFileSync(objPath);
    raw = zlib.inflateSync(compressed);
  } catch (err) {
    throw new GitXRayError(
      \`Failed to read/inflate object \${hash}: \${err.message}\`
    );
  }

  const actualHash = crypto.createHash('sha1').update(raw).digest('hex');
  if (actualHash !== hash) {
    throw new GitXRayError(
      \`Object \${hash} failed integrity check (computed \${actualHash})\`
    );
  }

  const nullIdx = raw.indexOf(0);
  if (nullIdx === -1) {
    throw new GitXRayError(\`Malformed object \${hash}: missing null byte\`);
  }

  const header = raw.subarray(0, nullIdx).toString('utf8');
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx === -1) {
    throw new GitXRayError(\`Malformed object header in \${hash}: "\${header}"\`);
  }

  const type = header.slice(0, spaceIdx);
  const size = parseInt(header.slice(spaceIdx + 1), 10);
  const body = raw.subarray(nullIdx + 1);

  if (body.length !== size) {
    throw new GitXRayError(
      \`Object \${hash} size mismatch: header says \${size}, body is \${body.length}\`
    );
  }

  return { type, size, body };
}

function parseCommit(hash, body) {
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

  const blankLineIdx = text.indexOf('\\n\\n');

  let headerBlock, messageBlock;
  if (blankLineIdx === -1) {
    headerBlock = text;
    messageBlock = '';
  } else {
    headerBlock = text.slice(0, blankLineIdx);
    messageBlock = text.slice(blankLineIdx + 2);
  }

  result.message = messageBlock.trimEnd();

  const lines = headerBlock.split('\\n');
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
      i++;
      while (i < lines.length && lines[i].startsWith(' ')) {
        i++;
      }
      continue;
    }
    i++;
  }

  if (!result.tree) {
    throw new GitXRayError(\`Commit \${hash} missing tree field\`);
  }

  return result;
}

function parseAuthorLine(line) {
  const match = line.match(/^(.+?)\\s*<([^>]*)>\\s*(\\d+)\\s*([+-]\\d{4})$/);
  if (!match) {
    return { name: line.trim(), email: '', timestamp: 0, tz: '+0000' };
  }

  return {
    name: match[1].trim(),
    email: match[2],
    timestamp: parseInt(match[3], 10),
    tz: match[4],
  };
}

function parseTree(body) {
  const entries = [];
  let offset = 0;

  while (offset < body.length) {
    const spaceIdx = body.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const mode = body.subarray(offset, spaceIdx).toString('ascii');

    const nullIdx = body.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = body.subarray(spaceIdx + 1, nullIdx).toString('utf8');

    const hashStart = nullIdx + 1;
    const hashEnd = hashStart + 20;
    if (hashEnd > body.length) break;
    const hash = body.subarray(hashStart, hashEnd).toString('hex');

    entries.push({ mode, name, hash });
    offset = hashEnd;
  }

  return entries;
}

// ==========================================
// 3. Ref Resolver
// ==========================================
function resolveHead(gitDir) {
  const headPath = path.join(gitDir, 'HEAD');

  if (!fs.existsSync(headPath)) {
    throw new GitXRayError(\`HEAD file not found: \${headPath}\`);
  }

  const content = fs.readFileSync(headPath, 'utf8').trim();

  if (content.startsWith('ref: ')) {
    const refName = content.slice(5).trim();
    const hash = resolveRef(gitDir, refName);
    if (!hash) {
      throw new GitXRayError(
        \`HEAD points to \${refName} which cannot be resolved (empty repo or broken ref)\`
      );
    }
    return { hash, ref: refName };
  }

  if (/^[0-9a-f]{40}$/i.test(content)) {
    return { hash: content.toLowerCase(), ref: null };
  }

  throw new GitXRayError(\`Unexpected HEAD format: "\${content}"\`);
}

function resolveRef(gitDir, refName) {
  const refPath = path.join(gitDir, refName);
  if (fs.existsSync(refPath)) {
    const content = fs.readFileSync(refPath, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(content)) {
      return content.toLowerCase();
    }
    if (content.startsWith('ref: ')) {
      return resolveRef(gitDir, content.slice(5).trim());
    }
  }

  return resolveFromPackedRefs(gitDir, refName);
}

function resolveFromPackedRefs(gitDir, refName) {
  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (!fs.existsSync(packedRefsPath)) {
    return null;
  }

  const content = fs.readFileSync(packedRefsPath, 'utf8');
  const lines = content.split('\\n');

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') {
      continue;
    }

    const parts = line.trim().split(/\\s+/);
    if (parts.length >= 2 && parts[1] === refName) {
      return parts[0].toLowerCase();
    }
  }

  return null;
}

function getAllBranches(gitDir) {
  const branches = new Map();

  const headsDir = path.join(gitDir, 'refs', 'heads');
  if (fs.existsSync(headsDir)) {
    walkRefsDir(headsDir, 'refs/heads', branches);
  }

  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (fs.existsSync(packedRefsPath)) {
    const content = fs.readFileSync(packedRefsPath, 'utf8');
    for (const line of content.split('\\n')) {
      if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') {
        continue;
      }
      const parts = line.trim().split(/\\s+/);
      if (parts.length >= 2 && parts[1].startsWith('refs/heads/')) {
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

function walkRefsDir(dirPath, prefix, result) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const refName = \`\${prefix}/\${entry.name}\`;

    if (entry.isDirectory()) {
      walkRefsDir(fullPath, refName, result);
    } else if (entry.isFile()) {
      try {
        const hash = fs.readFileSync(fullPath, 'utf8').trim();
        if (/^[0-9a-f]{40}$/i.test(hash)) {
          result.set(refName, hash.toLowerCase());
        }
      } catch {}
    }
  }
}

// ==========================================
// 4. Commit Walker & Tree Differ
// ==========================================
function walkCommits(gitDir, startHashes) {
  const visited = new Set();
  const commits = [];
  const queue = [...startHashes];
  let packedCount = 0;

  while (queue.length > 0) {
    const hash = queue.shift();

    if (visited.has(hash)) continue;
    visited.add(hash);

    const obj = readLooseObject(gitDir, hash);
    if (!obj) {
      packedCount++;
      continue;
    }

    if (obj.type !== 'commit') continue;

    let commit;
    try {
      commit = parseCommit(hash, obj.body);
    } catch {
      continue;
    }

    commits.push(commit);

    for (const parentHash of commit.parents) {
      if (!visited.has(parentHash)) {
        queue.push(parentHash);
      }
    }
  }

  commits.sort((a, b) => b.author.timestamp - a.author.timestamp);

  return { commits, packedCount };
}

function diffTrees(gitDir, oldTreeHash, newTreeHash) {
  const oldFiles = oldTreeHash ? flattenTree(gitDir, oldTreeHash, '') : new Map();
  const newFiles = flattenTree(gitDir, newTreeHash, '');

  const added = [];
  const modified = [];
  const deleted = [];

  for (const [filePath, newHash] of newFiles) {
    if (!oldFiles.has(filePath)) {
      added.push(filePath);
    } else if (oldFiles.get(filePath) !== newHash) {
      modified.push(filePath);
    }
  }

  for (const [filePath] of oldFiles) {
    if (!newFiles.has(filePath)) {
      deleted.push(filePath);
    }
  }

  return { added, modified, deleted };
}

function flattenTree(gitDir, treeHash, prefix) {
  const result = new Map();

  const obj = readLooseObject(gitDir, treeHash);
  if (!obj || obj.type !== 'tree') {
    return result;
  }

  const entries = parseTree(obj.body);

  for (const entry of entries) {
    const fullPath = prefix ? \`\${prefix}/\${entry.name}\` : entry.name;

    if (entry.mode === '40000' || entry.mode === '040000') {
      const subEntries = flattenTree(gitDir, entry.hash, fullPath);
      for (const [k, v] of subEntries) {
        result.set(k, v);
      }
    } else {
      result.set(fullPath, entry.hash);
    }
  }

  return result;
}

function computeAllDiffs(gitDir, commits) {
  const diffs = new Map();
  const commitMap = new Map();
  for (const c of commits) {
    commitMap.set(c.hash, c);
  }

  for (const commit of commits) {
    let parentTreeHash = null;
    if (commit.parents.length > 0) {
      const parentCommit = commitMap.get(commit.parents[0]);
      if (parentCommit) {
        parentTreeHash = parentCommit.tree;
      } else {
        diffs.set(commit.hash, { added: [], modified: [], deleted: [] });
        continue;
      }
    }

    try {
      const diff = diffTrees(gitDir, parentTreeHash, commit.tree);
      diffs.set(commit.hash, diff);
    } catch {
      diffs.set(commit.hash, { added: [], modified: [], deleted: [] });
    }
  }

  return diffs;
}

// ==========================================
// 5. Analytics Layer
// ==========================================
function computeChurn(commits, diffs) {
  const touchCount = new Map();

  for (const commit of commits) {
    const diff = diffs.get(commit.hash);
    if (!diff) continue;

    const touchedFiles = [...diff.added, ...diff.modified, ...diff.deleted];
    for (const filePath of touchedFiles) {
      touchCount.set(filePath, (touchCount.get(filePath) || 0) + 1);
    }
  }

  return Array.from(touchCount.entries())
    .map(([path, touches]) => ({ path, touches }))
    .sort((a, b) => b.touches - a.touches);
}

function computeOwnership(commits, diffs) {
  const fileAuthors = new Map();

  for (const commit of commits) {
    const diff = diffs.get(commit.hash);
    if (!diff) continue;

    const authorKey = \`\${commit.author.name} <\${commit.author.email}>\`;
    const touchedFiles = [...diff.added, ...diff.modified];

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

function computeBusFactor(ownershipData, threshold = 80) {
  const results = [];

  for (const entry of ownershipData) {
    if (entry.distinctAuthors === 0) continue;

    const topAuthor = entry.authors[0];
    const atRisk = topAuthor.percentage >= threshold;

    results.push({
      path: entry.path,
      topAuthor: topAuthor.name,
      topAuthorPercentage: topAuthor.percentage,
      distinctAuthors: entry.distinctAuthors,
      atRisk,
    });
  }

  return results.sort((a, b) => {
    if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
    return b.topAuthorPercentage - a.topAuthorPercentage;
  });
}

// ==========================================
// 6. Terminal & JSON Formatters
// ==========================================
const colorEnabled =
  !process.env.NO_COLOR &&
  process.stdout.isTTY !== false;

function style(styleName, text) {
  if (!colorEnabled || typeof util.styleText !== 'function') {
    return text;
  }
  try {
    return util.styleText(styleName, text);
  } catch {
    return text;
  }
}

function formatTable(headers, rows, options = {}) {
  const headerStyle = options.headerStyle || 'bold';

  const colWidths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => {
      const cellLen = stripAnsi(String(row[i] || '')).length;
      return Math.max(max, cellLen);
    }, 0);
    return Math.max(stripAnsi(h).length, dataMax);
  });

  const headerLine = headers
    .map((h, i) => style(headerStyle, padRight(h, colWidths[i])))
    .join('  ');

  const separator = colWidths.map((w) => '─'.repeat(w)).join('──');

  const dataLines = rows.map((row) =>
    row.map((cell, i) => padRight(String(cell || ''), colWidths[i])).join('  ')
  );

  return [headerLine, separator, ...dataLines].join('\\n');
}

function padRight(str, width) {
  const visibleLen = stripAnsi(str).length;
  if (visibleLen >= width) return str;
  return str + ' '.repeat(width - visibleLen);
}

function stripAnsi(str) {
  return str.replace(/\\x1b\\[[0-9;]*m/g, '');
}

function printHeader(title) {
  console.log('\\n' + style('bold', style('cyan', \`═══ \${title} ═══\`)));
}

function printWarning(message) {
  console.log(style('yellow', \`⚠  \${message}\`));
}

function printSuccess(message) {
  console.log(style('green', \`✓  \${message}\`));
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function formatPercent(value) {
  return \`\${value.toFixed(1)}%\`;
}

function colorPercent(value) {
  const text = formatPercent(value);
  if (value >= 80) return style('red', text);
  if (value >= 50) return style('yellow', text);
  return style('green', text);
}

function formatJSON(data) {
  return JSON.stringify(data, null, 2);
}

// ==========================================
// 7. CLI Argument Parsing & Wiring
// ==========================================
function parseCLI() {
  const COMMANDS = ['log', 'ownership', 'churn', 'bus-factor', 'interactive'];

  const { values, positionals } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '80' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  let repoPath, command;

  if (positionals.length === 1) {
    // Could be: gitxray <command> OR gitxray <path>
    if (COMMANDS.includes(positionals[0])) {
      command = positionals[0];
      repoPath = process.cwd();
    } else {
      // Default single-path invocation opens the central dashboard experience.
      repoPath = positionals[0];
      command = 'interactive';
    }
  } else {
    repoPath = positionals[0];
    command = positionals[1];
  }

  if (!COMMANDS.includes(command)) {
    console.error(\`Unknown command: "\${command}"\`);
    console.error('Available commands: ' + COMMANDS.join(', '));
    process.exit(1);
  }

  const threshold = parseInt(values.threshold, 10);
  if (isNaN(threshold) || threshold < 0 || threshold > 100) {
    console.error('--threshold must be a number between 0 and 100');
    process.exit(1);
  }

  return {
    command,
    repoPath,
    options: {
      json: values.json,
      threshold,
    },
  };
}

function printHelp() {
  const help = \`
Git X-Ray — an X-ray machine for your codebase's history

Usage:
  gitxray <path> <command> [options]
  gitxray <path> [options]          (opens the dashboard)
  gitxray <command> [options]       (uses current directory)

Commands:
  log          Reconstructed commit history (hash, author, date, message)
  ownership    Per-file ownership breakdown (primary author, distinct authors)
  churn        Files ranked by number of changes across history
  bus-factor   Files at risk — one author owns >N% of commits

Options:
  --json             Output as JSON instead of colored terminal table
  --threshold <N>    Bus-factor threshold percentage (default: 80)
  -h, --help         Show this help message

Examples:
  gitxray .
  gitxray . log
  gitxray /path/to/repo ownership --json
  gitxray . bus-factor --threshold 70
\`.trim();

  console.log(help);
}

function main() {
  const { command, repoPath, options } = parseCLI();

  try {
    const { gitDir, isBare } = locateGitDir(repoPath);
    const head = resolveHead(gitDir);
    const branches = getAllBranches(gitDir);

    const startHashes = new Set([head.hash]);
    for (const branch of branches) {
      startHashes.add(branch.hash);
    }

    const { commits, packedCount } = walkCommits(gitDir, [...startHashes]);

    if (packedCount > 0) {
      if (!options.json) {
        printWarning(
          \`\${packedCount} object(s) are packed and not analyzed. \` +
            'For complete results, analyze a repo before git gc, or run: git unpack-objects'
        );
      }
    }

    if (commits.length === 0) {
      if (options.json) {
        console.log(formatJSON({ error: 'No commits found (empty repo or all objects are packed)' }));
      } else {
        printWarning('No commits found. The repo may be empty or all objects are packed.');
      }
      process.exit(0);
    }

    switch (command) {
      case 'interactive': {
        const diffs = computeAllDiffs(gitDir, commits);
        runInteractiveDashboard({
          repoPath,
          commits,
          packedCount,
          diffs,
          options,
          onSelect: (selectedCommand) => {
            if (selectedCommand === 'log') handleLog(repoPath, commits, packedCount, options);
            else if (selectedCommand === 'churn') handleChurn(repoPath, commits, diffs, options);
            else if (selectedCommand === 'ownership') handleOwnership(repoPath, commits, diffs, options);
            else if (selectedCommand === 'bus-factor') handleBusFactor(repoPath, commits, diffs, options);
          },
        });
        break;
      }
      case 'log':
        handleLog(repoPath, commits, packedCount, options);
        break;
      case 'churn':
      case 'ownership':
      case 'bus-factor': {
        const diffs = computeAllDiffs(gitDir, commits);
        if (command === 'churn') handleChurn(repoPath, commits, diffs, options);
        else if (command === 'ownership') handleOwnership(repoPath, commits, diffs, options);
        else handleBusFactor(repoPath, commits, diffs, options);
        break;
      }
    }
  } catch (err) {
    if (err instanceof GitXRayError) {
      if (options.json) {
        console.error(formatJSON({ error: err.message }));
      } else {
        console.error(style('red', \`Error: \${err.message}\`));
      }
      process.exit(1);
    }
    console.error(style('red', \`Unexpected error: \${err.message}\`));
    process.exit(2);
  }
}

function buildDashboardMenu({ repoPath = process.cwd(), metrics = {} } = {}) {
  const items = [
    {
      id: 'log',
      label: 'Commit Log',
      description: 'Review recent commits and authorship trail',
      accent: 'cyan',
    },
    {
      id: 'ownership',
      label: 'Ownership',
      description: 'See per-file author concentration and recent hotspots',
      accent: 'green',
    },
    {
      id: 'churn',
      label: 'Churn',
      description: 'Find the files with the most edit activity over time',
      accent: 'yellow',
    },
    {
      id: 'bus-factor',
      label: 'Bus Factor',
      description: 'Highlight files dominated by a single author',
      accent: 'red',
    },
  ];

  return items.map((item, index) => ({
    ...item,
    index,
    repoPath,
    summary: {
      commits: metrics.commits ?? '—',
      files: metrics.files ?? '—',
      status: metrics.status ?? 'Live',
    },
  }));
}

function renderDashboardMenu({ repoPath = process.cwd(), items = [], selectedIndex = 0 } = {}) {
  const width = 78;
  const top = '╭' + '─'.repeat(width - 2) + '╮';
  const bottom = '╰' + '─'.repeat(width - 2) + '╯';
  const title = style('bold', style('cyan', 'Git X-Ray'));
  const subtitle = style('dim', repoPath || process.cwd());

  const rows = [
    top,
    `│ ${padRight(title, width - 4)} │`,
    `│ ${padRight(subtitle, width - 4)} │`,
    `│ ${padRight('', width - 4)} │`,
  ];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const active = i === selectedIndex;
    const indicator = active ? '▶' : ' ';
    const label = active ? style('bold', style(item.accent || 'cyan', item.label)) : item.label;
    const description = active ? style('dim', item.description) : item.description;
    rows.push(`│ ${padRight(`${indicator} ${label}  ${description}`, width - 4)} │`);
  }

  rows.push(`│ ${padRight(style('bold', 'Keyboard: ↑ ↓ to move • Enter to run • q to quit'), width - 4)} │`);
  rows.push(bottom);
  return rows.join('\n');
}

function runInteractiveDashboard({ repoPath, commits, packedCount, diffs, onSelect }) {
  if (!process.stdout.isTTY) {
    console.log(renderDashboardMenu({
      repoPath,
      items: buildDashboardMenu({
        repoPath,
        metrics: { commits: commits.length, files: diffs ? diffs.size : '—', status: packedCount > 0 ? 'Partial' : 'Live' },
      }),
      selectedIndex: 0,
    }));
    console.log(style('dim', 'Non-interactive terminal detected; use a direct command such as gitxray . log or gitxray . ownership.'));
    return;
  }

  const items = buildDashboardMenu({
    repoPath,
    metrics: { commits: commits.length, files: diffs ? diffs.size : '—', status: packedCount > 0 ? 'Partial' : 'Live' },
  });

  let selectedIndex = 0;
  const render = () => {
    console.clear();
    console.log(renderDashboardMenu({ repoPath, items, selectedIndex }));
  };

  render();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const onKey = (key) => {
    if (key === '\u0003' || key.toLowerCase() === 'q') {
      stdin.setRawMode(false);
      stdin.pause();
      console.clear();
      process.exit(0);
    }

    if (key === '\u001b[A') {
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      render();
    }

    if (key === '\u001b[B') {
      selectedIndex = (selectedIndex + 1) % items.length;
      render();
    }

    if (key === '\r' || key === '\n') {
      stdin.setRawMode(false);
      stdin.pause();
      const selected = items[selectedIndex];
      console.clear();
      if (typeof onSelect === 'function') {
        onSelect(selected.id);
      }
    }
  };

  stdin.on('data', onKey);
}

function padRight(str, width) {
  const output = String(str);
  const visible = output.replace(/\u001b\[[0-9;]*m/g, '').length;
  return visible >= width ? output : output + ' '.repeat(width - visible);
}

function handleLog(commits, packedCount, options) {
  if (options.json) {
    const data = commits.map((c) => ({
      hash: c.hash,
      author: \`\${c.author.name} <\${c.author.email}>\`,
      date: new Date(c.author.timestamp * 1000).toISOString(),
      message: c.message.split('\\n')[0],
      parents: c.parents,
      isMerge: c.parents.length > 1,
    }));
    console.log(formatJSON({ commits: data, totalCommits: data.length, packedSkipped: packedCount }));
    return;
  }

  printHeader(\`Commit Log (\${commits.length} commits)\`);

  if (commits.length <= 30) {
    for (const c of commits) {
      const hashStr = style('yellow', c.hash.slice(0, 8));
      const dateStr = style('dim', formatDate(c.author.timestamp));
      const authorStr = style('green', c.author.name);
      const mergeTag = c.parents.length > 1 ? style('cyan', ' [merge]') : '';
      const msg = c.message.split('\\n')[0];

      console.log(\`\${hashStr} \${dateStr} \${authorStr}\${mergeTag}\`);
      console.log(\`         \${msg}\`);
    }
  } else {
    const headers = ['Hash', 'Date', 'Author', 'Message'];
    const rows = commits.map((c) => [
      c.hash.slice(0, 8),
      formatDate(c.author.timestamp),
      c.author.name,
      c.message.split('\\n')[0].slice(0, 60),
    ]);
    console.log(formatTable(headers, rows));
  }

  printSuccess(\`\${commits.length} commits analyzed\`);
}

function handleChurn(commits, diffs, options) {
  const churnData = computeChurn(commits, diffs);

  if (options.json) {
    console.log(formatJSON({ churn: churnData, totalFiles: churnData.length }));
    return;
  }

  printHeader(\`Churn Report (\${churnData.length} files)\`);

  if (churnData.length === 0) {
    printWarning('No file changes detected.');
    return;
  }

  const headers = ['File', 'Touches', 'Bar'];
  const maxTouches = churnData[0].touches;
  const rows = churnData.map((entry) => {
    const barLen = Math.max(1, Math.round((entry.touches / maxTouches) * 20));
    const bar = '█'.repeat(barLen);
    return [entry.path, String(entry.touches), style('cyan', bar)];
  });

  console.log(formatTable(headers, rows));
  printSuccess(\`\${churnData.length} files tracked across \${commits.length} commits\`);
}

function handleOwnership(commits, diffs, options) {
  const ownershipData = computeOwnership(commits, diffs);

  if (options.json) {
    const data = ownershipData.map((entry) => ({
      ...entry,
      lastTouched: new Date(entry.lastTouched * 1000).toISOString(),
    }));
    console.log(formatJSON({ ownership: data, totalFiles: data.length }));
    return;
  }

  printHeader(\`Ownership Report (\${ownershipData.length} files)\`);

  if (ownershipData.length === 0) {
    printWarning('No file ownership data available.');
    return;
  }

  const headers = ['File', 'Primary Author', 'Ownership', 'Authors', 'Last Touched'];
  const rows = ownershipData.map((entry) => [
    entry.path,
    entry.primaryAuthor.name,
    colorPercent(entry.primaryAuthor.percentage),
    String(entry.distinctAuthors),
    formatDate(entry.lastTouched),
  ]);

  console.log(formatTable(headers, rows));
  printSuccess(\`\${ownershipData.length} files analyzed\`);
}

function handleBusFactor(commits, diffs, options) {
  const ownershipData = computeOwnership(commits, diffs);
  const busFactorData = computeBusFactor(ownershipData, options.threshold);

  if (options.json) {
    console.log(
      formatJSON({
        busFactor: busFactorData,
        threshold: options.threshold,
        atRiskCount: busFactorData.filter((e) => e.atRisk).length,
        totalFiles: busFactorData.length,
      })
    );
    return;
  }

  printHeader(\`Bus Factor Report (threshold: \${options.threshold}%)\`);

  const atRisk = busFactorData.filter((e) => e.atRisk);
  const safe = busFactorData.filter((e) => !e.atRisk);

  if (atRisk.length > 0) {
    console.log(style('red', \`\\n⚠  \${atRisk.length} file(s) at risk:\`));
    const headers = ['File', 'Top Author', 'Ownership', 'Authors'];
    const rows = atRisk.map((entry) => [
      entry.path,
      entry.topAuthor,
      colorPercent(entry.topAuthorPercentage),
      String(entry.distinctAuthors),
    ]);
    console.log(formatTable(headers, rows));
  } else {
    printSuccess('No files at risk — bus factor looks healthy!');
  }

  if (safe.length > 0 && atRisk.length > 0) {
    console.log(
      style('dim', \`\\n\${safe.length} file(s) below threshold (not shown)\`)
    );
  }

  printSuccess(
    \`\${busFactorData.length} files analyzed, \${atRisk.length} at risk (>\${options.threshold}%)\`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  locateGitDir,
  readLooseObject,
  parseCommit,
  parseTree,
  resolveHead,
  walkCommits,
  diffTrees,
  computeChurn,
  computeOwnership,
  computeBusFactor,
};
`;

fs.writeFileSync(OUT_FILE, bundle.trim() + '\n', 'utf8');

const hash = crypto.createHash('sha256').update(fs.readFileSync(OUT_FILE)).digest('hex');
console.log(`✓ Built dist/gitxray.js (SHA-256: ${hash})`);
