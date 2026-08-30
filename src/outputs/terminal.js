'use strict';

const util = require('node:util');
const path = require('node:path');

const BOX = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  vertical: '│',
  horizontal: '─',
  teeLeft: '├',
  teeRight: '┤',
  teeTop: '┬',
  teeBottom: '┴',
  cross: '┼',
};

// Detect color support — respect NO_COLOR env var (standard)
const colorEnabled =
  !process.env.NO_COLOR &&
  process.stdout.isTTY !== false;

/**
 * Apply a style to text using Node's built-in util.styleText.
 * Falls back to plain text if colors are not supported or util.styleText is unavailable.
 *
 * @param {string} styleName — e.g., 'bold', 'red', 'green', 'yellow', 'cyan', 'dim'
 * @param {string} text
 * @returns {string}
 */
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

function padRight(str, width) {
  const visibleLen = stripAnsi(str).length;
  if (visibleLen >= width) return str;
  return str + ' '.repeat(width - visibleLen);
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function renderSummaryPanel({ title, repoPath, metrics = [], status = 'Ready' }) {
  const rows = [
    `${style('bold', style('cyan', 'Git X-Ray'))}  ${style('dim', status)}`,
    `${style('dim', 'repo')} ${style('bold', repoPath || process.cwd())}`,
    '',
    ...metrics.map((metric) => `• ${metric}`),
  ];

  const bodyLineWidth = Math.max(
    40,
    ...rows.map((row) => stripAnsi(row).length + 4)
  );

  const titleLine = `${style('bold', style('cyan', title || 'Report'))}`;
  const width = Math.max(bodyLineWidth, stripAnsi(titleLine).length + 6);

  const top = `${BOX.topLeft}${BOX.horizontal.repeat(width)}${BOX.topRight}`;
  const bottom = `${BOX.bottomLeft}${BOX.horizontal.repeat(width)}${BOX.bottomRight}`;

  const content = [
    top,
    `${BOX.vertical} ${padRight(titleLine, width - 2)} ${BOX.vertical}`,
    `${BOX.vertical} ${padRight('', width - 2)} ${BOX.vertical}`,
    ...rows.map((row) => `${BOX.vertical} ${padRight(row, width - 2)} ${BOX.vertical}`),
    bottom,
  ].join('\n');

  return content;
}

function renderDashboardSummary({ title, repoPath, metrics = [], status = 'Ready' }) {
  const statusColor = status.toLowerCase() === 'healthy' ? 'green' : 'yellow';
  const statusChip = style(statusColor, `[ ${status} ]`);
  const metricCards = metrics
    .map(({ label, value }) => {
      const labelText = style('dim', label);
      const valueText = style('bold', String(value));
      return `${labelText}: ${valueText}`;
    })
    .join('    ');

  const rows = [
    `${style('bold', style('cyan', 'Git X-Ray'))}  ${statusChip}`,
    `${style('dim', 'repo')} ${style('bold', repoPath || process.cwd())}`,
    '',
    `${style('bold', style('cyan', title || 'Report'))}`,
    metricCards,
  ];

  const width = Math.max(
    48,
    ...rows.map((row) => stripAnsi(row).length + 4)
  );

  const top = `${BOX.topLeft}${BOX.horizontal.repeat(width)}${BOX.topRight}`;
  const bottom = `${BOX.bottomLeft}${BOX.horizontal.repeat(width)}${BOX.bottomRight}`;

  return [
    top,
    ...rows.map((row) => `${BOX.vertical} ${padRight(row, width - 2)} ${BOX.vertical}`),
    bottom,
  ].join('\n');
}

/**
 * Format a table with aligned columns for terminal output.
 * Hand-written — no cli-table3.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{ headerStyle?: string }} options
 * @returns {string}
 */
function formatTable(headers, rows, options = {}) {
  const headerStyle = options.headerStyle || 'bold';

  const colWidths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => {
      const cellLen = stripAnsi(String(row[i] || '')).length;
      return Math.max(max, cellLen);
    }, 0);
    return Math.max(stripAnsi(h).length, dataMax);
  });

  const paddedHeaders = headers.map((h, i) => style(headerStyle, padRight(h, colWidths[i])));
  const separator = colWidths.map((w) => BOX.horizontal.repeat(w)).join(`${BOX.teeTop}${BOX.horizontal}`);
  const headerLine = paddedHeaders.join(`  `);
  const dataLines = rows.map((row) =>
    row.map((cell, i) => padRight(String(cell || ''), colWidths[i])).join('  ')
  );

  return [
    `${BOX.topLeft}${separator}${BOX.topRight}`,
    `${BOX.vertical}${headerLine}${BOX.vertical}`,
    `${BOX.teeLeft}${separator}${BOX.teeRight}`,
    ...dataLines.map((line) => `${BOX.vertical}${line}${BOX.vertical}`),
    `${BOX.bottomLeft}${separator}${BOX.bottomRight}`,
  ].join('\n');
}

