"use strict";

// ============================================================================
// Zapple Core Engine: Syntax, Static Rules, Structural Analysis & Sandbox
// ============================================================================

// ---------- Checking (no DOM code here) ----------

/**
 * Parses `code` and reports whether it is valid JavaScript syntax.
 * Returns { ok: true } or { ok: false, problem: { message, line, column, sourceLine } }.
 */
function checkSyntax(code, sourceType) {
  try {
    acorn.parse(code, { ecmaVersion: "latest", sourceType, locations: true });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof SyntaxError) || !error.loc) throw error;
    return { ok: false, problem: describeProblem(error, code) };
  }
}

function describeProblem(error, code) {
  const { line, column } = error.loc;   // acorn: line starts at 1, column at 0
  return {
    // acorn appends " (line:column)" to its messages; we show the location separately
    message: error.message.replace(/\s*\(\d+:\d+\)$/, ""),
    line,
    column: column + 1,
    sourceLine: code.split("\n")[line - 1] ?? "",
  };
}

/**
 * Zapple does not ask whether JavaScript is a module or a plain script; it finds out.
 * Module is tried first because it is stricter and catches more. If Module rejects the code,
 * Plain script gets a turn. Returns { ok: true, sourceType } or { ok: false, problem }.
 */
function checkSyntaxInBothModes(code, log) {
  const asModule = checkSyntax(code, "module");
  if (asModule.ok) return { ok: true, sourceType: "module" };

  const asScript = checkSyntax(code, "script");
  if (asScript.ok) {
    log.add(`Module mode rejected the code (${asModule.problem.message}); plain script mode accepted it`);
    return { ok: true, sourceType: "script" };
  }
  return { ok: false, problem: asModule.problem };   // both refused it: report the Module error
}

// ---------- Rule checks (no DOM code here) ----------

// "error" problems are sent to the AI in the repair prompt.
// "warn" notes are shown on screen only, so the AI is not asked to tidy code you didn't ask about.
const ESLINT_RULES = {
  // Code that fails or behaves wrongly
  "no-undef": "error",
  // Using a variable before its declaration in the same scope crashes (TDZ). A function that mentions
  // a variable declared further down is fine, because it normally runs later, so variables:false.
  "no-use-before-define": ["error", { functions: false, classes: false, variables: false }],
  "no-const-assign": "error",
  "no-redeclare": ["error", { builtinGlobals: false }],
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-else-if": "error",
  "no-import-assign": "error",
  "no-unreachable": "error",
  "no-unsafe-negation": "error",
  "valid-typeof": "error",
  "use-isnan": "error",
  "getter-return": "error",
  "constructor-super": "error",
  "no-this-before-super": "error",
  // Banned patterns
  "no-eval": "error",
  // Housekeeping
  "no-unused-vars": ["warn", { vars: "local", args: "none", caughtErrors: "none" }],
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** "THREE, Chart  d3" -> ["THREE", "Chart", "d3"] (anything that isn't a valid name is dropped) */
function parseNameList(text) {
  return text.split(/[\s,]+/).filter((name) => IDENTIFIER.test(name));
}

function buildLintConfig(sourceType, extraGlobals) {
  const names = [...(typeof BROWSER_GLOBALS !== "undefined" ? BROWSER_GLOBALS : []), ...extraGlobals].filter((name) => IDENTIFIER.test(name));
  return {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType,
      globals: Object.fromEntries(names.map((name) => [name, "readonly"])),
    },
    rules: ESLINT_RULES,
  };
}

function toFinding(message) {
  return {
    line: message.line,
    column: message.column,
    message: message.message,
    ruleId: message.ruleId,
    severity: message.severity === 2 ? "error" : "note",
  };
}

/**
 * Runs the ESLint rules on code that already passed the syntax check.
 * Returns { errors, notes }, each a list of { line, column, message, ruleId, severity }.
 */
function lintCode({ code, sourceType, extraGlobals }) {
  const linter = new eslint.Linter({ configType: "flat" });
  const config = buildLintConfig(sourceType, extraGlobals);
  const findings = linter.verify(code, config, { filename: "input.js" }).map(toFinding);

  return {
    errors: findings.filter((finding) => finding.severity === "error"),
    notes: findings.filter((finding) => finding.severity === "note"),
  };
}

// ---------- Log ----------

/** A running record of what Zapple does during a check, shown in the Log panel. */
function createLog(outputElement) {
  let startedAt = performance.now();
  return {
    reset() {
      startedAt = performance.now();
      outputElement.textContent = "";
    },
    add(message) {
      const elapsed = Math.round(performance.now() - startedAt);
      outputElement.textContent += `[+${elapsed} ms] ${message}\n`;
    },
  };
}

// ---------- Sandbox: test-run the code (no DOM code here) ----------

window.RUN_TIMEOUT_MS = 3000;    // stop code that has not reached its last line by then
const SETTLE_MS = 500;          // when the code left a repeating timer running, wait this long for its errors
const QUICK_SETTLE_MS = 50;     // otherwise a short pause is enough, because everything else already finished
const MAX_TIMER_WAIT_MS = 2000; // Zapple waits for timers up to this long; a longer timer cannot be waited for
const MAX_OUTPUT_LINES = 200;

// Browser features that code under test must not use: network access and stored data.
// Both the JavaScript and the Python test areas block these same names.
const BLOCKED_BROWSER_APIS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches"];

// Names that only exist on a web page, so a worker cannot run code that uses them.
const PAGE_ONLY_NAMES = new Set(["document", "window", "localStorage", "sessionStorage", "alert", "confirm", "prompt"]);

/**
 * Runs first inside the worker (it is copied into the worker as text).
 * It captures console output, reports crashes, blocks network and storage access,
 * and provides deep structural comparison for test assertions.
 */
function workerSetup(blockedNames, maxTimerWaitMs) {
  const send = (message) => self.postMessage(message);

  const describe = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  };
  self.zappleDescribe = describe;   // used by the generated check code

  /** Deep structural comparison for checks (e.g. [1, 2] === [1, 2], { a: 1 } === { a: 1 }) */
  function deepEqual(a, b, depth = 0) {
    if (a === b) return true;
    if (depth > 20) return false;
    if (a === null || typeof a !== "object" || b === null || typeof b !== "object") {
      return Number.isNaN(a) && Number.isNaN(b);
    }
    if (a.constructor !== b.constructor) return false;
    if (a instanceof Date) return Object.is(a.getTime(), b.getTime());
    if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
    if (a instanceof Error) return a.name === b.name && a.message === b.message;
    if (a instanceof Number || a instanceof String || a instanceof Boolean) return Object.is(a.valueOf(), b.valueOf());
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i], depth + 1)) return false;
      }
      return true;
    }
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        if (!b.has(k) || !deepEqual(v, b.get(k), depth + 1)) return false;
      }
      return true;
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], depth + 1)) return false;
    }
    return true;
  }
  self.zappleDeepEqual = deepEqual;

  // Track timers so Zapple can wait for the code's delayed work (setTimeout, promises) before running checks
  const realSetTimeout = self.setTimeout.bind(self);
  const realClearTimeout = self.clearTimeout.bind(self);
  const realSetInterval = self.setInterval.bind(self);
  const realClearInterval = self.clearInterval.bind(self);
  const pendingTimers = new Map();
  const runningIntervals = new Set();
  self.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") return realSetTimeout(callback, delay, ...args);
    const wait = Math.max(0, Number(delay) || 0);
    if (wait > maxTimerWaitMs) send({ type: "long-timer" });
    const id = realSetTimeout(() => { pendingTimers.delete(id); callback(...args); }, wait);
    pendingTimers.set(id, { wait, due: Date.now() + wait });
    return id;
  };
  self.clearTimeout = (id) => { pendingTimers.delete(id); realClearTimeout(id); };
  self.setInterval = (callback, delay, ...args) => {
    const id = realSetInterval(callback, delay, ...args);
    runningIntervals.add(id);
    return id;
  };
  self.clearInterval = (id) => { runningIntervals.delete(id); realClearInterval(id); };
  const nextTurn = (milliseconds) => new Promise((resolve) => realSetTimeout(resolve, milliseconds));

  /** Waits until the code has nothing left to do: promise chains done, short timers fired. */
  self.zappleDrain = async () => {
    for (;;) {
      await nextTurn(0);   // lets promise chains and zero-delay timers finish
      const waiting = [...pendingTimers.values()].filter((timer) => timer.wait <= maxTimerWaitMs);
      if (waiting.length === 0) break;
      await nextTurn(Math.max(0, Math.min(...waiting.map((timer) => timer.due)) - Date.now()) + 5);
    }
    return {
      longTimers: [...pendingTimers.values()].filter((timer) => timer.wait > maxTimerWaitMs).length,
      intervals: runningIntervals.size,
    };
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => send({ type: "console", level, text: args.map(describe).join(" ") });
  }

  for (const name of blockedNames) {
    Object.defineProperty(self, name, {
      get() { throw new Error(`${name} is blocked in the Zapple sandbox`); },
    });
  }

  const reportError = (error, line, column) => send({
    type: "error",
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? "",
    line,
    column,
  });

  self.addEventListener("error", (event) => {
    event.preventDefault();
    reportError(event.error ?? { message: event.message }, event.lineno, event.colno);
  });
  self.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    reportError(event.reason);
  });
}

const WORKER_PREAMBLE = `(${workerSetup.toString()})(${JSON.stringify(BLOCKED_BROWSER_APIS)}, ${MAX_TIMER_WAIT_MS});`;
const PREAMBLE_LINES = WORKER_PREAMBLE.split("\n").length;   // user code starts on the next line

function buildWorkerSource(code, checks) {
  const checkSources = checks.map(buildCheckSource).join("\n");
  // The code runs first. Then Zapple waits for its delayed work (timers, promises) and only then runs the checks,
  // because a check like `total === 5` is meaningless while the code is still halfway through.
  return `${WORKER_PREAMBLE}\n${code}\nself.postMessage({ type: "reached-end" });\n`
    + `(async () => {\nconst __zap_state = await self.zappleDrain();\n${checkSources}\n`
    + `self.postMessage({ type: "finished", longTimers: __zap_state.longTimers, intervals: __zap_state.intervals });\n})();`;
}

function checkFinding(message) {
  return { line: null, column: null, message, ruleId: "check", severity: "error" };
}

/**
 * Reads the Checks box (one JavaScript expression per line).
 * Returns { checks, problems }: runnable checks, and findings for lines that are not valid expressions.
 * A check written as `a === b` keeps both sides, so a failure can report what `a` actually was.
 */
function parseChecks(text) {
  const checks = [];
  const problems = [];
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//"));

  for (const raw of lines) {
    try {
      let node = acorn.parseExpressionAt(raw, 0, { ecmaVersion: "latest", preserveParens: true });
      if (node.type === "SequenceExpression") throw new SyntaxError("write one check per line, not a comma list");
      // After the expression only whitespace, semicolons and comments may follow
      if (!/^(?:\s|;|\/\/.*|\/\*[\s\S]*?\*\/)*$/.test(raw.slice(node.end))) throw new SyntaxError("only one expression per line");
      const source = raw.slice(node.start, node.end);   // the expression only: no comment can swallow the closing brackets
      while (node.type === "ParenthesizedExpression") node = node.expression;   // (a === b) is still an equality check
      const isEquality = node.type === "BinaryExpression" && (node.operator === "===" || node.operator === "==");
      checks.push({
        source,
        operator: isEquality ? node.operator : null,
        left: isEquality ? raw.slice(node.left.start, node.left.end) : null,
        right: isEquality ? raw.slice(node.right.start, node.right.end) : null,
      });
    } catch (error) {
      problems.push(checkFinding(`Check is not a valid expression (${error.message.replace(/\s*\(\d+:\d+\)$/, "")}): ${raw}`));
    }
  }
  return { checks, problems };
}

/** Code appended to the user's code: evaluates one check and reports the result in an isolated block scope. */
function buildCheckSource({ source, left, right, operator }, index) {
  if (left !== null) {
    return `{
      try {
        const __zap_left = (${left});
        const __zap_right = (${right});
        const __zap_passed = (__zap_left ${operator === "==" ? "==" : "==="} __zap_right) || self.zappleDeepEqual(__zap_left, __zap_right);
        self.postMessage({ type: "check", index: ${index}, passed: __zap_passed, actual: self.zappleDescribe(__zap_left) });
      } catch (error) {
        self.postMessage({ type: "check", index: ${index}, passed: false, error: error.name + ": " + error.message });
      }
    }`;
  }
  return `{
    try {
      self.postMessage({ type: "check", index: ${index}, passed: Boolean((${source})) });
    } catch (error) {
      self.postMessage({ type: "check", index: ${index}, passed: false, error: error.name + ": " + error.message });
    }
  }`;
}

