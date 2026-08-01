/**
 * Loop-test orchestrator.
 *
 *   node test/run.mjs            one full pass (lib + http + 40 loop cycles)
 *   node test/run.mjs --rounds 3 --loop 60
 *
 * Boots the four mock providers and a production `next start`, forges a
 * session with the same secret it hands the server, runs every suite, and
 * exits non-zero on any failure. Results land in test/results.json.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startOpenAIMock, startAnthropicMock, startTtsMock, startMcpMock } from "./mocks.mjs";
import { drain, resetCounts, summary } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const ROUNDS = flag("rounds", 1);
const LOOP = flag("loop", 40);

const SECRET = "carvis-test-secret-0123456789";
const PORT = 3123;

/* --------------------------- environment ------------------------------ */
// The lib suites import app code directly, so the env must be set before
// those modules load. Everything test-scoped, nothing real.
process.env.CARVIS_AUTH_SECRET = SECRET;
process.env.CARVIS_ENCRYPTION_KEY = "carvis-test-encryption-key-16plus";
process.env.CARVIS_ALLOW_INSECURE_BASEURL = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const mocks = {};

async function startServer(env) {
  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/login`);
      if (res.status < 500) return { child, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`next start never came up:\n${log.slice(-2000)}`);
}

async function main() {
  console.log("Starting mock providers…");
  mocks.openaiMock = await startOpenAIMock(4310);
  mocks.anthropicMock = await startAnthropicMock(4311);
  mocks.ttsMock = await startTtsMock(4312);
  mocks.mcpMock = await startMcpMock(4313);

  console.log("Starting next production server…");
  const server = await startServer({
    CARVIS_AUTH_SECRET: SECRET,
    CARVIS_ENCRYPTION_KEY: process.env.CARVIS_ENCRYPTION_KEY,
    CARVIS_ALLOW_INSECURE_BASEURL: "1",
    CARVIS_ADMIN_EMAILS: "admin@test.dev",
  });

  const ctx = {
    ...mocks,
    baseUrl: `http://127.0.0.1:${PORT}`,
    secret: SECRET,
  };

  let grand = { passed: 0, failed: 0, failures: [] };

  try {
    for (let round = 1; round <= ROUNDS; round++) {
      console.log(`\n──── round ${round}/${ROUNDS} ────`);
      resetCounts();
      ctx.email = `loop-r${round}-${process.pid}@test.dev`;

      const { libSuites } = await import("./lib.test.mjs");
      await libSuites(ctx);
      const { httpSuites, loopSuites } = await import("./http.test.mjs");
      await httpSuites(ctx);
      await loopSuites(ctx, LOOP);

      const s = await drain({ verbose: false });
      console.log(`round ${round}: ${s.passed} passed, ${s.failed} failed`);
      grand.passed += s.passed;
      grand.failed += s.failed;
      grand.failures.push(...s.failures.map((f) => ({ round, ...f })));
    }
  } finally {
    server.child.kill();
    for (const m of Object.values(mocks)) await m.close?.();
  }

  writeFileSync(
    new URL("./results.json", import.meta.url),
    JSON.stringify({ when: new Date().toISOString(), ...grand }, null, 2),
  );

  console.log(`\nTOTAL: ${grand.passed} passed, ${grand.failed} failed`);
  if (grand.failures.length) {
    console.log("\nFailures:");
    for (const f of grand.failures.slice(0, 40)) {
      console.log(`  [r${f.round}][${f.section}] ${f.name}: ${f.error}`);
    }
  }
  process.exit(grand.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Harness crashed:", e);
  process.exit(2);
});
