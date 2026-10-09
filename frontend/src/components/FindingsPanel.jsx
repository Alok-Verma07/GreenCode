import { ListOrdered, Sparkles, ShieldCheck, CheckCircle2, XCircle, CircleDashed, Database } from 'lucide-react';
import { SeverityBadge } from './Badge.jsx';
import { fmtMs } from '../lib/carbon.js';

function AttemptIcon({ passed }) {
  if (passed === true) return <CheckCircle2 size={14} className="text-emerald-400" />;
  if (passed === false) return <XCircle size={14} className="text-red-400" />;
  return <CircleDashed size={14} className="text-amber-400" />;
}

export default function FindingsPanel({ result, verification }) {
  if (!result) return null;
  const ranking = result.ranking || [];
  const changes = result.changes || [];
  const sql = result.measurements?.sql;

  return (
    <section className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
      <div className="panel overflow-hidden">
        <div className="panel-header">
          <h2 className="panel-title">
            <ListOrdered size={15} className="text-violet-300" /> Strategist ranking
          </h2>
          <span className="font-mono text-[11px] text-slate-500">
            {result.profile.original.complexity} → {result.profile.optimized.complexity}
          </span>
        </div>
        {ranking.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">No bottlenecks detected - the code already looks efficient.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr className="border-b border-white/[0.06]">
                  <th className="px-4 py-2">#</th>
                  <th className="px-2 py-2">Bottleneck</th>
                  <th className="px-2 py-2">Line</th>
                  <th className="px-2 py-2">Severity</th>
                  <th className="px-2 py-2">Big-O</th>
                  <th className="px-2 py-2">Carbon share</th>
                  <th className="px-2 py-2">Memory</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => (
                  <tr key={r.finding_id} className="border-b border-white/[0.03] align-top hover:bg-white/[0.02]" title={r.action}>
                    <td className="px-4 py-2 font-mono text-slate-500">{r.rank}</td>
                    <td className="px-2 py-2">
                      <div className="font-medium text-slate-200">{r.title}</div>
                      <div className="mt-0.5 max-w-[420px] text-[11px] text-slate-500">{r.action}</div>
                    </td>
                    <td className="px-2 py-2 font-mono text-slate-400">{r.line}</td>
                    <td className="px-2 py-2"><SeverityBadge severity={r.severity} /></td>
                    <td className="px-2 py-2 font-mono text-red-300">{r.complexity}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
                          <div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-red-500" style={{ width: `${r.carbon_share_pct}%` }} />
                        </div>
                        <span className="font-mono text-slate-300">{r.carbon_share_pct}%</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-slate-400">{r.memory_impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              <Sparkles size={15} className="text-amber-300" /> Applied rewrites
            </h2>
            <span className="text-[11px] text-slate-500">
              {result.engine.type === 'llm' ? `Groq ${result.engine.model}` : 'Offline AST rule engine'}
            </span>
          </div>
          <div className="space-y-2 p-3">
            {result.engine.fallback_reason && result.engine.type !== 'llm' && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-200">
                Fallback: {result.engine.fallback_reason}
              </div>
            )}
            {changes.length === 0 && <p className="text-xs text-slate-500">No rewrite was applied - original code kept.</p>}
            {changes.map((c, i) => (
              <div key={i} className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-200">
                  <CheckCircle2 size={13} /> {c.title}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{c.detail}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              <ShieldCheck size={15} className="text-teal-300" /> Differential verification
            </h2>
            <span className="font-mono text-[11px] uppercase text-slate-500">{verification?.status}</span>
          </div>
          <div className="space-y-1.5 p-3 text-xs">
            {(verification?.attempts || []).map((a, i) => (
              <div key={i} className="flex items-start gap-2">
                <AttemptIcon passed={a.passed} />
                <div>
                  <span className="font-semibold text-slate-200">{a.label}:</span>{' '}
                  <span className="text-slate-400">{a.detail}</span>
                </div>
              </div>
            ))}
            {verification?.original?.ok && (
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="rounded-lg bg-black/25 p-2">
                  <div className="text-slate-500">original</div>
                  <div className="text-red-300">{fmtMs(verification.original.time_ms)} · {verification.original.reps} runs</div>
                </div>
                <div className="rounded-lg bg-black/25 p-2">
                  <div className="text-slate-500">optimized</div>
                  <div className="text-emerald-300">
                    {fmtMs(verification.optimized?.time_ms)} · {verification.optimized?.reps ?? '-'} runs
                  </div>
                </div>
              </div>
            )}
            {verification?.original?.output_preview?.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300">Observed output (both versions)</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10.5px] text-slate-300">
                  {verification.original.output_preview.join('\n')}
                </pre>
              </details>
            )}
            {sql?.original_plan && (
              <details className="mt-1" open>
                <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300">
                  <Database size={11} /> SQLite query plans
                </summary>
                <div className="mt-1 grid gap-2 font-mono text-[10.5px] md:grid-cols-2">
                  <pre className="overflow-auto rounded-lg bg-red-500/[0.06] p-2 text-red-200">{(sql.original_plan || []).flat().join('\n')}</pre>
                  <pre className="overflow-auto rounded-lg bg-emerald-500/[0.06] p-2 text-emerald-200">{(sql.optimized_plan || []).flat().join('\n')}</pre>
                </div>
                {sql.index_build_ms ? (
                  <div className="mt-1 text-[10.5px] text-slate-500">One-time index build: {fmtMs(sql.index_build_ms)} (excluded from per-query time)</div>
                ) : null}
              </details>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
