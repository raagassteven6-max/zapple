# Zapple

Zapple checks AI-written JavaScript **before** you use it, entirely in your browser.

Commercial AI tools make mistakes, and every failed run costs another prompt against your rate limit.
Zapple catches those mistakes first and gives you **one** repair prompt that lists everything wrong, so the AI can fix it in a single reply.

## How to use it

1. Paste the code the AI gave you.
2. Choose **Module** (uses `import`/`export`) or **Plain script**.
3. Optionally describe what the code should do, and list names it may use from libraries you load (for example `THREE`).
4. Tap **Check**.
5. If problems are found, tap **Copy repair prompt** and send it to the AI.
6. Open the **Log** panel to see exactly what Zapple did, step by step.

## What it checks

Each stage runs only if the one before it passes.

| Stage | Question it answers | Tool |
|---|---|---|
| 1. Syntax | Is this valid JavaScript? | [acorn](https://github.com/acornjs/acorn) |
| 2. Rules | Does it use names that don't exist, reassign constants, use a variable before it is declared, contain unreachable code, and so on? All findings are reported at once. | [ESLint](https://eslint.org) (browser build) |
| 3. Test run | Does it crash when it runs? Does it loop forever? | Web Worker sandbox |

Minor findings (like unused variables) are shown on screen but left out of the repair prompt, so the AI is not asked to tidy code you didn't ask about.

## Architecture

Zapple is a static site with no server and no build step. Everything runs on the visitor's device.

```
paste code
   |
   v
[1 Syntax check]  --error-->  repair prompt (one error, with surrounding lines)
   | ok
   v
[2 Rule check]    --errors-->  repair prompt (every error, with its line)
   | ok
   v
[3 Sandbox run]   --crash-->   repair prompt (runtime error mapped to your line)
   | ok
   v
OK + console output
```

`index.html` is one file, organized in labeled sections:

| Section | Job |
|---|---|
| Environment snapshot | Records the names this browser provides (`document`, `fetch`, ...) before any library loads, so ESLint doesn't call them undefined |
| Log | Timestamped record of each step |
| Rule checks | Syntax check, ESLint rule set, finding format |
| Sandbox | Runs the code in a Web Worker and reports crashes, timeouts and console output |
| Repair prompt | Builds the prompt from any set of findings |
| Display | Turns results into screen elements (pasted code is never inserted as HTML) |
| Wiring | Connects the buttons to the flow above |

The checking and prompt-building sections contain no DOM code, so they can move into their own modules later without changes.

All stages produce the same **finding** shape (`line`, `column`, `message`, `ruleId`, `severity`), which is why one prompt builder and one results list serve every stage.

## The sandbox

Code is test-run in a Web Worker: a separate background thread with no access to the page.

- **Time limit:** 3 seconds to reach the last line. After that the worker is stopped and reported as a possible infinite loop. After the last line, Zapple waits half a second for delayed errors from timers and promises.
- **Blocked:** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `indexedDB`, and `caches`. Using one is reported as a crash.
- **Captured:** `console.log`, `info`, `warn`, `error` and `debug`, shown on screen and in the log.
- **Line numbers:** crash locations are mapped back to your code from the error's stack trace. Browsers format traces differently, so some crashes are reported without a line.

This protects against accidents such as runaway loops and stray network calls. It is not designed to contain hostile code.

### What is not test-run yet

- Code that uses the page (`document`, `window`, `localStorage`, `alert`, ...), because a worker has no page.
- Code that uses `import`.

Zapple says so when it skips a run. It also only tests what actually executes: a function that nothing calls cannot fail.

## Dependencies

Loaded from a CDN when the page opens (a connection is needed the first time):

- acorn 8.11.3
- eslint-linter-browserify 9.x (exposes the global `eslint`)

## Run or deploy

Serve the folder from any static host. On GitHub Pages: repository Settings, Pages, deploy from the branch, and open the site URL. `index.html` is served at the root.

## Roadmap

- [x] Syntax check
- [x] Repair prompt
- [x] Rule checks (ESLint)
- [x] Sandbox test run and log
- [ ] Live graph of functions and calls
- [ ] Contracts and tests
- [ ] Optional small ONNX models (routing, error classification)
- [ ] Python checks (pyflakes through Pyodide)
- [ ] Split `index.html` into modules
