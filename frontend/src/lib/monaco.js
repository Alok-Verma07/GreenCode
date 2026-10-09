// Bundle Monaco locally (no CDN) so the demo works on flaky hackathon Wi-Fi.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Benchmarks run as scripts with injected globals (require, console) - skip type errors.
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});

monaco.editor.defineTheme('greencode-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5b7a6c', fontStyle: 'italic' },
    { token: 'keyword', foreground: '6ee7b7' },
    { token: 'string', foreground: 'fcd34d' },
    { token: 'number', foreground: 'f9a8d4' },
  ],
  colors: {
    'editor.background': '#0a120f',
    'editor.lineHighlightBackground': '#121e19',
    'editorLineNumber.foreground': '#3a5246',
    'editorLineNumber.activeForeground': '#6ee7b7',
    'editorGutter.background': '#0a120f',
    'editor.selectionBackground': '#10b98133',
    'editorCursor.foreground': '#34d399',
    'editorIndentGuide.background1': '#1a2a23',
    'scrollbarSlider.background': '#25392f88',
  },
});

loader.config({ monaco });

export default monaco;
