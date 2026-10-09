// Carbon model - mirrors the Carbon Accountant in backend/main.py (keep constants in sync).
//
// SCI = ((E × I) + M) per R            (Green Software Foundation, ISO/IEC 21031:2024)
//   E = (P_core · t + P_mem · GB · t) · PUE + tokens · e_token     [kWh]
//   I = grid carbon intensity                                       [gCO2e/kWh]
//   M = TE · (t / TL) · (1 / cores)                                 [gCO2e embodied share]
//   R = one execution of the program

export const HARDWARE_PROFILES = {
  cloud: {
    id: 'cloud',
    label: 'Cloud Server',
    detail: 'Xeon / EPYC vCPU',
    wattsPerCore: 3.5,
    memWattsPerGb: 0.392,
    pue: 1.12,
    embodiedKg: 1300,
    lifespanYears: 4,
    cores: 96,
    usdPerCoreHour: 0.0425,
    selfHosted: false,
  },
  edge: {
    id: 'edge',
    label: 'Mid/Edge Server',
    detail: '16-core on-prem',
    wattsPerCore: 8,
    memWattsPerGb: 0.392,
    pue: 1.4,
    embodiedKg: 900,
    lifespanYears: 5,
    cores: 16,
    usdPerCoreHour: 0.015,
    selfHosted: true,
  },
  laptop: {
    id: 'laptop',
    label: 'Developer Laptop',
    detail: 'single-core boost',
    wattsPerCore: 12,
    memWattsPerGb: 0.3,
    pue: 1.0,
    embodiedKg: 330,
    lifespanYears: 4,
    cores: 10,
    usdPerCoreHour: 0,
    selfHosted: true,
  },
};

export const GRID_PRESETS = [
  { id: 'india', label: 'India', short: 'IN', intensity: 716, usdPerKwh: 0.1 },
  { id: 'france', label: 'France', short: 'FR', intensity: 56, usdPerKwh: 0.27 },
  { id: 'us', label: 'United States', short: 'US', intensity: 385, usdPerKwh: 0.17 },
  { id: 'custom', label: 'Custom', short: '⚙', intensity: null, usdPerKwh: 0.15 },
];

export const LLM_KWH_PER_TOKEN = 0.25 / 1000 / 1000; // 0.25 Wh per 1k tokens
export const LLM_USD_PER_TOKEN = 0.69 / 1_000_000; // blended Groq llama-3.3-70b price
export const AI_QUERY_G_CO2E = 0.4; // reference footprint of one optimization LLM query
export const USD_TO_INR = 88;
const SECONDS_PER_YEAR = 365 * 24 * 3600;
const SEVERITY_PENALTY = { high: 15, medium: 7, low: 2 };

export const GRADE_COLORS = {
  'A+': '#10b981',
  A: '#34d399',
  B: '#a3e635',
  C: '#facc15',
  D: '#fb923c',
  E: '#f97316',
  F: '#ef4444',
};

export function gridPrice(regionId) {
  return (GRID_PRESETS.find((g) => g.id === regionId) || GRID_PRESETS[3]).usdPerKwh;
}

export function sciPerExecution(m, ctx) {
  const hw = HARDWARE_PROFILES[ctx.hardware];
  const t = Math.max(m.time_ms || 0, 0) / 1000;
  const memGb = Math.max(m.memory_mb || 0, 0) / 1024;
  const tokens = Math.max(m.llm_tokens || 0, 0);
  const eCpu = (hw.wattsPerCore * t) / 3.6e6;
  const eMem = (memGb * hw.memWattsPerGb * t) / 3.6e6;
  const eCompute = (eCpu + eMem) * hw.pue;
  const eLlm = tokens * LLM_KWH_PER_TOKEN;
  const energy = eCompute + eLlm;
  const operational = energy * ctx.gridIntensity;
  const embodied = (hw.embodiedKg * 1000 * (t / (hw.lifespanYears * SECONDS_PER_YEAR))) / hw.cores;
  let cost = (t / 3600) * hw.usdPerCoreHour + tokens * LLM_USD_PER_TOKEN;
  if (hw.selfHosted) cost += eCompute * gridPrice(ctx.gridRegion);
  return {
    t,
    memGb,
    tokens,
    eCpu,
    eMem,
    eCompute,
    eLlm,
    energy,
    operational,
    embodied,
    sci: operational + embodied,
    cost,
  };
}

export function greenScore(findings = [], exponent = 0, sciG = 0) {
  let penalty = findings.reduce((s, f) => s + (SEVERITY_PENALTY[f.severity] || 0), 0);
  penalty += exponent >= 3 ? 18 : exponent === 2 ? 10 : 0;
  const structural = Math.max(0, Math.min(100, 100 - penalty));
  const perMillion = Math.max(sciG * 1e6, 1);
  const efficiency = Math.max(0, Math.min(100, (100 * (5 - Math.log10(perMillion))) / 5));
  const score = Math.round((0.6 * structural + 0.4 * efficiency) * 10) / 10;
  const grade =
    score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 50 ? 'D' : score >= 40 ? 'E' : 'F';
  return { score, grade, structural, efficiency, penalty, perMillion };
}

