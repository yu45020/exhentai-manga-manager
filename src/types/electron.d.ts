export {}

declare global {
    interface Window {
        electron: {
            ipcInvoke: (channel: string, ...args: any[]) => Promise<any>
            ipcOn: (
                channel: string,
                listener: (event: any, ...args: any[]) => void
            ) => () => void
        }
    }
}
