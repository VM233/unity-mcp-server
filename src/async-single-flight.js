export class AsyncSingleFlight {
  constructor() {
    this.inFlight = new Map();
  }

  run(key, operation) {
    const active = this.inFlight.get(key);
    if (active) {
      return active;
    }

    const promise = Promise.resolve().then(operation);
    this.inFlight.set(key, promise);
    return promise.finally(() => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    });
  }
}
