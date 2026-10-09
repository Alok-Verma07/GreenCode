import { Check, X, Minus } from 'lucide-react';
import { SeverityBadge } from './Badge.jsx';
import { fmtMs } from '../lib/carbon.js';

function AttemptIcon({ passed }) {
  if (passed === true) return <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" strokeWidth={2.5} />;
  if (passed === false) return <X size={13} className="mt-0.5 shrink-0 text-rose-400" strokeWidth={2.5} />;
  return <Minus size={13} className="mt-0.5 shrink-0 text-amber-300" strokeWidth={2.5} />;
}

export default function FindingsPanel({ result, verification }) {
  if (!result) return null;
  const ranking = result.ranking || [];
  const changes = result.changes || [];
  const sql = result.measurements?.sql;

  return (
    <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="surface overflow-hidden">
        <div className="section-header">
          <h2 className="section-title">Bottlenecks</h2>
          <span className="font-mono text-[11px] text-zinc-500">
            <span className="text-rose-400">{result.profile.original.complexity}</span>
            <span className="px-1.5 text-zinc-600">→</span>
            <span className="text-emerald-400">{result.profile.optimized.complexity}</span>
          </span>
        </div>
        {ranking.length === 0 ? (
          <p className="p-5 text-xs text-zinc-500">No bottlenecks detected. The code already looks efficient.</p>
        ) : (
          <div className="overflow-x-auto thin-scroll">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-line">
                  {['#', 'Bottleneck', 'Line', 'Severity', 'Big-O', 'Carbon share', 'Memory'].map((h, i) => (
                    <th key={h} className={`micro h-9 font-medium ${i === 0 ? 'pl-5 pr-2' : 'px-3'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => (
                  <tr key={r.finding_id} className="border-b border-line/60 align-top last:border-0 hover:bg-elevated/50">
                    <td className="num py-3 pl-5 pr-2 font-mono text-zinc-600">{r.rank}</td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-zinc-100">{r.title}</div>
                      <div className="mt-0.5 max-w-[460px] text-zinc-500">{r.action}</div>
                    </td>
                    <td className="num px-3 py-3 font-mono text-zinc-400">{r.line}</td>
                    <td className="px-3 py-3"><SeverityBadge severity={r.severity} /></td>
                    <td className="px-3 py-3 font-mono text-zinc-300">{r.complexity}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-elevated">
                          <div className="h-full rounded-full bg-crimson" style={{ width: `${r.carbon_share_pct}%` }} />
                        </div>
                        <span className="num font-mono text-zinc-300">{r.carbon_share_pct}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 pr-5 text-zinc-500">{r.memory_impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="surface overflow-hidden">
          <div className="section-header">
            <h2 className="section-title">Applied rewrites</h2>
            <span className="truncate font-mono text-[11px] text-zinc-500">
              {result.engine.type === 'llm' ? `groq · ${result.engine.model}` : 'ast rule engine'}
            </span>
          </div>
          {result.engine.fallback_reason && result.engine.type !== 'llm' && (
            <div className="border-b border-line px-5 py-2.5 text-xs text-amber-300">Fallback: {result.engine.fallback_reason}</div>
          )}
          {changes.length === 0 ? (
            <p className="px-5 py-4 text-xs text-zinc-500">No rewrite applied. Original code kept.</p>
          ) : (
            <ul className="divide-y divide-line">
              {changes.map((c, i) => (
                <li key={i} className="flex gap-3 px-5 py-3">
                  <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" strokeWidth={2.5} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-100">{c.title}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="surface overflow-hidden">
          <div className="section-header">
            <h2 className="section-title">Differential verification</h2>
            <span className="font-mono text-[11px] uppercase text-zinc-500">{verification?.status}</span>
          </div>
          <div className="space-y-2 px-5 py-4 text-xs">
            {(verification?.attempts || []).map((a, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <AttemptIcon passed={a.passed} />
                <div className="min-w-0">
                  <span className="font-medium text-zinc-200">{a.label}</span>
                  <span className="text-zinc-500"> · {a.detail}</span>
                </div>
              </div>
            ))}
            {verification?.original?.ok && (
              <div className="num mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line font-mono text-[11px]">
                <div className="bg-canvas px-3 py-2">
                  <div className="text-zinc-600">original</div>
                  <div className="text-zinc-300">{fmtMs(verification.original.time_ms)} · {verification.original.reps} runs</div>
                </div>
                <div className="bg-canvas px-3 py-2">
                  <div className="text-zinc-600">optimized</div>
                  <div className="text-zinc-100">{fmtMs(verification.optimized?.time_ms)} · {verification.optimized?.reps ?? '-'} runs</div>
                </div>
              </div>
            )}
            {verification?.original?.output_preview?.length > 0 && (
              <details className="group pt-1">
                <summary className="cursor-pointer list-none text-zinc-500 transition-colors hover:text-zinc-200">Observed output</summary>
                <pre className="thin-scroll mt-2 max-h-40 overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-[11px] text-zinc-400">
                  {verification.original.output_preview.join('\n')}
                </pre>
              </details>
            )}
            {sql?.original_plan && (
              <details className="pt-1" open>
                <summary className="cursor-pointer list-none text-zinc-500 transition-colors hover:text-zinc-200">SQLite query plans</summary>
                <div className="mt-2 grid gap-2 font-mono text-[10.5px] md:grid-cols-2">
                  <pre className="thin-scroll overflow-auto rounded-md border border-line bg-canvas p-2.5 text-zinc-500">{(sql.original_plan || []).flat().join('\n')}</pre>
                  <pre className="thin-scroll overflow-auto rounded-md border border-line bg-canvas p-2.5 text-zinc-300">{(sql.optimized_plan || []).flat().join('\n')}</pre>
                </div>
                {sql.index_build_ms ? (
                  <div className="mt-1.5 text-[11px] text-zinc-600">One-time index build {fmtMs(sql.index_build_ms)}, excluded from per-query time</div>
                ) : null}
              </details>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
