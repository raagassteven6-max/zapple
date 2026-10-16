# Zapple tests

Run on GitHub automatically (Actions tab). To run locally: `npm install`, `pip install -r requirements-test.txt`,
`python -m playwright install chromium`, then `npm test`.

- `test_js.js`: static checks, lint rules, Checks box, comparison logic (Node, real acorn + ESLint)
- `test_py.py`: the Python half of checks.js, run on CPython with real pyflakes
- `test_sandbox.py`: the Web Worker sandbox in headless Chromium
- `test_ui.py`: the page itself in headless Chromium (saved history, export, delete, blocked storage). Needs `index.html`, `ui.js`, `styles.css`, `bot.js` in the repo root next to `checks.js`
- `corpus.js`, `corpus_py.py`: not part of CI. Run them over a folder of real code to look for false alarms:
  `node tests/corpus.js <folder>` and `python3 tests/corpus_py.py <folder>`
- Spec and requirement IDs (R1, L4 ...) are in `SPEC.md`
