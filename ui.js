"use strict";

// ---------- Display ----------
const codeInput   = document.getElementById("code-input");
const languageSelect = document.getElementById("language");
const taskInput   = document.getElementById("task-input");
const globalsInput = document.getElementById("globals-input");
const checksInput = document.getElementById("checks-input");
const resultPanel = document.getElementById("result");
const checkButton = document.getElementById("check-button");
const emptyState  = document.getElementById("empty");     // "Nothing checked yet" card on the Results tab
const summaryBox  = document.getElementById("summary");   // ring, verdict and tiles on the Results tab
const liveStatus  = document.getElementById("live");      // read aloud by screen readers when a check finishes
const log = createLog(document.getElementById("log-output"));

/** Tells the mascot what happened ("checking", "pass", "fail", "cantrun"). Safe if bot.js did not load. */
function botState(state, message) {
  if (typeof window.setBotState === "function") window.setBotState(state, message);
}

/** Creates an element with optional class and text (textContent keeps pasted code inert). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Puts boxes into the Results tab and switches to it. Boxes with the class "side" (repair prompt,
 * call map, console output) form a second column on wide screens; the rest form the first.
 * Called with nothing, it empties the tab (used by Clear).
 */
function showResult(...nodes) {
  const column = (className, items) => {
    const wrap = el("div", className);
    wrap.append(...items);
    return wrap;
  };
  const side = nodes.filter((node) => node.classList.contains("side"));
  const main = nodes.filter((node) => !node.classList.contains("side"));
  const columns = [];
  if (main.length > 0) columns.push(column("res-main", main));
  if (side.length > 0) columns.push(column("res-side", side));

  resultPanel.classList.toggle("two", columns.length === 2);
  resultPanel.replaceChildren(...columns);
  emptyState.hidden = nodes.length > 0;
  if (nodes.length === 0) {
    setSummary(null);
  } else {
    goToTab("results");
  }
}

/**
 * Fills the ring, verdict and three tiles at the top of the Results tab. Pass null to hide them.
 * tone is "good", "warn" or "bad"; tiles is [Problems, Notes, Checks passed], each { value, sub, tone }.
 */
function setSummary(summary) {
  if (!summary) {
    summaryBox.hidden = true;
    return;
  }
  const { tone, headline, detail, tiles } = summary;
  summaryBox.dataset.tone = tone;
  summaryBox.hidden = false;

  const ring = { good: ["✓", "Clear"], warn: ["!", "Not run"], bad: [String(tiles[0].value), "Problems"] }[tone];
  document.getElementById("ring-main").textContent = ring[0];
  document.getElementById("ring-sub").textContent = ring[1];
  document.getElementById("verdict-head").textContent = headline;
  document.getElementById("verdict-sub").textContent = detail;
  ["problems", "notes", "checks"].forEach((name, index) => {
    const number = document.getElementById(`tile-${name}`);
    number.textContent = tiles[index].value;
    number.dataset.tone = tiles[index].tone;
    document.getElementById(`tile-${name}-sub`).textContent = tiles[index].sub;
  });

  // Redraw the ring from empty. Two animation frames wait until the Results tab is on screen.
  const arc = document.getElementById("ring-arc");
  arc.style.transition = "none";
  arc.style.strokeDashoffset = "439.8";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.style.transition = "";
    arc.style.strokeDashoffset = "0";
  }));
  liveStatus.textContent = headline;
}

