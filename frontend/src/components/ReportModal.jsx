import { useEffect, useMemo, useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { buildReportData, downloadAuditPdf } from '../lib/report.js';
import { GRADE_COLORS } from '../lib/carbon.js';

function Section({ title, children }) {
  return (
    <section className="border-t border-line py-6 first:border-0 first:pt-0">
      <h3 className="micro mb-3">{title}</h3>
      {children}
    </section>
  );
}

const STATUS_TONE = { passed: 'text-emerald-400', failed: 'text-rose-400' };

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

  const diffPreview = data.diffRows.filter((r) => r.left?.type !== 'same' || r.right?.type !== 'same').slice(0, 40);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Green Software Audit Report"
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-black/60" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-zinc-100">Green Software Audit</h2>
            <p className="truncate font-mono text-[11px] text-zinc-500">{data.title} · {data.language} · {data.date.toLocaleString()}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn-primary" onClick={download} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download PDF
            </button>
            <button type="button" className="btn-icon h-8 w-8" onClick={onClose} aria-label="Close report">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="thin-scroll overflow-y-auto px-5 py-6 sm:px-8">
          <Section title="Executive summary">
            <div className="mb-4 flex items-center gap-6">
              {[['Before', data.scores.original], ['After', data.scores.optimized]].map(([label, s], i) => (
                <div key={label} className="flex items-center gap-6">
                  {i === 1 && <span className="text-zinc-600">→</span>}
                  <div>
                    <div className="text-4xl font-semibold leading-none tracking-tight" style={{ color: GRADE_COLORS[s.grade] }}>{s.grade}</div>
                    <div className="num mt-1.5 font-mono text-[11px] text-zinc-500">{label} · {s.score}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="max-w-3xl text-[13px] leading-relaxed text-zinc-300">{data.summary}</p>
          </Section>

          <Section title="Verified metrics">
            <div className="thin-scroll overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="bg-canvas">
                  <tr>{['Metric', 'Original', 'Optimized', 'Change', 'Basis'].map((h) => <th key={h} className="micro h-9 px-3 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="num">
                  {data.metrics.map((r) => (
                    <tr key={r[0]} className="border-t border-line">
                      <td className="px-3 py-2 text-zinc-300">{r[0]}</td>
                      <td className="px-3 py-2 font-mono text-zinc-500">{r[1]}</td>
                      <td className="px-3 py-2 font-mono text-zinc-100">{r[2]}</td>
                      <td className="px-3 py-2 font-mono text-zinc-300">{r[3]}</td>
                      <td className={`px-3 py-2 font-mono text-[10.5px] uppercase ${r[4] === 'measured' ? 'text-zinc-400' : 'text-amber-300'}`}>{r[4]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Differential verification">
            <p className="text-[13px] text-zinc-300">
              <span className={`font-mono text-xs uppercase ${STATUS_TONE[data.verification.status] || 'text-amber-300'}`}>{data.verification.status}</span>
              <span className="text-zinc-600"> · </span>
              {data.verification.detail}
            </p>
          </Section>

          <Section title={`Side-by-side diff · +${data.diffStats.added} −${data.diffStats.removed}`}>
            <div className="thin-scroll grid grid-cols-2 overflow-x-auto rounded-md border border-line bg-canvas font-mono text-[11px]">
              {diffPreview.map((r, i) => (
                <div key={i} className="contents">
                  <div className={`truncate px-2 py-0.5 ${r.left?.type === 'del' ? 'bg-crimson/10 text-rose-200' : 'text-zinc-600'}`}>
                    <span className="mr-2 inline-block w-6 text-right text-zinc-700">{r.left?.n ?? ''}</span>
                    {r.left?.text ?? ''}
                  </div>
                  <div className={`truncate border-l border-line px-2 py-0.5 ${r.right?.type === 'add' ? 'bg-emerald-500/10 text-emerald-200' : 'text-zinc-600'}`}>
                    <span className="mr-2 inline-block w-6 text-right text-zinc-700">{r.right?.n ?? ''}</span>
                    {r.right?.text ?? ''}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-zinc-600">Changed lines only. The PDF contains the full diff with context.</p>
          </Section>

          <Section title="Carbon payback">
            <dl className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
              {data.payback.map(([k, v]) => (
                <div key={k} className="bg-surface px-4 py-3">
                  <dt className="text-[11px] text-zinc-500">{k}</dt>
                  <dd className="num mt-0.5 text-[13px] text-zinc-200">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Methodology & disclosure">
            <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-zinc-500 marker:text-zinc-700">
              {data.methodology.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
