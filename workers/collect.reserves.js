require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Web3 = require('web3');

const EnumChainId = require('../enum/chain.id');
const EnumContracts = require('../enum/contracts');
const EnumAbi = require('../enum/abi');
const RpcLimiter = require('./lib/rpc.limiter');
const sleep = require('../utils/sleep');
const { maskRpcUrl, maskSecretsInText } = require('../utils/mask.rpc.url');

const LOG_DIR = path.join(__dirname, '..', 'log');
const COLLECT_LOG = path.join(LOG_DIR, 'reserves-collect.log');
const FAILED_LOG = path.join(LOG_DIR, 'reserves-failed.log');
const JSON_OUT = path.join(LOG_DIR, 'reserves.json');
const CSV_OUT = path.join(LOG_DIR, 'reserves.csv');
const CURSOR_FILE = path.join(LOG_DIR, 'reserves.cursor.json');
const CSV_HEADER = 'pair,blockNumber,reserve0,reserve1,blockTimestampLast';

const CHAIN_NAMES = {
    bsc: EnumChainId.BSC,
    bsc_testnet: EnumChainId.BSC_TESTNET,
    eth: EnumChainId.ETH,
    polygon: EnumChainId.POLYGON,
    amoy: EnumChainId.POLYGON_AMOY,
    polygon_amoy: EnumChainId.POLYGON_AMOY,
    rinkeby: EnumChainId.RINKEBY,
};

/* ---------- logging ---------- */

function logLine( msg ){
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(COLLECT_LOG, line + '\n'); } catch( err ){}
}

/* ---------- args ---------- */

function parseArgs(){
    const args = { chain: null, once: false };
    const argv = process.argv.slice(2);
    for( let i = 0; i < argv.length; i++ ){
        if( argv[i] === '--chain' ) args.chain = argv[++i];
        else if( argv[i].startsWith('--chain=') ) args.chain = argv[i].slice('--chain='.length);
        else if( argv[i] === '--once' ) args.once = true;
    }
    return args;
}

/* ---------- config ---------- */

function loadFileConfig(){
    try {
        return require('../config');
    } catch( err ) {
        return require('../config.example');
    }
}

