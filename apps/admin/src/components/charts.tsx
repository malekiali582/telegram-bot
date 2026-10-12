import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { formatCompact } from '../lib/format.ts';

/**
 * Plain-SVG charts (no chart library). Thin marks, recessive axes, a crosshair tooltip
 * on the trend line, values written on the bars. Text always wears the ink colors; a
 * series color only marks its data. Time runs left to right.
 */

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The smallest round step (1, 2, 2.5, 5 × 10ⁿ) that covers `max` in at most `count` steps. */
export function niceStep(max: number, count: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max / count));
  for (const m of [1, 2, 2.5, 5, 10, 20]) {
    if (Math.ceil(max / (m * power)) <= count) return m * power;
  }
  return 20 * power;
}

export interface TrendPoint {
  key: string;
  /** Axis and tooltip heading, e.g. «۲۰ مهر». */
  label: string;
  value: number;
  /** Exact, formatted readout for the tooltip. */
  display: string;
  /** Extra tooltip lines (label, value). */
  details?: [string, string][];
}

const HEIGHT = 220;
const PAD = { top: 14, right: 14, bottom: 28, left: 56 };

export function TrendChart({ points, label }: { points: TrendPoint[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const max = Math.max(0, ...points.map((p) => p.value));
  const step = niceStep(max, 5);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const x = (i: number) =>
    PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join('');
  const area = points.length
    ? `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`
    : '';
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 90))));

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - box.left) / box.width;
    setActive(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setActive((i) => Math.min(points.length - 1, (i ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((i) => Math.max(0, (i ?? points.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const current = active !== null ? points[active] : undefined;

  return (
    <div ref={ref} className="relative" dir="ltr">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="block outline-none focus-visible:outline-2 focus-visible:outline-accent"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              dy="0.32em"
              // Persian words in an LTR plot: right-to-left text, its start at the axis.
              direction="rtl"
              textAnchor="start"
              fontSize={11}
              fill="var(--color-muted)"
            >
              {formatCompact(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? (
            <text
              key={p.key}
              x={x(i)}
              y={HEIGHT - 8}
              textAnchor="middle"
              direction="rtl"
              fontSize={11}
              fill="var(--color-muted)"
            >
              {p.label}
            </text>
          ) : null,
        )}
        <path d={area} fill="var(--color-series-1)" fillOpacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {current && active !== null ? (
          <g pointerEvents="none">
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--color-muted)"
              strokeWidth={1}
            />
            <circle
              cx={x(active)}
              cy={y(current.value)}
              r={5}
              fill="var(--color-series-1)"
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          </g>
        ) : null}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={Math.max(1, plotW)}
          height={plotH}
          fill="transparent"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setActive(null)}
        />
      </svg>
      {current && active !== null ? (
        <div
          role="status"
          dir="rtl"
          className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-line bg-raised px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(0, x(active) - 80), Math.max(0, width - 180)),
          }}
        >
          <div className="mb-1 text-muted">{current.label}</div>
          <div className="text-sm font-bold text-ink">{current.display}</div>
          {current.details?.map(([k, v]) => (
            <div key={k} className="mt-0.5 flex justify-between gap-4 text-muted">
              <span>{k}</span>
              <span className="text-ink">{v}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  display: string;
}

/** Ranked horizontal bars of one series; each value is written beside its bar. */
export function BarList({
  items,
  series,
  empty,
}: {
  items: BarItem[];
  series: 1 | 2;
  empty: string;
}) {
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 0);
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} title={`${item.label}: ${item.display}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted">{item.label}</span>
            <span className="font-medium text-ink">{item.display}</span>
          </div>
          <div className="h-2.5 w-full">
            <div
              className={`h-full rounded-e ${series === 1 ? 'bg-series-1' : 'bg-series-2'}`}
              style={{ width: `${max > 0 ? Math.max(1, (item.value / max) * 100) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  /** One line, or several (shown on separate lines). */
  sub?: string | string[] | undefined;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {(Array.isArray(sub) ? sub : sub ? [sub] : []).map((line) => (
        <div key={line} className="mt-1 text-xs text-faint">
          {line}
        </div>
      ))}
    </div>
  );
}
