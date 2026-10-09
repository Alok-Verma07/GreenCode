import { useEffect, useRef } from 'react';
import { Check, X, AlertTriangle } from 'lucide-react';

export const STAGES = [
  { id: 'profiler', name: 'Profiler', role: 'Syntax tree · Big-O bottlenecks' },
  { id: 'strategist', name: 'Strategist', role: 'Ranks by carbon & memory impact' },
  { id: 'refactorer', name: 'Refactorer', role: 'LLaMA-3.3-70B · offline rule fallback' },
  { id: 'verifier', name: 'Verifier', role: 'Differential execution · 1 retry' },
  { id: 'accountant', name: 'Accountant', role: 'SCI = (E × I) + M per R' },
];

const DONE = ['done', 'warning'];

function StepNode({ status }) {
  if (status === 'running') {
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full border border-zinc-500 bg-canvas">
        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-zinc-600 border-t-zinc-100" />
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-zinc-100 text-zinc-950">
        <Check size={12} strokeWidth={3} />
      </span>
    );
  }
  if (status === 'warning') {
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-amber-400 text-zinc-950">
        <AlertTriangle size={11} strokeWidth={2.75} />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-crimson text-white">
        <X size={12} strokeWidth={3} />
      </span>
    );
  }
  return <span className="grid h-5 w-5 place-items-center rounded-full border border-line-strong bg-canvas" />;
}

function TimeBadge({ status, elapsed }) {
  if (status === 'running') {
    return <span className="rounded border border-line-strong px-1.5 font-mono text-[10.5px] leading-5 text-zinc-300">running</span>;
  }
  if (elapsed == null) return <span className="font-mono text-[10.5px] leading-5 text-zinc-700">- ms</span>;
  return (
    <span className="num rounded border border-line bg-elevated px-1.5 font-mono text-[10.5px] leading-5 text-zinc-300">
      {elapsed < 10 ? elapsed.toFixed(1) : elapsed.toFixed(0)} ms
    </span>
  );
}

const LEVEL_COLOR = { info: 'text-zinc-400', warn: 'text-amber-300', error: 'text-rose-400' };

export default function PipelineStream({ stages, logs, running, error }) {
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.length]);

  const doneCount = STAGES.filter((s) => DONE.includes(stages[s.id].status)).length;
  const totalMs = STAGES.reduce((sum, s) => sum + (stages[s.id].elapsed || 0), 0);

  return (
    <section className="surface flex h-[520px] flex-col overflow-hidden xl:absolute xl:inset-0 xl:h-auto">
      <div className="section-header">
        <h2 className="section-title">Agent Timeline</h2>
        <span className="num font-mono text-[11px] text-zinc-500">
          {running ? (
            <span className="text-zinc-300">{doneCount}/5 · streaming</span>
          ) : doneCount ? (
            `${doneCount}/5 · ${totalMs < 1000 ? `${totalMs.toFixed(0)} ms` : `${(totalMs / 1000).toFixed(2)} s`}`
          ) : (
            'idle'
          )}
        </span>
      </div>

      <ol className="px-4 pt-4">
        {STAGES.map((s, idx) => {
          const st = stages[s.id];
          const last = idx === STAGES.length - 1;
          const active = st.status === 'running';
          return (
            <li key={s.id} className="relative flex gap-3 pb-4 last:pb-3">
              {!last && (
                <span
                  className={`absolute left-[9.5px] top-6 bottom-1 w-px transition-colors duration-300 ${
                    DONE.includes(st.status) ? 'bg-zinc-500' : 'bg-line'
                  }`}
                />
              )}
              <div className="relative z-10 pt-px">
                <StepNode status={st.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-[13px] font-medium ${st.status === 'idle' ? 'text-zinc-500' : 'text-zinc-100'}`}>{s.name}</span>
                  <span className="ml-auto">
                    <TimeBadge status={st.status} elapsed={st.elapsed} />
                  </span>
                </div>
                <p className={`mt-0.5 truncate text-xs ${active ? 'text-zinc-400' : 'text-zinc-600'}`} title={st.summary || s.role}>
                  {st.summary || s.role}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex min-h-0 flex-1 flex-col border-t border-line">
        <div className="flex h-9 shrink-0 items-center justify-between px-4">
          <span className="micro">Logs</span>
          <span className="num font-mono text-[10.5px] text-zinc-600">{logs.length} lines</span>
        </div>
        <div ref={logRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-canvas px-4 py-2.5 font-mono text-[11px] leading-[1.7]">
          {logs.length === 0 && !error && <p className="text-zinc-600">Waiting for a run.</p>}
          {logs.map((l, i) => (
            <div key={i} className="flex animate-fade-in gap-2">
              <span className="w-[74px] shrink-0 truncate text-zinc-600">{l.stage}</span>
              <span className={`min-w-0 whitespace-pre-wrap break-words ${LEVEL_COLOR[l.level] || LEVEL_COLOR.info}`}>{l.message}</span>
            </div>
          ))}
          {error && <div className="mt-1 text-rose-400">error  {error}</div>}
          {running && <span className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-zinc-400 align-middle" />}
        </div>
      </div>
    </section>
  );
}
