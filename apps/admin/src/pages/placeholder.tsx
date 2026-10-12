import { Hammer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { NavItem } from '../nav.ts';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
    </div>
  );
}

/** A page whose build section has not been delivered yet. */
export function ComingSoon({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader title={item.label} />
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-4 py-16 text-center">
        <Hammer aria-hidden className="size-8 text-faint" />
        <p>این صفحه در بخش {item.section} ساخته می‌شود.</p>
      </div>
    </>
  );
}

export function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-lg">این صفحه پیدا نشد.</p>
      <Link to="/" className="text-accent hover:underline">
        بازگشت به داشبورد
      </Link>
    </div>
  );
}
