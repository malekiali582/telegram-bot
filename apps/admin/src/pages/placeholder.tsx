import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
    </div>
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
