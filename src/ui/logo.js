'use strict';

const { style } = require('./core.js');

/**
 * ASCII wordmark for "GIT X-RAY".
 */
const WORDMARK_LINES = [
  '  ██████╗   ██╗ ████████╗    ██╗  ██╗ ██████╗  █████╗ ██╗   ██╗',
  '██╔═════╝   ██║ ╚══██╔══╝    ╚██╗██╔╝ ██╔══██╗██╔══██╗╚██╗ ██╔╝',
  '██║   ████╗ ██║    ██║        ╚███╔╝  ██████╔╝███████║ ╚████╔╝ ',
  '██║   ╚═██║ ██║    ██║        ██╔██╗  ██╔══██╗██╔══██║  ╚██╔╝  ',
  '╚████████╔╝ ██║    ██║       ██╔╝ ██╗ ██║  ██║██║  ██║   ██║   ',
  ' ╚═══════╝  ╚═╝    ╚═╝       ╚═╝  ╚═╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ',
];

/**
 * Compact single-line header for narrow viewports (< 50 cols).
 */
const COMPACT_WORDMARK = [
  '  ◈ GIT X-RAY · Codebase Forensics',
];

/**
 * Render the Git X-Ray logo header.
 * @param {Object} opts
 * @param {boolean} [opts.showSubtitle=true]
 */
function renderLogo(opts = {}) {
  const termWidth = process.stdout.columns || 80;
  const showSubtitle = opts.showSubtitle !== false;

  if (termWidth < 50) {
    const lines = [style('bold', style('green', COMPACT_WORDMARK[0]))];
    if (showSubtitle) {
      lines.push(style('dim', '    Zero-dependency history intelligence'));
    }
    return lines.join('\n');
  }

  const lines = Array.isArray(WORDMARK_LINES)
    ? WORDMARK_LINES
    : String(WORDMARK_LINES).split('\n');

  const coloredWordmark = lines
    .map((line) => style('bold', style('green', line)))
    .join('\n');

  if (!showSubtitle) {
    return coloredWordmark;
  }

  const subtitle = `  ${style('dim', 'Zero-dependency codebase forensics')} ${style('cyan', 'v1.0.0')}`;
  return `${coloredWordmark}\n${subtitle}`;
}

module.exports = {
  WORDMARK_LINES,
  renderLogo,
};
