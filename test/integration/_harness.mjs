/**
 * Shared helpers for the integration suites.
 *
 * Everything here exists to keep the suites portable. They previously imported
 * application modules through absolute paths like /home/claude/rh/apps/... ,
 * which meant they ran on exactly one machine — the one they were written on.
 * A test that cannot run in CI or on a colleague's checkout is not a test.
 *
 * Application modules are resolved relative to this file's own URL, and
 * dependencies use ordinary bare specifiers so Node's resolver finds them
 * wherever node_modules happens to live.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file rather than assumed. */
export const repoRoot = resolve(here, '../..');

/** Imports an application module by repo-relative path. */
export const appImport = (relativePath) => import(new URL(`../../${relativePath}`, import.meta.url).href);

export const API_A = process.env.API_A ?? 'http://localhost:9001';
export const API_B = process.env.API_B ?? 'http://localhost:9002';

/**
 * A failure counter that is impossible to forget.
 *
 * The previous suites tracked failures by hand, and two scenarios printed FAIL
 * while leaving the counter at zero — so the script exited 0 and CI would have
 * gone green on a reproduced security hole. `check` is the only way to report a
 * result here, and it always counts.
 */
export function createChecks() {
  let failures = 0;

  const check = (name, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    return ok;
  };

  const finish = () => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll checks passed.');
  };

  return { check, finish, failures: () => failures };
}

/** Waits for an API instance, and fails loudly rather than hanging or racing. */
export async function waitForHealthy(base, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`FATAL: ${base} never became healthy after ${attempts} attempts.`);
  process.exit(1);
}
