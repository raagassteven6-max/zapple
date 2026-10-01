"use strict";

// ---------- Display ----------
const codeInput   = document.getElementById("code-input");
const languageSelect = document.getElementById("language");
const taskInput   = document.getElementById("task-input");
const globalsInput = document.getElementById("globals-input");
const checksInput = document.getElementById("checks-input");
const resultPanel = document.getElementById("result");
const checkButton = document.getElementById("check-button");
const log = createLog(document.getElementById("log-output"));

/** Creates an element with optional class and text (textContent keeps pasted code inert). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showResult(...nodes) {
  resultPanel.replaceChildren(...nodes);
}

function buildMessageBox(kind, title, detail) {
  const box = el("div", `result ${kind}`);
  box.append(el("p", "result-title", title));
  if (detail) box.append(el("p", "result-detail", detail));
  return box;
}

function showMessage(kind, title, detail) {
  showResult(buildMessageBox(kind, title, detail));
}

/** Shows the bad line with a caret under the problem column. */
function buildCodeFrame({ line, column, sourceLine }) {
  const gutter = `${line} | `;
  // Keep tabs as tabs so the caret lines up with the code above it
  const padding = sourceLine.slice(0, column - 1).replace(/[^\t]/g, " ");
  const caretLine = " ".repeat(gutter.length) + padding + "^";
  return el("pre", "code-frame", `${gutter}${sourceLine}\n${caretLine}`);
}

function showSyntaxError(problem, promptText) {
  const box = el("div", "result error");
  const jumpButton = el("button", "", `Go to line ${problem.line}`);
  jumpButton.type = "button";
  jumpButton.addEventListener("click", () => selectLine(problem.line));

  box.append(
    el("p", "result-title", "Syntax error"),
    el("p", "result-detail", `${problem.message} (line ${problem.line}, column ${problem.column})`),
    buildCodeFrame(problem),
    jumpButton
  );
  showResult(box, buildPromptSection(promptText));
}

/** The repair prompt in a read-only box, with a button that copies it. */
function buildPromptSection(promptText) {
  const label = el("label", "", "Repair prompt");
  label.htmlFor = "prompt-output";

  const promptBox = el("textarea", "prompt-box");
  promptBox.id = "prompt-output";
  promptBox.readOnly = true;
  promptBox.value = promptText;

  const copyButton = el("button", "primary", "Copy repair prompt");
  copyButton.type = "button";
  copyButton.addEventListener("click", () => copyPrompt(promptBox, copyButton));

  const section = el("div", "prompt-section");
  section.append(label, promptBox, copyButton);
  return section;
}

async function copyPrompt(promptBox, button) {
  try {
    await navigator.clipboard.writeText(promptBox.value);
    flashLabel(button, "Copied");
  } catch {
    // Clipboard blocked: select the text so it can be copied by hand
    promptBox.focus();
    promptBox.select();
    flashLabel(button, "Selected. Copy it manually");
  }
}

/** Shows a message on a button for two seconds, then restores its label. */
function flashLabel(button, message) {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => { button.textContent = original; }, 2000);
}

function countLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One tappable row per finding; tapping jumps to that line in the code box. */
function buildFindingList(findings) {
  const list = el("ul", "finding-list");
  for (const finding of findings) {
    const label = finding.line ? `Line ${finding.line}: ${finding.message}` : finding.message;
    const row = el("button", "finding", label);
    row.type = "button";
    if (finding.line) row.addEventListener("click", () => selectLine(finding.line));
    const item = el("li");
    item.append(row);
    list.append(item);
  }
  return list;
}

function buildFindingsBox(kind, title, findings) {
  const box = el("div", `result ${kind}`);
  box.append(el("p", "result-title", title), buildFindingList(findings));
  return box;
}

/** Why the test run was skipped, in plain words: the cause, what still ran, what did not, and what to do. */
function describeSkippedRun(run) {
  return [
    "No errors found by the checks that ran, but the code itself was not test-run.",
    `Why: ${run.reason}`,
    "Still checked: everything except the test run.",
    "Not checked: the test run itself, and your Checks (they run as part of the test run).",
    run.tip ? `Tip: ${run.tip}` : null,
  ].filter(Boolean).join("\n\n");
}

function describeRunOutcome(run) {
  if (run.status === "skipped") return describeSkippedRun(run);
  const checks = run.checkCount > 0 ? ` All ${countLabel(run.checkCount, "check")} passed.` : "";
  return `No errors found. The code ran without crashing (${run.durationMs} ms).${checks}`;
}

/** A titled box of preformatted text (used for the call map and the console output). */
function buildTextBox(title, text) {
  const box = el("div", "result note");
  box.append(el("p", "result-title", title), el("pre", "code-frame", text));
  return box;
}

