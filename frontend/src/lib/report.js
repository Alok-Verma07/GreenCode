// 1-click Green Software Audit Report - shared data model (modal preview) + jsPDF renderer.
import { jsPDF } from 'jspdf';
import { lineDiff, diffStats } from './diff.js';
import {
  HARDWARE_PROFILES,
  GRID_PRESETS,
  AI_QUERY_G_CO2E,
  LLM_KWH_PER_TOKEN,
  LLM_USD_PER_TOKEN,
  USD_TO_INR,
  fmtMs,
  fmtEnergy,
  fmtGrams,
  fmtMoney,
  fmtNumber,
  fmtDuration,
} from './carbon.js';

const pctChange = (a, b) => {
  if (!(a > 0)) return '-';
  const p = ((b - a) / a) * 100;
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
};
const LANG_LABEL = { python: 'Python', javascript: 'JavaScript', sql: 'SQL' };

export function buildReportData({ result, impact, measurements, verification, ctx, title, optimizedCode }) {
  const hw = HARDWARE_PROFILES[ctx.hardware];
  const grid = GRID_PRESETS.find((g) => g.id === ctx.gridRegion);
  const findings = result.profile.original.findings;
  const high = findings.filter((f) => f.severity === 'high').length;
  const top = result.ranking[0];
  const basis = measurements.basis;
  const { original: mo, optimized: mn } = measurements;
  const engine = result.engine.type === 'llm' ? `Groq ${result.engine.model}` : 'offline deterministic AST rule engine';
  const changes = result.changes || [];
  const status = verification?.status || result.verification.status;
  const statusSentence = {
    passed: `Differential execution confirmed identical observable behaviour (${verification?.equivalence?.detail || verification?.detail || 'outputs identical'}).`,
    failed: 'Differential execution rejected the rewrite, so the original code was retained.',
    estimated: 'The program could not be executed stand-alone, so behaviour was checked statically and all figures are estimates.',
  }[status];
  const lines = result.original_code.replace(/\n$/, '').split('\n').length;

  const summary =
    `GreenCode AI analysed "${title}", a ${lines}-line ${LANG_LABEL[result.language]} program. ` +
    `The Profiler agent found ${findings.length} bottleneck${findings.length === 1 ? '' : 's'} (${high} high severity)` +
    (top ? `; the Strategist ranked "${top.title}" (line ${top.line}, ${top.complexity}) as the largest carbon driver. ` : '. ') +
    `The Refactorer (${engine}) applied ${changes.length} rewrite${changes.length === 1 ? '' : 's'}, moving asymptotic cost from ` +
    `${result.profile.original.complexity} to ${result.profile.optimized.complexity}. ${statusSentence} ` +
    `At ${ctx.callsPerDay.toLocaleString('en-US')} executions/day on a ${hw.label} with a ${ctx.gridIntensity} gCO2e/kWh grid, ` +
    `the optimized version runs ${impact.speedup ? impact.speedup.toFixed(1) : '-'}x faster and avoids ${fmtGrams(impact.perYear.co2G)} CO2e ` +
    `and ${fmtMoney(impact.perYear.money, ctx.currency)} per year. Green Score: ${impact.score.original.grade} -> ${impact.score.optimized.grade}.`;

  const metrics = [
    ['Execution time (median wall)', fmtMs(mo.time_ms), fmtMs(mn.time_ms), impact.speedup ? `${impact.speedup.toFixed(1)}x faster` : '-', basis.time],
    ['CPU time', fmtMs(mo.cpu_ms), fmtMs(mn.cpu_ms), pctChange(mo.cpu_ms, mn.cpu_ms), basis.time],
    ['Memory', `${(mo.memory_mb ?? 0).toFixed(2)} MB`, `${(mn.memory_mb ?? 0).toFixed(2)} MB`, pctChange(mo.memory_mb, mn.memory_mb), basis.memory],
    ['Energy per execution', fmtEnergy(impact.original.energy), fmtEnergy(impact.optimized.energy), pctChange(impact.original.energy, impact.optimized.energy), basis.carbon],
    ['SCI per execution (CO2e)', fmtGrams(impact.original.sci), fmtGrams(impact.optimized.sci), pctChange(impact.original.sci, impact.optimized.sci), basis.carbon],
    ['CO2e per year', fmtGrams(impact.perYear.originalCo2G), fmtGrams(impact.perYear.optimizedCo2G), `-${fmtGrams(impact.perYear.co2G)}`, basis.carbon],
    ['Energy per year', fmtEnergy(impact.original.energy * ctx.callsPerDay * 365), fmtEnergy(impact.optimized.energy * ctx.callsPerDay * 365), `-${fmtEnergy(impact.perYear.energyKwh)}`, basis.carbon],
    ['Cost per year', fmtMoney(impact.perYear.originalMoney, ctx.currency), fmtMoney(impact.perYear.optimizedMoney, ctx.currency), `-${fmtMoney(impact.perYear.money, ctx.currency)}`, basis.carbon],
    ['App LLM tokens / execution', fmtNumber(mo.llm_tokens || 0, 1), fmtNumber(mn.llm_tokens || 0, 1), pctChange(mo.llm_tokens, mn.llm_tokens), basis.tokens],
    ['App LLM calls / execution', fmtNumber(mo.llm_calls || 0, 0), fmtNumber(mn.llm_calls || 0, 0), pctChange(mo.llm_calls, mn.llm_calls), basis.tokens],
    ['Green Score', `${impact.score.original.grade} (${impact.score.original.score})`, `${impact.score.optimized.grade} (${impact.score.optimized.score})`, `+${(impact.score.optimized.score - impact.score.original.score).toFixed(1)} pts`, basis.carbon],
  ];

  const p = impact.payback;
  const payback = [
    ['Optimization footprint', `${fmtGrams(p.aiCostG)} (${p.llmCalls} LLM quer${p.llmCalls === 1 ? 'y' : 'ies'} x ~${AI_QUERY_G_CO2E} g + local profiling/verification)`],
    ['Saved per execution', fmtGrams(impact.savedG)],
    ['Executions to carbon neutrality', p.executionsToNeutral ? fmtNumber(p.executionsToNeutral, 1) : 'never (no per-execution savings)'],
    ['Time to neutrality', p.executionsToNeutral ? `${fmtDuration(p.secondsToNeutral)} at ${ctx.callsPerDay.toLocaleString('en-US')}/day` : '-'],
    ['First-year return on carbon', p.paybackMultiple ? `${fmtNumber(p.paybackMultiple, 1)}x the optimization footprint` : '-'],
  ];

  const context = [
    ['Grid', `${grid?.label || 'Custom'} - ${ctx.gridIntensity} gCO2e/kWh`],
    ['Hardware', `${hw.label} (${hw.detail}) - ${hw.wattsPerCore} W/core, PUE ${hw.pue}, ${hw.embodiedKg} kgCO2e embodied / ${hw.lifespanYears} yrs / ${hw.cores} cores`],
    ['Volume', `${ctx.callsPerDay.toLocaleString('en-US')} executions/day`],
    ['Refactor engine', engine + (result.engine.fallback_reason ? ` (fallback: ${result.engine.fallback_reason})` : '')],
    ['GreenCode LLM usage', `${result.refactor_usage.calls} call(s), ${result.refactor_usage.total_tokens} tokens`],
  ];

  const methodology = [
    `Software Carbon Intensity (Green Software Foundation, ISO/IEC 21031:2024): SCI = ((E x I) + M) per R, with R = one execution.`,
    `E = (P_core x t + P_mem x GB x t) x PUE + tokens x ${(LLM_KWH_PER_TOKEN * 1e6).toFixed(2)} Wh per 1k tokens. P_core/PUE come from the selected hardware profile (Cloud Carbon Footprint coefficients for cloud vCPUs); P_mem = ${hw.memWattsPerGb} W/GB.`,
    `I = selected grid intensity. M = embodied emissions x (t / lifespan) x (1 / cores), i.e. the time- and resource-share of the server's manufacturing footprint.`,
    `"Measured" figures come from sandboxed differential execution: both versions run in isolated subprocesses (Python with tracemalloc, Node.js with V8 heap/RSS sampling, SQLite in-memory), timing is the median of up to 5 runs within a 1.5 s budget. Energy, carbon and cost are modelled from these measured values.`,
    `"Estimated" figures are derived statically from the syntax tree (loop depth, findings) when the code cannot run stand-alone; treat them as order-of-magnitude guidance.`,
    `Equivalence: stdout must be byte-identical (Python/JS; lines prefixed #METRIC are telemetry and excluded) or every SQL result set must match row-for-row (floats to 1e-6). One retry is attempted before the original code is kept.`,
    `Cost = core-hours x hourly rate + self-hosted electricity + LLM tokens x $${(LLM_USD_PER_TOKEN * 1e6).toFixed(2)}/M. INR uses a fixed rate of ${USD_TO_INR} per USD.`,
    `Optimization footprint uses ~${AI_QUERY_G_CO2E} g CO2e per LLM refactoring query plus the measured energy of the profiling/verification runs.`,
    `Limitations: single-core attribution; no network/storage energy beyond LLM tokens; benchmark inputs may not reflect production data distributions.`,
  ];

  const diffRows = lineDiff(result.original_code, optimizedCode);
  return {
    title,
    language: LANG_LABEL[result.language],
    date: new Date(),
    summary,
    metrics,
    payback,
    context,
    methodology,
    findings: result.ranking,
    changes,
    verification: {
      status,
      detail: verification?.equivalence?.detail || verification?.detail || '',
      attempts: verification?.attempts || [],
    },
    scores: impact.score,
    diffRows,
    diffStats: diffStats(diffRows),
  };
}

