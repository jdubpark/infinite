'use strict';
const terminal = new Terminal({
  fontFamily: 'Menlo, ui-monospace, monospace', fontSize: 13, lineHeight: 1.15,
  cursorBlink: true, scrollback: 10000, allowProposedApi: false, disableStdin: true,
  theme: { background: '#0D1017', foreground: '#BFBDB6', cursor: '#E6B450', selectionBackground: '#273747' }
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));
// GPU rendering keeps full-screen TUI redraws smooth; the DOM renderer remains the fallback.
try {
  const webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  terminal.loadAddon(webgl);
} catch (error) { console.warn('WebGL renderer unavailable', error); }
// Without control this Mac cannot resize the server PTY. A snapshot that carries the
// server's size keeps it, because reflowing a full-screen TUI scrambles it; replayed
// output without a known size is fitted to the viewport as the best available guess.
let follows = false, pinned = false;
const fitViewport = () => {
  if (pinned && !follows) return;
  const size = fit.proposeDimensions();
  if (size) terminal.resize(Math.min(240, Math.max(20, size.cols)), Math.min(100, Math.max(5, size.rows)));
};
const post = value => window.webkit.messageHandlers.terminal.postMessage(value);
terminal.onData(text => post({ type: 'input', text }));
terminal.onResize(({cols, rows}) => post({ type: 'resize', cols, rows }));
terminal.attachCustomKeyEventHandler(event => {
  if (event.metaKey && ['c', 'v', 'a', 'f', 'w', 't'].includes(event.key.toLowerCase())) return false;
  return true;
});
window.infiniteTerminal = {
  feed(base64, reset, columns, rows) {
    if (reset) { terminal.reset(); pinned = columns > 0 && rows > 0; if (pinned) terminal.resize(columns, rows); }
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    return new Promise(resolve => terminal.write(bytes, () => { if (reset) fitViewport(); resolve(); }));
  },
  control(enabled) { terminal.options.disableStdin = !enabled; },
  follow(enabled) { follows = enabled; if (enabled) fitViewport(); },
  focus() { terminal.focus(); },
  selection() { return terminal.getSelection(); },
  selectAll() { terminal.selectAll(); },
  resize() { fitViewport(); }
};
new ResizeObserver(() => fitViewport()).observe(document.getElementById('terminal'));
fitViewport(); post({ type: 'ready', cols: terminal.cols, rows: terminal.rows });
