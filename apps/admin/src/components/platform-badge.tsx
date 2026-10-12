import { PLATFORM_LABEL } from '../lib/labels.ts';

/** Which platform a player, group or message belongs to. */
export function PlatformBadge({ platform }: { platform: 'telegram' | 'rubika' }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs ${
        platform === 'telegram' ? 'border-accent/40 text-accent' : 'border-warn/40 text-warn'
      }`}
    >
      {PLATFORM_LABEL[platform]}
    </span>
  );
}