/** Everything the dashboard shows, recomputed live from raw measurements + context. */
export function computeImpact(result, measurements, ctx) {
  if (!result || !measurements) return null;
  const o = sciPerExecution(measurements.original, ctx);
  const n = sciPerExecution(measurements.optimized, ctx);
  const perDay = ctx.callsPerDay;
  const savedG = o.sci - n.sci;
  const hw = HARDWARE_PROFILES[ctx.hardware];
  const usage = result.refactor_usage || {};
  const verifyKwh = ((hw.wattsPerCore * ((usage.pipeline_compute_ms || 0) / 1000)) / 3.6e6) * hw.pue;
  const aiCostG = AI_QUERY_G_CO2E * (usage.calls || 0) + verifyKwh * ctx.gridIntensity;
  const executionsToNeutral = savedG > 0 ? Math.ceil(aiCostG / savedG) : null;
  const fx = ctx.currency === 'INR' ? USD_TO_INR : 1;
  const profile = result.profile || {};
  return {
    original: o,
    optimized: n,
    savedG,
    reductionPct: o.sci > 0 ? (100 * savedG) / o.sci : 0,
    speedup: measurements.optimized.time_ms > 0 ? measurements.original.time_ms / measurements.optimized.time_ms : null,
    perDay: {
      co2G: savedG * perDay,
      energyKwh: (o.energy - n.energy) * perDay,
      money: (o.cost - n.cost) * perDay * fx,
    },
    perYear: {
      co2G: savedG * perDay * 365,
      energyKwh: (o.energy - n.energy) * perDay * 365,
      money: (o.cost - n.cost) * perDay * 365 * fx,
      originalCo2G: o.sci * perDay * 365,
      optimizedCo2G: n.sci * perDay * 365,
      originalMoney: o.cost * perDay * 365 * fx,
      optimizedMoney: n.cost * perDay * 365 * fx,
    },
    payback: {
      aiCostG,
      llmCalls: usage.calls || 0,
      verifyKwh,
      executionsToNeutral,
      secondsToNeutral: executionsToNeutral ? (executionsToNeutral / perDay) * 86400 : null,
      paybackMultiple: aiCostG > 0 ? (savedG * perDay * 365) / aiCostG : null,
    },
    score: {
      original: greenScore(profile.original?.findings, profile.original?.exponent, o.sci),
      optimized: greenScore(profile.optimized?.findings, profile.optimized?.exponent, n.sci),
    },
    currency: ctx.currency,
  };
}

// ---------------------------------------------------------------- formatting

export function fmtNumber(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(digits)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(digits);
  if (abs === 0) return '0';
  return v.toPrecision(digits + 1);
}

export function fmtGrams(g) {
  if (g === null || g === undefined || Number.isNaN(g)) return '-';
  const abs = Math.abs(g);
  if (abs >= 1e6) return `${(g / 1e6).toFixed(2)} t`;
  if (abs >= 1e3) return `${(g / 1e3).toFixed(2)} kg`;
  if (abs >= 1) return `${g.toFixed(2)} g`;
  if (abs >= 1e-3) return `${(g * 1e3).toFixed(2)} mg`;
  if (abs === 0) return '0 g';
  return `${(g * 1e6).toFixed(2)} µg`;
}

export function fmtEnergy(kwh) {
  if (kwh === null || kwh === undefined || Number.isNaN(kwh)) return '-';
  const abs = Math.abs(kwh);
  if (abs >= 1e3) return `${(kwh / 1e3).toFixed(2)} MWh`;
  if (abs >= 1) return `${kwh.toFixed(2)} kWh`;
  if (abs >= 1e-3) return `${(kwh * 1e3).toFixed(2)} Wh`;
  if (abs === 0) return '0 Wh';
  return `${(kwh * 1e6).toFixed(2)} mWh`;
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(2)} ms`;
}

export function fmtMoney(v, currency) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const sym = currency === 'INR' ? '₹' : '$';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7 && currency === 'INR') return `${sign}${sym}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5 && currency === 'INR') return `${sign}${sym}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${sym}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `${sign}${sym}${abs.toFixed(2)}`;
  return `${sign}${sym}${abs.toFixed(4)}`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'never';
  if (seconds < 1) return '< 1 second';
  if (seconds < 60) return `${seconds.toFixed(0)} seconds`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} minutes`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hours`;
  if (seconds < 86400 * 365) return `${(seconds / 86400).toFixed(1)} days`;
  return `${(seconds / (86400 * 365)).toFixed(1)} years`;
}

export function fmtVolume(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return String(n);
}
