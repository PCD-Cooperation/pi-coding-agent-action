import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AuthOperationOptions, Credential, CredentialStore } from '@earendil-works/pi-ai';
import type { PiConfig } from '../types';

/** In-memory OAuth storage that masks new Copilot access tokens before use. */
class CopilotCredentials extends InMemoryCredentialStore {
  constructor(private readonly maskToken?: (token: string) => void) {
    super();
  }

  override modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    return super.modify(
      providerId,
      async current => {
        const next = await fn(current);
        if (next?.type === 'oauth' && next.access) {
          this.maskToken?.(next.access);
        }
        return next;
      },
      options
    );
  }
}

/** Seed Pi's native OAuth resolver; every run starts with an expired Copilot token. */
export async function createCopilotCredentials(
  config: Pick<PiConfig, 'provider' | 'token' | 'copilotOAuthToken'>,
  maskToken?: (token: string) => void
): Promise<CredentialStore | undefined> {
  const oauthToken = config.copilotOAuthToken;
  if (!oauthToken) {
    return undefined;
  }
  if (config.provider !== 'github-copilot' || config.token) {
    throw new Error(
      'copilot_oauth_token requires provider github-copilot and an empty token input.'
    );
  }
  if (!/^gh[ou]_/.test(oauthToken)) {
    throw new Error(
      'copilot_oauth_token requires a GitHub user OAuth token, not an installation or Copilot access token.'
    );
  }
  const credentials = new CopilotCredentials(maskToken);
  await credentials.modify('github-copilot', async () => ({
    type: 'oauth',
    refresh: oauthToken,
    access: '',
    expires: 0,
  }));
  return credentials;
}