/** Findings for the checks that failed or crashed. */
function failedCheckFindings(results, checks) {
  return results.filter((result) => !result.passed).map((result) => {
    const outcome = result.error
      ? `crashed with ${result.error}`
      : result.actual !== undefined ? `failed (got ${result.actual})` : "failed";
    return checkFinding(`Check ${outcome}: ${checks[result.index].source}`);
  });
}

/**
 * Tells a limit of Zapple's test area apart from a bug in the code. `message` is "TypeError: x is not defined" style text.
 * Returns { name, why } when the cause is the test area (a library that is not loaded, a page-only name, blocked network),
 * or null when the code itself is at fault.
 */
function findEnvironmentLimit(message, extraGlobals = []) {
  const blocked = /(\w+) is blocked in the Zapple sandbox/.exec(message);
  if (blocked) return { name: blocked[1], why: "blocked" };
  const missing = /^ReferenceError: ([\w$]+) is not defined/.exec(message);
  if (missing) {
    const known = new Set([...extraGlobals, ...PAGE_ONLY_NAMES, ...(typeof BROWSER_GLOBALS !== "undefined" ? BROWSER_GLOBALS : [])]);
    if (known.has(missing[1])) return { name: missing[1], why: "missing" };
  }
  return null;
}

function environmentReason({ name, why }, line) {
  const where = line ? ` (it stopped at line ${line})` : "";
  return why === "blocked"
    ? `it uses "${name}", which Zapple blocks in its test area (no network or stored data)${where}, so this cannot run here even if it is correct.`
    : `it uses "${name}", which comes from a library or a web page that Zapple's test area does not have${where}, so this cannot run here even if it is correct.`;
}

const ENVIRONMENT_TIP = "Test the logic separately: paste only the functions that calculate or handle data, and use Checks on them. The syntax, rule and structure checks already ran on everything.";

/** The reason this code cannot be test-run yet, or null if it can. */
function findSkipReason(code, sourceType) {
  let tokens;
  try {
    tokens = [...acorn.tokenizer(code, { ecmaVersion: "latest", sourceType })];
  } catch {
    return null;   // not valid JavaScript: the syntax check reports that
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (token.type === acorn.tokTypes._import) {
      return {
        reason: "it uses import, which loads other files or libraries. Zapple's test area cannot load them yet, so it cannot run this code.",
        tip: "If the import is only for a helper you can copy, paste that helper into the box instead.",
      };
    }
    const afterDot = Boolean(previous)
      && (previous.type === acorn.tokTypes.dot || previous.type === acorn.tokTypes.questionDot);
    const isKeyOrLabel = Boolean(next) && next.type === acorn.tokTypes.colon;
    if (token.type === acorn.tokTypes.name && PAGE_ONLY_NAMES.has(token.value) && !afterDot && !isKeyOrLabel) {
      return {
        reason: `it uses "${token.value}", which only exists inside a web page. Zapple tests code in a separate background area that has no web page, so this line would crash there even if it is correct on your site.`,
        tip: "Test the logic separately: paste only the functions that calculate or handle data, and use Checks on them. The lines that touch the page are still covered by the syntax, rule and structure checks.",
      };
    }
  }
  return null;
}

window.FIX_FIRST = {
  reason: "the checks above found errors, and running code that is already known to be broken would only repeat the same problem.",
  tip: "Fix the errors (the repair prompt does this) and check again.",
};

function skippedRun(reason, tip) {
  return { status: "skipped", reason, tip, errors: [], output: [], durationMs: 0, checkCount: 0 };
}

function runtimeFinding(message, line = null, column = null) {
  return { line, column, message, ruleId: "runtime", severity: "error" };
}

/** Line/column pairs found in an error's stack trace, in the order they appear. */
function framesFromStack(stack) {
  return [...stack.matchAll(/blob:\S*?:(\d+):(\d+)/g)]
    .map(([, line, column]) => ({ line: Number(line), column: Number(column) }));
}

/** Turns a crash report from the worker into a finding, with the line mapped back to the user's code. */
function toRuntimeFinding({ name, message, stack, line, column }) {
  const frames = [...(line ? [{ line, column }] : []), ...framesFromStack(stack)];
  const frame = frames.find((candidate) => candidate.line > PREAMBLE_LINES);
  const text = `${name}: ${message}`;
  return frame ? runtimeFinding(text, frame.line - PREAMBLE_LINES, frame.column) : runtimeFinding(text);
}

/**
 * Runs `code` in a Web Worker and reports what happened.
 * Resolves with { status, errors, output, durationMs, reason? }.
 * status: "finished" | "crashed" | "timeout" | "skipped"
 * "skipped" means Zapple could not verify the code because of a limit of its own test area, which is never reported as a problem.
 */
function runInSandbox({ code, sourceType, checksText, extraGlobals = [], log }) {
  const skip = findSkipReason(code, sourceType);
  if (skip) return Promise.resolve(skippedRun(skip.reason, skip.tip));
  const parsedChecks = parseChecks(checksText);

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const output = [];
    const errors = [...parsedChecks.problems];
    const checkResults = [];
    const url = URL.createObjectURL(new Blob([buildWorkerSource(code, parsedChecks.checks)], { type: "text/javascript" }));
    const worker = new Worker(url, { type: sourceType === "module" ? "module" : "classic" });
    let timeoutTimer = null;
    let settleTimer = null;
    let reachedEnd = false;
    let sawLongTimer = false;
    let done = false;

    function finish(status, extra = {}) {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      clearTimeout(settleTimer);
      worker.terminate();
      URL.revokeObjectURL(url);
      const durationMs = Math.round(performance.now() - startedAt);
      log.add(`Sandbox result: ${status} (${durationMs} ms)`);
      resolve({ status, errors, output, durationMs, checkCount: parsedChecks.checks.length, ...extra });
    }

    /** Ends the run as "could not verify" instead of reporting a problem the code does not have. */
    function giveUp(reason, tip = ENVIRONMENT_TIP) {
      log.add(`Cannot verify: ${reason}`);
      finish("skipped", { errors: [], reason, tip });
    }

    function recordCrash(finding) {
      const limit = findEnvironmentLimit(finding.message, extraGlobals);
      if (limit) return giveUp(environmentReason(limit, finding.line));
      errors.push(finding);
      log.add(`Crash: ${finding.message}${finding.line ? ` (line ${finding.line})` : ""}`);
      finish("crashed");
    }

    function finishAfterChecks({ longTimers = 0, intervals = 0 }) {
      const unverifiable = checkResults.map((result) => result.error && findEnvironmentLimit(result.error, extraGlobals)).find(Boolean);
      if (unverifiable) return giveUp(`a check ${environmentReason(unverifiable)}`);
      const failures = failedCheckFindings(checkResults, parsedChecks.checks);
      if ((longTimers > 0 || intervals > 0) && failures.length > 0) {
        return giveUp(`the code still has a timer running that Zapple cannot wait for (longer than ${MAX_TIMER_WAIT_MS / 1000} seconds, or repeating), so it cannot tell whether the failed check would pass once it fires.`,
          "Shorten the delay in the code you paste, or test the function that runs after the timer by itself.");
      }
      errors.push(...failures);
      finish("finished");
    }

    worker.onmessage = ({ data }) => {
      if (data.type === "console" && output.length < MAX_OUTPUT_LINES) {
        output.push(data.level === "log" ? data.text : `[${data.level}] ${data.text}`);
        log.add(`console.${data.level}: ${data.text}`);
      } else if (data.type === "error") {
        recordCrash(toRuntimeFinding(data));
      } else if (data.type === "check") {
        checkResults.push(data);
        log.add(`Check ${data.passed ? "passed" : "failed"}: ${parsedChecks.checks[data.index].source}`);
      } else if (data.type === "long-timer") {
        sawLongTimer = true;
      } else if (data.type === "reached-end") {
        reachedEnd = true;
        log.add("Code reached its last line; waiting for timers and promises to finish");
      } else if (data.type === "finished") {
        clearTimeout(timeoutTimer);
        // A repeating timer may still fail later, so give it a little longer to do so
        const settle = data.intervals > 0 ? SETTLE_MS : QUICK_SETTLE_MS;
        log.add(data.intervals > 0 ? "A repeating timer is still running; watching it briefly for errors" : "All delayed work finished");
        settleTimer = setTimeout(() => finishAfterChecks(data), settle);
      }
    };

    worker.onerror = (event) => {
      event.preventDefault();
      recordCrash(runtimeFinding(`The sandbox could not run the code: ${event.message || "unknown error"}`));
    };

    timeoutTimer = setTimeout(() => {
      if (reachedEnd) {
        // The code itself finished; it is only still scheduling timers. That is how animations and polling work, not a bug.
        return giveUp(`the code keeps scheduling timers for longer than ${RUN_TIMEOUT_MS / 1000} seconds (polling or an animation), so Zapple cannot wait for it to finish.`,
          "Test the functions that do the work separately, with Checks.");
      }
      if (sawLongTimer) {
        return giveUp(`the code waits on a timer longer than ${MAX_TIMER_WAIT_MS / 1000} seconds before it finishes, which is more than Zapple waits.`,
          "Shorten the delay in the code you paste, or test the functions that do the work separately, with Checks.");
      }
      errors.push(runtimeFinding(
        `The code did not finish within ${RUN_TIMEOUT_MS / 1000} seconds (possible infinite loop or endless wait)`
      ));
      log.add("Timeout: the code did not reach its last line");
      finish("timeout");
    }, RUN_TIMEOUT_MS);

    log.add(`Sandbox started (limit ${RUN_TIMEOUT_MS / 1000} s)`);
  });
}

// ---------- Structure checks and call map (no DOM code here) ----------

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const isFunction = (node) => Boolean(node) && FUNCTION_TYPES.has(node.type);
const isClass = (node) => node.type === "ClassDeclaration" || node.type === "ClassExpression";

/** Visits every node in the syntax tree. The visitor has `enter(node)` and `leave(node)`. */
function walkTree(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor.enter(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child.type === "string") walkTree(child, visitor);
    }
  }
  visitor.leave(node);
}

/**
 * How many arguments a function accepts.
 * Required parameters are positional parameters up to the last parameter without a default/rest.
 */
function argumentRange(fn) {
  let lastRequiredIdx = -1;
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    if (p.type !== "AssignmentPattern" && p.type !== "RestElement") {
      lastRequiredIdx = i;
    }
  }
  const min = lastRequiredIdx + 1;
  const hasRest = fn.params.some((p) => p.type === "RestElement");
  return { min, max: hasRest ? Infinity : fn.params.length };
}

/** The variable at the root of `a.b[c].d`, or null when the chain does not start at a plain name. */
function rootName(node) {
  let current = node;
  while (current && current.type === "MemberExpression") current = current.object;
  return current?.type === "Identifier" ? current.name : null;
}

/** Every plain name an assignment target writes to, including destructuring and members (`q.x = 1` writes to q). */
function writtenNames(target, names = new Set()) {
  if (!target) return names;
  if (target.type === "Identifier") names.add(target.name);
  else if (target.type === "MemberExpression") { const root = rootName(target); if (root) names.add(root); }
  else if (target.type === "AssignmentPattern") writtenNames(target.left, names);
  else if (target.type === "RestElement") writtenNames(target.argument, names);
  else if (target.type === "ArrayPattern") target.elements.forEach((element) => writtenNames(element, names));
  else if (target.type === "ObjectPattern") target.properties.forEach((property) => writtenNames(property.value ?? property.argument, names));
  return names;
}

/**
 * Names an expression reads (used for loop invariant checking). Property names after a dot are not variables,
 * so `queue.length` reads only `queue`.
 */
function collectIdentifiers(node) {
  const names = new Set();
  (function visit(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Identifier") { if (n.name !== "Math" && n.name !== "console") names.add(n.name); return; }
    if (n.type === "MemberExpression") { visit(n.object); if (n.computed) visit(n.property); return; }
    if (n.type === "Property") { if (n.computed) visit(n.key); visit(n.value); return; }
    for (const value of Object.values(n)) {
      for (const child of Array.isArray(value) ? value : [value]) visit(child);
    }
  })(node);
  return names;
}

/** True when running `node` could change state Zapple cannot see: any call, await or yield except console.* and Math.*. */
function hasOpaqueEffects(node) {
  let found = false;
  walkTree(node, {
    enter(n) {
      if (n.type === "AwaitExpression" || n.type === "YieldExpression" || n.type === "NewExpression" || n.type === "TaggedTemplateExpression") found = true;
      if (n.type === "CallExpression") {
        const harmless = n.callee.type === "MemberExpression" && n.callee.object.type === "Identifier"
          && (n.callee.object.name === "console" || (n.callee.object.name === "Math" && n.callee.property.name !== "random"));
        if (!harmless) found = true;
      }
    },
    leave() {},
  });
  return found;
}

