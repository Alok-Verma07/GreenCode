/** Provenance marker shown on every metric. */
export function BasisBadge({ basis, title }) {
  const measured = basis === 'measured';
  const tip =
    title ||
    (measured
      ? 'Measured: derived from a real differential execution of both versions in a sandboxed subprocess'
      : 'Estimated: static model from the syntax tree - the code could not be executed stand-alone');
  return (
    <span title={tip} className="inline-flex shrink-0 cursor-help items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-zinc-500">
      <span className={`h-1.5 w-1.5 rounded-full ${measured ? 'bg-zinc-300' : 'border border-amber-400'}`} />
      {measured ? 'Measured' : 'Estimated'}
    </span>
  );
}

const SEVERITY_DOT = { high: 'bg-crimson', medium: 'bg-orange-400', low: 'bg-zinc-500' };

export function SeverityBadge({ severity }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs capitalize text-zinc-300">
      <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[severity] || 'bg-zinc-500'}`} />
      {severity}
    </span>
  );
}

export function StatusDot({ state }) {
  const color = state === 'online' ? 'bg-emerald-500' : state === 'checking' ? 'bg-amber-400' : 'bg-crimson';
  return (
    <span className="relative inline-flex h-2 w-2">
      {state !== 'offline' && <span className={`absolute inset-0 animate-ping rounded-full opacity-40 ${color}`} />}
      <span className={`relative inline-block h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}
