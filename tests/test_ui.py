"""UI tests for the saved-history wiring (Playwright + Chromium).
Usage: python3 test_ui.py [site_dir] [checks.js]   (site_dir holds index.html, ui.js, styles.css, bot.js; default: the folder above tests/)
The CDN scripts are served from local files, and ESLint is a stub that reports nothing, because these tests are about
saving and exporting, not about lint rules (those are tested in test_js.js with the real ESLint)."""
import http.server, json, os, shutil, socketserver, sys, tempfile, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
site = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath(os.path.join(HERE, ".."))
checks = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(site, "checks.js")
root = tempfile.mkdtemp()
for name in ["index.html", "styles.css", "ui.js", "bot.js", "browser-globals.js"]:
    src = os.path.join(site, name)
    if os.path.exists(src): shutil.copy(src, root)
    elif name == "browser-globals.js": shutil.copy(os.path.join(HERE, "fixtures", name), root)
    else: sys.exit(f"{name} not found in {site}")
shutil.copy(checks, os.path.join(root, "checks.js"))
npm_acorn = os.path.join(HERE, "..", "node_modules", "acorn", "dist", "acorn.js")
shutil.copy(npm_acorn if os.path.exists(npm_acorn) else os.path.join(HERE, "fixtures", "acorn.js"), os.path.join(root, "acorn.js"))
with open(os.path.join(root, "eslint-stub.js"), "w") as f:
    f.write("window.eslint = { Linter: class { verify() { return []; } } };")

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), Quiet); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

failures = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   {detail}"))
    if not ok: failures.append(name)

def route(r):
    url = r.request.url
    if "acorn" in url: r.fulfill(path=os.path.join(root, "acorn.js"), content_type="text/javascript")
    elif "eslint-linter-browserify" in url: r.fulfill(path=os.path.join(root, "eslint-stub.js"), content_type="text/javascript")
    else: r.fulfill(status=200, body="", content_type="text/css")   # fonts

def new_page(browser, init_script=None):
    ctx = browser.new_context(accept_downloads=True, viewport={"width": 390, "height": 800},
                              permissions=["clipboard-read", "clipboard-write"])
    ctx.route(lambda u: not u.startswith(f"http://127.0.0.1:{port}"), route)
    if init_script: ctx.add_init_script(init_script)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{port}/index.html")
    return ctx, page, errors

def run_check(page, code):
    page.click("#t-code")
    page.fill("#code-input", code)
    page.click("#check-button")
    page.wait_for_function("document.getElementById('check-button').textContent === 'Check'", timeout=15000)

def status(page):
    page.click("#t-log")
    page.wait_for_timeout(400)          # the save finishes just after the report appears
    return page.inner_text("#history-status")

