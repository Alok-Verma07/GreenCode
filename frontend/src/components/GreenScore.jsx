import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { GRADE_COLORS, HARDWARE_PROFILES, LLM_KWH_PER_TOKEN, fmtGrams } from '../lib/carbon.js';

// Grade boundaries on the 0-100 score axis (lower bound of each grade).
const SCALE = [
  ['F', 0],
  ['E', 40],
  ['D', 50],
  ['C', 60],
  ['B', 70],
  ['A', 80],
  ['A+', 90],
];
const TRACK = `linear-gradient(to right, ${SCALE.map(([g, at], i) => `${GRADE_COLORS[g]} ${i === 0 ? 0 : at + 5}%`).join(', ')})`;

const clamp = (v) => Math.max(0, Math.min(100, v ?? 0));

/** Animates from 0 to the target score once it is known. */
function useAnimated(target, delay) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setV(clamp(target)), delay);
    return () => clearTimeout(t);
  }, [target, delay]);
  return v;
}

function Grade({ label, s }) {
  const color = s ? GRADE_COLORS[s.grade] : '#3f3f46';
  return (
    <div className="min-w-0">
      <div className="micro mb-2">{label}</div>
      <div className="text-[56px] font-semibold leading-none tracking-tight" style={{ color }}>
        {s?.grade || '-'}
      </div>
      <div className="num mt-2 font-mono text-xs text-zinc-500">{s ? `${s.score.toFixed(1)} / 100` : '-- / 100'}</div>
    </div>
  );
}

function Marker({ at, grade, filled, top }) {
  return (
    <div className="absolute -translate-x-1/2 transition-[left] duration-[1200ms] ease-[cubic-bezier(.2,.8,.2,1)]" style={{ left: `${at}%`, top }}>
      <div
        className="h-3.5 w-3.5 rounded-full border-2"
        style={{ borderColor: GRADE_COLORS[grade], background: filled ? GRADE_COLORS[grade] : '#121215' }}
      />
    </div>
  );
}

function FormulaRow({ name, s, ctx }) {
  const hw = HARDWARE_PROFILES[ctx.hardware];
  return (
    <div className="rounded-md border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-zinc-400">
      <div className="mb-1 font-sans text-xs font-medium text-zinc-200">{name}</div>
      <div>
        E = ({hw.wattsPerCore} W × {s.t.toFixed(4)} s + {hw.memWattsPerGb} W/GB × {s.memGb.toFixed(4)} GB × {s.t.toFixed(4)} s) × PUE {hw.pue}
        {s.tokens > 0 && ` + ${s.tokens.toFixed(0)} tok × ${(LLM_KWH_PER_TOKEN * 1e6).toFixed(2)} Wh/1k tok`}
      </div>
      <div className="pl-4 text-zinc-500">= {s.energy.toExponential(3)} kWh</div>
      <div>
        SCI = (E × I) + M = ({s.energy.toExponential(3)} × {ctx.gridIntensity}) + {s.embodied.toExponential(3)}
      </div>
      <div className="pl-4 text-zinc-200">= {fmtGrams(s.sci)} CO₂e per execution</div>
    </div>
  );
}

export default function GreenScore({ impact, ctx }) {
  const [open, setOpen] = useState(false);
  const before = impact?.score.original;
  const after = impact?.score.optimized;
  const a = useAnimated(before?.score, 80);
  const b = useAnimated(after?.score, 380);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  return (
    <section className="surface flex h-full flex-col">
      <div className="section-header">
        <h2 className="section-title">Green Score</h2>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
          aria-expanded={open}
        >
          Show the math <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <div className="flex flex-1 flex-col justify-between gap-6 p-5">
        <div className="flex items-end gap-6">
          <Grade label="Original" s={before} />
          <svg width="40" height="12" viewBox="0 0 40 12" className="mb-9 shrink-0 text-zinc-600" aria-hidden="true">
            <path d="M0 6h37M32 1l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <Grade label="Optimized" s={after} />
          {impact && (
            <div className="ml-auto hidden text-right sm:block">
              <div className="micro mb-2">Delta</div>
              <div className={`num font-mono text-lg ${after.score >= before.score ? 'text-emerald-400' : 'text-rose-400'}`}>
                {after.score >= before.score ? '+' : '−'}
                {Math.abs(after.score - before.score).toFixed(1)}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="relative h-5">
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full opacity-20" style={{ background: TRACK }} />
            {impact && (
              <div
                className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-[clip-path] duration-[1200ms] ease-[cubic-bezier(.2,.8,.2,1)]"
                style={{ background: TRACK, clipPath: `inset(0 ${100 - hi}% 0 ${lo}% round 9999px)` }}
              />
            )}
            {impact && <Marker at={a} grade={before.grade} top={3} />}
            {impact && <Marker at={b} grade={after.grade} filled top={3} />}
          </div>
          <div className="relative mt-1.5 h-4 font-mono text-[10px] text-zinc-600">
            {SCALE.map(([g, at]) => (
              <span key={g} className="absolute -translate-x-1/2" style={{ left: `${g === 'F' ? 20 : at + 5}%` }}>
                {g}
              </span>
            ))}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
          {[
            ['Structural', before?.structural, after?.structural],
            ['Carbon efficiency', before?.efficiency, after?.efficiency],
          ].map(([k, x, y]) => (
            <div key={k} className="bg-surface px-3 py-2.5">
              <dt className="micro">{k}</dt>
              <dd className="num mt-1 font-mono text-[13px] text-zinc-300">
                {impact ? (
                  <>
                    {x.toFixed(0)} <span className="text-zinc-600">→</span> <span className="text-zinc-100">{y.toFixed(0)}</span>
                  </>
                ) : (
                  <span className="text-zinc-700">-</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className={`grid transition-all duration-300 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="space-y-3 border-t border-line p-5 text-xs text-zinc-400">
            <div>
              <div className="font-mono text-sm text-zinc-100">SCI = (E × I) + M</div>
              <div className="mt-1 text-[11px] text-zinc-500">per functional unit R = one execution (Green Software Foundation SCI, ISO/IEC 21031)</div>
            </div>
            <ul className="space-y-1 text-[11px]">
              <li><b className="font-medium text-zinc-200">E</b> energy (kWh) = (P<sub>core</sub>·t + P<sub>mem</sub>·GB·t)·PUE + tokens·e<sub>token</sub></li>
              <li><b className="font-medium text-zinc-200">I</b> grid carbon intensity = {ctx.gridIntensity} gCO₂e/kWh</li>
              <li><b className="font-medium text-zinc-200">M</b> embodied share = TE · (t / lifespan) · (1 / cores)</li>
            </ul>
            {impact && <FormulaRow name="Original" s={impact.original} ctx={ctx} />}
            {impact && <FormulaRow name="Optimized" s={impact.optimized} ctx={ctx} />}
            <div className="rounded-md border border-line bg-canvas p-3 text-[11px] leading-relaxed">
              <div className="mb-1 text-xs font-medium text-zinc-200">Green Score composition</div>
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