function envInt( name ){
    const v = process.env[name];
    if( v === undefined || v === '' ) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function resolveReservesConfig( chainId, chainCfg ){
    const fromFile = (chainCfg && chainCfg.reserves) || {};
    const pick = (envName, fileKey, fallback) => {
        const envVal = envInt(envName);
        if( envVal !== undefined ) return envVal;
        if( fromFile[fileKey] !== undefined ) return fromFile[fileKey];
        return fallback;
    };
    return {
        workers:                       pick('RESERVES_WORKERS',              'workers',                        4),
        rpc_max_qps:                   pick('RESERVES_RPC_MAX_QPS',          'rpc_max_qps',                    5),
        retry_max_attempts:            pick('RESERVES_RETRY_MAX_ATTEMPTS',   'retry_max_attempts',             5),
        retry_base_delay_ms:           pick('RESERVES_RETRY_BASE_DELAY_MS',  'retry_base_delay_ms',            500),
        retry_backoff_factor:          pick('RESERVES_RETRY_BACKOFF_FACTOR', 'retry_backoff_factor',           2),
        retry_max_delay_ms:            pick('RESERVES_RETRY_MAX_DELAY_MS',   'retry_max_delay_ms',             30000),
        retry_jitter_ms:               pick('RESERVES_RETRY_JITTER_MS',      'retry_jitter_ms',                250),
        skip_after_consecutive_failures: pick('RESERVES_SKIP_AFTER_FAILURES','skip_after_consecutive_failures',3),
        confirmations:                 pick('RESERVES_CONFIRMATIONS',        'confirmations',                  12),
        max_pairs:                     pick('RESERVES_MAX_PAIRS',            'max_pairs',                      0),
        loop_interval_ms:              pick('RESERVES_LOOP_INTERVAL_MS',     'loop_interval_ms',               60000),
    };
}

function resolveRpcUrl( chainId, chainCfg ){
    const byChainEnv = {
        [EnumChainId.POLYGON_AMOY]: process.env.AMOY_RPC_URL,
        [EnumChainId.BSC]: process.env.BSC_RPC_URL,
        [EnumChainId.ETH]: process.env.ETH_RPC_URL,
        [EnumChainId.POLYGON]: process.env.POLYGON_RPC_URL,
    };
    const fromEnv = byChainEnv[chainId] || process.env[`RPC_URL_${chainId}`];
    if( fromEnv ) return fromEnv;
    const fromFile = chainCfg && chainCfg.http_provider;
    if( fromFile && !fromFile.includes('<') ) return fromFile;
    return null;
}

/* ---------- errors ---------- */

function isRateLimitError( err ){
    if( !err ) return false;
    if( err.code === 429 || err.statusCode === 429 ) return true;
    if( err.error && (err.error.code === -32005 || err.error.code === 429) ) return true;
    const msg = String(err.message || err);
    return /429|-32005|rate.?limit|too many requests|exceed|throttl/i.test(msg);
}

/* ---------- storage ( json + csv share the same dedup key: pair + block ) ---------- */

function recordKey( pair, blockNumber ){
    return `${pair.toLowerCase()}_${blockNumber}`;
}

function csvEscape( value ){
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordToCsvLine( r ){
    return [r.pair, r.blockNumber, r.reserve0, r.reserve1, r.blockTimestampLast].map(csvEscape).join(',');
}

function loadRecords(){
    try {
        const parsed = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8'));
        if( parsed && parsed.records && typeof parsed.records === 'object' ){
            return new Map(Object.entries(parsed.records));
        }
    } catch( err ){}
    return new Map();
}

function saveRecords( chainId, records ){
    const obj = {
        chainId,
        updatedAt: new Date().toISOString(),
        records: Object.fromEntries(records),
    };
    const tmp = JSON_OUT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, JSON_OUT);
}

function rewriteCsv( records ){
    const lines = [...records.values()]
        .sort((a, b) => a.blockNumber - b.blockNumber || (a.pair < b.pair ? -1 : 1))
        .map(recordToCsvLine);
    const tmp = CSV_OUT + '.tmp';
    fs.writeFileSync(tmp, CSV_HEADER + '\n' + (lines.length ? lines.join('\n') + '\n' : ''));
    fs.renameSync(tmp, CSV_OUT);
}

function ensureCsvHeader(){
    try {
        if( fs.statSync(CSV_OUT).size > 0 ) return;
    } catch( err ){}
    fs.writeFileSync(CSV_OUT, CSV_HEADER + '\n');
}

function appendCsvRecord( r ){
    fs.appendFileSync(CSV_OUT, recordToCsvLine(r) + '\n');
}

function loadCursor(){
    try {
        return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
    } catch( err ){}
    return null;
}

function saveCursor( chainId, lastSyncedBlock ){
    const tmp = CURSOR_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ chainId, lastSyncedBlock, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, CURSOR_FILE);
}

/* failed pairs already logged ( pair@block ), so reruns don't pile up duplicates */
function loadLoggedFailures(){
    const seen = new Set();
    try {
        const content = fs.readFileSync(FAILED_LOG, 'utf8');
        for( const match of content.matchAll(/pair=(0x[a-fA-F0-9]{40})\s+block=(\d+)/g) ){
            seen.add(`${match[1].toLowerCase()}@${match[2]}`);
        }
    } catch( err ){}
    return seen;
}

function logFailedPair( pair, blockNumber, consecutiveFailures, err ){
    const reason = maskSecretsInText(String((err && err.message) || err)).replace(/\s+/g, ' ').trim();
    const line = `[${new Date().toISOString()}] [SKIP] pair=${pair} block=${blockNumber} consecutive_failures=${consecutiveFailures} reason="${reason}"`;
    fs.appendFileSync(FAILED_LOG, line + '\n');
    logLine(`[SKIP] pair=${pair} skipped after ${consecutiveFailures} consecutive failures, written to log/reserves-failed.log`);
}

