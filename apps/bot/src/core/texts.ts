import { CENTI_PER_POINT, TOOL_KINDS } from '@lulu/config';
import type { CurseKind, FoodKind, ToolKind } from '@lulu/config';
import type {
  CemeteryView,
  CityView,
  GhostSearchResult,
  HuntResult,
  LeaderboardEntry,
  PlayerProfile,
  ToolShopItem,
  TreasuryView,
} from '@lulu/domain';
import {
  CURSE_NAMES,
  FOOD_NAMES,
  TOOL_NAMES,
  escapeHtml,
  formatDuration,
  formatInteger,
  formatPercentBp,
  formatPoints,
  levelName,
  toPersianDigits,
} from '@lulu/i18n';

/**
 * Every user-facing sentence of the bot. Short Persian, few emoji, HTML parse mode.
 * Anything user-controlled (names, ghost texts) goes through `escapeHtml`.
 */

export const pts = (centi: bigint) => `${formatPoints(centi)} پوینت`;
export const name = (displayName: string) => `<b>${escapeHtml(displayName)}</b>`;
/** Quoted user input is shortened so a long message is not echoed back whole. */
const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text);
const wait = (ms: number) => formatDuration(Math.ceil(ms / 1000));
const tehranClock = (at: Date) =>
  toPersianDigits(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
const until = (at: Date, now: Date) => wait(at.getTime() - now.getTime());
const fa = (n: number) => toPersianDigits(String(n));
const minutes = (seconds: number) => fa(Math.round(seconds / 60));

export const T = {
  // ── general ──
  banned: 'حساب شما در بازی مسدود است.',
  groupDisabled:
    '⏸️ «لولو» در این گروه موقتاً غیرفعال است و دستورهای بازی اینجا اجرا نمی‌شوند. داده‌های گروه و بازیکن‌ها سر جایش می‌ماند.',
  groupDisabledButton: 'بازی در این گروه موقتاً غیرفعال است.',
  groupOnly:
    'این کار فقط داخل گروه انجام می‌شود. ربات را به گروه اضافه کنید و همان‌جا امتحان کنید.',
  anonymousAdmin:
    'شما به‌صورت ناشناس (به نام گروه) پیام داده‌اید. برای کارهای شخصی، با حساب خودتان پیام بدهید.',
  replyToPerson:
    'برای انتقال باید روی پیام گیرنده reply کنید و فقط بنویسید: «انتقال ۱۰۰». گیرنده با @نام‌کاربری یا اسم مشخص نمی‌شود.',
  notRegisteredTarget:
    'این کاربر هنوز در بازی ثبت نشده است. اول خودش باید یک‌بار «لولو» یا /start بزند.',
  targetIsBot: 'به ربات‌ها نمی‌شود پوینت داد.',
  selfTransfer: 'به خودتان نمی‌شود پوینت داد.',
  onlyAdmins: 'فقط مالک یا ادمین‌های گروه می‌توانند خزانهٔ شهر را خرج کنند.',
  invalidAmount: 'مبلغ نامعتبر است. یک عدد مثبت بنویسید، مثلاً «۱۰۰» یا «۱٬۵۰۰».',
  /** The text after the command is not a plain number (extra words, a unit, a mention…). */
  amountNotANumber: (argText: string, example: string) =>
    `«${escapeHtml(clip(argText))}» عدد نیست. بعد از دستور فقط مبلغ را با رقم بنویسید، بدون واحد یا متن اضافه؛ مثلاً «${example}».`,
  transferRecipientByReply: 'گیرنده همان کسی است که روی پیامش reply کرده‌اید؛ نام یا @ لازم نیست.',
  amountZero: 'مبلغ باید بیشتر از صفر باشد.',
  amountNegative: 'مبلغ نمی‌تواند منفی باشد.',
  amountTooLarge: 'این مبلغ بیش از حد بزرگ است.',
  tooPrecise: 'حداکثر دو رقم اعشار مجاز است.',
  unknownItem: 'این مورد را نمی‌شناسم. فهرست را با «سرداب»، «ابزار شکار» یا «نفرین‌ها» ببینید.',
  missingArg: (example: string) => `این دستور یک مقدار لازم دارد، مثلاً: «${example}»`,
  cancelled: 'لغو شد.',
  confirmPrompt: 'برای انجام، «تأیید» را بزنید.',
  btn: {
    confirm: '✅ تأیید',
    cancel: '✖️ لغو',
    help: 'راهنما',
    cave: 'غار من',
    addToGroup: '➕ افزودن به گروه',
  },
  button: {
    notYours: 'این دکمه مال کس دیگری است. خودتان دستور را بفرستید تا دکمه‌های خودتان بیاید.',
    invalid: 'این دکمه دیگر معتبر نیست؛ دستور را دوباره بفرستید.',
    used: 'این تأیید قبلاً انجام یا لغو شده است.',
    /** Only confirmations expire; menu buttons (help, my cave…) never do. */
    expired: (ttlSeconds: number) =>
      `مهلت این تأیید (${minutes(ttlSeconds)} دقیقه) تمام شده و کاری انجام نشد. برای امنیت تراکنش، دستور را دوباره بفرستید.`,
    done: 'انجام شد.',
  },

  // ── onboarding ──
  welcome: (displayName: string) =>
    [
      `سلام ${name(displayName)}! به «لولو» خوش آمدید 👻`,
      'شما یک «روح» سطح ۱ هستید. در گروه بنویسید «لولو» تا پوینت بگیرید، شکار کنید، قبرستان بسازید و شهرتان را بزرگ کنید.',
      'برای دیدن همهٔ دستورها «راهنما» را بزنید.',
    ].join('\n\n'),
  groupWelcome: [
    '👻 «لولو» به این گروه آمد و این گروه حالا یک «لولوآباد» است.',
    'برای شروع بنویسید: <b>لولو</b>',
    '⚠️ برای اینکه پیام سادهٔ «لولو» به من برسد، یکی از این دو کار لازم است:',
    '۱. مرا ادمین گروه کنید (هیچ دسترسی خاصی لازم نیست؛ همهٔ تیک‌ها را بردارید)،',
    '۲. یا سازندهٔ ربات در BotFather گزینهٔ Group Privacy را خاموش کند.',
    'بدون این، فقط دستورهای «/» و پاسخ‌ها (reply) به پیام‌های من دیده می‌شوند.',
  ].join('\n'),

  // ── lolo ──
  loloOk: (displayName: string, base: number, cash: bigint) =>
    `🧛 ${name(displayName)} لولو کرد: +${formatInteger(base)} پوینت\nموجودی نقد: ${pts(cash)}`,
  loloWait: (displayName: string, remainingMs: number) =>
    `⏳ ${name(displayName)}، لولوی بعدی ${wait(remainingMs)} دیگر.`,

  // ── balances & profile ──
  balance: (v: TreasuryView) =>
    [
      `💰 نقد: ${pts(v.cashCenti)}`,
      `🏦 گنجینه: ${pts(v.treasuryCenti)}`,
      `جمع: ${pts(v.cashCenti + v.treasuryCenti)}`,
    ].join('\n'),
  cave: (p: PlayerProfile, now: Date) => {
    const lines = [
      `🕳 غار ${name(p.displayName)}`,
      `سطح ${toPersianDigits(String(p.level))} — ${levelName(p.level)}`,
      `💰 نقد: ${pts(p.cashCenti)} · 🏦 گنجینه: ${pts(p.treasuryCenti)}`,
      `جمع: ${pts(p.cashCenti + p.treasuryCenti)}`,
      p.nextLevelCostCenti === null
        ? 'به بالاترین سطح رسیده‌اید.'
        : `هزینهٔ ارتقا به «${levelName(p.level + 1)}»: ${pts(p.nextLevelCostCenti)}`,
      `🔪 ابزارها: ${
        p.tools.owned.length === 0
          ? 'هیچ'
          : TOOL_KINDS.filter((t) => p.tools.owned.includes(t))
              .map((t) =>
                t === p.tools.equipped ? `<b>${TOOL_NAMES[t]}</b> (در حال استفاده)` : TOOL_NAMES[t],
              )
              .join('، ')
      }`,
      `🍖 سرداب: ${foodList(p.inventory) || 'خالی'}`,
      `🍽 وعده‌های فعال: ${toPersianDigits(String(p.meals.active.length))} از ${toPersianDigits(String(p.meals.capacity))}${
        p.meals.active.length
          ? ` (${p.meals.active.map((m) => `${FOOD_NAMES[m.food]} تا ${tehranClock(m.expiresAt)}، ${fa(m.depositsLeft)} واریز ${pts(m.depositCenti)} مانده`).join('؛ ')})`
          : ''
      }`,
      p.cemetery
        ? `⚰️ قبرستان سطح ${toPersianDigits(String(p.cemetery.level))}: ${pts(p.cemetery.hourlyIncomeCenti)} در ساعت`
        : '⚰️ قبرستان: ندارید',
      `👻 روح امروز: ${toPersianDigits(String(p.ghostsToday.found))} از ${toPersianDigits(String(p.ghostsToday.limit))}`,
      p.lastStreakReward
        ? `🔥 آخرین پاداش روزانه: ${pts(p.lastStreakReward.personalCenti + p.lastStreakReward.groupCenti)} (استریک ${fa(p.lastStreakReward.streak)} روز، ${fa(p.lastStreakReward.activeMembers)} عضو فعال)`
        : '🔥 پاداش روزانه: با «لولو» در گروه، هر نیمه‌شب پاداش استریک و پاداش گروهی می‌گیرید.',
    ];
    const waits = (
      [
        ['lolo', 'لولو'],
        ['hunt', 'شکار'],
        ['ghost', 'روح'],
      ] as const
    )
      .filter(([k]) => p.waits[k])
      .map(([k, label]) => `${label}: ${until(p.waits[k]!, now)}`);
    if (waits.length) lines.push(`⏳ انتظار — ${waits.join(' · ')}`);
    return lines.join('\n');
  },

  // ── level ──
  levelPreview: (current: number, cost: bigint, cash: bigint) =>
    `ارتقا از «${levelName(current)}» به «${levelName(current + 1)}»\nهزینه: ${pts(cost)} (از نقد)\nموجودی نقد: ${pts(cash)}`,
  levelNotAffordable: (cost: bigint, cash: bigint) =>
    `برای ارتقا ${pts(cost)} نقد لازم است؛ شما ${pts(cash)} دارید.`,
  levelMax: 'به بالاترین سطح («خون‌آشام») رسیده‌اید.',
  levelOk: (level: number, cash: bigint) =>
    `🎉 حالا «${levelName(level)}» (سطح ${toPersianDigits(String(level))}) هستید. موجودی نقد: ${pts(cash)}`,
  stale: 'وضعیت تغییر کرده است؛ دستور را دوباره بفرستید.',

  // ── tools ──
  shop: (items: ToolShopItem[], cash: bigint) =>
    [
      '🔪 ابزار شکار (دائمی، بدون فروش و استهلاک)',
      'شکار همیشه با قوی‌ترین ابزاری که دارید انجام می‌شود؛ تجهیز دستی لازم نیست.',
      ...items.map(
        (i) =>
          `${i.equipped ? '✅' : i.owned ? '☑️' : '▫️'} ${TOOL_NAMES[i.tool]} — ${pts(i.priceCenti)} — موفقیت ${formatPercentBp(i.successBp)}${
            i.equipped ? ' (در حال استفاده)' : i.owned ? ' (دارید)' : ''
          }`,
      ),
      `موجودی نقد: ${pts(cash)}`,
    ].join('\n'),
  toolPreview: (tool: ToolKind, price: bigint, cash: bigint) =>
    `خرید ${TOOL_NAMES[tool]} به قیمت ${pts(price)}؟\nموجودی نقد: ${pts(cash)}`,
  toolOk: (tool: ToolKind, inUse: ToolKind) =>
    inUse === tool
      ? `${TOOL_NAMES[tool]} خریداری شد و از این به بعد با آن شکار می‌کنید.`
      : `${TOOL_NAMES[tool]} خریداری شد. شکار همچنان با ${TOOL_NAMES[inUse]} انجام می‌شود، چون قوی‌تر است.`,
  toolOwned: (tool: ToolKind) => `${TOOL_NAMES[tool]} را از قبل دارید.`,

  // ── hunt ──
  hunt: (displayName: string, r: HuntResult, now: Date) => {
    switch (r.status) {
      case 'success':
        return `🏹 ${name(displayName)} با ${TOOL_NAMES[r.tool]} یک «${FOOD_NAMES[r.food]}» شکار کرد! شکار بعدی ${until(r.nextAvailableAt, now)} دیگر.`;
      case 'failed':
        return `🌫 ${name(displayName)} با ${TOOL_NAMES[r.tool]} چیزی شکار نکرد. شکار بعدی ${until(r.nextAvailableAt, now)} دیگر.`;
      case 'level_too_low':
        return `شکار از سطح ${toPersianDigits(String(r.minLevel))} («${levelName(r.minLevel)}») ممکن است. با «ارتقای لولو» بالا بروید.`;
      case 'no_tool':
        return 'برای شکار ابزار لازم است. با «ابزار شکار» یکی بخرید.';
      case 'cooldown':
        return `⏳ ${name(displayName)}، شکار بعدی ${wait(r.remainingMs)} دیگر.`;
      case 'banned':
        return T.banned;
    }
  },

  // ── food ──
  cellar: (inv: Record<FoodKind, number>, active: number, capacity: number) =>
    [
      `🍖 سرداب: ${foodList(inv) || 'خالی'}`,
      `وعده‌های فعال: ${toPersianDigits(String(active))} از ${toPersianDigits(String(capacity))}`,
      'برای خوردن: «خوردن استخوان ۲» یا دکمه‌ها.',
    ].join('\n'),
  eatPreview: (food: FoodKind, count: number, m: MealPlan) =>
    `خوردن ${fa(count)} «${FOOD_NAMES[food]}»؟ ${mealPlan(m)}`,
  eatOk: (
    food: FoodKind,
    count: number,
    expiresAt: Date,
    active: number,
    capacity: number,
    m: MealPlan,
  ) =>
    `😋 ${fa(count)} «${FOOD_NAMES[food]}» خورده شد؛ تا ${tehranClock(expiresAt)} فعال است. ${mealPlan({ ...m, count })}\nوعده‌های فعال: ${fa(active)} از ${fa(capacity)}.`,
  eatCapacity: (active: number, capacity: number, requested: number) =>
    capacity === 0
      ? 'در این سطح هنوز نمی‌توانید غذا بخورید (ظرفیت صفر). با «ارتقای لولو» بالا بروید.'
      : `ظرفیت کافی نیست: ${toPersianDigits(String(active))} وعدهٔ فعال از ${toPersianDigits(String(capacity))}؛ ${toPersianDigits(String(requested))} وعدهٔ دیگر جا نمی‌شود.`,
  notEnoughFood: (food: FoodKind, have: number) =>
    `از «${FOOD_NAMES[food]}» فقط ${toPersianDigits(String(have))} عدد دارید.`,

  // ── cemetery ──
  cemetery: (v: CemeteryView) => {
    if (v.status === 'banned') return T.banned;
    if (v.status === 'closed') {
      return `⚰️ هنوز قبرستان ندارید. افتتاح: ${pts(v.openCostCenti)} — درآمد ساعتی بدون نیاز به آنلاین بودن.\nموجودی نقد: ${pts(v.cashCenti)}`;
    }
    return [
      `⚰️ قبرستان سطح ${toPersianDigits(String(v.level))} از ${toPersianDigits(String(v.maxLevel))}`,
      `درآمد: ${pts(v.hourlyIncomeCenti)} در ساعت (خودکار به نقد واریز می‌شود)`,
      v.nextUpgradeCostCenti === null
        ? 'به بالاترین سطح رسیده است.'
        : `هزینهٔ ارتقا: ${pts(v.nextUpgradeCostCenti)}`,
      `موجودی نقد: ${pts(v.cashCenti)}`,
    ].join('\n');
  },
  cemeteryOpenPreview: (cost: bigint) => `افتتاح قبرستان با ${pts(cost)}؟`,
  cemeteryUpgradePreview: (level: number, cost: bigint) =>
    `ارتقای قبرستان به سطح ${toPersianDigits(String(level + 1))} با ${pts(cost)}؟`,
  cemeteryOpened: '⚰️ قبرستان افتتاح شد و از همین حالا درآمد می‌دهد.',
  cemeteryUpgraded: (level: number) => `⚰️ قبرستان به سطح ${toPersianDigits(String(level))} رسید.`,
  cemeteryAlreadyOpen: 'قبرستان را از قبل دارید.',
  cemeteryNotOpen: 'اول قبرستان را افتتاح کنید.',

  // ── treasury & transfer ──
  treasury: (v: TreasuryView, now: Date) =>
    [
      `🏦 گنجینه: ${pts(v.treasuryCenti)}`,
      `هر نیمه‌شب (تهران) ${formatPercentBp(v.dailyInterestBp)} سود به خود گنجینه اضافه می‌شود. نیمه‌شب بعدی: ${until(v.nextInterestAt, now)} دیگر.`,
      v.lastInterest ? `آخرین سود: ${pts(v.lastInterest.interestCenti)}` : '',
      `💰 نقد: ${pts(v.cashCenti)}`,
      '«واریز گنجینه ۱۰۰» · «برداشت گنجینه ۱۰۰»',
    ]
      .filter(Boolean)
      .join('\n'),
  depositPreview: (amount: bigint) => `واریز ${pts(amount)} از نقد به گنجینه؟`,
  withdrawPreview: (amount: bigint) => `برداشت ${pts(amount)} از گنجینه به نقد؟`,
  moved: (cash: bigint, treasury: bigint) =>
    `انجام شد. 💰 نقد: ${pts(cash)} · 🏦 گنجینه: ${pts(treasury)}`,
  insufficient: (available: bigint) => `موجودی کافی نیست؛ موجودی قابل استفاده: ${pts(available)}`,
  transferPreview: (toName: string, toId: string, amount: bigint) =>
    `انتقال ${pts(amount)} از نقد شما به ${name(toName)} (شناسه <code>${escapeHtml(toId)}</code>)؟ کارمزد: صفر.`,
  transferOk: (toName: string, amount: bigint, cash: bigint) =>
    `✅ ${pts(amount)} به ${name(toName)} منتقل شد. موجودی نقد شما: ${pts(cash)}`,
  recipientBanned: 'حساب گیرنده مسدود است.',

  // ── city ──
  city: (v: CityView) =>
    [
      `🏚 لولوآباد سطح ${toPersianDigits(String(v.level))} از ${toPersianDigits(String(v.maxLevel))}`,
      `👥 جمعیت فعال: ${toPersianDigits(String(v.population.active))}${
        v.population.requiredForNext === null
          ? ''
          : ` (برای ارتقا ${toPersianDigits(String(v.population.requiredForNext))} لازم است)`
      }`,
      `   «جمعیت فعال» یعنی اعضای این گروه که در ${toPersianDigits(String(v.population.windowDays))} روز گذشته اینجا لولو، شکار یا جست‌وجوی روح موفق داشته‌اند.`,
      `🍖 ذخیرهٔ شکار: ${formatInteger(v.huntStore.points)} امتیاز (کل اهداها: ${formatInteger(v.huntStore.donatedTotal)})`,
      `🩸 بانک خون سطح ${toPersianDigits(String(v.bloodBank.level))}: ${pts(v.bloodBank.balanceCenti)}`,
      `🏹 شکارگاه سطح ${toPersianDigits(String(v.huntingGround.level))} (سقف با این بانک: ${toPersianDigits(String(v.huntingGround.maxForBank))})`,
      `🔮 نفرین‌ها: ${(Object.keys(v.curses) as CurseKind[])
        .map((k) => `${CURSE_NAMES[k]} ${toPersianDigits(String(v.curses[k].level))}`)
        .join(' · ')}`,
      v.next.city
        ? `ارتقای آبادی: ${pts(v.next.city.bloodBankCostCenti)} از بانک + ${formatInteger(v.next.city.huntPointsCost)} امتیاز شکار`
        : 'آبادی در بالاترین سطح است.',
    ].join('\n'),
  bloodBank: (v: CityView) =>
    [
      `🩸 بانک خون سطح ${toPersianDigits(String(v.bloodBank.level))}`,
      `موجودی: ${pts(v.bloodBank.balanceCenti)} · کل اهداها: ${pts(v.bloodBank.donatedTotalCenti)}`,
      v.next.bloodBank
        ? `ارتقا: ${pts(v.next.bloodBank.costCenti)} (نیازمند آبادی سطح ${toPersianDigits(String(v.next.bloodBank.requiresCityLevel))})`
        : 'بانک در بالاترین سطح است.',
      'هر عضو می‌تواند اهدا کند: «اهدای خون ۵۰۰». خرج آن فقط با مالک یا ادمین‌ها و فقط برای ارتقاست.',
    ].join('\n'),
  huntingGround: (v: CityView) =>
    [
      `🏹 شکارگاه سطح ${toPersianDigits(String(v.huntingGround.level))} (سقف با بانک فعلی: ${toPersianDigits(String(v.huntingGround.maxForBank))})`,
      v.next.huntingGround
        ? `ارتقا: ${pts(v.next.huntingGround.costCenti)} از بانک خون`
        : 'در بالاترین سطح است.',
      'سطح بالاتر، شانس شکارهای بزرگ‌تر را بیشتر می‌کند.',
    ].join('\n'),
  curses: (v: CityView) =>
    [
      '🔮 نفرین‌ها (اثر فقط در همین گروه):',
      ...(Object.keys(v.curses) as CurseKind[]).map((k) => {
        const next = v.next.curses[k];
        return `${CURSE_NAMES[k]}: سطح ${toPersianDigits(String(v.curses[k].level))} (سقف ${toPersianDigits(String(v.curses[k].maxForBank))})${
          next ? ` — سطح بعد: ${pts(next.costCenti)}` : ''
        }`;
      }),
      'هر سطح ۵٪ از زمان انتظار پایه کم می‌کند. «ارتقای نفرین شتاب شکار»',
    ].join('\n'),
  upgradePreview: (what: string, cost: bigint, huntPoints = 0) =>
    `ارتقای ${what} با ${pts(cost)} از بانک خون${huntPoints ? ` و ${formatInteger(huntPoints)} امتیاز شکار` : ''}؟`,
  upgradeDone: (what: string, level: number) =>
    `🏗 ${what} به سطح ${toPersianDigits(String(level))} رسید.`,
  populationLow: (active: number, required: number) =>
    `جمعیت فعال کافی نیست: ${toPersianDigits(String(active))} از ${toPersianDigits(String(required))}.`,
  bankLow: (cost: bigint, balance: bigint) =>
    `بانک خون کافی نیست: ${pts(balance)} از ${pts(cost)}.`,
  huntPointsLow: (cost: number, available: number) =>
    `ذخیرهٔ شکار کافی نیست: ${formatInteger(available)} از ${formatInteger(cost)}.`,
  needsCityLevel: (level: number) =>
    `اول آبادی باید به سطح ${toPersianDigits(String(level))} برسد.`,
  needsBankLevel: (max: number) =>
    `با سطح فعلی بانک خون حداکثر سطح ${toPersianDigits(String(max))} مجاز است.`,
  maxLevelReached: 'در بالاترین سطح است.',
  donateBloodPreview: (amount: bigint) =>
    `اهدای ${pts(amount)} از نقد شما به بانک خون این گروه؟ این اهدا قطعی است.`,
  donateBloodOk: (amount: bigint, bank: bigint) =>
    `🩸 ${pts(amount)} اهدا شد. بانک خون: ${pts(bank)}`,
  donateHuntPreview: (food: FoodKind, count: number) =>
    `اهدای ${toPersianDigits(String(count))} «${FOOD_NAMES[food]}» به ذخیرهٔ شکار گروه؟`,
  donateHuntOk: (food: FoodKind, count: number, points: number, pool: number) =>
    `🍖 ${toPersianDigits(String(count))} «${FOOD_NAMES[food]}» اهدا شد (+${formatInteger(points)}). ذخیرهٔ شکار: ${formatInteger(pool)}`,

  // ── ghosts ──
  ghostFound: (
    displayName: string,
    text: string,
    reward: bigint,
    expiresAt: Date,
    now: Date,
    attemptsLeft: number,
  ) =>
    [
      `👻 ${name(displayName)} روحی از یاد رفته پیدا کرد…`,
      '',
      `<i>${escapeHtml(text)}</i>`,
      '',
      `${name(displayName)}، روی همین پیام reply کنید و بنویسید «شنیدم» تا به هر عضو فعال این گروه (از جمله خودتان) ${pts(reward)} برسد. مهلت: ${until(expiresAt, now)} دیگر. بدون «شنیدم» به هیچ‌کس پاداشی نمی‌رسد.`,
      `تلاش‌های باقی‌ماندهٔ امروز: ${fa(attemptsLeft)}`,
    ].join('\n'),
  ghostSearch: (
    displayName: string,
    r: Exclude<GhostSearchResult, { status: 'found' }>,
    now: Date,
  ) => {
    switch (r.status) {
      case 'not_found': {
        const pct = Number((r.nextChance.numerator * 10_000n) / r.nextChance.denominator);
        return r.attemptsLeft > 0
          ? `🌫 ${name(displayName)} روحی پیدا نکرد. شانس تلاش بعدی: ${formatPercentBp(pct)} — ${until(r.nextAvailableAt, now)} دیگر. تلاش‌های باقی‌ماندهٔ امروز: ${fa(r.attemptsLeft)}`
          : `🌫 ${name(displayName)} روحی پیدا نکرد. تلاش‌های امروز تمام شد؛ از نیمه‌شب (تهران) دوباره.`;
      }
      case 'daily_limit':
        return `امروز ${fa(r.dailyLimit)} روح پیدا کرده‌اید؛ سهمیهٔ بعدی از نیمه‌شب (تهران).`;
      case 'no_attempts':
        return `امروز هر ${fa(r.dailyAttempts)} تلاش جست‌وجوی روح را انجام داده‌اید؛ تلاش‌های بعدی از نیمه‌شب (تهران).`;
      case 'no_content':
        return 'امشب روحی سرگردان نیست. بعداً دوباره سر بزنید.';
      case 'cooldown':
        return `⏳ ${name(displayName)}، جست‌وجوی بعدی ${wait(r.remainingMs)} دیگر.`;
      case 'banned':
        return T.banned;
    }
  },
  ghostRepost: (ownerName: string, text: string, reward: bigint, expiresAt: Date, now: Date) =>
    [
      `👻 روح شنیده‌نشدهٔ ${name(ownerName)} (پیش از ارتقای گروه به سوپرگروه پیدا شده بود)…`,
      '',
      `<i>${escapeHtml(text)}</i>`,
      '',
      `پیداکننده می‌تواند روی همین پیام reply کند و «شنیدم» بنویسد تا به هر عضو فعال این گروه ${pts(reward)} برسد (تا ${until(expiresAt, now)} دیگر).`,
    ].join('\n'),
  heardOk: (displayName: string, reward: bigint, members: number) =>
    `😱 ${name(displayName)} صدای روح را شنید! به ${fa(members)} عضو فعال این گروه هر کدام ${pts(reward)} رسید.`,
  heardNoReply: 'برای «شنیدم»، روی پیام روحی که خودتان پیدا کرده‌اید reply کنید.',
  heardNotOwner:
    'این روح را کس دیگری پیدا کرده؛ فقط خودش می‌تواند «شنیدم» بزند تا به همه پاداش برسد.',
  heardNotGhost: 'این پیام، پیام روح نیست. روی خود پیام روح (نه نسخهٔ فورواردشده) reply کنید.',
  heardWrongGroup: 'این روح مال گروه دیگری است.',
  heardAlready: 'این روح را قبلاً شنیده‌اید.',
  heardExpired: 'مهلت شنیدن این روح تمام شده است.',

  // ── leaderboard ──
  /**
   * In a group: that group's members, plus the bot-wide top three. In private chat:
   * the bot-wide list. `me` is shown when the player is outside the listed top.
   */
  leaderboard: (
    scope: 'group' | 'global',
    entries: LeaderboardEntry[],
    me: LeaderboardEntry | null,
    globalTop: LeaderboardEntry[] = [],
  ) =>
    [
      `😱 ترسناک‌ترین لولوها — ${scope === 'group' ? 'این گروه' : 'کل ربات'}`,
      ...(entries.length ? entries.map(rankLine) : ['هنوز کسی اینجا لولوپوینتی ندارد.']),
      me && !entries.some((e) => e.userId === me.userId)
        ? `…\n${fa(me.rank)}. شما — ${pts(me.pointsCenti)}`
        : '',
      globalTop.length ? `\n🌍 سه لولوی برتر کل ربات:\n${globalTop.map(rankLine).join('\n')}` : '',
      '<i>رتبه بر اساس لولوپوینت (نقد + گنجینه) است.</i>',
    ]
      .filter(Boolean)
      .join('\n'),
};

function foodList(inv: Record<FoodKind, number>): string {
  return (Object.keys(inv) as FoodKind[])
    .filter((f) => inv[f] > 0)
    .map((f) => `${FOOD_NAMES[f]} ×${formatInteger(inv[f])}`)
    .join('، ');
}

const rankLine = (e: LeaderboardEntry) =>
  `${fa(e.rank)}. ${name(e.displayName)} — ${pts(e.pointsCenti)} · ${levelName(e.level)}`;

/** What one kind of meal pays, for previews and confirmations. */
export interface MealPlan {
  pointsPerDeposit: number;
  depositsTotal: number;
  depositIntervalSeconds: number;
  count?: number;
}

function mealPlan(m: MealPlan): string {
  const each = BigInt(m.pointsPerDeposit) * CENTI_PER_POINT;
  const perMeal = each * BigInt(m.depositsTotal);
  const minutesTotal = minutes(m.depositIntervalSeconds * m.depositsTotal);
  const base = `هر وعده ${minutesTotal} دقیقه فعال است و هر ${minutes(m.depositIntervalSeconds)} دقیقه ${pts(each)} خودکار به نقد واریز می‌کند (جمع هر وعده: ${pts(perMeal)}).`;
  return m.count && m.count > 1
    ? `${base} جمع این ${fa(m.count)} وعده: ${pts(perMeal * BigInt(m.count))}.`
    : base;
}
