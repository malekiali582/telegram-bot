import type { AdminRole } from '@lulu/api/contract';
import type { LucideIcon } from 'lucide-react';
import {
  Castle,
  Ghost,
  LayoutDashboard,
  Megaphone,
  Receipt,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Users,
} from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Owner-only pages are hidden from admins (the server refuses them anyway). */
  ownerOnly?: boolean;
  /** Build section (docs/panel-plan.md) that delivers the page. */
  section: string;
  /** Shown in the account menu rather than the sidebar. */
  accountMenu?: boolean;
}

export const NAV: NavItem[] = [
  { path: '/', label: 'داشبورد', icon: LayoutDashboard, section: '۸.۲' },
  { path: '/players', label: 'بازیکن‌ها', icon: Users, section: '۸.۳' },
  { path: '/groups', label: 'گروه‌ها', icon: Castle, section: '۸.۴' },
  { path: '/transactions', label: 'تراکنش‌ها', icon: Receipt, section: '۸.۳' },
  { path: '/economy', label: 'تنظیمات اقتصاد', icon: SlidersHorizontal, section: '۸.۵' },
  { path: '/ghosts', label: 'محتوای روح', icon: Ghost, section: '۸.۶' },
  { path: '/announcements', label: 'اطلاع‌رسانی', icon: Megaphone, section: '۸.۷' },
  { path: '/admins', label: 'مدیران', icon: ShieldCheck, ownerOnly: true, section: '۸.۸' },
  { path: '/audit', label: 'سابقهٔ کارها', icon: ScrollText, section: '۸.۸' },
  { path: '/system', label: 'سیستم', icon: Server, section: '۸.۲' },
  { path: '/account', label: 'حساب من', icon: UserCog, section: '۸.۸', accountMenu: true },
];

export const navFor = (role: AdminRole) =>
  NAV.filter((item) => !item.ownerOnly || role === 'owner');

export const ROLE_LABEL: Record<AdminRole, string> = { owner: 'مالک', admin: 'مدیر' };