/** True when an expression itself assigns something (`while ((m = re.exec(s)))`), so its value changes by itself. */
function containsAssignment(node) {
  let found = false;
  walkTree(node, { enter(n) { if (n.type === "AssignmentExpression" || n.type === "UpdateExpression") found = true; }, leave() {} });
  return found;
}

/**
 * Checks if any of the given variable names could change inside a block. Anything Zapple cannot see through
 * (a call to another function, a method on the variable, a member write, a destructuring write) counts as a
 * possible change, because a loop is only called infinite here when nothing at all could end it.
 */
function bodyModifiesAny(bodyNode, varNames) {
  let modified = hasOpaqueEffects(bodyNode);
  let hasExit = false;

  walkTree(bodyNode, {
    enter(n) {
      if (n.type === "AssignmentExpression") {
        for (const name of writtenNames(n.left)) if (varNames.has(name)) modified = true;
      } else if (n.type === "UpdateExpression") {
        for (const name of writtenNames(n.argument)) if (varNames.has(name)) modified = true;
      } else if (n.type === "UnaryExpression" && n.operator === "delete") {
        for (const name of writtenNames(n.argument)) if (varNames.has(name)) modified = true;
      } else if ((n.type === "ForInStatement" || n.type === "ForOfStatement") && n.left.type !== "VariableDeclaration") {
        for (const name of writtenNames(n.left)) if (varNames.has(name)) modified = true;
      } else if (n.type === "BreakStatement" || n.type === "ReturnStatement" || n.type === "ThrowStatement") {
        hasExit = true;
      }
    },
    leave() {},
  });

  return { modified, hasExit };
}

// ---------- Built-in member typos (Math.flor, "abc".toUppercase()) ----------

// Newer built-ins that an older checking browser may not have yet. Never reported, because they are real.
const NEWER_BUILT_IN_MEMBERS = new Set([
  "groupBy", "withResolvers", "fromAsync", "try", "isError", "union", "intersection", "difference", "symmetricDifference",
  "isSubsetOf", "isSupersetOf", "isDisjointFrom", "toSorted", "toReversed", "toSpliced", "with", "at", "findLast",
  "findLastIndex", "flat", "flatMap", "replaceAll", "isWellFormed", "toWellFormed", "hasOwn", "sumPrecise", "f16round",
  "dispose", "asyncDispose", "metadata", "getOrInsert", "getOrInsertComputed", "toBase64", "fromBase64", "toHex", "fromHex", "trimStart", "trimEnd", "matchAll", "fromEntries", "allSettled", "any",
]);
const BUILT_IN_NAMESPACES = ["Math", "JSON", "Object", "Array", "Number", "String", "Promise", "Symbol", "Date", "Boolean"];
const INSTANCE_PROTOTYPES = { Array, String, Number, Map, Set };

function namesOf(object) {
  const names = new Set();
  for (let current = object; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    Object.getOwnPropertyNames(current).forEach((name) => names.add(name));
  }
  Object.getOwnPropertyNames(Object.prototype).forEach((name) => names.add(name));
  return names;
}

const NAMESPACE_MEMBERS = new Map(BUILT_IN_NAMESPACES.map((name) => [name, namesOf(globalThis[name])]));
const INSTANCE_MEMBERS = new Map(Object.entries(INSTANCE_PROTOTYPES).map(([name, type]) => [name, new Set([...namesOf(type.prototype), "length"])]));

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** The closest real name to a misspelt one, or null when nothing is close. */
function closestName(wrong, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate.startsWith("__") || candidate === "constructor") continue;
    const distance = candidate.toLowerCase() === wrong.toLowerCase() ? 0 : editDistance(wrong, candidate);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return bestDistance <= 2 && bestDistance < wrong.length ? best : null;
}

/** What type a literal expression is, for the few types Zapple knows the members of. */
function literalType(node, structure) {
  if (!node) return null;
  if (node.type === "ArrayExpression") return "Array";
  if (node.type === "TemplateLiteral" || (node.type === "Literal" && typeof node.value === "string")) return "String";
  if (node.type === "NewExpression" && node.callee.type === "Identifier" && (node.callee.name === "Map" || node.callee.name === "Set")
      && !structure.declared.has(node.callee.name)) return node.callee.name;
  return null;
}

/**
 * Reads the code's structure without running it: which functions exist (including functions
 * inside object literals, listed as "service.greet"), which classes have which methods, and
 * who calls whom. Assumes the code already passed the syntax check.
 */
function analyzeStructure(code, sourceType) {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType, locations: true });
  const structure = {
    functions: new Map(),        // name or "service.greet" -> { min, max } arguments accepted
    functionCount: new Map(),    // how many times each name was defined; a name defined twice is ambiguous
    asyncFunctions: new Set(),   // names of functions declared async
    calls: [],                   // direct calls to plain names
    methodCalls: [],             // this.method() calls
    memberCalls: [],             // obj.method() calls where obj is a plain name
    superCalls: [],              // super.method() calls
    newCalls: [],                // new X() calls
    otherCalls: [],              // calls that can only be traced by guessing
    unawaitedCalls: [],          // candidates: async functions called and dereferenced (judged in findStructureProblems)
    builtInTypos: [],            // Math.flor, "abc".toUppercase(): members that do not exist on a built-in
    loopInvariants: [],          // while loops whose conditions are never mutated
    loopShadowing: [],           // nested loops that reuse the same index variable
    classes: new Map(),          // class name -> { name, members, hasParent, parentName }
    aliases: new Map(),          // alias -> { kind: "name", target } or { kind: "member", object, method }
    shorthandTargets: new Map(), // "obj.method" written as shorthand { method } -> the outer function name
    objectMembers: new Map(),    // object literal name -> Set of member names it has
    declared: new Set(),         // every name this code declares itself
    nameCounts: new Map(),       // how often each name appears anywhere in the code
    exported: new Set(),         // names exported from a module
    callOwners: new Set(),       // owners whose body contains at least one call of any kind
  };
  const bindingCounts = new Map();      // how many times each name is declared (a name declared twice is never guessed about)
  const literalTypes = new Map();       // name -> type when declared with a literal (const names = [])
  const writtenTo = new Set();          // names that are assigned or mutated somewhere
  const memberUses = [];                // obj.member reads and calls, judged after the whole code was read
  const quietMembers = new Set();       // member expressions that are tested for, assigned or deleted: never reported
  const testedNames = new Set();        // member names that are tested for or written as text anywhere (feature detection)
  const assignedMembers = new Set();    // "String.alphabet": members the code adds itself, so they are real
  const calledMembers = new Set();      // member expressions that are the callee of a call

  const owners = [];
  const classes = [];
  const objects = [];
  const loopVars = [];
  const currentClass = () => classes.at(-1);
  const currentObject = () => objects.at(-1);
  const currentOwner = () => owners.at(-1) ?? "(top level)";
  const whereOf = (node) => ({ line: node.loc.start.line, column: node.loc.start.column + 1, owner: currentOwner() });

  function ownerOf(node) {
    if (node.type === "FunctionDeclaration") return node.id?.name ?? null;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isFunction(node.init)) return node.id.name;
    if (node.type === "MethodDefinition" && !node.computed && node.key.type === "Identifier") {
      return `${currentClass()?.name}.${node.key.name}`;
    }
    return objectMethodName(node);
  }

  function objectMethodName(node) {
    const isNamedFunction = node.type === "Property" && isFunction(node.value) && !node.computed && node.key.type === "Identifier";
    return isNamedFunction && currentObject() ? `${currentObject()}.${node.key.name}` : null;
  }

  function objectNameOf(node) {
    const isObject = node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init?.type === "ObjectExpression";
    return isObject ? node.id.name : null;
  }

  function defineFunction(node) {
    let name = null;
    if (node.type === "FunctionDeclaration" && node.id) {
      name = node.id.name;
    } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isFunction(node.init)) {
      name = node.id.name;
    } else if (objectMethodName(node)) {
      name = objectMethodName(node);
    }
    if (!name) return;
    structure.functionCount.set(name, (structure.functionCount.get(name) ?? 0) + 1);
    const fn = node.init ?? node.value ?? node;
    structure.functions.set(name, argumentRange(fn));
    if (fn.async && !fn.generator) {
      structure.asyncFunctions.add(name);
    }
  }

  function noteObjectMember(node) {
    if (node.type !== "Property" || node.computed || node.key.type !== "Identifier" || !currentObject()) return;
    const object = currentObject();
    if (!structure.objectMembers.has(object)) structure.objectMembers.set(object, new Set());
    structure.objectMembers.get(object).add(node.key.name);
    if (node.shorthand && node.value.type === "Identifier") {
      structure.shorthandTargets.set(`${object}.${node.key.name}`, node.value.name);
    }
  }

  function noteDeclarations(node) {
    const declare = (pattern) => {
      if (!pattern) return;
      if (pattern.type === "Identifier") { structure.declared.add(pattern.name); bindingCounts.set(pattern.name, (bindingCounts.get(pattern.name) ?? 0) + 1); }
      else if (pattern.type === "AssignmentPattern") declare(pattern.left);
      else if (pattern.type === "RestElement") declare(pattern.argument);
      else if (pattern.type === "ArrayPattern") pattern.elements.forEach(declare);
      else if (pattern.type === "ObjectPattern") pattern.properties.forEach((property) => declare(property.value ?? property.argument));
    };

    if (node.type === "VariableDeclarator") {
      declare(node.id);
      if (node.id.type === "Identifier") literalTypes.set(node.id.name, literalType(node.init, structure));
    }
    else if (node.type === "ClassDeclaration" && node.id) declare(node.id);
    else if (node.type === "CatchClause") declare(node.param);
    else if (node.type.startsWith("Import") && node.local) structure.declared.add(node.local.name);
    else if (isFunction(node)) {
      declare(node.id);
      node.params.forEach(declare);
    }
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declarator of node.declarations) {
        if (declarator.id.type !== "Identifier" || !declarator.init) continue;
        if (declarator.init.type === "Identifier") {
          structure.aliases.set(declarator.id.name, { kind: "name", target: declarator.init.name });
        } else if (declarator.init.type === "MemberExpression" && declarator.init.object.type === "Identifier"
            && !declarator.init.computed && declarator.init.property.type === "Identifier") {
          structure.aliases.set(declarator.id.name, {
            kind: "member", object: declarator.init.object.name, method: declarator.init.property.name,
          });
        }
      }
    }
  }

  function rememberThisAssignment({ left }) {
    const isThisProperty = left.type === "MemberExpression" && left.object.type === "ThisExpression"
      && !left.computed && left.property.type === "Identifier";
    if (isThisProperty) currentClass()?.members.add(left.property.name);
  }

  function recordCall(node) {
    const { callee } = node;
    const where = whereOf(node);
    structure.callOwners.add(where.owner);

    for (const argument of node.arguments) {
      if (argument.type === "Identifier") structure.otherCalls.push({ ...where, kind: "passed", name: argument.name });
    }

    if (callee.type === "Identifier") {
      const hasSpread = node.arguments.some((argument) => argument.type === "SpreadElement");
      structure.calls.push({ ...where, name: callee.name, argCount: node.arguments.length, hasSpread });
    } else if (callee.type === "MemberExpression") {
      recordMemberCall(callee, where, node);
    }
  }

  function recordMemberCall(callee, where, node) {
    const method = !callee.computed && callee.property.type === "Identifier" ? callee.property.name : null;
    const argCount = node.arguments.length;
    const hasSpread = node.arguments.some((argument) => argument.type === "SpreadElement");

    if (callee.object.type === "ThisExpression" && method && currentClass()) {
      structure.methodCalls.push({ ...where, cls: currentClass(), method, argCount, hasSpread });
    } else if (callee.object.type === "Super" && method && currentClass()) {
      structure.superCalls.push({ ...where, cls: currentClass(), method, argCount, hasSpread });
    } else if (callee.object.type === "Identifier" && method) {
      structure.memberCalls.push({ ...where, object: callee.object.name, method, argCount, hasSpread });
    } else {
      structure.otherCalls.push({ ...where, kind: "dynamic", text: method ? `….${method}()` : "[…]()" });
    }
  }

  function noteMemberUse(node) {
    const quiet = (member) => {
      quietMembers.add(member);
      if (member?.type === "MemberExpression" && !member.computed && member.property.type === "Identifier") testedNames.add(member.property.name);
    };
    if (node.type === "Literal" && typeof node.value === "string") testedNames.add(node.value);
    if (node.type === "UnaryExpression" && (node.operator === "typeof" || node.operator === "delete" || node.operator === "!")) quiet(node.argument);
    else if (node.type === "LogicalExpression") { quiet(node.left); quiet(node.right); }
    else if (node.type === "IfStatement" || node.type === "ConditionalExpression") quiet(node.test);
    else if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") quiet(node.left ?? node.argument);
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      if (node.optional) quiet(node.callee); else calledMembers.add(node.callee);
    }

    if (node.type === "AssignmentExpression") {
      writtenNames(node.left).forEach((name) => writtenTo.add(name));
      if (node.left.type === "MemberExpression" && !node.left.computed && node.left.property.type === "Identifier") assignedMembers.add(node.left.property.name);
    }
    else if (node.type === "UpdateExpression") writtenNames(node.argument).forEach((name) => writtenTo.add(name));
    else if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      if (node.left.type !== "VariableDeclaration") writtenNames(node.left).forEach((name) => writtenTo.add(name));
    }

    if (node.type === "MemberExpression" && !node.optional && !node.computed && node.property.type === "Identifier" && !quietMembers.has(node)) {
      memberUses.push({
        ...whereOf(node), node, property: node.property.name, called: calledMembers.has(node),
      });
    }

    // Candidate for "async function result used without await"; judged later, once every function is known
    if (node.type === "MemberExpression" && node.object.type === "CallExpression" && node.object.callee.type === "Identifier") {
      const property = !node.computed && node.property.type === "Identifier" ? node.property.name : "[property]";
      structure.unawaitedCalls.push({ ...whereOf(node), name: node.object.callee.name, property });
    }
  }

  function judgeMemberUses() {
    for (const use of memberUses) {
      const { object } = use.node;
      let members = null;
      let label = null;
      let typeLabel = null;
      if (object.type === "Identifier") {
        const name = object.name;
        if (NAMESPACE_MEMBERS.has(name) && !structure.declared.has(name)) {
          members = NAMESPACE_MEMBERS.get(name); label = name; typeLabel = `JavaScript's ${name}`;
        } else if ((bindingCounts.get(name) ?? 0) === 1 && !writtenTo.has(name) && literalTypes.get(name)) {
          const type = literalTypes.get(name);
          members = INSTANCE_MEMBERS.get(type); label = name; typeLabel = `${/^[AEIOU]/.test(type) ? "an" : "a"} ${type}`;
        }
      } else if (object.type === "ArrayExpression") {
        members = INSTANCE_MEMBERS.get("Array"); label = "[…]"; typeLabel = "an Array";
      } else if (object.type === "Literal" && typeof object.value === "string") {
        members = INSTANCE_MEMBERS.get("String"); label = JSON.stringify(object.value); typeLabel = "a String";
      } else if (object.type === "TemplateLiteral") {
        members = INSTANCE_MEMBERS.get("String"); label = "`…`"; typeLabel = "a String";
      }
      if (!members || members.has(use.property) || NEWER_BUILT_IN_MEMBERS.has(use.property) || assignedMembers.has(use.property) || testedNames.has(use.property)) continue;
      structure.builtInTypos.push({
        line: use.line, column: use.column, owner: use.owner, text: `${label}.${use.property}`,
        property: use.property, typeLabel, called: use.called,
        suggestion: closestName(use.property, members) && (typeLabel.startsWith("JavaScript's") ? `${label}.` : "") + closestName(use.property, members),
      });
    }
  }

  function recordExports({ declaration, specifiers = [] }) {
    const names = [
      declaration?.id?.name,
      declaration?.name,
      ...(declaration?.declarations ?? []).map((declarator) => declarator.id.name),
      ...specifiers.map((specifier) => specifier.local.name),
    ];
    names.filter(Boolean).forEach((name) => structure.exported.add(name));
  }

  walkTree(ast, {
    enter(node) {
      if (node.type === "Identifier") {
        structure.nameCounts.set(node.name, (structure.nameCounts.get(node.name) ?? 0) + 1);
      } else if (isClass(node)) {
        const info = {
          name: node.id?.name ?? "(anonymous class)", members: new Set(), hasParent: Boolean(node.superClass),
          parentName: node.superClass?.type === "Identifier" ? node.superClass.name : null,
        };
        classes.push(info);
        if (node.id) structure.classes.set(info.name, info);
      } else if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
        if (!node.computed && node.key.type === "Identifier") currentClass()?.members.add(node.key.name);
      } else if (node.type === "AssignmentExpression") {
        rememberThisAssignment(node);
      } else if (node.type === "CallExpression") {
        recordCall(node);
      } else if (node.type === "NewExpression" && node.callee.type === "Identifier") {
        structure.newCalls.push({ ...whereOf(node), name: node.callee.name });
        structure.callOwners.add(currentOwner());
      } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
        recordExports(node);
      }

      // Check loop invariants in while loops (e.g. while (low <= high))
      if (node.type === "WhileStatement" && node.test && node.body) {
        const testVars = collectIdentifiers(node.test);
        if (testVars.size > 0 && !hasOpaqueEffects(node.test) && !containsAssignment(node.test)) {
          const { modified, hasExit } = bodyModifiesAny(node.body, testVars);
          if (!modified && !hasExit) {
            structure.loopInvariants.push({
              ...whereOf(node),
              vars: [...testVars],
            });
          }
        }
      }

      // Check loop counter shadowing in nested for loops
      if (node.type === "ForStatement" && node.init && node.init.type === "VariableDeclaration") {
        for (const decl of node.init.declarations) {
          if (decl.id.type === "Identifier") {
            const varName = decl.id.name;
            if (loopVars.includes(varName)) {
              structure.loopShadowing.push({
                ...whereOf(node),
                name: varName,
              });
            }
            loopVars.push(varName);
          }
        }
      }

      noteMemberUse(node);
      noteDeclarations(node);
      defineFunction(node);
      noteObjectMember(node);
      const objectName = objectNameOf(node);
      if (objectName) objects.push(objectName);
      const owner = ownerOf(node);
      if (owner) owners.push(owner);
    },
    leave(node) {
      if (node.type === "ForStatement" && node.init?.type === "VariableDeclaration") {
        for (const decl of node.init.declarations) {
          if (decl.id.type === "Identifier") loopVars.pop();
        }
      }
      if (ownerOf(node)) owners.pop();
      if (objectNameOf(node)) objects.pop();
      if (isClass(node)) classes.pop();
    },
  });

  judgeMemberUses();
  structure.bindingCounts = bindingCounts;
  return structure;
}

