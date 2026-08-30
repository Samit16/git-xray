# STDLIB.md — Standard Library Substitution Log

**Git X-Ray · Zero Dependency 2026**

Git X-Ray has **0 npm dependencies**, **0 external APIs**, and **0 subshells to the `git` binary**. Everything is built directly with Node.js built-in modules (`node:fs`, `node:zlib`, `node:crypto`, `node:util`, `node:path`, `node:test`, `node:assert`).

---

## 1. Package Substitutions Table

| # | Normally You Would Use | Replaced With (Node.js Built-in) | Category | Why & How It Works |
|---|------------------------|----------------------------------|----------|--------------------|
| 1 | `simple-git` / `isomorphic-git` | `node:fs` reading `.git/objects` directly | Git Engine | Directly resolves `HEAD`, decodes refs from `refs/heads/*` and `packed-refs`, and reads loose git objects. Zero reliance on git binaries. |
| 2 | `chalk` (319.8M wkly downloads) | `util.styleText` (Node 22+) | Package Killer | Formats terminal text with colors (`cyan`, `yellow`, `red`, `green`, `dim`, `bold`). Respects `NO_COLOR` env and TTY settings natively. |
| 3 | `commander` / `yargs` | `util.parseArgs` (Node 18.3+) | CLI Parser | Strictly validates CLI arguments, boolean flags (`--json`), options (`--threshold`), and positional commands. |
| 4 | `zlib` (npm packages) | `node:zlib` (`inflateSync`) | Compression | Loose git objects are compressed with standard DEFLATE / zlib. Decompresses raw buffers synchronously into memory. |
| 5 | `crypto-js` / `sha.js` | `node:crypto` (`createHash('sha1')`, `createHash('sha256')`) | Cryptography | Verifies loose object SHA-1 integrity checks and generates SHA-256 build checksums. |
| 6 | `cli-table3` / `cli-table` | Native Handcrafted ANSI-aware Formatter | Terminal Layout | Custom table formatter calculating column widths and padding with `stripAnsi` awareness. |
| 7 | `jest` / `mocha` | `node:test` + `node:assert/strict` | Testing Suite | Built-in test runner with nested test suites, TAP output, and subtests without runner frameworks. |
| 8 | `glob` / `fast-glob` | Recursive `node:fs` (`readdirSync({ withFileTypes: true })`) | Filesystem | Recursively traverses `refs/` directory trees to discover loose branch references. |
| 9 | `strip-ansi` | Regex `/\x1b\[[0-9;]*m/g` | Formatting | Strips ANSI escape sequences to accurately compute string visual width for column alignment. |
| 10 | `ora` / `cli-spinners` | Custom `TerminalSpinner` via `setInterval` + ANSI escapes | Terminal UI | Live braille spinner animation with cursor hiding (`\x1b[?25l`) and TTY auto-detection. |
| 11 | `boxen` | Native Unicode box-drawing primitives | Terminal UI | Responsive bordered panels, status cards, and metric boxes with terminal width clamping. |
| 12 | `inquirer` / `prompts` | Raw `process.stdin` + ANSI keycode parser | Interaction | Full interactive terminal dashboard navigation using arrow keys (↑/↓), vim keys (j/k), and Enter. |
| 13 | `figlet` / ASCII art generator | Handcrafted circuit-grid ASCII logo | Branding | Pixel-accurate green circuit-chip header logo with responsive narrow-terminal fallback. |
| 14 | `dotenv` | `process.loadEnvFile()` (Node 20.12+) / `process.env` | Config | Native environment variable handling without external file loaders. |
| 15 | `semver` / `which` | Built-in `process.version` & `process.cwd` | Diagnostics | Eliminates path-lookup and version checking libraries. |

---

## 2. Package Killer Highlight: `chalk` → `util.styleText`

### Before (Third-Party Dependency)
```js
const chalk = require('chalk');
console.log(chalk.bold.cyan('═══ Commit Log ═══'));
console.log(chalk.red(`⚠ 5 files at risk`));
```

### After (Git X-Ray Zero-Dependency)
```js
const util = require('node:util');

function style(styleName, text) {
  if (process.env.NO_COLOR || process.stdout.isTTY === false) return text;
  return util.styleText(styleName, text);
}

console.log(style('bold', style('cyan', '═══ Commit Log ═══')));
console.log(style('red', '⚠ 5 files at risk'));
```

---

## 3. Disclosures & Runtime Guarantees

1. **No External Git Invocation**: `child_process`, `exec`, and `spawn` are **not imported or used** anywhere in `src/`, `dist/`, or `build.js`.
2. **Binary Git Tree Parser**: Custom implementation parses the raw binary Git tree format (`<mode> <name>\0<20-byte-sha1>`) directly from Node `Buffer` slices.
3. **Graceful Degradation**: Packed objects (which require delta compression reconstruction) are cleanly detected and counted, reporting an honest message instead of crashing or misreporting statistics.
