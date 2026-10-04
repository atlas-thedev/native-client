/**
 * Minimal Electron stub for `node --test`.
 *
 * The main-process modules `require('electron')` for `app`, `shell` and
 * `ipcMain`. Outside a real Electron runtime that require throws, which made
 * the suite fail on any machine without the Electron binary. Require this
 * helper *before* the module under test.
 */

const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const originalLoad = Module._load;

const stub = {
  app: {
    getPath: (name) => {
      if (name === 'userData') return process.env.NOCTRA_TEST_USER_DATA || path.join(os.tmpdir(), 'noctra-test-userdata');
      if (name === 'appData') return os.tmpdir();
      return os.tmpdir();
    },
    getName: () => 'Native Client',
    getVersion: () => '0.0.0-test',
    setPath: () => {}
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showMessageBox: async () => ({ response: 0 })
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => {}
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {}
  },
  BrowserWindow: class BrowserWindow {}
};

Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') return stub;
  return originalLoad.call(this, request, ...rest);
};

module.exports = stub;
