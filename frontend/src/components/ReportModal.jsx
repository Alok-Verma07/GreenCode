import { useEffect, useMemo, useState } from 'react';
import { X, Download, FileText, Loader2, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { buildReportData, downloadAuditPdf } from '../lib/report.js';
import { GRADE_COLORS } from '../lib/carbon.js';

function Section({ title, children }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-white">
        <span className="h-3 w-1 rounded bg-emerald-400" /> {title}
      </h3>
      {children}
    </section>
  );
}

export default function ReportModal({ open, onClose, ...props }) {
  const [busy, setBusy] = useState(false);
  const data = useMemo(() => (open ? buildReportData(props) : null), [open, props]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !data) return null;

  const download = () => {
    setBusy(true);
    // Let the spinner paint before the (synchronous) PDF render.
    setTimeout(() => {
      try {
        downloadAuditPdf(data, props.ctx.currency);
      } finally {
        setBusy(false);
      }
    }, 30);
  };

  const StatusIcon = data.verification.status === 'passed' ? ShieldCheck : data.verification.status === 'failed' ? ShieldAlert : ShieldQuestion;
  const diffPreview = data.diffRows.filter((r) => r.left?.type !== 'same' || r.right?.type !== 'same').slice(0, 40);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label="Green Software Audit Report">
      <div className="panel flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header bg-ink-850">
          <h2 className="panel-title text-base">
            <FileText size={17} className="text-emerald-400" /> Green Software Audit Report
          </h2>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary py-1.5" onClick={download} disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download PDF
            </button>
            <button type="button" className="btn-ghost px-2 py-1.5" onClick={onClose} aria-label="Close report">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-6">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-transparent p-5">
            <div>
              <div className="label text-emerald-400">GreenCode AI · {data.language}</div>
              <div className="mt-1 text-xl font-extrabold text-white">{data.title}</div>
              <div className="text-xs text-slate-400">{data.date.toLocaleString()}</div>
            </div>
            <div className="flex items-center gap-3">
              {[['Before', data.scores.original], ['After', data.scores.optimized]].map(([label, s]) => (
                <div key={label} className="rounded-xl bg-black/30 px-4 py-2 text-center">
                  <div className="text-3xl font-black" style={{ color: GRADE_COLORS[s.grade] }}>{s.grade}</div>
                  <div className="label">{label} · {s.score}</div>
                </div>
              ))}
            </div>
          </div>

          <Section title="Executive summary">
            <p className="text-sm leading-relaxed text-slate-300">{data.summary}</p>
          </Section>

          <Section title="Verified metrics">
            <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
              <table className="w-full text-left text-xs">
                <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{['Metric', 'Original', 'Optimized', 'Change', 'Basis'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {data.metrics.map((r) => (
                    <tr key={r[0]} className="border-t border-white/[0.04]">
                      <td className="px-3 py-1.5 text-slate-300">{r[0]}</td>
                      <td className="px-3 py-1.5 font-mono text-red-300">{r[1]}</td>
                      <td className="px-3 py-1.5 font-mono text-emerald-300">{r[2]}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-200">{r[3]}</td>
                      <td className={`px-3 py-1.5 text-[10px] font-bold uppercase ${r[4] === 'measured' ? 'text-emerald-400' : 'text-amber-400'}`}>{r[4]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Differential verification">
            <div className="flex items-start gap-2 text-sm text-slate-300">
              <StatusIcon size={18} className={data.verification.status === 'passed' ? 'text-emerald-400' : 'text-amber-400'} />
              <span>
                <b className="uppercase">{data.verification.status}</b> - {data.verification.detail}
              </span>
            </div>
          </Section>

          <Section title={`Side-by-side diff (+${data.diffStats.added} / −${data.diffStats.removed})`}>
            <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-white/[0.06] font-mono text-[11px]">
              {diffPreview.map((r, i) => (
                <div key={i} className="contents">
                  <div className={`truncate px-2 py-0.5 ${r.left?.type === 'del' ? 'bg-red-500/10 text-red-200' : 'text-slate-500'}`}>
                    <span className="mr-2 inline-block w-6 text-right text-slate-600">{r.left?.n ?? ''}</span>
                    {r.left?.text ?? ''}
                  </div>
                  <div className={`truncate border-l border-white/[0.06] px-2 py-0.5 ${r.right?.type === 'add' ? 'bg-emerald-500/10 text-emerald-200' : 'text-slate-500'}`}>
                    <span className="mr-2 inline-block w-6 text-right text-slate-600">{r.right?.n ?? ''}</span>
                    {r.right?.text ?? ''}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Preview shows changed lines; the PDF contains the full diff with context.</p>
          </Section>

          <Section title="Carbon payback analysis">
            <dl className="grid gap-2 sm:grid-cols-2">
              {data.payback.map(([k, v]) => (
                <div key={k} className="rounded-lg bg-black/25 px-3 py-2">
                  <dt className="label">{k}</dt>
                  <dd className="mt-0.5 text-sm text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Methodology & disclosure">
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-400">
              {data.methodology.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
