export {}

declare global {
  interface Window {
    electron?: {
      invoke?: (channel: string, ...args: any[]) => Promise<any>
      on?: (
        channel: string,
        listener: (event: any, ...args: any[]) => void
      ) => () => void
    }
    // (optional) if you also reference window.ipcRenderer directly anywhere:
    ipcRenderer?: import('electron').IpcRenderer
  }
}