/** "1 argument" / "2 arguments" — shared wording for the argument-count findings. */
function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function structureFinding(call, message, ruleId, severity) {
  return { line: call.line, column: call.column, message, ruleId, severity };
}

function resolveAliasTarget(aliases, name) {
  const alias = aliases.get(name);
  if (!alias) return null;
  return alias.kind === "name" ? alias.target : `${alias.object}.${alias.method}`;
}

/**
 * Suspicious calls found without running anything.
 */
function findStructureProblems({
  functions,
  functionCount,
  calls,
  memberCalls,
  methodCalls,
  aliases,
  shorthandTargets,
  nameCounts,
  loopInvariants = [],
  loopShadowing = [],
  unawaitedCalls = [],
  asyncFunctions = new Set(),
  bindingCounts = new Map(),
  builtInTypos = [],
}) {
  const errors = [];
  const notes = [];
  const usesArguments = nameCounts.has("arguments");

  for (const call of calls) {
    const aliased = resolveAliasTarget(aliases, call.name);
    const known = functions.get(call.name) ?? (aliased ? functions.get(aliased) : undefined);
    const ambiguous = (functionCount.get(call.name) ?? 1) > 1
      || (aliased && (functionCount.get(aliased) ?? 1) > 1);
    if (!known || ambiguous || call.hasSpread || usesArguments) continue;
    const given = countLabel(call.argCount, "argument");
    const label = aliased ? `${call.name}() (alias for ${aliased}())` : `${call.name}()`;

    if (call.argCount > known.max) {
      errors.push(structureFinding(call, `${label} is called with ${given} but accepts only ${known.max}`, "zapple/too-many-arguments", "error"));
    } else if (call.argCount < known.min) {
      notes.push(structureFinding(call, `${label} is called with ${given} but expects at least ${known.min}`, "zapple/too-few-arguments", "note"));
    }
  }

  for (const call of memberCalls) {
    const key = `${call.object}.${call.method}`;
    let known = functions.get(key);
    let label = `${key}()`;
    if (!known) {
      const shorthand = shorthandTargets.get(key);
      if (shorthand && functions.has(shorthand)) {
        known = functions.get(shorthand);
        label = `${key}() (shorthand for ${shorthand}())`;
      }
    }
    if (!known || (functionCount.get(key) ?? 1) > 1 || call.hasSpread || usesArguments) continue;
    const given = countLabel(call.argCount, "argument");

    if (call.argCount > known.max) {
      errors.push(structureFinding(call, `${label} is called with ${given} but accepts only ${known.max}`, "zapple/too-many-arguments", "error"));
    } else if (call.argCount < known.min) {
      notes.push(structureFinding(call, `${label} is called with ${given} but expects at least ${known.min}`, "zapple/too-few-arguments", "note"));
    }
  }

  for (const call of methodCalls) {
    if (call.cls.hasParent || call.cls.members.has(call.method)) continue;
    errors.push(structureFinding(call, `this.${call.method}() is called, but ${call.cls.name} has no method or property "${call.method}"`, "zapple/unknown-method", "error"));
  }

  for (const loop of loopInvariants) {
    errors.push(structureFinding(
      loop,
      `While loop condition depends on "${loop.vars.join(', ')}", but none of these variables are modified in the loop body (likely infinite loop)`,
      "zapple/unmodified-loop-condition",
      "error"
    ));
  }

  for (const item of loopShadowing) {
    notes.push(structureFinding(
      item,
      `Loop variable "${item.name}" shadows an outer loop variable with the same name. This can cause early termination or skipped iterations.`,
      "zapple/loop-variable-shadowing",
      "note"
    ));
  }

  const PROMISE_METHODS = new Set(["then", "catch", "finally"]);
  for (const item of unawaitedCalls) {
    if (PROMISE_METHODS.has(item.property) || !asyncFunctions.has(item.name) || (functionCount.get(item.name) ?? 1) > 1 || (bindingCounts.get(item.name) ?? 1) > 1) continue;
    errors.push(structureFinding(
      item,
      `"${item.name}()" is an async function that returns a Promise. Accessing ".${item.property}" without "await" will read from the Promise object, resulting in undefined.`,
      "zapple/unawaited-async",
      "error"
    ));
  }

  for (const typo of builtInTypos) {
    const hint = typo.suggestion ? ` Did you mean ${typo.suggestion}?` : "";
    errors.push(structureFinding(
      typo,
      `${typo.text}${typo.called ? "()" : ""} does not exist: ${typo.typeLabel} has no "${typo.property}".${hint}`,
      "zapple/unknown-builtin-member",
      "error"
    ));
  }

  return { errors, notes };
}

const BUILT_IN_METHODS = new Set(
  [Array, String, Object, Map, Set, Promise, Function, Number, Date, RegExp]
    .flatMap((type) => Object.getOwnPropertyNames(type.prototype))
);

const NOT_FOLLOWED_WHY = {
  variable: "called through a variable that is not a function declared here",
  member: "called through an object, and Zapple could not tell which function that is",
  dynamic: "called through an expression Zapple cannot read",
  super: "the parent class is not in this code",
};

