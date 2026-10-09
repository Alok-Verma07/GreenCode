import { Globe, Server, Laptop, Cloud, Activity } from 'lucide-react';
import { GRID_PRESETS, HARDWARE_PROFILES, fmtVolume } from '../lib/carbon.js';

const HW_ICONS = { cloud: Cloud, edge: Server, laptop: Laptop };
const MIN_EXP = 3; // 1,000 executions/day
const MAX_EXP = 7; // 10,000,000 executions/day

const toSlider = (v) => ((Math.log10(v) - MIN_EXP) / (MAX_EXP - MIN_EXP)) * 1000;
const fromSlider = (s) => {
  const raw = 10 ** (MIN_EXP + (s / 1000) * (MAX_EXP - MIN_EXP));
  const mag = 10 ** Math.floor(Math.log10(raw));
  return Math.round(raw / (mag / 4)) * (mag / 4); // snap to quarter steps of each decade
};

export default function ContextBar({ ctx, setCtx }) {
  const update = (patch) => setCtx((c) => ({ ...c, ...patch }));
  const intensityColor =
    ctx.gridIntensity < 150 ? 'text-emerald-300' : ctx.gridIntensity < 450 ? 'text-amber-300' : 'text-red-300';

  return (
    <section className="panel grid gap-4 p-4 lg:grid-cols-[1.25fr_1fr_1.1fr]">
      {/* Grid intensity */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <Globe size={12} /> Grid carbon intensity
          </span>
          <span className={`font-mono text-xs font-semibold ${intensityColor}`}>{ctx.gridIntensity} gCO₂e/kWh</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {GRID_PRESETS.map((g) => {
            const on = ctx.gridRegion === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() =>
                  update({ gridRegion: g.id, gridIntensity: g.intensity ?? ctx.customIntensity })
                }
                className={on ? 'seg-on' : 'seg-off'}
                title={g.intensity ? `${g.label}: ${g.intensity} gCO₂e/kWh` : 'Enter your own grid intensity'}
              >
                <span className="mr-1 font-mono text-[10px] opacity-60">{g.short}</span>
                {g.label}
                {g.intensity ? <span className="ml-1 font-mono text-[10px] opacity-60">{g.intensity}</span> : null}
              </button>
            );
          })}
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
              className="w-24 rounded-lg border border-white/10 bg-ink-800 px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-emerald-500/60"
              aria-label="Custom grid intensity in gCO2e per kWh"
            />
          )}
        </div>
      </div>

      {/* Hardware */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <Server size={12} /> Hardware profile
          </span>
          <span className="font-mono text-[11px] text-slate-500">
            {HARDWARE_PROFILES[ctx.hardware].wattsPerCore} W/core · PUE {HARDWARE_PROFILES[ctx.hardware].pue}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {Object.values(HARDWARE_PROFILES).map((hw) => {
            const Icon = HW_ICONS[hw.id];
            const on = ctx.hardware === hw.id;
            return (
              <button
                key={hw.id}
                type="button"
                onClick={() => update({ hardware: hw.id })}
                className={`flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition ${
                  on ? 'bg-emerald-500/15 ring-1 ring-emerald-500/40' : 'hover:bg-white/5'
                }`}
              >
                <span className={`flex items-center gap-1.5 text-xs font-semibold ${on ? 'text-emerald-300' : 'text-slate-300'}`}>
                  <Icon size={13} /> {hw.label}
                </span>
                <span className="text-[10px] text-slate-500">{hw.detail}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Volume */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <Activity size={12} /> Executions per day
          </span>
          <span className="font-mono text-sm font-bold text-emerald-300">{ctx.callsPerDay.toLocaleString('en-US')}</span>
        </div>
        <input
          type="range"
          className="gc-range"
          min={0}
          max={1000}
          step={1}
          value={toSlider(ctx.callsPerDay)}
          onChange={(e) => update({ callsPerDay: Math.max(1000, Math.min(10_000_000, fromSlider(Number(e.target.value)))) })}
          aria-label="Executions per day"
        />
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-slate-500">
          {[1e3, 1e4, 1e5, 1e6, 1e7].map((v) => (
            <button key={v} type="button" className="hover:text-emerald-300" onClick={() => update({ callsPerDay: v })}>
              {fmtVolume(v)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
