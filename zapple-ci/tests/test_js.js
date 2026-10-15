const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { load } = require("./harness");
const z = load();
const rules = (r) => [...r.errors, ...r.notes].map((f) => f.ruleId);
const has = (r, rule) => rules(r).includes(rule);

// ---- R1 loop invariant
test("R1 true positive: unchanged counter with only console.log", () => {
  assert.ok(has(z.structureProblems("let i = 0; while (i < 10) { console.log(i); }"), "zapple/unmodified-loop-condition"));
});
test("R1 no alarm: queue drained with q.shift()", () => {
  assert.ok(!has(z.structureProblems("const q=[1,2]; while (q.length > 0) { const x = q.shift(); console.log(x); }"), "zapple/unmodified-loop-condition"));
});
test("R1 no alarm: destructuring swap (gcd)", () => {
  assert.ok(!has(z.structureProblems("let a=12,b=8; while (b) { [a, b] = [b, a % b]; }"), "zapple/unmodified-loop-condition"));
});
test("R1 no alarm: state changed by a called function", () => {
  assert.ok(!has(z.structureProblems("let done=false; function step(){ done = true; } while (!done) { step(); }"), "zapple/unmodified-loop-condition"));
});
test("R1 no alarm: member mutation q[i]= / obj.x=", () => {
  assert.ok(!has(z.structureProblems("const s={n:0}; while (s.n < 3) { s.n = s.n + 1; }"), "zapple/unmodified-loop-condition"));
});
test("R1 no alarm: test itself calls something", () => {
  assert.ok(!has(z.structureProblems("const it=[1].values(); let r; while (!(r = it.next()).done) { console.log(r.value); }"), "zapple/unmodified-loop-condition"));
});

// ---- R2 unawaited async
test("R2 .then on async call is fine", () => {
  assert.ok(!has(z.structureProblems("async function load(){return 1} load().then(x=>x);"), "zapple/unawaited-async"));
});
test("R2 .catch/.finally fine", () => {
  assert.ok(!has(z.structureProblems("async function load(){return 1} load().catch(e=>e).finally(()=>1);"), "zapple/unawaited-async"));
});
test("R2 call before definition still flagged (order independent)", () => {
  assert.ok(has(z.structureProblems("const d = go().json(); async function go(){ return {json(){}} }"), "zapple/unawaited-async"));
});
test("R2 property read on async result flagged", () => {
  assert.ok(has(z.structureProblems("async function load(){return {a:1}} const v = load().a;"), "zapple/unawaited-async"));
});
test("R2 name defined twice is skipped", () => {
  assert.ok(!has(z.structureProblems("async function load(){return 1} function load2(){} function load(){return {a:1}} load().a;"), "zapple/unawaited-async"));
});

// ---- R3 lint
test("R3 function using a later const is fine", () => {
  const r = z.lintCode({ code: "function f(){ return LIMIT; }\nconst LIMIT = 3;\nconsole.log(f());", sourceType: "script", extraGlobals: [] });
  assert.deepEqual(r.errors.map((e) => e.ruleId), []);
});
test("R3 same-scope use before const still an error", () => {
  const r = z.lintCode({ code: "console.log(X);\nconst X = 3;", sourceType: "script", extraGlobals: [] });
  assert.deepEqual(r.errors.map((e) => e.ruleId), ["no-use-before-define"]);
});
test("R3 same-scope class use before declaration still an error", () => {
  const r = z.lintCode({ code: "const a = new Foo();\nclass Foo {}\nconsole.log(a);", sourceType: "script", extraGlobals: [] });
  assert.deepEqual(r.errors.map((e) => e.ruleId), ["no-use-before-define"]);
});

