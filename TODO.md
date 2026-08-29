# TODO — Git X-Ray
72-hour build plan. Kickoff Aug 28, 18:00 UTC → Code freeze Aug 31, 18:00 UTC.
Roles: **A** = Core Engine · **B** = Analytics/CLI/Tests · **C** = Proof & Packaging

Check things off as you go. Don't skip the honesty/graceful-failure items — they're worth real rubric points and take minutes, not hours.

---

## Phase 0 — Before kickoff (planning only, NO CODE)
- [ ] Confirm Node version to target (24 or 26 LTS) — pin it in README
- [ ] Set up repo skeleton (empty, no code): `README.md`, `STDLIB.md`, `.zero-dep.toml`, `deps-proof.txt`, `tests/`, `src/` (or plan for single-file)
- [ ] Person B: identify/prepare 2–3 real small public git repos (or your own old projects) to use as test fixtures — commit a **zipped snapshot of a real `.git` folder** into `tests/fixtures/`. This is fine: fixture creation isn't part of the shipped artifact, and the tool never invokes `git` at runtime.
- [ ] Agree on the object-format reference each person will use while building (git's own documented internal format — no package needed to read the spec)

---

## Phase 1 — Hours 0–12: Core parsing (get one real object round-tripped)
- [ ] **A:** `.git` directory locator — handle missing `.git`, bare repos, worktrees → clear error, non-zero exit
- [ ] **A:** `hashToPath(sha1)` helper
- [ ] **A:** Read + `zlib.inflateSync` a single loose object, parse the `"<type> <size>\0<content>"` header
- [ ] **A:** Parse a `commit` object (tree, parent(s), author, committer, message) — write down the exact plaintext format you're relying on
- [ ] **A:** Parse a `tree` object (binary: mode, name, 20-byte SHA-1 per entry) — this is the fiddliest part, budget extra time
- [ ] **B:** Skeleton CLI with `util.parseArgs` — just `gitxray <path> <command>` routing, no logic yet
- [ ] **C:** README skeleton (sections only) + STDLIB.md skeleton (table headers) — start now, not later
- [ ] **Checkpoint:** can you print one real commit's metadata from a real repo? If not, this is priority #1 for hour 12–18.

## Phase 2 — Hours 12–30: Commit graph + tree diffing
- [ ] **A:** Resolve `HEAD` → symbolic ref → `refs/heads/*` and `packed-refs` (branch tips)
- [ ] **A:** Walk commit graph via parent pointers (BFS/DFS), build ordered commit list
- [ ] **A:** Handle merge commits (2+ parents) — decide: diff against first parent only (document this choice)
- [ ] **A:** Recursive tree differ — given two tree SHA-1s, produce list of changed file paths
- [ ] **A:** Detect + gracefully skip packed (non-loose) objects — print the honest warning message, don't crash
- [ ] **B:** `gitxray log` command wired to A's commit walker — first end-to-end feature working
- [ ] **B:** Start `node:test` suite: at least one test per parser (commit, tree, blob header)
- [ ] **C:** Draft STDLIB.md entries for everything shipped so far (zlib, crypto, fs so far)
- [ ] **Checkpoint (~hour 30):** `gitxray log` works end-to-end on a real fixture repo. If not on track, cut a stretch feature now, not later.

## Phase 3 — Hours 30–48: Analytics + reporting
- [ ] **B:** `churn` — count file touches across all commits
- [ ] **B:** `ownership` — per-file author breakdown, primary-author %
- [ ] **B:** `bus-factor` — flag files above ownership threshold (make threshold a `--threshold` flag, default 80%)
- [ ] **B:** `--json` output mode for every command
- [ ] **B:** Terminal reporter using `util.styleText` (colors) — tables/formatting by hand, no `chalk`, no `cli-table3`
- [ ] **A:** Support for non-UTF8 author names/commit messages (decode fallback) — add a test case
- [ ] **A:** Corrupted-object handling — wrap parsing in try/catch, skip + report bad hash instead of crashing
- [ ] **C:** Keep STDLIB.md current; start drafting the "honest limitations" section of README (packed objects, first-parent-only diffing, etc.)
- [ ] **🚦 HARD CHECKPOINT — Single File bonus decision (hour ~48):**
  - [ ] Is the current single-file line count still readable top-to-bottom?
  - [ ] Are tests still clean to write against it?
  - [ ] **If yes** → keep going single-file, aim to land the +5 bonus.
  - [ ] **If no** → split into `src/` now. Do not let this bonus damage Code Quality (25%, worth 5x more than this bonus).

## Phase 4 — Hours 48–60: Stretch features (only if MVP is solid)
- [ ] ASCII heatmap visualization for churn/ownership
- [ ] Basic `.idx` pack-index reading (existence lookup only, no delta resolution) — upgrade the "packed object" warning to at least report accurate counts
- [ ] Author identity merging heuristic
- [ ] **If MVP has any rough edges at all, skip this phase entirely and go straight to Phase 5.**

## Phase 5 — Hours 60–68: Hardening, tests, edge cases
- [ ] Test: empty repo (0 commits)
- [ ] Test: repo with only 1 commit
- [ ] Test: merge commit (2+ parents)
- [ ] Test: detached HEAD
- [ ] Test: symbolic ref resolution
- [ ] Test: deeply nested tree structure
- [ ] Test: binary file blob (doesn't break tree diffing)
- [ ] Test: non-UTF8 author name/message
- [ ] Test: missing `.git` directory → clean error, correct exit code
- [ ] Test: packed objects present → honest warning, no crash
- [ ] Run the whole test suite with `node --test`, fix anything red
- [ ] Sanity-run the tool against 2–3 *different* real repos, not just your fixture — catch surprises now

## Phase 6 — Hours 68–72: Submission packaging (DO NOT let this slip)
- [ ] **C:** Finalize README.md — what it does, how to run it (one command), full honest limitations section
- [ ] **C:** Finalize STDLIB.md — confirm 10+ real substitution entries with one-line rationale each (STDLIB Log bonus)
- [ ] **C:** Write/finalize `Makefile` or single build command
- [ ] **C:** Run the build twice, `sha256sum` both outputs, paste both hashes into `deps-proof.txt` and README (Reproducible Build bonus)
- [ ] **C:** Generate final `deps-proof.txt` — actual command output (see template file provided)
- [ ] **C:** Finalize `.zero-dep.toml` — confirm track letter + pitch (see template file provided)
- [ ] **C:** Confirm `package.json` (if present) has `dependencies: {}` or is absent entirely — **5-second judge check, must be flawless**
- [ ] **C:** Record 5-minute demo video: show the empty manifest, run the tool live on a real repo, show 2–3 features, show one graceful-failure case (e.g., run it on a non-git folder)
- [ ] **All:** Confirm every line of code was written during the 72-hour window (pre-kickoff code = disqualification)
- [ ] **All:** Confirm repo is public with an OSI-approved license before code freeze
- [ ] **All:** Double-check no `git` binary invocation exists anywhere in the shipped code (grep for `child_process`, `exec`, `spawn` — should return nothing, or only in a clearly-disclosed dev-fixture script that never ships)
- [ ] Submit before **Aug 31, 18:00 UTC** — don't cut it to the last 5 minutes, GitHub/network hiccups happen

---

## Quick reference: what NOT to do (auto-loses points)
- ❌ Calling the real `git` binary from the shipped tool (`child_process.exec('git ...')`) — this is a hidden dependency
- ❌ Vendoring any library source into `src/` without disclosing it in STDLIB.md
- ❌ Claiming full packfile support when you only handle loose objects — be honest instead
- ❌ Crashing with a raw stack trace on bad input — always a clean message + non-zero exit
- ❌ Leaving STDLIB.md with empty/vague bullets — judges read this closely, it's 30% of the score
