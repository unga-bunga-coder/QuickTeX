// Everything the page needs from CodeMirror, exposed as one global `CM`.
export { EditorState, StateField, StateEffect } from "@codemirror/state";
export { EditorView, Decoration, WidgetType, keymap, showTooltip, drawSelection } from "@codemirror/view";
export { history, historyKeymap, defaultKeymap, undo, redo } from "@codemirror/commands";
export { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