/** "JavaScript · 16 lines · checked 17:42", the small line under the verdict. */
function summaryDetail() {
  const lines = codeInput.value.split("\n").length;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${languageSelect.selectedOptions[0].textContent} · ${countLabel(lines, "line")} · checked ${time}`;
}

function buildReportSummary({ errors, notes, run }) {
  const skipped = run.status === "skipped";
  const clean = errors.length === 0;
  let checks;
  if (clean && !skipped) {
    const count = run.checkCount ?? 0;
    checks = { value: count, sub: count > 0 ? "all passed" : "none written", tone: count > 0 ? "good" : "" };
  } else {
    checks = { value: "–", sub: skipped ? "not run" : "see problems", tone: "" };
  }
  return {
    tone: !clean ? "bad" : skipped ? "warn" : "good",
    headline: !clean ? `Hold: ${countLabel(errors.length, "problem")} to fix`
      : skipped ? "No errors, but not test-run" : "Clear to use",
    detail: summaryDetail(),
    tiles: [
      { value: errors.length, sub: clean ? "none found" : "to fix", tone: clean ? "good" : "bad" },
      { value: notes.length, sub: notes.length > 0 ? "worth a look" : "none", tone: notes.length > 0 ? "warn" : "" },
      checks,
    ],
  };
}

function buildMessageBox(kind, title, detail) {
  const box = el("div", `result ${kind}`);
  box.append(el("p", "result-title", title));
  if (detail) box.append(el("p", "result-detail", detail));
  return box;
}

function showMessage(kind, title, detail) {
  setSummary(null);              // a plain message is not a verdict, so no ring or tiles
  liveStatus.textContent = title;
  botState("cantrun", title);    // "Nothing to check", "Parser not loaded"...: nothing was verified
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

function showSyntaxError(problem, promptText, request) {
  const box = el("div", "result error");
  const jumpButton = el("button", "btn sm", `Go to line ${problem.line}`);
  jumpButton.type = "button";
  jumpButton.addEventListener("click", () => selectLine(problem.line));

  box.append(
    el("p", "result-title", "Syntax error"),
    el("p", "result-detail", `${problem.message} (line ${problem.line}, column ${problem.column})`),
    buildCodeFrame(problem),
    jumpButton
  );
  const notReached = { value: "–", sub: "not reached", tone: "" };
  setSummary({
    tone: "bad",
    headline: "Hold: syntax error",
    detail: `Line ${problem.line}, column ${problem.column}`,
    tiles: [{ value: 1, sub: "to fix", tone: "bad" }, notReached, notReached],
  });
  botState("fail");
  saveToHistory(request, [{ ...problem, ruleId: "syntax", severity: "error" }], skippedRun(FIX_FIRST.reason, FIX_FIRST.tip));
  const syntaxFinding = { ...problem, ruleId: "syntax", severity: "error" };
  const packetBox = buildPacketSection({
    request, errors: [syntaxFinding], notes: [], run: skippedRun(FIX_FIRST.reason, FIX_FIRST.tip), callMap: "",
    untraced: { count: 0, samples: [] },
  });
  showResult(box, buildPromptSection(promptText), ...(packetBox ? [packetBox] : []));
}

/** The repair prompt in a read-only box, with a button that copies it. */
function buildPromptSection(promptText) {
  const label = el("label", "", "Repair prompt");
  label.htmlFor = "prompt-output";

  const promptBox = el("textarea", "prompt-box");
  promptBox.id = "prompt-output";
  promptBox.readOnly = true;
  promptBox.value = promptText;

  const copyButton = el("button", "btn", "Copy repair prompt");
  copyButton.type = "button";
  copyButton.addEventListener("click", () => copyPrompt(promptBox, copyButton));

  const hint = el("p", "hint", "Every problem in one message, so one round trip to the AI is enough.");

  const section = el("div", "prompt-section side");
  section.append(label, promptBox, copyButton, hint);
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

/**
 * The evidence packet: everything Zapple knows as one text for any AI (built by buildEvidencePacket in checks.js).
 * A foldable box with a Copy button. If it cannot be built, the report still shows without it.
 */
function buildPacketSection({ request, errors, notes, run, callMap, untraced }) {
  if (!request) return null;
  let packetText;
  try {
    packetText = buildEvidencePacket({ ...request, errors, notes, run, callMap, untraced });
  } catch (error) {
    log.add(`Could not build the evidence packet (${error.message}). The result is not affected`);
    return null;
  }
  const preview = el("pre", "code-frame", packetText);
  const copyButton = el("button", "btn", "Copy evidence packet");
  copyButton.type = "button";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(packetText);
      flashLabel(copyButton, "Copied");
    } catch {
      // Clipboard blocked: select the text so it can be copied by hand
      getSelection().selectAllChildren(preview);
      flashLabel(copyButton, "Selected. Copy it manually");
    }
  });
  const box = el("details", "result note textbox side");
  box.append(
    el("summary", "result-title", "Evidence packet"),
    el("p", "hint", "Everything Zapple found, in one message. Paste it into any AI chat to get an analysis that knows what was and was not verified."),
    copyButton,
    preview
  );
  return box;
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

/** One row per finding. With a line number it is a button that jumps to that line in the code box. */
function buildFindingList(findings) {
  const list = el("ul", "finding-list");
  for (const finding of findings) {
    const row = el(finding.line ? "button" : "div", "finding");
    if (finding.line) {
      row.type = "button";
      row.append(el("span", "chip", `Line ${finding.line}`));
      row.addEventListener("click", () => selectLine(finding.line));
    }
    row.append(el("span", "finding-text", finding.message));
    const item = el("li");
    item.append(row);
    list.append(item);
  }
  return list;
}

function buildFindingsBox(kind, title, findings) {
  const box = el("div", `result ${kind}${kind === "note" ? " flagged" : ""}`);
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

/** A foldable, titled box of preformatted text (used for the call map and the console output). */
function buildTextBox(title, text, open = false) {
  const box = el("details", "result note textbox side");
  box.open = open;
  box.append(el("summary", "result-title", title), el("pre", "code-frame", text));
  return box;
}

/** Plain-language summary of what Zapple found, on top of the technical output. */
function buildInsightBox({ errors, notes, run, untraced }) {
  const lines = [];

  if (errors.length > 0) {
    lines.push(`${countLabel(errors.length, "problem")} found. The technical list is below, `
      + "and a ready-made repair prompt you can paste to an AI is included at the end.");
  } else {
    lines.push("No problems were found by any check.");
  }

  if (run.status === "skipped") {
    lines.push(`The test run was skipped: ${run.reason}`);
  } else if (errors.length === 0) {
    const checks = run.checkCount > 0 ? ` All ${countLabel(run.checkCount, "check")} passed.` : "";
    lines.push(`The code ran without crashing (${run.durationMs} ms).${checks}`);
  } else {
    lines.push("The test run did not happen because errors were found earlier; fix those first.");
  }

  if (untraced.count > 0) {
    const example = untraced.samples.length > 0 ? ` (for example ${untraced.samples.join(", ")})` : "";
    lines.push(`${countLabel(untraced.count, "call")} could not be traced by reading the code${example}. `
      + "The runtime section below shows what actually executed.");
  }

  if (notes.length > 0) {
    lines.push(`${countLabel(notes.length, "note")}: worth a look, but not necessarily mistakes.`);
  }

  const box = el("div", "result note insight");
  box.append(el("p", "result-title", "Insight"), el("p", "result-detail", lines.join("\n")));
  return box;
}

/** Shows errors (with the repair prompt), notes, and what the code printed during the test run. */
function showReport({ errors, notes, callMap, run, promptText, request, untraced = { count: 0, samples: [] } }) {
  const blocks = [buildInsightBox({ errors, notes, run, untraced })];

  if (errors.length === 0) {
    blocks.push(buildMessageBox("ok", "OK", describeRunOutcome(run)));
  } else {
    blocks.push(buildFindingsBox("error", countLabel(errors.length, "problem"), errors));
  }
  if (notes.length > 0) {
    blocks.push(buildFindingsBox("note", countLabel(notes.length, "note"), notes));
  }
  // The repair prompt comes first among the side boxes, because it is what most people want next
  if (promptText) {
    blocks.push(buildPromptSection(promptText));
  }
  if (callMap) {
    blocks.push(buildTextBox("Call map", callMap));
  }
  if (run.output.length > 0) {
    blocks.push(buildTextBox("Console output", run.output.join("\n"), true));
  }
  const packetBox = buildPacketSection({ request, errors, notes, run, callMap, untraced });
  if (packetBox) blocks.push(packetBox);
  setSummary(buildReportSummary({ errors, notes, run }));
  botState(errors.length > 0 ? "fail" : run.status === "skipped" ? "cantrun" : "pass");
  saveToHistory(request, [...errors, ...notes], run);
  showResult(...blocks);
}

/** Highlights a line inside the textarea so it can be fixed right away. */
function selectLine(lineNumber) {
  goToTab("code");    // the code box lives on the Code tab
  const lines = codeInput.value.split("\n");
  const start = lines.slice(0, lineNumber - 1).reduce((sum, text) => sum + text.length + 1, 0);
  codeInput.focus();
  codeInput.setSelectionRange(start, start + lines[lineNumber - 1].length);
}

// ---------- Saved history (this device only) ----------
// Every finished check is saved in this browser's IndexedDB by ZapLog: what was found, why, and
// whether the next check shows it fixed. Nothing is sent anywhere. The code itself is not saved unless
// the switch on the Log tab is on. If saving fails (private window, blocked storage), checks still work.

const historyStatus = document.getElementById("history-status");
const keepCodeSwitch = document.getElementById("keep-code");
const exportButton = document.getElementById("export-button");
const forgetButton = document.getElementById("forget-button");

const SESSION_ID = (crypto.randomUUID?.() ?? `s${Date.now().toString(36)}`);
let checkNumber = 0;

function engineInfo() {
  return { acorn: typeof acorn !== "undefined" ? acorn.version : null };
}

/** Saves one finished check. Never throws and never makes the user wait: the report is already on screen. */
function saveToHistory(request, findings, run) {
  try {
    if (!request || typeof ZapLog === "undefined") return;
    checkNumber += 1;
    const record = buildLogRecord({
      language: request.language, sourceType: request.sourceType, code: request.code,
      findings, run, session: SESSION_ID, seq: checkNumber, engine: engineInfo(),
    });
    ZapLog.record(record, request.code).then(refreshHistory);
  } catch (error) {
    log.add(`Could not save this check (${error.message}). The result above is not affected`);
  }
}

async function refreshHistory() {
  if (typeof ZapLog === "undefined") return;
  const stats = await ZapLog.stats();
  const unavailable = stats === null;
  exportButton.disabled = unavailable || stats.checks === 0;
  forgetButton.disabled = unavailable || stats.checks === 0;
  historyStatus.textContent = unavailable
    ? "Saving is not available in this browser (a private window can cause this). Checks still work normally."
    : stats.checks === 0
      ? "Nothing saved yet. Each check you run will be saved here, on this device only."
      : `${countLabel(stats.checks, "check")} saved on this device. Nothing is sent anywhere.`;
}

function readKeepCodeChoice() {
  try { return localStorage.getItem("zapple-keep-code") === "1"; } catch { return false; }
}

keepCodeSwitch.checked = readKeepCodeChoice();
if (typeof ZapLog !== "undefined") ZapLog.setKeepCode(keepCodeSwitch.checked);
keepCodeSwitch.addEventListener("change", () => {
  ZapLog.setKeepCode(keepCodeSwitch.checked);
  try { localStorage.setItem("zapple-keep-code", keepCodeSwitch.checked ? "1" : "0"); } catch { /* the choice just will not be remembered */ }
});

exportButton.addEventListener("click", async () => {
  const text = await ZapLog.exportJsonl();
  if (!text) { flashLabel(exportButton, "Nothing to export"); return; }
  const link = el("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  link.download = `zapple-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

forgetButton.addEventListener("click", async () => {
  if (!confirm("Delete every saved check on this device? This cannot be undone.")) return;
  await ZapLog.clear();
  await refreshHistory();
});

refreshHistory();

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
    showReport({ errors, notes: [], callMap: "", run: skippedRun(), promptText: buildLintPrompt({ ...request, errors }), request, untraced: { count: 0, samples: [] } });
    return;
  }

  if (analysis.blanked > 0) {
    log.add(`Replaced ${countLabel(analysis.blanked, "notebook command line")} (like !pip or %magic) with "pass", keeping line numbers`);
  }
  if (analysis.syntax) {
    log.add(`Syntax check: error at line ${analysis.syntax.line}`);
    showSyntaxError(analysis.syntax, buildSyntaxPrompt({ ...request, problem: analysis.syntax }), request);
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
  showReport({
    errors, notes: analysis.notes, callMap: analysis.callMap, run, promptText, request,
    untraced: { count: analysis.untracedCalls ?? 0, samples: [] },
  });
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
    const callMapResult = buildCallMap(structure);
    return { problems, callMap: callMapResult.text, untraced: { count: callMapResult.stats.notFollowed, samples: callMapResult.stats.notFollowedSamples } };
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
    showSyntaxError(syntax.problem, buildSyntaxPrompt({ ...request, problem: syntax.problem }), request);
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
  showReport({ errors, notes, callMap: structure.callMap, run, promptText, request, untraced: structure.untraced });
}

