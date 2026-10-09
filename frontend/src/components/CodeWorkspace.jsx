import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Code2, Sparkles, Copy, Check, RefreshCw, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2 } from 'lucide-react';

const EDITOR_OPTIONS = {
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  fontSize: 12.5,
  lineHeight: 19,
  minimap: { enabled: false },
  glyphMargin: true,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: 'line',
  smoothScrolling: true,
  padding: { top: 10, bottom: 10 },
  tabSize: 4,
  wordWrap: 'off',
  overviewRulerBorder: false,
  hover: { delay: 150 },
  stickyScroll: { enabled: false },
};

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
              color: kind === 'original' ? '#ef4444' : '#10b981',
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

function VerificationPill({ status }) {
  if (!status) return null;
  const map = {
    passed: { icon: ShieldCheck, text: 'Verified equivalent', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
    failed: { icon: ShieldAlert, text: 'Verification failed', cls: 'border-red-500/40 bg-red-500/10 text-red-300' },
    estimated: { icon: ShieldQuestion, text: 'Static check only', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
    stale: { icon: ShieldQuestion, text: 'Edited - re-verify', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  };
  const m = map[status] || map.estimated;
  const Icon = m.icon;
  return (
    <span className={`chip py-0.5 text-[11px] ${m.cls}`}>
      <Icon size={12} /> {m.text}
    </span>
  );
}

export default function CodeWorkspace({
  language,
  original,
  onOriginalChange,
  optimized,
  onOptimizedChange,
  annotations,
  findingsCount,
  changesCount,
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

  const monacoLang = language === 'sql' ? 'sql' : language;

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <div className="panel overflow-hidden">
        <div className="panel-header">
          <h3 className="panel-title">
            <Code2 size={15} className="text-red-400" /> Original
            {findingsCount > 0 && (
              <span className="chip border-red-500/40 bg-red-500/10 py-0.5 text-[11px] text-red-300">
                {findingsCount} hotspot{findingsCount === 1 ? '' : 's'}
              </span>
            )}
          </h3>
          <span className="font-mono text-[11px] uppercase text-slate-500">{language}</span>
        </div>
        <div className="h-[520px]">
          <Editor
            language={monacoLang}
            theme="greencode-dark"
            value={original}
            onChange={(v) => onOriginalChange(v ?? '')}
            onMount={(editor, monaco) => {
              origEditor.current = editor;
              origMonaco.current = monaco;
              markOrigReady();
            }}
            options={{ ...EDITOR_OPTIONS, readOnly: running }}
            loading={<div className="grid h-full place-items-center text-xs text-slate-500">Loading editor…</div>}
          />
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="panel-header">
          <h3 className="panel-title">
            <Sparkles size={15} className="text-emerald-400" /> Optimized
            {changesCount > 0 && (
              <span className="chip border-emerald-500/40 bg-emerald-500/10 py-0.5 text-[11px] text-emerald-300">
                {changesCount} change{changesCount === 1 ? '' : 's'}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-1.5">
            <VerificationPill status={hasResult ? verificationStatus : null} />
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={onReverify}
              disabled={!hasResult || reverifying || running}
              title="Re-run the differential execution test on the (edited) optimized code"
            >
              {reverifying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Re-verify
            </button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={copy} disabled={!optimized} title="Copy optimized code">
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
        <div className="relative h-[520px]">
          {!hasResult && !running && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-ink-900/70 backdrop-blur-[1px]">
              <div className="text-center">
                <Sparkles className="mx-auto mb-2 text-emerald-500/60" size={28} />
                <p className="text-sm font-medium text-slate-300">Optimized code appears here</p>
                <p className="mt-1 text-xs text-slate-500">Run the pipeline to profile, refactor and verify.</p>
              </div>
            </div>
          )}
          {running && !hasResult && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-ink-900/70">
              <div className="flex items-center gap-2 text-sm text-emerald-300">
                <Loader2 size={16} className="animate-spin" /> Agents at work…
              </div>
            </div>
          )}
          <Editor
            language={monacoLang}
            theme="greencode-dark"
            value={optimized}
            onChange={(v) => onOptimizedChange(v ?? '')}
            onMount={(editor, monaco) => {
              optEditor.current = editor;
              optMonaco.current = monaco;
              markOptReady();
            }}
            options={{ ...EDITOR_OPTIONS, readOnly: running || !hasResult }}
            loading={<div className="grid h-full place-items-center text-xs text-slate-500">Loading editor…</div>}
          />
        </div>
      </div>
    </section>
  );
}