with sync_playwright() as p:
    browser = p.chromium.launch()

    ctx, page, errors = new_page(browser)
    check("H1 empty history says nothing saved yet", "Nothing saved yet" in status(page), status(page))
    check("H1b export and delete are disabled when empty", page.is_disabled("#export-button") and page.is_disabled("#forget-button"))

    run_check(page, "const x = ;")
    check("H2 a syntax error is saved", "1 check saved" in status(page), status(page))
    run_check(page, "const a = 1;\nconsole.log(a);")
    check("H3 a clean check is saved", "2 checks saved" in status(page), status(page))
    page.click("#t-results")
    check("H3b the report still shows (saving never blocks it)", "Clear to use" in page.inner_text("#verdict-head"), page.inner_text("#verdict-head"))

    page.click("#t-log")
    with page.expect_download() as dl:
        page.click("#export-button")
    path = dl.value.path()
    rows = [json.loads(l) for l in open(path).read().splitlines()]
    checks_rows = [r for r in rows if r["store"] == "checks"]
    check("H4 export has both checks", len(checks_rows) == 2, str(len(checks_rows)))
    syntax_row = next((r for r in checks_rows if any(f["rule"] == "syntax" for f in r["findings"])), None)
    check("H4b syntax finding recorded with basis", syntax_row is not None and syntax_row["findings"][0]["basis"] == "the parser could not read the code", str(syntax_row))
    check("H5 code is NOT saved by default, only a fingerprint", all(r["code"] is None and r["codeHash"] for r in checks_rows))
    check("H5b the clean run is marked finished", any(r["ran"]["status"] == "finished" for r in checks_rows))

    page.check("#keep-code")
    run_check(page, "console.log('kept');")
    with page.expect_download() as dl:
        page.click("#t-log"); page.click("#export-button")
    rows = [json.loads(l) for l in open(dl.value.path()).read().splitlines()]
    kept = [r for r in rows if r["store"] == "checks" and r["code"] == "console.log('kept');"]
    check("H6 code is saved once the switch is on", len(kept) == 1, str(len(kept)))
    page.reload()
    check("H6b the switch choice is remembered after reload", page.is_checked("#keep-code"))

    page.once("dialog", lambda d: d.accept())
    page.click("#t-log"); page.click("#forget-button")
    page.wait_for_timeout(500)
    check("H7 delete empties the history", "Nothing saved yet" in page.inner_text("#history-status"), page.inner_text("#history-status"))
    check("H8 no page errors", errors == [], str(errors))
    page.screenshot(path=os.path.join(tempfile.gettempdir(), "zapple-log-mobile.png"), full_page=True)
    ctx.close()

    # Evidence packet (R27)
    ctx, page, errors = new_page(browser)
    run_check(page, "const a = 1;\nconsole.log(a);")
    page.click("#t-results")
    check("E1 the evidence packet box is on the Results tab", page.is_visible("summary:has-text('Evidence packet')"))
    page.click("summary:has-text('Evidence packet')")
    check("E1b the packet text is shown when opened", "# Zapple evidence packet" in page.inner_text("details:has(summary:has-text('Evidence packet')) pre"))
    page.click("button:has-text('Copy evidence packet')")
    page.wait_for_timeout(300)
    copied = page.evaluate("navigator.clipboard.readText()")
    check("E2 Copy puts the whole packet on the clipboard", copied.startswith("# Zapple evidence packet") and "## Code" in copied and "console.log(a);" in copied, copied[:120])
    check("E2b the button confirms", "Copied" in page.inner_text("button:has-text('Copied')"))
    check("E3 clean run says what was verified", "finished without crashing" in copied, copied[:600])

    run_check(page, "const x = ;")
    page.click("#t-results")
    page.click("summary:has-text('Evidence packet')")
    page.click("button:has-text('Copy evidence packet')")
    page.wait_for_timeout(300)
    copied = page.evaluate("navigator.clipboard.readText()")
    check("E4 syntax error packet says later stages were not reached", "does not parse" in copied and "Line 1" in copied, copied[:600])
    check("E5 no page errors", errors == [], str(errors))
    page.screenshot(path=os.path.join(tempfile.gettempdir(), "zapple-packet-mobile.png"), full_page=True)
    ctx.close()

    ctx, page, errors = new_page(browser)
    run_check(page, "const a = 1;\nconst b = undefinedName;\nconsole.log(a, b);")
    page.click("#t-results")
    page.click("summary:has-text('Evidence packet')")
    page.click("button:has-text('Copy evidence packet')")
    page.wait_for_timeout(300)
    copied = page.evaluate("navigator.clipboard.readText()")
    check("E6 a real runtime crash appears under Problems, with the run marked as finding problems",
          "## Problems" in copied and "undefinedName" in copied and "found problems" in copied, copied[:700])
    ctx.close()

    # Saving impossible (private window / blocked storage): checks must still work
    ctx, page, errors = new_page(browser, "indexedDB.open = () => { throw new Error('blocked'); };")
    msg = status(page)
    check("H9 blocked storage is explained, not an error", "not available" in msg, msg)
    run_check(page, "console.log(1);")
    page.click("#t-results")
    check("H10 check still works with blocked storage", "Clear to use" in page.inner_text("#verdict-head"), page.inner_text("#verdict-head"))
    check("H11 no page errors with blocked storage", errors == [], str(errors))
    ctx.close()
    browser.close()

print(f"\n{'ALL PASSED' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
