import { BasisBadge } from './Badge.jsx';
import { fmtMs, fmtEnergy, fmtGrams, fmtMoney, fmtNumber } from '../lib/carbon.js';

const DASH = '-';
const pct = (a, b) => (a > 0 ? ((a - b) / a) * 100 : 0);

/** "12.40 kg" -> ["12.40", "kg"] so the unit can be set smaller than the number. */
function splitUnit(s) {
  const i = s.lastIndexOf(' ');
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
}

function Value({ value, unit, tone = 'neutral', size = 'lg' }) {
  const color = { gain: 'text-emerald-400', loss: 'text-rose-400', neutral: 'text-zinc-100', muted: 'text-zinc-700' }[tone];
  return (
    <div className={`num flex items-baseline gap-1.5 font-semibold tracking-tight ${color} ${size === 'lg' ? 'text-[34px] leading-none' : 'text-xl leading-none'}`}>
      {value}
      {unit && <span className={`font-medium text-zinc-500 ${size === 'lg' ? 'text-base' : 'text-xs'}`}>{unit}</span>}
    </div>
  );
}

function Compare({ before, after }) {
  if (!before && !after) return null;
  return (
    <div className="num flex items-center gap-2 font-mono text-[11px]">
      <span className="text-zinc-500">{before}</span>
      <span className="text-zinc-700">→</span>
      <span className="text-zinc-300">{after}</span>
    </div>
  );
}

