"""Browser test of the Python worker's library loading (R19), with a FAKE Pyodide: no network needed.
The fake cannot run Python. It only records what the worker does (which packages it loads, whether fetch is blocked
at that moment) so the loading, timing and blocking logic in checks.js is tested. Real Pyodide is tested in test_pyodide_real.py.
Usage: python3 test_pyworker.py [path/to/checks.js]"""
import http.server, json, os, shutil, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
checks = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "checks.js")
root = tempfile.mkdtemp()
for f in os.listdir(os.path.join(HERE, "fixtures")):
    shutil.copy(os.path.join(HERE, "fixtures", f), root)
npm_acorn = os.path.join(HERE, "..", "node_modules", "acorn", "dist", "acorn.js")
if os.path.exists(npm_acorn): shutil.copy(npm_acorn, os.path.join(root, "acorn.js"))
shutil.copy(checks, os.path.join(root, "checks.js"))

FAKE_PYODIDE = r"""
self.loadPyodide = async () => {
  const state = { loads: [], runs: [], fetchBlockedDuringLoad: null, fetchBlockedAfter: null };
  const fetchBlocked = () => { try { fetch; return false; } catch (e) { return true; } };
  return {
    async loadPackage(names) {
      state.loads.push([].concat(names));
      const name = [].concat(names)[0];
      if (name === "micropip") return;
      state.fetchBlockedDuringLoad = fetchBlocked();
      if (name === "slow") await new Promise((r) => setTimeout(r, 4000));
      if (name === "broken") throw new Error("404 not found");
    },
    pyimport() { return { install: async () => {} }; },
    runPython(code) { state.runs.push(code); },
    globals: { get() { return async (requestJson, loader) => {
      const request = JSON.parse(requestJson);
      const [names, mode] = request.code.split("|");
      let failed = [];
      if (names) failed = JSON.parse(await loader(JSON.stringify(names.split(","))));
      state.fetchBlockedAfter = fetchBlocked();
      if (mode === "hang") { const t = Date.now(); while (Date.now() - t < 4500) {} }
      return JSON.stringify({ errors: [], notes: [], output: [], runErrors: [], checkCount: 0, failed, state });
    }; } },
  };
};
"""

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), Quiet); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

failures = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   {detail}"))
    if not ok: failures.append(name)

RUN = """async (code) => {
  const lines = []; const log = { add: (m) => lines.push(m) };
  const t0 = performance.now();
  const r = await runPythonAnalysis({ code, extraNames: [], checks: [] }, log);
  return { r, lines, ms: Math.round(performance.now() - t0) };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context()
    ctx.route("**/pyodide.js", lambda route: route.fulfill(body=FAKE_PYODIDE, content_type="text/javascript"))
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{port}/page.html")

    out = page.evaluate(RUN, "numpy,pandas")
    state = out["r"]["state"]
    loads = [l[0] for l in state["loads"] if l[0] != "micropip"]
    check("W1 each library is loaded by name", loads == ["numpy", "pandas"], str(state["loads"]))
    check("W1b libraries are imported once after loading", any("import numpy" in c for c in state["runs"]) and any("import pandas" in c for c in state["runs"]), str(state["runs"]))
    check("W1c nothing failed", out["r"]["failed"] == [])
    check("W2 fetch works while libraries load", state["fetchBlockedDuringLoad"] is False, str(state["fetchBlockedDuringLoad"]))
    check("W2b fetch is blocked again before the user's code runs", state["fetchBlockedAfter"] is True, str(state["fetchBlockedAfter"]))
    check("W3 the log says what is loading", any("Loading numpy, pandas" in l for l in out["lines"]), str(out["lines"]))

    out = page.evaluate(RUN, "numpy,pandas")
    loads_now = [l[0] for l in out["r"]["state"]["loads"] if l[0] != "micropip"]
    check("W4 an already loaded library is not downloaded again", loads_now == ["numpy", "pandas"], str(loads_now))
    check("W4b no loading messages the second time", not any("Loading" in l for l in out["lines"]), str(out["lines"]))
    check("W4c fetch stays blocked on later runs", out["r"]["state"]["fetchBlockedAfter"] is True)

    out = page.evaluate(RUN, "slow")
    check("W5 a 4 s download does not hit the 3 s run limit", not out["r"].get("timedOut") and out["ms"] >= 3900, f"timedOut={out['r'].get('timedOut')} ms={out['ms']}")

    out = page.evaluate(RUN, "broken")
    check("W6 a failed download is reported, not a crash", out["r"].get("failed") == ["broken"] and not out["r"].get("workerFailed"), str(out["r"].get("failed")) + str(out["r"].get("workerFailed")))
    check("W6b the log names what could not be downloaded", any("broken" in l and "download" in l.lower() for l in out["lines"]), str(out["lines"]))
    out = page.evaluate(RUN, "numpy")
    check("W6c the worker still works after a failed download", out["r"].get("failed") == [] and "state" in out["r"], str(out["r"])[:200])

    out = page.evaluate(RUN, "|")
    check("W7 code without libraries never touches the loader", "Loading" not in " ".join(out["lines"]))

    out = page.evaluate(RUN, "numpy|hang")
    check("W8 the run limit still applies to code, after loading", out["r"].get("timedOut") is True, str(out["r"])[:200])
    out = page.evaluate(RUN, "|")
    check("W8b the worker restarts after a timeout", "state" in out["r"], str(out["r"])[:200])
    browser.close()

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
