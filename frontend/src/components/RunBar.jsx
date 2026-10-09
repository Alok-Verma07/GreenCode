import { Play, Square, Undo2, ChevronDown } from 'lucide-react';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Workspace toolbar: benchmark tabs, language and the pipeline trigger. */
export default function RunBar({
  benchmarks,
  benchmarkId,
  onSelectBenchmark,
  languages,
  language,
  onLanguageChange,
  running,
  canRun,
  onRun,
  onStop,
  showReset,
  onReset,
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-line px-4 py-2 md:h-12 md:flex-row md:items-center md:gap-4 md:py-0">
      <nav className="-mb-px flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto no-scrollbar md:h-full" aria-label="Benchmarks">
        {benchmarks.map((b) => {
          const on = b.id === benchmarkId;
          return (
            <button
              key={b.id}
              type="button"
              disabled={running}
              onClick={() => onSelectBenchmark(b.id)}
              title={`${b.tagline} - ${b.description}`}
              className={`relative flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors disabled:cursor-not-allowed md:h-auto md:rounded-none ${
                on ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {b.name}
              {on && <span className="absolute inset-x-2.5 bottom-0 h-px bg-zinc-100" />}
            </button>
          );
        })}
        {!benchmarkId && (
          <span className="relative flex h-9 shrink-0 items-center px-2.5 text-[13px] text-zinc-100 md:h-auto">
            Custom
            <span className="absolute inset-x-2.5 bottom-0 h-px bg-zinc-100" />
          </span>
        )}
      </nav>

      <div className="flex items-center gap-2">
        <label className="relative">
          <span className="sr-only">Language</span>
          <select
            value={language}
            disabled={running}
            onChange={(e) => onLanguageChange(e.target.value)}
            className="h-8 appearance-none rounded-md border border-line bg-canvas pl-3 pr-8 text-[13px] text-zinc-200 outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:opacity-40"
          >
            {languages.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        </label>

        {showReset && (
          <button type="button" className="btn-secondary" onClick={onReset} title="Discard edits to the optimized code">
            <Undo2 size={14} /> Reset
          </button>
        )}

        {running ? (
          <button type="button" className="btn-secondary min-w-[136px] text-rose-300" onClick={onStop}>
            <Square size={12} fill="currentColor" /> Stop
          </button>
        ) : (
          <button type="button" className="btn-primary min-w-[136px]" onClick={onRun} disabled={!canRun} title={`Run pipeline (${IS_MAC ? '⌘' : 'Ctrl'}+Enter)`}>
            <Play size={13} fill="currentColor" /> Run Pipeline
            <span className="kbd ml-1 hidden sm:inline">{IS_MAC ? '⌘↵' : 'Ctrl ↵'}</span>
          </button>
        )}
      </div>
    </div>
  );
}
