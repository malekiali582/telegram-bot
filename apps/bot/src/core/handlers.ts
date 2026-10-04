import type { CurseKind, FoodKind, ToolKind } from '@lulu/config';
import type { DomainContext, GroupRole, GroupUpgradeResult } from '@lulu/domain';
import {
  buyTool,
  cemeteryView,
  cityView,
  claimLolo,
  depositToTreasury,
  donateBlood,
  donateHunt,
  eat,
  equipTool,
  findUserIdByIdentity,
  hearGhost,
  hunt,
  openCemetery,
  playerFearRank,
  playerProfile,
  previewLevelUpgrade,
  scaryLeaderboard,
  searchGhost,
  toolShop,
  transfer,
  treasuryView,
  upgradeBloodBank,
  upgradeCemetery,
  upgradeCity,
  upgradeCurse,
  upgradeHuntingGround,
  upgradeLevel,
  withdrawFromTreasury,
} from '@lulu/domain';
import type { ParsedCommand } from '@lulu/i18n';
import { CURSE_NAMES, FOOD_NAMES, TOOL_NAMES, helpText } from '@lulu/i18n';
import type { MemberRole, ReplyTarget, Sender } from '@lulu/platform';
import type { ButtonSpec, PendingButton } from './buttons.ts';
import { confirmRow, makeButtons } from './buttons.ts';
import type { Conversation, Reply } from './reply.ts';
import { answer, edit, send } from './reply.ts';
import { T } from './texts.ts';

/** What a handler knows about the event it is handling. `ctx.db` is the update transaction. */
export interface HandlerContext {
  ctx: DomainContext;
  conv: Conversation;
  userId: number;
  sender: Sender;
  groupId: number | null;
  /** Live role in the group, fetched before the transaction for admin-only actions. */
  role: MemberRole | undefined;
  replyTo: ReplyTarget | undefined;
}

export const ADMIN_COMMANDS = new Set([
  'city_upgrade',
  'blood_bank_upgrade',
  'hunting_ground_upgrade',
  'curse_upgrade',
]);
export const ADMIN_OPS = new Set(['city_upgrade']);

const managerRole = (role: MemberRole | undefined): GroupRole =>
  role === 'owner' || role === 'admin' ? role : 'member';

const buttons = (h: HandlerContext, rows: ButtonSpec[][]) =>
  makeButtons(
    h.ctx,
    { userId: h.userId, groupId: h.groupId, platform: h.conv.platform, chatId: h.conv.chatId },
    rows,
  );

const confirm = (h: HandlerContext, op: string, params: Record<string, unknown>) =>
  buttons(h, confirmRow(op, params, { confirm: T.btn.confirm, cancel: T.btn.cancel }));

const now = (h: HandlerContext) => h.ctx.clock.now();

// ───────────────────────── previews (shared by commands and prompt buttons) ─────────────────────────

/** Text + confirm buttons for an operation, or just a text explaining why it is not possible. */
interface Preview {
  text: string;
  rows?: ButtonSpec[][];
}