function buildCallMap(structure) {
  const { functions, calls, methodCalls, memberCalls, superCalls, newCalls, otherCalls, classes, aliases,
    shorthandTargets, declared, nameCounts, exported, callOwners } = structure;
  const byOwner = new Map();
  const entryFor = (owner) => {
    if (!byOwner.has(owner)) byOwner.set(owner, { followed: new Set(), guessed: new Set(), builtIn: new Set(), notFollowed: [] });
    return byOwner.get(owner);
  };
  const notFollowed = (call, text, why) => entryFor(call.owner).notFollowed.push({ text, why: NOT_FOLLOWED_WHY[why], line: call.line });

  const onlyClassWith = (method) => {
    const owners = [...classes.values()].filter((info) => info.members.has(method));
    return owners.length === 1 ? owners[0].name : null;
  };

  for (const call of calls) {
    const aliased = resolveAliasTarget(aliases, call.name);
    if (functions.has(call.name)) entryFor(call.owner).followed.add(call.name);
    else if (aliased && functions.has(aliased)) entryFor(call.owner).followed.add(`${aliased} (through ${call.name})`);
    else if (declared.has(call.name)) notFollowed(call, `${call.name}()`, "variable");
    else entryFor(call.owner).builtIn.add(`${call.name}()`);
  }

  for (const call of methodCalls) entryFor(call.owner).followed.add(`this.${call.method}`);

  for (const call of memberCalls) {
    const key = `${call.object}.${call.method}`;
    const entry = entryFor(call.owner);
    const shorthand = shorthandTargets.get(key);
    if (functions.has(key)) entry.followed.add(key);
    else if (shorthand && functions.has(shorthand)) entry.guessed.add(`${shorthand}? (through ${key})`);
    else if (!declared.has(call.object) || BUILT_IN_METHODS.has(call.method)) entry.builtIn.add(`${key}()`);
    else {
      const guess = onlyClassWith(call.method);
      if (guess) entry.guessed.add(`${guess}.${call.method}?`);
      else notFollowed(call, `${key}()`, "member");
    }
  }

  for (const call of superCalls) {
    const parent = classes.get(call.cls.parentName);
    if (parent?.members.has(call.method)) entryFor(call.owner).followed.add(`${parent.name}.${call.method}`);
    else notFollowed(call, `super.${call.method}()`, "super");
  }

  for (const call of newCalls) {
    const entry = entryFor(call.owner);
    if (classes.has(call.name) || functions.has(call.name)) entry.followed.add(`new ${call.name}`);
    else if (!declared.has(call.name)) entry.builtIn.add(`new ${call.name}`);
  }

  for (const call of otherCalls) {
    const entry = entryFor(call.owner);
    if (call.kind === "passed") {
      if (functions.has(call.name)) entry.followed.add(`${call.name} (passed along)`);
    } else {
      notFollowed(call, call.text, "dynamic");
    }
  }

  const usedShortNames = new Set();
  for (const call of calls) usedShortNames.add(call.name);
  for (const call of memberCalls) { usedShortNames.add(call.method); usedShortNames.add(call.object); }
  for (const call of methodCalls) usedShortNames.add(call.method);
  for (const call of superCalls) usedShortNames.add(call.method);
  for (const call of newCalls) usedShortNames.add(call.name);
  for (const alias of aliases.values()) {
    if (alias.kind === "name") usedShortNames.add(alias.target);
    else { usedShortNames.add(alias.object); usedShortNames.add(alias.method); }
  }

  const lines = [];
  for (const [owner, entry] of byOwner) {
    const targets = [...entry.followed, ...entry.guessed];
    if (targets.length > 0) {
      lines.push(`${owner} → ${targets.join(", ")}`);
    } else {
      const madeCalls = callOwners.has(owner) || entry.notFollowed.length > 0 || entry.builtIn.size > 0;
      lines.push(madeCalls ? `${owner} (no calls Zapple could identify)` : `${owner} (no calls here)`);
    }
    for (const item of entry.notFollowed) lines.push(`    ? ${item.text}  not followed, ${item.why} (line ${item.line})`);
    if (entry.builtIn.size > 0) lines.push(`    · built-in or library: ${[...entry.builtIn].join(", ")}`);
  }
  for (const name of functions.keys()) {
    if (byOwner.has(name)) continue;
    lines.push(callOwners.has(name) ? `${name} (no calls Zapple could identify)` : `${name} (no calls here)`);
  }

  const unused = [...functions.keys()].filter((name) => {
    const short = name.split(".").pop();
    return (nameCounts.get(short) ?? 0) <= 1 && !usedShortNames.has(short) && !exported.has(name);
  });

  const sum = (key) => [...byOwner.values()].reduce((total, entry) => total + (entry[key].size ?? entry[key].length), 0);
  const notFollowedList = [...byOwner.values()].flatMap((entry) => entry.notFollowed);
  const stats = {
    functions: functions.size, followed: sum("followed"), guessed: sum("guessed"),
    notFollowed: notFollowedList.length, builtIn: sum("builtIn"), never: unused.length,
    notFollowedSamples: notFollowedList.slice(0, 3).map((item) => item.text),
  };

  if (unused.length > 0) lines.push("", `Never called or referenced: ${unused.join(", ")}`);
  if (stats.guessed > 0) {
    lines.push("", "A name ending in ? is a suggested link: only one place in this code has that name, so Zapple shows that link, but reading the code cannot prove the call goes there.");
  }
  if (stats.notFollowed > 0) {
    lines.push("", "Some calls could not be traced by reading the code. A ? at the start of a line marks such a call. "
      + "Zapple follows only direct calls, this.method(), known object methods and one-step aliases (const fn = greet). "
      + "Every other call is listed under the calling function as not traced.");
  }

  return { text: lines.join("\n"), stats };
}

// ---------- Python engine (no DOM code here) ----------

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PYTHON_LOAD_TIMEOUT_MS = 90000;

const PYTHON_SKIP_TIP = "The syntax, undefined-name and structure checks above still apply to this code. Running it for real needs a fuller Python than a browser can offer (extra packages, threads), which is what the planned remote runner is for.";

