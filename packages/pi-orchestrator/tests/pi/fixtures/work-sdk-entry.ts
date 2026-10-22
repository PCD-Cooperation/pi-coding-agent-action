import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Agent } from '../../../src/pi/agent';
import type { PlatformProvider } from '../../../src/platform';
import type { ReviewUnitResult, ReviewWorkUnit } from '../../../src/review/work-types';
import type { FindingInput } from '../../../src/review/types';

const cwd = process.env.FIXTURE_DIR!;
writeFileSync(join(cwd, 'AGENTS.md'), 'AMBIENT_CONTEXT_MUST_NOT_LEAK');
writeFileSync(join(cwd, 'evidence.txt'), 'Pinned review evidence');
const mode = process.env.FIXTURE_ROLE ?? 'worker';
const worker = mode.startsWith('worker');
const recovery = mode === 'worker-recovery';
const finding: FindingInput = {
  id: 'F1',
  rootCause: 'Missing tenant predicate',
  origin: 'pr_introduced',
  lifecycle: 'fixed',
  material: true,
  location: 'evidence.txt:1',
  evidence: 'Pinned head restores tenant filtering.',
  originEvidence: 'Pinned merge-base omitted tenant filtering.',
  dispositionReason: 'The required tenant predicate is restored.',
};
const unit: ReviewWorkUnit = {
  id: 'unit-1',
  kind: 'diff',
  basis: 'full',
  paths: ['evidence.txt'],
  spans: recovery
    ? Array.from({ length: 12 }, (_, index) => ({
        id: createHash('sha256').update(`span-${index}`).digest('hex'),
        fileId: 'file-1',
        path: 'evidence.txt',
        previousPath: null,
        status: 'modified',
        binary: false,
        oldBlob: 'base',
        newBlob: 'head',
        patchPath: '/patch',
        patchStartLine: 1,
        patchEndLine: 1,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
      }))
    : [],
  findingIds: recovery ? ['F1'] : [],
  question: 'Review evidence',
};
const unitResult: ReviewUnitResult = {
  unitId: unit.id,
  status: 'reviewed',
  coveredSpanIds: unit.spans.map(span => span.id),
  reconciledFindingIds: [...unit.findingIds],
  assessment: 'The pinned evidence has been inspected.',
  limitations: [],
  findings: recovery ? [finding] : [],
  followUps: [],
};
const modelResult = {
  status: unitResult.status,
  assessment: unitResult.assessment,
  limitations: unitResult.limitations,
  findings: unitResult.findings,
  followUps: unitResult.followUps,
};
const warnings: string[] = [];
let requests = 0;
const toolSets: string[][] = [];
const submitProperties: string[][] = [];
let rejection = '';
let readSucceeded = false;
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as {
    tools: { name: string; input_schema?: { properties?: Record<string, unknown> } }[];
    messages: unknown[];
  };
  if (JSON.stringify(body).includes('AMBIENT_CONTEXT_MUST_NOT_LEAK')) {
    throw new Error('Ambient context leaked');
  }
  toolSets.push(body.tools.map(tool => tool.name));
  const submit = body.tools.find(tool => tool.name === 'submit_review_unit_result');
  if (submit) {
    submitProperties.push(Object.keys(submit.input_schema?.properties ?? {}));
  }
  requests++;
  if (requests >= 3) {
    rejection += JSON.stringify(body.messages.at(-1)) + '\n';
  }
  if (requests === 2) {
    readSucceeded = JSON.stringify(body.messages).includes('Pinned review evidence');
  }
  const name =
    requests === 1 ? 'read' : worker ? 'submit_review_unit_result' : 'request_review_followup';
  const args =
    requests === 1
      ? { path: join(cwd, 'evidence.txt') }
      : worker
        ? {
            ...modelResult,
            ...(recovery && requests === 2
              ? {
                  status: 'partial',
                  coveredSpans: ['S13'],
                  limitations: ['Inspection remains.'],
                  findings: [],
                }
              : recovery && requests === 3
                ? { findings: [] }
                : {}),
          }
        : {
            requests: [
              { paths: ['evidence.txt'], question: 'Verify the external caller contract.' },
            ],
          };
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `message-${requests}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-4-5',
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `tool-${requests}`, name, input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
};
const noop = () => undefined;
const agent = new Agent(
  {
    debug: noop,
    info: noop,
    warning: message => warnings.push(message),
    error: noop,
    notice: noop,
  },
  { type: 'github' } as PlatformProvider,
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    token: 'fake-isolated-token',
    promptInput: '',
    cwd,
    thinkingLevel: 'off',
    refreshModelCatalog: false,
    statefulReview: true,
    loadBuiltinExtensions: false,
    enableReviewSubagents: true,
    extensions: ['/must-not-load.ts'],
    loadedTools: [
      'read',
      'write',
      'bash',
      'subagent',
      'wait_subagents',
      'submit_review_result',
      'request_review_followup',
      'submit_review_unit_result',
    ],
    ...(worker ? { reviewWorkUnit: unit } : { reviewCoverageSynthesis: true }),
  }
);
try {
  await agent.ready();
  const result = await agent.run('Inspect evidence and return structured data.');
  console.info(
    JSON.stringify({
      result,
      toolSets,
      requests,
      readSucceeded,
      warnings,
      expectedSpanIds: unit.spans.map(span => span.id),
      rejection,
      submitProperties,
    })
  );
} finally {
  await agent.dispose();
}
