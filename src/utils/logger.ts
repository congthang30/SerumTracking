export interface LogEntry {
  id: number;
  time: string;
  type: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

class ClientLogger {
  public log(type: LogEntry['type'], ...args: any[]): void {
    // Console logging is disabled; keep the API for existing callers.
    void type;
    void args;
  }

  public getEntries(): LogEntry[] {
    return [];
  }

  public subscribe(_fn: (entry: LogEntry) => void): () => void {
    return () => {};
  }
}

export const logger = new ClientLogger();