/**
 * Print a section header.
 * @param {string} title
 * @param {string} [repoPath]
 * @param {string[]} [metrics]
 */
function printHeader(title, repoPath = process.cwd(), metrics = []) {
  console.log('\n' + renderSummaryPanel({
    title,
    repoPath,
    metrics,
    status: 'Live',
  }));
}

/**
 * Print a warning message.
 * @param {string} message
 */
function printWarning(message) {
  console.log(style('yellow', `⚠  ${message}`));
}

/**
 * Print a success message.
 * @param {string} message
 */
function printSuccess(message) {
  console.log(style('green', `✓  ${message}`));
}

/**
 * Format a date from a unix timestamp.
 * @param {number} timestamp — unix seconds
 * @returns {string}
 */
function formatDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/**
 * Format a percentage.
 * @param {number} value — 0 to 100
 * @returns {string}
 */
function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

/**
 * Color a percentage value based on thresholds.
 * @param {number} value
 * @returns {string}
 */
function colorPercent(value) {
  const text = formatPercent(value);
  if (value >= 80) return style('red', text);
  if (value >= 50) return style('yellow', text);
  return style('green', text);
}

/**
 * Render hotspots report as a formatted panel.
 * @param {Array} hotspots — from computeHotspots()
 * @param {string} repoPath
 * @returns {string}
 */
