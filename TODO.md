# TODO — Git X-Ray
72-hour build plan. Kickoff Aug 28, 18:00 UTC → Code freeze Aug 31, 18:00 UTC.
Roles: **A** = Core Engine · **B** = Analytics/CLI/Tests · **C** = Proof & Packaging

---

## Phase 0 — Before kickoff (planning only, NO CODE)
- [x] Confirm Node version to target (22 LTS) — pinned in README and zero-dep.toml
- [x] Set up repo skeleton: `README.md`, `STDLIB.md`, `.zero-dep.toml`, `deps-proof.txt`, `tests/`, `src/`, `dist/`
- [x] Agree on object-format reference: Git internal loose format (`<type> <size>\0<content>`, raw binary trees)

---

## Phase 1 — Core parsing
- [x] **A:** `.git` directory locator — handle missing `.git`, bare repos, worktrees → clear error, non-zero exit
- [x] **A:** `hashToPath(sha1)` helper
- [x] **A:** Read + `zlib.inflateSync` a single loose object, parse header
- [x] **A:** Parse `commit` object (tree, parents, author, committer, message, gpgsig skipping)
- [x] **A:** Parse `tree` object (binary: mode, name, 20-byte raw SHA-1)
- [x] **B:** CLI argument routing with `util.parseArgs`
- [x] **C:** README and STDLIB.md initial structures

---

## Phase 2 — Commit graph + tree diffing
- [x] **A:** Resolve `HEAD` → symbolic ref → `refs/heads/*` and `packed-refs`
- [x] **A:** Walk commit graph via parent pointers (BFS), build ordered commit list
- [x] **A:** Handle merge commits (diff against first parent only)
- [x] **A:** Recursive tree differ — flatten trees to path-hash maps, compare
- [x] **A:** Detect + gracefully skip packed objects with honest warning
- [x] **B:** `gitxray log` command end-to-end
- [x] **B:** `node:test` test suite initiated

---

## Phase 3 — Analytics + reporting
- [x] **B:** `churn` — count touches across commits
- [x] **B:** `ownership` — per-file author breakdown, primary-author %
- [x] **B:** `bus-factor` — flag files above threshold (`--threshold`, default 80%)
- [x] **B:** `--json` output mode for all commands
- [x] **B:** Terminal reporter using `util.styleText` and ANSI-aware table alignment
- [x] **A:** Non-UTF8 decode fallback (latin1)
- [x] **A:** Corrupted-object handling (try/catch skip + warning)
- [x] **Single File Decision:** Kept modular `src/` for clean development, created `build.js` to compile standalone deterministic `dist/gitxray.js` to claim both Code Quality and Single-File / Reproducible Build bonuses.

---

## Phase 4 — Hardening, tests, edge cases
- [x] Test: locator (.git search, bare repo, non-git dir error handling)
- [x] Test: object parsers (real commit, synthetic binary tree, hashToPath)
- [x] Test: refs (symbolic HEAD, branches)
- [x] Test: walker (commit ordering, tree differ, root commit diffs)
- [x] Test: analytics (churn, ownership, bus-factor, custom threshold)
- [x] Test: graceful error handling and non-zero exit codes
- [x] Test suite: 23/23 tests passing with `node --test`

---

## Phase 5 — Submission packaging
- [x] **C:** Finalize [README.md](file:///c:/Users/samit/OneDrive/Desktop/Projects/git-xray/README.md) — usage, features, reproducible build, honest scope
- [x] **C:** Finalize [STDLIB.md](file:///c:/Users/samit/OneDrive/Desktop/Projects/git-xray/STDLIB.md) — 11 documented substitutions + `chalk` Package Killer highlight
- [x] **C:** Deterministic build script [build.js](file:///c:/Users/samit/OneDrive/Desktop/Projects/git-xray/build.js)
- [x] **C:** Finalize [deps-proof.txt](file:///c:/Users/samit/OneDrive/Desktop/Projects/git-xray/deps-proof.txt) with real command proofs and SHA-256 verification
- [x] **C:** Finalize [zero-dep.toml](file:///c:/Users/samit/OneDrive/Desktop/Projects/git-xray/zero-dep.toml)
- [x] **All:** Zero `child_process` / `exec` / `spawn` / external packages confirmed
