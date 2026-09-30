// Worker entry: builds a crash-analysis mod index off the main thread.
const { parentPort, workerData } = require('worker_threads');
const { buildIndex } = require('./modIndex');

try {
  parentPort.postMessage({ ok: true, mods: buildIndex(workerData.dir) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || String(error) });
}
