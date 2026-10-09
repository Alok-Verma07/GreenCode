import { FlaskConical, Calculator } from 'lucide-react';

/** Explicit provenance badge shown on every metric. */
export function BasisBadge({ basis, title }) {
  const measured = basis === 'measured';
  const tip =
    title ||
    (measured
      ? 'Measured: derived from a real differential execution of both versions in a sandboxed subprocess'
      : 'Estimated: static model from the syntax tree - the code could not be executed stand-alone');
  return (
    <span
      title={tip}
      className={`chip shrink-0 cursor-help py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        measured
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
      }`}
    >
      {measured ? <FlaskConical size={11} /> : <Calculator size={11} />}
      {measured ? 'Measured' : 'Estimated'}
    </span>
  );
}

const SEVERITY_STYLES = {
  high: 'border-red-500/40 bg-red-500/10 text-red-300',
  medium: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  low: 'border-rose-400/30 bg-rose-400/5 text-rose-200',
};

export function SeverityBadge({ severity }) {
  return (
    <span className={`chip py-0.5 text-[10px] font-semibold uppercase tracking-wider ${SEVERITY_STYLES[severity] || ''}`}>
      {severity}
    </span>
  );
}

export function StatusDot({ state }) {
  const color =
    state === 'online' ? 'bg-emerald-400' : state === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-red-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}
