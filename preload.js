const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  ipcOn: (channel, listener) => {
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})

contextBridge.exposeInMainWorld('electronFunction', {
  'get-zoom-level': () => webFrame.getZoomLevel(),
  'set-zoom-level': (level) => webFrame.setZoomLevel(level),
  'insert-css': (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
})

contextBridge.exposeInMainWorld('wcv', {
  nav: (id, dir /* 'back' | 'forward' */) =>
    ipcRenderer.invoke('wcv:nav', { id, dir }),
  getState: (id) => ipcRenderer.invoke('wcv:getState', id),
  onState: (handler) => {
    const h = (_e, s) => handler(s)
    ipcRenderer.on('wcv:nav-state', h)
    return () => ipcRenderer.off('wcv:nav-state', h) // unsubscribe helper
  },
})