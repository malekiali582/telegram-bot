import type { PlatformCapabilities } from './adapter.ts';
import type { OutgoingMessage } from './outgoing.ts';

const utf8 = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

/**
 * Checks a message against a platform's limits before it is queued, so the renderer
 * fails in tests instead of the platform rejecting it in production.
 * Returns human-readable problems; an empty array means the message is valid.
 */
export function validateOutgoing(message: OutgoingMessage, caps: PlatformCapabilities): string[] {
  const problems: string[] = [];

  if (message.text.trim() === '') problems.push('text is empty');
  // Platforms count characters (UTF-16 code units for Telegram) after entity parsing;
  // checking the raw length is a conservative upper bound.
  if (message.text.length > caps.maxTextLength) {
    problems.push(`text has ${message.text.length} chars, limit is ${caps.maxTextLength}`);
  }

  const rows = message.buttons ?? [];
  if (rows.length > caps.maxButtonRows) {
    problems.push(`${rows.length} button rows, limit is ${caps.maxButtonRows}`);
  }
  rows.forEach((row, r) => {
    if (row.length === 0) problems.push(`button row ${r} is empty`);
    if (row.length > caps.maxButtonsPerRow) {
      problems.push(`button row ${r} has ${row.length} buttons, limit is ${caps.maxButtonsPerRow}`);
    }
    row.forEach((button, b) => {
      if (button.label.trim() === '') problems.push(`button ${r}.${b} has an empty label`);
      if (button.kind === 'callback') {
        const bytes = utf8ByteLength(button.data);
        if (bytes === 0 || bytes > caps.maxCallbackDataBytes) {
          problems.push(
            `button ${r}.${b} callback data is ${bytes} bytes, allowed 1..${caps.maxCallbackDataBytes}`,
          );
        }
      }
      if (button.kind === 'url' && !/^https:\/\//.test(button.url)) {
        problems.push(`button ${r}.${b} url must be https`);
      }
    });
  });

  return problems;
}
