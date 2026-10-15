// Runs the structure checks over lots of real, valid JS and lists everything the new/changed checks report.
const fs = require("fs"), path = require("path");
const { load } = require("./harness");
const z = load(process.argv[3] || undefined);
const root = process.argv[2];
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory()) { if (files.length < 4000) walk(p); } else if (/\.(c?js|mjs)$/.test(e.name) && fs.statSync(p).size < 300000) files.push(p);
} })(root);
const counts = {}; const shown = {};
let parsed = 0;
for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  let r;
  try { r = z.structureProblems(code, "script"); } catch { try { r = z.structureProblems(code, "module"); } catch { continue; } }
  parsed++;
  for (const x of [...r.errors, ...r.notes]) {
    counts[x.ruleId] = (counts[x.ruleId] || 0) + 1;
    if (["zapple/possible-property-typo"].includes(x.ruleId) && (shown[x.ruleId] = (shown[x.ruleId]||0)+1) <= 30)
      console.log(x.ruleId, path.relative(root, f) + ":" + x.line, x.message.slice(0, 140));
  }
}
console.log("files parsed:", parsed, counts);
