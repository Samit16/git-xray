'use strict';

const { parseArgs } = require('node:util');

/**
 * Parse CLI arguments using Node's built-in util.parseArgs.
 *
 * Usage:
 *   gitxray <path> <command> [options]
 *   gitxray <path> [options]             (defaults to log)
 *   gitxray <command> [options]          (uses cwd)
 *
 * Commands: log, ownership, churn, bus-factor
 * Options:
 *   --json          Output as JSON
 *   --threshold N   Bus-factor threshold percentage (default: 80)
 *   --help          Show help
 *
 * @returns {{ command: string, repoPath: string, options: { json: boolean, threshold: number } }}
 */
function parseCLI() {
  const COMMANDS = ['log', 'ownership', 'churn', 'bus-factor', 'interactive'];

  const { values, positionals } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '80' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  let repoPath, command;

  if (positionals.length === 1) {
    // Could be: gitxray <command> OR gitxray <path>
    if (COMMANDS.includes(positionals[0])) {
      command = positionals[0];
      repoPath = process.cwd();
    } else {
      // Default single-path invocation opens the central dashboard experience.
      repoPath = positionals[0];
      command = 'interactive';
    }
  } else {
    // gitxray <path> <command>
    repoPath = positionals[0];
    command = positionals[1];
  }

  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: "${command}"`);
    console.error('Available commands: ' + COMMANDS.join(', '));
    process.exit(1);
  }

  const threshold = parseInt(values.threshold, 10);
  if (isNaN(threshold) || threshold < 0 || threshold > 100) {
    console.error('--threshold must be a number between 0 and 100');
    process.exit(1);
  }

  return {
    command,
    repoPath,
    options: {
      json: values.json,
      threshold,
    },
  };
}

function printHelp() {
  const help = `
╭──────────────────────────────────────────────────────────────────────╮
│ Git X-Ray — Codebase history intelligence for modern engineering  │
├──────────────────────────────────────────────────────────────────────┤
│ Usage:                                                              │
│   node src/index.js <path> <command> [options]                     │
│   node src/index.js <path> [options]      (defaults to log)         │
│   node src/index.js <command> [options]   (uses current directory)  │
│                                                                      │
│ Commands:                                                           │
│   log          Reconstructed commit history                          │
│   ownership    Per-file ownership breakdown                         │
│   churn        Files ranked by change intensity                     │
│   bus-factor   Files at risk from concentration of authorship       │
│                                                                      │
│ Options:                                                            │
│   --json             Output as JSON                                  │
│   --threshold <N>    Bus-factor risk threshold (default: 80)         │
│   -h, --help         Show this help message                         │
│                                                                      │
│ Examples:                                                           │
│   node src/index.js . log                                           │
│   node src/index.js /path/to/repo ownership --json                  │
│   node src/index.js . bus-factor --threshold 70                     │
╰──────────────────────────────────────────────────────────────────────╯
`.trim();

  console.log(help);
}

module.exports = { parseCLI };