/** Shows errors (with the repair prompt), notes, and what the code printed during the test run. */
function showReport({ errors, notes, callMap, run, promptText }) {
  const blocks = [];

  if (errors.length === 0) {
    blocks.push(buildMessageBox("ok", "OK", describeRunOutcome(run)));
  } else {
    blocks.push(buildFindingsBox("error", countLabel(errors.length, "problem"), errors));
  }
  if (notes.length > 0) {
    blocks.push(buildFindingsBox("note", countLabel(notes.length, "note"), notes));
  }
  if (callMap) {
    blocks.push(buildTextBox("Call map", callMap));
  }
  if (run.output.length > 0) {
    blocks.push(buildTextBox("Console output", run.output.join("\n")));
  }
  if (promptText) {
    blocks.push(buildPromptSection(promptText));
  }
  showResult(...blocks);
}

/** Highlights a line inside the textarea so it can be fixed right away. */
function selectLine(lineNumber) {
  const lines = codeInput.value.split("\n");
  const start = lines.slice(0, lineNumber - 1).reduce((sum, text) => sum + text.length + 1, 0);
  codeInput.focus();
  codeInput.setSelectionRange(start, start + lines[lineNumber - 1].length);
}

// ---------- Wiring ----------

/** The Python version of the Check button: syntax, then pyflakes rules, then a test run of standard-library code. */
async function checkPython(request) {
  const analysis = await runPythonAnalysis({
    code: request.code,
    extraNames: request.extraGlobals,
    checks: request.checksText.split("\n").map((line) => line.trim()).filter(Boolean),
  }, log);

  if (analysis.internalError) throw new Error(analysis.internalError);
  if (analysis.workerFailed) {
    log.add(`Python stopped unexpectedly: ${analysis.workerFailed}`);
    throw new Error(`Python stopped unexpectedly (${analysis.workerFailed}). It restarts on the next check, which takes a few extra seconds.`);
  }

  if (analysis.timedOut) {
    const seconds = RUN_TIMEOUT_MS / 1000;
    log.add(`Timeout: the code did not finish within ${seconds} s. Python was stopped and restarts on the next check`);
    const errors = [runtimeFinding(`The code did not finish within ${seconds} seconds (possible infinite loop or endless wait)`)];
    showReport({ errors, notes: [], callMap: "", run: skippedRun(), promptText: buildLintPrompt({ ...request, errors }) });
    return;
  }

  if (analysis.blanked > 0) {
    log.add(`Replaced ${countLabel(analysis.blanked, "notebook command line")} (like !pip or %magic) with "pass", keeping line numbers`);
  }
  if (analysis.syntax) {
    log.add(`Syntax check: error at line ${analysis.syntax.line}`);
    showSyntaxError(analysis.syntax, buildSyntaxPrompt({ ...request, problem: analysis.syntax }));
    return;
  }
  log.add("Syntax check: passed");
  log.add(`Rule check and structure check (pyflakes + Zapple): ${countLabel(analysis.errors.length, "error")}, ${countLabel(analysis.notes.length, "note")}`);
  if (analysis.structureFailed) {
    log.add(`Structure check could not finish (${analysis.structureFailed}). The other checks still ran`);
  } else {
    log.add(`Structure check: ${countLabel(analysis.structureCount, "definition")} found`);
  }

  let run;
  if (analysis.errors.length > 0) {
    run = skippedRun(FIX_FIRST.reason, FIX_FIRST.tip);
  } else if (analysis.skipReason) {
    run = skippedRun(analysis.skipReason, PYTHON_SKIP_TIP);
  } else {
    run = { status: "finished", errors: analysis.runErrors, output: analysis.output, durationMs: analysis.elapsedMs, checkCount: analysis.checkCount };
  }

  if (run.status === "skipped") {
    log.add(`Test run skipped: ${run.reason}`);
  } else {
    run.output.forEach((line) => log.add(`print: ${line}`));
    run.errors.forEach((problem) => log.add(`Problem: ${problem.message}${problem.line ? ` (line ${problem.line})` : ""}`));
    log.add(`Test run complete (${run.durationMs} ms, including your checks)`);
  }

  const errors = [...analysis.errors, ...run.errors];
  const promptText = errors.length > 0 ? buildLintPrompt({ ...request, errors }) : null;
  showReport({ errors, notes: analysis.notes, callMap: analysis.callMap, run, promptText });
}

/**
 * The structure check with its own safety net: if it hits a bug, the other results still show
 * (the Python side has the same protection). Returns { problems, callMap }.
 */
