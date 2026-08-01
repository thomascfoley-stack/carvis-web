/**
 * Minimal test harness. No framework: assertions are functions, failures are
 * collected rather than thrown to the top, and the summary is machine-readable
 * so the loop runner can decide whether to keep going.
 */

const state = {
  passed: 0,
  failed: 0,
  failures: [],
  current: "",
  queue: [],
};

export function section(name) {
  state.queue.push({ kind: "section", name });
}

export function t(name, fn) {
  state.queue.push({ kind: "test", name, fn });
}

export function ok(cond, msg = "expected truthy") {
  if (!cond) throw new Error(msg);
}

export function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}${msg ? ": " : ""}expected ${e}, got ${a}`);
}

export async function drain({ verbose = false } = {}) {
  for (const item of state.queue) {
    if (item.kind === "section") {
      state.current = item.name;
      if (verbose) console.log(`\n== ${item.name} ==`);
      continue;
    }
    try {
      await item.fn();
      state.passed++;
      if (verbose) console.log(`  ok   ${item.name}`);
    } catch (e) {
      state.failed++;
      state.failures.push({
        section: state.current,
        name: item.name,
        error: String(e?.message ?? e).slice(0, 400),
      });
      console.log(`  FAIL [${state.current}] ${item.name}\n       ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  state.queue = [];
  return summary();
}

export function summary() {
  return { passed: state.passed, failed: state.failed, failures: state.failures };
}

export function resetCounts() {
  state.passed = 0;
  state.failed = 0;
  state.failures = [];
}
