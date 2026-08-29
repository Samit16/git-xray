'use strict';

const util = require('node:util');

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
};