// ------------------------------------------------------------------ PDF

const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACEMENTS = { '→': '->', '←': '<-', '₂': '2', '₹': 'Rs ', '≈': '~', '≥': '>=', '≤': '<=', '✓': 'OK', '✗': 'X', '−': '-', '∞': 'inf', '⋯': '...', '₁₀': '10', '₀': '0' };

function clean(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (ch.charCodeAt(0) < 256 || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

const C = {
  ink: [15, 23, 20],
  text: [40, 52, 48],
  muted: [110, 125, 120],
  emerald: [16, 150, 105],
  emeraldLight: [220, 245, 234],
  red: [200, 50, 50],
  redLight: [252, 228, 228],
  greenLight: [222, 247, 233],
  line: [225, 232, 229],
  amber: [190, 120, 10],
};

export function downloadAuditPdf(data, currency) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const CW = W - 2 * M;
  let y = M;

  const ensure = (h) => {
    if (y + h > H - M - 16) {
      doc.addPage();
      y = M;
    }
  };
  const setColor = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const heading = (t) => {
    ensure(34);
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    setColor(C.ink);
    doc.text(clean(t), M, y);
    y += 5;
    doc.setDrawColor(...C.emerald);
    doc.setLineWidth(1.2);
    doc.line(M, y, M + 38, y);
    y += 13;
  };
  const paragraph = (t, size = 9.5, color = C.text, indent = 0) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    setColor(color);
    const lines = doc.splitTextToSize(clean(t), CW - indent);
    for (const ln of lines) {
      ensure(size + 3);
      doc.text(ln, M + indent, y);
      y += size + 3;
    }
  };
  const table = (headers, rows, widths, opts = {}) => {
    const size = opts.size || 8.5;
    const pad = 4;
    const drawRow = (cells, header) => {
      doc.setFont('helvetica', header ? 'bold' : 'normal');
      doc.setFontSize(size);
      const wrapped = cells.map((c, i) => doc.splitTextToSize(clean(c), widths[i] - 2 * pad));
      const h = Math.max(...wrapped.map((w) => w.length)) * (size + 2) + 2 * pad;
      ensure(h);
      if (header) {
        doc.setFillColor(...C.emeraldLight);
        doc.rect(M, y, CW, h, 'F');
      }
      let x = M;
      wrapped.forEach((w, i) => {
        const cell = String(cells[i] ?? '');
        let color = header ? C.ink : C.text;
        if (!header && opts.basisCol === i) color = cell === 'measured' ? C.emerald : C.amber;
        setColor(color);
        doc.text(w, x + pad, y + pad + size - 1);
        x += widths[i];
      });
      y += h;
      doc.setDrawColor(...C.line);
      doc.setLineWidth(0.5);
      doc.line(M, y, M + CW, y);
    };
    drawRow(headers, true);
    rows.forEach((r) => drawRow(r, false));
    y += 6;
  };

  // ---- Cover band
  doc.setFillColor(...C.ink);
  doc.rect(0, 0, W, 110, 'F');
  doc.setFillColor(...C.emerald);
  doc.rect(0, 110, W, 4, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(110, 231, 183);
  doc.text('GREENCODE AI', M, 38);
  doc.setFontSize(21);
  doc.setTextColor(255, 255, 255);
  doc.text('Green Software Audit Report', M, 64);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(190, 205, 200);
  doc.text(clean(`${data.title} - ${data.language} - ${data.date.toLocaleString('en-GB')}`), M, 84);

  // Grade badges
  const badge = (x, label, s) => {
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, 30, 62, 58, 6, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    const g = s.grade;
    const col = g.startsWith('A') ? C.emerald : g === 'B' || g === 'C' ? C.amber : C.red;
    setColor(col);
    doc.text(g, x + 31, 64, { align: 'center' });
    doc.setFontSize(7);
    setColor(C.muted);
    doc.text(`${label} ${s.score}`, x + 31, 80, { align: 'center' });
  };
  badge(W - M - 140, 'BEFORE', data.scores.original);
  badge(W - M - 62, 'AFTER', data.scores.optimized);
  y = 140;

  heading('Executive summary');
  paragraph(data.summary, 10);

  heading('Verified metrics');
  table(['Metric', 'Original', 'Optimized', 'Change', 'Basis'], data.metrics, [150, 95, 95, 105, 70], { basisCol: 4 });

  heading('Analysis context');
  table(['Parameter', 'Value'], data.context, [120, CW - 120]);

  heading('Bottlenecks (Strategist ranking)');
  if (data.findings.length === 0) paragraph('No bottlenecks detected.');
  else
    table(
      ['#', 'Bottleneck', 'Line', 'Severity', 'Big-O', 'Carbon share'],
      data.findings.map((f) => [f.rank, f.title, f.line, f.severity, f.complexity, `${f.carbon_share_pct}%`]),
      [24, 220, 40, 60, 80, 91],
    );

  heading('Applied rewrites');
  if (data.changes.length === 0) paragraph('No rewrite applied - original code retained.');
  data.changes.forEach((c, i) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    setColor(C.emerald);
    ensure(14);
    doc.text(clean(`${i + 1}. ${c.title}`), M, y);
    y += 12;
    paragraph(c.detail, 8.5, C.text, 12);
    y += 2;
  });

  heading('Differential verification');
  paragraph(`Status: ${data.verification.status.toUpperCase()} - ${data.verification.detail}`, 9.5, data.verification.status === 'passed' ? C.emerald : C.amber);
  data.verification.attempts.forEach((a) =>
    paragraph(`- ${a.label}: ${a.passed === true ? 'PASS' : a.passed === false ? 'FAIL' : 'SKIPPED'} - ${a.detail}`, 8.5, C.text, 8),
  );

  heading('Carbon payback analysis');
  table(['Item', 'Value'], data.payback, [170, CW - 170]);

  // ---- Side-by-side diff
  doc.addPage();
  y = M;
  heading(`Side-by-side code diff  (+${data.diffStats.added} / -${data.diffStats.removed} lines)`);
  const colW = (CW - 10) / 2;
  const fs = 6.4;
  const rowH = 8.2;
  const numW = 16;
  const maxChars = Math.floor((colW - numW - 4) / (fs * 0.6));
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  setColor(C.red);
  doc.text('ORIGINAL', M, y);
  setColor(C.emerald);
  doc.text('OPTIMIZED', M + colW + 10, y);
  y += 8;

  // Collapse long unchanged stretches so the diff stays readable.
  const rows = [];
  const CONTEXT = 3;
  const changed = data.diffRows.map((r) => r.left?.type !== 'same' || r.right?.type !== 'same');
  for (let i = 0; i < data.diffRows.length; i++) {
    const near = changed.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(Boolean);
    if (near || data.diffRows.length < 140) rows.push(data.diffRows[i]);
    else if (rows[rows.length - 1] !== 'gap') rows.push('gap');
  }

  const drawSide = (cell, x, type) => {
    if (!cell) return;
    if (type !== 'same') {
      doc.setFillColor(...(type === 'del' ? C.redLight : C.greenLight));
      doc.rect(x, y - fs, colW, rowH, 'F');
    }
    doc.setFont('courier', 'normal');
    doc.setFontSize(fs);
    setColor(C.muted);
    doc.text(String(cell.n), x + numW - 3, y, { align: 'right' });
    setColor(type === 'del' ? C.red : type === 'add' ? C.emerald : C.text);
    let t = clean(cell.text.replace(/\t/g, '    '));
    if (t.length > maxChars) t = t.slice(0, maxChars - 1) + '>';
    doc.text(t, x + numW + 2, y);
  };
  for (const r of rows) {
    ensure(rowH);
    if (r === 'gap') {
      doc.setFont('courier', 'italic');
      doc.setFontSize(fs);
      setColor(C.muted);
      doc.text('...  unchanged lines collapsed  ...', M + CW / 2, y, { align: 'center' });
      y += rowH;
      continue;
    }
    drawSide(r.left, M, r.left?.type || 'same');
    drawSide(r.right, M + colW + 10, r.right?.type || 'same');
    y += rowH;
  }

  heading('Methodology & disclosure');
  data.methodology.forEach((m) => {
    paragraph(`- ${m}`, 8.5, C.text, 4);
    y += 1;
  });

  // ---- Footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    setColor(C.muted);
    doc.text(clean(`GreenCode AI - Green Software Audit - ${data.title} - currency ${currency}`), M, H - 22);
    doc.text(`Page ${i} / ${pages}`, W - M, H - 22, { align: 'right' });
  }

  const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  doc.save(`greencode-audit-${slug || 'report'}-${data.date.toISOString().slice(0, 10)}.pdf`);
}
