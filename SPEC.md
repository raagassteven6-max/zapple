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
