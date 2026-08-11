import { buildSubscriptionUrl } from './panel-client.interface';

describe('buildSubscriptionUrl public endpoint', () => {
  it('uses the Cloudflare subscription hostname without changing the internal panel origin', () => {
    const link = buildSubscriptionUrl(
      {
        baseUrl: 'https://127.0.0.1:8000/api/',
        subPort: 2096,
        subPath: '/sub/',
        extraConfig: { publicSubscriptionBaseUrl: 'https://sub.example.com' },
      },
      'token/value',
    );

    expect(link).toBe('https://sub.example.com/sub/token%2Fvalue');
  });
});