const PYTHON_SOURCE = String.raw`
import ast, builtins, contextlib, copy, difflib, importlib, inspect, io, json, pkgutil, re, sys, time, traceback, warnings
from pyflakes.checker import Checker

ERROR_KINDS = {"UndefinedName", "UndefinedLocal", "UndefinedExport", "DuplicateArgument",
               "ReturnOutsideFunction", "YieldOutsideFunction"}
MAX_OUTPUT_LINES = 200

def finding(message, line=None, column=None, rule="", severity="error"):
    return {"line": line, "column": column, "message": message, "ruleId": rule, "severity": severity}

# Notebook commands such as "!pip install x" or "%matplotlib inline". "% name)" and "!= b" are valid Python, so the
# line must start with the command name right after the symbol.
NOTEBOOK_LINE = re.compile(r"(?m)^([ \t]*)(?:%{1,2}[A-Za-z_].*|![^=\s].*)$")

def parse_code(code):
    """Parses the code as written. Only when that fails are notebook command lines replaced with "pass"
    (line numbers stay the same). Returns (tree, blanked_count, syntax_error)."""
    try:
        return ast.parse(code), 0, None
    except SyntaxError as written:
        blanked, count = NOTEBOOK_LINE.subn(r"\1pass", code)
        if count == 0:
            return None, 0, written
        try:
            return ast.parse(blanked), count, None
        except SyntaxError as error:
            return None, count, error

def outside_packages(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return sorted(names - set(sys.stdlib_module_names))

def rule_findings(tree, extra_names):
    checker = Checker(tree, builtins=extra_names)
    findings = []
    for message in sorted(checker.messages, key=lambda m: m.lineno):
        kind = type(message).__name__
        severity = "error" if kind in ERROR_KINDS else "note"
        text = message.message % message.message_args
        findings.append(finding(text, message.lineno, message.col + 1, "pyflakes/" + kind, severity))
    return findings

def crash_finding(error):
    line = None
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename == "<user code>":
            line = frame.lineno
    if line is None:
        line = getattr(error, "lineno", None)
    return finding(f"{type(error).__name__}: {error}", line, None, "runtime")

class AsyncRunRewriter(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        return node
    visit_AsyncFunctionDef = visit_Lambda = visit_ClassDef = visit_FunctionDef

    def visit_Call(self, node):
        self.generic_visit(node)
        func = node.func
        is_asyncio_run = (isinstance(func, ast.Attribute) and func.attr == "run"
                          and isinstance(func.value, ast.Name) and func.value.id == "asyncio")
        if is_asyncio_run and len(node.args) == 1 and not node.keywords:
            return ast.copy_location(ast.Await(value=node.args[0]), node)
        return node

def environment_limit(error, outside):
    if isinstance(error, AttributeError) and re.match(r"module '[\w.]+' has no attribute", str(error)) \
            and str(error).split("'")[1].split(".")[0] in sys.stdlib_module_names:
        return (f"it uses something from the standard library that this version of Python does not have ({error}). "
                f"Zapple runs {python_version()}, so newer features can be missing here even though your Python has them.")
    if isinstance(error, FileNotFoundError) and error.filename:
        return (f"it opens a file ({error.filename}), which Zapple's test area does not have. "
                "Zapple's Python runs inside your browser and cannot see files on your computer.")
    if isinstance(error, EOFError) and "reading a line" in str(error):
        return ("it waits for you to type something with input(). "
                "Zapple's Python runs without a keyboard, so this code cannot run here even if it is correct.")
    if isinstance(error, ModuleNotFoundError) and (error.name or "").split(".")[0] in outside:
        return (f"it imports {error.name}, which is not part of standard Python. "
                "Zapple's Python runs inside your browser and only has the standard library for now.")
    if "can't start new thread" in str(error):
        return ("it starts threads (for example with ThreadPoolExecutor). Zapple's Python runs inside your browser, "
                "which does not allow threads, so this code cannot run here even if it is correct.")
    return None

async def run_code(tree):
    namespace = {"__name__": "__main__", "__file__": "main.py"}
    printed = io.StringIO()
    crash = None
    exit_code, exit_line = None, None
    try:
        rewritten = ast.fix_missing_locations(AsyncRunRewriter().visit(copy.deepcopy(tree)))
        compiled = compile(rewritten, "<user code>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(printed):
            outcome = eval(compiled, namespace)
            if inspect.iscoroutine(outcome):
                await outcome
    except SystemExit as stop:
        exit_code, exit_line = stop.code, crash_finding(stop)["line"]
    except BaseException as error:
        crash = error
    return namespace, printed.getvalue().splitlines()[:MAX_OUTPUT_LINES], crash, (exit_code, exit_line)

def run_checks(check_lines, namespace):
    findings, total = [], 0
    for source in check_lines:
        try:
            node = ast.parse(source, mode="eval").body
        except SyntaxError as error:
            findings.append(finding(f"Check is not a valid expression ({error.msg}): {source}", rule="check"))
            continue
        total += 1
        try:
            if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
                left = eval(ast.get_source_segment(source, node.left), namespace)
                right = eval(ast.get_source_segment(source, node.comparators[0]), namespace)
                passed, detail = left == right, f" (got {left!r})"
            else:
                passed, detail = bool(eval(source, namespace)), ""
        except Exception as error:
            findings.append(finding(f"Check crashed with {type(error).__name__}: {error}: {source}", rule="check"))
            continue
        if not passed:
            findings.append(finding(f"Check failed{detail}: {source}", rule="check"))
    return findings, total

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
SCOPE_NODES = FUNCTION_NODES + (ast.Lambda,)
OBJECT_BASES = {"object"}

IMPORT_HOOKS = {"find_spec", "find_module", "create_module", "exec_module", "load_module"}
COMMON_METHODS = set(dir(list)) | set(dir(dict)) | set(dir(str)) | set(dir(set)) | set(dir(bytes))

def mutable_default_notes(tree):
    notes = []
    for node in ast.walk(tree):
        if not isinstance(node, SCOPE_NODES):
            continue
        for default in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
            is_literal = isinstance(default, (ast.List, ast.Dict, ast.Set))
            is_constructor = (isinstance(default, ast.Call) and isinstance(default.func, ast.Name)
                              and default.func.id in ("list", "dict", "set"))
            if is_literal or is_constructor:
                notes.append(finding("A default value that is a list, dict or set is created once and shared by every call of the function",
                                     default.lineno, default.col_offset + 1, "zapple/mutable-default", "note"))
    return notes

def is_dunder(name):
    return name.startswith("__") and name.endswith("__")

def first_param(fn):
    params = fn.args.posonlyargs + fn.args.args
    return params[0].arg if params else None

def count_label(count, noun):
    return f"{count} {noun}{'' if count == 1 else 's'}"

def names_in(items):
    return ", ".join(f'"{item}"' for item in items)

class ClassInfo:
    def __init__(self, node):
        self.node = node
        self.name = node.name
        self.methods = {}
        self.members = set()
        self.decorated = bool(node.decorator_list)
        has_base = any(not (isinstance(b, ast.Name) and b.id in OBJECT_BASES) for b in node.bases)
        self.has_parent = has_base or bool(node.keywords)
        self.dynamic = False
        self.set_on_self = set()

class Structure:
    def __init__(self, tree):
        self.plain_defs = {}
        self.rebound = set()
        self.classes = {}
        self.referenced = set()
        self.uses_dynamic_lookup = False
        self._collect(tree, None)
        self.imported = {(alias.asname or alias.name).split(".")[0] for node in ast.walk(tree)
                         if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names}

    def _collect(self, node, scope, class_node=None):
        if isinstance(node, FUNCTION_NODES + (ast.ClassDef,)):
            if class_node is None:
                self.plain_defs.setdefault(node.name, []).append((node, scope))
            elif isinstance(node, FUNCTION_NODES):
                self.classes[class_node].methods.setdefault(node.name, []).append(node)
        self._note_names(node)

        if isinstance(node, ast.ClassDef):
            self.classes[node] = ClassInfo(node)
            self._note_class_body(node, self.classes[node])
            for child in ast.iter_child_nodes(node):
                self._collect(child, scope, node)
            return

        child_scope = node if isinstance(node, SCOPE_NODES) else scope
        for child in ast.iter_child_nodes(node):
            self._collect(child, child_scope)

    def _note_names(self, node):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                self.referenced.add(node.id)
                if node.id in ("getattr", "globals", "locals", "setattr", "vars", "eval", "exec"):
                    self.uses_dynamic_lookup = True
            else:
                self.rebound.add(node.id)
        elif isinstance(node, ast.Attribute):
            if isinstance(node.ctx, ast.Load):
                self.referenced.add(node.attr)
            if node.attr == "__dict__":
                self.uses_dynamic_lookup = True
        elif isinstance(node, ast.arg):
            self.rebound.add(node.arg)
        elif isinstance(node, ast.alias):
            self.rebound.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            self.rebound.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            self.rebound.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            self.rebound.add(node.rest)

    def _note_class_body(self, node, info):
        for statement in node.body:
            if isinstance(statement, FUNCTION_NODES + (ast.ClassDef,)):
                info.members.add(statement.name)
            for target in ast.walk(statement) if not isinstance(statement, FUNCTION_NODES) else ():
                if isinstance(target, ast.Name) and not isinstance(target.ctx, ast.Load):
                    info.members.add(target.id)
        self_names = {first_param(m) for m in node.body if isinstance(m, FUNCTION_NODES)} - {None}
        for inner in ast.walk(node):
            is_self_attribute = (isinstance(inner, ast.Attribute) and isinstance(inner.value, ast.Name)
                                 and inner.value.id in self_names)
            if is_self_attribute and not isinstance(inner.ctx, ast.Load):
                info.members.add(inner.attr)
                info.set_on_self.add(inner.attr)
            if isinstance(inner, ast.Name) and inner.id in ("setattr", "__getattr__", "__getattribute__"):
                info.dynamic = True
            if isinstance(inner, ast.Attribute) and inner.attr == "__dict__":
                info.dynamic = True
        if "__getattr__" in info.members or "__getattribute__" in info.members:
            info.dynamic = True

    def single_definition(self, name):
        found = self.plain_defs.get(name, [])
        if len(found) != 1 or name in self.rebound:
            return None
        return found[0]

def build_signature(fn, drop_first):
    args = fn.args
    positional = args.posonlyargs + args.args
    required_count = len(positional) - len(args.defaults)
    if drop_first:
        if not positional:
            return None
        positional, required_count = positional[1:], max(0, required_count - 1)
        posonly = {a.arg for a in args.posonlyargs[1:]}
    else:
        posonly = {a.arg for a in args.posonlyargs}
    names = [a.arg for a in positional]
    return {
        "names": names,
        "required": names[:required_count],
        "max_positional": float("inf") if args.vararg else len(names),
        "keyword_ok": {n for n in names if n not in posonly} | {a.arg for a in args.kwonlyargs},
        "posonly": posonly,
        "required_keyword_only": [a.arg for a, d in zip(args.kwonlyargs, args.kw_defaults) if d is None],
        "takes_any_keyword": args.kwarg is not None,
    }

def call_problems(call, signature, label):
    if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
        return []
    problems = []
    given = len(call.args)
    if given > signature["max_positional"]:
        limit = signature["max_positional"]
        accepts = "accepts none" if limit == 0 else f"accepts only {limit}"
        problems.append(("too-many-arguments", f"{label} is called with {count_label(given, 'positional argument')} but {accepts}"))
        return problems

    filled = set(signature["names"][:given])
    for keyword in call.keywords:
        if keyword.arg in filled:
            problems.append(("duplicate-argument", f'{label} gets two values for "{keyword.arg}" (by position and by name)'))
        elif keyword.arg in signature["keyword_ok"]:
            filled.add(keyword.arg)
        elif keyword.arg in signature["posonly"]:
            problems.append(("unknown-keyword", f'{label} cannot take "{keyword.arg}" by name (it is positional-only)'))
        elif not signature["takes_any_keyword"]:
            problems.append(("unknown-keyword", f'{label} has no argument named "{keyword.arg}"'))

    missing = [n for n in signature["required"] + signature["required_keyword_only"] if n not in filled]
    if missing:
        problems.append(("missing-arguments", f"{label} is missing required {'argument' if len(missing) == 1 else 'arguments'} {names_in(missing)}"))
    return problems

def constructor_signature(info):
    if info.decorated or info.has_parent:
        return None
    customized = [n for n in ("__new__", "__init_subclass__") if n in info.members]
    if customized or "__call__" in info.methods:
        return None
    if "__init__" not in info.members:
        return build_signature(ast.parse("def __init__(self): pass").body[0], True)
    definitions = info.methods.get("__init__", [])
    if len(definitions) != 1 or definitions[0].decorator_list:
        return None
    return build_signature(definitions[0], True)

def finding_for(call, problem):
    rule, message = problem
    return finding(message, call.lineno, call.col_offset + 1, "zapple/" + rule)

class CallWalker:
    def __init__(self, structure):
        self.structure = structure
        self.errors = []
        self.callees = {}
        self.not_followed = {}
        self.built_in = {}
        self.plain_called = set()
        self.any_calls = set()
        self.method_owners = {}
        for info in structure.classes.values():
            for name in info.methods:
                self.method_owners.setdefault(name, []).append(info.name)

    def visit(self, node, owner, cls, self_name, scopes):
        if isinstance(node, ast.ClassDef):
            cls, self_name = self.structure.classes[node], None
            for child in ast.iter_child_nodes(node):
                self.visit(child, owner, cls, self_name, scopes)
            return

        if isinstance(node, SCOPE_NODES):
            in_class = cls is not None and node in cls.node.body
            if isinstance(node, FUNCTION_NODES):
                owner = f"{cls.name}.{node.name}" if in_class else node.name
            if in_class:
                self_name = None if node.decorator_list else first_param(node)
            elif self_name in {a.arg for a in ast.walk(node.args) if isinstance(a, ast.arg)}:
                self_name = None
            scopes = scopes + [node]
            for child in ast.iter_child_nodes(node):
                self.visit(child, owner, cls, self_name, scopes)
            return

        if isinstance(node, ast.Assign):
            for target in node.targets:
                self.note_property_setter(target, owner, cls, self_name)
        if isinstance(node, ast.Call):
            self.check_call(node, owner, cls, self_name, scopes)
        for child in ast.iter_child_nodes(node):
            self.visit(child, owner, cls, self_name, scopes)

    def add_callee(self, owner, callee):
        self.callees.setdefault(owner, [])
        if callee not in self.callees[owner]:
            self.callees[owner].append(callee)

    def check_call(self, call, owner, cls, self_name, scopes):
        target = call.func
        self.any_calls.add(owner)
        self.note_functions_passed(call, owner, scopes)
        if isinstance(target, ast.Name):
            if target.id == "cls" and cls is not None:
                self.add_callee(owner, cls.name)
            self.sort_plain_call(call, target.id, owner, scopes)
            self.check_plain_call(call, target.id, owner, scopes)
        elif isinstance(target, ast.Attribute):
            if isinstance(target.value, ast.Name) and cls is not None and self_name and target.value.id == self_name:
                self.add_callee(owner, f"{self_name}.{target.attr}")
                self.check_method_call(call, target.attr, cls)
            elif cls is not None and self.is_super_call(target.value):
                self.add_callee(owner, self.super_target(cls, target.attr))
            else:
                self.sort_member_call(call, target, owner)

    def note_built_in(self, owner, text):
        names = self.built_in.setdefault(owner, [])
        if text not in names:
            names.append(text)

    def note_not_followed(self, owner, text, why, call):
        self.not_followed.setdefault(owner, []).append((text, why, call.lineno))

    def sort_plain_call(self, call, name, owner, scopes):
        defined = any(scope is None or scope in scopes for _, scope in self.structure.plain_defs.get(name, []))
        if defined or name == "cls":
            return
        if hasattr(builtins, name) or name in self.structure.imported:
            self.note_built_in(owner, f"{name}()")
        elif name in self.structure.rebound:
            self.note_not_followed(owner, f"{name}()", "called through a variable that is not a function defined here", call)

    def sort_member_call(self, call, target, owner):
        method = target.attr
        root = target.value.id if isinstance(target.value, ast.Name) else None
        text = f"{root}.{method}()" if root else f"….{method}()"
        if root in self.structure.imported or method in COMMON_METHODS:
            self.note_built_in(owner, text)
        elif not self.guess_method_target(method, owner):
            self.note_not_followed(owner, text, "called through an object, and Zapple could not tell which function that is", call)

    @staticmethod
    def is_super_call(node):
        return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "super"

    def super_target(self, cls, method):
        for base in cls.node.bases:
            found = self.structure.single_definition(base.id) if isinstance(base, ast.Name) else None
            if found and isinstance(found[0], ast.ClassDef) and method in self.structure.classes[found[0]].methods:
                return f"{found[0].name}.{method}"
        return f"super().{method}"

    def note_functions_passed(self, call, owner, scopes):
        for argument in call.args + [k.value for k in call.keywords]:
            if isinstance(argument, ast.Name):
                visible = [d for d, scope in self.structure.plain_defs.get(argument.id, [])
                           if isinstance(d, FUNCTION_NODES) and (scope is None or scope in scopes)]
                if visible:
                    self.add_callee(owner, f"{argument.id} (passed along)")

    def note_property_setter(self, target, owner, cls, self_name):
        is_self_attribute = (cls is not None and self_name and isinstance(target, ast.Attribute)
                             and isinstance(target.value, ast.Name) and target.value.id == self_name)
        if not is_self_attribute:
            return
        for method in cls.methods.get(target.attr, []):
            if any(isinstance(d, ast.Attribute) and d.attr == "setter" for d in method.decorator_list):
                self.add_callee(owner, f"{cls.name}.{target.attr} (setter)")
                return

    def guess_method_target(self, method, owner):
        owners = self.method_owners.get(method, [])
        if len(owners) == 1 and method not in COMMON_METHODS and not is_dunder(method):
            self.add_callee(owner, f"{owners[0]}.{method}?")

    def check_plain_call(self, call, name, owner, scopes):
        structure = self.structure
        visible = [d for d, scope in structure.plain_defs.get(name, []) if scope is None or scope in scopes]
        if visible:
            self.add_callee(owner, name)
            self.plain_called.add(name)
        found = structure.single_definition(name)
        if not found or found[0] not in visible or found[0].decorator_list:
            return
        definition = found[0]
        if isinstance(definition, ast.ClassDef):
            signature = constructor_signature(structure.classes[definition])
        else:
            signature = build_signature(definition, False)
        if signature:
            for problem in call_problems(call, signature, f"{name}()"):
                self.errors.append(finding_for(call, problem))

    def check_method_call(self, call, method, cls):
        definitions = cls.methods.get(method, [])
        replaced = method in cls.set_on_self
        if len(definitions) == 1 and not definitions[0].decorator_list and not replaced:
            signature = build_signature(definitions[0], True)
            if signature:
                for problem in call_problems(call, signature, f"self.{method}()"):
                    self.errors.append(finding_for(call, problem))
        elif not definitions and method not in cls.members and not cls.has_parent \
                and not cls.decorated and not cls.dynamic:
            message = f'self.{method}() is called, but class {cls.name} has no method or attribute "{method}"'
            self.errors.append(finding_for(call, ("unknown-method", message)))

def unused_names(structure, check_names):
    used = structure.referenced | check_names
    unused = []
    for name, found in structure.plain_defs.items():
        for definition, _ in found:
            registered_elsewhere = isinstance(definition, ast.ClassDef) and (definition.bases or definition.keywords)
            if name not in used and not definition.decorator_list and not is_dunder(name) and not registered_elsewhere:
                unused.append(name)
    for info in structure.classes.values():
        if info.has_parent or info.decorated:
            continue
        for name, definitions in info.methods.items():
            if name in used or is_dunder(name) or name in IMPORT_HOOKS or any(d.decorator_list for d in definitions):
                continue
            unused.append(f"{info.name}.{name}")
    return unused

def build_call_map(structure, walker, check_names):
    untraced = {}
    for owner, items in walker.not_followed.items():
        untraced[owner] = [f"    ? {text}  not followed, {why} (line {line})" for text, why, line in items]

    printed = set()
    lines = []
    for owner, callees in walker.callees.items():
        printed.add(owner)
        lines.append(f"{owner} → {', '.join(callees)}")
        lines.extend(untraced.get(owner, []))
    every_function = [n for n, found in structure.plain_defs.items()
                      for d, _ in found if isinstance(d, FUNCTION_NODES)]
    every_function += [f"{i.name}.{n}" for i in structure.classes.values() for n in i.methods]
    for name in every_function:
        if name in printed:
            continue
        made_calls = name in walker.any_calls or name in walker.built_in
        lines.append(f"{name} (no calls Zapple could identify)" if made_calls else f"{name} (no calls here)")

    for owner, rows in untraced.items():
        if owner not in printed:
            lines.append(f"{owner} (no calls Zapple could identify)")
            lines.extend(rows)

    unused = unused_names(structure, check_names)
    if unused:
        lines += ["", f"Never called or referenced: {', '.join(unused)}"]
        if structure.uses_dynamic_lookup:
            lines.append("(This code looks names up by text, for example with getattr, so some of these may be used that way.)")
    if any(callee.endswith("?") for callees in walker.callees.values() for callee in callees):
        lines += ["", "A name ending in ? is a suggested link: only one class in this code has a method with that name."]
    if any(untraced.values()):
        lines += ["", "Some calls could not be traced by reading the code. A ? at the start of a line marks such a call. "
                       "Zapple follows only direct calls, self.method(), known object methods and one-step aliases (const fn = greet). "
                       "Every other call is listed under the calling function as not traced."]
    return "\n".join(lines)

def check_names_used(check_lines):
    names = set()
    for source in check_lines:
        try:
            for node in ast.walk(ast.parse(source, mode="eval")):
                if isinstance(node, ast.Name):
                    names.add(node.id)
                elif isinstance(node, ast.Attribute):
                    names.add(node.attr)
        except SyntaxError:
            continue
    return names

STDLIB_NEVER_IMPORT = {"this", "antigravity", "idlelib", "tkinter", "turtle", "turtledemo", "test", "lib2to3", "pydoc_data", "ensurepip", "venv"}
# Attributes that only exist on some systems or in newer Pythons than the one Zapple runs. Never reported as missing.
WINDOWS_ONLY_MEMBERS = {"startfile", "O_BINARY", "STARTUPINFO", "STARTF_USESHOWWINDOW", "SW_HIDE", "CREATE_NEW_CONSOLE",
                        "CREATE_NO_WINDOW", "CREATE_NEW_PROCESS_GROUP", "DETACHED_PROCESS", "CTRL_C_EVENT", "CTRL_BREAK_EVENT",
                        "WindowsSelectorEventLoopPolicy", "WindowsProactorEventLoopPolicy", "ProactorEventLoop",
                        "windll", "WinDLL", "WinError", "oledll", "OleDLL", "HRESULT", "FormatError", "GetLastError", "WINFUNCTYPE",
                        "getwindowsversion", "winver", "add_dll_directory"}
NEWER_PYTHON_MEMBERS = {"deprecated", "replace", "process_cpu_count", "fma", "z85encode", "z85decode", "UnsupportedOperation",
                        "batched", "sumprod", "binomialvariate", "TaskGroup", "ExceptionGroup", "BaseExceptionGroup", "Runner",
                        "timeout", "timeout_at", "Barrier", "pairwise", "UTC", "StrEnum", "ReprEnum", "EnumCheck", "verify",
                        "override", "TypeAliasType", "Buffer", "is_protocol", "get_protocol_members", "NoDefault", "ReadOnly",
                        "TypeIs", "is_typeddict", "evaluate_forward_ref", "annotationlib", "Template", "Interpolation"}
# On these, which attributes exist depends on the operating system, so only a close misspelling is reported
PLATFORM_VARIABLE_MODULES = {"os", "signal", "socket", "select", "selectors", "time", "resource", "fcntl", "termios", "pwd", "grp",
                             "mmap", "multiprocessing", "asyncio", "subprocess", "ctypes", "shutil", "ssl", "threading", "tty", "pty",
                             "syslog", "errno", "stat", "sys", "locale", "curses", "readline", "platform", "sysconfig", "tempfile",
                             "posix", "pathlib", "logging", "concurrent", "zoneinfo", "sqlite3"}
JSON_KEYWORD_FUNCTIONS = {"dumps", "dump"}   # their **kw goes to JSONEncoder, whose options are all named in the signature

def python_version():
    return f"Python {sys.version_info.major}.{sys.version_info.minor}"

class Bindings:
    """Every name the code binds and how many times. A name bound once, by an import, can be trusted to mean that import."""
    def __init__(self, tree):
        self.counts = {}
        self.imports = {}
        self.star = False
        self.assigned_members = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
                self.add(node.id)
            elif isinstance(node, ast.arg):
                self.add(node.arg)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.add(node.name)
            elif isinstance(node, ast.ExceptHandler) and node.name:
                self.add(node.name)
            elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
                self.add(node.name)
            elif isinstance(node, ast.MatchMapping) and node.rest:
                self.add(node.rest)
            elif isinstance(node, (ast.TypeVar, ast.ParamSpec, ast.TypeVarTuple)):
                self.add(node.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name.split(".")[0]
                    self.add_import(name, ("import", alias.name if alias.asname else name, None))
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == "*":
                        self.star = True
                    elif node.level or not node.module:
                        self.add(alias.asname or alias.name)
                    else:
                        self.add_import(alias.asname or alias.name, ("from", node.module, alias.name))
            elif isinstance(node, ast.Attribute) and not isinstance(node.ctx, ast.Load):
                self.assigned_members.add(node.attr)

    def add(self, name):
        self.counts[name] = self.counts.get(name, 0) + 1

    def add_import(self, name, source):
        if self.imports.get(name) != source:      # "import os" twice means the same thing
            self.add(name)
        self.imports[name] = source

def load_stdlib_module(module_name):
    top = module_name.split(".")[0]
    if top.startswith("_") or top in STDLIB_NEVER_IMPORT or top not in sys.stdlib_module_names:
        return None
    try:
        with warnings.catch_warnings(), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            warnings.simplefilter("ignore")
            return importlib.import_module(module_name)
    except BaseException:
        return None

def stdlib_signature(function):
    try:
        parameters = list(inspect.signature(function).parameters.values())
    except (ValueError, TypeError):
        return None
    kinds = inspect.Parameter
    positional = [p for p in parameters if p.kind in (kinds.POSITIONAL_ONLY, kinds.POSITIONAL_OR_KEYWORD)]
    keyword_only = [p for p in parameters if p.kind is kinds.KEYWORD_ONLY]
    return {
        "names": [p.name for p in positional],
        "required": [p.name for p in positional if p.default is kinds.empty],
        "max_positional": float("inf") if any(p.kind is kinds.VAR_POSITIONAL for p in parameters) else len(positional),
        "keyword_ok": {p.name for p in positional if p.kind is kinds.POSITIONAL_OR_KEYWORD} | {p.name for p in keyword_only},
        "posonly": {p.name for p in positional if p.kind is kinds.POSITIONAL_ONLY},
        "required_keyword_only": [p.name for p in keyword_only if p.default is kinds.empty],
        "takes_any_keyword": any(p.kind is kinds.VAR_KEYWORD for p in parameters),
    }

def is_submodule(module, name):
    """A package's submodules appear as attributes only after something imports them, so they are never reported missing."""
    return any(info.name == name for info in pkgutil.iter_modules(getattr(module, "__path__", [])))

def has_member(module, name):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return hasattr(module, name)
    except BaseException:
        return True      # when unsure, assume it exists

def missing_member_hint(alias, module, attribute):
    names = [n for n in dir(module) if not n.startswith("_")]
    owners = [n for n in names if inspect.isclass(getattr(module, n, None)) and has_member(getattr(module, n), attribute)]
    if len(owners) == 1:
        return f"{alias}.{owners[0]}.{attribute}"
    close = difflib.get_close_matches(attribute, names, n=1, cutoff=0.7)
    return f"{alias}.{close[0]}" if close else None

def guarded_nodes(tree):
    """Code the author protected against a missing name: inside try/except AttributeError (or a broad except), or inside an
    if that tests the Python version or uses hasattr. Such code is written for other Pythons, so it is never judged here."""
    guarded = set()
    def mark(statements):
        for statement in statements:
            guarded.update(id(n) for n in ast.walk(statement))
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            broad = any(h.type is None or any(isinstance(n, ast.Name) and n.id in ("AttributeError", "Exception", "BaseException", "ImportError", "TypeError")
                                                for n in ast.walk(h.type)) for h in node.handlers)
            if broad:
                mark(node.body)
        elif isinstance(node, ast.If):
            text = ast.unparse(node.test)
            if "version" in text or "hasattr" in text or "platform" in text:
                mark(node.body + node.orelse)
    return guarded

def stdlib_findings(tree):
    """Wrong names and wrong arguments in calls into the standard library. Reads the real standard library, so it knows
    json.dumps() has no "indnt" argument even in a function that never runs. Quiet whenever a name could mean something else."""
    bindings = Bindings(tree)
    if bindings.star:
        return []
    modules, functions = {}, {}
    for name, (kind, module_name, member) in bindings.imports.items():
        if bindings.counts.get(name) != 1:
            continue
        module = load_stdlib_module(module_name)
        if module is None:
            continue
        if kind == "import":
            modules[name] = module
        else:
            target = getattr(module, member, None)
            if inspect.ismodule(target):
                modules[name] = target
            elif target is not None:
                functions[name] = target
    version = python_version()
    findings = []
    # A name the code also writes as text, like hasattr(os, "lchmod"), is being tested for, so it may legitimately be missing
    named_in_text = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    guarded = guarded_nodes(tree)

    def report(node, rule, message):
        findings.append(finding(f"{message} (checked against {version})", node.lineno, node.col_offset + 1, "zapple/" + rule))

    for node in ast.walk(tree):
        if id(node) in guarded:
            continue
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load) and isinstance(node.value, ast.Name) and node.value.id in modules:
            alias, module, attribute = node.value.id, modules[node.value.id], node.attr
            skipped = (is_submodule(module, attribute) or attribute in WINDOWS_ONLY_MEMBERS or attribute in NEWER_PYTHON_MEMBERS
                       or attribute.startswith("_") or attribute in named_in_text
                       or attribute in bindings.assigned_members or has_member(module, attribute))
            if skipped:
                continue
            hint = missing_member_hint(alias, module, attribute)
            if module.__name__.split(".")[0] in PLATFORM_VARIABLE_MODULES and (not hint or attribute.isupper()):
                continue
            report(node, "unknown-module-member",
                   f'{alias}.{attribute} does not exist: module "{module.__name__}" has no attribute "{attribute}".'
                   + (f" Did you mean {hint}?" if hint else ""))
        elif isinstance(node, ast.Call):
            target, label = None, None
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in modules:
                target, label = getattr(modules[func.value.id], func.attr, None), f"{func.value.id}.{func.attr}()"
            elif isinstance(func, ast.Name) and func.id in functions:
                target, label = functions[func.id], f"{func.id}()"
            elif isinstance(func, ast.Name) and func.id not in bindings.counts and hasattr(builtins, func.id):
                target, label = getattr(builtins, func.id), f"{func.id}()"
            if target is None or not (inspect.isfunction(target) or inspect.isbuiltin(target) or inspect.ismethod(target)):
                continue
            signature = stdlib_signature(target)
            if signature is None:
                continue
            if getattr(target, "__module__", None) == "json" and getattr(target, "__name__", "") in JSON_KEYWORD_FUNCTIONS \
                    and not any(k.arg == "cls" for k in node.keywords):
                signature["takes_any_keyword"] = False      # json passes **kw straight to its encoder, which accepts exactly the named ones
            for rule, message in call_problems(node, signature, label):
                report(node, "stdlib-" + rule, message)
    return findings

def analyze_structure(tree, check_lines):
    structure = Structure(tree)
    walker = CallWalker(structure)
    walker.visit(tree, "(top level)", None, None, [])
    errors = sorted(walker.errors, key=lambda f: (f["line"], f["column"]))
    call_map = build_call_map(structure, walker, check_names_used(check_lines))
    definitions = sum(len(found) for found in structure.plain_defs.values())
    untraced = sum(len(items) for items in walker.not_followed.values())
    return errors, call_map, definitions, untraced

async def analyze(request):
    tree, blanked, error = parse_code(request["code"])
    result = {"blanked": blanked, "syntax": None, "errors": [], "notes": [], "skipReason": None,
              "output": [], "runErrors": [], "checkCount": 0,
              "callMap": "", "structureCount": 0, "untracedCalls": 0, "structureFailed": None}

    if tree is None:
        lines = request["code"].split("\n")
        line = error.lineno or 1
        source_line = lines[line - 1] if line <= len(lines) else ""
        result["syntax"] = {"message": error.msg, "line": line, "column": error.offset or 1, "sourceLine": source_line}
        return result

    findings = rule_findings(tree, request["extraNames"])
    result["errors"] = [f for f in findings if f["severity"] == "error"]
    result["notes"] = sorted([f for f in findings if f["severity"] == "note"] + mutable_default_notes(tree),
                             key=lambda f: f["line"] or 0)

    try:
        problems, result["callMap"], result["structureCount"], result["untracedCalls"] = analyze_structure(tree, request["checks"])
        problems = problems + stdlib_findings(tree)
        result["errors"] = sorted(result["errors"] + problems, key=lambda f: f["line"] or 0)
    except Exception as error:
        result["structureFailed"] = f"{type(error).__name__}: {error}"
    if result["errors"]:
        return result

    outside = outside_packages(tree)
    namespace, result["output"], error, (exit_code, exit_line) = await run_code(tree)
    if exit_code is not None and exit_code != 0:
        result["notes"].append(finding(
            f"The code stopped early with exit code {exit_code!r}, so anything after that point did not run",
            exit_line, None, "zapple/early-exit", "note"))
    limit = environment_limit(error, outside) if error else None
    if limit:
        result["skipReason"], result["output"] = limit, []
    elif error:
        result["runErrors"] = [crash_finding(error)]
    else:
        result["runErrors"], result["checkCount"] = run_checks(request["checks"], namespace)
    return result

async def zapple_analyze(request_json):
    started = time.perf_counter()
    result = await analyze(json.loads(request_json))
    result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
    return json.dumps(result)
`;

