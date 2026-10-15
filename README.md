# Zapple

**Check AI-generated JavaScript and Python before you use it.** Zapple runs in your browser, finds likely problems, and helps you send the AI a focused repair prompt instead of spending another prompt debugging one error at a time.

Zapple combines syntax validation, static analysis, structural checks, and a sandboxed test run where the code can be executed safely enough for ordinary debugging. It also provides a log and a copyable repair prompt.

> **Important:** Zapple is a debugging aid, not a proof that code is correct or a security boundary for hostile code. A passing check only means the tested checks passed in the conditions available to Zapple.

## How to use it

1. Paste the code you want to check.
2. Choose **JavaScript** or **Python**.
3. Optionally describe what the code should do and list names it is expected to use from libraries or earlier notebook cells (for example, `THREE`).
4. Tap **Check**.
5. Review the findings, call map, console output, and **Log**.
6. If Zapple finds problems, tap **Copy repair prompt** and send that prompt to your AI assistant.
7. Make the suggested changes, then check the revised code again.

For JavaScript, Zapple detects whether the code should be parsed as a script or a module based on `import`/`export` syntax. Module parsing does not mean every module can be executed in the sandbox; see the limitations below.

## What Zapple checks

Zapple runs the checks supported for the selected language. Some later stages may be skipped when the browser environment cannot verify the code.

| Stage | What it checks | JavaScript | Python |
|---|---|---:|---:|
| 1. Syntax | Invalid syntax and parse errors | Yes | Yes |
| 2. Rules | Issues such as undefined names and other static-analysis findings | ESLint browser build | Pyflakes |
| 3. Structure | Function/method calls, argument counts, selected class/constructor relationships, and a text call map | Yes | Yes |
| 4. Test run | Runtime errors, console output, timeouts, and user-written checks where supported | Web Worker sandbox | Pyodide in the browser |

### Structural checks

Zapple's structure analysis reads the syntax tree to find likely call-site problems that syntax and lint rules may not catch.

Examples include:
- Too many arguments passed to a function.
- Calls to unknown `this.method()` or `self.method()` names in supported patterns.
- Python constructor calls checked against `__init__`.
- Python calls with missing or unexpected positional/keyword arguments.
- Python mutable default values.
- A text call map that helps show how functions are connected.

Too few JavaScript arguments may be reported as a note rather than an error because omitted arguments can be intentional. Some inferred object-method relationships are uncertain and are marked with `?`.

### User-written checks

You can write simple checks for expected results, such as:

```javascript
add(2, 3) === 5
```

Zapple can evaluate these checks after the supported test run. A failed check is reported as a finding; it is not the same thing as a syntax error. Checks can only validate behavior that the sandbox can actually execute and observe.

### Findings and repair prompts

- Findings use a common format, including location and message where available.
- Zapple can report multiple rule or structure findings together.
- Minor findings, such as unused variables, may be shown on screen but omitted from the repair prompt so the AI is not asked to make unrelated cleanups.
- The **Log** records what Zapple did step by step.
- Captured console output helps show what happened during a test run.

## JavaScript sandbox

JavaScript is executed in a **Web Worker**, separate from the page's main JavaScript context.

The sandbox currently provides:
- A time limit for code execution to help detect infinite loops or code that does not finish.
- Captured `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` output.
- Runtime error reporting, with line numbers mapped back to user code when the browser's stack trace provides enough information.
- Handling for timers and delayed work, including cases where a continuing timer means Zapple cannot confidently verify a result.
- User-written checks for expected values.
- A “could not verify”/skipped result for certain unsupported browser features or environment limitations, rather than treating every limitation as a bug.

### JavaScript limitations

The sandbox is not a full browser page and does not reproduce every application environment.

