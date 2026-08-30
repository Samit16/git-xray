'use strict';

const { parseArgs } = require('node:util');

/**
 * Parse CLI arguments using Node's built-in util.parseArgs.
 *
 * Usage:
 *   gitxray <path> [command] [options]
 *   gitxray [command] [options]          (uses current directory)
 *
 * Commands & Aliases:
 *   overview   | health      Repository Health & Executive Overview (default)
 *   hotspots   | risk        Where Is The Risk? (Risk hotspots)
 *   bus-factor | knowledge   Who Owns The Knowledge? (Bus factor & ownership)
 *   ownership                Per-file ownership breakdown
 *   churn      | changes     What Changes Most? (Change frequency)
 *   complexity               What Is Most Complex? (Structural complexity)
 *   log        | history     Repository History (Commit timeline)
 *   interactive              Interactive forensic navigation dashboard
 *
 * Options:
 *   --json          Output as JSON
 *   --threshold N   Bus-factor threshold percentage (default: 80)
 *   -h, --help      Show help
 *
 * @returns {{ command: string, repoPath: string, options: { json: boolean, threshold: number } }}
 */
function parseCLI() {
  const COMMAND_ALIASES = {
    health: 'overview',
    risk: 'hotspots',
    knowledge: 'bus-factor',
    changes: 'churn',
    history: 'log',
  };

  const VALID_COMMANDS = [
    'overview',
    'log',
    'ownership',
    'churn',
    'bus-factor',
    'hotspots',
    'complexity',
    'interactive',
    ...Object.keys(COMMAND_ALIASES),
  ];

  let values;
  let positionals;

  try {
    ({ values, positionals } = parseArgs({
      options: {
        json: { type: 'boolean', default: false },
        threshold: { type: 'string', default: '80' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    const optionName = err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && err.optionName
      ? err.optionName
      : 'unknown option';
    console.error(`Unknown option: ${optionName}`);
    console.error('Use --help for usage information.');
    process.exit(1);
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  let repoPath, rawCommand;

  if (positionals.length === 1) {
    // Could be: gitxray <command> OR gitxray <path>
    if (VALID_COMMANDS.includes(positionals[0])) {
      rawCommand = positionals[0];
      repoPath = process.cwd();
    } else {
      // Default single-path invocation launches interactive dashboard in TTY or overview in script/pipe
      repoPath = positionals[0];
      rawCommand = process.stdout.isTTY && !values.json ? 'interactive' : 'overview';
    }
  } else {
    // gitxray <path> <command>
    repoPath = positionals[0];
    rawCommand = positionals[1];
  }

  if (!VALID_COMMANDS.includes(rawCommand)) {
    console.error(`Unknown command: "${rawCommand}"`);
    console.error('Available commands: overview (health), hotspots (risk), bus-factor (knowledge), churn (changes), complexity, log (history), interactive');
    process.exit(1);
  }

  // Resolve alias if used
  const command = COMMAND_ALIASES[rawCommand] || rawCommand;

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
│ Git X-Ray — Zero-Dependency Codebase Intelligence & Forensics       │
├──────────────────────────────────────────────────────────────────────┤
│ Usage:                                                               │
│   gitxray <path> [command] [options]                                 │
│   gitxray [command] [options]             (uses current directory)   │
│                                                                      │
│ Commands framed as user questions:                                   │
│   overview   | health     Repository Health Summary (default)        │
│   hotspots   | risk       Where Is The Risk? (Fragile files)         │
│   bus-factor | knowledge  Who Owns The Knowledge? (Knowledge silos)  │
│   churn      | changes    What Changes Most? (Modification churn)    │
│   complexity              What Is Most Complex? (Structural AST)     │
│   log        | history    Repository History (Commit timeline)       │
│   ownership               Per-file author ownership breakdown        │
│   interactive             Launch interactive dashboard               │
│                                                                      │
│ Options:                                                             │
│   --json             Output clean JSON                               │
│   --threshold <N>    Bus-factor risk threshold percentage (def: 80)  │
│   -h, --help         Show this help guide                            │
│                                                                      │
│ Examples:                                                            │
│   gitxray .                                                          │
│   gitxray . risk                                                     │
│   gitxray . knowledge --threshold 75                                 │
│   gitxray . complexity                                               │
╰──────────────────────────────────────────────────────────────────────╯
`.trim();

  console.log(help);
}

module.exports = { parseCLI };
