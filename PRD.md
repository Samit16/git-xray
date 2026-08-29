# PRD — Git X-Ray

**Zero Dependency 2026 · Track A (Developer Tools & CLI) · JavaScript/TypeScript (Node.js, plain JS)**

---

## 1. One-line pitch

An X-ray machine for a codebase's history — reads the raw `.git` object database directly (no calling the `git` binary, no npm packages) to surface repo-health signals that `git log` doesn't show you: file ownership risk, churn hotspots, and bus-factor.

## 2. Problem statement

Engineering teams lose knowledge silently. A file with one committer who leaves is a landmine nobody notices until it's too late. Existing tools that answer this (`gitinspector`, `git-quick-stats`, GitHub's own insights) either shell out to the real `git` binary or require installing a package. Git X-Ray answers the same questions by parsing git's on-disk object format itself — zero runtime dependencies, zero calls to an external `git` process.

## 3. Goals / Non-goals

**Goals**

- Correctly parse loose git objects (blobs, trees, commits) directly from `.git/objects/`
- Walk the commit graph via parent pointers to reconstruct history
- Attribute file changes to authors and compute churn / ownership / bus-factor metrics
- Present results as a readable terminal report (with color) and optional JSON output
- Ship with zero third-party runtime dependencies, one-command build, tests, README, STDLIB.md

