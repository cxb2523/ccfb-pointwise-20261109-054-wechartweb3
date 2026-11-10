const EnumChainId = require("./enum/chain.id");
const { toCheckSum } = require("./utils/addresses");
let scraperConfig = {
    [EnumChainId.BSC]: {
        "save_price": true, // do you want the scraper to save the price records of the tokens ?
        "save_transactions": true, // do you want the scraper to save every swap transaction ?
        "calculate_pair_fees": true, // do you want the scraper to save the fees of all the pairs ?
        "whitelist_enabled": false,// do you want the scraper to scrape only specific given tokens ?
        "whitelist": [ // pass here the tokens to whitelist as the example one 
            toCheckSum("0xc748673057861a797275CD8A068AbB95A902e8de") // example whitelisted token
        ], 
        "use_checkpoint_when_restart": false, // if the scraper crashes, it has to scrape all the block since the latest one scraped?
        "http_provider": "<your_http_provider>", // to fill
        "ws_provider": "<your_ws_provider>", // to fill
    },
    [EnumChainId.POLYGON_AMOY]: {
        "save_price": true,
        "save_transactions": true,
        "calculate_pair_fees": true,
        "whitelist_enabled": false,
        "whitelist": [],
        "use_checkpoint_when_restart": false,
        "http_provider": "<your_amoy_http_provider>", // e.g. https://polygon-amoy.g.alchemy.com/v2/<api_key> (can be overridden by AMOY_RPC_URL)
        "ws_provider": "<your_amoy_ws_provider>", // to fill
        "reserves": { // settings of workers/collect.reserves.js for this chain
            "workers": 4, // how many pair scanners run concurrently ( they all share the same rpc limiter )
            "rpc_max_qps": 5, // max rpc calls per second allowed on the http provider
            "retry_max_attempts": 5, // max attempts for a single pair before giving up on it
            "retry_base_delay_ms": 500, // exponential backoff: delay before attempt n = base * factor^(n-1)
            "retry_backoff_factor": 2, // exponential backoff multiplier
            "retry_max_delay_ms": 30000, // exponential backoff cap
            "retry_jitter_ms": 250, // random jitter added on top of every backoff delay
            "skip_after_consecutive_failures": 3, // skip the pair ( and log it to log/reserves-failed.log ) after N consecutive failures
            "confirmations": 12, // how many blocks to wait from the chain head before considering data final ( reorg safety )
            "max_pairs": 0, // 0 = scan every pair of the factory, otherwise scan only the first N pairs ( useful for testing )
            "loop_interval_ms": 60000 // delay between two full passes when running without --once
        }
    }
}
module.exports = scraperConfig;