function pythonWorkerMain() {
  let pyodide = null;

  self.onmessage = async ({ data }) => {
    if (data.type === "init") {
      try {
        importScripts(`${data.pyodideUrl}pyodide.js`);
        pyodide = await loadPyodide({ indexURL: data.pyodideUrl });
        await pyodide.loadPackage("micropip");
        await pyodide.pyimport("micropip").install("pyflakes");
        pyodide.runPython(data.pythonSource);

        for (const name of data.blockedNames) {
          Object.defineProperty(self, name, {
            get() { throw new Error(`${name} is blocked in the Zapple sandbox`); },
          });
        }
        self.postMessage({ type: "ready" });
      } catch (error) {
        self.postMessage({ type: "failed", message: String(error) });
      }
    } else if (data.type === "run") {
      try {
        const analyze = pyodide.globals.get("zapple_analyze");
        const answer = await analyze(JSON.stringify(data.request));
        self.postMessage({ type: "result", result: JSON.parse(answer) });
      } catch (error) {
        self.postMessage({ type: "result", result: { internalError: String(error) } });
      }
    }
  };
}

let pythonWorker = null;

function startPythonWorker(log) {
  log.add("Loading Python (about 10 MB the first time, then cached)...");
  const url = URL.createObjectURL(new Blob([`(${pythonWorkerMain})();`], { type: "text/javascript" }));
  const worker = new Worker(url);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Python took too long to load. Check your internet connection and try again.")), PYTHON_LOAD_TIMEOUT_MS);
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") { clearTimeout(timer); resolve(worker); }
      if (data.type === "failed") { clearTimeout(timer); reject(new Error(`Python could not start: ${data.message}`)); }
    };
    worker.onerror = (event) => { clearTimeout(timer); reject(new Error(`Python could not start: ${event.message || "unknown error"}`)); };
  });

  worker.postMessage({ type: "init", pyodideUrl: PYODIDE_URL, pythonSource: PYTHON_SOURCE, blockedNames: BLOCKED_BROWSER_APIS });
  return ready.finally(() => URL.revokeObjectURL(url));
}

