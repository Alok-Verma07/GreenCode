import { useEffect, useRef } from 'react';
import {
  ScanSearch,
  ListOrdered,
  Sparkles,
  ShieldCheck,
  Leaf,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CircleDashed,
  Terminal,
  XCircle,
} from 'lucide-react';

export const STAGES = [
  { id: 'profiler', name: 'Profiler', role: 'Syntax tree · Big-O bottlenecks', icon: ScanSearch, color: 'text-sky-300' },
  { id: 'strategist', name: 'Strategist', role: 'Ranks by carbon & memory impact', icon: ListOrdered, color: 'text-violet-300' },
  { id: 'refactorer', name: 'Refactorer', role: 'LLaMA-3.3-70B · offline rule fallback', icon: Sparkles, color: 'text-amber-300' },
  { id: 'verifier', name: 'Verifier', role: 'Differential execution · 1 retry', icon: ShieldCheck, color: 'text-teal-300' },
  { id: 'accountant', name: 'Carbon Accountant', role: 'SCI = (E × I) + M per R', icon: Leaf, color: 'text-emerald-300' },
];

function StageIcon({ status }) {
  if (status === 'running') return <Loader2 size={16} className="animate-spin text-emerald-300" />;
  if (status === 'done') return <CheckCircle2 size={16} className="text-emerald-400" />;
  if (status === 'warning') return <AlertTriangle size={16} className="text-amber-400" />;
  if (status === 'error') return <XCircle size={16} className="text-red-400" />;
  return <CircleDashed size={16} className="text-slate-600" />;
}

const LEVEL_COLOR = { info: 'text-slate-300', warn: 'text-amber-300', error: 'text-red-300' };

export default function PipelineStream({ stages, logs, running, error }) {
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.length]);

  const doneCount = STAGES.filter((s) => ['done', 'warning'].includes(stages[s.id].status)).length;

  return (
    <section className="panel flex h-[600px] flex-col xl:h-[571px]">
      <div className="panel-header">
        <h2 className="panel-title">
          <Terminal size={15} className="text-emerald-400" /> Live Agent Pipeline
        </h2>
        <span className="font-mono text-[11px] text-slate-500">
          {running ? <span className="shimmer-text font-semibold">streaming…</span> : `${doneCount}/5 stages`}
        </span>
      </div>

      <div className="h-1 w-full bg-ink-800">
        <div
          className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500"
          style={{ width: `${(doneCount / STAGES.length) * 100}%` }}
        />
      </div>

      <ol className="space-y-1.5 p-3">
        {STAGES.map((s, idx) => {
          const st = stages[s.id];
          const Icon = s.icon;
          const active = st.status === 'running';
          return (
            <li
              key={s.id}
              className={`relative flex items-start gap-3 rounded-xl border px-3 py-2 transition ${
                active
                  ? 'border-emerald-500/40 bg-emerald-500/[0.06] animate-pulse-ring'
                  : st.status === 'idle'
                    ? 'border-transparent bg-white/[0.015]'
                    : 'border-white/[0.06] bg-white/[0.025]'
              }`}
            >
              <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink-800 ${s.color}`}>
                <Icon size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-600">0{idx + 1}</span>
                  <span className="text-sm font-semibold text-slate-100">{s.name}</span>
                  {st.elapsed != null && (
                    <span className="ml-auto font-mono text-[10px] text-slate-500">{st.elapsed.toFixed(0)} ms</span>
                  )}
                </div>
                <p className="truncate text-[11px] text-slate-500" title={st.summary || s.role}>
                  {st.summary || s.role}
                </p>
              </div>
              <div className="mt-1">
                <StageIcon status={st.status} />
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-black/40">
        <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3 py-1.5">
          <span className="h-2 w-2 rounded-full bg-red-500/70" />
          <span className="h-2 w-2 rounded-full bg-amber-500/70" />
          <span className="h-2 w-2 rounded-full bg-emerald-500/70" />
          <span className="ml-2 font-mono text-[10px] text-slate-500">agent.log</span>
        </div>
        <div ref={logRef} className="log-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 && !error && (
            <p className="text-slate-600">
              $ Pick a benchmark or paste code, then press <span className="text-emerald-400">Run pipeline</span>.
            </p>
          )}
          {logs.map((l, i) => {
            const stage = STAGES.find((s) => s.id === l.stage);
            return (
              <div key={i} className="animate-fade-in whitespace-pre-wrap break-words">
                <span className={`${stage?.color || 'text-slate-400'} opacity-80`}>[{l.stage}]</span>{' '}
                <span className={LEVEL_COLOR[l.level] || LEVEL_COLOR.info}>{l.message}</span>
              </div>
            );
          })}
          {error && <div className="mt-1 text-red-400">✗ {error}</div>}
          {running && <span className="inline-block h-3 w-1.5 animate-pulse bg-emerald-400 align-middle" />}
        </div>
      </div>
    </section>
  );
}
