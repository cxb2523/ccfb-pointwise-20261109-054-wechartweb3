const SENSITIVE_QUERY_KEYS = [
    'key', 'apikey', 'api_key', 'api-key', 'token', 'auth',
    'secret', 'password', 'signature', 'sig', 'access_token'
];

function maskSecret( value ){
    const s = String(value);
    if( s.length <= 4 ) return '***';
    return s.slice(0, 4) + '***';
}

function looksLikeKey( segment ){
    // long alphanumerical path segments are usually api keys ( infura / alchemy / quicknode style urls )
    return /^[A-Za-z0-9_-]{16,}$/.test(segment);
}

/*
 * Masks the api key of a single rpc url:
 *  - sensitive query params ( ?apiKey=... / ?token=... / ... )
 *  - path segments that look like keys ( /v2/<key> / /v3/<key> / <key>.domain.tld style is left to the subdomain check )
 */
function maskRpcUrl( url ){
    if( !url || typeof url !== 'string' ) return url;
    let parsed;
    try {
        parsed = new URL(url);
    } catch( err ){
        return maskSecretsInText(url);
    }
    // mask key-like subdomains ( e.g. https://<key>.eth.example.com )
    if( parsed.hostname.split('.').some(looksLikeKey) ){
        parsed.hostname = parsed.hostname
            .split('.')
            .map( part => looksLikeKey(part) ? maskSecret(part) : part )
            .join('.');
    }
    // mask key-like path segments ( e.g. /v2/abcdef... )
    parsed.pathname = parsed.pathname
        .split('/')
        .map( seg => looksLikeKey(seg) ? maskSecret(seg) : seg )
        .join('/');
    // mask sensitive ( or key-looking ) query params
    for( const key of [...parsed.searchParams.keys()] ){
        const value = parsed.searchParams.get(key);
        if( SENSITIVE_QUERY_KEYS.includes(key.toLowerCase()) || looksLikeKey(value || '') ){
            parsed.searchParams.set(key, maskSecret(value));
        }
    }
    // mask userinfo if present ( https://user:pass@host )
    if( parsed.password ) parsed.password = '***';
    if( parsed.username && looksLikeKey(parsed.username) ) parsed.username = maskSecret(parsed.username);
    return parsed.toString();
}

/* Masks every rpc url found inside a free text ( error messages, logs, ... ) */
function maskSecretsInText( text ){
    if( !text || typeof text !== 'string' ) return text;
    return text.replace(/(https?|wss?):\/\/[^\s)"'\]]+/gi, match => maskRpcUrl(match));
}

let UtilsMaskRpcUrl = {
    maskRpcUrl,
    maskSecretsInText
}

module.exports = UtilsMaskRpcUrl;
