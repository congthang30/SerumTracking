export interface LogEntry {
  id: number;
  time: string;
  type: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

class ClientLogger {
  public log(type: LogEntry['type'], ...args: any[]): void {
    if ((import.meta as any).env?.DEV) {
      const fn = (console as any)[type] || console.log;
      fn(...args);
    }
  }

  public getEntries(): LogEntry[] {
    return [];
  }

  public subscribe(_fn: (entry: LogEntry) => void): () => void {
    return () => {};
  }
}

export const logger = new ClientLogger();
