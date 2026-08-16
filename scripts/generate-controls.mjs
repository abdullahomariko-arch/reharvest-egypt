/**
 * Regenerates packages/core/src/controls.generated.ts from the handoff JSON.
 * Run after any change to the risk catalog so the code and the catalog cannot drift.
 *   node scripts/generate-controls.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'packages/core/src/controls.data.json';
const OUT = 'packages/core/src/controls.generated.ts';

const controls = JSON.parse(readFileSync(SRC, 'utf8'));
const j = (v) => JSON.stringify(v);

const body = controls
  .map(
    (r) => `  ${r.domain_id}: {
    domainId: ${j(r.domain_id)},
    domain: ${j(r.domain)},
    phase: ${j(r.phase)},
    owner: ${j(r.owner)},
    module: ${j(r.module)},
    severity: ${r.severity},
    likelihoodBand: ${r.likelihood_band},
    prevention: ${j(r.prevention)},
    detection: ${j(r.detection)},
    mitigation: ${j(r.mitigation)},
    evidence: ${j(r.evidence)},
    hardRule: ${j(r.hard_rule)},
    fallback: ${j(r.fallback)},
    acceptanceTests: ${j(r.minimum_acceptance_tests)},
  },`,
  )
  .join('\n');

const modules = [...new Set(controls.map((r) => r.module))].sort();

writeFileSync(
  OUT,
  `/**
 * AUTO-GENERATED from app_control_requirements_54.json — do not edit by hand.
 * Regenerate with: node scripts/generate-controls.mjs
 */

export interface ControlRequirement {
  readonly domainId: string;
  readonly domain: string;
  readonly phase: string;
  readonly owner: string;
  readonly module: string;
  readonly severity: 1 | 2 | 3 | 4 | 5;
  readonly likelihoodBand: number;
  readonly prevention: string;
  readonly detection: string;
  readonly mitigation: string;
  readonly evidence: string;
  readonly hardRule: string;
  readonly fallback: string;
  readonly acceptanceTests: readonly string[];
}

export const CONTROLS: Readonly<Record<string, ControlRequirement>> = Object.freeze({
${body}
});

export type DomainId = keyof typeof CONTROLS;

export const MODULES = ${j(modules)} as const;

export const controlsForModule = (m: string): ControlRequirement[] =>
  Object.values(CONTROLS).filter((c) => c.module === m);

export const blockingControls = (): ControlRequirement[] =>
  Object.values(CONTROLS).filter((c) => c.hardRule.startsWith('BLOCK'));
`,
);

console.log(`Generated ${controls.length} controls across ${modules.length} modules.`);
