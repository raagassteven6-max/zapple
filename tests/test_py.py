"""Python-side tests: CPython + real pyflakes against the Python embedded in checks.js.
Usage: PYTHONPATH=<dir containing pyflakes> python3 test_py.py [path/to/checks.js]"""
import asyncio, io, json, os, subprocess, sys, unittest

sys.stdin = io.StringIO("")   # like Pyodide: input() hits end-of-file instead of waiting
HERE = os.path.dirname(os.path.abspath(__file__))
checks = sys.argv.pop(1) if len(sys.argv) > 1 and sys.argv[1].endswith(".js") else os.path.join(HERE, "..", "checks.js")
source = subprocess.run(["node", "--expose-internals", os.path.join(HERE, "extract_py.js"), checks],
                        capture_output=True, text=True, check=True).stdout
ns = {}
exec(compile(source, "zapple_py.py", "exec"), ns)

def run(code, checks=(), extra=()):
    return asyncio.run(ns["analyze"]({"code": code, "extraNames": list(extra), "checks": list(checks)}))
def msgs(items): return [i["message"] for i in items]
def rules(items): return [i["ruleId"] for i in items]

class Magics(unittest.TestCase):          # R9
    def test_R9_percent_continuation_is_valid(self):
        r = run('name = "x"\nmsg = ("Hello %s"\n       % name)\nprint(msg)\n')
        self.assertIsNone(r["syntax"]); self.assertEqual(r["blanked"], 0); self.assertEqual(r["output"], ["Hello x"])
    def test_R9_not_equal_at_line_start_is_valid(self):
        r = run('a, b = 1, 2\nif (a\n    != b):\n    print("diff")\n')
        self.assertIsNone(r["syntax"]); self.assertEqual(r["output"], ["diff"])
    def test_R9_bang_inside_string_untouched(self):
        r = run('s = """\n!hello\n%matplotlib\n"""\nprint(len(s))\n')
        self.assertIsNone(r["syntax"]); self.assertEqual(r["blanked"], 0); self.assertEqual(r["output"], ["20"])
    def test_R9_real_magic_is_blanked(self):
        r = run('%matplotlib inline\n!pip install foo\nprint(1)\n')
        self.assertIsNone(r["syntax"]); self.assertEqual(r["blanked"], 2); self.assertEqual(r["output"], ["1"])
    def test_R9_real_error_behind_magic_reported_at_true_line(self):
        r = run('%matplotlib inline\nx = (1\n')
        self.assertIsNotNone(r["syntax"]); self.assertEqual(r["syntax"]["line"], 2)
    def test_R9_real_syntax_error_without_magic(self):
        r = run('def f(:\n    pass\n'); self.assertEqual(r["syntax"]["line"], 1)

class Environment(unittest.TestCase):     # R10
    def test_R10_file_is_defined(self):
        r = run('import os\nprint(os.path.basename(__file__))\n')
        self.assertEqual(r["runErrors"], []); self.assertIsNone(r["skipReason"])
    def test_R10_relative_file_is_environment_limit(self):
        r = run('with open("data_that_is_not_here.csv") as f:\n    print(f.read())\n')
        self.assertEqual(r["runErrors"], []); self.assertTrue(r["skipReason"])
    def test_R10_input_is_environment_limit(self):
        r = run('name = input("name? ")\nprint(name)\n')
        self.assertEqual(r["runErrors"], []); self.assertTrue(r["skipReason"])
    def test_R10_real_runtime_error_still_reported(self):
        r = run('x = {}\nprint(x["a"])\n')
        self.assertEqual(len(r["runErrors"]), 1); self.assertIsNone(r["skipReason"])

class Exit(unittest.TestCase):            # R11
    def exit_notes(self, code): return [n for n in run(code)["notes"] if n["ruleId"] == "zapple/early-exit"]
    def test_R11_nonzero_exit_note(self):
        n = self.exit_notes('import sys\nprint("hi")\nsys.exit(3)\n')
        self.assertEqual(len(n), 1); self.assertIn("3", n[0]["message"]); self.assertEqual(n[0]["line"], 3)
    def test_R11_string_exit_note(self): self.assertEqual(len(self.exit_notes('raise SystemExit("bad")\n')), 1)
    def test_R11_zero_exit_quiet(self):
        for body in ("sys.exit()", "sys.exit(0)", "sys.exit(None)"):
            self.assertEqual(self.exit_notes(f"import sys\n{body}\n"), [], body)
    def test_R11_checks_still_run_after_exit(self):
        r = run('import sys\nx = 1\nsys.exit(2)\n', ["x == 1", "x == 2"])
        self.assertEqual(r["checkCount"], 2); self.assertEqual(len(r["runErrors"]), 1)

