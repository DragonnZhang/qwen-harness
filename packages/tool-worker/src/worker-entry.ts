/**
 * The built worker entry point. The client runs THIS file (as compiled dist/worker-entry.js)
 * inside the sandbox. It exists so the entry has a stable, bindable path separate from the
 * library surface.
 */
import './worker-main.ts';
