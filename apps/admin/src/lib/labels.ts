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
