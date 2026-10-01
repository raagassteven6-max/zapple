// Snapshot of every name this browser provides (window, document, fetch, ...).
// It runs before any library loads, so libraries and this page's own functions
// are not mistaken for browser built-ins.
window.BROWSER_GLOBALS = (() => {
  const names = new Set();
  for (let holder = window; holder && holder !== Object.prototype; holder = Object.getPrototypeOf(holder)) {
    Object.getOwnPropertyNames(holder).forEach((name) => names.add(name));
  }
  names.delete("constructor");
  return [...names];
})();
