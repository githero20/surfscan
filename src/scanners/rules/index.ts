import { listTargets } from '../../core/runner.js';
import { LineIndex } from '../../core/text.js';
import type { Finding, Rule, ScanContext, Scanner, Severity, SourceProvider, SurfscanConfig } from '../../core/types.js';
import { findingsFromMatches, type TextMatch } from '../shared.js';
import {
  findCredentialAccess,
  findEncodedBlocks,
  findHiddenContent,
  findInstructionOverride,
  findInvisibleChars,
  findPipeToShell,
  findRemoteInstructions,
  findUnpinnedInstalls,
} from './patterns.js';

/** Agent instruction files, at any depth so monorepo packages are covered. */
export const RULES_TARGETS = [
  '**/CLAUDE.md',
  '**/CLAUDE.local.md',
  '**/AGENTS.md',
  '**/.cursorrules',
  '**/.cursor/rules/**/*',
  '**/.github/copilot-instructions.md',
];

export function findRulesTargets(provider: SourceProvider, config: SurfscanConfig): Promise<string[]> {
  return listTargets(provider, config, RULES_TARGETS);
}

interface TextRuleSpec {
  id: string;
  severity: Severity;
  title: string;
  detect: (text: string) => TextMatch[];
  message: (detail: string) => string;
  fix: string;
}

function textRule(spec: TextRuleSpec): Rule {
  return {
    id: spec.id,
    severity: spec.severity,
    title: spec.title,
    check(context: ScanContext): Finding[] {
      const out: Finding[] = [];
      for (const file of context.files) {
        const matches = spec.detect(file.content);
        if (matches.length === 0) continue;
        out.push(...findingsFromMatches(spec, file, matches, spec.message, spec.fix, new LineIndex(file.content)));
      }
      return out;
    },
  };
}

export const rules: Rule[] = [
  textRule({
    id: 'RULES-001',
    severity: 'high',
    title: 'Invisible Unicode in instruction file',
    detect: findInvisibleChars,
    message: (d) => `Invisible Unicode in instruction file: ${d}`,
    fix: 'remove the hidden characters and review the surrounding text',
  }),
  textRule({
    id: 'RULES-002',
    severity: 'high',
    title: 'Hidden instructions in comment or markup',
    detect: findHiddenContent,
    message: (d) => `Hidden content in instruction file, ${d}`,
    fix: 'move the text into visible prose or delete it; agents read comments that rendered previews hide',
  }),
  textRule({
    id: 'RULES-003',
    severity: 'high',
    title: 'Download piped into a shell',
    detect: findPipeToShell,
    message: (d) => `Download piped into a shell: ${d}`,
    fix: 'download the script, review it, pin it by checksum, then run the local copy',
  }),
  textRule({
    id: 'RULES-004',
    severity: 'high',
    title: 'Instruction to read or send credentials',
    detect: findCredentialAccess,
    message: (d) => `Instruction touches credentials: ${d}`,
    fix: 'remove the instruction; agents should never read or transmit secrets, env files or SSH keys',
  }),
  textRule({
    id: 'RULES-005',
    severity: 'high',
    title: 'Instruction to override earlier instructions or skip confirmation',
    detect: findInstructionOverride,
    message: (d) => `Instruction overrides safeguards: ${d}`,
    fix: 'remove the instruction; keep human confirmation for actions with side effects',
  }),
  textRule({
    id: 'RULES-006',
    severity: 'medium',
    title: 'Long encoded block in instruction file',
    detect: findEncodedBlocks,
    message: (d) => `Encoded content in instruction file: ${d}`,
    fix: 'decode and review the block; replace it with plain text or a reference to a reviewed file',
  }),
  textRule({
    id: 'RULES-007',
    severity: 'medium',
    title: 'Instruction to install unpinned packages',
    detect: findUnpinnedInstalls,
    message: (d) => `Unpinned package install: ${d}`,
    fix: 'pin exact versions (for example pkg@1.2.3 or pkg==1.2.3) or install from the lock file',
  }),
  textRule({
    id: 'RULES-008',
    severity: 'medium',
    title: 'Instruction to fetch and follow an external URL',
    detect: findRemoteInstructions,
    message: (d) => `Instructions loaded from an external URL: ${d}`,
    fix: 'copy the reviewed instructions into the repo instead of telling the agent to fetch and follow them',
  }),
];

export const rulesScanner: Scanner = {
  name: 'rules',
  rules,
  findTargets: findRulesTargets,
};
