import { describe, expect, it } from 'vitest';
import { deviceLabel } from '@/shared/device';

describe('deviceLabel', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'iPhone · Safari',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      'Android · Chrome',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
      'Windows · Edge',
    ],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0', 'Mac · Firefox'],
    ['curl/8.0', 'Device · Browser'],
  ])('%s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });
});