class ModuleMembers(unittest.TestCase):   # R12
    def typo(self, code): return [e for e in run(code)["errors"] if e["ruleId"] == "zapple/unknown-module-member"]
    def test_R12_datetime_now_in_uncalled_function(self):
        e = self.typo('import datetime\ndef stamp():\n    return datetime.now()\n')
        self.assertEqual(len(e), 1); self.assertIn("datetime.datetime.now", e[0]["message"]); self.assertEqual(e[0]["line"], 3)
    def test_R12_typo_suggests(self):
        e = self.typo('import math\ndef f():\n    return math.sqroot(4)\n')
        self.assertEqual(len(e), 1); self.assertIn("sqrt", e[0]["message"])
    def test_R12_python2_ism(self):
        self.assertEqual(len(self.typo('import string\ndef f():\n    return string.letters\n')), 1)
    def test_R12_alias(self):
        e = self.typo('import datetime as dt\ndef f():\n    return dt.now()\n')
        self.assertEqual(len(e), 1); self.assertIn("dt.now", e[0]["message"])
    def test_R12_valid_members_quiet(self):
        self.assertEqual(self.typo('import math, json, os, datetime, collections\nprint(math.sqrt(4), json.dumps(1), os.getcwd(), datetime.datetime.now(), collections.Counter())\n'), [])
    def test_R12_package_quiet(self):
        self.assertEqual(self.typo('import xml\ndef f():\n    return xml.etree\n'), [])
    def test_R12_rebound_name_quiet(self):
        self.assertEqual(self.typo('import math\nmath = None\ndef f():\n    return math.foo\n'), [])
    def test_R12_param_shadow_quiet(self):
        self.assertEqual(self.typo('import math\ndef f(math):\n    return math.foo\n'), [])
    def test_R12_double_import_quiet(self):
        self.assertEqual(self.typo('try:\n    import tomllib\nexcept ImportError:\n    import json as tomllib\ndef f():\n    return tomllib.foo\n'), [])
    def test_R12_star_import_quiet(self):
        self.assertEqual(self.typo('import math\nfrom somewhere import *\ndef f():\n    return math.foo\n'), [])
    def test_R12_third_party_quiet(self):
        self.assertEqual(self.typo('import numpy as np\ndef f():\n    return np.foo\n'), [])
    def test_R12_windows_only_attr_quiet(self):
        self.assertEqual(self.typo('import os, ctypes\ndef f():\n    os.startfile("x")\n    return ctypes.windll\n'), [])
    def test_R12_platform_module_needs_typo(self):
        self.assertEqual(self.typo('import os\ndef f():\n    return os.completelymadeup\n'), [])
        self.assertEqual(len(self.typo('import os\ndef f():\n    return os.getcwdd()\n')), 1)

class StdlibCalls(unittest.TestCase):     # R13
    def bad(self, code): return [e for e in run(code)["errors"] if e["ruleId"].startswith("zapple/stdlib-")]
    def test_R13_json_dumps_bad_keyword(self):
        e = self.bad('import json\ndef dump(x):\n    return json.dumps(x, indnt=2)\n')
        self.assertEqual(len(e), 1); self.assertIn("indnt", e[0]["message"])
    def test_R13_json_dumps_good_keywords_quiet(self):
        self.assertEqual(self.bad('import json\nprint(json.dumps({"a": 1}, indent=2, sort_keys=True, default=str))\n'), [])
    def test_R13_json_cls_with_custom_kwargs_quiet(self):
        self.assertEqual(self.bad('import json\nclass E(json.JSONEncoder):\n    pass\ndef f(x):\n    return json.dumps(x, cls=E, whatever=1)\n'), [])
    def test_R13_too_many_positional(self):
        e = self.bad('import math\ndef f():\n    return math.sqrt(1, 2)\n'); self.assertEqual(len(e), 1)
    def test_R13_missing_argument(self):
        e = self.bad('import random\ndef f():\n    return random.randint(1)\n'); self.assertEqual(len(e), 1)
    def test_R13_from_import_function(self):
        e = self.bad('from json import dumps\ndef f(x):\n    return dumps(x, indnt=2)\n'); self.assertEqual(len(e), 1)
    def test_R13_builtin_bad_keyword(self):
        e = self.bad('def f(xs):\n    return sorted(xs, reversed=True)\n'); self.assertEqual(len(e), 1)
    def test_R13_valid_builtins_quiet(self):
        self.assertEqual(self.bad('print(sorted([3,1], reverse=True), round(1.234, 2), open, len([1]))\nprint("a", "b", sep="-", end="")\n'), [])
    def test_R13_user_shadowing_builtin_quiet(self):
        self.assertEqual(self.bad('def sorted(x):\n    return x\ndef f():\n    return sorted([1], reversed=True)\n'), [])
    def test_R13_spread_args_quiet(self):
        self.assertEqual(self.bad('import math\ndef f(a):\n    return math.sqrt(*a)\n'), [])
    def test_R13_star_import_quiet(self):
        self.assertEqual(self.bad('from x import *\ndef f(a):\n    return sorted(a, reversed=True)\n'), [])

