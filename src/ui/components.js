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

const path = require('node:path');

/**
 * Render responsive 2-column metric cards grid (collapses to 1-col on narrow terminals).
 * @param {Object} opts
 * @param {string} [opts.title='REPOSITORY INTELLIGENCE']
 * @param {string} opts.repoPath
 * @param {string} [opts.branch='main']
 * @param {string} [opts.subtitle]
 * @param {Array<{label: string, value: string|number, color?: string, desc?: string}>} opts.metrics
 * @param {number} [opts.width]
 * @param {string} [opts.borderColor='cyan']
 * @returns {string}
 */
function renderMetricGrid({
  title = 'REPOSITORY INTELLIGENCE',
  repoPath = process.cwd(),
  branch = 'main',
  subtitle,
  metrics = [],
  width,
  borderColor = 'cyan',
}) {
  const b = BOX.rounded;
  const termWidth = getTerminalWidth(80);
  const targetWidth = Math.min(termWidth - 2, width || Math.max(54, termWidth - 4));
  const innerWidth = targetWidth - 2;
  const isSingleCol = targetWidth < 62;

  const lines = [];

  // Top border
  const titleText = ` ${title} `;
  const topAvailable = innerWidth - visibleLength(titleText);
  const topBorder = style(
    borderColor,
    `${b.tl}${b.h}${titleText}${b.h.repeat(Math.max(0, topAvailable - 1))}${b.tr}`
  );
  lines.push(topBorder);

  // Repository & Branch info
  const repoName = path.basename(repoPath) || repoPath;
  const repoLine = ` Repository: ${style('bold', repoName)}`;
  lines.push(`${style(borderColor, b.v)}${padRight(truncate(repoLine, innerWidth), innerWidth)}${style(borderColor, b.v)}`);

  const branchLine = ` Branch: ${style('bold', branch)}`;
  lines.push(`${style(borderColor, b.v)}${padRight(truncate(branchLine, innerWidth), innerWidth)}${style(borderColor, b.v)}`);

  if (subtitle) {
    const subLine = ` ${subtitle}`;
    lines.push(`${style(borderColor, b.v)}${padRight(truncate(subLine, innerWidth), innerWidth)}${style(borderColor, b.v)}`);
  }

  if (isSingleCol) {
    // 1-column layout for narrow terminals
    for (let i = 0; i < metrics.length; i++) {
      lines.push(style(borderColor, `${b.vl}${b.h.repeat(innerWidth)}${b.vr}`));
      const m = metrics[i];
      const lbl = ` ${style('bold', style('dim', m.label.toUpperCase()))}`;
      const valStr = m.color ? style(m.color, String(m.value)) : style('bold', String(m.value));
      const val = ` ${valStr}${m.desc ? style('dim', ` (${m.desc})`) : ''}`;
      lines.push(`${style(borderColor, b.v)}${padRight(truncate(lbl, innerWidth), innerWidth)}${style(borderColor, b.v)}`);
      lines.push(`${style(borderColor, b.v)}${padRight(truncate(val, innerWidth), innerWidth)}${style(borderColor, b.v)}`);
    }
    lines.push(style(borderColor, `${b.bl}${b.h.repeat(innerWidth)}${b.br}`));
  } else {
    // 2-column layout
    const col1 = Math.floor((innerWidth - 1) / 2);
    const col2 = innerWidth - 1 - col1;

    // Header to grid divider
    lines.push(style(borderColor, `${b.vl}${b.h.repeat(col1)}${b.ht}${b.h.repeat(col2)}${b.vr}`));

    for (let i = 0; i < metrics.length; i += 2) {
      if (i > 0) {
        lines.push(style(borderColor, `${b.vl}${b.h.repeat(col1)}${b.x}${b.h.repeat(col2)}${b.vr}`));
      }
      const m1 = metrics[i];
      const m2 = metrics[i + 1];

      // Labels row
      const l1 = ` ${style('bold', style('dim', m1.label.toUpperCase()))}`;
      const l2 = m2 ? ` ${style('bold', style('dim', m2.label.toUpperCase()))}` : '';
      const row1 = `${style(borderColor, b.v)}${padRight(truncate(l1, col1), col1)}${style(borderColor, b.v)}${padRight(truncate(l2, col2), col2)}${style(borderColor, b.v)}`;
      lines.push(row1);

      // Values row
      const v1Str = m1.color ? style(m1.color, String(m1.value)) : style('bold', String(m1.value));
      const v1 = ` ${v1Str}${m1.desc ? style('dim', ` [${m1.desc}]`) : ''}`;
      let v2 = '';
      if (m2) {
        const v2Str = m2.color ? style(m2.color, String(m2.value)) : style('bold', String(m2.value));
        v2 = ` ${v2Str}${m2.desc ? style('dim', ` [${m2.desc}]`) : ''}`;
      }
      const row2 = `${style(borderColor, b.v)}${padRight(truncate(v1, col1), col1)}${style(borderColor, b.v)}${padRight(truncate(v2, col2), col2)}${style(borderColor, b.v)}`;
      lines.push(row2);
    }

    // Bottom border
    lines.push(style(borderColor, `${b.bl}${b.h.repeat(col1)}${b.hb}${b.h.repeat(col2)}${b.br}`));
  }

  return lines.join('\n');
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
  innerLines.push(` ${style('bold', style('cyan', 'GIT X-RAY'))}  ${style('dim', '•')}  ${style('bold', title)}  ${statusBadge}`);
  innerLines.push(` ${style('dim', 'repo:')} ${style('bold', repoPath)}`);
  innerLines.push('');

  // Metric pills formatted cleanly
  const pillStr = metrics
    .map((m) => {
      if (typeof m === 'string') {
        return m;
      }
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
  renderMetricGrid,
  renderTable,
  renderSection,
};