/* ---------- collector ---------- */

class ReservesCollector {
    constructor({ chainId, chainName, rpcUrl, cfg }){
        this.chainId = chainId;
        this.chainName = chainName;
        this.cfg = cfg;
        this.web3 = new Web3(new Web3.providers.HttpProvider(rpcUrl, { timeout: 30000 }));
        this.factoryAddress = EnumContracts[chainId].MAIN_FACTORY;
        this.factory = new this.web3.eth.Contract(EnumAbi[chainId].MAIN_FACTORY, this.factoryAddress);
        this.pairAbi = EnumAbi[chainId].PAIR;
        // one single limiter shared by every worker: qps spacing + shared exponential backoff
        this.limiter = new RpcLimiter({
            maxQps: cfg.rpc_max_qps,
            baseDelayMs: cfg.retry_base_delay_ms,
            backoffFactor: cfg.retry_backoff_factor,
            maxDelayMs: cfg.retry_max_delay_ms,
            jitterMs: cfg.retry_jitter_ms,
            onLog: logLine,
        });
        // per-pair state and per-pair promise chains: retries / skips of the same pair are
        // always serialized, so two workers can never write the same pair concurrently
        this.pairStates = new Map();
        this.pairChains = new Map();
        this.failedLogged = loadLoggedFailures();
        this.records = loadRecords();
        this.stats = { fetched: 0, skippedDuplicates: 0, failed: 0 };
    }

    enqueuePair( pair, fn ){
        const key = pair.toLowerCase();
        const prev = this.pairChains.get(key) || Promise.resolve();
        const next = prev.then(fn, fn);
        this.pairChains.set(key, next.then(() => {}, () => {}));
        return next;
    }

    pairState( pair ){
        const key = pair.toLowerCase();
        if( !this.pairStates.has(key) ){
            this.pairStates.set(key, { consecutiveFailures: 0, skipped: false });
        }
        return this.pairStates.get(key);
    }

    async rpcWithRetry( label, fn ){
        for( let attempt = 1; attempt <= this.cfg.retry_max_attempts; attempt++ ){
            try {
                const out = await this.limiter.schedule(fn);
                this.limiter.notifySuccess();
                return out;
            } catch( err ) {
                const rateLimited = isRateLimitError(err);
                if( rateLimited ) this.limiter.notifyRateLimited();
                if( attempt >= this.cfg.retry_max_attempts ){
                    throw err;
                }
                const delay = this.limiter.retryDelayMs(attempt);
                logLine(`[RETRY] ${label} attempt=${attempt}/${this.cfg.retry_max_attempts} rate_limited=${rateLimited} backoff=${delay}ms error="${maskSecretsInText(String(err.message || err)).replace(/\s+/g, ' ').trim()}"`);
                await sleep(delay);
            }
        }
    }

    async getPairs(){
        const length = Number(await this.rpcWithRetry('factory.allPairsLength', () => this.factory.methods.allPairsLength().call()));
        const cap = this.cfg.max_pairs > 0 ? Math.min(length, this.cfg.max_pairs) : length;
        logLine(`[PAIRS] factory=${this.factoryAddress} allPairsLength=${length} scanning=${cap}`);
        const pairs = [];
        const BATCH = 50;
        for( let start = 0; start < cap; start += BATCH ){
            const indexes = [];
            for( let i = start; i < Math.min(start + BATCH, cap); i++ ) indexes.push(i);
            const chunk = await Promise.all(indexes.map(i =>
                this.rpcWithRetry(`factory.allPairs(${i})`, () => this.factory.methods.allPairs(i).call())
            ));
            pairs.push(...chunk);
        }
        return [...new Set(pairs.map(p => this.web3.utils.toChecksumAddress(p)))];
    }

