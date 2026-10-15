// Dumps the Python embedded in checks.js: node --expose-internals extract_py.js [checks.js] > zapple_py.py
const { load } = require("./harness");
const vm = require("node:vm");
const z = load(process.argv[2] || undefined);
process.stdout.write(vm.runInContext("PYTHON_SOURCE", z.ctx));
