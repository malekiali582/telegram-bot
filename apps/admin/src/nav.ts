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
  /** Shown in the account menu rather than the sidebar. */
  accountMenu?: boolean;
}

export const NAV: NavItem[] = [
  { path: '/', label: 'داشبورد', icon: LayoutDashboard },
  { path: '/players', label: 'بازیکن‌ها', icon: Users },
  { path: '/groups', label: 'گروه‌ها', icon: Castle },
  { path: '/transactions', label: 'تراکنش‌ها', icon: Receipt },
  { path: '/economy', label: 'تنظیمات اقتصاد', icon: SlidersHorizontal },
  { path: '/ghosts', label: 'محتوای روح', icon: Ghost },
  { path: '/announcements', label: 'اطلاع‌رسانی', icon: Megaphone },
  { path: '/admins', label: 'مدیران', icon: ShieldCheck, ownerOnly: true },
  { path: '/audit', label: 'سابقهٔ کارها', icon: ScrollText },
  { path: '/system', label: 'سیستم', icon: Server },
  { path: '/account', label: 'حساب من', icon: UserCog, accountMenu: true },
];

export const navFor = (role: AdminRole) =>
  NAV.filter((item) => !item.ownerOnly || role === 'owner');

export const ROLE_LABEL: Record<AdminRole, string> = { owner: 'مالک', admin: 'مدیر' };