function Cell({ label, basis, basisTitle, children, sub, compare, size = 'lg' }) {
  return (
    <div className={`flex min-w-0 flex-col bg-surface ${size === 'lg' ? 'gap-3 p-5' : 'gap-2 px-5 py-4'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="micro truncate">{label}</span>
        {basis && <BasisBadge basis={basis} title={basisTitle} />}
      </div>
      {children}
      <div className="mt-auto space-y-1">
        {sub && <div className="truncate text-xs text-zinc-500">{sub}</div>}
        {compare}
      </div>
    </div>
  );
}

export default function ImpactPanel({ impact, measurements, usage, currency, callsPerDay }) {
  const ready = !!(impact && measurements);
  const mo = measurements?.original;
  const mn = measurements?.optimized;
  const basis = measurements?.basis || {};
  const derivedTip =
    basis.carbon === 'measured'
      ? 'Measured basis: modeled from the measured runtime/memory × hardware power profile × grid intensity'
      : 'Estimated: runtime was estimated statically, so energy/carbon/cost are estimates too';

  const speed = impact?.speedup;
  const speedText = speed ? (speed >= 10 ? speed.toFixed(0) : speed.toFixed(2)) : DASH;
  const reduction = impact?.reductionPct ?? 0;
  const [co2Value, co2Unit] = ready ? splitUnit(fmtGrams(impact.perYear.co2G)) : [DASH, ''];
  const memDelta = ready ? pct(mo.memory_mb, mn.memory_mb) : 0;
  const [energyValue, energyUnit] = ready ? splitUnit(fmtEnergy(impact.perYear.energyKwh)) : [DASH, ''];
  const tokensSaved = ready ? (mo.llm_tokens || 0) - (mn.llm_tokens || 0) : 0;
  const tone = (v) => (!ready ? 'muted' : v > 0 ? 'gain' : v < 0 ? 'loss' : 'neutral');

  return (
    <section className="surface overflow-hidden">
      <div className="section-header">
        <h2 className="section-title">
          Impact
          <span className="hidden font-normal text-zinc-500 sm:inline">
            per execution × {callsPerDay.toLocaleString('en-US')}/day
          </span>
        </h2>
        {ready && (
          <span className={`num font-mono text-xs ${reduction > 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
            {reduction > 0 ? '−' : '+'}
            {Math.abs(reduction).toFixed(1)}% CO₂e / run
          </span>
        )}
      </div>

      <div className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
        <Cell
          label="CPU speedup"
          basis={ready ? basis.time : null}
          sub={ready ? `CPU ${fmtMs(mo.cpu_ms)} → ${fmtMs(mn.cpu_ms)}` : 'Median wall time of both versions'}
          compare={ready && <Compare before={fmtMs(mo.time_ms)} after={fmtMs(mn.time_ms)} />}
        >
          <Value value={speedText} unit={speed ? '× faster' : ''} tone={!ready ? 'muted' : speed > 1 ? 'gain' : 'loss'} />
        </Cell>

        <Cell
          label="Carbon reduction"
          basis={ready ? basis.carbon : null}
          basisTitle={derivedTip}
          sub={ready ? `${co2Value} ${co2Unit} CO₂e avoided / year` : 'SCI per execution, original vs optimized'}
          compare={ready && <Compare before={`${fmtGrams(impact.original.sci)}/run`} after={`${fmtGrams(impact.optimized.sci)}/run`} />}
        >
          <Value value={ready ? `${Math.abs(reduction).toFixed(1)}` : DASH} unit={ready ? '%' : ''} tone={tone(reduction)} />
        </Cell>

        <Cell
          label="Memory usage"
          basis={ready ? basis.memory : null}
          sub={ready ? `${memDelta >= 0 ? '−' : '+'}${Math.abs(memDelta).toFixed(1)}% peak · ${measurements.memory_label || 'peak allocation'}` : 'Peak allocation during execution'}
          compare={ready && <Compare before={`${mo.memory_mb?.toFixed(2) ?? DASH} MB`} after={`${mn.memory_mb?.toFixed(2) ?? DASH} MB`} />}
        >
          <Value value={ready ? (mn.memory_mb?.toFixed(2) ?? DASH) : DASH} unit={ready ? 'MB' : ''} tone={!ready ? 'muted' : memDelta > 0.5 ? 'gain' : memDelta < -0.5 ? 'loss' : 'neutral'} />
        </Cell>

        <Cell
          label="Financial savings"
          basis={ready ? basis.carbon : null}
          basisTitle={derivedTip}
          sub={ready ? `per year · ${fmtMoney(impact.perDay.money, currency)} / day` : 'Compute + electricity + LLM tokens'}
          compare={ready && <Compare before={`${fmtMoney(impact.perYear.originalMoney, currency)}/yr`} after={`${fmtMoney(impact.perYear.optimizedMoney, currency)}/yr`} />}
        >
          <Value value={ready ? fmtMoney(impact.perYear.money, currency) : DASH} tone={tone(impact?.perYear.money)} />
        </Cell>
      </div>

      <div className="grid gap-px border-t border-line bg-line md:grid-cols-3">
        <Cell size="sm" label="Energy saved / year" basis={ready ? basis.carbon : null} basisTitle={derivedTip}
          compare={ready && <Compare before={`${fmtEnergy(impact.original.energy)}/run`} after={`${fmtEnergy(impact.optimized.energy)}/run`} />}>
          <Value size="sm" value={energyValue} unit={energyUnit} tone={tone(impact?.perYear.energyKwh)} />
        </Cell>
        <Cell size="sm" label="App LLM tokens / run" basis={ready ? basis.tokens : null}
          compare={ready && mo.llm_tokens ? <Compare before={`${fmtNumber(mo.llm_tokens, 1)} tok · ${fmtNumber(mo.llm_calls, 0)} calls`} after={`${fmtNumber(mn.llm_tokens, 1)} tok · ${fmtNumber(mn.llm_calls, 0)} calls`} /> : null}
          sub={ready && !mo.llm_tokens ? 'No LLM calls in this code' : null}>
          <Value size="sm" value={ready && mo.llm_tokens ? `−${fmtNumber(tokensSaved, 1)}` : DASH} unit={ready && mo.llm_tokens ? 'tokens' : ''} tone={ready && mo.llm_tokens ? tone(tokensSaved) : 'muted'} />
        </Cell>
        <Cell size="sm" label="Refactor cost" sub={ready ? `${usage?.provider || 'offline'} · ${fmtNumber(usage?.total_tokens || 0, 1)} tokens` : 'LLM calls spent by GreenCode'}>
          <Value size="sm" value={ready ? String(usage?.calls || 0) : DASH} unit={ready ? `LLM call${usage?.calls === 1 ? '' : 's'}` : ''} tone={ready ? 'neutral' : 'muted'} />
        </Cell>
      </div>
    </section>
  );
}
