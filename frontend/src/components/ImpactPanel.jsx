import { Timer, Zap, Factory, MemoryStick, Coins, Bot, ArrowRight, TrendingDown } from 'lucide-react';
import { BasisBadge } from './Badge.jsx';
import { fmtMs, fmtEnergy, fmtGrams, fmtMoney, fmtNumber } from '../lib/carbon.js';

function MetricCard({ icon: Icon, title, basis, basisTitle, before, after, headline, sub, accent = 'emerald', footnote }) {
  const accentCls = {
    emerald: 'from-emerald-500/20 text-emerald-300',
    teal: 'from-teal-500/20 text-teal-300',
    sky: 'from-sky-500/20 text-sky-300',
    amber: 'from-amber-500/20 text-amber-300',
    violet: 'from-violet-500/20 text-violet-300',
    lime: 'from-lime-500/20 text-lime-300',
  }[accent];
  return (
    <div className="panel relative flex flex-col overflow-hidden p-4">
      <div className={`pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gradient-to-br ${accentCls} to-transparent opacity-40 blur-2xl`} />
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="label flex items-center gap-1.5">
          <Icon size={13} className={accentCls.split(' ')[1]} /> {title}
        </span>
        <BasisBadge basis={basis} title={basisTitle} />
      </div>
      <div className={`text-2xl font-extrabold tracking-tight ${accentCls.split(' ')[1]}`}>{headline}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
      {(before || after) && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-[11px]">
          <span className="text-red-300/90" title="Original">{before}</span>
          <ArrowRight size={12} className="shrink-0 text-slate-600" />
          <span className="text-emerald-300" title="Optimized">{after}</span>
        </div>
      )}
      {footnote && <div className="mt-2 text-[10px] leading-snug text-slate-500">{footnote}</div>}
    </div>
  );
}

const pct = (a, b) => (a > 0 ? ((a - b) / a) * 100 : 0);

export default function ImpactPanel({ impact, measurements, usage, currency, callsPerDay }) {
  if (!impact || !measurements) {
    return (
      <section className="panel grid place-items-center p-8 text-center">
        <TrendingDown className="mb-2 text-emerald-500/50" />
        <p className="text-sm text-slate-400">Measured impact appears after the Verifier runs both versions.</p>
      </section>
    );
  }
  const { original: mo, optimized: mn, basis } = measurements;
  const derivedTip =
    basis.carbon === 'measured'
      ? 'Measured basis: modeled from the measured runtime/memory × hardware power profile × grid intensity'
      : 'Estimated: runtime was estimated statically, so energy/carbon/cost are estimates too';
  const memDelta = pct(mo.memory_mb, mn.memory_mb);
  const tokensSaved = (mo.llm_tokens || 0) - (mn.llm_tokens || 0);

  return (
    <section>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 className="text-base font-bold text-white">Measured Impact</h2>
          <p className="text-xs text-slate-500">
            Per execution, scaled to {callsPerDay.toLocaleString('en-US')} executions/day · updates live with the context bar
          </p>
        </div>
        <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          <TrendingDown size={13} /> {impact.reductionPct.toFixed(1)}% less carbon / execution
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          icon={Timer}
          title="CPU execution time"
          basis={basis.time}
          headline={impact.speedup ? `${impact.speedup >= 10 ? impact.speedup.toFixed(0) : impact.speedup.toFixed(2)}× faster` : '-'}
          sub={`median wall time · CPU ${fmtMs(mo.cpu_ms)} → ${fmtMs(mn.cpu_ms)}`}
          before={fmtMs(mo.time_ms)}
          after={fmtMs(mn.time_ms)}
          accent="sky"
        />
        <MetricCard
          icon={Zap}
          title="Energy"
          basis={basis.carbon}
          basisTitle={derivedTip}
          headline={fmtEnergy(impact.perYear.energyKwh)}
          sub="saved per year"
          before={`${fmtEnergy(impact.original.energy)}/run`}
          after={`${fmtEnergy(impact.optimized.energy)}/run`}
          accent="amber"
        />
        <MetricCard
          icon={Factory}
          title="CO₂e emissions"
          basis={basis.carbon}
          basisTitle={derivedTip}
          headline={fmtGrams(impact.perYear.co2G)}
          sub={`avoided per year · ${fmtGrams(impact.perDay.co2G)}/day`}
          before={fmtGrams(impact.perYear.originalCo2G) + '/yr'}
          after={fmtGrams(impact.perYear.optimizedCo2G) + '/yr'}
          accent="emerald"
        />
        <MetricCard
          icon={MemoryStick}
          title="Memory"
          basis={basis.memory}
          headline={`${mn.memory_mb?.toFixed(2) ?? '-'} MB`}
          sub={`${memDelta >= 0 ? '−' : '+'}${Math.abs(memDelta).toFixed(1)}% vs original`}
          before={`${mo.memory_mb?.toFixed(2) ?? '-'} MB`}
          after={`${mn.memory_mb?.toFixed(2) ?? '-'} MB`}
          footnote={measurements.memory_label}
          accent="violet"
        />
        <MetricCard
          icon={Coins}
          title="Money saved"
          basis={basis.carbon}
          basisTitle={derivedTip}
          headline={fmtMoney(impact.perYear.money, currency)}
          sub={`per year · ${fmtMoney(impact.perDay.money, currency)}/day`}
          before={fmtMoney(impact.perYear.originalMoney, currency) + '/yr'}
          after={fmtMoney(impact.perYear.optimizedMoney, currency) + '/yr'}
          footnote="Compute rental + self-hosted electricity + LLM token spend"
          accent="lime"
        />
        <MetricCard
          icon={Bot}
          title="LLM tokens & calls"
          basis={basis.tokens}
          headline={mo.llm_tokens ? `${fmtNumber(tokensSaved, 1)} tokens` : 'No LLM calls'}
          sub={mo.llm_tokens ? `saved per run · calls ${fmtNumber(mo.llm_calls, 0)} → ${fmtNumber(mn.llm_calls, 0)}` : 'in the application code'}
          before={mo.llm_tokens ? `${fmtNumber(mo.llm_tokens, 1)} tok` : null}
          after={mo.llm_tokens ? `${fmtNumber(mn.llm_tokens, 1)} tok` : null}
          footnote={`GreenCode refactor: ${usage?.calls || 0} LLM call${usage?.calls === 1 ? '' : 's'} · ${fmtNumber(usage?.total_tokens || 0, 1)} tokens (${usage?.provider || 'offline'})`}
          accent="teal"
        />
      </div>
    </section>
  );
}
