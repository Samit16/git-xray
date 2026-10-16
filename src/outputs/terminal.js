'use strict';

const path = require('node:path');
const {
  style,
  stripAnsi,
  visibleLength,
  getTerminalWidth,
  padRight,
  padLeft,
  padCenter,
  truncate,
  BOX,
  BADGES,
  formatSeverity,
  renderSparkline,
  renderBar,
} = require('../ui/core.js');
const { renderLogo } = require('../ui/logo.js');
const {
  renderPanel,
  renderExecutiveCard,
  renderMetricGrid,
  renderTable,
  renderSection,
} = require('../ui/components.js');

/**
 * Format a table with aligned columns for terminal output.
 * Fully ANSI-aware, supports responsive wrapping.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{ headerStyle?: string }} options
 * @returns {string}
 */
function formatTable(headers, rows, options = {}) {
  return renderTable(headers, rows, { headerColor: options.headerStyle || 'cyan' });
}

function renderSummaryPanel({ title, repoPath, metrics = [], status = 'Ready' }) {
  return renderExecutiveCard({
    title,
    repoPath: repoPath || process.cwd(),
    metrics: metrics.map((m) => {
      if (typeof m === 'string') {
        const parts = m.split(':');
        return { label: parts[0]?.trim() || '', value: parts[1]?.trim() || '' };
      }
      return m;
    }),
    status,
  });
}

function renderDashboardSummary({ title, repoPath, metrics = [], status = 'Ready' }) {
  return renderExecutiveCard({
    title,
    repoPath: repoPath || process.cwd(),
    metrics,
    status,
  });
}

function printHeader(title, repoPath = process.cwd(), metrics = []) {
  console.log('\n' + renderSummaryPanel({
    title,
    repoPath,
    metrics,
    status: 'Live',
  }));
}

function printWarning(message) {
  console.log(style('yellow', `⚠  ${message}`));
}

