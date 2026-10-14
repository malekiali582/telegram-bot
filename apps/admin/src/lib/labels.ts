import type { ServiceState } from '@lulu/api/contract';

/** Persian names for system accounts, jobs and states; unknown codes are shown as is. */

const ACCOUNTS: Record<string, string> = {
  'mint:lolo': 'لولو',
  'mint:food': 'غذا',
  'mint:cemetery': 'قبرستان',
  'mint:interest': 'سود گنجینه',
  'mint:ghost': 'روح',
  'mint:streak': 'استریک',
  'burn:level_upgrade': 'ارتقای سطح',
  'burn:tool': 'خرید ابزار',
  'burn:cemetery': 'قبرستان (خرید و ارتقا)',
  'burn:city_upgrade': 'ارتقای لولوآباد',
  'burn:blood_bank_upgrade': 'ارتقای بانک خون',
  'burn:hunting_ground_upgrade': 'ارتقای شکارگاه',
  'burn:curse': 'نفرین‌ها',
  'adjust:admin': 'اصلاح مدیر',
};
export const accountLabel = (code: string) => ACCOUNTS[code] ?? code;

const JOBS: Record<string, string> = {
  settlement: 'تسویهٔ دوره‌ای (قبرستان، سود، غذا، استریک)',
  'ghost-activation': 'فعال کردن بستهٔ روح شب',
  cleanup: 'پاک‌سازی جدول‌های موقت',
};
export const jobLabel = (name: string) => JOBS[name] ?? name;

export const SERVICE_LABEL: Record<'bot' | 'worker', string> = { bot: 'ربات', worker: 'worker' };

export const STATE_LABEL: Record<ServiceState, string> = {
  online: 'روشن',
  stopped: 'خاموش شده',
  unresponsive: 'بی‌پاسخ',
  never: 'هنوز گزارشی نداده',
};

export const PLATFORM_LABEL: Record<'telegram' | 'rubika', string> = {
  telegram: 'تلگرام',
  rubika: 'روبیکا',
};

export const ROLE_LABEL: Record<'owner' | 'admin', string> = { owner: 'مالک', admin: 'مدیر' };

const AUDIT_ACTIONS: Record<string, string> = {
  'auth.login': 'ورود به پنل',
  'auth.logout': 'خروج از پنل',
  'admin.bootstrap': 'ساخت مالک اولیه',
  'admin.create': 'افزودن مدیر',
  'admin.role': 'تغییر نقش مدیر',
  'admin.disable': 'حذف مدیر',
  'admin.enable': 'برگرداندن مدیر',
  'admin.password_reset': 'رمز تازه برای مدیر',
  'account.password': 'تغییر رمز خود',
  'account.session_revoke': 'بستن یک نشست خود',
  'account.sessions_revoke_others': 'بستن نشست‌های دیگر خود',
  'balance.adjust': 'دادن یا کم کردن پوینت',
  'player.ban': 'مسدود کردن بازیکن',
  'player.unban': 'رفع مسدودی بازیکن',
  'group.disable': 'غیرفعال کردن گروه',
  'group.enable': 'فعال کردن گروه',
  'group_migration.review': 'بررسی تعارض مهاجرت',
  'config.update': 'تغییر تنظیمات اقتصاد',
  'config.rollback': 'برگشت تنظیمات',
  'ghost.import': 'افزودن بستهٔ روح',
  'ghost.cancel': 'لغو بستهٔ روح',
  'announcement.send': 'ارسال اطلاعیه',
  'announcement.cancel': 'لغو اطلاعیه',
  'announcement.retry': 'ارسال دوبارهٔ اطلاعیه',
  'outbox.retry': 'ارسال دوبارهٔ پیام ناموفق',
  'backup.create': 'گرفتن بکاپ',
  'backup.download': 'دانلود بکاپ',
  'transactions.export': 'خروجی CSV تراکنش‌ها',
};
export const auditActionLabel = (code: string) => AUDIT_ACTIONS[code] ?? code;

const AUDIT_TARGETS: Record<string, string> = {
  user: 'بازیکن',
  group: 'گروه',
  admin_user: 'مدیر',
  config_version: 'نسخهٔ تنظیمات',
  ghost_batch: 'بستهٔ روح',
  announcement: 'اطلاعیه',
  group_migration: 'مهاجرت گروه',
  outbox: 'پیام صف ارسال',
  transactions: 'تراکنش‌ها',
  backup: 'بکاپ',
};
export const auditTargetLabel = (code: string) => AUDIT_TARGETS[code] ?? code;

/** «Edge روی Windows» from a user agent; good enough to recognise one's own devices. */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'مرورگر ناشناس';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'مرورگر';
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return os ? `${browser} روی ${os}` : browser;
}
