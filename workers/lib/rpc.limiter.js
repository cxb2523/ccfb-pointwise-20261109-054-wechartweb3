const sleep = require('../../utils/sleep');

/*
 * RpcLimiter
 *
 * One single limiter instance has to be shared by every worker of a process:
 *  - it serializes the rpc calls and spaces them so the configured QPS is never exceeded
 *  - when a rate-limit error ( 429 / -32005 ) is signalled, the spacing grows exponentially
 *    for EVERY worker at once, so they don't all fire again at the same time when the
 *    backoff ends ( no thundering herd )
 *  - on successes the spacing decays back towards the configured QPS
 */
class RpcLimiter {
    constructor({
        maxQps = 5,
        baseDelayMs = 500,
        backoffFactor = 2,
        maxDelayMs = 30000,
        jitterMs = 250,
        onLog = null, // optional logger: (msg) => {}
    } = {}) {
        this.maxQps = maxQps > 0 ? maxQps : Infinity;
        this.minIntervalMs = this.maxQps === Infinity ? 0 : Math.ceil(1000 / this.maxQps);
        this.baseDelayMs = baseDelayMs;
        this.backoffFactor = backoffFactor;
        this.maxDelayMs = maxDelayMs;
        this.jitterMs = jitterMs;
        this.onLog = typeof onLog === 'function' ? onLog : () => {};

        this.backoffLevel = 0;      // shared backoff state, grows on rate-limit errors, decays on successes
        this._nextSlot = 0;         // earliest timestamp the next call is allowed to start
        this._chain = Promise.resolve(); // serializes every scheduled call
    }

    _backoffDelayMs() {
        if( this.backoffLevel === 0 ) return 0;
        const delay = this.baseDelayMs * Math.pow(this.backoffFactor, this.backoffLevel - 1);
        return Math.min(this.maxDelayMs, delay);
    }

    _currentIntervalMs() {
        return Math.max(this.minIntervalMs, this._backoffDelayMs());
    }

    _logIntervalChange( reason ){
        const interval = this._currentIntervalMs();
        const qps = interval === 0 ? 'unlimited' : (1000 / interval).toFixed(2);
        this.onLog(`[LIMITER] ${reason} -> backoff_level=${this.backoffLevel} interval=${interval}ms (max ~${qps} qps, shared by all workers)`);
    }

    /* call this whenever an rpc call failed with a rate-limit error ( 429 / -32005 ) */
    notifyRateLimited() {
        this.backoffLevel++;
        this._logIntervalChange('rate limited (429/-32005), backing off');
    }

    /* call this whenever an rpc call succeeded */
    notifySuccess() {
        if( this.backoffLevel > 0 ){
            this.backoffLevel--;
            this._logIntervalChange('rpc call succeeded, relaxing backoff');
        }
    }

    /* extra jittered delay a worker should wait before retrying a failed call */
    retryDelayMs( attempt ){
        const delay = Math.min(
            this.maxDelayMs,
            this.baseDelayMs * Math.pow(this.backoffFactor, Math.max(0, attempt - 1))
        );
        return delay + Math.floor(Math.random() * this.jitterMs);
    }

    /*
     * Runs fn() through the shared queue. Calls are started one after the other with at
     * least the current interval between them, whatever the number of workers is.
     */
    schedule( fn ){
        const run = async () => {
            const wait = this._nextSlot - Date.now();
            if( wait > 0 ) await sleep(wait);
            this._nextSlot = Date.now() + this._currentIntervalMs();
            return fn();
        };
        const result = this._chain.then(run);
        // keep the queue alive even when a call rejects
        this._chain = result.then(() => {}, () => {});
        return result;
    }
}

module.exports = RpcLimiter;
