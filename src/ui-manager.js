import { existsSync, readFileSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { getRequestBody } from './common.js';

// CPU usage calculation related variables
let previousCpuInfo = null;

/**
 * Get CPU usage percentage
 * @returns {string} CPU usage string, e.g. "25.5%"
 */
function getCpuUsagePercent() {
    const cpus = os.cpus();
    
    let totalIdle = 0;
    let totalTick = 0;
    
    for (const cpu of cpus) {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }
    
    const currentCpuInfo = {
        idle: totalIdle,
        total: totalTick
    };
    
    let cpuPercent = 0;
    
    if (previousCpuInfo) {
        const idleDiff = currentCpuInfo.idle - previousCpuInfo.idle;
        const totalDiff = currentCpuInfo.total - previousCpuInfo.total;
        
        if (totalDiff > 0) {
            cpuPercent = 100 - (100 * idleDiff / totalDiff);
        }
    }
    
    previousCpuInfo = currentCpuInfo;
    
    return `${cpuPercent.toFixed(1)}%`;
}

import { getAllProviderModels, getProviderModels } from './provider-models.js';
import { CONFIG } from './config-manager.js';
import { serviceInstances, getServiceAdapter } from './adapter.js';
import { initApiService } from './service-manager.js';
import { handleGeminiCliOAuth, handleGeminiAntigravityOAuth } from './oauth-handlers.js';
import {
    generateUUID,
    normalizePath,
    getFileName,
    pathsEqual,
    isPathUsed,
    detectProviderFromPath,
    isValidOAuthCredentials,
    createProviderConfig,
    addToUsedPaths,
    formatSystemPath
} from './provider-utils.js';
import { formatGeminiUsage, formatAntigravityUsage } from './usage-service.js';
import { metricsService } from './metrics-service.js';
import cacheService from './cache-service.js';
import redisClient from './redis-client.js';

// Session cache configuration
const SESSION_CACHE_PREFIX = 'session:';
const SESSION_CACHE_TTL = 24 * 60 * 60; // 24 hours (matches token expiry)

// Usage cache file path
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');

/**
 * Read usage cache file
 * @returns {Promise<Object|null>} Cached usage data, returns null if does not exist or read fails
 */
async function readUsageCache() {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            return JSON.parse(content);
        }
        return null;
    } catch (error) {
        console.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * Write usage cache file
 * @param {Object} usageData - Usage data
 */
async function writeUsageCache(usageData) {
    try {
        await fs.writeFile(USAGE_CACHE_FILE, JSON.stringify(usageData, null, 2), 'utf8');
        console.log('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
    } catch (error) {
        console.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * Read usage cache for specific provider type
 * @param {string} providerType - Provider type
 * @returns {Promise<Object|null>} Cached usage data
 */
async function readProviderUsageCache(providerType) {
    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true
        };
    }
    return null;
}

/**
 * Update usage cache for specific provider type
 * @param {string} providerType - Provider type
 * @param {Object} usageData - Usage data
 */
async function updateProviderUsageCache(providerType, usageData) {
    let cache = await readUsageCache();
    if (!cache) {
        cache = {
            timestamp: new Date().toISOString(),
            providers: {}
        };
    }
    cache.providers[providerType] = usageData;
    cache.timestamp = new Date().toISOString();
    await writeUsageCache(cache);
}

/**
 * Generate simple token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate token expiry time
 */
function getExpiryTime() {
    const now = Date.now();
    const expiry = 24 * 60 * 60 * 1000; // 24 hours
    return now + expiry;
}

/**
 * Verify token using Redis (Redis-only, no Postgres)
 */
async function verifyToken(token) {
    if (!token) return null;

    if (!redisClient.isAvailable()) {
        console.warn('[Auth] Redis not available, cannot verify token');
        return null;
    }

    try {
        const cached = await redisClient.getJSON(`${SESSION_CACHE_PREFIX}${token}`);
        if (!cached) return null;

        // Check if expired (redundant since Redis TTL handles this, but good for safety)
        if (Date.now() > cached.expiryTime) {
            await deleteToken(token);
            return null;
        }

        return cached;
    } catch (error) {
        console.error('[Auth] Token verification error:', error.message);
        return null;
    }
}

/**
 * Save token to Redis (Redis-only, no Postgres)
 */
async function saveToken(token, tokenInfo) {
    if (!redisClient.isAvailable()) {
        console.warn('[Auth] Redis not available, session will not persist');
        return;
    }

    try {
        await redisClient.setJSON(
            `${SESSION_CACHE_PREFIX}${token}`,
            tokenInfo,
            SESSION_CACHE_TTL
        );
        console.log('[Auth] Session saved to Redis');
    } catch (error) {
        console.error('[Auth] Failed to save session:', error.message);
        throw error;
    }
}

/**
 * Delete token from Redis (Redis-only, no Postgres)
 */
async function deleteToken(token) {
    if (!redisClient.isAvailable()) {
        console.warn('[Auth] Redis not available, cannot delete token');
        return;
    }

    try {
        await redisClient.del(`${SESSION_CACHE_PREFIX}${token}`);
        console.log('[Auth] Session removed from Redis');
    } catch (error) {
        console.error('[Auth] Failed to delete token:', error.message);
    }
}

/**
 * Default password (used when pwd file does not exist)
 */
const DEFAULT_PASSWORD = 'admin123';

/**
 * Read password file content
 * If file does not exist or read fails, return default password
 */
async function readPasswordFile() {
    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
    try {
        // Use async method to check file existence and read to avoid race conditions
        const password = await fs.readFile(pwdFilePath, 'utf8');
        const trimmedPassword = password.trim();
        // If password file is empty, use default password
        if (!trimmedPassword) {
            console.log('[Auth] Password file is empty, using default password: ' + DEFAULT_PASSWORD);
            return DEFAULT_PASSWORD;
        }
        console.log('[Auth] Successfully read password file');
        return trimmedPassword;
    } catch (error) {
        // ENOENT means file does not exist, which is normal
        if (error.code === 'ENOENT') {
            console.log('[Auth] Password file does not exist, using default password: ' + DEFAULT_PASSWORD);
        } else {
            console.error('[Auth] Failed to read password file:', error.code || error.message);
            console.log('[Auth] Using default password: ' + DEFAULT_PASSWORD);
        }
        return DEFAULT_PASSWORD;
    }
}

/**
 * Validate login credentials
 */
async function validateCredentials(password) {
    const storedPassword = await readPasswordFile();
    console.log('[Auth] Validating password, stored password length:', storedPassword ? storedPassword.length : 0, ', input password length:', password ? password.length : 0);
    const isValid = storedPassword && password === storedPassword;
    console.log('[Auth] Password validation result:', isValid);
    return isValid;
}

/**
 * Parse request body JSON
 */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                if (!body.trim()) {
                    resolve({});
                } else {
                    resolve(JSON.parse(body));
                }
            } catch (error) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Check token authentication
 */
async function checkAuth(req) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const token = authHeader.substring(7);
    const tokenInfo = await verifyToken(token);

    return tokenInfo !== null;
}

/**
 * Handle login request
 */
