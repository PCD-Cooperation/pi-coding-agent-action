import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { registerBundledOAuthFlows } from '../../src/bundled-oauth';

registerBundledOAuthFlows();

const oauth = openaiCodexProvider().auth.oauth;
if (!oauth) {
  throw new Error('OpenAI Codex OAuth is unavailable');
}

const auth = await oauth.toAuth({
  type: 'oauth',
  access: 'bundled-access-token',
  refresh: 'bundled-refresh-token',
  expires: Date.now() + 60_000,
});

process.stdout.write(JSON.stringify(auth));