function checkStructureSafely(request) {
  try {
    const structure = analyzeStructure(request.code, request.sourceType);
    const problems = findStructureProblems(structure);
    log.add(`Structure check: ${countLabel(structure.functions.size, "function")} found, `
      + `${countLabel(problems.errors.length, "error")}, ${countLabel(problems.notes.length, "note")}`);
    return { problems, callMap: buildCallMap(structure) };
  } catch (error) {
    log.add(`Structure check could not finish (${error.message}). The other checks still ran`);
    return { problems: { errors: [], notes: [] }, callMap: "" };
  }
}

// A very large paste can freeze the page, because the checks run inside it.
const MAX_CODE_CHARS = 200000;   // roughly 5,000 lines

async function handleCheck() {
  if (typeof acorn === "undefined") {
    showMessage("error", "Parser not loaded", "Check your internet connection and reload the page.");
    return;
  }
  if (codeInput.value.trim() === "") {
    showMessage("error", "Nothing to check", "Paste some code first.");
    return;
  }
  if (codeInput.value.length > MAX_CODE_CHARS) {
    log.reset();
    log.add(`Check refused: ${codeInput.value.length.toLocaleString()} characters is over the limit of ${MAX_CODE_CHARS.toLocaleString()}`);
    showMessage("error", "Code is too large to check",
      "Zapple checks code inside this web page, and a very large paste can freeze the page.\n\n"
      + `The limit is ${MAX_CODE_CHARS.toLocaleString()} characters (roughly 5,000 lines). Your code has ${codeInput.value.length.toLocaleString()}.\n\n`
      + "Tip: check one part at a time, for example one class or a few related functions.");
    return;
  }

  log.reset();
  const request = {
    code: codeInput.value,
    language: languageSelect.value,
    task: taskInput.value.trim(),
    extraGlobals: parseNameList(globalsInput.value),
    checksText: checksInput.value,
  };
  log.add(`Check started: ${request.language}, ${countLabel(request.code.split("\n").length, "line")}`);

  if (request.language === "python") {
    await checkPython(request);
    return;
  }

  const syntax = checkSyntaxInBothModes(request.code, log);
  if (!syntax.ok) {
    log.add(`Syntax check: error at line ${syntax.problem.line}`);
    showSyntaxError(syntax.problem, buildSyntaxPrompt({ ...request, problem: syntax.problem }));
    return;
  }
  request.sourceType = syntax.sourceType;
  log.add(`Syntax check: passed (detected ${syntax.sourceType === "module" ? "module" : "plain script"})`);

  if (typeof eslint === "undefined") {
    log.add("Rule check: could not load ESLint");
    showMessage("error", "Rule checker not loaded",
      "The syntax is valid, but the rule checker could not load. Check your internet connection and reload the page.");
    return;
  }

  const lint = lintCode(request);
  log.add(`Rule check: ${countLabel(lint.errors.length, "error")}, ${countLabel(lint.notes.length, "note")}`);

  const structure = checkStructureSafely(request);

  const staticErrors = [...lint.errors, ...structure.problems.errors];
  const notes = [...lint.notes, ...structure.problems.notes];

  // Only test-run code that passed the static checks, so the same problem is not reported twice
  const run = staticErrors.length === 0
    ? await runInSandbox({ ...request, log })
    : skippedRun(FIX_FIRST.reason, FIX_FIRST.tip);
  if (run.status === "skipped") log.add(`Sandbox skipped: ${run.reason}`);

  const errors = [...staticErrors, ...run.errors];
  const promptText = errors.length > 0 ? buildLintPrompt({ ...request, errors }) : null;
  showReport({ errors, notes, callMap: structure.callMap, run, promptText });
}

function handleClear() {
  codeInput.value = "";
  showResult();
  log.reset();
  codeInput.focus();
}

checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;   // no second run while the sandbox is busy
  try {
    await handleCheck();
  } catch (error) {
    log.add(`Unexpected error: ${error.message}`);
    showMessage("error", "Something went wrong", error.message);
  } finally {
    checkButton.disabled = false;
  }
});
// The hint texts follow the chosen language, so the boxes always describe what to type there
const LANGUAGE_HINTS = {
  javascript: {
    code: "Paste JavaScript here",
    names: "Names from libraries you load, like THREE, Chart",
    checksLabel: "Checks (optional): one JavaScript expression per line",
    checks: "add(2, 3) === 5",
  },
  python: {
    code: "Paste Python here",
    names: "Names defined in earlier notebook cells, like df, model",
    checksLabel: "Checks (optional): one Python expression per line",
    checks: "add(2, 3) == 5",
  },
};

function applyLanguage() {
  const hints = LANGUAGE_HINTS[languageSelect.value];
  codeInput.placeholder = hints.code;
  globalsInput.placeholder = hints.names;
  checksInput.placeholder = hints.checks;
  document.getElementById("checks-label").textContent = hints.checksLabel;
}

languageSelect.addEventListener("change", applyLanguage);
document.getElementById("clear-button").addEventListener("click", handleClear);
