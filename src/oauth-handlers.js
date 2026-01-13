import { OAuth2Client } from 'google-auth-library';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import open from 'open';
import { broadcastEvent } from './ui-manager.js';
import { autoLinkProviderConfigs } from './service-manager.js';
import { CONFIG } from './config-manager.js';

/**
 * OAuth Provider Configuration
 */
const OAUTH_PROVIDERS = {
    'gemini-cli-oauth': {
        clientId: process.env.GEMINI_CLI_OAUTH_CLIENT_ID,
        clientSecret: process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET,
        port: 8085,
        credentialsDir: '.gemini',
        credentialsFile: 'oauth_creds.json',
        scope: ['https://www.googleapis.com/auth/cloud-platform'],
        logPrefix: '[Gemini Auth]'
    },
    'gemini-antigravity': {
        clientId: process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_ID,
        clientSecret: process.env.GEMINI_ANTIGRAVITY_OAUTH_CLIENT_SECRET,
        port: 8086,
        credentialsDir: '.antigravity',
        credentialsFile: 'oauth_creds.json',
        scope: ['https://www.googleapis.com/auth/cloud-platform'],
        logPrefix: '[Antigravity Auth]'
    }
};

/**
 * Active Server Instance Management
 */
const activeServers = new Map();

/**
 * Active Polling Task Management
 */
const activePollingTasks = new Map();

/**
 * Generate HTML response page
 * @param {boolean} isSuccess - Whether successful
 * @param {string} message - Display message
 * @returns {string} HTML content
 */
function generateResponsePage(isSuccess, message) {
    const title = isSuccess ? 'Authorization Successful!' : 'Authorization Failed';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
    </div>
</body>
</html>`;
}

/**
 * Close active server on specified port
 * @param {number} port - Port number
 * @returns {Promise<void>}
 */
async function closeActiveServer(provider, port = null) {
    // 1. Close all previous servers for this provider
    const existing = activeServers.get(provider);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeServers.delete(provider);
                console.log(`[OAuth] Closed old server for provider ${provider} on port ${existing.port}`);
                resolve();
            });
        });
    }

    // 2. If port is specified, check if other providers are using that port
    if (port) {
        for (const [p, info] of activeServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeServers.delete(p);
                        console.log(`[OAuth] Closed old server on port ${port} (occupied by provider: ${p})`);
                        resolve();
                    });
                });
            }
        }
    }
}

/**
 * Create OAuth callback server
 * @param {Object} config - OAuth provider configuration
 * @param {string} redirectUri - Redirect URI
 * @param {OAuth2Client} authClient - OAuth2 client
 * @param {string} credPath - Credentials save path
 * @param {string} provider - Provider identifier
 * @returns {Promise<http.Server>} HTTP server instance
 */
async function createOAuthCallbackServer(config, redirectUri, authClient, credPath, provider, options = {}) {
    const port = parseInt(options.port) || config.port;
    // First close any servers that may be running for this provider, or old servers on this port
    await closeActiveServer(provider, port);

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, redirectUri);
                const code = url.searchParams.get('code');
                const errorParam = url.searchParams.get('error');

                if (code) {
                    console.log(`${config.logPrefix} Received successful callback from Google: ${req.url}`);

                    try {
                        const { tokens } = await authClient.getToken(code);
                        let finalCredPath = credPath;

                        // If specified to save to configs directory
                        if (options.saveToConfigs) {
                            const providerDir = options.providerDir;
                            const targetDir = path.join(process.cwd(), 'configs', providerDir);
                            await fs.promises.mkdir(targetDir, { recursive: true });
                            const timestamp = Date.now();
                            const filename = `${timestamp}_oauth_creds.json`;
                            finalCredPath = path.join(targetDir, filename);
                        }

                        await fs.promises.mkdir(path.dirname(finalCredPath), { recursive: true });
                        await fs.promises.writeFile(finalCredPath, JSON.stringify(tokens, null, 2));
                        console.log(`${config.logPrefix} New token received and saved to file: ${finalCredPath}`);

                        const relativePath = path.relative(process.cwd(), finalCredPath);

                        // Broadcast authorization success event
                        broadcastEvent('oauth_success', {
                            provider: provider,
                            credPath: finalCredPath,
                            relativePath: relativePath,
                            timestamp: new Date().toISOString()
                        });

                        // Auto-link newly generated credentials to Pools
                        await autoLinkProviderConfigs(CONFIG);

                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(true, 'You can close this page'));
                    } catch (tokenError) {
                        console.error(`${config.logPrefix} Failed to get token:`, tokenError);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `Failed to get token: ${tokenError.message}`));
                    } finally {
                        server.close(() => {
                            activeServers.delete(provider);
                        });
                    }
                } else if (errorParam) {
                    const errorMessage = `Authorization failed. Google returned error: ${errorParam}`;
                    console.error(`${config.logPrefix}`, errorMessage);

                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, errorMessage));
                    server.close(() => {
                        activeServers.delete(provider);
                    });
                } else {
                    console.log(`${config.logPrefix} Ignoring irrelevant request: ${req.url}`);
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                console.error(`${config.logPrefix} Error processing callback:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `Server error: ${error.message}`));

                if (server.listening) {
                    server.close(() => {
                        activeServers.delete(provider);
                    });
                }
            }
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`${config.logPrefix} Port ${port} is already in use`);
                reject(new Error(`Port ${port} is already in use`));
            } else {
                console.error(`${config.logPrefix} Server error:`, err);
                reject(err);
            }
        });

        const host = '0.0.0.0';
        server.listen(port, host, () => {
            console.log(`${config.logPrefix} OAuth callback server started at ${host}:${port}`);
            activeServers.set(provider, { server, port });
            resolve(server);
        });
    });
}