async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Only POST requests are supported' }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;
        
        if (!password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Password cannot be empty' }));
            return true;
        }

        const isValid = await validateCredentials(password);
        
        if (isValid) {
            // Generate simple token
            const token = generateToken();
            const expiryTime = getExpiryTime();
            
            // Store token info to local file
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: '24 hours'
            }));
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Incorrect password, please try again'
            }));
        }
    } catch (error) {
        console.error('[Auth] Login processing error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: error.message || 'Server error'
        }));
    }
    return true;
}

// Configure multer middleware
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            // When multer destination callback is called, req.body is not yet parsed, use default path first
            // The actual provider will be obtained from req.body after file upload completes
            const uploadPath = path.join(process.cwd(), 'configs', 'temp');
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${timestamp}_${sanitizedName}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['.json', '.txt', '.key', '.pem', '.p12', '.pfx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Unsupported file type'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

/**
 * Serve static files for the UI
 * @param {string} path - The request path
 * @param {http.ServerResponse} res - The HTTP response object
 */
export async function serveStaticFiles(pathParam, res) {
    const staticDir = path.join(process.cwd(), 'static');
    const requestedPath = pathParam === '/' || pathParam === '/index.html' ? 'index.html' : pathParam.replace('/static/', '');
    const filePath = path.join(staticDir, requestedPath);

    // Security: Ensure the resolved path is within the static directory
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(staticDir + path.sep) && resolvedPath !== staticDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return true;
    }

    if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.ico': 'image/x-icon',
            '.svg': 'image/svg+xml'
        }[ext] || 'text/plain';

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readFileSync(filePath));
        return true;
    }
    return false;
}

/**
 * Handle UI management API requests
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Promise<boolean>} - True if the request was handled by UI API
 */
/**
 * Reload configuration files
 * Dynamically import config-manager and reinitialize configuration
 * @returns {Promise<Object>} Returns the reloaded configuration object
 */
async function reloadConfig(providerPoolManager) {
    try {
        // Import config manager dynamically
        const { initializeConfig } = await import('./config-manager.js');
        
        // Reload main config
        const newConfig = await initializeConfig(process.argv.slice(2), 'configs/config.json');
        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = newConfig.providerPools;
            providerPoolManager.initializeProviderStatus();
        }
        
        // Update global CONFIG
        Object.assign(CONFIG, newConfig);
        console.log('[UI API] Configuration reloaded:');

        // Update initApiService - Clear and reinitialize service instances
        Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
        initApiService(CONFIG);
        
        console.log('[UI API] Configuration reloaded successfully');
        
        return newConfig;
    } catch (error) {
        console.error('[UI API] Failed to reload configuration:', error);
        throw error;
    }
}

