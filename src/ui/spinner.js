'use strict';

const { style } = require('./core.js');

/**
 * ANSI braille/spinner frames for CLI interactions.
 */
const SPINNERS = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  pulse: ['█', '▓', '▒', '░', '▒', '▓'],
  arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
  bars: [' ', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃'],
};

/**
 * Zero-dependency live terminal progress/spinner display.
 */
class TerminalSpinner {
  /**
   * @param {string} text - initial status text
   * @param {Object} [opts]
   * @param {string} [opts.spinner='dots']
   * @param {string} [opts.color='cyan']
   */
  constructor(text, opts = {}) {
    this.text = text;
    this.frames = SPINNERS[opts.spinner] || SPINNERS.dots;
    this.color = opts.color || 'cyan';
    this.frameIndex = 0;
    this.timer = null;
    this.isTTY = process.stdout.isTTY && !process.env.CI;
  }

  /**
   * Start spinning animation in TTY environments.
   */
  start() {
    if (!this.isTTY) {
      process.stdout.write(`• ${this.text}...\n`);
      return this;
    }

    // Hide cursor
    process.stdout.write('\u001b[?25l');
    this.render();

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.render();
    }, 80);

    return this;
  }

  /**
   * Update message.
   * @param {string} text
   */
  update(text) {
    this.text = text;
    if (this.isTTY) {
      this.render();
    }
  }

  render() {
    const frame = style('bold', style(this.color, this.frames[this.frameIndex]));
    process.stdout.write(`\r\u001b[K${frame} ${this.text}`);
  }

  /**
   * Stop spinner with success mark.
   * @param {string} [text]
   */
  succeed(text) {
    this.stop();
    const msg = text || this.text;
    const mark = style('bold', style('green', '✓'));
    if (this.isTTY) {
      process.stdout.write(`\r\u001b[K${mark} ${msg}\n`);
    } else {
      process.stdout.write(`✓ ${msg}\n`);
    }
  }

  /**
   * Stop spinner with failure mark.
   * @param {string} [text]
   */
  fail(text) {
    this.stop();
    const msg = text || this.text;
    const mark = style('bold', style('red', '✗'));
    if (this.isTTY) {
      process.stdout.write(`\r\u001b[K${mark} ${msg}\n`);
    } else {
      process.stdout.write(`✗ ${msg}\n`);
    }
  }

  /**
   * Stop spinner and restore cursor.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      // Show cursor
      process.stdout.write('\u001b[?25h');
    }
  }
}

module.exports = {
  SPINNERS,
  TerminalSpinner,
};
