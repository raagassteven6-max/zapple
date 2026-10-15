"""Browser tests for the JS sandbox (Playwright + Chromium). Usage: python3 test_sandbox.py [path/to/checks.js]"""
import http.server, json, os, shutil, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
checks = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "checks.js")
root = tempfile.mkdtemp()
for f in os.listdir(os.path.join(HERE, "fixtures")):
    shutil.copy(os.path.join(HERE, "fixtures", f), root)
npm_acorn = os.path.join(HERE, "..", "node_modules", "acorn", "dist", "acorn.js")
if os.path.exists(npm_acorn):                      # CI: the same acorn the page loads from the CDN
    shutil.copy(npm_acorn, os.path.join(root, "acorn.js"))
elif not os.path.exists(os.path.join(root, "acorn.js")):
    sys.exit("acorn.js missing: run npm install first")
shutil.copy(checks, os.path.join(root, "checks.js"))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), Quiet); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

RUN = """async ({code, checks, extra, sourceType}) => {
  const lines = [];
  const log = { add: (m) => lines.push(m) };
  const t0 = performance.now();
  const r = await runInSandbox({ code, sourceType: sourceType || 'script', checksText: checks || '', extraGlobals: extra || [], log });
  r.wallMs = Math.round(performance.now() - t0);
  return r;
}"""

