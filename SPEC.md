# Zapple checks.js: false-alarm fixes + cheap new checks

Goal: Zapple must never report a problem that is really a limit of Zapple's own test area, or a
guess that valid code can trip. When unsure, stay quiet or say "couldn't verify" (amber).
Non-goals this pass: splitting files, confidence tiers, library runners, AI call, ZapLog wiring.
Public names that ui.js uses are unchanged (see list in the report).

## Requirements (each has a test; tag = test name prefix)

JS static
- R1 loop-invariant: flag `while` only if the body has no call other than console.* / Math.*, no
  member mutation of a tested variable (q.shift(), q.x=1, q[i]=1), no destructuring assignment to it,
  no exit, and the test has no call/await/yield. Property names (`.length`) are not "variables".
  Still flagged: `while (i < 10) { console.log(i) }`.
- R2 unawaited-async: `.then/.catch/.finally` on an async call is fine; `load().data` and
  `load().json()` flagged; order of definition does not matter; a name defined twice is skipped.
- R3 lint: `no-use-before-define` uses `variables:false`. A function that mentions a later `const`
  is fine; same-scope use before declaration is still an error.
- R6 checks box: trailing `// comment`, trailing `;`, a fully parenthesised check, and `==` (loose)
  all work.
- R7 deepEqual: Dates, RegExps, Errors, boxed primitives compare by value, not "both empty objects".
- R8 built-in typos (error `zapple/unknown-builtin-member`, with "did you mean"): `Math.flor`,
  `"abc".toUppercase()`, `[1].contains(1)`, receiver a single-declared const initialised with a
  literal. Never for: shadowed names, newer APIs on an allowlist (groupBy, withResolvers, at, ...),
  unknown receivers.

JS sandbox (browser test)
- R4 environment errors become `skipped` (amber), not a problem: extra globals (THREE), page-only
  names, blocked APIs (fetch). Real errors still `crashed`.
- R5 async: checks run after pending timers finish; a 1 s timer's result is visible to a check;
  a timer longer than the limit => `skipped`, not an error; a synchronous infinite loop => `timeout` error.

Python (CPython 3.13 + real pyflakes in tests; Pyodide is 3.12)
- R9 notebook magics are only blanked if the code fails to parse as written; valid `%` / `!=`
  continuation lines are never touched; a real error behind a magic is reported at its true line.
- R10 `__file__` is defined; relative-file `FileNotFoundError` and `input()` EOF are environment
  limits (skipped), not problems.
- R11 `sys.exit(n)` with n not 0/None => note "exited early with code n"; checks still run.
- R12 stdlib attribute typos on a plain `import mod` (single binding, non-package module): error
  with "did you mean".
- R13 stdlib calls: unknown keyword / too many positional args checked via inspect.signature, only
  when the signature is trustworthy (no **kwargs, resolvable, name bound once).
- R14 regression: add() missing arg, self.totl(), quiet on dataclass/Enum/NamedTuple still hold.

## Edge cases / safety
Every new static check skips when unsure (rebinding, star imports, getattr, `arguments`, spread).
Python runs in Pyodide 3.12; messages about stdlib say "in Python 3.12" so newer APIs are not a surprise.

## Not verifiable here
Real Pyodide, the real eslint-linter-browserify bundle (tests use node ESLint 9 Linter, same
rules), real Chrome worker blob timing beyond Playwright Chromium, the user's browser-globals.js.

## Round 2 (after live testing)
- L1 Undeclared library names stay `no-undef` errors (genuine undefined-name detection); the message now says to add the name
  to "Extra names". Declared names are clean and the sandbox reports a missing library as amber (R4).
- L2 A blocked-API error that user code catches is console output only. Only an uncaught one makes the run amber. console.error is never a checker failure.
- L3 `==` produces no diagnostic. R6 is about parsing/running loose equality only (no eqeqeq rule is in ESLINT_RULES).
- L4 `item.quantitty`: runtime gives NaN (no error). A Check detects it. Static note `zapple/possible-property-typo` only when the
  name is read once, never created, 1-2 letters off a name the same code defines (not a plural, not case-only, >=5 letters), in
  snippet-sized code (<=40 own property names). Note severity only: never an error, never sent to the repair prompt.
- D1 Console output and "got ..." show NaN, Infinity, undefined (not null).

## Round 3: library runners (numpy, pandas)
Goal: code that imports numpy or pandas is test-run for real instead of skipped. Everything else that is not standard
library stays "can't test-run" (amber). Non-goals: PyTorch/transformers/scipy/matplotlib (need the remote runner or are
too big), static checks of library calls, a UI for choosing libraries.
- R15 `libraries_needed(code)` returns the imported top-level packages that are on the allowlist `RUNNABLE_LIBRARIES`
  (numpy, pandas), sorted, once each. Syntax errors and notebook magics are handled like the rest (parse_code). Nothing else is returned.
- R16 `analyze(request, load_libraries)`: the loader (a JS function in the browser) is awaited once, with a JSON list of
  names, only when the code will actually be run: never when static errors were found, never when no allowlisted library is imported.
  It returns a JSON list of names that could not be loaded.
- R17 A library that could not be loaded gives a skip (amber) saying it could not be downloaded and to check the connection,
  not a code problem. A library that is not on the allowlist keeps the existing skip, and the message lists what IS available.
- R18 Real runtime errors in code that uses numpy/pandas are still reported as problems; checks run against the namespace.
- R19 Worker, loading phase: the 3 s run limit does not count download or first-import time (loading has its own 90 s limit,
  after which the worker restarts); the blocked browser APIs (fetch...) are lifted only while libraries load and are
  blocked again before the user's code runs; a failed download does not crash the worker; later checks reuse the loaded libraries.
- R20 Real Pyodide (CI only, needs internet): numpy and pandas snippets run and print correct results; a numpy error is reported;
  user code still cannot call fetch after loading.

## Round 4: AI evidence packet
Goal: one block of plain text that gives any AI everything Zapple knows, so one paste replaces several rounds. It
says what was verified, what was NOT, and which findings are facts vs hints. Non-goals: calling an AI from the page,
API keys, a backend, fix-pattern history in the packet (later), replacing the repair prompt (that stays: it is the strict "reply with only code" version).
- R21 `buildEvidencePacket({language, sourceType, task, code, errors, notes, run, callMap, untraced, extraGlobals, checksText})`
  returns text. Same input => same text (no clock, no randomness). Fixed section order: header, Verdict, Verified,
  Not verified, Problems, Notes, Console output, Call map, Checks box, Code, How to use this.
- R22 Each problem: place (line, column), message, rule id, how it was found (the same `basis` text the local log stores),
  and the source line. Notes are labelled as hints that may be wrong. Empty sections are left out (except Verdict, Verified, Not verified, Code).
- R23 Honesty: a skipped run says why; a run not attempted because of static problems says that; Checks that did not run are
  listed as not verified; calls that could not be traced are counted; the packet always says static checks cannot prove the code does what it should.
  A syntax error says that rules, structure and the test run were not reached.
- R24 Size: console output max 40 lines, call map max 60 lines, quoted source lines max 200 characters, each cut says how much was left out.
- R25 The code is shown with line numbers that match the problem list, in a fence longer than any backtick run in the code.
- R26 Task, extra names and the Checks box text appear only when present.
- R27 UI: an "Evidence packet" box after every report and syntax error with a Copy button that puts the whole text on the clipboard.
