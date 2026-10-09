import { useEffect, useState } from 'react';
import { Gauge as GaugeIcon, ChevronDown, Sigma, ArrowRight } from 'lucide-react';
import { GRADE_COLORS, HARDWARE_PROFILES, LLM_KWH_PER_TOKEN, fmtGrams } from '../lib/carbon.js';

const R = 70;
const ARC = Math.PI * R; // semicircle length

function Gauge({ label, score, grade, delay = 0 }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setShown(score ?? 0), 80 + delay);
    return () => clearTimeout(t);
  }, [score, delay]);
  const color = GRADE_COLORS[grade] || '#334155';
  const offset = ARC * (1 - Math.max(0, Math.min(100, shown)) / 100);
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 180 104" className="w-full max-w-[200px]">
        <defs>
          <linearGradient id={`g-${label}`} x1="0" x2="1">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="50%" stopColor="#facc15" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        <path d={`M 20 92 A ${R} ${R} 0 0 1 160 92`} fill="none" stroke="#1a2a23" strokeWidth="14" strokeLinecap="round" />
        <path
          d={`M 20 92 A ${R} ${R} 0 0 1 160 92`}
          fill="none"
          stroke={score == null ? '#1a2a23' : `url(#g-${label})`}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={ARC}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)' }}
        />
        <text x="90" y="78" textAnchor="middle" fontSize="34" fontWeight="900" fill={score == null ? '#3a5246' : color}>
          {grade || '–'}
        </text>
        <text x="90" y="98" textAnchor="middle" fontSize="11" fill="#64748b" fontFamily="JetBrains Mono, monospace">
          {score == null ? '--' : `${shown.toFixed(1)} / 100`}
        </text>
      </svg>
      <span className="label mt-1">{label}</span>
    </div>
  );
}

function FormulaRow({ name, s, ctx }) {
  const hw = HARDWARE_PROFILES[ctx.hardware];
  return (
    <div className="rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
      <div className="mb-1 font-sans text-xs font-semibold text-slate-200">{name}</div>
      <div>
        E = ({hw.wattsPerCore} W × {s.t.toFixed(4)} s + {hw.memWattsPerGb} W/GB × {s.memGb.toFixed(4)} GB × {s.t.toFixed(4)} s) × PUE {hw.pue}
        {s.tokens > 0 && ` + ${s.tokens.toFixed(0)} tok × ${(LLM_KWH_PER_TOKEN * 1e6).toFixed(2)} Wh/1k tok`}
      </div>
      <div className="pl-4 text-slate-400">= {s.energy.toExponential(3)} kWh</div>
      <div>
        SCI = (E × I) + M = ({s.energy.toExponential(3)} × {ctx.gridIntensity}) + {s.embodied.toExponential(3)}
      </div>
      <div className="pl-4 text-emerald-300">= {fmtGrams(s.sci)} CO₂e per execution</div>
    </div>
  );
}

export default function GreenScore({ impact, ctx }) {
  const [open, setOpen] = useState(false);
  const before = impact?.score.original;
  const after = impact?.score.optimized;

  return (
    <section className="panel flex h-full flex-col">
      <div className="panel-header">
        <h2 className="panel-title">
          <GaugeIcon size={15} className="text-emerald-400" /> Green Score
        </h2>
        <span className="text-[11px] text-slate-500">A+ (best) → F</span>
      </div>
      <div className="flex flex-1 items-center justify-center gap-2 px-4 pt-4">
        <Gauge label="Before" score={before?.score ?? null} grade={before?.grade} />
        <ArrowRight className="shrink-0 text-slate-600" />
        <Gauge label="After" score={after?.score ?? null} grade={after?.grade} delay={350} />
      </div>
      {impact && (
        <div className="grid grid-cols-2 gap-2 px-4 pb-1 pt-3 text-center text-[11px]">
          <div className="rounded-lg bg-black/20 py-1.5 text-slate-400">
            Structural <span className="font-mono text-slate-200">{before.structural.toFixed(0)} → {after.structural.toFixed(0)}</span>
          </div>
          <div className="rounded-lg bg-black/20 py-1.5 text-slate-400">
            Carbon efficiency <span className="font-mono text-slate-200">{before.efficiency.toFixed(0)} → {after.efficiency.toFixed(0)}</span>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mx-4 mb-4 mt-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs font-semibold text-slate-300 hover:border-emerald-500/30"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          <Sigma size={13} className="text-emerald-400" /> Show the math
        </span>
        <ChevronDown size={14} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <div className={`grid transition-all duration-300 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="space-y-3 px-4 pb-4 text-xs text-slate-400">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 text-center">
              <div className="font-mono text-base font-bold text-emerald-300">SCI = (E × I) + M</div>
              <div className="mt-1 text-[11px]">per functional unit R = one execution (Green Software Foundation SCI, ISO/IEC 21031)</div>
            </div>
            <ul className="space-y-1 text-[11px]">
              <li><b className="text-slate-200">E</b> energy (kWh) = (P<sub>core</sub>·t + P<sub>mem</sub>·GB·t)·PUE + tokens·e<sub>token</sub></li>
              <li><b className="text-slate-200">I</b> grid carbon intensity = {ctx.gridIntensity} gCO₂e/kWh</li>
              <li><b className="text-slate-200">M</b> embodied share = TE · (t / lifespan) · (1 / cores)</li>
            </ul>
            {impact && <FormulaRow name="Original" s={impact.original} ctx={ctx} />}
            {impact && <FormulaRow name="Optimized" s={impact.optimized} ctx={ctx} />}
            <div className="rounded-lg bg-black/30 p-3 text-[11px] leading-relaxed">
              <div className="mb-1 text-xs font-semibold text-slate-200">Green Score composition</div>
              <div className="font-mono">score = 0.6 × structural + 0.4 × efficiency</div>
              <div className="font-mono">structural = 100 − Σ(high 15, medium 7, low 2) − (O(N²) 10 | O(N³) 18)</div>
              <div className="font-mono">efficiency = 100 × (5 − log₁₀(SCI per 1M runs in g)) / 5</div>
              <div className="mt-1">Grades: A+ ≥ 90 · A ≥ 80 · B ≥ 70 · C ≥ 60 · D ≥ 50 · E ≥ 40 · F &lt; 40</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
