/**
 * bf-cache-verify — SillyTavern server plugin.
 * Companion to the bf-cache-verify UI extension that verifies Claude prompt
 * caching via OpenRouter.
 *
 * Module format: CommonJS (plugins/package.json declares "type": "commonjs";
 * the ST plugin loader dynamic-import()s this file and reads module.exports
 * via the default import).
 *
 * Mounted by the loader at: /api/plugins/bf-cache-verify
 *
 * Endpoints:
 *   GET  /probe              -> { ok: true, version }
 *   GET  /config             -> { ok, claude/effective: <boot-time values the running server uses>,
 *                                 file: <fresh parse of config.yaml>, restartRequired, raw }
 *   GET  /generation?id=X    -> proxied OpenRouter generation stats (retries 404 up to 3x, 1s apart)
 *   POST /fix-config { cachingAtDepth } -> sets claude.cachingAtDepth in config.yaml
 *                               (comment-preserving edit + backup; restart required).
 *                               enableServerPlugins can NOT be self-fixed: this plugin
 *                               only runs when that flag is already true.
 *   POST /log { line }       -> appends timestamped line to cache-verify.log
 *   GET  /log/tail?n=200     -> { ok, lines: [...] }
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');

const VERSION = '1.1.0';
const PLUGIN_DIR = __dirname;
// plugins/bf-cache-verify -> two levels up is the SillyTavern server root.
const SERVER_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const CONFIG_YAML_PATH = path.join(SERVER_ROOT, 'config.yaml');
const LOG_FILE = path.join(PLUGIN_DIR, 'cache-verify.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024; // ~2 MB cap

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lazily loaded 'yaml' package from ST's node_modules (same lib ST core uses). */
let yamlLib = null;
function getYaml() {
    if (!yamlLib) {
        // Resolves via plugins/ -> server root node_modules.
        // eslint-disable-next-line global-require
        yamlLib = require('yaml');
    }
    return yamlLib;
}

/** Parse config.yaml fresh on every call (the user may edit it while testing). */
function readConfigYaml() {
    const text = fs.readFileSync(CONFIG_YAML_PATH, 'utf8');
    return getYaml().parse(text) ?? {};
}

/**
 * Normalize the claude section exactly like src/endpoints/backends/chat-completions.js
 * (non-integer / negative cachingAtDepth -> -1, booleans coerced).
 * @param {object} config Parsed config.yaml object
 * @returns {{cachingAtDepth: number, enableSystemPromptCache: boolean, extendedTTL: boolean}}
 */
function normalizeClaudeSection(config) {
    const claude = config?.claude ?? {};
    const rawDepth = claude.cachingAtDepth;
    return {
        cachingAtDepth: (Number.isInteger(rawDepth) && rawDepth >= 0) ? rawDepth : -1,
        enableSystemPromptCache: Boolean(claude.enableSystemPromptCache),
        extendedTTL: Boolean(claude.extendedTTL),
    };
}

/**
 * Boot-time snapshot of the claude section. The ST server reads
 * claude.cachingAtDepth / enableSystemPromptCache / extendedTTL into
 * module-scoped constants ONCE at startup (chat-completions.js:101-107);
 * plugin init() also runs at server startup, so this snapshot equals the
 * values the running server actually uses until the next restart.
 * @type {ReturnType<typeof normalizeClaudeSection>|null}
 */
let bootClaudeConfig = null;

/**
 * Read the OpenRouter API key.
 * Primary path: ST's own secrets module (ESM, so dynamic import) with the
 * per-request user directories. Fallback: parse secrets.json manually from
 * the default-user data directory.
 * Never logs or returns the key to clients.
 * @param {object} req Express request
 * @returns {Promise<string>} key or '' if not found
 */
