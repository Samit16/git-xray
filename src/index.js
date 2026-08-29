#!/usr/bin/env node
'use strict';

const { locateGitDir, GitXRayError } = require('./git/locator.js');
const { resolveHead, getAllBranches } = require('./git/refs.js');
const { walkCommits, computeAllDiffs } = require('./git/walker.js');
const { computeChurn } = require('./analytics/churn.js');
const { computeOwnership } = require('./analytics/ownership.js');
const { computeBusFactor } = require('./analytics/bus-factor.js');
const { parseCLI } = require('./cli/args.js');
const { formatJSON } = require('./outputs/json.js');
const {
  style,
  formatTable,
  renderDashboardSummary,
  printHeader,
  printWarning,
  printSuccess,
  formatDate,
  colorPercent,
  formatPercent,
} = require('./outputs/terminal.js');
const { buildDashboardMenu, renderDashboardMenu, runInteractiveDashboard } = require('./ui/dashboard.js');

/**
 * Main entry point — wires the full pipeline:
 * CLI args → .git locator → ref resolver → commit walker → tree differ → analytics → output
 */
function main() {
  const { command, repoPath, options } = parseCLI();

  try {
    // Step 1: Locate .git
    const { gitDir, isBare } = locateGitDir(repoPath);

    // Step 2: Resolve HEAD + get all branch tips
    const head = resolveHead(gitDir);
    const branches = getAllBranches(gitDir);

    // Collect all unique branch tip hashes as walk starting points
    const startHashes = new Set([head.hash]);
    for (const branch of branches) {
      startHashes.add(branch.hash);
    }

    // Step 3: Walk commit graph
    const { commits, packedCount } = walkCommits(gitDir, [...startHashes]);

    if (packedCount > 0) {
      if (!options.json) {
        printWarning(
          `${packedCount} object(s) could not be read and were skipped. ` +
            'History may be incomplete.'
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

    // Step 4: Dispatch to command handler
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
        // These all need diffs
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
        console.error(style('red', `Error: ${err.message}`));
      }
      process.exit(1);
    }
    // Unexpected error
    console.error(style('red', `Unexpected error: ${err.message}`));
    process.exit(2);
  }
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

function handleLog(repoPath, commits, packedCount, options) {
  if (options.json) {
    const data = commits.map((c) => ({
      hash: c.hash,
      author: `${c.author.name} <${c.author.email}>`,
      date: new Date(c.author.timestamp * 1000).toISOString(),
      message: c.message.split('\n')[0],
      parents: c.parents,
      isMerge: c.parents.length > 1,
    }));
    console.log(formatJSON({ commits: data, totalCommits: data.length, packedSkipped: packedCount }));
    return;
  }

  console.log(
    renderDashboardSummary({
      title: `Commit Log (${commits.length} commits)`,
      repoPath,
      metrics: [
        { label: 'Commits', value: commits.length },
        { label: 'Packed', value: packedCount },
      ],
      status: 'Live',
    })
  );

  if (commits.length <= 30) {
    // Detailed view for small repos
    for (const c of commits) {
      const hashStr = style('yellow', c.hash.slice(0, 8));
      const dateStr = style('dim', formatDate(c.author.timestamp));
      const authorStr = style('green', c.author.name);
      const mergeTag = c.parents.length > 1 ? style('cyan', ' [merge]') : '';
      const msg = c.message.split('\n')[0];

      console.log(`${hashStr} ${dateStr} ${authorStr}${mergeTag}`);
      console.log(`         ${msg}`);
    }
  } else {
    // Table view for larger repos
    const headers = ['Hash', 'Date', 'Author', 'Message'];
    const rows = commits.map((c) => [
      c.hash.slice(0, 8),
      formatDate(c.author.timestamp),
      c.author.name,
      c.message.split('\n')[0].slice(0, 60),
    ]);
    console.log(formatTable(headers, rows));
  }

  printSuccess(`${commits.length} commits analyzed`);
}

function handleChurn(repoPath, commits, diffs, options) {
  const churnData = computeChurn(commits, diffs);

  if (options.json) {
    console.log(formatJSON({ churn: churnData, totalFiles: churnData.length }));
    return;
  }

  console.log(
    renderDashboardSummary({
      title: `Churn Report (${churnData.length} files)`,
      repoPath,
      metrics: [
        { label: 'Files', value: churnData.length },
        { label: 'Commits', value: commits.length },
      ],
      status: 'Live',
    })
  );

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
  printSuccess(`${churnData.length} files tracked across ${commits.length} commits`);
}

function handleOwnership(repoPath, commits, diffs, options) {
  const ownershipData = computeOwnership(commits, diffs);

  if (options.json) {
    const data = ownershipData.map((entry) => ({
      ...entry,
      lastTouched: new Date(entry.lastTouched * 1000).toISOString(),
    }));
    console.log(formatJSON({ ownership: data, totalFiles: data.length }));
    return;
  }

  console.log(
    renderDashboardSummary({
      title: `Ownership Report (${ownershipData.length} files)`,
      repoPath,
      metrics: [
        { label: 'Files', value: ownershipData.length },
        { label: 'Authors', value: new Set(commits.flatMap((c) => [c.author.email])).size },
      ],
      status: 'Healthy',
    })
  );

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
  printSuccess(`${ownershipData.length} files analyzed`);
}

function handleBusFactor(repoPath, commits, diffs, options) {
  const ownershipData = computeOwnership(commits, diffs);
  const busFactorData = computeBusFactor(ownershipData, options.threshold);
  const atRisk = busFactorData.filter((e) => e.atRisk);
  const safe = busFactorData.filter((e) => !e.atRisk);

  if (options.json) {
    console.log(
      formatJSON({
        busFactor: busFactorData,
        threshold: options.threshold,
        atRiskCount: atRisk.length,
        totalFiles: busFactorData.length,
      })
    );
    return;
  }

  console.log(
    renderDashboardSummary({
      title: `Bus Factor Report (threshold: ${options.threshold}%)`,
      repoPath,
      metrics: [
        { label: 'Files', value: busFactorData.length },
        { label: 'At risk', value: atRisk.length },
      ],
      status: atRisk.length > 0 ? 'Watchlist' : 'Healthy',
    })
  );

  if (atRisk.length > 0) {
    console.log(style('red', `\n⚠  ${atRisk.length} file(s) at risk:`));
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
      style('dim', `\n${safe.length} file(s) below threshold (not shown)`)
    );
  }

  printSuccess(
    `${busFactorData.length} files analyzed, ${atRisk.length} at risk (>${options.threshold}%)`
  );
}

main();
