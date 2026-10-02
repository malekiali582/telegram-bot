import { describe, expect, it } from 'vitest';
import type { PlatformCapabilities } from './adapter.ts';
import { PlatformSendError } from './adapter.ts';
import type { OutgoingMessage } from './outgoing.ts';
import { utf8ByteLength, validateOutgoing } from './validate.ts';

const caps: PlatformCapabilities = {
  maxTextLength: 4096,
  maxCallbackDataBytes: 64,
  maxButtonsPerRow: 8,
  maxButtonRows: 100,
  canEditMessages: true,
};

const base: OutgoingMessage = { platformChatId: '-100123', text: 'سلام', format: 'html' };

describe('validateOutgoing', () => {
  it('accepts a well-formed message with buttons', () => {
    expect(
      validateOutgoing(
        {
          ...base,
          buttons: [
            [{ kind: 'callback', label: 'تأیید', data: 'c:0123456789abcdef' }],
            [{ kind: 'url', label: 'راهنما', url: 'https://core.telegram.org/bots/faq' }],
          ],
        },
        caps,
      ),
    ).toEqual([]);
  });

  it('measures callback data in UTF-8 bytes, not characters', () => {
    // 32 Persian letters are 64 bytes; 33 overflow Telegram's 64-byte limit.
    expect(utf8ByteLength('ل'.repeat(32))).toBe(64);
    const ok = { kind: 'callback', label: 'x', data: 'ل'.repeat(32) } as const;
    const tooLong = { kind: 'callback', label: 'x', data: 'ل'.repeat(33) } as const;
    expect(validateOutgoing({ ...base, buttons: [[ok]] }, caps)).toEqual([]);
    expect(validateOutgoing({ ...base, buttons: [[tooLong]] }, caps)).toHaveLength(1);
  });

  it('rejects empty text, overlong text, empty rows/labels and non-https urls', () => {
    expect(validateOutgoing({ ...base, text: '  ' }, caps)).toHaveLength(1);
    expect(validateOutgoing({ ...base, text: 'a'.repeat(4097) }, caps)).toHaveLength(1);
    expect(validateOutgoing({ ...base, buttons: [[]] }, caps)).toHaveLength(1);
    expect(
      validateOutgoing({ ...base, buttons: [[{ kind: 'add_to_group', label: ' ' }]] }, caps),
    ).toHaveLength(1);
    expect(
      validateOutgoing(
        { ...base, buttons: [[{ kind: 'url', label: 'x', url: 'http://example.com' }]] },
        caps,
      ),
    ).toHaveLength(1);
  });

  it('enforces button grid limits', () => {
    const row = Array.from({ length: 9 }, (_, i) => ({
      kind: 'callback' as const,
      label: String(i),
      data: String(i),
    }));
    expect(validateOutgoing({ ...base, buttons: [row] }, caps)).toHaveLength(1);
  });
});

describe('PlatformSendError', () => {
  it('carries the retry hint for rate limiting', () => {
    const err = new PlatformSendError('rate_limited', 'Too Many Requests', 7);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBe(7);
  });
});