async function readOpenRouterKey(req) {
    // Primary: official secrets API with the request's user directories.
    try {
        if (req.user && req.user.directories) {
            const secretsPath = path.join(SERVER_ROOT, 'src', 'endpoints', 'secrets.js');
            const secretsUrl = url.pathToFileURL(secretsPath).toString();
            const secrets = await import(secretsUrl);
            const readSecret = secrets.readSecret ?? secrets.default?.readSecret;
            const SECRET_KEYS = secrets.SECRET_KEYS ?? secrets.default?.SECRET_KEYS;
            if (typeof readSecret === 'function' && SECRET_KEYS?.OPENROUTER) {
                const key = readSecret(req.user.directories, SECRET_KEYS.OPENROUTER);
                if (key) return String(key);
            }
        }
    } catch (err) {
        console.warn('[bf-cache-verify] readSecret via ST secrets module failed:', err.message);
    }

    // Fallback: parse secrets.json from the (default) user data directory.
    try {
        const config = readConfigYaml();
        const dataRoot = path.resolve(SERVER_ROOT, config?.dataRoot ?? './data');
        const secretsFile = path.join(dataRoot, 'default-user', 'secrets.json');
        if (fs.existsSync(secretsFile)) {
            const store = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
            const entry = store?.['api_key_openrouter'];
            if (typeof entry === 'string') return entry; // legacy flat format
            if (Array.isArray(entry)) {
                const active = entry.find(v => v && v.active) ?? entry[0];
                if (active?.value) return String(active.value);
            }
        }
    } catch (err) {
        console.warn('[bf-cache-verify] secrets.json fallback failed:', err.message);
    }

    return '';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Append a line to the log file, truncating the oldest half when over the cap. */
async function appendLogLine(line) {
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    await fsp.appendFile(LOG_FILE, stamped, 'utf8');
    try {
        const stat = await fsp.stat(LOG_FILE);
        if (stat.size > LOG_MAX_BYTES) {
            const text = await fsp.readFile(LOG_FILE, 'utf8');
            const lines = text.split('\n');
            const keep = lines.slice(Math.floor(lines.length / 2));
            await fsp.writeFile(LOG_FILE, keep.join('\n'), 'utf8');
        }
    } catch (err) {
        console.warn('[bf-cache-verify] log truncation failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

const info = {
    id: 'bf-cache-verify',
    name: 'BF Cache Verify',
    description: 'Companion server plugin for verifying Claude prompt caching via OpenRouter: exposes config.yaml caching settings, proxies OpenRouter generation stats, and keeps a live verification log.',
};

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    // Body parsing: ST applies express.json() globally before the plugin
    // router, but parse defensively in case ordering ever changes.

    // Capture the boot-time claude config (see bootClaudeConfig docstring).
    try {
        bootClaudeConfig = normalizeClaudeSection(readConfigYaml());
    } catch (err) {
        console.warn('[bf-cache-verify] boot config snapshot failed:', err.message);
    }

    router.get('/probe', (req, res) => {
        res.json({ ok: true, version: VERSION });
    });

    router.get('/config', (req, res) => {
        try {
            const config = readConfigYaml();
            const file = normalizeClaudeSection(config);
            const effective = bootClaudeConfig ?? file;
            const restartRequired = ['cachingAtDepth', 'enableSystemPromptCache', 'extendedTTL']
                .some(k => effective[k] !== file[k]);
            res.json({
                ok: true,
                // What the RUNNING server actually uses (boot-time constants).
                claude: effective,
                effective: effective,
                // What config.yaml currently contains on disk.
                file: file,
                restartRequired: restartRequired,
                raw: config?.claude ?? {},
            });
        } catch (err) {
            console.error('[bf-cache-verify] /config failed:', err);
            res.status(500).json({ ok: false, error: String(err.message ?? err) });
        }
    });

    router.get('/generation', async (req, res) => {
        try {
            const id = String(req.query.id ?? '').trim();
            if (!id) {
                return res.status(400).json({ ok: false, error: 'missing_id' });
            }
            const apiKey = await readOpenRouterKey(req);
            if (!apiKey) {
                return res.json({ ok: false, error: 'no_key' });
            }

            const genUrl = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`;
            const MAX_ATTEMPTS = 3;
            let lastStatus = 0;
            let lastBody = '';

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                let response;
                try {
                    response = await fetch(genUrl, {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'HTTP-Referer': 'https://sillytavern.app',
                            'X-Title': 'SillyTavern',
                        },
                    });
                } catch (fetchErr) {
                    // Network error: treat like a retryable failure.
                    lastStatus = 0;
                    lastBody = String(fetchErr.message ?? fetchErr);
                    if (attempt < MAX_ATTEMPTS) { await sleep(1000); continue; }
                    break;
                }

                lastStatus = response.status;

                if (response.ok) {
                    const json = await response.json();
                    // OpenRouter wraps stats in { data: {...} }.
                    return res.json({ ok: true, data: json?.data ?? json });
                }

                lastBody = await response.text().catch(() => '');

                if (response.status === 404 && attempt < MAX_ATTEMPTS) {
                    // Generation stats may lag 1-2s behind the completion.
                    await sleep(1000);
                    continue;
                }
                break;
            }

            return res.status(502).json({
                ok: false,
                error: 'openrouter_error',
                status: lastStatus,
                detail: String(lastBody).slice(0, 500),
            });
        } catch (err) {
            console.error('[bf-cache-verify] /generation failed:', err);
            res.status(500).json({ ok: false, error: String(err.message ?? err) });
        }
    });

    router.post('/fix-config', async (req, res) => {
        try {
            const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
            const depth = (Number.isInteger(body.cachingAtDepth) && body.cachingAtDepth >= 0 && body.cachingAtDepth <= 128)
                ? body.cachingAtDepth
                : 2;

            const YAML = getYaml();
            const text = fs.readFileSync(CONFIG_YAML_PATH, 'utf8');
            // parseDocument keeps comments and formatting intact on re-serialize.
            const doc = YAML.parseDocument(text);
            const from = doc.getIn(['claude', 'cachingAtDepth']);

            const backupName = 'config.yaml.bak-bfcv';
            fs.writeFileSync(path.join(SERVER_ROOT, backupName), text, 'utf8');

            doc.setIn(['claude', 'cachingAtDepth'], depth);
            fs.writeFileSync(CONFIG_YAML_PATH, doc.toString(), 'utf8');

            await appendLogLine(`[fix-config] claude.cachingAtDepth: ${String(from)} -> ${depth} (backup: ${backupName}; ST restart required)`);
            res.json({
                ok: true,
                changed: from !== depth,
                from: from ?? null,
                to: depth,
                backup: backupName,
                // The running server keeps its boot-time value until restart.
                restartRequired: true,
            });
        } catch (err) {
            console.error('[bf-cache-verify] /fix-config failed:', err);
            res.status(500).json({ ok: false, error: String(err.message ?? err) });
        }
    });

    router.post('/log', async (req, res) => {
        try {
            const line = typeof req.body === 'object' && req.body !== null
                ? String(req.body.line ?? '')
                : '';
            if (!line) {
                return res.status(400).json({ ok: false, error: 'missing_line' });
            }
            // Keep single-line JSONL integrity.
            await appendLogLine(line.replace(/\r?\n/g, ' '));
            res.json({ ok: true });
        } catch (err) {
            console.error('[bf-cache-verify] /log failed:', err);
            res.status(500).json({ ok: false, error: String(err.message ?? err) });
        }
    });

    router.get('/log/tail', async (req, res) => {
        try {
            const n = Math.max(1, Math.min(2000, parseInt(String(req.query.n ?? '200'), 10) || 200));
            let lines = [];
            if (fs.existsSync(LOG_FILE)) {
                const text = await fsp.readFile(LOG_FILE, 'utf8');
                lines = text.split('\n').filter(l => l.length > 0).slice(-n);
            }
            res.json({ ok: true, lines });
        } catch (err) {
            console.error('[bf-cache-verify] /log/tail failed:', err);
            res.status(500).json({ ok: false, error: String(err.message ?? err) });
        }
    });

    console.log(`[bf-cache-verify] plugin v${VERSION} initialized (log: ${LOG_FILE})`);
}

async function exit() {
    // Nothing to clean up: no timers, no open handles.
}

module.exports = { info, init, exit };