class ReviewRound(unittest.TestCase):
    def errs(self, code): return run(code)["errors"]
    def test_RV1_json_loads_strict_ok(self):
        self.assertEqual(self.errs('import json\nprint(json.loads("{}", strict=False))\n'), [])
    def test_RV2_newer_member_in_version_guard_quiet(self):
        self.assertEqual([e for e in self.errs('import sys, statistics\nif sys.version_info >= (3, 13):\n    statistics.kde([1])\n') if "module-member" in e["ruleId"]], [])
    def test_RV2_try_except_attributeerror_quiet(self):
        self.assertEqual([e for e in self.errs('import statistics\ntry:\n    f = statistics.kdee\nexcept AttributeError:\n    f = None\n') if "module-member" in e["ruleId"]], [])
    def test_RV2_runtime_missing_stdlib_attr_is_environment(self):
        r = run('import math\nprint(math.nothing_here_at_all)\n')
        self.assertEqual(r["runErrors"], [])
        self.assertTrue(r["skipReason"] or r["errors"])

class Regression(unittest.TestCase):      # R14
    def test_R14_add_missing_argument(self):
        r = run('def add(a, b):\n    return a + b\nprint(add(1))\n')
        self.assertTrue(any("missing" in m for m in msgs(r["errors"])))
    def test_R14_self_typo(self):
        r = run('class B:\n    def total(self):\n        return 1\n    def s(self):\n        return self.totl()\nprint(B().s())\n')
        self.assertTrue(any("totl" in m for m in msgs(r["errors"])))
    def test_R14_quiet_on_dataclass_enum_namedtuple(self):
        r = run('from dataclasses import dataclass\nfrom enum import Enum\nfrom typing import NamedTuple\n@dataclass\nclass A:\n    x: int\nclass C(Enum):\n    R = 1\nclass P(NamedTuple):\n    a: int\nprint(A(1), C.R, P(2))\n')
        self.assertEqual(r["errors"], []); self.assertEqual(r["runErrors"], [])
    def test_R14_undefined_name_from_pyflakes(self):
        r = run('print(undefined_thing)\n'); self.assertTrue(any("undefined" in m for m in msgs(r["errors"])))
    def test_R14_checks_pass_and_fail(self):
        r = run('def add(a, b):\n    return a + b\n', ["add(1, 2) == 3", "add(1, 2) == 4"])
        self.assertEqual(r["checkCount"], 2); self.assertEqual(len(r["runErrors"]), 1)
    def test_R14_clean_realistic_script_is_quiet(self):
        code = ('import json, re, itertools, collections\nfrom pathlib import Path\n'
                'def parse(text):\n    return [int(x) for x in re.findall(r"\\d+", text)]\n'
                'def top(xs, n=2):\n    return [k for k, _ in collections.Counter(xs).most_common(n)]\n'
                'data = parse("1 2 2 3 3 3")\nprint(json.dumps(top(data), indent=2))\nprint(list(itertools.pairwise(data))[:2])\n')
        r = run(code); self.assertEqual(r["errors"], []); self.assertEqual(r["runErrors"], [])