async function preview(
  h: HandlerContext,
  op: string,
  p: Record<string, unknown>,
): Promise<Preview> {
  const ok = (text: string): Preview => ({
    text: `${text}\n${T.confirmPrompt}`,
    rows: confirmRow(op, p, { confirm: T.btn.confirm, cancel: T.btn.cancel }),
  });
  switch (op) {
    case 'level_upgrade': {
      const v = await previewLevelUpgrade(h.ctx, h.userId);
      if (v.status === 'banned') return { text: T.banned };
      if (v.status === 'max_level') return { text: T.levelMax };
      if (!v.affordable) return { text: T.levelNotAffordable(v.costCenti, v.cashCenti) };
      p.expectedLevel = v.currentLevel;
      return ok(T.levelPreview(v.currentLevel, v.costCenti, v.cashCenti));
    }
    case 'tool_buy': {
      const tool = p.tool as ToolKind;
      const shop = await toolShop(h.ctx, h.userId);
      const item = shop.items.find((i) => i.tool === tool)!;
      if (item.owned) return { text: T.toolOwned(tool) };
      if (shop.cashCenti < item.priceCenti) return { text: T.insufficient(shop.cashCenti) };
      return ok(T.toolPreview(tool, item.priceCenti, shop.cashCenti));
    }
    case 'eat': {
      const food = p.food as FoodKind;
      const count = p.count as number;
      const profile = await playerProfile(h.ctx, h.userId);
      if (profile.inventory[food] < count)
        return { text: T.notEnoughFood(food, profile.inventory[food]) };
      const active = profile.meals.active.length;
      if (active + count > profile.meals.capacity) {
        return { text: T.eatCapacity(active, profile.meals.capacity, count) };
      }
      return ok(T.eatPreview(food, count));
    }
    case 'cemetery_open': {
      const v = await cemeteryView(h.ctx, h.userId);
      if (v.status === 'banned') return { text: T.banned };
      if (v.status === 'open') return { text: T.cemeteryAlreadyOpen };
      if (v.cashCenti < v.openCostCenti) return { text: T.insufficient(v.cashCenti) };
      return ok(T.cemeteryOpenPreview(v.openCostCenti));
    }
    case 'cemetery_upgrade': {
      const v = await cemeteryView(h.ctx, h.userId);
      if (v.status === 'banned') return { text: T.banned };
      if (v.status === 'closed') return { text: T.cemeteryNotOpen };
      if (v.nextUpgradeCostCenti === null) return { text: T.maxLevelReached };
      if (v.cashCenti < v.nextUpgradeCostCenti) return { text: T.insufficient(v.cashCenti) };
      p.expectedLevel = v.level;
      return ok(T.cemeteryUpgradePreview(v.level, v.nextUpgradeCostCenti));
    }
    case 'treasury_deposit':
    case 'treasury_withdraw':
    case 'donate_blood': {
      const amount = BigInt(p.amount as string);
      const v = await treasuryView(h.ctx, h.userId);
      if (v.status === 'banned') return { text: T.banned };
      const available = op === 'treasury_withdraw' ? v.treasuryCenti : v.cashCenti;
      if (available < amount) return { text: T.insufficient(available) };
      if (op === 'donate_blood') return ok(T.donateBloodPreview(amount));
      return ok(op === 'treasury_deposit' ? T.depositPreview(amount) : T.withdrawPreview(amount));
    }
    case 'donate_hunt': {
      const food = p.food as FoodKind;
      const count = p.count as number;
      const profile = await playerProfile(h.ctx, h.userId);
      if (profile.inventory[food] < count)
        return { text: T.notEnoughFood(food, profile.inventory[food]) };
      return ok(T.donateHuntPreview(food, count));
    }
    case 'city_upgrade': {
      if (h.groupId === null) return { text: T.groupOnly };
      const v = await cityView(h.ctx, h.groupId);
      const part = p.part as 'city' | 'bank' | 'ground' | 'curse';
      if (part === 'city') {
        if (!v.next.city) return { text: T.maxLevelReached };
        p.expectedLevel = v.level;
        return ok(
          T.upgradePreview('آبادی', v.next.city.bloodBankCostCenti, v.next.city.huntPointsCost),
        );
      }
      if (part === 'bank') {
        if (!v.next.bloodBank) return { text: T.maxLevelReached };
        p.expectedLevel = v.bloodBank.level;
        return ok(T.upgradePreview('بانک خون', v.next.bloodBank.costCenti));
      }
      if (part === 'ground') {
        if (!v.next.huntingGround) return { text: T.maxLevelReached };
        p.expectedLevel = v.huntingGround.level;
        return ok(T.upgradePreview('شکارگاه', v.next.huntingGround.costCenti));
      }
      const curse = p.curse as CurseKind;
      const next = v.next.curses[curse];
      if (!next) return { text: T.maxLevelReached };
      p.expectedLevel = v.curses[curse].level;
      return ok(T.upgradePreview(`نفرین «${CURSE_NAMES[curse]}»`, next.costCenti));
    }
    default:
      return { text: T.button.invalid };
  }
}

