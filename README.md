# bf-cache-verify (SillyTavern Server Plugin)

Companion server plugin for the **BF Cache Verify** UI extension. Verifies Claude
prompt caching via OpenRouter by exposing the server-side caching config,
proxying OpenRouter generation stats (cache_discount), and keeping a live log file.

## Installation

1. Clone this repo into the SillyTavern `plugins` folder (works the same on
   Windows and Termux/Android):

   ```bash
   cd <SillyTavern>/plugins
   git clone https://github.com/BF-GitH/bf-cache-verify-plugin bf-cache-verify
   ```

   (The folder name `bf-cache-verify` matters — it becomes the plugin id and
   the API base URL.)

2. Enable server plugins in `<SillyTavern>/config.yaml`:

   ```yaml
   enableServerPlugins: true
   ```

3. Restart SillyTavern. The server log should show:
   `[bf-cache-verify] plugin v1.0.0 initialized`

Since this folder is a git repo, `enableServerPluginsAutoUpdate: true` (ST
default) will auto-`git pull` updates on every server start.

The companion UI extension lives here:
<https://github.com/BF-GitH/bf-cache-verify>

## Endpoints

Base URL: `/api/plugins/bf-cache-verify` (requires ST session cookie + `X-CSRF-Token` header, like all `/api/` routes).

| Method | Path                 | Purpose |
|--------|----------------------|---------|
| GET    | `/probe`             | `{ ok: true, version }` — reachability check |
| GET    | `/config`            | `{ ok, claude: { cachingAtDepth, enableSystemPromptCache, extendedTTL }, raw }` parsed live from config.yaml |
| GET    | `/generation?id=X`   | Proxies `https://openrouter.ai/api/v1/generation?id=X` using the OpenRouter key from ST secrets. Retries up to 3x with 1s delay on 404. Returns `{ ok, data: { cache_discount, tokens_prompt, ... } }`, or `{ ok:false, error:'no_key' }` if no OpenRouter key is stored. |
| POST   | `/fix-config` `{ "cachingAtDepth": 2 }` | Sets `claude.cachingAtDepth` in `config.yaml` (comment-preserving edit; backup written to `config.yaml.bak-bfcv`). Returns `{ ok, from, to, backup, restartRequired: true }` — the running server keeps its boot-time value until restart. Note: `enableServerPlugins` cannot be self-fixed (this plugin only runs when it is already `true`). |
| POST   | `/log` `{ "line": "..." }` | Appends a timestamped line to `cache-verify.log` (capped at ~2 MB; oldest half is dropped when exceeded) |
| GET    | `/log/tail?n=200`    | `{ ok, lines: [...] }` — last n log lines |

## Watching the log live

```powershell
Get-Content -Wait "C:\Users\RedLeader\Desktop\SillyTavern\plugins\bf-cache-verify\cache-verify.log"
```

## Security notes

- The OpenRouter API key is read server-side only (ST secrets mechanism, with a
  `secrets.json` fallback) and is never logged or returned to the client.
- All handlers are wrapped in try/catch and return JSON errors; the plugin
  cannot crash the ST server.