class Libraries(unittest.TestCase):       # R15-R18 (CPython here has numpy and pandas; in the browser a loader fetches them)
    def needed(self, code): return ns["libraries_needed"](code)
    def run_with_loader(self, code, checks=(), failed=()):
        calls = []
        async def loader(names_json):
            calls.append(json.loads(names_json)); return json.dumps(list(failed))
        r = asyncio.run(ns["analyze"]({"code": code, "extraNames": [], "checks": list(checks)}, loader))
        return r, calls

    def test_R15_finds_allowlisted_imports(self):
        self.assertEqual(self.needed("import numpy as np\nfrom pandas import DataFrame\nimport os\n"), ["numpy", "pandas"])
    def test_R15_submodules_and_duplicates(self):
        self.assertEqual(self.needed("import numpy.linalg as la\nimport numpy\nfrom numpy.random import rand\n"), ["numpy"])
    def test_R15_other_libraries_and_stdlib_are_not_listed(self):
        self.assertEqual(self.needed("import torch\nimport os\nimport transformers\n"), [])
    def test_R15_syntax_error_and_relative_import(self):
        self.assertEqual(self.needed("import numpy as\n"), [])
        self.assertEqual(self.needed("from . import numpy\n"), [])
    def test_R15_magic_lines_do_not_hide_imports(self):
        self.assertEqual(self.needed("%matplotlib inline\nimport pandas as pd\n"), ["pandas"])

    def test_R16_loader_called_once_before_the_run(self):
        r, calls = self.run_with_loader("import numpy as np\nimport pandas as pd\nprint(np.arange(4).sum())\n")
        self.assertEqual(calls, [["numpy", "pandas"]]); self.assertEqual(r["output"], ["6"]); self.assertIsNone(r["skipReason"])
    def test_R16_loader_not_called_without_libraries(self):
        _, calls = self.run_with_loader("print(1)\n"); self.assertEqual(calls, [])
    def test_R16_loader_not_called_when_static_errors_stop_the_run(self):
        r, calls = self.run_with_loader("import numpy as np\nprint(undefined_name)\n")
        self.assertEqual(calls, []); self.assertTrue(r["errors"])
    def test_R16_no_loader_still_works(self):
        r = run("import numpy as np\nprint(np.arange(3).sum())\n"); self.assertEqual(r["output"], ["3"])
    def test_R16_pandas_code_and_checks_run_for_real(self):
        code = 'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, 3]})\ntotal = int(df["a"].sum())\nprint(total)\n'
        r, _ = self.run_with_loader(code, ["total == 6", "total == 7"])
        self.assertEqual(r["output"], ["6"]); self.assertEqual(r["checkCount"], 2); self.assertEqual(len(r["runErrors"]), 1)

    def test_R17_failed_download_is_a_skip_not_a_problem(self):
        ns["RUNNABLE_LIBRARIES"].add("zz_missing_lib")
        try:
            r, calls = self.run_with_loader("import zz_missing_lib\nprint(1)\n", failed=["zz_missing_lib"])
        finally:
            ns["RUNNABLE_LIBRARIES"].discard("zz_missing_lib")
        self.assertEqual(calls, [["zz_missing_lib"]]); self.assertEqual(r["runErrors"], [])
        self.assertIn("could not be downloaded", r["skipReason"]); self.assertIn("zz_missing_lib", r["skipReason"])
    def test_R17_other_library_keeps_the_skip_and_lists_what_is_available(self):
        r, calls = self.run_with_loader("import torch\nprint(1)\n")
        self.assertEqual(calls, []); self.assertEqual(r["runErrors"], [])
        self.assertIn("torch", r["skipReason"]); self.assertIn("numpy", r["skipReason"]); self.assertIn("pandas", r["skipReason"])

    def test_R18_real_numpy_error_is_a_problem(self):
        r, _ = self.run_with_loader("import numpy as np\nvalues = np.zeros(3)\nprint(values[5])\n")
        self.assertEqual(len(r["runErrors"]), 1); self.assertIn("IndexError", r["runErrors"][0]["message"]); self.assertEqual(r["runErrors"][0]["line"], 3)
    def test_R18_static_checks_still_run_on_library_code(self):
        r, _ = self.run_with_loader("import numpy as np\nvalues = np.zeros(3)\nprint(valeus)\n")
        self.assertTrue(any("valeus" in m for m in msgs(r["errors"])))

if __name__ == "__main__":
    unittest.main(verbosity=1)
