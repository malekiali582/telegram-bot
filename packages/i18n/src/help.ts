import type { HelpGroup, TextCommandId } from './aliases.ts';
import { COMMANDS } from './aliases.ts';
import { escapeHtml } from './format.ts';

const GROUP_TITLES: Record<HelpGroup, string> = {
  basics: '👻 پایه',
  hunt: '🔪 شکار و غذا',
  assets: '💰 دارایی',
  city: '🏚 لولوآباد',
  ghosts: '🕯 روح‌ها',
};

const GROUP_ORDER: readonly HelpGroup[] = ['basics', 'hunt', 'assets', 'city', 'ghosts'];

/** Short, categorized help built from the command table (HTML). */
export function helpText(): string {
  const ids = Object.keys(COMMANDS) as TextCommandId[];
  const sections = GROUP_ORDER.map((group) => {
    const lines = ids
      .filter((id) => COMMANDS[id].helpGroup === group)
      .map((id) => {
        const spec = COMMANDS[id];
        return `• <b>${escapeHtml(spec.aliases[0])}</b>: ${escapeHtml(spec.help)}`;
      });
    return `<b>${GROUP_TITLES[group]}</b>\n${lines.join('\n')}`;
  });
  return ['<b>راهنمای لولو</b>', ...sections].join('\n\n');
}
