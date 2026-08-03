import { describe, expect, it } from 'vitest';
import { createClient } from './index';

// Placeholder coverage: there is no protocol yet, so the only behaviour to pin is that the base URL
// is normalized to an origin. Its real job is to prove the `client` vitest project is wired into
// the root orchestrator and runs against the source rather than dist/.
describe('createClient', () => {
  it('reduces a base URL to its origin', () => {
    expect(createClient({ baseUrl: 'https://nachbarin.example/', apiKey: 'k' }).baseUrl).toBe('https://nachbarin.example');
    expect(createClient({ baseUrl: 'https://nachbarin.example/v1/records?x=1', apiKey: 'k' }).baseUrl).toBe('https://nachbarin.example');
  });

  it('rejects a base URL that is not absolute', () => {
    expect(() => createClient({ baseUrl: '/v1/records', apiKey: 'k' })).toThrow();
  });
});
