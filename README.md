# Git X-Ray

**Repository Forensics, Not Another Git Client.**

Git X-Ray is a zero-dependency command-line tool that analyzes Git repository history to uncover hidden engineering and knowledge risks.

Instead of simply showing commits, Git X-Ray helps answer questions such as:

- Which files change the most?
- Where is development knowledge concentrated?
- Which files have a low bus factor?
- Which parts of the codebase represent potential maintenance risks?
- Who are the primary contributors to critical files?
- Which files combine high change activity with concentrated ownership?
- How has the repository evolved over time?

Git X-Ray reads Git's underlying `.git` object data directly and performs its analysis locally — without relying on external APIs, third-party runtime packages, or the Git executable.

---

## Why Git X-Ray?

A Git repository records *what* changed and *who* changed it, but raw history does not immediately tell a team *where* knowledge and maintenance risk are concentrated.

A file may be:

- Frequently modified
- Structurally complex
- Dominated by one contributor
- Dependent on a very small number of people with historical knowledge

Such files can become engineering bottlenecks and single points of failure.

Git X-Ray transforms repository history into understandable forensic signals that help teams identify these risks before they become problems.

---

## Core Features

### Repository Overview

Get a high-level view of the repository before diving into individual metrics. The overview provides information such as:

- Commit count
- Contributor count
- File count
- Repository activity
- Risk indicators
- Knowledge concentration
- High-risk areas

### Risk Hotspots

Identify files that deserve attention based on historical development and structural signals. Git X-Ray highlights files where factors such as:

- High change frequency
- Concentrated ownership
- Low contributor diversity
- Structural complexity

combine to create elevated maintenance risk. The objective is not simply to produce a number, but to show *why* a file is considered risky.

### Ownership Analysis

Analyze who has historically contributed to each file and how concentrated that knowledge is.

**Example:**

| File | Primary Author | Ownership |
|---|---|---|
| `src/auth.js` | X | 82% |
| `src/server.js` | Y | 51% |
| `src/utils.js` | Z | 28% |

This helps teams identify areas where critical knowledge may depend heavily on a small number of contributors.

### Bus-Factor Analysis

Identify files where knowledge is concentrated around very few contributors. A low bus factor indicates that a project may have limited redundancy in its knowledge base.

**Example:**

```
CRITICAL

src/auth.js

Bus Factor: 1
Primary Author: X
Ownership: 91%
```

These files can become single points of failure if their primary contributor leaves the project, changes teams, or becomes unavailable.

### Churn Analysis

Measure how frequently files have changed throughout repository history. High churn can indicate:

- Actively evolving code
- Frequently modified components
- Potentially unstable areas
- Maintenance hotspots

Git X-Ray presents historical file activity in a form that can be compared with ownership and structural signals.

### Structural Complexity

Analyze source files using structural signals such as branching, loops, nesting, and other code constructs. The resulting complexity information is intended to help identify structurally difficult areas of the repository and combine them with historical development signals.

### Repository History

Inspect reconstructed commit history directly from the repository's Git object database. Git X-Ray analyzes:

- Commits
- Authors
- Parent relationships
- File changes
- Historical activity

### JSON Output

Git X-Ray can produce machine-readable output for automation and further processing.

```bash
gitxray . log --json
```

---

## How It Works

Git X-Ray does not use Git as a subprocess. Instead, it reads the repository's underlying object database directly.

```
Git Repository
      |
      v
    .git/
      |
      v
Raw Git Object Data
      |
  +---+---+
  |       |
  v       v
Commits  Trees
  |       |
  +---+---+
      |
      v
History Reconstruction
      |
      v
File-Level Analysis
      |
  +---+---+---+
  |       |       |
  v       v       v
Churn  Ownership  Bus Factor
  |       |       |
  +---+---+---+
      |
      v
  Risk Analysis
      |
      v
Terminal / JSON Output
```

The core engine is implemented using Node.js standard-library functionality.

---

## Zero Dependencies

Git X-Ray was designed under a strict zero-third-party-dependency constraint. The runtime uses only Node.js built-in functionality.

Examples include:

| Purpose | Built-in used |
|---|---|
| File system access | `node:fs` |
| Path handling | `node:path` |
| Git object decompression | `node:zlib` |
| Hashing | `node:crypto` |
| Terminal input/output | `node:readline` and `process` |
| Binary data | `Buffer` |
| Testing | `node:test` |

No third-party runtime packages are required.

Git X-Ray does **not** use:

- `simple-git`
- `nodegit`
- GitHub APIs
- External services
- External databases
- Third-party terminal UI libraries

The project includes `STDLIB.md` for documenting standard-library substitutions and `deps-proof.txt` for dependency verification.

---

## Installation

**Requirements:**

- Node.js
- A Git repository to analyze

No package installation is required for the canonical execution path.

Clone the repository:

```bash
git clone <YOUR_REPOSITORY_URL>
cd git-xray
```

Build:

```bash
node build.js
```

Run:

```bash
node dist/gitxray.js .
```

Analyze another repository:

```bash
node dist/gitxray.js /path/to/repository
```

On Windows:

```bash
node dist/gitxray.js "C:\path\to\repository"
```

### Optional CLI command

For local developer convenience, Git X-Ray also provides a `gitxray` executable entry point.

```bash
npm link
```

Then:

```bash
gitxray .
```

`npm link` is optional. It creates a local command alias and does not add a third-party runtime dependency to the project.

The canonical zero-install execution path is:

```bash
node dist/gitxray.js .
```

---

## Usage

Show help:

```bash
gitxray --help
```

Analyze a repository:

```bash
gitxray .
```

Repository history:

```bash
gitxray . log
```

Churn:

```bash
gitxray . churn
```

Ownership:

```bash
gitxray . ownership
```

Bus-factor analysis:

```bash
gitxray . bus-factor
```

Custom bus-factor threshold:

```bash
gitxray . bus-factor --threshold 70
```

JSON output:

```bash
gitxray . log --json
```

Use `gitxray --help` for the authoritative list of commands and options supported by the current build.

---

## Terminal Interface

Git X-Ray is designed as a terminal-native developer tool. The interface provides:

- Interactive keyboard navigation
- Repository overview
- Risk dashboards
- Analytical tables
- Visual risk indicators
- File-level analysis
- JSON output for automation

The interface is implemented without third-party terminal UI frameworks.

---

## Design Principles

**Explainability Over Opaque Scoring**
Git X-Ray is designed to make risk understandable. A file should not simply be labelled with a high-risk score without showing the signals contributing to that result.

**History Over Snapshots**
Git X-Ray analyzes how a repository evolved rather than looking only at its current state.

**Local-First Analysis**
Repository data stays local. No GitHub account, API key, cloud service, or external analytics service is required for repository analysis.

**Zero Dependencies**
The project deliberately replaces commonly used third-party packages with Node.js standard-library functionality.

**Focused Scope**
Git X-Ray is an analysis tool, not a replacement for Git.

---

## Project Structure

```
git-xray/
│
├── bin/
│   └── gitxray.js
│
├── dist/
│   └── gitxray.js
│
├── src/
│   ├── analytics/
│   │   ├── bus-factor.js
│   │   ├── churn.js
│   │   └── ownership.js
│   │
│   ├── cli/
│   │   └── args.js
│   │
│   ├── git/
│   │   ├── locator.js
│   │   ├── objects.js
│   │   ├── refs.js
│   │   └── walker.js
│   │
│   ├── outputs/
│   │   ├── json.js
│   │   └── terminal.js
│   │
│   └── index.js
│
├── tests/
│   └── test.js
│
├── build.js
├── package.json
├── STDLIB.md
├── deps-proof.txt
└── zero-dep.toml
```

---

## Testing

Git X-Ray uses Node.js's built-in test runner.

```bash
node --test tests/test.js
```

The test suite covers repository validation, Git object parsing, history traversal, analytics, CLI behavior, and output generation.

The current validation suite contains **115 tests**, with **all 115 passing and 0 failures**.

---

## Deterministic Build

Git X-Ray includes a bundled single-file distribution: `dist/gitxray.js`.

Build it using:

```bash
node build.js
```

The build process is designed to produce deterministic output. The generated artifact can be executed directly:

```bash
node dist/gitxray.js .
```

---

## Limitations

Git X-Ray intentionally does not attempt to implement the complete Git feature set. Current limitations include:

- Full packed-object delta resolution is not currently implemented
- Deep binary delta reconstruction from `.pack` archives is outside the current scope
- Advanced merge/rebase complexity is limited by the documented history model
- Structural complexity analysis is intentionally lightweight rather than a replacement for language-specific static-analysis platforms

These limitations are documented rather than hidden. Git X-Ray is intended to provide useful repository forensics, not to become another implementation of Git.

---

## Security and Privacy

Git X-Ray performs repository analysis locally. It does not require:

- GitHub credentials
- API keys
- Cloud services
- External analytics services
- Repository uploads

The repository being analyzed remains on the local machine.

---

## Hackathon Implementation

Git X-Ray was built for a strict standard-library-only development environment. The project demonstrates how functionality commonly delegated to external packages can be implemented using platform primitives.

| Capability | Implementation |
|---|---|
| Git parsing | Raw Git object handling |
| Compression | `node:zlib` |
| Hashing | `node:crypto` |
| CLI parsing | Custom argument parser |
| Terminal UI | ANSI escape sequences and Node.js I/O |
| Testing | `node:test` |
| Build | Custom Node.js build script |

The complete standard-library substitution rationale is documented in `STDLIB.md`. Dependency verification is documented in `deps-proof.txt`.

---

## Project Status

Git X-Ray currently provides a functional repository-forensics workflow with:

- Raw Git repository analysis
- Commit and tree parsing
- History reconstruction
- Churn analysis
- Ownership analysis
- Bus-factor analysis
- Structural analysis
- Risk and hotspot analysis
- Interactive terminal output
- JSON output
- Deterministic bundled distribution
- Automated testing
- Zero third-party runtime dependencies

The implementation has been tested against real-world public repositories in addition to the project's own repository.

---

**Git X-Ray**
*Repository Forensics, Not Another Git Client.*