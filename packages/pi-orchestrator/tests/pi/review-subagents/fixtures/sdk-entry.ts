import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createCopilotCredentials } from '../../../../src/pi/copilot-credentials';
import { reviewSubagentsFactory } from '../../../../src/pi/review-subagents/extension';
import { CHILD_TOOLS } from '../../../../src/pi/review-subagents/coordinator';
import { registerBundledOAuthFlows } from '../../../../../pi-action/src/bundled-oauth';

function stream(item: Record<string, unknown>, text?: string): Response {
  const events: Record<string, unknown>[] = [
    {
      type: 'response.created',
      response: { id: 'response-test', status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
  ];
  if (text !== undefined) {
    events.push(
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }
    );
  }
  events.push(
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'response-test',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }
  );
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function main() {
  registerBundledOAuthFlows();
  const cwd = process.env.FIXTURE_DIR!;
  const evidence = join(cwd, 'evidence.txt');
  writeFileSync(evidence, 'current PR evidence');
  let exchanges = 0;
  let inference = 0;
  let parentRequests = 0;
  const efforts: unknown[] = [];
  const toolSets: string[][] = [];
  const masked: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (url.pathname === '/copilot_internal/v2/token') {
      if ((init?.headers as Record<string, string>).Authorization !== 'Bearer ghu_offline-review') {
        throw new Error('Wrong OAuth identity');
      }
      exchanges++;
      return Response.json({
        token: 'tid=offline;proxy-ep=proxy.individual.githubcopilot.com;',
        expires_at: Date.now() / 1000 + 3600,
      });
    }
    if (url.pathname === '/models') {
      return Response.json({
        data: [{ id: 'gpt-6-luna', model_picker_enabled: true, policy: { state: 'enabled' } }],
      });
    }
    if (url.pathname !== '/responses') {
      throw new Error(`Unexpected network request: ${url.href}`);
    }
    const body = JSON.parse(String(init?.body)) as {
      reasoning: { effort: string };
      tools: { name: string }[];
      input: { type: string }[];
    };
    efforts.push(body.reasoning.effort);
    toolSets.push(body.tools.map(tool => tool.name));
    inference++;
    if (body.reasoning.effort === 'max') {
      parentRequests++;
      const names = ['subagent', 'codemode', 'wait_subagents'];
      const args = [
        {
          tasks: [
            { scope: 'flow A', task: 'Review evidence.txt' },
            { scope: 'flow B', task: 'Independently review evidence.txt' },
          ],
        },
        { code: `text(await tools.read({path: ${JSON.stringify(evidence)}}));` },
        {},
      ];
      if (parentRequests <= 3) {
        return stream({
          id: `parent-tool-${parentRequests}`,
          type: 'function_call',
          call_id: `parent-call-${parentRequests}`,
          name: names[parentRequests - 1],
          arguments: JSON.stringify(args[parentRequests - 1]),
          status: 'completed',
        });
      }
      const text =
        '## Findings\nNo blocking findings.\n\n## Notes\nBoth child scopes verified.\n\n## Merge Decision\nAPPROVE: no blocking issues found';
      return stream(
        {
          id: 'parent-report',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
        text
      );
    }
    if (
      !body.input.some(
        item => item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
      )
    ) {
      return stream({
        id: `tool-${inference}`,
        type: 'function_call',
        call_id: `call-${inference}`,
        name: 'codemode',
        arguments: JSON.stringify({
          code: `text(await tools.read({path: ${JSON.stringify(evidence)}}));`,
        }),
        status: 'completed',
      });
    }
    const text = 'Verified current PR evidence; no blocking finding in assigned scope.';
    return stream(
      {
        id: `msg-${inference}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
      text
    );
  };
  const runtime = await ModelRuntime.create({
    credentials: (await createCopilotCredentials(
      { provider: 'github-copilot', token: '', copilotOAuthToken: 'ghu_offline-review' },
      token => masked.push(token)
    ))!,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel('github-copilot', 'gpt-6-luna')!;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      reviewSubagentsFactory(process.env.SUBAGENT_ENTRY!, runtime, () => undefined),
    ],
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) {
    throw new Error(JSON.stringify(loader.getExtensions().errors));
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'max',
    tools: [...CHILD_TOOLS, 'subagent', 'wait_subagents'],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  try {
    await session.bindExtensions({ mode: 'print' });
    session.setActiveToolsByName([...CHILD_TOOLS, 'subagent', 'wait_subagents']);
    await session.prompt(
      'Review alone by default. For this fixture, delegate two distinct scopes, continue reading evidence yourself using codemode, collect all children, then publish one final report.'
    );
    const tools = session.agent.state.tools;
    const messages = session.agent.state.messages;
    const collected = messages.find(
      message => message.role === 'toolResult' && message.toolName === 'wait_subagents'
    );
    if (collected?.role !== 'toolResult') {
      throw new Error('Missing child collection');
    }
    const parentRead = messages.find(
      message => message.role === 'toolResult' && message.toolName === 'codemode'
    );
    if (parentRead?.role !== 'toolResult') {
      throw new Error('Missing parent codemode read');
    }
    const repeated = await tools
      .find(tool => tool.name === 'wait_subagents')!
      .execute('collect-again', {});
    const text = collected.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
    if (!text.includes('review-1 (completed)')) {
      throw new Error(text);
    }
    const finalMessage = messages.at(-1);
    if (finalMessage?.role !== 'assistant') {
      throw new Error('Missing final report');
    }
    const report = finalMessage.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('');
    console.info(
      JSON.stringify({
        report,
        totalTokens: session.getSessionStats().tokens.total,
        parentRead: parentRead.content,
        efforts,
        toolSets,
        exchanges,
        masked: masked.length,
        inference,
        tokens: collected.usage?.totalTokens,
        repeatTokens: repeated.usage?.totalTokens,
      })
    );
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
}
void main();