/**
 * Handle Google OAuth authorization (common function)
 * @param {string} providerKey - Provider key name
 * @param {Object} currentConfig - Current configuration object
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Returns authorization URL and related info
 */
async function handleGoogleOAuth(providerKey, currentConfig, options = {}) {
    const config = OAUTH_PROVIDERS[providerKey];
    if (!config) {
        throw new Error(`Unknown provider: ${providerKey}`);
    }

    const port = parseInt(options.port) || config.port;
    const externalHost = process.env.OAUTH_EXTERNAL_HOST;
    const redirectUri = externalHost
        ? `${externalHost}:${port}`
        : `http://localhost:${port}`;

    const authClient = new OAuth2Client(config.clientId, config.clientSecret);
    authClient.redirectUri = redirectUri;

    const authUrl = authClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'select_account',
        scope: config.scope
    });

    // Start callback server
    const credPath = path.join(os.homedir(), config.credentialsDir, config.credentialsFile);

    try {
        await createOAuthCallbackServer(config, redirectUri, authClient, credPath, providerKey, options);
    } catch (error) {
        throw new Error(`Failed to start callback server: ${error.message}`);
    }

    return {
        authUrl,
        authInfo: {
            provider: providerKey,
            redirectUri: redirectUri,
            port: port,
            ...options
        }
    };
}

/**
 * Handle Gemini CLI OAuth authorization
 * @param {Object} currentConfig - Current configuration object
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Returns authorization URL and related info
 */
export async function handleGeminiCliOAuth(currentConfig, options = {}) {
    return handleGoogleOAuth('gemini-cli-oauth', currentConfig, options);
}

/**
 * Handle Gemini Antigravity OAuth authorization
 * @param {Object} currentConfig - Current configuration object
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Returns authorization URL and related info
 */
export async function handleGeminiAntigravityOAuth(currentConfig, options = {}) {
    return handleGoogleOAuth('gemini-antigravity', currentConfig, options);
}

/**
 * Generate PKCE code verifier
 * @returns {string} Base64URL encoded random string
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate PKCE code challenge
 * @param {string} codeVerifier - Code verifier
 * @returns {string} Base64URL encoded SHA256 hash
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256');
    hash.update(codeVerifier);
    return hash.digest('base64url');
}