- Code that depends on page objects such as `document`, `window`, `localStorage`, or `alert` generally cannot be tested as if it were running in a real page.
- `import`/`export` can affect how code is parsed, but imported dependencies are not automatically fetched and wired into the sandbox. Module code that depends on external imports may therefore not be test-runnable.
- Network and browser storage APIs are restricted in the sandbox, including `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `indexedDB`, and `caches`. Depending on the code path, Zapple may report that it cannot verify the run.
- Code that never calls a function cannot reveal that function's runtime errors during the test run.
- Browser stack traces differ, so some runtime errors may not have a reliable user-code line number.
- The sandbox is designed to help test ordinary pasted code, not to contain hostile or deliberately malicious code.

**Size limit:** pasted code over 200,000 characters (roughly 5,000 lines) is refused because very large input can freeze the page. Check a smaller section at a time.

## Python support

Python runs in the browser through [Pyodide](https://pyodide.org), a Python runtime compiled to WebAssembly.

Zapple's Python checks include:
- Python syntax parsing.
- Static analysis with Pyflakes, including undefined names and unused imports.
- Structure checks for supported function and method calls, argument counts, constructors, mutable defaults, and a text call map.
- A sandboxed test run with a time limit.
- User-written checks after the code runs, where supported.
- Console/log output and explanatory messages when a run cannot be verified.

### Python limitations

- Pyodide loads when Python is selected; the first load requires a network connection and may take time. Browser caching can make later loads faster.
- The browser runtime does not provide every package or system feature available in desktop Python.
- Code that imports packages unavailable in the browser (for example, heavy packages such as `torch` or `transformers`) may still receive syntax, rule, and structure checks, while the runtime test is skipped.
- Notebook commands such as `!pip install ...` and `%matplotlib inline` are not standard Python. Zapple replaces supported notebook-style lines with `pass` to preserve line numbering and notes this in the log.
- Names from earlier notebook cells can be listed in the **Extra names** field to avoid false undefined-name findings.
- Because the browser's Python already has an event loop, top-level `asyncio.run(...)` is handled as `await ...` where supported.
- Code that starts threads cannot run normally in this browser environment and may be marked as not test-run.
- Network access is restricted during the user's code execution. Pyodide may need network access to load before the restrictions are applied.

## Privacy, safety, and browser limits

Zapple is a static browser application; the checking flow is designed to run on the visitor's device. It does not need a Zapple application server to perform its local checks. Some libraries and the Python runtime are loaded from a CDN, so a connection is needed when they are first downloaded.

The sandbox helps prevent ordinary test code from making network requests or running indefinitely, but **it is not a security sandbox for untrusted or hostile programs**. Do not use it as a guarantee that malicious code is harmless.

Browser storage is scoped by the website origin. Sites or projects hosted under the same origin may share browser storage, so hosting Zapple at a dedicated origin is preferable if origin isolation matters.

## Dependencies

The README's current implementation uses these browser-loaded dependencies:

- [Acorn](https://github.com/acornjs/acorn) for JavaScript parsing (version 8.11.3).
- [ESLint](https://eslint.org) through `eslint-linter-browserify` (version 9.37.0).
- [Pyodide](https://pyodide.org) (version 0.26.4) and Pyflakes for Python support.

Python support loads only when selected. The first load may be around 10 MB, depending on what is cached and how the runtime is delivered.

## Automated tests

The repository includes automated JavaScript, Python, and browser sandbox tests run through GitHub Actions. The workflow installs its test dependencies and runs the checks, including the sandbox suite in Chromium.

A successful workflow means the tests in that run passed against that commit. It does not guarantee that every possible program or environment has been tested.

## Run or deploy

Zapple is a static site and does not require an application server or build step.

To deploy with GitHub Pages:

1. Open the repository's **Settings**.
2. Open **Pages**.
3. Configure deployment from the branch and folder containing the site files.
4. Save the settings and open the published site URL.

Serve the site from any compatible static host. Keep the expected app files at the location configured for your host; `index.html` is served at the site root when the repository is configured that way.

## Current capabilities and roadmap

### Available now

- [x] JavaScript syntax checks
- [x] JavaScript static analysis with ESLint
- [x] JavaScript structure checks and text call map
- [x] JavaScript sandbox execution, console capture, and runtime findings
- [x] User-written checks for expected results
- [x] Repair-prompt generation
- [x] Python syntax checks
- [x] Python static analysis with Pyflakes
- [x] Python structure checks and text call map
- [x] Python sandbox execution through Pyodide, within browser limits
- [x] GitHub Actions CI for JavaScript, Python, and Chromium sandbox tests

### Not available yet / future work

- [ ] Optional remote runner for code requiring heavy libraries such as `torch` and `transformers`
- [ ] Optional small ONNX models for routing or error classification
