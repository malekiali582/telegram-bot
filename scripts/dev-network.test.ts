import { describe, expect, it } from 'vitest';
import { proxyUrlFromSystemSetting, redactProxy } from './dev-network.ts';

describe('dev network helpers', () => {
  it('turns the Windows ProxyServer value into a TELEGRAM_PROXY address', () => {
    expect(proxyUrlFromSystemSetting('127.0.0.1:12334')).toBe('http://127.0.0.1:12334');
    expect(proxyUrlFromSystemSetting('http://127.0.0.1:10809')).toBe('http://127.0.0.1:10809');
    expect(proxyUrlFromSystemSetting('http=127.0.0.1:8080;https=127.0.0.1:8443')).toBe(
      'http://127.0.0.1:8443',
    );
    expect(proxyUrlFromSystemSetting('http=127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('suggests nothing for SOCKS-only or empty settings', () => {
    expect(proxyUrlFromSystemSetting('socks=127.0.0.1:1080')).toBeUndefined();
    expect(proxyUrlFromSystemSetting('socks5://127.0.0.1:1080')).toBeUndefined();
    expect(proxyUrlFromSystemSetting('')).toBeUndefined();
  });

  it('hides proxy credentials before printing', () => {
    expect(redactProxy('http://user:secret@127.0.0.1:8080')).toBe('http://***@127.0.0.1:8080');
    expect(redactProxy('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });
});
