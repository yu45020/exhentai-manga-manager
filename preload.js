const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
})

contextBridge.exposeInMainWorld('electronFunction', {
  'get-zoom-level': () => webFrame.getZoomLevel(),
  'set-zoom-level': (level) => webFrame.setZoomLevel(level),
  'insert-css': (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
})

// for sub window
contextBridge.exposeInMainWorld('electronAPI', {
  createSubWindow: (opts) => ipcRenderer.invoke('subwin:create', opts),
  // navigateSubWindow: (opts) => ipcRenderer.invoke('subwin:navigate', opts),
  focusSubWindow: (opts) => ipcRenderer.invoke('subwin:focus', opts),
  setEhCookies: (opts) => ipcRenderer.invoke('eh:cookies:set', opts),
  onSubWindowClosed: (cb) => {
    const handler = (_e, payload) => cb && cb(payload)
    ipcRenderer.on('subwin:closed', handler)
    return () => ipcRenderer.off('subwin:closed', handler)
  }
})