function renderHotspotsReport(hotspots, repoPath) {
  const title = `Risk Hotspots (${hotspots.length} files)`;
  const lines = [renderDashboardSummary({ title, repoPath, metrics: [], status: 'Analysis' })];

  if (hotspots.length === 0) {
    lines.push(style('green', '✓ No high-risk files detected.'));
    return lines.join('\n');
  }

  // Group by severity
  const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
  for (const h of hotspots) {
    bySeverity[h.severity].push(h);
  }

  // Show critical and high first
  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const items = bySeverity[severity];
    if (items.length === 0) continue;

    const severityColor = {
      CRITICAL: 'red',
      HIGH: 'yellow',
      MEDIUM: 'cyan',
      LOW: 'green',
    }[severity];

    lines.push('');
    lines.push(style('bold', style(severityColor, `${severity} (${items.length} files):`)));

    for (const hotspot of items.slice(0, 10)) {
      const scoreStr = style('bold', String(hotspot.riskScore));
      const fileStr = style('cyan', hotspot.file);
      const [author, touches] = hotspot.topAuthor || ['—', 0];
      const churnStr = `${hotspot.churn} touches`;
      const ownerStr = `${hotspot.ownershipConcentration}% by ${author}`;

      lines.push(`  ${scoreStr}/100  ${fileStr}`);
      lines.push(`         ${churnStr} · ${ownerStr}`);
      lines.push(`         Primary: ${hotspot.primaryRisk}`);
    }

    if (items.length > 10) {
      lines.push(`  ... and ${items.length - 10} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Render structural complexity report as a formatted panel.
 * @param {Array} complexities — from analyzeDirectoryComplexity()
 * @param {string} repoPath
 * @returns {string}
 */
function renderComplexityReport(complexities, repoPath) {
  const title = `Structural Complexity (${complexities.length} files)`;
  const lines = [renderDashboardSummary({ title, repoPath, metrics: [], status: 'Analysis' })];

  if (complexities.length === 0) {
    lines.push(style('green', '✓ No source files found.'));
    return lines.join('\n');
  }

  // Group by complexity level
  const byLevel = { 'VERY HIGH': [], HIGH: [], MEDIUM: [], LOW: [], TRIVIAL: [] };
  for (const c of complexities) {
    byLevel[c.complexity].push(c);
  }

  // Show highest complexity first
  for (const level of ['VERY HIGH', 'HIGH', 'MEDIUM', 'LOW', 'TRIVIAL']) {
    const items = byLevel[level];
    if (items.length === 0) continue;

    const levelColor = {
      'VERY HIGH': 'red',
      HIGH: 'yellow',
      MEDIUM: 'cyan',
      LOW: 'green',
      TRIVIAL: 'dim',
    }[level];

    lines.push('');
    lines.push(style('bold', style(levelColor, `${level} (${items.length} files):`)));

    for (const comp of items.slice(0, 8)) {
      const scoreStr = style('bold', String(comp.score));
      const fileStr = style('cyan', path.basename(comp.file));
      const langStr = style('dim', `[${comp.language}]`);
      const branchStr = `${comp.branches} branches`;
      const nestStr = `max depth ${comp.maxDepth}`;

      lines.push(`  ${scoreStr}/100  ${fileStr} ${langStr}`);
      lines.push(`         ${branchStr} · ${nestStr}`);
    }

    if (items.length > 8) {
      lines.push(`  ... and ${items.length - 8} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Render Executive Overview report as a clean, readable terminal view.
 * @param {Object} overview — from computeOverview()
 * @returns {string}
 */
function renderOverviewReport(overview) {
  const lines = [];

  const riskColor = {
    CRITICAL: 'red',
    HIGH: 'yellow',
    MEDIUM: 'cyan',
    LOW: 'green',
  }[overview.overallRisk] || 'white';

  const title = `Repository Executive Overview`;
  const summaryBox = renderDashboardSummary({
    title,
    repoPath: overview.repository,
    metrics: [
      { label: 'Commits', value: overview.commitCount },
      { label: 'Contributors', value: overview.contributorCount },
      { label: 'Files', value: overview.fileCount },
      { label: 'Overall Risk', value: `${overview.overallRisk} (${overview.riskScore}/100)` },
    ],
    status: overview.overallRisk === 'LOW' ? 'Healthy' : overview.overallRisk === 'MEDIUM' ? 'Moderate' : 'Risk Alert',
  });

  lines.push(summaryBox);
  lines.push('');

  // 1. Knowledge Concentration
  const kc = overview.knowledgeConcentration;
  const kcColor = kc.concentrationLevel === 'HIGH' ? 'red' : kc.concentrationLevel === 'MODERATE' ? 'yellow' : 'green';
  lines.push(style('bold', style('cyan', '─── Knowledge Concentration ───')));
  lines.push(`  Concentration Level: ${style('bold', style(kcColor, kc.concentrationLevel))}`);
  lines.push(`  Top Contributor:     ${style('bold', kc.topCommitter)} (${kc.topCommitterShare}% of all commits)`);
  lines.push(`  Avg File Dominance:  ${kc.avgMaxOwnership}% by primary author`);
  lines.push('');

  // 2. Bus-Factor Alerts
  const bfa = overview.busFactorAlerts;
  const bfColor = bfa.atRiskCount > 0 ? 'red' : 'green';
  lines.push(style('bold', style('cyan', '─── Bus-Factor Alerts ───')));
  lines.push(`  Single-Author Dominated: ${style('bold', style(bfColor, `${bfa.atRiskCount} files`))} (${bfa.percentage}% of codebase > ${bfa.threshold}% ownership)`);
  if (bfa.topAlerts.length > 0) {
    for (const item of bfa.topAlerts) {
      lines.push(`  • ${style('yellow', item.path)}: ${style('bold', `${item.topAuthorPercentage.toFixed(0)}%`)} by ${item.topAuthor} (${item.distinctAuthors} author${item.distinctAuthors === 1 ? '' : 's'})`);
    }
  } else {
    lines.push(`  ${style('green', '✓ No single-author bottlenecks detected.')}`);
  }
  lines.push('');

  // 3. Critical Files & Top Hotspots
  lines.push(style('bold', style('cyan', '─── Top Risk Hotspots & Critical Files ───')));
  if (overview.topHotspots.length > 0) {
    for (const h of overview.topHotspots) {
      const sevColor = h.severity === 'CRITICAL' ? 'red' : h.severity === 'HIGH' ? 'yellow' : h.severity === 'MEDIUM' ? 'cyan' : 'green';
      const badge = style('bold', style(sevColor, `[${h.severity}]`));
      lines.push(`  ${badge} ${style('bold', h.file)} (${h.riskScore}/100)`);
      lines.push(`     Touches: ${h.churn} · Concentration: ${h.ownershipConcentration}% · Risk: ${h.primaryRisk}`);
    }
  } else {
    lines.push(`  ${style('green', '✓ No high-risk hotspots found.')}`);
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
};