**Non-goals (explicitly out of scope, and that's fine — say so honestly in the README)**

- Full packfile delta resolution (offset/ref deltas) — real git repos mix loose + packed objects; we scope to loose objects for the MVP and treat packed objects as a documented limitation (see §7)
- Merge/rebase/any write operations — this is a read-only forensics tool
- Being faster than real `git` — correctness and honesty beat performance

## 4. Track & rule fit

- **Track A is explicitly named for "git helper" tools** in the official brief — no track-fit justification needed.
- **Confirmed legal per organizer FAQ:** *"Can my tool run git at runtime? No... Parsing files those tools already produced is fine, because nothing third-party ends up in your artifact."* Two conditions we must satisfy:
  1. Disclose this approach explicitly in STDLIB.md
  2. Degrade gracefully (clear error, not a crash) when `.git` is missing or malformed

## 5. Target user

An engineering lead or new team member who wants to answer, in 10 seconds, from any repo on disk: *"which files are dangerously owned by one person, and where is this codebase most fragile?"*

## 6. Features

### MVP (must-ship)

| Feature                       | Description                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `gitxray <path> log`        | Reconstructed commit history (hash, author, date, message) by walking loose objects — a sanity check that parsing works |
| `gitxray <path> ownership`  | Per-file: primary author %, number of distinct authors, last-touched date                                                |
| `gitxray <path> churn`      | Files ranked by number of changes across history (commit touch count)                                                    |
| `gitxray <path> bus-factor` | Files where one author owns >X% of lines/commits — the "if they leave, we're in trouble" list                           |
| `--json` flag               | Machine-readable output for any command (scriptability, also makes testing easier)                                       |
| Colored terminal report       | Using`util.styleText` (Node's built-in — kills `chalk`, see STDLIB.md)                                              |
| Graceful failure              | Not a git repo / empty repo / corrupted object → clear message, non-zero exit code, no stack trace dump                 |

### Stretch (only if MVP is done with time to spare)

| Feature                            | Description                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ASCII heatmap visualization        | Churn/ownership rendered as a colored grid in the terminal                                                                                             |
| Basic`.idx` (pack index) reading | Look up whether an object exists in a packfile and report "object is packed, skipping" instead of silently missing it — without full delta resolution |
| Author identity merging            | Collapse`Alice <alice@work.com>` / `Alice <a@personal.com>` via simple name-matching heuristic                                                     |
| Time-decayed ownership score       | Recent commits weighted more than old ones                                                                                                             |

**Cut stretch features first if time is tight. Never cut MVP correctness or tests for a stretch feature.**

## 7. Technical scope decision (important — document this in README)

Real repos store objects two ways: **loose** (one zlib-deflated file per object under `.git/objects/xx/`) and **packed** (compressed into `.pack` files with delta compression, referenced by a `.idx` index, once you run `git gc`).

**We are scoping the MVP to loose objects only.** Packfile delta resolution (reconstructing an object from a chain of binary diffs against a base object) is a genuinely large parsing task and a poor use of 72 hours relative to the payoff.

**Mitigation:** detect when an object we need isn't present as a loose object, and print an honest message (`"N commits are packed and not analyzed — run 'git gc --aggressive=false' or 'git repack -d' with a large window disabled, or analyze a repo before its first gc"`) rather than silently producing wrong numbers. This honesty is explicitly rewarded: *"A naive but honest implementation scores above a fast one that hides its corners."*

If a stretch-goal window opens up, add `.idx` reading (object existence lookup only, no delta resolution) so packed commits can at least be *counted*, even if their tree contents aren't walked.

## 8. Architecture

```Markdown
Input: path to a repo (defaults to cwd)
  │
  ▼
1. Locate .git directory (handle: bare repos, worktrees, missing .git → error)
  │
  ▼
2. Read HEAD → resolve symbolic ref → read refs/heads/* and packed-refs
  │
  ▼
3. Object reader (core engine)
   - hashToPath(sha1) → .git/objects/xx/yyyy...
   - readLooseObject(path) → zlib.inflateSync → parse "<type> <size>\0<content>"
   - parseTree(buffer) → [{mode, name, sha1}]
   - parseCommit(buffer) → {tree, parents[], author, committer, message}
  │
  ▼
4. Commit graph walker
   - BFS/DFS from each branch tip via parent pointers
   - Build ordered commit list, detect merge commits (2+ parents)
  │
  ▼
5. Tree differ
   - For each commit, diff its tree against parent's tree (recursive walk)
   - Produce list of changed file paths per commit
  │
  ▼
6. Analytics layer
   - churn: count touches per file path
   - ownership: group touches by author per file path
   - bus-factor: flag files where max author % > threshold (default 80%)
  │
  ▼
7. Reporter
   - Terminal: util.styleText colored tables
   - --json: JSON.stringify structured output
```

## 9. Standard-library mapping (feeds STDLIB.md)

| Normally you'd use                  | Instead we use                                               | Why                                                          |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `simple-git` / `isomorphic-git` | `node:fs` reading `.git/objects` directly                | Core premise of the project                                  |
| `zlib` npm wrapper                | `node:zlib` (`inflateSync`)                              | Loose objects are zlib-deflated                              |
| hashing package                     | `node:crypto` (`createHash('sha1')`)                     | Verify object hashes; also useful if we detect SHA-256 repos |
| `commander` / `yargs`           | `util.parseArgs` (stable since Node 18.3)                  | CLI argument parsing                                         |
| `chalk` (319.8M weekly downloads) | `util.styleText` (stable since Node 22.17)                 | Colored terminal output — flagship Package Killer target    |
| `cli-table3` / `blessed`        | Hand-written table formatting + raw ANSI cursor codes        | Terminal report layout                                       |
| `glob`                            | `fs.globSync` (Node 22+) or manual `fs.readdirSync` walk | Walking`.git/objects/**`                                   |
| `mocha` / `jest`                | `node:test` + `node:assert`                              | Test suite                                                   |
| `dotenv` (if any config needed)   | `process.loadEnvFile()`                                    | Unlikely to be needed but documented if used                 |

*(Aim for 10+ real entries here for the STDLIB Log bonus — expand this table as you build; every non-obvious substitution counts.)*

## 10. Bonus challenge strategy

| Bonus                             | Plan                                                                                                                                                                                                                                                                                                                                                                                                | Points           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Package Killer (+3)**     | `chalk` (319.8M/wk, highest-value target on the organizers' list) → `util.styleText`. Document clearly in STDLIB.md with a before/after code snippet.                                                                                                                                                                                                                                          | +3               |
| **STDLIB Log (+3)**         | Table in §9 above, expanded to 10+ entries as you build, each with a one-line rationale.                                                                                                                                                                                                                                                                                                           | +3               |
| **Single File (+5)**        | **Attempt it, with a decision checkpoint at hour 48** (see TODO.md). Git X-Ray's scope (parser + graph walker + analytics + CLI + reporter) is plausibly ~500–800 lines — genuinely single-file-able if kept disciplined. If by hour 48 the file is unmanageable or tests are suffering, split into `src/` and skip this bonus rather than jeopardize Code Quality (25%, worth far more). | +5 (conditional) |
| **Reproducible Build (+5)** | No compile step needed for plain JS. Build script: copy/concatenate source into`dist/gitxray.js` deterministically (sorted file order, no embedded timestamps/`Date.now()`), run it twice, `sha256sum` both outputs, publish both hashes in README. Organizer FAQ confirms: same machine, same toolchain, byte-identical — cross-environment reproducibility is *not* required.            | +5               |

**Total realistic upside: 11–16 bonus points**, on top of the 100-point rubric.

## 11. Scoring rubric alignment

| Criterion                  | Weight | How this project earns it                                                                                            |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| Functionality & Usefulness | 35%    | Real, working tool solving a real problem (repo risk visibility); one-command run; honest about its scope limits     |
| Zero-Dependency Craft      | 30%    | No shelling out to`git`; deep, well-documented stdlib substitutions (zlib, crypto, fs)                             |
| Code Quality & Idiom       | 25%    | Clean separation of concerns even if single-file; sensible error handling; readable to a senior JS reviewer          |
| Innovation                 | 10%    | "You can X-ray a repo's ownership risk without ever calling git" is a genuine "didn't know you could do that" moment |

## 12. Risks & mitigations

| Risk                                             | Mitigation                                                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packed objects break parsing on real-world repos | Scope to loose objects (§7), detect and report packed objects honestly instead of crashing                                                                                              |
| Binary blobs (images, etc.) break tree diffing   | Only need file*paths* and *sizes* from tree entries for churn/ownership — never need to parse blob *content* except for `.git/objects` header, so binary content is a non-issue |
| Corrupted/truncated objects                      | Wrap every`inflateSync`/parse call in try/catch, report the bad object hash and skip it rather than crashing the whole run                                                             |
| Merge commits double-counting churn              | Decide up front: diff merge commits against first parent only (standard convention), document the choice                                                                                 |
| Non-UTF8 author names/commit messages            | Read as`Buffer`, decode with explicit `'utf8'` and fallback to `latin1` if decode fails — document the choice                                                                     |
| Single-file bonus fights code quality            | Hard checkpoint at hour 48 (§10) — bail to`src/` structure if it's hurting readability                                                                                               |
| Team runs out of time on docs                    | Person C starts STDLIB.md and README skeleton on day one, fills in as features land — never left to the last hours                                                                      |

## 13. Team roles (3 people)

- **Person A — Core Engine:** object reader, zlib/SHA1 handling, tree/commit parsers, commit graph walker, tree differ. This is the technical heart and what you'll defend to judges.
- **Person B — Analytics + CLI + Tests:** churn/ownership/bus-factor computation on top of A's parsed data, `util.parseArgs` CLI surface, terminal reporter (`util.styleText`), and the `node:test` suite (this is also the person who builds test fixture repos — see TODO.md).
- **Person C — Proof & Packaging:** README.md, STDLIB.md (living document, updated continuously), build script + reproducible-build verification, `deps-proof.txt`, `.zero-dep.toml`, and the 5-minute demo video/script.

Roles can rotate once MVP core parsing is stable — Person C's work depends on A/B being far enough along to document accurately.
