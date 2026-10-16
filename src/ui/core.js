'use strict';

const util = require('node:util');

/**
 * Terminal UI core utilities for zero-dependency agentic CLIs.
 */

const colorEnabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.isTTY !== false || process.env.FORCE_COLOR === '1');

const ANSI_CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * Apply ANSI text styling with zero dependencies and safe fallbacks.
 * @param {string} styleName - color/style name
 * @param {string} text
 */
function style(styleName, text) {
  if (!colorEnabled) return String(text);
  if (typeof util.styleText === 'function') {
    try {
      return util.styleText(styleName, String(text));
    } catch {
      // fallback if style name is custom or unhandled
    }
  }
  const code = ANSI_CODES[styleName];
  if (code) {
    return `${code}${text}${ANSI_CODES.reset}`;
  }
  return String(text);
}

/**
 * Strip ANSI escape codes to measure visible string width accurately.
 * @param {string} str
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return String(str || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Get visual length of string without ANSI codes.
 * @param {string} str
 */
function visibleLength(str) {
  return stripAnsi(str).length;
}

/**
 * Get current terminal width with safe default fallback.
 * @param {number} fallback
 */
function getTerminalWidth(fallback = 80) {
  return process.stdout.columns && process.stdout.columns > 20
    ? process.stdout.columns
    : fallback;
}

/**
 * Pad a string to target width, ANSI-safe.
 * @param {string} str
 * @param {number} width
 * @param {'left'|'right'|'center'} align
 */
function pad(str, width, align = 'right') {
  const s = String(str || '');
  const len = visibleLength(s);
  if (len >= width) return s;
  const diff = width - len;
  if (align === 'left') {
    return ' '.repeat(diff) + s;
  }
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  }
  return s + ' '.repeat(diff);
}

function padRight(str, width) {
  return pad(str, width, 'right');
}

function padLeft(str, width) {
  return pad(str, width, 'left');
}

function padCenter(str, width) {
  return pad(str, width, 'center');
}

/**
 * Truncate string to max visible length with optional ellipsis.
 * @param {string} str
 * @param {number} max
 * @param {string} ellipsis
 */
function truncate(str, max, ellipsis = '…') {
  const s = String(str || '');
  if (visibleLength(s) <= max) return s;
  let trimmed = s;
  const target = Math.max(1, max - visibleLength(ellipsis));
  while (visibleLength(trimmed) > target && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed + ellipsis;
}

/**
 * Box drawing border characters.
 */
const BOX = {
  rounded: {
    tl: '╭', tr: '╮', bl: '╰', br: '╯',
    h: '─', v: '│',
    vl: '├', vr: '┤', ht: '┬', hb: '┴',
    x: '┼'
  },
  single: {
    tl: '┌', tr: '┐', bl: '└', br: '┘',
    h: '─', v: '│',
    vl: '├', vr: '┤', ht: '┬', hb: '┴',
    x: '┼'
  },
  double: {
    tl: '╔', tr: '╗', bl: '╚', br: '╝',
    h: '═', v: '║',
    vl: '╠', vr: '╣', ht: '╦', hb: '╩',
    x: '╬'
  },
  ascii: {
    tl: '+', tr: '+', bl: '+', br: '+',
    h: '-', v: '|',
    vl: '+', vr: '+', ht: '+', hb: '+',
    x: '+'
  }
};

/**
 * Status badges & icons.
 */
const BADGES = {
  critical: () => style('bold', style('red', '[CRITICAL]')),
  high: () => style('bold', style('yellow', '[HIGH]')),
  medium: () => style('bold', style('cyan', '[MEDIUM]')),
  low: () => style('bold', style('green', '[LOW]')),
  healthy: () => style('bold', style('green', '[HEALTHY]')),
  warning: () => style('bold', style('yellow', '[WARNING]')),
  alert: () => style('bold', style('red', '[ALERT]')),
  live: () => style('bold', style('green', '[LIVE]')),
  info: () => style('bold', style('cyan', '[INFO]')),
};

/**
 * Format a risk severity badge with text label visible even without color.
 * @param {string} severity - 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
 */
function formatSeverity(severity) {
  const sev = String(severity || '').toUpperCase();
  if (sev === 'CRITICAL') return style('bold', style('red', '[CRITICAL]'));
  if (sev === 'HIGH') return style('bold', style('yellow', '[HIGH]'));
  if (sev === 'MEDIUM') return style('bold', style('cyan', '[MEDIUM]'));
  if (sev === 'LOW') return style('bold', style('green', '[LOW]'));
  return `[${sev || 'UNKNOWN'}]`;
}

const SPARK_CHARS = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ASCII = ['_', '.', '-', '=', '#'];

/**
 * Render compact Unicode block sparkline from time-series data.
 * @param {number[]} values
 * @param {Object} [opts]
 * @param {string} [opts.color='cyan']
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {boolean} [opts.ascii=false]
 * @returns {string}
 */
function renderSparkline(values, opts = {}) {
  if (!Array.isArray(values) || values.length === 0) return '';
  const color = opts.color || 'cyan';
  const isAscii = opts.ascii || (process.env.TERM === 'dumb');
  const palette = isAscii ? SPARK_ASCII : SPARK_CHARS;

  const min = opts.min !== undefined ? opts.min : Math.min(...values);
  const max = opts.max !== undefined ? opts.max : Math.max(...values);

  if (max === min) {
    const flatChar = min === 0 ? palette[0] : palette[Math.floor(palette.length / 2)];
    return style(color, flatChar.repeat(values.length));
  }

  const chars = values.map((val) => {
    const clamped = Math.max(min, Math.min(max, val));
    const ratio = (clamped - min) / (max - min);
    const idx = Math.min(palette.length - 1, Math.floor(ratio * palette.length));
    return palette[idx];
  });

  return style(color, chars.join(''));
}

/**
 * Format a progress / gauge bar.
 * @param {number} percent - 0 to 100
 * @param {number} width - character width
 * @param {Object} opts
 */
function renderBar(percent, width = 20, opts = {}) {
  const p = Math.max(0, Math.min(100, percent));
  const fillWidth = Math.round((p / 100) * width);
  const emptyWidth = width - fillWidth;
  const fillChar = opts.fillChar || '█';
  const emptyChar = opts.emptyChar || '░';

  let coloredFill;
  if (p >= 80) coloredFill = style('red', fillChar.repeat(fillWidth));
  else if (p >= 50) coloredFill = style('yellow', fillChar.repeat(fillWidth));
  else coloredFill = style('green', fillChar.repeat(fillWidth));

  return coloredFill + style('dim', emptyChar.repeat(emptyWidth));
}

module.exports = {
  colorEnabled,
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
  formatSeverity,
  SPARK_CHARS,
  renderSparkline,
  renderBar,
};