// ---- R6 checks box
const parse1 = (src) => z.parseChecks(src);
test("R6 trailing comment", () => {
  const r = parse1("add(2, 3) === 5 // basic");
  assert.equal(r.problems.length, 0); assert.equal(r.checks.length, 1);
  assert.ok(!r.checks[0].source.includes("//"));
});
test("R6 semicolon then comment", () => {
  const r = parse1("add(2, 3) === 5; // basic");
  assert.equal(r.problems.length, 0);
});
test("R6 fully parenthesised check", () => {
  const r = parse1("(add(2, 3) === 5)");
  assert.equal(r.problems.length, 0);
});
test("R6 two expressions still rejected", () => {
  assert.equal(parse1("a === 1 b === 2").problems.length, 1);
});
function runCheck(check, setup = "") {
  // Evaluate a generated check block in a vm with a fake worker `self`, as the worker would
  const msgs = [];
  const self = { postMessage: (m) => msgs.push(m), addEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval };
  const ctx = vm.createContext({ self, console: {} });
  vm.runInContext(`(${z.workerSetup.toString()})([])`, ctx);
  vm.runInContext(`${setup}\n${z.buildCheckSource(check, 0)}`, ctx);
  return msgs.find((m) => m.type === "check");
}
test("R6 == is loose equality", () => {
  const c = parse1("1 == '1'").checks[0];
  assert.equal(runCheck(c).passed, true);
});
test("R6 === stays strict", () => {
  const c = parse1("1 === '1'").checks[0];
  assert.equal(runCheck(c).passed, false);
});

// ---- R7 deepEqual
const eq = (a, b) => runCheck(parse1(`${a} === ${b}`).checks[0]).passed;
test("R7 different Dates are not equal", () => assert.equal(eq("new Date(1)", "new Date(2)"), false));
test("R7 same Dates are equal", () => assert.equal(eq("new Date(1)", "new Date(1)"), true));
test("R7 different RegExps are not equal", () => assert.equal(eq("/a/g", "/b/g"), false));
test("R7 same RegExps are equal", () => assert.equal(eq("/a/g", "/a/g"), true));
test("R7 different Errors are not equal", () => assert.equal(eq("new Error('x')", "new Error('y')"), false));
test("R7 same Errors are equal", () => assert.equal(eq("new Error('x')", "new Error('x')"), true));
test("R7 boxed numbers", () => assert.equal(eq("new Number(1)", "new Number(2)"), false));
test("R7 still works for arrays/objects/NaN", () => {
  assert.equal(eq("[1,{a:[2]}]", "[1,{a:[2]}]"), true);
  assert.equal(eq("[1,2]", "[1,3]"), false);
  assert.equal(eq("NaN", "NaN"), true);
});

// ---- R8 built-in typos
const typos = (code) => z.structureProblems(code).errors.filter((e) => e.ruleId === "zapple/unknown-builtin-member");
test("R8 Math.flor", () => {
  const t = typos("const x = Math.flor(2.5);");
  assert.equal(t.length, 1); assert.match(t[0].message, /Math\.floor/);
});
test("R8 string literal method typo", () => {
  const t = typos("const s = 'abc'.toUppercase();");
  assert.equal(t.length, 1); assert.match(t[0].message, /toUpperCase/);
});
test("R8 array literal contains()", () => assert.equal(typos("[1,2].contains(1);").length, 1));
test("R8 single-declared const literal receiver", () => {
  const t = typos("const names = ['a'];\nnames.pusj('b');");
  assert.equal(t.length, 1); assert.match(t[0].message, /push/);
});
test("R8 valid built-ins are quiet", () => {
  assert.equal(typos("Math.floor(1); 'a'.toUpperCase(); [1].map(x=>x); JSON.stringify({}); Object.keys({}); Number.isInteger(1);").length, 0);
});
test("R8 newer APIs on the allowlist are quiet", () => {
  assert.equal(typos("Object.groupBy([],x=>x); Promise.withResolvers(); [1].toSorted(); [1].at(-1); 'a'.replaceAll('a','b'); Array.fromAsync([]);").length, 0);
});
test("R8 shadowed name is quiet", () => {
  assert.equal(typos("const Math = { flor(){ } }; Math.flor();").length, 0);
});
test("R8 reassigned variable is quiet", () => {
  assert.equal(typos("let names = ['a']; names = {pusj(){}}; names.pusj();").length, 0);
});
test("R8 unknown receiver is quiet", () => assert.equal(typos("function f(x){ return x.contains(1); }").length, 0));

// ---- review round: false alarms found by the fresh reviewer
const flag = (code, rule) => has(z.structureProblems(code), rule);
test("RV9 Math.random in loop test is not an infinite loop", () =>
  assert.ok(!flag("let n=0; while (n < 5 && Math.random() < 0.9) { console.log('retry') }", "zapple/unmodified-loop-condition")));