function handleClear() {
  codeInput.value = "";
  showResult();
  log.reset();
  codeInput.focus();
}

checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;   // no second run while the sandbox is busy
  checkButton.textContent = "Checking…";
  botState("checking");
  try {
    await handleCheck();
  } catch (error) {
    log.add(`Unexpected error: ${error.message}`);
    showMessage("error", "Something went wrong", error.message);
  } finally {
    checkButton.disabled = false;
    checkButton.textContent = "Check";
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

// ---------- Tabs ----------
const TAB_NAMES = ["code", "results", "log"];

/** Shows one tab and hides the other two. */
function goToTab(name, { focus = false } = {}) {
  for (const tabName of TAB_NAMES) {
    const selected = tabName === name;
    const tab = document.getElementById(`t-${tabName}`);
    document.getElementById(`p-${tabName}`).hidden = !selected;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  window.scrollTo({ top: 0 });
}

TAB_NAMES.forEach((name, index) => {
  const tab = document.getElementById(`t-${name}`);
  tab.addEventListener("click", () => goToTab(name));
  // Arrow keys, Home and End move between tabs, as people expect from a tab bar
  tab.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let target;
    if (step) target = TAB_NAMES[(index + step + TAB_NAMES.length) % TAB_NAMES.length];
    else if (event.key === "Home") target = TAB_NAMES[0];
    else if (event.key === "End") target = TAB_NAMES[TAB_NAMES.length - 1];
    if (!target) return;
    event.preventDefault();
    goToTab(target, { focus: true });
  });
});

// ---------- JS / PY pill switch ----------
// The hidden <select id="language"> is still the one real language control; the pills just drive it.
const languagePills = document.querySelectorAll("[data-lang]");

function syncLanguagePills() {
  for (const pill of languagePills) {
    pill.setAttribute("aria-pressed", String(pill.dataset.lang === languageSelect.value));
  }
}

for (const pill of languagePills) {
  pill.addEventListener("click", () => {
    languageSelect.value = pill.dataset.lang;
    languageSelect.dispatchEvent(new Event("change"));   // runs applyLanguage, same as the old dropdown did
  });
}
languageSelect.addEventListener("change", syncLanguagePills);

// Browsers can restore an old selection on reload, so bring the hint texts and pills in line with it
applyLanguage();
syncLanguagePills();
