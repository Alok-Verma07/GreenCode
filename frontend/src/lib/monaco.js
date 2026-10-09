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
    { token: '', foreground: 'd4d4d8' },
    { token: 'comment', foreground: '5c5c66', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c4b5fd' },
    { token: 'string', foreground: 'e6c07b' },
    { token: 'number', foreground: 'f0a875' },
    { token: 'type', foreground: '93c5fd' },
    { token: 'delimiter', foreground: 'a1a1aa' },
  ],
  colors: {
    'editor.background': '#0A0A0B',
    'editor.foreground': '#d4d4d8',
    'editor.lineHighlightBackground': '#ffffff06',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#3f3f46',
    'editorLineNumber.activeForeground': '#a1a1aa',
    'editorGutter.background': '#0A0A0B',
    'editor.selectionBackground': '#ffffff1f',
    'editor.inactiveSelectionBackground': '#ffffff12',
    'editorCursor.foreground': '#f4f4f5',
    'editorIndentGuide.background1': '#1f1f23',
    'editorIndentGuide.activeBackground1': '#3f3f46',
    'editorWidget.background': '#18181b',
    'editorWidget.border': '#27272a',
    'editorHoverWidget.background': '#18181b',
    'editorHoverWidget.border': '#27272a',
    'scrollbarSlider.background': '#3f3f4666',
    'scrollbarSlider.hoverBackground': '#52525b88',
    'scrollbar.shadow': '#00000000',
  },
});

loader.config({ monaco });

export default monaco;
