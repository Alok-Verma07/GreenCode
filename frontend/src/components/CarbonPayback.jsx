import { Recycle, Bot, Cpu, Scale, Trophy } from 'lucide-react';
import { BasisBadge } from './Badge.jsx';
import { fmtGrams, fmtDuration, fmtNumber, AI_QUERY_G_CO2E } from '../lib/carbon.js';

export default function CarbonPayback({ impact, basis, callsPerDay }) {
  if (!impact) {
    return (
      <section className="panel grid min-h-[300px] place-items-center p-6 text-center">
        <div>
          <Recycle className="mx-auto mb-2 text-emerald-500/50" />
          <p className="text-sm text-slate-400">Carbon payback is computed once the pipeline finishes.</p>
        </div>
      </section>
    );
  }
  const { payback, savedG } = impact;
  const paid = payback.executionsToNeutral != null;
  const dayOneShare = payback.aiCostG > 0 ? Math.min(1, (savedG * callsPerDay) / payback.aiCostG) : 1;
  const llmPart = AI_QUERY_G_CO2E * payback.llmCalls;
  const localPart = payback.aiCostG - llmPart;

  return (
    <section className="panel flex h-full flex-col">
      <div className="panel-header">
        <h2 className="panel-title">
          <Recycle size={15} className="text-emerald-400" /> Carbon Payback
        </h2>
        <BasisBadge basis={basis} />
      </div>
      <div className="grid flex-1 gap-4 p-4 md:grid-cols-2">
        <div className="space-y-3">
          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
            <div className="label mb-1">Cost of this optimization</div>
            <div className="text-2xl font-extrabold text-amber-300">{fmtGrams(payback.aiCostG)}</div>
            <div className="mt-2 space-y-1 text-[11px] text-slate-400">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <Bot size={12} /> LLM queries ({payback.llmCalls} × ~{AI_QUERY_G_CO2E} g)
                </span>
                <span className="font-mono">{fmtGrams(llmPart)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <Cpu size={12} /> Profiling + verification runs
                </span>
                <span className="font-mono">{fmtGrams(localPart)}</span>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
            <div className="label mb-1">Saved per execution</div>
            <div className="text-2xl font-extrabold text-emerald-300">{fmtGrams(savedG)}</div>
            <div className="mt-1 text-[11px] text-slate-500">SCI(original) − SCI(optimized)</div>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-3">
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 text-center">
            <Scale className="mx-auto mb-1 text-emerald-400" size={20} />
            <div className="label">Carbon-neutral after</div>
            <div className="mt-1 text-3xl font-black text-white">
              {paid ? fmtNumber(payback.executionsToNeutral, 1) : '∞'}
            </div>
            <div className="text-xs text-slate-400">{paid ? 'executions' : 'no per-execution savings'}</div>
            {paid && (
              <div className="mt-2 text-xs text-emerald-300">
                ≈ {fmtDuration(payback.secondsToNeutral)} at {callsPerDay.toLocaleString('en-US')}/day
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[11px] text-slate-400">
              <span>Day-1 recovery of optimization cost</span>
              <span className="font-mono text-emerald-300">{(dayOneShare * 100).toFixed(0)}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-400 via-lime-400 to-emerald-400 transition-all duration-700"
                style={{ width: `${dayOneShare * 100}%` }}
              />
            </div>
          </div>
          {payback.paybackMultiple != null && payback.paybackMultiple > 1 && (
            <div className="flex items-center gap-2 rounded-lg bg-black/25 px-3 py-2 text-xs text-slate-300">
              <Trophy size={14} className="shrink-0 text-amber-300" />
              Year one repays the optimization footprint
              <span className="font-mono font-bold text-emerald-300">{fmtNumber(payback.paybackMultiple, 1)}×</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
