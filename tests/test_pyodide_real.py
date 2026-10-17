"""REAL Pyodide in headless Chromium (R20). Needs internet: it downloads Pyodide, pyflakes, numpy and pandas from the
same CDNs the live page uses, so it runs on GitHub Actions and is not part of the offline suite.
Usage: python3 test_pyodide_real.py [path/to/checks.js]"""
import http.server, os, shutil, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
checks = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "checks.js")
root = tempfile.mkdtemp()
for f in os.listdir(os.path.join(HERE, "fixtures")):
    shutil.copy(os.path.join(HERE, "fixtures", f), root)
npm_acorn = os.path.join(HERE, "..", "node_modules", "acorn", "dist", "acorn.js")
if os.path.exists(npm_acorn): shutil.copy(npm_acorn, os.path.join(root, "acorn.js"))
elif not os.path.exists(os.path.join(root, "acorn.js")): sys.exit("acorn.js missing: run npm install first")
shutil.copy(checks, os.path.join(root, "checks.js"))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), Quiet); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

failures = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   {detail}"))
    if not ok: failures.append(name)

RUN = """async ({code, checks}) => {
  const lines = []; const log = { add: (m) => { lines.push(m); console.log(m); } };
  const t0 = performance.now();
  const r = await runPythonAnalysis({ code, extraNames: [], checks: checks || [] }, log);
  return { r, lines, ms: Math.round(performance.now() - t0) };
}"""

def run(page, code, checks=None):
    out = page.evaluate(RUN, {"code": code, "checks": checks or []})
    r = out["r"]
    print(f"     ({out['ms']} ms) log: {out['lines']}")
    return r, out

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.set_default_timeout(300000)
    page.on("console", lambda m: print("     [page]", m.text) if m.type == "error" else None)
    page.goto(f"http://127.0.0.1:{port}/page.html")

    r, out = run(page, "import numpy as np\nprint(int(np.arange(5).sum()))\n")
    check("N1 numpy code runs for real", r.get("output") == ["10"] and not r.get("skipReason") and not r.get("runErrors"), str(r)[:400])
    check("N1b the log says libraries were loaded", any("Loading numpy" in l for l in out["lines"]), str(out["lines"]))

    code = 'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, 3]})\ntotal = int(df["a"].sum())\nprint(total)\n'
    r, out = run(page, code, ["total == 6", "total == 7"])
    check("N2 pandas code runs and checks are evaluated", r.get("output") == ["6"] and r.get("checkCount") == 2 and len(r.get("runErrors", [])) == 1, str(r)[:400])

    r, out = run(page, "import numpy as np\nvalues = np.zeros(3)\nprint(values[5])\n")
    check("N3 a real numpy error is a problem", len(r.get("runErrors", [])) == 1 and "IndexError" in r["runErrors"][0]["message"], str(r)[:400])
    check("N3b numpy was already loaded, so no second download", not any("Loading" in l for l in out["lines"]), str(out["lines"]))

    r, out = run(page, "import torch\nprint(1)\n")
    check("N4 an unsupported library is skipped, not a problem", r.get("skipReason") and "numpy" in r["skipReason"] and not r.get("runErrors"), str(r)[:400])

    r, out = run(page, "import numpy as np\nfrom js import fetch\nfetch('https://example.com')\n")
    check("N5 user code cannot use fetch after libraries loaded", any("blocked" in e["message"] for e in r.get("runErrors", [])) or bool(r.get("skipReason")), str(r)[:400])
    browser.close()

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
