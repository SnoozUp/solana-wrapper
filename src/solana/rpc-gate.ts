export class RpcGate {
  private q: Array<() => void> = [];
  private inFlight = 0;
  
  constructor(private max = Number(process.env.RPC_MAX_CONCURRENCY ?? 6)) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { 
      return await fn(); 
    } finally { 
      this.release(); 
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.max) { 
      this.inFlight++; 
      return Promise.resolve(); 
    }
    // Guard against extreme queue buildup
    if (this.q.length > 1000) {
      throw new Error('RpcGate queue overflow - too many concurrent requests');
    }
    return new Promise<void>(res => this.q.push(() => { 
      this.inFlight++; 
      res(); 
    }));
  }

  private release() {
    this.inFlight--;
    const next = this.q.shift();
    if (next) next();
  }
}

export class Gate {
  private q: Array<() => void> = [];
  private inFlight = 0;
  
  constructor(private max = Number(process.env.BUILD_MAX_CONCURRENCY ?? 4)) {}
  
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { 
      return await fn(); 
    } finally { 
      this.release(); 
    }
  }
  
  private acquire(): Promise<void> {
    if (this.inFlight < this.max) { 
      this.inFlight++; 
      return Promise.resolve(); 
    }
    // Guard against extreme queue buildup
    if (this.q.length > 1000) {
      throw new Error('Gate queue overflow - too many concurrent operations');
    }
    return new Promise(res => this.q.push(() => { 
      this.inFlight++; 
      res(); 
    }));
  }
  
  private release() { 
    this.inFlight--; 
    this.q.shift()?.(); 
  }
}
