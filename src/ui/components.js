'use strict';

const {
  style,
  stripAnsi,
  visibleLength,
  getTerminalWidth,
  pad,
  padRight,
  padLeft,
  padCenter,
  truncate,
  BOX,
  BADGES,
  renderBar,
} = require('./core.js');

/**
 * Render a bordered panel/card with responsive width.
 * @param {Object} opts
 * @param {string} [opts.title] - panel header title
 * @param {string} [opts.badge] - status badge string
 * @param {string[]} opts.lines - body text lines
 * @param {number} [opts.width] - explicit width (default auto fits terminal)
 * @param {'rounded'|'single'|'double'|'ascii'} [opts.borderStyle]
 * @param {string} [opts.borderColor]
 */
function renderPanel({
  title,
  badge,
  lines = [],
  width,
  borderStyle = 'rounded',
  borderColor = 'cyan',
}) {
  const b = BOX[borderStyle] || BOX.rounded;
  const termWidth = getTerminalWidth(80);
  const targetWidth = Math.min(termWidth - 2, width || Math.max(76, termWidth - 4));
  const innerWidth = targetWidth - 2;

  const result = [];

  // Top border with title and optional badge
  let topHeader = '';
  if (title) {
    const titleText = ` ${title} `;
    const badgeText = badge ? ` ${badge} ` : '';
    const available = innerWidth - visibleLength(titleText) - visibleLength(badgeText);
    if (available >= 2) {
      topHeader = `${titleText}${b.h.repeat(available)}${badgeText}`;
    } else {
      topHeader = truncate(titleText, innerWidth);
    }
  }

  const topRemainder = Math.max(0, innerWidth - visibleLength(topHeader));
  const topBorder = style(borderColor, `${b.tl}${topHeader}${b.h.repeat(topRemainder)}${b.tr}`);
  result.push(topBorder);

  // Content lines
  for (const line of lines) {
    const content = padRight(truncate(line, innerWidth), innerWidth);
    result.push(`${style(borderColor, b.v)}${content}${style(borderColor, b.v)}`);
  }

  // Bottom border
  const bottomBorder = style(borderColor, `${b.bl}${b.h.repeat(innerWidth)}${b.br}`);
  result.push(bottomBorder);

  return result.join('\n');
}

/**
 * Render key-value metric summary grid inside a panel.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.repoPath
 * @param {Array<{label: string, value: string|number, color?: string}>} opts.metrics
 * @param {string} [opts.status]
 */
function renderExecutiveCard({
  title = 'Repository Executive Overview',
  repoPath = process.cwd(),
  metrics = [],
  status = 'Healthy',
}) {
  const innerLines = [];

  const statusBadge = BADGES[status.toLowerCase()] ? BADGES[status.toLowerCase()]() : `[ ${status} ]`;
  
  // Header line
  innerLines.push(` ${style('bold', style('green', 'GIT X-RAY'))}  ${style('dim', '•')}  ${style('bold', title)}  ${statusBadge}`);
  innerLines.push(` ${style('dim', 'repo:')} ${style('bold', repoPath)}`);
  innerLines.push('');

  // Metric pills formatted cleanly
  const pillStr = metrics
    .map((m) => {
      const val = m.color ? style(m.color, String(m.value)) : style('bold', String(m.value));
      return `${style('dim', m.label)}: ${val}`;
    })
    .join(style('dim', '   │   '));

  innerLines.push(` ${pillStr}`);

  return renderPanel({
    lines: innerLines,
    borderColor: 'cyan',
  });
}

/**
 * Render clean, ANSI-aware aligned table with responsive column width management.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {Object} opts
 * @param {string[]} [opts.alignments] - array of 'left'|'right'|'center'
 * @param {string} [opts.headerColor] - header color
 */
function renderTable(headers, rows, opts = {}) {
  const headerColor = opts.headerColor || 'cyan';
  const alignments = opts.alignments || headers.map(() => 'right');
  const termWidth = getTerminalWidth(80);
  const maxTableWidth = Math.min(termWidth - 2, 100);

  // Compute maximum content width per column
  const colWidths = headers.map((h, i) => {
    let max = visibleLength(h);
    for (const row of rows) {
      if (row[i] !== undefined) {
        max = Math.max(max, visibleLength(String(row[i])));
      }
    }
    return max;
  });

  // Check if columns exceed terminal width and compress first column (usually file path) if needed
  let totalWidth = colWidths.reduce((a, b) => a + b, 0) + (headers.length - 1) * 3;
  if (totalWidth > maxTableWidth && colWidths.length > 1) {
    const overflow = totalWidth - maxTableWidth;
    colWidths[0] = Math.max(20, colWidths[0] - overflow);
  }

  const lines = [];

  // Header row
  const headerCells = headers.map((h, i) => {
    const padded = pad(h, colWidths[i], alignments[i]);
    return style('bold', style(headerColor, padded));
  });
  lines.push(headerCells.join(style('dim', ' │ ')));

  // Divider row
  const dividers = colWidths.map((w) => '─'.repeat(w));
  lines.push(style('dim', dividers.join('─┼─')));

  // Data rows
  for (const row of rows) {
    const rowCells = headers.map((_, i) => {
      const rawCell = row[i] !== undefined ? String(row[i]) : '';
      const cellText = i === 0 ? truncate(rawCell, colWidths[i]) : rawCell;
      return pad(cellText, colWidths[i], alignments[i]);
    });
    lines.push(rowCells.join(style('dim', ' │ ')));
  }

  return lines.join('\n');
}

/**
 * Render a section header banner.
 * @param {string} title
 * @param {string} [icon]
 */
function renderSection(title, icon = '▶') {
  return `\n${style('bold', style('cyan', `${icon} ${title}`))}`;
}

module.exports = {
  renderPanel,
  renderExecutiveCard,
  renderTable,
  renderSection,
};
