'use strict';
const terminal = new Terminal({
  fontFamily: 'Menlo, ui-monospace, monospace', fontSize: 13, lineHeight: 1.15,
  cursorBlink: true, scrollback: 10000, allowProposedApi: false, disableStdin: true,
  theme: { background: '#0D1017', foreground: '#BFBDB6', cursor: '#E6B450', selectionBackground: '#273747' }
});
let rendererVisible = false;
const updateCursorBlink = () => { terminal.options.cursorBlink = rendererVisible && document.visibilityState === 'visible'; };
document.addEventListener('visibilitychange', updateCursorBlink);
updateCursorBlink();
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));
try {
  const webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  terminal.loadAddon(webgl);
} catch (error) { console.warn('WebGL renderer unavailable', error); }
let follows = false, pinned = false, applyingServerSize = false;
let lastServerSize = null;
let pending = Promise.resolve();
const validSize = (cols, rows) =>
  Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000;
const readSize = value => {
  if (!value || typeof value !== 'object') return null;
  if (validSize(value.cols, value.rows)) return { cols: value.cols, rows: value.rows };
  if (validSize(value.columns, value.rows)) return { cols: value.columns, rows: value.rows };
  return null;
};
const resizeToServer = size => {
  if (!size) return;
  if (terminal.cols === size.cols && terminal.rows === size.rows) return;
  applyingServerSize = true;
  try { terminal.resize(size.cols, size.rows); } finally { applyingServerSize = false; }
};
const adoptServerSize = (size, force) => {
  if (!size) return false;
  const changed = !lastServerSize || lastServerSize.cols !== size.cols || lastServerSize.rows !== size.rows;
  lastServerSize = { cols: size.cols, rows: size.rows };
  pinned = true;
  if (force || (!follows && changed)) resizeToServer(size);
  return true;
};
const fitViewport = () => {
  if (pinned && !follows) return;
  const size = fit.proposeDimensions();
  if (size && size.cols > 0 && size.rows > 0) {
    terminal.resize(Math.min(240, Math.max(20, size.cols)), Math.min(100, Math.max(5, size.rows)));
  }
};
const post = value => window.webkit?.messageHandlers?.terminal?.postMessage(value);
terminal.onData(text => post({ type: 'input', text }));
terminal.onResize(({cols, rows}) => { if (!applyingServerSize) post({ type: 'resize', cols, rows }); });
terminal.attachCustomKeyEventHandler(event => {
  if (event.metaKey && ['c', 'v', 'a', 'f', 'w', 't'].includes(event.key.toLowerCase())) return false;
  return true;
});
const writeChunk = data => new Promise(resolve => terminal.write(data, resolve));
const enqueue = task => {
  const next = pending.then(task, task);
  pending = next.catch(() => {});
  return next;
};
const decodeBase64 = base64 => {
  if (!base64) return new Uint8Array(0);
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
};
const applyFrameStep = async frame => {
  if (!frame || typeof frame !== 'object') return;
  const topSize = readSize(frame);
  if (frame.snapshot && typeof frame.snapshot === 'object') {
    const size = readSize(frame.snapshot) || topSize;
    terminal.reset();
    if (size) adoptServerSize(size, true);
    else { pinned = false; lastServerSize = null; fitViewport(); }
    if (typeof frame.snapshot.ansi === 'string' && frame.snapshot.ansi.length > 0) {
      await writeChunk(frame.snapshot.ansi);
    }
    if (follows) fitViewport();
    return;
  }
  if (frame.open && typeof frame.open === 'object') {
    const size = readSize(frame.open) || topSize;
    if (size) adoptServerSize(size, !follows);
    else { pinned = false; lastServerSize = null; fitViewport(); }
  }
  if (frame.replay !== undefined) {
    const replayObj = frame.replay && typeof frame.replay === 'object' ? frame.replay : null;
    const size = readSize(replayObj) || topSize;
    terminal.reset();
    if (size) adoptServerSize(size, true);
    else { pinned = false; lastServerSize = null; fitViewport(); }
    const text = typeof frame.replay === 'string' ? frame.replay : typeof replayObj?.text === 'string' ? replayObj.text : '';
    const base64 = typeof replayObj?.base64 === 'string' ? replayObj.base64 : '';
    if (base64) await writeChunk(decodeBase64(base64));
    else if (text) await writeChunk(text);
    if (follows) fitViewport();
  }
  if (frame.type === 'resize' || (frame.resize && typeof frame.resize === 'object')) {
    const size = readSize(frame.resize) || topSize;
    if (size) adoptServerSize(size, !follows);
  }
  if (Array.isArray(frame.events)) {
    if (frame.reset === true) {
      terminal.reset();
      if (topSize) adoptServerSize(topSize, true);
      else { pinned = false; lastServerSize = null; fitViewport(); }
    } else if (topSize) {
      adoptServerSize(topSize, false);
    }
    for (const event of frame.events) {
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'lifecycle') {
        const size = readSize(event.data) || readSize(event.data?.terminalSize);
        if (size) adoptServerSize(size, !follows);
      } else if (event.type === 'output') {
        const size = readSize(event.data) || readSize(event.data?.terminalSize);
        if (size) adoptServerSize(size, !follows);
        if (typeof event.data?.text === 'string' && event.data.text.length > 0) {
          await writeChunk(event.data.text);
        }
      }
    }
    if (frame.reset === true && follows) fitViewport();
  }
  if (frame.state && typeof frame.state === 'object') {
    const size = readSize(frame.state.terminalSize) || readSize(frame.state);
    if (size && !lastServerSize) adoptServerSize(size, !follows);
  }
};
window.infiniteTerminal = {
  feed(base64, reset, columns, rows) {
    return enqueue(async () => {
      const size = validSize(columns, rows) ? { cols: columns, rows } : null;
      if (reset) {
        terminal.reset();
        if (size) adoptServerSize(size, true);
        else { pinned = false; lastServerSize = null; fitViewport(); }
      } else if (size) {
        adoptServerSize(size, false);
      }
      const bytes = decodeBase64(base64);
      await writeChunk(bytes);
      if (reset && follows) fitViewport();
    });
  },
  applyFrame(frame) {
    return enqueue(() => applyFrameStep(frame));
  },
  control(enabled) { terminal.options.disableStdin = !enabled; },
  render(enabled) { rendererVisible = enabled; updateCursorBlink(); },
  follow(enabled) { follows = enabled; if (enabled) fitViewport(); },
  focus() { terminal.focus(); },
  selection() { return terminal.getSelection(); },
  selectAll() { terminal.selectAll(); },
  resize() { fitViewport(); }
};
new ResizeObserver(() => fitViewport()).observe(document.getElementById('terminal'));
fitViewport(); post({ type: 'ready', cols: terminal.cols, rows: terminal.rows });
