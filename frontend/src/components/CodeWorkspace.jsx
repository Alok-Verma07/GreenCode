import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Copy, Check, RefreshCw, Loader2 } from 'lucide-react';

const EDITOR_OPTIONS = {
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  fontSize: 12.5,
  lineHeight: 20,
  minimap: { enabled: false },
  glyphMargin: true,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 6,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: 'line',
  smoothScrolling: true,
  padding: { top: 12, bottom: 12 },
  tabSize: 4,
  wordWrap: 'off',
  overviewRulerBorder: false,
  overviewRulerLanes: 1,
  hideCursorInOverviewRuler: true,
  hover: { delay: 150 },
  stickyScroll: { enabled: false },
  guides: { indentation: true },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
};

const EXT = { python: 'py', javascript: 'js', sql: 'sql' };

/** Keeps a Monaco decorations collection in sync with annotation props. */
function useDecorations(editorRef, monacoRef, annotations, kind) {
  const collection = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    const decorations = (annotations || [])
      .filter((a) => a.line >= 1 && a.line <= lineCount)
      .map((a) => {
        const cls = kind === 'original' ? `gc-line-${a.severity || 'high'}` : 'gc-line-opt';
        const glyph = kind === 'original' ? `gc-glyph-${a.severity || 'high'}` : 'gc-glyph-opt';
        return {
          range: new monaco.Range(a.line, 1, Math.min(a.end_line || a.line, lineCount), 1),
          options: {
            isWholeLine: true,
            className: cls,
            glyphMarginClassName: glyph,
            hoverMessage: { value: a.message },
            glyphMarginHoverMessage: { value: a.message },
            overviewRuler: {
              color: kind === 'original' ? '#e11d48' : '#10b981',
              position: monaco.editor.OverviewRulerLane.Left,
            },
          },
        };
      });
    if (!collection.current) collection.current = editor.createDecorationsCollection(decorations);
    else collection.current.set(decorations);
  }, [annotations, kind, ready, editorRef, monacoRef]);

  return () => setReady(true);
}

const VERIFY_STATE = {
  passed: { text: 'Verified equivalent', dot: 'bg-emerald-500', cls: 'text-emerald-400' },
  failed: { text: 'Verification failed', dot: 'bg-crimson', cls: 'text-rose-400' },
  estimated: { text: 'Static check only', dot: 'bg-amber-400', cls: 'text-amber-300' },
  stale: { text: 'Edited · re-verify', dot: 'bg-amber-400', cls: 'text-amber-300' },
};

function VerificationState({ status }) {
  if (!status) return null;
  const m = VERIFY_STATE[status] || VERIFY_STATE.estimated;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} /> {m.text}
    </span>
  );
}

function PaneHeader({ name, children, meta }) {
  return (
    <div className="flex h-10 items-center justify-between gap-2 border-b border-line bg-surface px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate font-mono text-xs text-zinc-200">{name}</span>
        {meta}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

const editorLoading = <div className="grid h-full place-items-center font-mono text-xs text-zinc-600">Loading editor…</div>;

export default function CodeWorkspace({
  toolbar,
  language,
  original,
  onOriginalChange,
  optimized,
  onOptimizedChange,
  annotations,
  findingsCount,
  changesCount,
  complexity,
  engineLabel,
  verificationStatus,
  onReverify,
  reverifying,
  running,
  hasResult,
}) {
  const origEditor = useRef(null);
  const origMonaco = useRef(null);
  const optEditor = useRef(null);
  const optMonaco = useRef(null);
  const [copied, setCopied] = useState(false);

  const markOrigReady = useDecorations(origEditor, origMonaco, annotations?.original, 'original');
  const markOptReady = useDecorations(optEditor, optMonaco, annotations?.optimized, 'optimized');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(optimized);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  };

  const ext = EXT[language] || 'txt';
  const lines = original ? original.split('\n').length : 0;

  return (
    <section className="surface flex flex-col overflow-hidden">
      {toolbar}

      <div className="grid lg:grid-cols-2">
        <div className="min-w-0">
          <PaneHeader
            name={`original.${ext}`}
            meta={
              findingsCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs text-rose-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-crimson" />
                  {findingsCount} hotspot{findingsCount === 1 ? '' : 's'}
                </span>
              )
            }
          />
          <div className="h-[360px] lg:h-[480px]">
            <Editor
              language={language}
              theme="greencode-dark"
              value={original}
              onChange={(v) => onOriginalChange(v ?? '')}
              onMount={(editor, monaco) => {
                origEditor.current = editor;
                origMonaco.current = monaco;
                markOrigReady();
              }}
              options={{ ...EDITOR_OPTIONS, readOnly: running }}
              loading={editorLoading}
            />
          </div>
        </div>

        <div className="min-w-0 border-t border-line lg:border-l lg:border-t-0">
          <PaneHeader
            name={`optimized.${ext}`}
            meta={
              changesCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {changesCount} change{changesCount === 1 ? '' : 's'}
                </span>
              )
            }
          >
            <button
              type="button"
              className="btn h-7 px-2 text-xs text-zinc-400 hover:bg-elevated hover:text-zinc-100"
              onClick={onReverify}
              disabled={!hasResult || reverifying || running}
              title="Re-run the differential execution test on the (edited) optimized code"
            >
              {reverifying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Re-verify
            </button>
            <button type="button" className="btn-icon" onClick={copy} disabled={!optimized} title="Copy optimized code" aria-label="Copy optimized code">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </PaneHeader>
          <div className="relative h-[360px] lg:h-[480px]">
            {!hasResult && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-canvas">
                {running ? (
                  <span className="inline-flex items-center gap-2 font-mono text-xs text-zinc-400">
                    <Loader2 size={13} className="animate-spin" /> Agents running…
                  </span>
                ) : (
                  <span className="text-xs text-zinc-600">Run the pipeline to generate a verified rewrite</span>
                )}
              </div>
            )}
            <Editor
              language={language}
              theme="greencode-dark"
              value={optimized}
              onChange={(v) => onOptimizedChange(v ?? '')}
              onMount={(editor, monaco) => {
                optEditor.current = editor;
                optMonaco.current = monaco;
                markOptReady();
              }}
              options={{ ...EDITOR_OPTIONS, readOnly: running || !hasResult }}
              loading={editorLoading}
            />
          </div>
        </div>
      </div>

      <div className="flex h-8 items-center gap-4 overflow-x-auto border-t border-line px-4 font-mono text-[11px] text-zinc-500 no-scrollbar">
        <span className="shrink-0 uppercase">{language}</span>
        <span className="shrink-0">{lines} lines</span>
        {complexity && (
          <span className="shrink-0">
            <span className="text-rose-400">{complexity.from}</span>
            <span className="px-1.5 text-zinc-600">→</span>
            <span className={complexity.to !== complexity.from ? 'text-emerald-400' : 'text-zinc-400'}>{complexity.to}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-4">
          {engineLabel && <span>{engineLabel}</span>}
          <VerificationState status={hasResult ? verificationStatus : null} />
        </span>
      </div>
    </section>
  );
}
