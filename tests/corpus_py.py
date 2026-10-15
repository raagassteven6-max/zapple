"""Runs the new Python static checks over real, valid Python files and prints what they report."""
import ast, os, subprocess, sys, sysconfig, collections, io
HERE = os.path.dirname(os.path.abspath(__file__))
src = subprocess.run(["node", "--expose-internals", os.path.join(HERE, "extract_py.js")], capture_output=True, text=True, check=True).stdout
ns = {}; exec(compile(src, "zapple_py.py", "exec"), ns)
roots = sys.argv[1:] or [sysconfig.get_paths()["stdlib"]]
files = [os.path.join(d, f) for r in roots for d, _, fs in os.walk(r) for f in fs if f.endswith(".py") and "site-packages" not in d and "/test" not in d]
counts = collections.Counter(); shown = collections.Counter(); n = 0
for f in files[:3000]:
    try: tree = ast.parse(open(f, encoding="utf-8").read())
    except Exception: continue
    n += 1
    try:
        found = ns["stdlib_findings"](tree)
        _, _, _, _ = ns["analyze_structure"](tree, [])
    except Exception as e:
        print("CRASH", f, type(e).__name__, e); continue
    for x in found:
        counts[x["ruleId"]] += 1
        if shown[x["ruleId"]] < 25:
            shown[x["ruleId"]] += 1; print(x["ruleId"], f.split("/lib/")[-1] + ":" + str(x["line"]), x["message"][:150])
print("files:", n, dict(counts))
