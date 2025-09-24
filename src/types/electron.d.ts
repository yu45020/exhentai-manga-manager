export {}

declare global {
    interface Window {
        ipcRenderer: {
            invoke: (channel: string, ...args: any[]) => Promise<any>
            ipcOn: (
                channel: string,
                listener: (event: any, ...args: any[]) => void
            ) => () => void
        }
    }
}