async function sendPreview(
  h: HandlerContext,
  op: string,
  params: Record<string, unknown>,
): Promise<Reply[]> {
  const pv = await preview(h, op, params);
  return [send(h.conv, pv.text, pv.rows ? { buttons: await buttons(h, pv.rows) } : {})];
}

// ───────────────────────── operations (run on «تأیید») ─────────────────────────

const upgradeText = (what: string, r: GroupUpgradeResult): string => {
  switch (r.status) {
    case 'ok':
      return T.upgradeDone(what, r.newLevel);
    case 'not_admin':
      return T.onlyAdmins;
    case 'stale':
    case 'duplicate':
      return T.stale;
    case 'max_level':
      return T.maxLevelReached;
    case 'population_too_low':
      return T.populationLow(r.active, r.required);
    case 'insufficient_bank':
      return T.bankLow(r.costCenti, r.balanceCenti);
    case 'insufficient_hunt_points':
      return T.huntPointsLow(r.cost, r.available);
    case 'requires_city_level':
      return T.needsCityLevel(r.required);
    case 'requires_bank_level':
      return T.needsBankLevel(r.maxForBank);
    case 'banned':
      return T.banned;
  }
};

async function runOp(
  h: HandlerContext,
  op: string,
  p: Record<string, unknown>,
  key: string,
): Promise<string> {
  const userId = h.userId;
  switch (op) {
    case 'level_upgrade': {
      const r = await upgradeLevel(h.ctx, {
        userId,
        expectedLevel: p.expectedLevel as number,
        idempotencyKey: key,
      });
      if (r.status === 'ok') return T.levelOk(r.newLevel, r.cashCenti);
      if (r.status === 'insufficient_funds') return T.levelNotAffordable(r.costCenti, r.cashCenti);
      if (r.status === 'max_level') return T.levelMax;
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'tool_buy': {
      const tool = p.tool as ToolKind;
      const r = await buyTool(h.ctx, { userId, tool, idempotencyKey: key });
      if (r.status === 'ok') return T.toolOk(tool, r.equipped);
      if (r.status === 'already_owned') return T.toolOwned(tool);
      if (r.status === 'insufficient_funds') return T.insufficient(r.cashCenti);
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'eat': {
      const r = await eat(h.ctx, {
        userId,
        food: p.food as FoodKind,
        count: p.count as number,
        idempotencyKey: key,
      });
      if (r.status === 'ok')
        return T.eatOk(r.food, r.count, r.expiresAt, r.activeMeals, r.capacity);
      if (r.status === 'capacity_exceeded') return T.eatCapacity(r.active, r.capacity, r.requested);
      if (r.status === 'not_enough_food') return T.notEnoughFood(r.food, r.have);
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'cemetery_open': {
      const r = await openCemetery(h.ctx, { userId, idempotencyKey: key });
      if (r.status === 'ok') return T.cemeteryOpened;
      if (r.status === 'already_open') return T.cemeteryAlreadyOpen;
      if (r.status === 'insufficient_funds') return T.insufficient(r.cashCenti);
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'cemetery_upgrade': {
      const r = await upgradeCemetery(h.ctx, {
        userId,
        expectedLevel: p.expectedLevel as number,
        idempotencyKey: key,
      });
      if (r.status === 'ok') return T.cemeteryUpgraded(r.newLevel);
      if (r.status === 'insufficient_funds') return T.insufficient(r.cashCenti);
      if (r.status === 'max_level') return T.maxLevelReached;
      if (r.status === 'not_open') return T.cemeteryNotOpen;
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'treasury_deposit':
    case 'treasury_withdraw': {
      const move = op === 'treasury_deposit' ? depositToTreasury : withdrawFromTreasury;
      const r = await move(h.ctx, {
        userId,
        amountCenti: BigInt(p.amount as string),
        idempotencyKey: key,
      });
      if (r.status === 'ok') return T.moved(r.cashCenti, r.treasuryCenti);
      if (r.status === 'insufficient_funds') return T.insufficient(r.availableCenti);
      if (r.status === 'invalid_amount') return T.invalidAmount;
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'transfer': {
      const r = await transfer(h.ctx, {
        fromUserId: userId,
        toUserId: p.toUserId as number,
        amountCenti: BigInt(p.amount as string),
        ...(h.groupId !== null ? { groupId: h.groupId } : {}),
        idempotencyKey: key,
      });
      if (r.status === 'ok')
        return T.transferOk(p.toName as string, r.amountCenti, r.senderCashCenti);
      if (r.status === 'insufficient_funds') return T.insufficient(r.availableCenti);
      if (r.status === 'recipient_banned') return T.recipientBanned;
      if (r.status === 'unknown_recipient') return T.notRegisteredTarget;
      if (r.status === 'self_transfer') return T.selfTransfer;
      if (r.status === 'invalid_amount') return T.invalidAmount;
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'donate_blood': {
      if (h.groupId === null) return T.groupOnly;
      const r = await donateBlood(h.ctx, {
        userId,
        groupId: h.groupId,
        amountCenti: BigInt(p.amount as string),
        idempotencyKey: key,
      });
      if (r.status === 'ok') return T.donateBloodOk(r.amountCenti, r.bankBalanceCenti);
      if (r.status === 'insufficient_funds') return T.insufficient(r.availableCenti);
      if (r.status === 'invalid_amount') return T.invalidAmount;
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'donate_hunt': {
      if (h.groupId === null) return T.groupOnly;
      const r = await donateHunt(h.ctx, {
        userId,
        groupId: h.groupId,
        food: p.food as FoodKind,
        count: p.count as number,
        idempotencyKey: key,
      });
      if (r.status === 'ok') return T.donateHuntOk(r.food, r.count, r.huntPoints, r.poolPoints);
      if (r.status === 'not_enough_food') return T.notEnoughFood(p.food as FoodKind, r.have);
      return r.status === 'banned' ? T.banned : T.stale;
    }
    case 'city_upgrade': {
      if (h.groupId === null) return T.groupOnly;
      const input = {
        groupId: h.groupId,
        actorUserId: userId,
        actorRole: managerRole(h.role),
        expectedLevel: p.expectedLevel as number,
        idempotencyKey: key,
      };
      switch (p.part) {
        case 'city':
          return upgradeText('آبادی', await upgradeCity(h.ctx, input));
        case 'bank':
          return upgradeText('بانک خون', await upgradeBloodBank(h.ctx, input));
        case 'ground':
          return upgradeText('شکارگاه', await upgradeHuntingGround(h.ctx, input));
        default: {
          const curse = p.curse as CurseKind;
          return upgradeText(
            `نفرین «${CURSE_NAMES[curse]}»`,
            await upgradeCurse(h.ctx, { ...input, curse }),
          );
        }
      }
    }
    default:
      return T.button.invalid;
  }
}

// ───────────────────────── text commands ─────────────────────────

/** Says exactly what was wrong with the argument, quoting it when it was not a number. */
function problemText(cmd: Extract<ParsedCommand, { kind: 'invalid' }>): string {
  const example = EXAMPLES[cmd.command] ?? cmd.command;
  switch (cmd.problem) {
    case 'missing':
    case 'empty':
      return T.missingArg(example);
    case 'unknown_item':
      return T.unknownItem;
    case 'too_precise':
      return T.tooPrecise;
    case 'zero':
      return T.amountZero;
    case 'negative':
      return T.amountNegative;
    case 'too_large':
      return T.amountTooLarge;
    case 'invalid': {
      if (cmd.argText === null) return T.invalidAmount;
      const text = T.amountNotANumber(cmd.argText, example);
      return cmd.command === 'transfer' ? `${text}\n${T.transferRecipientByReply}` : text;
    }
  }
}

/** Why a transfer cannot go to the replied-to message's author, if it cannot. */
function transferTargetProblem(h: HandlerContext): string | null {
  const target = h.replyTo;
  if (!target || !target.sender) return T.replyToPerson;
  if (target.fromThisBot || target.sender.isBot) return T.targetIsBot;
  if (target.sender.platformUserId === h.sender.platformUserId) return T.selfTransfer;
  return null;
}

const EXAMPLES: Record<string, string> = {
  treasury_deposit: 'واریز گنجینه ۱۰۰',
  treasury_withdraw: 'برداشت گنجینه ۱۰۰',
  transfer: 'انتقال ۱۰۰',
  donate_blood: 'اهدای خون ۵۰۰',
  donate_hunt: 'اهدای شکار موش ۲',
  tool_buy: 'خرید چاقو',
  tool_equip: 'تجهیز چاقو',
  eat: 'خوردن استخوان ۱',
  curse_upgrade: 'ارتقای نفرین شتاب شکار',
};

const GROUP_ONLY = new Set([
  'lolo',
  'hunt',
  'ghost_search',
  'heard',
  'transfer',
  'city',
  'blood_bank',
  'donate_blood',
  'donate_hunt',
  'city_upgrade',
  'blood_bank_upgrade',
  'hunting_ground',
  'hunting_ground_upgrade',
  'curses',
  'curse_upgrade',
]);

export async function handleCommand(h: HandlerContext, cmd: ParsedCommand): Promise<Reply[]> {
  if (GROUP_ONLY.has(cmd.command) && h.groupId === null) return [send(h.conv, T.groupOnly)];
  // A missing reply is the usual mistake («انتقال ۵۰ @someone»), so it is reported
  // before the amount: otherwise the player only hears that the amount is invalid.
  if (cmd.command === 'transfer') {
    const problem = transferTargetProblem(h);
    if (problem) return [send(h.conv, problem)];
  }
  if (cmd.kind === 'invalid') return [send(h.conv, problemText(cmd))];
  const t = now(h);
  const groupId = h.groupId!;
  const who = h.sender.displayName;

  switch (cmd.command) {
    case 'start': {
      const rows = await buttons(h, [
        [
          { label: T.btn.help, action: 'help' },
          { label: T.btn.cave, action: 'cave' },
        ],
      ]);
      return [
        send(h.conv, T.welcome(who), {
          buttons: [[{ kind: 'add_to_group', label: T.btn.addToGroup }], ...rows],
        }),
      ];
    }
    case 'help':
      return [send(h.conv, helpText())];

    case 'lolo': {
      const r = await claimLolo(h.ctx, { userId: h.userId, groupId });
      if (r.status === 'ok')
        return [send(h.conv, T.loloOk(who, r.basePoints, r.foodBonusPoints, r.cashCenti))];
      if (r.status === 'cooldown')
        return r.notify ? [send(h.conv, T.loloWait(who, r.remainingMs))] : [];
      return [send(h.conv, T.banned)];
    }
    case 'balance': {
      const v = await treasuryView(h.ctx, h.userId);
      return [send(h.conv, v.status === 'ok' ? T.balance(v) : T.banned)];
    }
    case 'cave':
      return [send(h.conv, T.cave(await playerProfile(h.ctx, h.userId), t))];
    case 'level_upgrade':
      return sendPreview(h, 'level_upgrade', {});

    case 'tool_shop': {
      const shop = await toolShop(h.ctx, h.userId);
      const rows: ButtonSpec[][] = shop.items
        .filter((i) => !i.equipped)
        .map((i) => [
          i.owned
            ? { label: `تجهیز ${TOOL_NAMES[i.tool]}`, action: 'equip', params: { tool: i.tool } }
            : {
                label: `خرید ${TOOL_NAMES[i.tool]}`,
                action: 'prompt',
                params: { op: 'tool_buy', tool: i.tool },
              },
        ]);
      return [
        send(h.conv, T.shop(shop.items, shop.cashCenti), { buttons: await buttons(h, rows) }),
      ];
    }
    case 'tool_buy':
      return sendPreview(h, 'tool_buy', { tool: cmd.args.tool });
    case 'tool_equip': {
      const r = await equipTool(h.ctx, { userId: h.userId, tool: cmd.args.tool });
      if (r.status === 'ok') return [send(h.conv, T.equipped(r.tool))];
      return [send(h.conv, r.status === 'not_owned' ? T.toolNotOwned(r.tool) : T.banned)];
    }

    case 'hunt':
      return [send(h.conv, T.hunt(who, await hunt(h.ctx, { userId: h.userId, groupId }), t))];
    case 'cellar':
    case 'eat': {
      if (cmd.command === 'eat' && cmd.args.pick) {
        return sendPreview(h, 'eat', { food: cmd.args.pick.food, count: cmd.args.pick.count });
      }
      const p = await playerProfile(h.ctx, h.userId);
      const foods = (Object.keys(p.inventory) as FoodKind[]).filter((f) => p.inventory[f] > 0);
      const rows = foods.map((f) => [
        {
          label: `خوردن ${FOOD_NAMES[f]}`,
          action: 'prompt',
          params: { op: 'eat', food: f, count: 1 },
        },
      ]);
      return [
        send(h.conv, T.cellar(p.inventory, p.meals.active.length, p.meals.capacity), {
          buttons: await buttons(h, rows),
        }),
      ];
    }

    case 'cemetery': {
      const v = await cemeteryView(h.ctx, h.userId);
      const rows: ButtonSpec[][] =
        v.status === 'closed'
          ? [[{ label: 'افتتاح قبرستان', action: 'prompt', params: { op: 'cemetery_open' } }]]
          : v.status === 'open' && v.nextUpgradeCostCenti !== null
            ? [[{ label: 'ارتقای قبرستان', action: 'prompt', params: { op: 'cemetery_upgrade' } }]]
            : [];
      return [send(h.conv, T.cemetery(v), { buttons: await buttons(h, rows) })];
    }

    case 'treasury': {
      const v = await treasuryView(h.ctx, h.userId);
      return [send(h.conv, v.status === 'ok' ? T.treasury(v, t) : T.banned)];
    }
    case 'treasury_deposit':
    case 'treasury_withdraw':
    case 'donate_blood':
      return sendPreview(h, cmd.command, { amount: cmd.args.amountCenti.toString() });

    case 'transfer': {
      const target = h.replyTo!.sender!; // checked by transferTargetProblem
      const toUserId = await findUserIdByIdentity(h.ctx.db, h.conv.platform, target.platformUserId);
      if (toUserId === undefined) return [send(h.conv, T.notRegisteredTarget)];
      const amount = cmd.args.amountCenti;
      const v = await treasuryView(h.ctx, h.userId);
      if (v.status !== 'ok') return [send(h.conv, T.banned)];
      if (v.cashCenti < amount) return [send(h.conv, T.insufficient(v.cashCenti))];
      const rows = await confirm(h, 'transfer', {
        toUserId,
        toName: target.displayName,
        amount: amount.toString(),
      });
      return [
        send(
          h.conv,
          `${T.transferPreview(target.displayName, target.platformUserId, amount)}\n${T.confirmPrompt}`,
          {
            buttons: rows,
          },
        ),
      ];
    }

    case 'city':
      return [send(h.conv, T.city(await cityView(h.ctx, groupId)))];
    case 'blood_bank':
      return [send(h.conv, T.bloodBank(await cityView(h.ctx, groupId)))];
    case 'hunting_ground':
      return [send(h.conv, T.huntingGround(await cityView(h.ctx, groupId)))];
    case 'curses':
      return [send(h.conv, T.curses(await cityView(h.ctx, groupId)))];
    case 'donate_hunt':
      return sendPreview(h, 'donate_hunt', { food: cmd.args.food, count: cmd.args.count });
    case 'city_upgrade':
    case 'blood_bank_upgrade':
    case 'hunting_ground_upgrade':
    case 'curse_upgrade': {
      if (managerRole(h.role) === 'member') return [send(h.conv, T.onlyAdmins)];
      const part =
        cmd.command === 'city_upgrade'
          ? 'city'
          : cmd.command === 'blood_bank_upgrade'
            ? 'bank'
            : cmd.command === 'hunting_ground_upgrade'
              ? 'ground'
              : 'curse';
      return sendPreview(h, 'city_upgrade', {
        part,
        ...(cmd.command === 'curse_upgrade' ? { curse: cmd.args.curse } : {}),
      });
    }

    case 'ghost_search': {
      const r = await searchGhost(h.ctx, {
        userId: h.userId,
        groupId,
        platform: h.conv.platform,
        chatId: h.conv.chatId,
      });
      if (r.status === 'found') {
        return [
          send(h.conv, T.ghostFound(who, r.text, r.fearReward, r.expiresAt, t), {
            onSent: { type: 'ghost_encounter', encounterId: r.encounterId },
          }),
        ];
      }
      if (r.status === 'cooldown' && !r.notify) return [];
      return [send(h.conv, T.ghostSearch(who, r, t))];
    }
    case 'heard': {
      const r = await hearGhost(h.ctx, {
        userId: h.userId,
        groupId,
        platform: h.conv.platform,
        replyChatId: h.replyTo?.chatId ?? null,
        replyToMessageId: h.replyTo?.messageId ?? null,
        replyFromThisBot: h.replyTo?.fromThisBot ?? false,
      });
      const text = {
        ok: r.status === 'ok' ? T.heardOk(who, r.fearReward, r.totalFear) : '',
        no_reply: T.heardNoReply,
        not_a_ghost: T.heardNotGhost,
        wrong_group: T.heardWrongGroup,
        not_owner: T.heardNotOwner,
        already_heard: T.heardAlready,
        expired: T.heardExpired,
        banned: T.banned,
      }[r.status];
      return [send(h.conv, text)];
    }
    case 'leaderboard': {
      // In a group only its own members are ranked; the global list is private-chat only.
      const scope = h.groupId === null ? {} : { groupId: h.groupId };
      const entries = await scaryLeaderboard(h.ctx, { ...scope, limit: 10 });
      const me = await playerFearRank(h.ctx, { userId: h.userId, ...scope });
      return [send(h.conv, T.leaderboard(h.groupId === null ? 'global' : 'group', entries, me))];
    }
  }
}

// ───────────────────────── buttons ─────────────────────────

export async function handleButton(
  h: HandlerContext,
  click: { callbackId: string; messageId: string | undefined; token: string },
  button: PendingButton,
): Promise<Reply[]> {
  const params = { ...button.params };
  delete params.batch;
  const done = answer(h.conv, click.callbackId, T.button.done);
  const replace = (text: string, rows?: Awaited<ReturnType<typeof buttons>>): Reply =>
    click.messageId
      ? edit(h.conv, click.messageId, text, rows)
      : send(h.conv, text, rows ? { buttons: rows } : {});

  switch (button.action) {
    case 'cancel':
      return [answer(h.conv, click.callbackId), replace(T.cancelled)];
    case 'help':
      return [answer(h.conv, click.callbackId), send(h.conv, helpText(), { reply: false })];
    case 'cave':
      return [
        answer(h.conv, click.callbackId),
        send(h.conv, T.cave(await playerProfile(h.ctx, h.userId), now(h)), { reply: false }),
      ];
    case 'global_board': {
      // Only on messages sent before the global list became private-chat only.
      if (h.conv.chatKind !== 'private')
        return [answer(h.conv, click.callbackId, T.globalBoardInPrivate, true)];
      const entries = await scaryLeaderboard(h.ctx, { limit: 10 });
      const me = await playerFearRank(h.ctx, { userId: h.userId });
      return [
        answer(h.conv, click.callbackId),
        send(h.conv, T.leaderboard('global', entries, me), { reply: false }),
      ];
    }
    case 'equip': {
      const r = await equipTool(h.ctx, { userId: h.userId, tool: params.tool as ToolKind });
      const text =
        r.status === 'ok'
          ? T.equipped(r.tool)
          : r.status === 'not_owned'
            ? T.toolNotOwned(r.tool)
            : T.banned;
      return [answer(h.conv, click.callbackId, text), replace(text)];
    }
    case 'prompt': {
      const op = params.op as string;
      delete params.op;
      const pv = await preview(h, op, params);
      return [
        answer(h.conv, click.callbackId),
        replace(pv.text, pv.rows ? await buttons(h, pv.rows) : undefined),
      ];
    }
    case 'confirm': {
      const op = params.op as string;
      delete params.op;
      const text = await runOp(h, op, params, `btn:${click.token}`);
      return [done, replace(text)];
    }
    default:
      return [answer(h.conv, click.callbackId, T.button.invalid, true)];
  }
}