test("RV7 async generator .next is fine", () =>
  assert.ok(!flag("async function* gen(){yield 1} async function main(){ const r = await gen().next() }", "zapple/unawaited-async")));
test("RV7 parameter named like an async function is not it", () =>
  assert.ok(!flag("async function load(){} function run(load){ return load().data }", "zapple/unawaited-async")));
for (const [name, code] of [
  ["in-test", "const a=[1]; if ('foo' in a) a.foo;"],
  ["optional call", "const a=[1]; a.foo?.();"],
  ["&& guard", "const a=[1]; a.contains && a.contains(1);"],
  ["if guard", "const a=[1]; if (a.contains) a.contains(1);"],
  ["defineProperty", "Object.defineProperty(Array.prototype,'last',{get(){}}); [1].last;"],
]) test(`RV8 feature detection quiet: ${name}`, () => assert.ok(!flag(code, "zapple/unknown-builtin-member")));
test("RV6 comment-only line and parenthesised equality", () => {
  assert.equal(parse1("// my checks\nadd(1,2) === 3").problems.length, 0);
  assert.equal(runCheck(parse1("(([1]) === ([1]))").checks[0]).passed, true);
});
test("RV6 comma list rejected", () => assert.equal(parse1("a === 1, b === 2").problems.length, 1));
test("RV10 skip reason does not throw on broken code", () => assert.doesNotThrow(() => z.findSkipReason("const a = 1;\n/* open", "script")));

// ---- live-test round 2
const lintErrs = (code, extra = []) => z.lintCode({ code, sourceType: "script", extraGlobals: extra }).errors;
const THREE_CODE = "const scene = new THREE.Scene();\nconst cam = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);\nconsole.log(scene, cam);";
test("L1 undeclared THREE is still an undefined-name error, with a hint about Extra names", () => {
  const e = lintErrs(THREE_CODE);
  assert.equal(e.length, 2); assert.ok(e.every((x) => x.ruleId === "no-undef"));
  assert.match(e[0].message, /Extra names/);
});
test("L1 declared THREE is clean", () => assert.deepEqual(lintErrs(THREE_CODE, ["THREE"]), []));
test("L1 a real typo'd name is still an error (not suppressed by declaring THREE)", () =>
  assert.equal(lintErrs("const a = 1; console.log(aa);", ["THREE"]).length, 1));
test("L3 loose equality in code gets no diagnostic (spec R6 is parsing only)", () => {
  const r = z.lintCode({ code: "const a = 1, b = '1'; console.log(a == b);", sourceType: "script", extraGlobals: [] });
  assert.deepEqual([...r.errors, ...r.notes].map((f) => f.ruleId), []);
});
const typoNotes = (code) => z.structureProblems(code).notes.filter((n) => n.ruleId === "zapple/possible-property-typo");
test("L4 item.quantitty near a name the code defines => note with suggestion", () => {
  const n = typoNotes("function total(items){ let t=0; for (const item of items) t += item.price * item.quantitty; return t; }\nconsole.log(total([{price:2,quantity:3}]));");
  assert.equal(n.length, 1); assert.match(n[0].message, /quantity/); assert.equal(n[0].severity, "note");
});
test("L4 correct spelling is quiet", () =>
  assert.equal(typoNotes("function total(items){ let t=0; for (const item of items) t += item.price * item.quantity; return t; }\ntotal([{price:2,quantity:3}]);").length, 0));
test("L4 property with no near-miss in the code is quiet (could be any outside object)", () =>
  assert.equal(typoNotes("const o = {name: 'x'}; function f(r){ return r.statusText + o.name; }").length, 0));
test("L4 two legitimately different names are not merged (both defined)", () =>
  assert.equal(typoNotes("const o = {width: 1, widths: [1]}; console.log(o.width, o.widths);").length, 0));
test("L4 short names never flagged", () =>
  assert.equal(typoNotes("const o = {id: 1}; console.log(o.ids);").length, 0));
test("L4 built-in members are never treated as typos of own names", () =>
  assert.equal(typoNotes("const o = {lengths: 1}; console.log([1].length, o.lengths);").length, 0));
test("L4 feature detection quiet", () =>
  assert.equal(typoNotes("const o = {quantity: 1}; if (o.quantitty) console.log(o.quantitty);").length, 0));
