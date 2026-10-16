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
    const lines = [style('bold', style('cyan', COMPACT_WORDMARK[0]))];
    if (showSubtitle) {
      lines.push(style('dim', '    Zero-dependency repository intelligence'));
    }
    return lines.join('\n');
  }

  const lines = Array.isArray(WORDMARK_LINES)
    ? WORDMARK_LINES
    : String(WORDMARK_LINES).split('\n');

  const coloredWordmark = lines
    .map((line) => style('bold', style('cyan', line)))
    .join('\n');

  if (!showSubtitle) {
    return coloredWordmark;
  }

  const subtitle = `  ${style('bold', style('cyan', 'GIT X-RAY'))} ${style('dim', '· Zero-dependency repository intelligence')} ${style('cyan', 'v1.0.0')}`;
  return `${coloredWordmark}\n${subtitle}`;
}

module.exports = {
  WORDMARK_LINES,
  renderLogo,
};