function getPythonWorker(log) {
  if (!pythonWorker) {
    pythonWorker = startPythonWorker(log).catch((error) => {
      pythonWorker = null;
      throw error;
    });
  }
  return pythonWorker;
}

async function runPythonAnalysis(request, log) {
  const worker = await getPythonWorker(log);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      pythonWorker = null;
      resolve({ timedOut: true });
    }, RUN_TIMEOUT_MS);

    worker.onmessage = ({ data }) => {
      if (data.type !== "result") return;
      clearTimeout(timer);
      resolve(data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      clearTimeout(timer);
      worker.terminate();
      pythonWorker = null;
      resolve({ workerFailed: event.message || "unknown error" });
    };
    worker.postMessage({ type: "run", request });
  });
}

// ---------- Repair prompt (no DOM code here) ----------

const CONTEXT_LINES = 3;
const REPLY_RULE = "- Reply with only the complete corrected code in one code block. No explanation.";

const SYNTAX_FIX_RULES = [
  "Rules:",
  "- Fix only this error. Do not rewrite, rename, reformat, or add features.",
  "- If you spot other syntax errors, fix those too, and change nothing else.",
  REPLY_RULE,
];

const LINT_FIX_RULES = [
  "Rules:",
  "- Fix every problem listed and change nothing else. Do not rewrite, rename, reformat, or add features.",
  "- For a name that is not defined, either define it or use the correct name that already exists in the code. Do not delete the code that uses it.",
  "- For a call with the wrong arguments, fix the call or the function definition, whichever matches what the code is meant to do. Keep every other call working.",
  "- Problems marked [runtime] crashed when the code was run. Fix the cause of the crash.",
  "- Problems marked [check] are tests written by the user. The corrected code must pass them.",
  REPLY_RULE,
];

function buildContext(code, errorLine) {
  const lines = code.split("\n");
  const first = Math.max(1, errorLine - CONTEXT_LINES);
  const last = Math.min(lines.length, errorLine + CONTEXT_LINES);
  const width = String(last).length;

  const rows = [];
  for (let number = first; number <= last; number++) {
    const marker = number === errorLine ? ">" : " ";
    rows.push(`${marker} ${String(number).padStart(width)} | ${lines[number - 1]}`);
  }
  return rows.join("\n");
}

function fenceFor(code) {
  const longestRun = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

function describeCodeType({ language, sourceType }) {
  if (language === "python") return "Python 3";
  if (sourceType === "module") return "JavaScript ES module";
  if (sourceType === "script") return "JavaScript plain script";
  return "JavaScript";
}

function assemblePrompt({ intro, task, language, sourceType, details, rules, code }) {
  const fence = fenceFor(code);
  const fenceLanguage = language === "python" ? "python" : "js";
  const sections = [
    intro,
    task ? `What the code should do: ${task}` : null,
    `Code type: ${describeCodeType({ language, sourceType })}`,
    details,
    rules.join("\n"),
    `Full code:\n${fence}${fenceLanguage}\n${code}\n${fence}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function buildSyntaxPrompt({ code, problem, language, sourceType, task }) {
  const details = [
    `Error: ${problem.message} (line ${problem.line}, column ${problem.column})`,
    `Code around the error (">" marks the line):\n${buildContext(code, problem.line)}`,
  ].join("\n\n");

  return assemblePrompt({
    intro: "Fix the syntax error in the code below.",
    task, language, sourceType, details, code,
    rules: SYNTAX_FIX_RULES,
  });
}

function buildLintPrompt({ code, errors, language, sourceType, task }) {
  const lines = code.split("\n");
  const problems = errors.map((finding, index) => {
    const rule = finding.ruleId ? ` [${finding.ruleId}]` : "";
    const place = finding.line ? `Line ${finding.line}, column ${finding.column}: ` : "";
    const heading = `${index + 1}. ${place}${finding.message}${rule}`;
    const source = finding.line ? `\n   > ${(lines[finding.line - 1] ?? "").trim()}` : "";
    return heading + source;
  });

  return assemblePrompt({
    intro: "Fix the problems found in the code below.",
    task, language, sourceType, code,
    details: `Problems found:\n${problems.join("\n")}`,
    rules: LINT_FIX_RULES,
  });
}

// ---------- Finding labels and local telemetry ----------

function kindOf(finding) {
  if (finding.ruleId === "runtime" && /^The sandbox could not run the code/.test(finding.message)) return "not-checked";
  return finding.severity === "error" ? "found" : "suggestion";
}

function basisFor(finding, context = {}) {
  const id = finding.ruleId || "";
  if (id === "runtime") {
    if (/^The code did not finish/.test(finding.message)) return "the run was stopped at the time limit";
    if (/^The sandbox could not run the code/.test(finding.message)) return "the sandbox itself failed to start";
    return context.language === "python" ? "Zapple ran this code in the browser's Python" : "Zapple ran this code in a background sandbox";
  }
  if (id === "check") return "a line from the Checks box, run against this code";
  if (id === "no-undef") return "compared with names declared in this code, the browser globals and the globals box";
  if (id.startsWith("pyflakes/")) return `pyflakes ${id.slice("pyflakes/".length)}`;
  if (id.startsWith("zapple/")) {
    return context.language === "python"
      ? "name defined once in this code and never reused as a variable or parameter"
      : "read from this code's structure, without running it";
  }
  return `ESLint rule ${id}`;
}

function subjectOf(finding) {
  if (finding.ruleId === "no-undef" || finding.ruleId === "pyflakes/UndefinedName") {
    const match = /'([^']+)'/.exec(finding.message);
    return match ? match[1] : null;
  }
  return null;
}

function labelFinding(finding, context) {
  const subject = subjectOf(finding);
  return {
    ...finding,
    kind: kindOf(finding),
    basis: basisFor(finding, context),
    subject,
    key: `${finding.ruleId}|${subject ?? finding.message}`,
  };
}

function buildLogRecord({ language, sourceType, code, findings, run, session, seq, engine }) {
  return {
    v: 1,
    session, seq,
    t: Date.now(),
    lang: language === "python" ? "python" : "js",
    sourceType: sourceType ?? null,
    lines: code.split("\n").length,
    engine: engine ?? {},
    ran: {
      status: run?.status ?? "not-run",
      ms: run?.durationMs ?? null,
      skipReason: run?.reason ?? run?.skipReason ?? null,
    },
    findings: findings.map((finding) => labelFinding(finding, { language }))
      .map(({ line, ruleId, kind, basis, subject, key, message }) =>
        ({ key, rule: ruleId, kind, line, subject, message, basis })),
  };
}

// ---------- Local log (IndexedDB store: checks, counts, pairs) ----------

const ZapLog = (() => {
  const DB = 'zapple-log', KEEP = 200;
  let dbp = null, keepCode = false;
  let prev = null;

  function open() {
    if (!dbp) dbp = new Promise(resolve => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('checks', { keyPath: 'id' });
          db.createObjectStore('counts', { keyPath: 'key' });
          db.createObjectStore('pairs',  { keyPath: 'key' });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = r.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  }

  async function run(store, mode, fn) {
    const db = await open();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const t = db.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        t.onerror = t.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  const put = (s, v) => run(s, 'readwrite', o => o.put(v));
  const get = (s, k) => run(s, 'readonly',  o => o.get(k));
  const all = (s)    => run(s, 'readonly',  o => o.getAll());
  const del = (s, k) => run(s, 'readwrite', o => o.delete(k));

  async function bump(store, key, field, extra = {}) {
    const cur = (await get(store, key)) || { key, ...extra };
    cur[field] = (cur[field] || 0) + 1;
    await put(store, cur);
  }

  async function hash(text) {
    try {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
    } catch (e) { return 'nohash-' + text.length; }
  }

  const ID = /[A-Za-z_$][\w$]*$/g;
  function swapped(prevLine, nextLine, subject) {
    const a = prevLine.match(ID) || [], b = nextLine.match(ID) || [];
    const as = new Set(a), bs = new Set(b);
    const removed = a.filter(t => !bs.has(t)), added = b.filter(t => !as.has(t));
    return removed.length === 1 && added.length === 1 && removed[0] === subject ? added[0] : null;
  }

  async function compare(p, rec, code) {
    const now = new Set(rec.findings.map(f => f.key));
    const pl = p.code.split('\n'), nl = code.split('\n');
    for (const f of p.findings) {
      const ck = rec.lang + '|' + f.rule;
      if (now.has(f.key)) { await bump('counts', ck, 'stillNext'); continue; }
      await bump('counts', ck, 'goneNext');
      if (f.subject && f.line && pl.length === nl.length) {
        const to = swapped(pl[f.line - 1] || '', nl[f.line - 1] || '', f.subject);
        if (to) await bump('pairs', f.rule + '|' + f.subject + '|' + to, 'n',
                           { rule: f.rule, from: f.subject, to });
      }
    }
  }

  async function trim() {
    const rows = await all('checks');
    if (!rows || rows.length <= KEEP) return;
    rows.sort((a, b) => a.t - b.t);
    for (const r of rows.slice(0, rows.length - KEEP)) await del('checks', r.id);
  }

  return {
    setKeepCode(v) { keepCode = !!v; },

    async record(rec, code) {
      try {
        rec.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        rec.codeHash = await hash(code);
        rec.code = keepCode ? code : null;
        await put('checks', rec);
        for (const f of rec.findings) await bump('counts', rec.lang + '|' + f.rule, 'shown');
        if (prev && prev.session === rec.session) await compare(prev, rec, code);
        prev = { session: rec.session, code, findings: rec.findings };
        await trim();
      } catch (e) {}
    },

    async seenFixes(rule, subject) {
      const rows = (await all('pairs')) || [];
      return rows.filter(p => p.rule === rule && p.from === subject)
                 .sort((a, b) => b.n - a.n).slice(0, 3);
    },

    async exportJsonl() {
      const out = [];
      for (const s of ['checks', 'counts', 'pairs'])
        for (const r of (await all(s)) || []) out.push(JSON.stringify({ store: s, ...r }));
      return out.join('\n');
    },

    async clear() {
      for (const s of ['checks', 'counts', 'pairs'])
        for (const r of (await all(s)) || []) await del(s, r.key || r.id);
    }
  };
})();
