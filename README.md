# Git X-Ray 🔍

> An X-ray machine for a codebase's history — reads the raw `.git` object database directly (zero dependencies, zero shelling out to `git`) to surface ownership risk, churn hotspots, and bus-factor.

Built for **Zero Dependency 2026 · Track A (Developer Tools & CLI)**.

---

## Features

- **`gitxray <repo>` (Default Overview)**: Instant executive repo assessment — commit counts, contributor counts, file counts, composite risk score, knowledge concentration, bus-factor alerts, and top critical hotspots.
- **`gitxray <path> log`**: Reconstructs commit history (hash, author, date, message) by traversing loose commit objects.
- **`gitxray <path> churn`**: Computes change frequency per file across commits, with terminal bar charts.
- **`gitxray <path> ownership`**: Identifies primary authors, distinct contributors, and percentage breakdown per file.
- **`gitxray <path> bus-factor`**: Surfaces files where a single committer owns >N% of changes (configurable with `--threshold`).
- **`gitxray <path> hotspots`**: Identifies risk hotspots by combining churn, ownership dominance, and recency.
- **`gitxray <path> complexity`**: Performs zero-dependency structural complexity analysis on codebase files.
- **`--json`**: Machine-readable JSON output for any command.
- **Colored Terminal Reports**: Native styling using `util.styleText` (respects `NO_COLOR`).
- **Graceful Failure**: Clean messages for missing repositories, empty trees, and packed objects — zero unhandled stack dumps.

---

## Requirements & Running

- **Node.js**: `v22.0.0+` (Built and verified on Node.js `v22.20.0`)
- **Dependencies**: **0** runtime npm packages.

### Run directly with Node
```bash
# Default Executive Overview
node src/index.js .

# Or explicit overview command
node src/index.js . overview

# View commit history
node src/index.js . log

# View file churn hotspots
node src/index.js . churn

# View code ownership
node src/index.js . ownership

# View bus-factor risks (default 80% threshold)
node src/index.js . bus-factor

# View risk hotspots
node src/index.js . hotspots

# View structural complexity
node src/index.js . complexity

# Custom threshold and JSON output
node src/index.js . --json
node src/index.js . bus-factor --threshold 70 --json
```

Or run the bundled standalone single-file version:
```bash
node dist/gitxray.js .
```

---

## Reproducible Build & Single-File Artifact

To generate the standalone single-file distribution in `dist/gitxray.js`:

```bash
node build.js
```

### Reproducibility Verification
Running the build produces a deterministic byte-identical artifact:

```bash
node build.js && node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('dist/gitxray.js')).digest('hex'))"
# Output SHA-256: a7b1057f0b0f81485b713b3fab4faec05d448b0b7242edaecde9649cbcfb39ad
```

---

## Running Tests

Run the full zero-dependency test suite using Node's built-in test runner:

```bash
node --test tests/test.js
```

---
