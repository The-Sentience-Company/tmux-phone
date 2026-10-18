// The parts of CodeMirror 6 the page uses, bundled by `npm run build` into static/vendor/codemirror.js,
// which the page loads as the global CM. The versions are pinned in package.json.
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { classHighlighter } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { sql } from "@codemirror/lang-sql";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { diff } from "@codemirror/legacy-modes/mode/diff";

const old = (mode) => () => StreamLanguage.define(mode);
const BY_EXT = {
  js: () => javascript({ jsx: true }), mjs: javascript, cjs: javascript, jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }), mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }),
  py: python, pyi: python, json: json, md: markdown, markdown: markdown, html: html, htm: html, css: css,
  yaml: yaml, yml: yaml, go: go, rs: rust, c: cpp, h: cpp, cc: cpp, cpp: cpp, hpp: cpp, sql: sql,
  sh: old(shell), bash: old(shell), zsh: old(shell), toml: old(toml), lua: old(lua),
  diff: old(diff), patch: old(diff),
};
// Shell setup files and Dockerfiles have no extension to go by.
const BY_NAME = { ".bashrc": old(shell), ".bash_profile": old(shell), ".zshrc": old(shell), ".zprofile": old(shell),
                  ".zshenv": old(shell), ".profile": old(shell), Dockerfile: old(dockerFile) };

// The highlighting for a file name, or nothing for a file type not listed here.
function languageFor(name) {
  const make = BY_NAME[name] || BY_EXT[name.includes(".") ? name.split(".").pop().toLowerCase() : ""];
  return make ? make() : [];
}

export { EditorView, EditorState, Compartment, keymap, lineNumbers, syntaxHighlighting, classHighlighter,
         defaultKeymap, history, historyKeymap, indentWithTab, languageFor };
