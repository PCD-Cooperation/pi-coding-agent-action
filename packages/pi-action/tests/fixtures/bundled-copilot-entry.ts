import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCopilotCredentials } from '../../../pi-orchestrator/src/pi/copilot-credentials';
import { registerBundledOAuthFlows } from '../../src/bundled-oauth';

registerBundledOAuthFlows();

let exchanges = 0;
const masked: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  if (url.pathname === '/copilot_internal/v2/token') {
    if ((init?.headers as Record<string, string>).Authorization !== 'Bearer ghu_bundle-test') {
      throw new Error('Unexpected OAuth identity');
    }
    exchanges++;
    return Response.json({
      token: `tid=${exchanges};proxy-ep=proxy.business.githubcopilot.com;`,
      expires_at: Date.now() / 1000 + 3600,
    });
  }
  if (url.href === 'https://api.business.githubcopilot.com/models') {
    return Response.json({
      data: [{ id: 'gpt-6-luna', model_picker_enabled: true, policy: { state: 'enabled' } }],
    });
  }
  throw new Error(`Unexpected network request: ${url.href}`);
};

async function main() {
  const credentials = await createCopilotCredentials(
    { provider: 'github-copilot', token: '', copilotOAuthToken: 'ghu_bundle-test' },
    token => masked.push(token)
  );
  const runtime = await ModelRuntime.create({
    credentials: credentials!,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModel('github-copilot', 'gpt-6-luna')!;
  const first = await runtime.getAuth(model);
  await credentials!.modify('github-copilot', async current =>
    current?.type === 'oauth' ? { ...current, expires: 0 } : current
  );
  const renewed = await Promise.all(Array.from({ length: 5 }, () => runtime.getAuth(model)));
  process.stdout.write(
    JSON.stringify({
      exchanges,
      baseUrl: first?.auth.baseUrl,
      renewed: renewed.every(auth => auth?.auth.apiKey !== first?.auth.apiKey),
      masked: renewed.every(
        auth => typeof auth?.auth.apiKey === 'string' && masked.includes(auth.auth.apiKey)
      ),
    })
  );
}

void main();
