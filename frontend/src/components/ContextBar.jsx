import { GRID_PRESETS, HARDWARE_PROFILES, fmtVolume } from '../lib/carbon.js';

const MIN_EXP = 3; // 1,000 executions/day
const MAX_EXP = 7; // 10,000,000 executions/day

const toSlider = (v) => ((Math.log10(v) - MIN_EXP) / (MAX_EXP - MIN_EXP)) * 1000;
const fromSlider = (s) => {
  const raw = 10 ** (MIN_EXP + (s / 1000) * (MAX_EXP - MIN_EXP));
  const mag = 10 ** Math.floor(Math.log10(raw));
  return Math.round(raw / (mag / 4)) * (mag / 4); // snap to quarter steps of each decade
};

function Field({ label, value, children }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span className="micro">{label}</span>
        <span className="num truncate font-mono text-[11px] text-zinc-400">{value}</span>
      </div>
      {children}
    </div>
  );
}

/** Deployment assumptions that drive the carbon model. Changing them recomputes impact live. */
export default function ContextBar({ ctx, setCtx }) {
  const update = (patch) => setCtx((c) => ({ ...c, ...patch }));
  const hw = HARDWARE_PROFILES[ctx.hardware];
  const slider = toSlider(ctx.callsPerDay);

  return (
    <section className="surface grid divide-y divide-line lg:grid-cols-[1.3fr_1fr_1.1fr] lg:divide-x lg:divide-y-0">
      <Field label="Grid intensity" value={`${ctx.gridIntensity} gCO₂e/kWh`}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg-group max-w-full overflow-x-auto no-scrollbar" role="group" aria-label="Grid region">
            {GRID_PRESETS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => update({ gridRegion: g.id, gridIntensity: g.intensity ?? ctx.customIntensity })}
                className={`seg ${ctx.gridRegion === g.id ? 'seg-active' : ''}`}
                title={g.intensity ? `${g.label}: ${g.intensity} gCO₂e/kWh` : 'Enter your own grid intensity'}
              >
                {g.label}
                {g.intensity ? <span className="num font-mono text-[10.5px] text-zinc-500">{g.intensity}</span> : null}
              </button>
            ))}
          </div>
          {ctx.gridRegion === 'custom' && (
            <input
              type="number"
              min={0}
              max={2000}
              value={ctx.customIntensity}
              onChange={(e) => {
                const v = Math.max(0, Math.min(2000, Number(e.target.value) || 0));
                update({ customIntensity: v, gridIntensity: v });
              }}
              className="num h-7 w-20 rounded-md border border-line bg-canvas px-2 font-mono text-xs text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
              aria-label="Custom grid intensity in gCO2e per kWh"
            />
          )}
        </div>
      </Field>

      <Field label="Hardware" value={`${hw.wattsPerCore} W/core · PUE ${hw.pue}`}>
        <div className="seg-group" role="group" aria-label="Hardware profile">
          {Object.values(HARDWARE_PROFILES).map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => update({ hardware: h.id })}
              className={`seg ${ctx.hardware === h.id ? 'seg-active' : ''}`}
              title={h.detail}
            >
              {h.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Executions / day" value={ctx.callsPerDay.toLocaleString('en-US')}>
        <input
          type="range"
          className="gc-range"
          style={{ '--fill': `${slider / 10}%` }}
          min={0}
          max={1000}
          step={1}
          value={slider}
          onChange={(e) => update({ callsPerDay: Math.max(1000, Math.min(10_000_000, fromSlider(Number(e.target.value)))) })}
          aria-label="Executions per day"
        />
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-600">
          {[1e3, 1e4, 1e5, 1e6, 1e7].map((v) => (
            <button key={v} type="button" className="transition-colors hover:text-zinc-300" onClick={() => update({ callsPerDay: v })}>
              {fmtVolume(v)}
            </button>
          ))}
        </div>
      </Field>
    </section>
  );
}