    appendRecord( pair, blockNumber, reserves ){
        const key = recordKey(pair, blockNumber);
        if( this.records.has(key) ){
            this.stats.skippedDuplicates++;
            return false;
        }
        const record = {
            pair,
            blockNumber,
            reserve0: String(reserves._reserve0 !== undefined ? reserves._reserve0 : reserves[0]),
            reserve1: String(reserves._reserve1 !== undefined ? reserves._reserve1 : reserves[1]),
            blockTimestampLast: Number(reserves._blockTimestampLast !== undefined ? reserves._blockTimestampLast : reserves[2]),
        };
        this.records.set(key, record);
        appendCsvRecord(record); // csv is append-only during a pass
        this.stats.fetched++;
        return true;
    }

    async processPair( pair, blockNumber ){
        // everything touching the same pair ( retries, skip state, writes ) is serialized
        return this.enqueuePair(pair, async () => {
            const state = this.pairState(pair);
            if( state.skipped ) return;
            if( this.records.has(recordKey(pair, blockNumber)) ){
                this.stats.skippedDuplicates++;
                return;
            }
            const contract = new this.web3.eth.Contract(this.pairAbi, pair);
            for( let attempt = 1; attempt <= this.cfg.retry_max_attempts; attempt++ ){
                try {
                    const reserves = await this.limiter.schedule(() => contract.methods.getReserves().call({}, blockNumber));
                    this.limiter.notifySuccess();
                    state.consecutiveFailures = 0;
                    this.appendRecord(pair, blockNumber, reserves);
                    return;
                } catch( err ) {
                    state.consecutiveFailures++;
                    const rateLimited = isRateLimitError(err);
                    if( rateLimited ) this.limiter.notifyRateLimited();
                    const exhausted = attempt >= this.cfg.retry_max_attempts;
                    const tooManyFailures = state.consecutiveFailures >= this.cfg.skip_after_consecutive_failures;
                    if( exhausted || tooManyFailures ){
                        state.skipped = true;
                        this.stats.failed++;
                        const failKey = `${pair.toLowerCase()}@${blockNumber}`;
                        if( !this.failedLogged.has(failKey) ){
                            this.failedLogged.add(failKey);
                            logFailedPair(pair, blockNumber, state.consecutiveFailures, err);
                        } else {
                            logLine(`[SKIP] pair=${pair} still failing (${state.consecutiveFailures} consecutive failures), already in log/reserves-failed.log`);
                        }
                        return;
                    }
                    const delay = this.limiter.retryDelayMs(attempt);
                    logLine(`[RETRY] pair=${pair} block=${blockNumber} attempt=${attempt}/${this.cfg.retry_max_attempts} consecutive_failures=${state.consecutiveFailures}/${this.cfg.skip_after_consecutive_failures} rate_limited=${rateLimited} backoff=${delay}ms error="${maskSecretsInText(String(err.message || err)).replace(/\s+/g, ' ').trim()}"`);
                    await sleep(delay);
                }
            }
        });
    }

    /* drop records that sit inside the reorg window ( above the current safe head ) */
    pruneReorgWindow( safeHead ){
        let pruned = 0;
        for( const [key, record] of this.records ){
            if( record.blockNumber > safeHead ){
                this.records.delete(key);
                pruned++;
            }
        }
        if( pruned > 0 ){
            saveRecords(this.chainId, this.records);
            rewriteCsv(this.records); // compaction pass: dirty records are removed, not appended again
            logLine(`[REORG] pruned ${pruned} records above safe block ${safeHead}, reserves.json and reserves.csv rewritten`);
        }
        return pruned;
    }