export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
    // Handle login endpoint
    if (method === 'POST' && pathParam === '/api/login') {
        const handled = await handleLoginRequest(req, res);
        if (handled) return true;
    }

    // Handle logout endpoint
    if (method === 'POST' && pathParam === '/api/logout') {
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                await deleteToken(token);
                console.log('[Auth] Token invalidated via logout');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Logout successful'
            }));
            return true;
        } catch (error) {
            console.error('[Auth] Logout error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Logout failed'
            }));
            return true;
        }
    }

    // Health check endpoint (for frontend token verification)
    if (method === 'GET' && pathParam === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        return true;
    }

    // Handle UI management API requests (requires token verification, except login, health check and Events endpoints)
    if (pathParam.startsWith('/api/') && pathParam !== '/api/login' && pathParam !== '/api/health' && pathParam !== '/api/events') {
        // Check token authentication
        const isAuth = await checkAuth(req);
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: 'Unauthorized access, please login first',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // File upload API
    if (method === 'POST' && pathParam === '/api/upload-oauth-credentials') {
        const uploadMiddleware = upload.single('file');
        
        uploadMiddleware(req, res, async (err) => {
            if (err) {
                console.error('[UI API] File upload error:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: err.message || 'File upload failed'
                    }
                }));
                return;
            }

            try {
                if (!req.file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: 'No file was uploaded'
                        }
                    }));
                    return;
                }

                // After multer completes, form fields are parsed into req.body
                const provider = req.body.provider || 'common';
                const tempFilePath = req.file.path;

                // Move file to correct directory based on actual provider
                let targetDir = path.join(process.cwd(), 'configs', provider);

                await fs.mkdir(targetDir, { recursive: true });
                
                const targetFilePath = path.join(targetDir, req.file.filename);
                await fs.rename(tempFilePath, targetFilePath);
                
                const relativePath = path.relative(process.cwd(), targetFilePath);

                // Broadcast update event
                broadcastEvent('config_update', {
                    action: 'add',
                    filePath: relativePath,
                    provider: provider,
                    timestamp: new Date().toISOString()
                });

                console.log(`[UI API] OAuth credentials file uploaded: ${targetFilePath} (provider: ${provider})`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'File uploaded successfully',
                    filePath: relativePath,
                    originalName: req.file.originalname,
                    provider: provider
                }));

            } catch (error) {
                console.error('[UI API] File upload processing error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File upload processing failed: ' + error.message
                    }
                }));
            }
        });
        return true;
    }

    // Update admin password
    if (method === 'POST' && pathParam === '/api/admin-password') {
        try {
            const body = await getRequestBody(req);
            const { password } = body;

            if (!password || password.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Password cannot be empty'
                    }
                }));
                return true;
            }

            // Write password to pwd file
            const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
            await fs.writeFile(pwdFilePath, password.trim(), 'utf8');
            
            console.log('[UI API] Admin password updated successfully');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Admin password updated successfully'
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to update admin password:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to update password: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get configuration
    if (method === 'GET' && pathParam === '/api/config') {
        let systemPrompt = '';

        if (currentConfig.SYSTEM_PROMPT_FILE_PATH && existsSync(currentConfig.SYSTEM_PROMPT_FILE_PATH)) {
            try {
                systemPrompt = readFileSync(currentConfig.SYSTEM_PROMPT_FILE_PATH, 'utf-8');
            } catch (e) {
                console.warn('[UI API] Failed to read system prompt file:', e.message);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...currentConfig,
            systemPrompt
        }));
        return true;
    }

    // Update configuration
    if (method === 'POST' && pathParam === '/api/config') {
        try {
            const body = await getRequestBody(req);
            const newConfig = body;

            // Update config values in memory
            if (newConfig.REQUIRED_API_KEY !== undefined) currentConfig.REQUIRED_API_KEY = newConfig.REQUIRED_API_KEY;
            if (newConfig.HOST !== undefined) currentConfig.HOST = newConfig.HOST;
            if (newConfig.SERVER_PORT !== undefined) currentConfig.SERVER_PORT = newConfig.SERVER_PORT;
            if (newConfig.MODEL_PROVIDER !== undefined) currentConfig.MODEL_PROVIDER = newConfig.MODEL_PROVIDER;
            if (newConfig.PROJECT_ID !== undefined) currentConfig.PROJECT_ID = newConfig.PROJECT_ID;
            if (newConfig.OPENAI_API_KEY !== undefined) currentConfig.OPENAI_API_KEY = newConfig.OPENAI_API_KEY;
            if (newConfig.OPENAI_BASE_URL !== undefined) currentConfig.OPENAI_BASE_URL = newConfig.OPENAI_BASE_URL;
            if (newConfig.CLAUDE_API_KEY !== undefined) currentConfig.CLAUDE_API_KEY = newConfig.CLAUDE_API_KEY;
            if (newConfig.CLAUDE_BASE_URL !== undefined) currentConfig.CLAUDE_BASE_URL = newConfig.CLAUDE_BASE_URL;
            if (newConfig.GEMINI_OAUTH_CREDS_BASE64 !== undefined) currentConfig.GEMINI_OAUTH_CREDS_BASE64 = newConfig.GEMINI_OAUTH_CREDS_BASE64;
            if (newConfig.GEMINI_OAUTH_CREDS_FILE_PATH !== undefined) currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH = newConfig.GEMINI_OAUTH_CREDS_FILE_PATH;

            // Provider URLs
            if (newConfig.GEMINI_BASE_URL !== undefined) currentConfig.GEMINI_BASE_URL = newConfig.GEMINI_BASE_URL;
            if (newConfig.ANTIGRAVITY_BASE_URL_DAILY !== undefined) currentConfig.ANTIGRAVITY_BASE_URL_DAILY = newConfig.ANTIGRAVITY_BASE_URL_DAILY;
            if (newConfig.ANTIGRAVITY_BASE_URL_AUTOPUSH !== undefined) currentConfig.ANTIGRAVITY_BASE_URL_AUTOPUSH = newConfig.ANTIGRAVITY_BASE_URL_AUTOPUSH;
            if (newConfig.SYSTEM_PROMPT_FILE_PATH !== undefined) currentConfig.SYSTEM_PROMPT_FILE_PATH = newConfig.SYSTEM_PROMPT_FILE_PATH;
            if (newConfig.SYSTEM_PROMPT_MODE !== undefined) currentConfig.SYSTEM_PROMPT_MODE = newConfig.SYSTEM_PROMPT_MODE;
            if (newConfig.PROMPT_LOG_BASE_NAME !== undefined) currentConfig.PROMPT_LOG_BASE_NAME = newConfig.PROMPT_LOG_BASE_NAME;
            if (newConfig.PROMPT_LOG_MODE !== undefined) currentConfig.PROMPT_LOG_MODE = newConfig.PROMPT_LOG_MODE;
            if (newConfig.REQUEST_MAX_RETRIES !== undefined) currentConfig.REQUEST_MAX_RETRIES = newConfig.REQUEST_MAX_RETRIES;
            if (newConfig.REQUEST_BASE_DELAY !== undefined) currentConfig.REQUEST_BASE_DELAY = newConfig.REQUEST_BASE_DELAY;
            if (newConfig.CRON_NEAR_MINUTES !== undefined) currentConfig.CRON_NEAR_MINUTES = newConfig.CRON_NEAR_MINUTES;
            if (newConfig.CRON_REFRESH_TOKEN !== undefined) currentConfig.CRON_REFRESH_TOKEN = newConfig.CRON_REFRESH_TOKEN;
            if (newConfig.PROVIDER_POOLS_FILE_PATH !== undefined) currentConfig.PROVIDER_POOLS_FILE_PATH = newConfig.PROVIDER_POOLS_FILE_PATH;
            if (newConfig.MAX_ERROR_COUNT !== undefined) currentConfig.MAX_ERROR_COUNT = newConfig.MAX_ERROR_COUNT;
            if (newConfig.providerFallbackChain !== undefined) currentConfig.providerFallbackChain = newConfig.providerFallbackChain;

            // Auto health check configuration
            if (newConfig.QUICK_RETRY_INTERVAL_SECONDS !== undefined) currentConfig.QUICK_RETRY_INTERVAL_SECONDS = newConfig.QUICK_RETRY_INTERVAL_SECONDS;
            if (newConfig.QUICK_RETRY_MAX_COUNT !== undefined) currentConfig.QUICK_RETRY_MAX_COUNT = newConfig.QUICK_RETRY_MAX_COUNT;
            if (newConfig.RATE_LIMIT_CHECK_INTERVAL_HOURS !== undefined) currentConfig.RATE_LIMIT_CHECK_INTERVAL_HOURS = newConfig.RATE_LIMIT_CHECK_INTERVAL_HOURS;
            if (newConfig.STANDARD_CHECK_INTERVAL_HOURS !== undefined) currentConfig.STANDARD_CHECK_INTERVAL_HOURS = newConfig.STANDARD_CHECK_INTERVAL_HOURS;
            if (newConfig.AUTO_HEALTH_CHECK_ENABLED !== undefined) currentConfig.AUTO_HEALTH_CHECK_ENABLED = newConfig.AUTO_HEALTH_CHECK_ENABLED;

            // Handle system prompt update
            if (newConfig.systemPrompt !== undefined) {
                const promptPath = currentConfig.SYSTEM_PROMPT_FILE_PATH || 'configs/input_system_prompt.txt';
                try {
                    const relativePath = path.relative(process.cwd(), promptPath);
                    writeFileSync(promptPath, newConfig.systemPrompt, 'utf-8');

                    // Broadcast update event
                    broadcastEvent('config_update', {
                        action: 'update',
                        filePath: relativePath,
                        type: 'system_prompt',
                        timestamp: new Date().toISOString()
                    });
                    
                    console.log('[UI API] System prompt updated');
                } catch (e) {
                    console.warn('[UI API] Failed to write system prompt:', e.message);
                }
            }

            // Update config.json file
            try {
                const configPath = 'configs/config.json';
                
                // Create a clean config object for saving (exclude runtime-only properties)
                const configToSave = {
                    REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY,
                    SERVER_PORT: currentConfig.SERVER_PORT,
                    HOST: currentConfig.HOST,
                    MODEL_PROVIDER: currentConfig.MODEL_PROVIDER,
                    OPENAI_API_KEY: currentConfig.OPENAI_API_KEY,
                    OPENAI_BASE_URL: currentConfig.OPENAI_BASE_URL,
                    CLAUDE_API_KEY: currentConfig.CLAUDE_API_KEY,
                    CLAUDE_BASE_URL: currentConfig.CLAUDE_BASE_URL,
                    PROJECT_ID: currentConfig.PROJECT_ID,
                    GEMINI_OAUTH_CREDS_BASE64: currentConfig.GEMINI_OAUTH_CREDS_BASE64,
                    GEMINI_OAUTH_CREDS_FILE_PATH: currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH,
                    // Provider URLs
                    GEMINI_BASE_URL: currentConfig.GEMINI_BASE_URL,
                    ANTIGRAVITY_BASE_URL_DAILY: currentConfig.ANTIGRAVITY_BASE_URL_DAILY,
                    ANTIGRAVITY_BASE_URL_AUTOPUSH: currentConfig.ANTIGRAVITY_BASE_URL_AUTOPUSH,
                    SYSTEM_PROMPT_FILE_PATH: currentConfig.SYSTEM_PROMPT_FILE_PATH,
                    SYSTEM_PROMPT_MODE: currentConfig.SYSTEM_PROMPT_MODE,
                    PROMPT_LOG_BASE_NAME: currentConfig.PROMPT_LOG_BASE_NAME,
                    PROMPT_LOG_MODE: currentConfig.PROMPT_LOG_MODE,
                    REQUEST_MAX_RETRIES: currentConfig.REQUEST_MAX_RETRIES,
                    REQUEST_BASE_DELAY: currentConfig.REQUEST_BASE_DELAY,
                    CRON_NEAR_MINUTES: currentConfig.CRON_NEAR_MINUTES,
                    CRON_REFRESH_TOKEN: currentConfig.CRON_REFRESH_TOKEN,
                    PROVIDER_POOLS_FILE_PATH: currentConfig.PROVIDER_POOLS_FILE_PATH,
                    MAX_ERROR_COUNT: currentConfig.MAX_ERROR_COUNT,
                    providerFallbackChain: currentConfig.providerFallbackChain,
                    // Auto health check configuration
                    QUICK_RETRY_INTERVAL_SECONDS: currentConfig.QUICK_RETRY_INTERVAL_SECONDS,
                    QUICK_RETRY_MAX_COUNT: currentConfig.QUICK_RETRY_MAX_COUNT,
                    RATE_LIMIT_CHECK_INTERVAL_HOURS: currentConfig.RATE_LIMIT_CHECK_INTERVAL_HOURS,
                    STANDARD_CHECK_INTERVAL_HOURS: currentConfig.STANDARD_CHECK_INTERVAL_HOURS,
                    AUTO_HEALTH_CHECK_ENABLED: currentConfig.AUTO_HEALTH_CHECK_ENABLED
                };

                writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
                console.log('[UI API] Configuration saved to configs/config.json');

                // Broadcast update event
                broadcastEvent('config_update', {
                    action: 'update',
                    filePath: 'configs/config.json',
                    type: 'main_config',
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('[UI API] Failed to save configuration to file:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Failed to save configuration to file: ' + error.message,
                        partial: true  // Indicate that memory config was updated but not saved
                    }
                }));
                return true;
            }

            // Update the global CONFIG object to reflect changes immediately
            Object.assign(CONFIG, currentConfig);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Configuration updated successfully',
                details: 'Configuration has been updated in both memory and config.json file'
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get system information
    if (method === 'GET' && pathParam === '/api/system') {
        const memUsage = process.memoryUsage();

        // Read version from package.json
        let appVersion = 'unknown';
        try {
            const packageJsonPath = path.join(process.cwd(), 'package.json');
            if (existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
                appVersion = packageJson.version || 'unknown';
            }
        } catch (error) {
            console.warn('[UI API] Failed to read package.json:', error.message);
        }

        // Calculate CPU usage
        const cpuUsage = getCpuUsagePercent();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            appVersion: appVersion,
            nodeVersion: process.version,
            serverTime: new Date().toLocaleString(),
            memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
            cpuUsage: cpuUsage,
            uptime: process.uptime()
        }));
        return true;
    }

    // Get provider pools summary
    if (method === 'GET' && pathParam === '/api/providers') {
        let providerPools = {};
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        try {
            if (providerPoolManager && providerPoolManager.providerPools) {
                providerPools = providerPoolManager.providerPools;
            } else if (filePath && existsSync(filePath)) {
                const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
                providerPools = poolsData;
            }
        } catch (error) {
            console.warn('[UI API] Failed to load provider pools:', error.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(providerPools));
        return true;
    }

    // Get specific provider type details
    const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
    if (method === 'GET' && providerTypeMatch) {
        const providerType = decodeURIComponent(providerTypeMatch[1]);
        let providerPools = {};
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        try {
            if (providerPoolManager && providerPoolManager.providerPools) {
                providerPools = providerPoolManager.providerPools;
            } else if (filePath && existsSync(filePath)) {
                const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
                providerPools = poolsData;
            }
        } catch (error) {
            console.warn('[UI API] Failed to load provider pools:', error.message);
        }

        const providers = providerPools[providerType] || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            providerType,
            providers,
            totalCount: providers.length,
            healthyCount: providers.filter(p => p.isHealthy).length
        }));
        return true;
    }

    // Get available models for all providers or specific provider type
    if (method === 'GET' && pathParam === '/api/provider-models') {
        const allModels = getAllProviderModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(allModels));
        return true;
    }

    // Get available models for a specific provider type
    const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
    if (method === 'GET' && providerModelsMatch) {
        const providerType = decodeURIComponent(providerModelsMatch[1]);
        const models = getProviderModels(providerType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            providerType,
            models
        }));
        return true;
    }

    // Add new provider configuration
    if (method === 'POST' && pathParam === '/api/providers') {
        try {
            const body = await getRequestBody(req);
            const { providerType, providerConfig } = body;

            if (!providerType || !providerConfig) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'providerType and providerConfig are required' } }));
                return true;
            }

            // Generate UUID if not provided
            if (!providerConfig.uuid) {
                providerConfig.uuid = generateUUID();
            }

            // Set default values
            providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
            providerConfig.lastUsed = providerConfig.lastUsed || null;
            providerConfig.usageCount = providerConfig.usageCount || 0;
            providerConfig.errorCount = providerConfig.errorCount || 0;
            providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    console.warn('[UI API] Failed to read existing provider pools:', readError.message);
                }
            }

            // Add new provider to the appropriate type
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }
            providerPools[providerType].push(providerConfig);

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'add',
                filePath: filePath,
                providerType,
                providerConfig,
                timestamp: new Date().toISOString()
            });

            // Broadcast provider update event
            broadcastEvent('provider_update', {
                action: 'add',
                providerType,
                providerConfig,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Provider added successfully',
                provider: providerConfig,
                providerType
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Update specific provider configuration
    const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
    if (method === 'PUT' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];

        try {
            const body = await getRequestBody(req);
            const { providerConfig } = body;

            if (!providerConfig) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'providerConfig is required' } }));
                return true;
            }

            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Find and update the provider
            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
            
            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            // Update provider while preserving certain fields
            const existingProvider = providers[providerIndex];
            const updatedProvider = {
                ...existingProvider,
                ...providerConfig,
                uuid: providerUuid, // Ensure UUID doesn't change
                lastUsed: existingProvider.lastUsed, // Preserve usage stats
                usageCount: existingProvider.usageCount,
                errorCount: existingProvider.errorCount,
                lastErrorTime: existingProvider.lastErrorTime
            };

            providerPools[providerType][providerIndex] = updatedProvider;

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Updated provider ${providerUuid} in ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'update',
                filePath: filePath,
                providerType,
                providerConfig: updatedProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Provider updated successfully',
                provider: updatedProvider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Delete specific provider configuration
    if (method === 'DELETE' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            let providerPools = {};

            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Find and remove the provider
            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);

            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            const deletedProvider = providers[providerIndex];
            providers.splice(providerIndex, 1);

            // Remove the entire provider type if no providers left
            if (providers.length === 0) {
                delete providerPools[providerType];
            }

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'delete',
                filePath: filePath,
                providerType,
                providerConfig: deletedProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Provider deleted successfully',
                deletedProvider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Disable/Enable specific provider configuration
    const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
    if (disableEnableProviderMatch) {
        const providerType = decodeURIComponent(disableEnableProviderMatch[1]);
        const providerUuid = disableEnableProviderMatch[2];
        const action = disableEnableProviderMatch[3];

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Find and update the provider
            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
            
            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            // Update isDisabled field
            const provider = providers[providerIndex];
            provider.isDisabled = action === 'disable';
            
            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;

                // Call the appropriate method
                if (action === 'disable') {
                    providerPoolManager.disableProvider(providerType, provider);
                } else {
                    providerPoolManager.enableProvider(providerType, provider);
                }
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: action,
                filePath: filePath,
                providerType,
                providerConfig: provider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Provider ${action}d successfully`,
                provider: provider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Reset all providers health status for a specific provider type
    const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetHealthMatch) {
        const providerType = decodeURIComponent(resetHealthMatch[1]);

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            let providerPools = {};

            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Reset health status for all providers of this type
            const providers = providerPools[providerType] || [];

            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
                return true;
            }

            let resetCount = 0;
            providers.forEach(provider => {
                if (!provider.isHealthy) {
                    provider.isHealthy = true;
                    provider.errorCount = 0;
                    provider.lastErrorTime = null;
                    resetCount++;
                }
            });

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Reset health status for ${resetCount} providers in ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'reset_health',
                filePath: filePath,
                providerType,
                resetCount,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Successfully reset health status for ${resetCount} providers`,
                resetCount,
                totalCount: providers.length
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Perform health check for all providers of a specific type
    const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
    if (method === 'POST' && healthCheckMatch) {
        const providerType = decodeURIComponent(healthCheckMatch[1]);

        try {
            if (!providerPoolManager) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            const providers = providerPoolManager.providerStatus[providerType] || [];
            
            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
                return true;
            }

            console.log(`[UI API] Starting health check for ${providers.length} providers in ${providerType}`);

            // Execute health check (force check, ignore checkHealth config)
            const results = [];
            for (const providerStatus of providers) {
                const providerConfig = providerStatus.config;
                try {
                    // Pass forceCheck = true to force health check, ignoring checkHealth config
                    const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);
                    
                    if (healthResult === null) {
                        results.push({
                            uuid: providerConfig.uuid,
                            success: null,
                            message: 'Health check not supported for this provider type'
                        });
                        continue;
                    }
                    
                    if (healthResult.success) {
                        providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
                        results.push({
                            uuid: providerConfig.uuid,
                            success: true,
                            modelName: healthResult.modelName,
                            message: 'Healthy'
                        });
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerType, providerConfig, healthResult.errorMessage);
                        providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                        if (healthResult.modelName) {
                            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                        }
                        results.push({
                            uuid: providerConfig.uuid,
                            success: false,
                            modelName: healthResult.modelName,
                            message: healthResult.errorMessage || 'Check failed'
                        });
                    }
                } catch (error) {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig, error.message);
                    results.push({
                        uuid: providerConfig.uuid,
                        success: false,
                        message: error.message
                    });
                }
            }

            // Save updated status to file
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';

            // Build providerPools object from providerStatus and save
            const providerPools = {};
            for (const pType in providerPoolManager.providerStatus) {
                providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
            }
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');

            const successCount = results.filter(r => r.success === true).length;
            const failCount = results.filter(r => r.success === false).length;

            console.log(`[UI API] Health check completed for ${providerType}: ${successCount} healthy, ${failCount} unhealthy`);

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'health_check',
                filePath: filePath,
                providerType,
                results,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
                successCount,
                failCount,
                totalCount: providers.length,
                results
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Health check error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Generate OAuth authorization URL for providers
    const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
    if (method === 'POST' && generateAuthUrlMatch) {
        const providerType = decodeURIComponent(generateAuthUrlMatch[1]);
        
        try {
            let authUrl = '';
            let authInfo = {};

            // Parse options
            let options = {};
            try {
                options = await getRequestBody(req);
            } catch (e) {
                // If no request body, use default empty object
            }

            // Generate auth URL and start callback server based on provider type
            if (providerType === 'gemini-cli-oauth') {
                const result = await handleGeminiCliOAuth(currentConfig, options);
                authUrl = result.authUrl;
                authInfo = result.authInfo;
            } else if (providerType === 'gemini-antigravity') {
                const result = await handleGeminiAntigravityOAuth(currentConfig, options);
                authUrl = result.authUrl;
                authInfo = result.authInfo;
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: `Unsupported provider type: ${providerType}`
                    }
                }));
                return true;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                authUrl: authUrl,
                authInfo: authInfo
            }));
            return true;
            
        } catch (error) {
            console.error(`[UI API] Failed to generate auth URL for ${providerType}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Failed to generate auth URL: ${error.message}`
                }
            }));
            return true;
        }
    }

    // Server-Sent Events for real-time updates
    if (method === 'GET' && pathParam === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        res.write('\n');

        // Store the response object for broadcasting
        if (!global.eventClients) {
            global.eventClients = [];
        }
        global.eventClients.push(res);

        // Keep connection alive
        const keepAlive = setInterval(() => {
            res.write(':\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            global.eventClients = global.eventClients.filter(r => r !== res);
        });

        return true;
    }

    // Get upload configuration files list
    if (method === 'GET' && pathParam === '/api/upload-configs') {
        try {
            const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(configFiles));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to scan config files:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to scan config files: ' + error.message
                }
            }));
            return true;
        }
    }

    // View specific configuration file
    const viewConfigMatch = pathParam.match(/^\/api\/upload-configs\/view\/(.+)$/);
    if (method === 'GET' && viewConfigMatch) {
        try {
            const filePath = decodeURIComponent(viewConfigMatch[1]);
            const fullPath = path.join(process.cwd(), filePath);
            
            // Security check: ensure file path is within allowed directories
            const allowedDirs = ['configs'];
            const relativePath = path.relative(process.cwd(), fullPath);
            const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
            
            if (!isAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Access denied: can only view files in configs directory'
                    }
                }));
                return true;
            }
            
            if (!existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File does not exist'
                    }
                }));
                return true;
            }
            
            const content = await fs.readFile(fullPath, 'utf8');
            const stats = await fs.stat(fullPath);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                path: relativePath,
                content: content,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                name: path.basename(fullPath)
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to view config file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to view config file: ' + error.message
                }
            }));
            return true;
        }
    }

    // Delete specific configuration file
    const deleteConfigMatch = pathParam.match(/^\/api\/upload-configs\/delete\/(.+)$/);
    if (method === 'DELETE' && deleteConfigMatch) {
        try {
            const filePath = decodeURIComponent(deleteConfigMatch[1]);
            const fullPath = path.join(process.cwd(), filePath);
            
            // Security check: ensure file path is within allowed directories
            const allowedDirs = ['configs'];
            const relativePath = path.relative(process.cwd(), fullPath);
            const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);

            if (!isAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Access denied: can only delete files in configs directory'
                    }
                }));
                return true;
            }
            
            if (!existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'File does not exist'
                    }
                }));
                return true;
            }
            

            await fs.unlink(fullPath);

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'delete',
                filePath: relativePath,
                timestamp: new Date().toISOString()
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'File deleted successfully',
                filePath: relativePath
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to delete config file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to delete config file: ' + error.message
                }
            }));
            return true;
        }
    }

    // Download all configs as zip
    if (method === 'GET' && pathParam === '/api/upload-configs/download-all') {
        try {
            const configsPath = path.join(process.cwd(), 'configs');
            if (!existsSync(configsPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'configs directory does not exist' } }));
                return true;
            }

            const zip = new AdmZip();
            
            // Recursive function to add directory
            const addDirectoryToZip = async (dirPath, zipPath = '') => {
                const items = await fs.readdir(dirPath, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(dirPath, item.name);
                    const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;
                    
                    if (item.isFile()) {
                        const content = await fs.readFile(fullPath);
                        zip.addFile(itemZipPath.replace(/\\/g, '/'), content);
                    } else if (item.isDirectory()) {
                        await addDirectoryToZip(fullPath, itemZipPath);
                    }
                }
            };

            await addDirectoryToZip(configsPath);
            
            const zipBuffer = zip.toBuffer();
            const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': zipBuffer.length
            });
            res.end(zipBuffer);
            
            console.log(`[UI API] All configs downloaded as zip: ${filename}`);
            return true;
        } catch (error) {
            console.error('[UI API] Failed to download all configs:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to download zip: ' + error.message
                }
            }));
            return true;
        }
    }

    // Quick link config to corresponding provider based on directory
    if (method === 'POST' && pathParam === '/api/quick-link-provider') {
        try {
            const body = await getRequestBody(req);
            const { filePath } = body;

            if (!filePath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'filePath is required' } }));
                return true;
            }

            const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
            
            // Auto-detect provider type based on file path
            const providerMapping = detectProviderFromPath(normalizedPath);
            
            if (!providerMapping) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Unable to identify provider type for config file, please ensure file is in configs/gemini/ or configs/antigravity/ directory'
                    }
                }));
                return true;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName } = providerMapping;
            const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            
            // Load existing pools
            let providerPools = {};
            if (existsSync(poolsFilePath)) {
                try {
                    const fileContent = readFileSync(poolsFilePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    console.warn('[UI API] Failed to read existing provider pools:', readError.message);
                }
            }

            // Ensure provider type array exists
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }

            // Check if already linked - use normalized paths for comparison
            const normalizedForComparison = filePath.replace(/\\/g, '/');
            const isAlreadyLinked = providerPools[providerType].some(p => {
                const existingPath = p[credPathKey];
                if (!existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                       normalizedExistingPath === './' + normalizedForComparison ||
                       './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'This config file is already linked' } }));
                return true;
            }

            // Create new provider config based on provider type
            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(filePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId
            });

            providerPools[providerType].push(newProvider);

            // Save to file
            writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Quick linked config: ${filePath} -> ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'quick_link',
                filePath: poolsFilePath,
                providerType,
                newProvider,
                timestamp: new Date().toISOString()
            });

            broadcastEvent('provider_update', {
                action: 'add',
                providerType,
                providerConfig: newProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Config successfully linked to ${displayName}`,
                provider: newProvider,
                providerType: providerType
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Quick link failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Link failed: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get usage limits for all providers
    if (method === 'GET' && pathParam === '/api/usage') {
        try {
            // Parse query parameters, check if force refresh is needed
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';
            
            let usageResults;
            
            if (!refresh) {
                // Prefer reading from cache
                const cachedData = await readUsageCache();
                if (cachedData) {
                    console.log('[Usage API] Returning cached usage data');
                    usageResults = { ...cachedData, fromCache: true };
                }
            }
            
            if (!usageResults) {
                // Cache does not exist or refresh required, re-query
                console.log('[Usage API] Fetching fresh usage data');
                usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
                // Write to cache
                await writeUsageCache(usageResults);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usageResults));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to get usage:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to get usage info: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get usage limits for a specific provider type
    const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
    if (method === 'GET' && usageProviderMatch) {
        const providerType = decodeURIComponent(usageProviderMatch[1]);
        try {
            // Parse query parameters, check if force refresh is needed
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';
            
            let usageResults;
            
            if (!refresh) {
                // Prefer reading from cache
                const cachedData = await readProviderUsageCache(providerType);
                if (cachedData) {
                    console.log(`[Usage API] Returning cached usage data for ${providerType}`);
                    usageResults = cachedData;
                }
            }
            
            if (!usageResults) {
                // Cache does not exist or refresh required, re-query
                console.log(`[Usage API] Fetching fresh usage data for ${providerType}`);
                usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
                // Update cache
                await updateProviderUsageCache(providerType, usageResults);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usageResults));
            return true;
        } catch (error) {
            console.error(`[UI API] Failed to get usage for ${providerType}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Failed to get usage info for ${providerType}: ` + error.message
                }
            }));
            return true;
        }
    }

    // Reload configuration files
    if (method === 'POST' && pathParam === '/api/reload-config') {
        try {
            // Call reload config function
            const newConfig = await reloadConfig(providerPoolManager);
            
            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'reload',
                filePath: 'configs/config.json',
                providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
                timestamp: new Date().toISOString()
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Configuration files reloaded successfully',
                details: {
                    configReloaded: true,
                    configPath: 'configs/config.json',
                    providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null
                }
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to reload config files:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to reload configuration files: ' + error.message
                }
            }));
            return true;
        }
    }

    // Restart service (worker process)
    // Restart service endpoint - supports master-worker process architecture
    if (method === 'POST' && pathParam === '/api/restart-service') {
        try {
            const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
            
            if (IS_WORKER_PROCESS && process.send) {
                // Running as worker process, notify master process to restart
                console.log('[UI API] Requesting restart from master process...');
                process.send({ type: 'restart_request' });
                
                // Broadcast restart event
                broadcastEvent('service_restart', {
                    action: 'restart_requested',
                    timestamp: new Date().toISOString(),
                    message: 'Service restart requested, worker will be restarted by master process'
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'Restart request sent to master process',
                    mode: 'worker',
                    details: {
                        workerPid: process.pid,
                        restartMethod: 'master_controlled'
                    }
                }));
            } else {
                // Standalone mode, cannot auto-restart
                console.log('[UI API] Service is running in standalone mode, cannot auto-restart');
                
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'Service is running in standalone mode. Please use master.js to enable auto-restart feature.',
                    mode: 'standalone',
                    hint: 'Start the service with: node src/master.js [args]'
                }));
            }
            return true;
        } catch (error) {
            console.error('[UI API] Failed to restart service:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to restart service: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get service mode information
    // Get service running mode info
    if (method === 'GET' && pathParam === '/api/service-mode') {
        const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
        const masterPort = process.env.MASTER_PORT || 3100;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            mode: IS_WORKER_PROCESS ? 'worker' : 'standalone',
            pid: process.pid,
            ppid: process.ppid,
            uptime: process.uptime(),
            canAutoRestart: IS_WORKER_PROCESS && !!process.send,
            masterPort: IS_WORKER_PROCESS ? masterPort : null,
            nodeVersion: process.version,
            platform: process.platform
        }));
        return true;
    }

    // ===== METRICS API ENDPOINTS =====

    // Get metrics overview (dashboard cards)
    if (method === 'GET' && pathParam === '/api/metrics/overview') {
        try {
            const overview = await metricsService.getOverview();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(overview));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get overview:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get requests time series
    if (method === 'GET' && pathParam === '/api/metrics/requests') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const range = url.searchParams.get('range') || '24h';
            const data = await metricsService.getRequestsTimeSeries(range);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get requests data:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get latency statistics
    if (method === 'GET' && pathParam === '/api/metrics/latency') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const range = url.searchParams.get('range') || '24h';
            const data = await metricsService.getLatencyStats(range);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get latency stats:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get error statistics
    if (method === 'GET' && pathParam === '/api/metrics/errors') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const range = url.searchParams.get('range') || '24h';
            const data = await metricsService.getErrorStats(range);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get error stats:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get token usage statistics
    if (method === 'GET' && pathParam === '/api/metrics/tokens') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const range = url.searchParams.get('range') || '24h';
            const data = await metricsService.getTokenStats(range);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get token stats:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get provider health timeline
    if (method === 'GET' && pathParam === '/api/metrics/providers/health-timeline') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const range = url.searchParams.get('range') || '24h';
            const data = await metricsService.getHealthTimeline(range);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get health timeline:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get provider load distribution
    if (method === 'GET' && pathParam === '/api/metrics/providers/load') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const range = url.searchParams.get('range') || '24h';
            const data = await metricsService.getProviderLoad(range);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('[Metrics API] Failed to get provider load:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get cache statistics
    if (method === 'GET' && pathParam === '/api/cache/stats') {
        try {
            const stats = await cacheService.getCacheStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
            return true;
        } catch (error) {
            console.error('[Cache API] Failed to get cache stats:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Clear cache
    if (method === 'POST' && pathParam === '/api/cache/clear') {
        try {
            const count = await cacheService.clearCache();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, clearedCount: count }));
            return true;
        } catch (error) {
            console.error('[Cache API] Failed to clear cache:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    return false;
}

/**
 * Initialize UI management features
 */
export function initializeUIManagement() {
    // Initialize log broadcasting for UI
    if (!global.eventClients) {
        global.eventClients = [];
    }
    if (!global.logBuffer) {
        global.logBuffer = [];
    }

    // Override console.log to broadcast logs
    const originalLog = console.log;
    console.log = function(...args) {
        originalLog.apply(console, args);
        const message = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch (e) {
                if (arg instanceof Error) {
                    return `[Error: ${arg.message}] ${arg.stack || ''}`;
                }
                return `[Object: ${Object.prototype.toString.call(arg)}] (Circular or too complex to stringify)`;
            }
        }).join(' ');
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: message
        };
        global.logBuffer.push(logEntry);
        if (global.logBuffer.length > 100) {
            global.logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };

    // Override console.error to broadcast errors
    const originalError = console.error;
    console.error = function(...args) {
        originalError.apply(console, args);
        const message = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch (e) {
                if (arg instanceof Error) {
                    return `[Error: ${arg.message}] ${arg.stack || ''}`;
                }
                return `[Object: ${Object.prototype.toString.call(arg)}] (Circular or too complex to stringify)`;
            }
        }).join(' ');
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: message
        };
        global.logBuffer.push(logEntry);
        if (global.logBuffer.length > 100) {
            global.logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };
}

/**
 * Helper function to broadcast events to UI clients
 * @param {string} eventType - The type of event
 * @param {any} data - The data to broadcast
 */
export function broadcastEvent(eventType, data) {
    if (global.eventClients && global.eventClients.length > 0) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        global.eventClients.forEach(client => {
            client.write(`event: ${eventType}\n`);
            client.write(`data: ${payload}\n\n`);
        });
    }
}

/**
 * Scan and analyze configuration files
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - Provider pool manager instance
 * @returns {Promise<Array>} Array of configuration file objects
 */
async function scanConfigFiles(currentConfig, providerPoolManager) {
    const configFiles = [];
    
    // Only scan configs directory
    const configsPath = path.join(process.cwd(), 'configs');
    
    if (!existsSync(configsPath)) {
        // console.log('[Config Scanner] configs directory not found, creating empty result');
        return configFiles;
    }

    const usedPaths = new Set(); // Store used paths for determining association status

    // Extract all OAuth credentials file paths from config - normalize path format
    addToUsedPaths(usedPaths, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH);

    // Use latest provider pool data
    let providerPools = currentConfig.providerPools;
    if (providerPoolManager && providerPoolManager.providerPools) {
        providerPools = providerPoolManager.providerPools;
    }

    // Check all OAuth credentials paths in provider pools file - normalize path format
    if (providerPools) {
        for (const [providerType, providers] of Object.entries(providerPools)) {
            for (const provider of providers) {
                addToUsedPaths(usedPaths, provider.GEMINI_OAUTH_CREDS_FILE_PATH);
                addToUsedPaths(usedPaths, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH);
            }
        }
    }

    try {
        // Scan all subdirectories and files under configs directory
        const configsFiles = await scanOAuthDirectory(configsPath, usedPaths, currentConfig);
        configFiles.push(...configsFiles);
    } catch (error) {
        console.warn(`[Config Scanner] Failed to scan configs directory:`, error.message);
    }

    return configFiles;
}

/**
 * Analyze OAuth configuration file and return metadata
 * @param {string} filePath - Full path to the file
 * @param {Set} usedPaths - Set of paths currently in use
 * @returns {Promise<Object|null>} OAuth file information object
 */
async function analyzeOAuthFile(filePath, usedPaths, currentConfig) {
    try {
        const stats = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const filename = path.basename(filePath);
        const relativePath = path.relative(process.cwd(), filePath);
        
        // Read file content for analysis
        let content = '';
        let type = 'oauth_credentials';
        let isValid = true;
        let errorMessage = '';
        let oauthProvider = 'unknown';
        let usageInfo = getFileUsageInfo(relativePath, filename, usedPaths, currentConfig);
        
        try {
            if (ext === '.json') {
                const rawContent = await fs.readFile(filePath, 'utf8');
                const jsonData = JSON.parse(rawContent);
                content = rawContent;
                
                // Identify OAuth provider
                if (jsonData.apiKey || jsonData.api_key) {
                    type = 'api_key';
                } else if (jsonData.client_id || jsonData.client_secret) {
                    oauthProvider = 'oauth2';
                } else if (jsonData.access_token || jsonData.refresh_token) {
                    oauthProvider = 'token_based';
                } else if (jsonData.credentials) {
                    oauthProvider = 'service_account';
                }
                
                if (jsonData.base_url || jsonData.endpoint) {
                    if (jsonData.base_url.includes('openai.com')) {
                        oauthProvider = 'openai';
                    } else if (jsonData.base_url.includes('anthropic.com')) {
                        oauthProvider = 'claude';
                    } else if (jsonData.base_url.includes('googleapis.com')) {
                        oauthProvider = 'gemini';
                    }
                }
            } else {
                content = await fs.readFile(filePath, 'utf8');
                
                if (ext === '.key' || ext === '.pem') {
                    if (content.includes('-----BEGIN') && content.includes('PRIVATE KEY-----')) {
                        oauthProvider = 'private_key';
                    }
                } else if (ext === '.txt') {
                    if (content.includes('api_key') || content.includes('apikey')) {
                        oauthProvider = 'api_key';
                    }
                } else if (ext === '.oauth' || ext === '.creds') {
                    oauthProvider = 'oauth_credentials';
                }
            }
        } catch (readError) {
            isValid = false;
            errorMessage = `Unable to read file: ${readError.message}`;
        }
        
        return {
            name: filename,
            path: relativePath,
            size: stats.size,
            type: type,
            provider: oauthProvider,
            extension: ext,
            modified: stats.mtime.toISOString(),
            isValid: isValid,
            errorMessage: errorMessage,
            isUsed: isPathUsed(relativePath, filename, usedPaths),
            usageInfo: usageInfo, // Added detailed association info
            preview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
        };
    } catch (error) {
        console.warn(`[OAuth Analyzer] Failed to analyze file ${filePath}:`, error.message);
        return null;
    }
}

/**
 * Get detailed usage information for a file
 * @param {string} relativePath - Relative file path
 * @param {string} fileName - File name
 * @param {Set} usedPaths - Set of used paths
 * @param {Object} currentConfig - Current configuration
 * @returns {Object} Usage information object
 */
function getFileUsageInfo(relativePath, fileName, usedPaths, currentConfig) {
    const usageInfo = {
        isUsed: false,
        usageType: null,
        usageDetails: []
    };

    // Check if being used
    const isUsed = isPathUsed(relativePath, fileName, usedPaths);
    if (!isUsed) {
        return usageInfo;
    }

    usageInfo.isUsed = true;

    // Check usage in main config
    if (currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH &&
        (pathsEqual(relativePath, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH) ||
         pathsEqual(relativePath, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
        usageInfo.usageType = 'main_config';
        usageInfo.usageDetails.push({
            type: 'Main Config',
            location: 'Gemini OAuth credentials file path',
            configKey: 'GEMINI_OAUTH_CREDS_FILE_PATH'
        });
    }

    // Check usage in provider pools
    if (currentConfig.providerPools) {
        // Use flatMap to optimize double loop to single loop O(n)
        const allProviders = Object.entries(currentConfig.providerPools).flatMap(
            ([providerType, providers]) =>
                providers.map((provider, index) => ({ provider, providerType, index }))
        );

        for (const { provider, providerType, index } of allProviders) {
            const providerUsages = [];

            if (provider.GEMINI_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.GEMINI_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.GEMINI_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: 'Provider Pool',
                    location: `Gemini OAuth credentials (node ${index + 1})`,
                    providerType: providerType,
                    providerIndex: index,
                    configKey: 'GEMINI_OAUTH_CREDS_FILE_PATH'
                });
            }

            if (provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: 'Provider Pool',
                    location: `Antigravity OAuth credentials (node ${index + 1})`,
                    providerType: providerType,
                    providerIndex: index,
                    configKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH'
                });
            }
            
            if (providerUsages.length > 0) {
                usageInfo.usageType = 'provider_pool';
                usageInfo.usageDetails.push(...providerUsages);
            }
        }
    }

    // If there are multiple usage locations, mark as multiple purposes
    if (usageInfo.usageDetails.length > 1) {
        usageInfo.usageType = 'multiple';
    }

    return usageInfo;
}

/**
 * Scan OAuth directory for credential files
 * @param {string} dirPath - Directory path to scan
 * @param {Set} usedPaths - Set of used paths
 * @param {Object} currentConfig - Current configuration
 * @returns {Promise<Array>} Array of OAuth configuration file objects
 */
async function scanOAuthDirectory(dirPath, usedPaths, currentConfig) {
    const oauthFiles = [];
    
    try {
        const files = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);
            
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // Only focus on OAuth-related file types
                if (['.json', '.oauth', '.creds', '.key', '.pem', '.txt'].includes(ext)) {
                    const fileInfo = await analyzeOAuthFile(fullPath, usedPaths, currentConfig);
                    if (fileInfo) {
                        oauthFiles.push(fileInfo);
                    }
                }
            } else if (file.isDirectory()) {
                // Recursively scan subdirectories (limit depth)
                const relativePath = path.relative(process.cwd(), fullPath);
                // Max depth 4 levels, to support structures like configs/gemini/{subfolder}/file.json
                if (relativePath.split(path.sep).length < 4) {
                    const subFiles = await scanOAuthDirectory(fullPath, usedPaths, currentConfig);
                    oauthFiles.push(...subFiles);
                }
            }
        }
    } catch (error) {
        console.warn(`[OAuth Scanner] Failed to scan directory ${dirPath}:`, error.message);
    }
    
    return oauthFiles;
}


// Note: normalizePath, getFileName, pathsEqual, isPathUsed, detectProviderFromPath
// have been moved to provider-utils.js common module

/**
 * Get usage info for all providers that support usage queries
 * @param {Object} currentConfig - Current configuration
 * @param {Object} providerPoolManager - Provider pool manager
 * @returns {Promise<Object>} Usage info for all providers
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // List of providers that support usage queries
    const supportedProviders = ['gemini-cli-oauth', 'gemini-antigravity'];

    // Concurrently get usage data for all providers
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // Wait for all concurrent requests to complete
    const usageResults = await Promise.all(usagePromises);

    // Integrate results into results.providers
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * Get usage info for specified provider type
 * @param {string} providerType - Provider type
 * @param {Object} currentConfig - Current configuration
 * @param {Object} providerPoolManager - Provider pool manager
 * @returns {Promise<Object>} Provider usage info
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // Get all instances from provider pool
    let providers = [];
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        providers = providerPoolManager.providerPools[providerType];
    } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        providers = currentConfig.providerPools[providerType];
    }

    result.totalCount = providers.length;

    // Iterate through all provider instances to get usage
    for (const provider of providers) {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];
        
        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        // First check if disabled, skip initialization for disabled providers
        if (provider.isDisabled) {
            instanceResult.error = 'Provider is disabled';
            result.errorCount++;
        } else if (!adapter) {
            // Service instance not initialized, try auto-initialization
            try {
                console.log(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                // Build configuration object
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                console.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                result.errorCount++;
            }
        }
        
        // If adapter exists (including just initialized), and no error, try to get usage
        if (adapter && !instanceResult.error) {
            try {
                const usage = await getAdapterUsage(adapter, providerType);
                instanceResult.success = true;
                instanceResult.usage = usage;
                result.successCount++;
            } catch (error) {
                instanceResult.error = error.message;
                result.errorCount++;
            }
        }

        result.instances.push(instanceResult);
    }

    return result;
}

/**
 * Get usage info from adapter
 * @param {Object} adapter - Service adapter
 * @param {string} providerType - Provider type
 * @returns {Promise<Object>} Usage info
 */
async function getAdapterUsage(adapter, providerType) {
    if (providerType === 'gemini-cli-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.geminiApiService.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-antigravity') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.antigravityApiService.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    throw new Error(`Unsupported provider type: ${providerType}`);
}

/**
 * Get provider display name
 * @param {Object} provider - Provider configuration
 * @param {string} providerType - Provider type
 * @returns {string} Display name
 */
function getProviderDisplayName(provider, providerType) {
    // Claude Code uses customName directly
    if (providerType === 'claudeCode-custom') {
        return provider.customName || provider.uuid || 'Claude Code CLI';
    }

    // Try to extract name from credentials file path
    const credPathKey = {
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH'
    }[providerType];

    if (credPathKey && provider[credPathKey]) {
        const filePath = provider[credPathKey];
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return provider.uuid || 'Unnamed';
}
