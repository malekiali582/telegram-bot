import type { CirculationPoint, FlowSummary, GrowthMeasure } from '@lulu/domain';
import { economyOverview, ghostCoverage } from '@lulu/domain';
import type { FastifyPluginCallback } from 'fastify';
import type { ApiDeps } from '../app.ts';
import type { CirculationView, DashboardView, FlowView, GrowthView } from '../contract.ts';
import { systemSummary } from '../system.ts';

const circulation = (p: CirculationPoint): CirculationView => ({
  date: p.date,
  cash: p.cash.toString(),
  treasury: p.treasury.toString(),
  bloodBank: p.bloodBank.toString(),
  total: p.total.toString(),
});

const flow = (f: FlowSummary): FlowView => ({
  produced: f.produced.map((x) => ({ code: x.code, centi: x.centi.toString() })),
  consumed: f.consumed.map((x) => ({ code: x.code, centi: x.centi.toString() })),
  adjustments: f.adjustments.toString(),
  net: f.net.toString(),
});

const growth = (g: GrowthMeasure): GrowthView => ({
  from: g.from,
  to: g.to,
  base: g.baseCenti.toString(),
  change: g.changeCenti.toString(),
  growthBp: g.growthBp,
  thresholdBp: g.thresholdBp,
  exceeded: g.exceeded,
});

export const dashboardRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { ctx } = deps;

  app.get('/api/dashboard', { config: { access: 'admin' } }, async (): Promise<DashboardView> => {
    const o = await economyOverview(ctx);
    return {
      today: o.today,
      players: o.players,
      groups: o.groups,
      circulation: {
        now: circulation(o.circulation.now),
        daily: o.circulation.daily.map(circulation),
        pending: o.circulation.pendingCenti.toString(),
      },
      flows: { today: flow(o.flows.today), week: flow(o.flows.week), month: flow(o.flows.month) },
      inflation: {
        status: o.inflation.status,
        day: growth(o.inflation.day),
        week: growth(o.inflation.week),
        minCirculation: o.inflation.minCirculationCenti.toString(),
      },
      ghosts: await ghostCoverage(ctx),
      system: await systemSummary(ctx.db, ctx.clock.now()),
    };
  });
  done();
};
