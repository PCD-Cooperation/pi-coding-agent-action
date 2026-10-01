import { afterEach, expect, test, vi } from 'vitest';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCopilotCredentials } from '../../src/pi/copilot-credentials';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('native Pi caches and renews Copilot OAuth in memory, including concurrent calls', async () => {
  let now = Date.now();
  let exchanges = 0;
  let revoked = false;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (url.pathname === '/copilot_internal/v2/token') {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer ghu_offline-proof'
      );
      exchanges++;
      if (revoked) {
        return new Response('Revoked', { status: 401 });
      }
      return Response.json({
        token: `tid=${exchanges};proxy-ep=proxy.business.githubcopilot.com;`,
        expires_at: now / 1000 + 3600,
      });
    }
    expect(url.href).toBe('https://api.business.githubcopilot.com/models');
    return Response.json({
      data: [{ id: 'gpt-6-luna', model_picker_enabled: true, policy: { state: 'enabled' } }],
    });
  });
  const maskToken = vi.fn();
  const credentials = await createCopilotCredentials(
    { provider: 'github-copilot', token: '', copilotOAuthToken: 'ghu_offline-proof' },
    maskToken
  );
  expect(credentials).toBeDefined();
  const runtime = await ModelRuntime.create({
    credentials: credentials!,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModel('github-copilot', 'gpt-6-luna')!;
  const first = await runtime.getAuth(model);
  expect(first?.auth.baseUrl).toBe('https://api.business.githubcopilot.com');
  expect(exchanges).toBe(1);
  expect(maskToken).toHaveBeenCalledWith(first?.auth.apiKey);
  expect((await runtime.getAuth(model))?.auth.apiKey).toBe(first?.auth.apiKey);
  expect(exchanges).toBe(1);
  now += 3600 * 1000;
  const renewed = await Promise.all(Array.from({ length: 5 }, () => runtime.getAuth(model)));
  expect(exchanges).toBe(2);
  expect(renewed.every(item => item?.auth.apiKey !== first?.auth.apiKey)).toBe(true);
  expect(maskToken).toHaveBeenCalledTimes(2);
  revoked = true;
  now += 3600 * 1000;
  await expect(runtime.getAuth(model)).rejects.toThrow('OAuth refresh failed');
});

test.each([
  { provider: 'openrouter', token: '', copilotOAuthToken: 'ghu_user' },
  { provider: 'github-copilot', token: 'api-key', copilotOAuthToken: 'ghu_user' },
  { provider: 'github-copilot', token: '', copilotOAuthToken: 'ghs_installation' },
])('rejects incompatible Copilot OAuth configuration before creating a session', async config => {
  await expect(createCopilotCredentials(config)).rejects.toThrow('copilot_oauth_token');
});