    async runPass(){
        this.stats = { fetched: 0, skippedDuplicates: 0, failed: 0 };
        const head = Number(await this.rpcWithRetry('eth.getBlockNumber', () => this.web3.eth.getBlockNumber()));
        const safeHead = head - this.cfg.confirmations;
        const cursor = loadCursor();
        logLine(`[PASS] chain=${this.chainName} (${this.chainId}) head=${head} confirmations=${this.cfg.confirmations} target_block=${safeHead} cursor=${cursor ? cursor.lastSyncedBlock : 'none'}`);
        if( safeHead <= 0 ){
            logLine(`[PASS] head too low to apply ${this.cfg.confirmations} confirmations, nothing to do`);
            return;
        }
        this.pruneReorgWindow(safeHead);
        if( cursor && cursor.chainId === this.chainId && cursor.lastSyncedBlock >= safeHead ){
            logLine(`[PASS] cursor (${cursor.lastSyncedBlock}) already covers target block ${safeHead}, nothing new to collect`);
            return;
        }
        const pairs = await this.getPairs();
        ensureCsvHeader();

        let nextIndex = 0;
        const worker = async ( workerId ) => {
            while( true ){
                const i = nextIndex++;
                if( i >= pairs.length ) return;
                await this.processPair(pairs[i], safeHead);
            }
        };
        const workers = [];
        for( let w = 0; w < this.cfg.workers; w++ ) workers.push(worker(w + 1));
        await Promise.all(workers);

        saveRecords(this.chainId, this.records);
        if( this.stats.failed === 0 ){
            saveCursor(this.chainId, safeHead);
        } else {
            // failed pairs are retried on the next pass at the same block instead of
            // moving the cursor past them ( already collected pairs are deduped anyway )
            logLine(`[PASS] cursor kept at ${cursor ? cursor.lastSyncedBlock : 'none'} because ${this.stats.failed} pair(s) failed`);
        }
        logLine(`[PASS] done block=${safeHead} pairs=${pairs.length} fetched=${this.stats.fetched} duplicates_skipped=${this.stats.skippedDuplicates} failed=${this.stats.failed}`);
    }
}

/* ---------- main ---------- */

async function main(){
    const args = parseArgs();
    if( !args.chain ){
        console.error('usage: node workers/collect.reserves.js --chain <name|chainId> [--once]');
        process.exit(1);
    }
    const chainId = CHAIN_NAMES[String(args.chain).toLowerCase()] || Number(args.chain);
    if( !chainId || !EnumContracts[chainId] || !EnumAbi[chainId] ){
        console.error(`unknown or unsupported chain: ${args.chain}`);
        process.exit(1);
    }
    const chainName = String(args.chain).toLowerCase();
    const fileConfig = loadFileConfig();
    const chainCfg = fileConfig[chainId] || {};
    const cfg = resolveReservesConfig(chainId, chainCfg);
    const rpcUrl = resolveRpcUrl(chainId, chainCfg);
    if( !rpcUrl ){
        console.error(`no rpc url for chain ${args.chain}: set it in config.js or via env ( e.g. AMOY_RPC_URL )`);
        process.exit(1);
    }

    logLine(`[CONFIG] chain=${chainName} (${chainId}) rpc=${maskRpcUrl(rpcUrl)} factory=${EnumContracts[chainId].MAIN_FACTORY}`);
    logLine(`[CONFIG] workers=${cfg.workers} rpc_max_qps=${cfg.rpc_max_qps} retry_max_attempts=${cfg.retry_max_attempts} backoff=${cfg.retry_base_delay_ms}ms*${cfg.retry_backoff_factor} (max ${cfg.retry_max_delay_ms}ms, jitter ${cfg.retry_jitter_ms}ms) skip_after_consecutive_failures=${cfg.skip_after_consecutive_failures} confirmations=${cfg.confirmations} max_pairs=${cfg.max_pairs || 'all'}`);

    const collector = new ReservesCollector({ chainId, chainName, rpcUrl, cfg });

    if( args.once ){
        await collector.runPass();
        return;
    }
    while( true ){
        try {
            await collector.runPass();
        } catch( err ) {
            logLine(`[ERROR] pass failed: ${maskSecretsInText(String(err && err.stack || err))}`);
        }
        await sleep(cfg.loop_interval_ms);
    }
}

main().catch(err => {
    logLine(`[FATAL] ${maskSecretsInText(String(err && err.stack || err))}`);
    process.exit(1);
});
