import { BasisBadge } from './Badge.jsx';
import { fmtGrams, fmtDuration, fmtNumber, AI_QUERY_G_CO2E } from '../lib/carbon.js';

function Stat({ label, value, tone = 'text-zinc-100', children }) {
  return (
    <div className="min-w-0 bg-surface p-5">
      <div className="micro mb-3">{label}</div>
      <div className={`num text-[26px] font-semibold leading-none tracking-tight ${tone}`}>{value}</div>
      <div className="mt-2.5 space-y-1 text-xs text-zinc-500">{children}</div>
    </div>
  );
}

export default function CarbonPayback({ impact, basis, callsPerDay }) {
  const payback = impact?.payback;
  const savedG = impact?.savedG ?? 0;
  const paid = payback?.executionsToNeutral != null;
  const dayOneShare = !impact ? 0 : payback.aiCostG > 0 ? Math.min(1, (savedG * callsPerDay) / payback.aiCostG) : 1;
  const llmPart = impact ? AI_QUERY_G_CO2E * payback.llmCalls : 0;
  const localPart = impact ? payback.aiCostG - llmPart : 0;

  return (
    <section className="surface flex h-full flex-col overflow-hidden">
      <div className="section-header">
        <h2 className="section-title">Carbon Payback</h2>
        {impact && <BasisBadge basis={basis} />}
      </div>

      <div className="grid gap-px border-b border-line bg-line sm:grid-cols-3">
        <Stat label="Optimization cost" value={impact ? fmtGrams(payback.aiCostG) : '-'} tone={impact ? 'text-zinc-100' : 'text-zinc-700'}>
          {impact ? (
            <>
              <div className="num flex justify-between gap-2"><span>LLM {payback.llmCalls} × {AI_QUERY_G_CO2E} g</span><span className="font-mono">{fmtGrams(llmPart)}</span></div>
              <div className="num flex justify-between gap-2"><span>Verify runs</span><span className="font-mono">{fmtGrams(localPart)}</span></div>
            </>
          ) : (
            <div>LLM queries + verification</div>
          )}
        </Stat>
        <Stat label="Saved / execution" value={impact ? fmtGrams(savedG) : '-'} tone={!impact ? 'text-zinc-700' : savedG > 0 ? 'text-emerald-400' : 'text-rose-400'}>
          <div>SCI original − optimized</div>
        </Stat>
        <Stat label="Break-even" value={impact ? (paid ? fmtNumber(payback.executionsToNeutral, 1) : '∞') : '-'} tone={impact ? 'text-zinc-100' : 'text-zinc-700'}>
          <div>{!impact ? 'executions to carbon-neutral' : paid ? `runs · ≈ ${fmtDuration(payback.secondsToNeutral)} at ${fmtNumber(callsPerDay, 0)}/day` : 'no per-execution savings'}</div>
        </Stat>
      </div>

      <div className="flex flex-1 flex-col justify-center gap-2.5 px-5 py-4">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-zinc-400">Day-1 recovery of optimization footprint</span>
          <span className={`num font-mono ${dayOneShare >= 1 ? 'text-emerald-400' : 'text-zinc-300'}`}>{(dayOneShare * 100).toFixed(0)}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
          <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-700" style={{ width: `${dayOneShare * 100}%` }} />
        </div>
        {payback?.paybackMultiple != null && payback.paybackMultiple > 1 && (
          <p className="text-xs text-zinc-500">
            Year one repays the optimization footprint <span className="num font-mono text-emerald-400">{fmtNumber(payback.paybackMultiple, 1)}×</span> over.
          </p>
        )}
      </div>
    </section>
  );
}