function printSuccess(message) {
  console.log(style('green', `✓  ${message}`));
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function colorPercent(value) {
  const text = formatPercent(value);
  if (value >= 80) return style('red', text);
  if (value >= 50) return style('yellow', text);
  return style('green', text);
}

/**
 * Render Executive Overview / Repository Health Report.
 * Structured around user questions: What is the state? What is wrong? What to check next?
 *
 * @param {Object} overview — from computeOverview()
 * @returns {string}
 */
function renderOverviewReport(overview) {
  const lines = [];

  // 1. Clean Logo Header
  lines.push(renderLogo({ showSubtitle: true }));
  lines.push('');

  // 2. Repository Intelligence & Health Summary Card
  const riskColor = overview.overallRisk === 'CRITICAL' ? 'red' : overview.overallRisk === 'HIGH' ? 'yellow' : overview.overallRisk === 'MEDIUM' ? 'cyan' : 'green';

  const intelligenceCard = renderMetricGrid({
    title: 'REPOSITORY INTELLIGENCE',
    repoPath: overview.repository,
    branch: overview.branch || 'main',
    subtitle: `Git X-Ray Repository Health Summary: ${formatSeverity(overview.overallRisk)} (${overview.riskScore} / 100)`,
    metrics: [
      { label: 'Files', value: overview.fileCount?.toLocaleString() || '0' },
      { label: 'Contributors', value: overview.contributorCount?.toLocaleString() || '0' },
      { label: 'Risk Score', value: `${overview.riskScore} / 100 [${overview.overallRisk}]`, color: riskColor },
      { label: 'Hotspots', value: String(overview.topHotspots?.length || 0) },
      { label: 'Bus Factor = 1', value: `${overview.busFactorAlerts?.atRiskCount || 0} file(s)`, color: overview.busFactorAlerts?.atRiskCount > 0 ? 'red' : 'green', desc: `${overview.busFactorAlerts?.percentage || 0}%` },
      { label: 'Dominance', value: `${overview.knowledgeConcentration?.avgMaxOwnership || 0}%`, desc: 'avg max' },
    ],
  });
  lines.push(intelligenceCard);
  lines.push('');

  // 3. Activity Sparklines
  lines.push(renderSection('Repository Activity (Trends across history)', '📈'));
  if (overview.activitySeries) {
    const s = overview.activitySeries;
    const commitSpark = renderSparkline(s.commitActivity, { color: 'cyan' });
    const churnSpark = renderSparkline(s.fileChurn, { color: 'yellow' });
    const oldestDate = formatDate(s.oldestTimestamp);
    const newestDate = formatDate(s.newestTimestamp);

    lines.push(`  ${padRight(style('dim', 'Recent commit activity:'), 26)} ${commitSpark}`);
    lines.push(`  ${padRight(style('dim', 'File churn:'), 26)} ${churnSpark}`);
    lines.push(`  ${style('dim', `Period: Last ${s.intervals} available intervals (${oldestDate} to ${newestDate})`)}`);
  } else {
    lines.push(`  ${style('dim', 'Insufficient history for activity trends (requires >= 2 commits across distinct intervals).')}`);
  }
  lines.push('');

  // 4. Key Findings
  lines.push(renderSection('Key Findings & Risk Diagnosis', '🔍'));
  const kc = overview.knowledgeConcentration;
  const bfa = overview.busFactorAlerts;
  const criticalCount = overview.criticalFiles?.length || 0;

  if (criticalCount > 0) {
    lines.push(`  ${style('bold', style('red', '✗'))} ${style('bold', `${criticalCount} critical-risk file(s)`)} require attention due to high churn or extreme dominance.`);
  } else {
    lines.push(`  ${style('green', '✓')} No critical-risk file hotspots detected.`);
  }

  if (bfa && bfa.atRiskCount > 0) {
    lines.push(`  ${style('bold', style('red', '✗'))} ${style('bold', `${bfa.atRiskCount} file(s)`)} have Bus Factor = 1 (${bfa.percentage}% of repository > ${bfa.threshold}% single-author ownership).`);
  } else {
    lines.push(`  ${style('green', '✓')} Knowledge is shared evenly across team members.`);
  }

  if (kc && kc.topCommitterShare >= 50) {
    lines.push(`  ${style('bold', style('yellow', '⚠'))} Top contributor ${style('bold', kc.topCommitter)} authored ${style('bold', `${kc.topCommitterShare}%`)} of all commits.`);
  }

  if (kc) {
    lines.push(`  ${style('dim', '•')} Average primary-author dominance across codebase: ${style('bold', `${kc.avgMaxOwnership}%`)}.`);
  }
  lines.push(`  ${style('dim', '• Note: Historical commit concentration reflects measured touch frequency, not definitive organizational failure.')}`);
  lines.push('');

  // 5. Most At-Risk Files Table
  lines.push(renderSection('Where Is The Risk? (Top At-Risk Files)', '⚡'));
  if (overview.topHotspots && overview.topHotspots.length > 0) {
    const hsHeaders = ['Risk Score', 'Severity', 'File', 'Activity Profile', 'Why Is This Risky?'];
    const hsRows = overview.topHotspots.map((h) => {
      const formattedSev = formatSeverity(h.severity);
      return [
        style('bold', `${h.riskScore}/100`),
        formattedSev,
        h.file,
        `${h.churn} touches · ${h.ownershipConcentration}% dominance`,
        h.primaryRisk,
      ];
    });
    lines.push(renderTable(hsHeaders, hsRows, {
      alignments: ['center', 'center', 'left', 'left', 'left'],
    }));
  } else {
    lines.push(`  ${style('green', '✓ No high-risk files identified.')}`);
  }
  lines.push('');

  // 6. What To Investigate Next
  lines.push(renderSection('Recommended Next Investigation', '💡'));
  lines.push(`  ${style('cyan', '→')} Run ${style('bold', 'Where Is The Risk?')} (or ${style('dim', 'gitxray . hotspots')}) for complete risk rankings.`);
  lines.push(`  ${style('cyan', '→')} Run ${style('bold', 'Who Owns The Knowledge?')} (or ${style('dim', 'gitxray . bus-factor')}) to audit single-person dependencies.`);
  lines.push(`  ${style('cyan', '→')} Run ${style('bold', 'What Is Most Complex?')} (or ${style('dim', 'gitxray . complexity')}) to find refactoring candidates.`);

  return lines.join('\n');
}

/**
 * Render Hotspots Report / "Where Is The Risk?"
 * @param {Array} hotspots
 * @param {string} repoPath
 * @returns {string}
 */
function renderHotspotsReport(hotspots, repoPath) {
  const lines = [];

  const critical = hotspots.filter((h) => h.severity === 'CRITICAL').length;
  const high = hotspots.filter((h) => h.severity === 'HIGH').length;

  lines.push(renderDashboardSummary({
    title: 'Where Is The Risk? (Risk Hotspots)',
    repoPath,
    metrics: [
      { label: 'Files Evaluated', value: hotspots.length },
      { label: 'Critical', value: critical, color: 'red' },
      { label: 'High Risk', value: high, color: 'yellow' },
    ],
    status: critical > 0 ? 'Alert' : 'Analysis',
  }));

  lines.push('');
  lines.push(` ${style('dim', 'What this measures:')} Combines commit frequency (40%), author concentration (35%),`);
  lines.push(` and modification recency (25%) into an overall engineering risk score (0–100).`);

  if (hotspots.length === 0) {
    lines.push('');
    lines.push(style('green', '✓ No risk hotspots detected across git history.'));
    return lines.join('\n');
  }

  lines.push(renderSection('Ranked Risk Hotspots', '⚡'));

  const headers = ['Risk Score', 'Severity', 'File', 'Activity Profile', 'Why Is This Risky?'];
  const rows = hotspots.slice(0, 15).map((h) => {
    const sevColor = h.severity === 'CRITICAL' ? 'red' : h.severity === 'HIGH' ? 'yellow' : h.severity === 'MEDIUM' ? 'cyan' : 'green';
    const [topAuthor] = h.topAuthor || ['Unknown'];
    return [
      style('bold', `${h.riskScore}/100`),
      style('bold', style(sevColor, h.severity)),
      h.file,
      `${h.churn} touches · ${h.ownershipConcentration}% ${topAuthor}`,
      h.primaryRisk,
    ];
  });

  lines.push(renderTable(headers, rows, {
    alignments: ['center', 'center', 'left', 'left', 'left'],
  }));

  if (hotspots.length > 15) {
    lines.push(style('dim', `\n  ... and ${hotspots.length - 15} more files evaluated.`));
  }

  return lines.join('\n');
}

/**
 * Render Structural Complexity Report / "What Is Most Complex?"
 * @param {Array} complexities
 * @param {string} repoPath
 * @returns {string}
 */
function renderComplexityReport(complexities, repoPath) {
  const lines = [];
  const veryHigh = complexities.filter((c) => c.complexity === 'VERY HIGH').length;
  const high = complexities.filter((c) => c.complexity === 'HIGH').length;

  lines.push(renderDashboardSummary({
    title: 'What Is Most Complex? (Structural Complexity)',
    repoPath,
    metrics: [
      { label: 'Files Analyzed', value: complexities.length },
      { label: 'Very High', value: veryHigh, color: 'red' },
      { label: 'High', value: high, color: 'yellow' },
    ],
    status: veryHigh > 0 ? 'Alert' : 'Analysis',
  }));

  lines.push('');
  lines.push(` ${style('dim', 'What this measures:')} Evaluates cyclomatic branch density, deep nesting levels, and`);
  lines.push(` control-flow branches to identify code that is hard to review, test, or modify safely.`);

  if (complexities.length === 0) {
    lines.push('');
    lines.push(style('green', '✓ No source code files found for AST/cyclomatic inspection.'));
    return lines.join('\n');
  }

  lines.push(renderSection('Source Files Ranked by Structural Complexity', '⚙'));

  const headers = ['Score', 'Complexity', 'File', 'Lang', 'Branches', 'Max Depth', 'Functions'];
  const rows = complexities.slice(0, 15).map((c) => {
    const lvlColor = c.complexity === 'VERY HIGH' ? 'red' : c.complexity === 'HIGH' ? 'yellow' : c.complexity === 'MEDIUM' ? 'cyan' : 'green';
    return [
      style('bold', `${c.score}/100`),
      style('bold', style(lvlColor, c.complexity)),
      c.file,
      c.language,
      String(c.branches),
      String(c.maxDepth),
      String(c.functions),
    ];
  });

  lines.push(renderTable(headers, rows, {
    alignments: ['center', 'center', 'left', 'center', 'center', 'center', 'center'],
  }));

  if (complexities.length > 15) {
    lines.push(style('dim', `\n  ... and ${complexities.length - 15} more files analyzed.`));
  }

  return lines.join('\n');
}

/**
 * Render Knowledge / Bus-Factor Report / "Who Owns The Knowledge?"
 * @param {Array} busFactorData
 * @param {number} threshold
 * @param {string} repoPath
 * @returns {string}
 */
function renderKnowledgeReport(busFactorData, threshold, repoPath) {
  const atRisk = busFactorData.filter((e) => e.atRisk);
  const safe = busFactorData.filter((e) => !e.atRisk);
  const lines = [];

  lines.push(renderDashboardSummary({
    title: 'Who Owns The Knowledge? (Bus Factor & Ownership)',
    repoPath,
    metrics: [
      { label: 'Files Analyzed', value: busFactorData.length },
      { label: 'Bus Factor = 1', value: atRisk.length, color: atRisk.length > 0 ? 'red' : 'green' },
      { label: 'Threshold', value: `${threshold}%` },
    ],
    status: atRisk.length > 0 ? 'Watchlist' : 'Healthy',
  }));

  lines.push('');
  lines.push(` ${style('dim', 'What this measures:')} Identifies knowledge silos and single-author bottlenecks.`);
  lines.push(` When Bus Factor is 1, losing a single contributor leaves the team without context.`);

  if (atRisk.length > 0) {
    lines.push(renderSection(`Single-Author Dominated Files (${atRisk.length} files at risk > ${threshold}%)`, '⚠'));
    const headers = ['At-Risk File', 'Dominant Author', 'Ownership Share', 'Authors', 'Knowledge Status'];
    const rows = atRisk.map((entry) => [
      entry.path,
      entry.topAuthor,
      colorPercent(entry.topAuthorPercentage),
      `${entry.distinctAuthors} author${entry.distinctAuthors === 1 ? '' : 's'}`,
      entry.topAuthorPercentage >= 95 ? style('bold', style('red', 'Single Author Only')) : style('yellow', 'Heavily Dominated'),
    ]);
    lines.push(renderTable(headers, rows, {
      alignments: ['left', 'left', 'center', 'center', 'left'],
    }));
  } else {
    lines.push('');
    lines.push(style('green', '✓ Bus factor looks healthy! No critical single-author bottlenecks detected.'));
  }

  if (safe.length > 0 && atRisk.length > 0) {
    lines.push(style('dim', `\n  ${safe.length} file(s) have shared authorship (not shown).`));
  }

  return lines.join('\n');
}

/**
 * Render Churn Report / "What Changes Most?"
 * @param {Array} churnData
 * @param {number} commitCount
 * @param {string} repoPath
 * @returns {string}
 */
function renderChurnReport(churnData, commitCount, repoPath, activitySeries = null) {
  const lines = [];

  lines.push(renderDashboardSummary({
    title: 'What Changes Most? (Change Frequency)',
    repoPath,
    metrics: [
      { label: 'Files Tracked', value: churnData.length },
      { label: 'Total Commits', value: commitCount },
    ],
    status: 'Live',
  }));

  if (activitySeries) {
    const churnSpark = renderSparkline(activitySeries.fileChurn, { color: 'yellow' });
    lines.push('');
    lines.push(` ${style('dim', 'Repository churn trend:')}  ${churnSpark}  ${style('dim', `(last ${activitySeries.intervals} intervals)`)}`);
  }

  lines.push('');
  lines.push(` ${style('dim', 'What this measures:')} Tracks files with the most frequent revisions over time.`);
  lines.push(` High churn indicates volatile requirements, ongoing refactoring, or bug regression hot zones.`);

  if (churnData.length === 0) {
    lines.push('');
    lines.push(style('green', '✓ No file modifications recorded in history.'));
    return lines.join('\n');
  }

  lines.push(renderSection('Files Ranked by Edit Frequency', '🔥'));

  const maxTouches = churnData[0].touches;
  const headers = ['File', 'Revisions', 'Activity Level', 'Relative Intensity'];
  const rows = churnData.slice(0, 20).map((entry) => {
    const pct = Math.round((entry.touches / maxTouches) * 100);
    const level = pct >= 80 ? style('bold', style('red', 'Very High')) : pct >= 50 ? style('yellow', 'High') : pct >= 25 ? style('cyan', 'Moderate') : style('dim', 'Low');
    const bar = renderBar(pct, 16);
    return [
      entry.path,
      String(entry.touches),
      level,
      bar,
    ];
  });

  lines.push(renderTable(headers, rows, {
    alignments: ['left', 'center', 'center', 'left'],
  }));

  if (churnData.length > 20) {
    lines.push(style('dim', `\n  ... and ${churnData.length - 20} more files tracked.`));
  }

  return lines.join('\n');
}

module.exports = {
  style,
  formatTable,
  renderSummaryPanel,
  renderDashboardSummary,
  printHeader,
  printWarning,
  printSuccess,
  formatDate,
  formatPercent,
  colorPercent,
  stripAnsi,
  renderHotspotsReport,
  renderComplexityReport,
  renderOverviewReport,
  renderKnowledgeReport,
  renderChurnReport,
};