results = []
def case(name, code, expect, checks="", extra=None, sourceType=None, max_ms=None):
    r = page.evaluate(RUN, {"code": code, "checks": checks, "extra": extra, "sourceType": sourceType})
    problems = []
    for key, want in expect.items():
        got = r.get(key)
        if key == "errors": got = [e["message"].split(":")[0] for e in r["errors"]]; 
        if key == "errorCount": got = len(r["errors"])
        if callable(want): ok = want(got)
        else: ok = got == want
        if not ok: problems.append(f"{key}: got {got!r}, wanted {want!r}")
    if max_ms and r["wallMs"] > max_ms: problems.append(f"took {r['wallMs']} ms (> {max_ms})")
    results.append((name, not problems, problems, r))
    print(("PASS " if not problems else "FAIL ") + name + ("" if not problems else "\n     " + "\n     ".join(problems) + f"\n     status={r['status']} errors={[e['message'] for e in r['errors']]} reason={r.get('reason')}"))

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(f"http://127.0.0.1:{port}/page.html")

    case("S1 plain code finishes, console captured", "console.log('hi');", {"status": "finished", "errorCount": 0, "output": ["hi"]})
    case("S2 extra global (THREE) => skipped, no problem", "const s = new THREE.Scene();", {"status": "skipped", "errorCount": 0}, extra=["THREE"])
    case("S3 blocked fetch => skipped, no problem", "fetch('/x');", {"status": "skipped", "errorCount": 0})
    case("S3b page-only name inside a function that runs => skipped", "function f(){ return document.title } f();", {"status": "skipped", "errorCount": 0})
    case("S4 real TypeError => crashed", "const o = null; o.x;", {"status": "crashed", "errorCount": 1})
    case("S5 typo'd undefined name => crashed (real bug)", "const a = 1; console.log(aa);", {"status": "crashed", "errorCount": 1})
    case("S6 timer result visible to a check", "let r = 0; setTimeout(() => { r = 5 }, 1000);", {"status": "finished", "errorCount": 0, "checkCount": 1}, checks="r === 5")
    case("S7 async function result visible to a check", "let v; async function f(){ await null; v = 1 } f();", {"status": "finished", "errorCount": 0}, checks="v === 1")
    case("S7b error inside a 1 s timer is caught", "setTimeout(() => { null.x }, 1000);", {"status": "crashed", "errorCount": 1})
    case("S8 long timer, no failing check => finished quickly", "setTimeout(() => {}, 10000);", {"status": "finished", "errorCount": 0}, max_ms=1500)
    case("S8b long timer + failing check => skipped (cannot verify)", "let r = 0; setTimeout(() => { r = 1 }, 10000);", {"status": "skipped", "errorCount": 0}, checks="r === 1")
    case("S8c endless timer chain => skipped, not a problem", "function tick(){ setTimeout(tick, 100) } tick();", {"status": "skipped", "errorCount": 0})
    case("S9 synchronous infinite loop => timeout error", "while (true) {}", {"status": "timeout", "errorCount": 1})
    case("S10 error in a repeating interval is caught", "setInterval(() => { null.x }, 50);", {"status": "crashed", "errorCount": 1})
    case("S11 interval alone does not hang", "setInterval(() => {}, 100);", {"status": "finished", "errorCount": 0}, max_ms=2500)
    case("S12 check using an extra global => skipped, not a failure", "const a = 1;", {"status": "skipped", "errorCount": 0}, checks="THREE.REVISION > 0", extra=["THREE"])
    case("S13 module with top-level await", "await new Promise(r => setTimeout(r, 200)); globalThis.v = 1;", {"status": "finished", "errorCount": 0}, checks="globalThis.v === 1", sourceType="module")
    case("S14 failing check is still reported", "const add = (a,b)=>a+b;", {"status": "finished", "errorCount": 1}, checks="add(1,1) === 3")
    case("S15 passing checks counted", "const add = (a,b)=>a+b;", {"status": "finished", "errorCount": 0, "checkCount": 2}, checks="add(1,1) === 2\nadd(2,2) === 4 // four")
    case("S16 line numbers map back to user code", "const a = 1;\nconst b = 2;\nnull.x;", {"status": "crashed", "errors": ["TypeError"]})
    case("RV3 interval that finishes itself + failing check => skipped", "let n=0; const t=setInterval(()=>{n++; if(n>3)clearInterval(t)},50);", {"status": "skipped", "errorCount": 0}, checks="n===4")
    case("RV4 module awaiting a 5 s timer => skipped, not a timeout error", "await new Promise(r=>setTimeout(r,5000));", {"status": "skipped", "errorCount": 0}, sourceType="module")
    case("L2 caught fetch: console output only, not a problem", "(async () => { try { await fetch('https://example.com/x'); } catch (e) { console.error('Request failed:', e.message); } })();", {"status": "finished", "errorCount": 0, "output": lambda o: any("fetch is blocked" in x for x in o)})
    case("L2 console.error alone is not a checker failure", "console.error('boom'); console.warn('careful');", {"status": "finished", "errorCount": 0})
    case("L2 uncaught fetch with .catch handler still amber", "fetch('https://example.com/x').catch(e => console.log(e.message));", {"status": "skipped", "errorCount": 0})
    case("L4 called function with property typo: NaN is output, not an error (documented limit)", "function total(items){ let t=0; for (const i of items) t += i.price * i.quantitty; return t; }\nconsole.log(total([{price:2,quantity:3}]));", {"status": "finished", "errorCount": 0, "output": ["NaN"]})
    case("L4 same function with a Check catches it", "function total(items){ let t=0; for (const i of items) t += i.price * i.quantitty; return t; }", {"status": "finished", "errorCount": 1}, checks="total([{price:2,quantity:3}]) === 6")
    case("D1 console.log shows NaN / Infinity / undefined, not null", "console.log(NaN); console.log([1, NaN, Infinity, undefined]); console.log({a: NaN}); console.log(undefined, 5, 'x');", {"status": "finished", "errorCount": 0, "output": ["NaN", '[1,"NaN","Infinity","undefined"]', '{"a":"NaN"}', "undefined 5 x"]})
    case("D1 normal values unchanged", "console.log({a:[1,2],b:'x'}); console.log(true, 3.5, null);", {"status": "finished", "errorCount": 0, "output": ['{"a":[1,2],"b":"x"}', "true 3.5 null"]})
    case("D1 failed check shows the real value", "const v = 0/0;", {"status": "finished", "errorCount": 1, "errors": lambda e: True}, checks="v === 1")
    r = [x for x in results if x[0].startswith("S16")][0][3]
    line = r["errors"][0]["line"]
    ok16 = line == 3
    print(("PASS " if ok16 else "FAIL ") + f"S16b crash reports user line 3 (got {line})"); results.append(("S16b", ok16, [], r))
    browser.close()

failed = [x for x in results if not x[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
