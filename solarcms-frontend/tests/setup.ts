import "@testing-library/jest-dom/vitest";

/**
 * A `localStorage` for the theme tests.
 *
 * jsdom 25 exposes a `localStorage` accessor on `window` whose getter resolves
 * to `undefined` under Vitest, so `localStorage.clear()` throws before a single
 * theme assertion runs. That failure says nothing about the application — the
 * theme contract it was guarding (an explicit choice is persisted and survives
 * a remount) simply stopped being checked.
 *
 * So the polyfill is installed **only when the environment does not provide a
 * working one**: if a future jsdom fixes its getter, the real implementation is
 * used and this becomes dead weight rather than a mock that quietly shadows it.
 *
 * In-memory and per-process, which is what the tests want — `beforeEach` clears
 * it, and no test should inherit a value another test wrote.
 */
function installStorage(name: "localStorage" | "sessionStorage"): void {
  const existing = (() => {
    try {
      return (globalThis as { [k: string]: unknown })[name];
    } catch {
      return undefined;
    }
  })();
  if (existing) return;

  let entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      entries.delete(String(key));
    },
    clear: () => {
      entries = new Map();
    },
  };

  // Defined on both `window` and the global: application code reads the bare
  // `localStorage` binding, and the tests reach for it the same way.
  for (const target of [globalThis, (globalThis as { window?: object }).window]) {
    if (!target) continue;
    Object.defineProperty(target, name, {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}

installStorage("localStorage");
installStorage("sessionStorage");
