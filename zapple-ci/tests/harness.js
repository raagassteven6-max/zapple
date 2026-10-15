// Loads checks.js into a vm context with real acorn (node-internal) and real ESLint Linter.
// Run with: npm test
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
// CI installs acorn and eslint from npm. The fallbacks only exist so the tests also run in offline sandboxes.
const first = (...loaders) => { for (const load of loaders) { try { return load(); } catch {} } throw new Error("acorn/eslint not found: run npm install"); };
const acorn = first(() => require("acorn"), () => require("internal/deps/acorn/acorn/dist/acorn"));
const { Linter } = first(() => require("eslint"), () => require("/opt/node-tools/node_modules/eslint"));

function load(file = path.join(__dirname, "..", "checks.js")) {
  const ctx = vm.createContext({
    acorn, eslint: { Linter }, performance, URL, console, setTimeout, clearTimeout,
    BROWSER_GLOBALS: ["console", "setTimeout", "document", "window", "fetch", "localStorage"],
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: "checks.js" });
  const names = ["analyzeStructure", "findStructureProblems", "lintCode", "parseChecks", "buildCheckSource",
    "buildWorkerSource", "workerSetup", "checkSyntaxInBothModes", "buildCallMap", "findSkipReason"];
  const api = vm.runInContext(`({${names.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(",")}})`, ctx);
  api.ctx = ctx;
  api.structureProblems = (code, sourceType = "script") => {
    const s = api.analyzeStructure(code, sourceType);
    return api.findStructureProblems(s);
  };
  return api;
}
module.exports = { load, acorn };
