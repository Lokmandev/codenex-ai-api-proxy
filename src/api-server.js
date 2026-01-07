import * as http from 'http';
import { initializeConfig, CONFIG, logProviderSpecificDetails } from './config-manager.js';
import { initApiService, autoLinkProviderConfigs } from './service-manager.js';
import { initializeUIManagement } from './ui-manager.js';
import { initializeAPIManagement } from './api-manager.js';
import { createRequestHandler } from './request-handler.js';
import redisClient from './redis-client.js';
import { initializePostgres } from './postgres-client.js';
import { metricsService } from './metrics-service.js';

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Description:
 * (Final Production Ready Version)
 * This script creates a standalone Node.js HTTP server that acts as a local proxy for the Google Cloud Code Assist API.
 * This version includes all features and bug fixes, designed to be robust, flexible, and easy to monitor through a comprehensive and controllable logging system.
 *
 * Key Features:
 * - OpenAI & Gemini & Claude Multi-Compatibility: Seamlessly bridges clients using the OpenAI API format with the Google Gemini API. Supports both native Gemini API (`/v1beta`) and OpenAI-compatible (`/v1`) endpoints.
 *
 * - Robust Authentication Management: Supports multiple authentication methods, including OAuth 2.0 configuration via Base64 strings, file paths, or automatic discovery of local credentials. Capable of automatically refreshing expired tokens to ensure continuous service operation.
 *
 * - Flexible API Key Validation: Supports three API key validation methods: `Authorization: Bearer <key>` request header, `x-goog-api-key` request header, and `?key=` URL query parameter, configurable via the `--api-key` startup parameter.
 *
 * - Dynamic System Prompt Management:
 *   - File Injection: Loads system prompts from external files via `--system-prompt-file` and controls their behavior (overwrite or append) with `--system-prompt-mode`.
 *   - Real-time Synchronization: Capable of writing system prompts included in requests to the `fetch_system_prompt.txt` file in real-time, facilitating developer observation and debugging.
 *
 * - Intelligent Request Conversion and Repair: Automatically converts OpenAI-formatted requests to Gemini format, including role mapping (`assistant` -> `model`), merging consecutive messages from the same role, and fixing missing `role` fields.
 *
 * - Comprehensive and Controllable Logging System: Provides two logging modes (console or file), detailing input and output of each request, remaining token validity, and other information for monitoring and debugging.
 *
 * - Highly Configurable Startup: Supports configuring service listening address, port, project ID, API key, and logging mode via command-line parameters.
 *
 * Usage Examples:
 *
 * Basic Usage:
 * node src/api-server.js
 *
 * Server Configuration:
 * node src/api-server.js --host 0.0.0.0 --port 8080 --api-key your-secret-key
 *
 * OpenAI Provider:
 * node src/api-server.js --model-provider openai-custom --openai-api-key sk-xxx --openai-base-url https://api.openai.com/v1
 *
 * Claude Provider:
 * node src/api-server.js --model-provider claude-custom --claude-api-key sk-ant-xxx --claude-base-url https://api.anthropic.com
 *
 * Gemini Provider (OAuth with Base64 credentials):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-base64 eyJ0eXBlIjoi... --project-id your-project-id
 *
 * Gemini Provider (OAuth with credentials file):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-file /path/to/credentials.json --project-id your-project-id
 *
 * System Prompt Management:
 * node src/api-server.js --system-prompt-file custom-prompt.txt --system-prompt-mode append
 *
 * Logging Configuration:
 * node src/api-server.js --log-prompts console
 * node src/api-server.js --log-prompts file --prompt-log-base-name my-logs
 *
 * Complete Example:
 * node src/api-server.js \
 *   --host 0.0.0.0 \
 *   --port 3000 \
 *   --api-key my-secret-key \
 *   --model-provider gemini-cli-oauth \
 *   --project-id my-gcp-project \
 *   --gemini-oauth-creds-file ./credentials.json \
 *   --system-prompt-file ./custom-system-prompt.txt \
 *   --system-prompt-mode overwrite \
 *   --log-prompts file \
 *   --prompt-log-base-name api-logs
 *
 * Command Line Parameters:
 * --host <address>                    Server listening address (default: 0.0.0.0)
 * --port <number>                     Server listening port (default: 3000)
 * --api-key <key>                     Required API key for authentication (default: 123456)
 * --model-provider <provider[,provider...]> AI model provider: openai-custom, claude-custom, gemini-cli-oauth, gemini-antigravity
 * --openai-api-key <key>             OpenAI API key (for openai-custom provider)
 * --openai-base-url <url>            OpenAI API base URL (for openai-custom provider)
 * --claude-api-key <key>             Claude API key (for claude-custom provider)
 * --claude-base-url <url>            Claude API base URL (for claude-custom provider)
 * --gemini-oauth-creds-base64 <b64>  Gemini OAuth credentials as Base64 string
 * --gemini-oauth-creds-file <path>   Path to Gemini OAuth credentials JSON file
 * --project-id <id>                  Google Cloud Project ID (for gemini-cli provider)
 * --system-prompt-file <path>        Path to system prompt file (default: configs/input_system_prompt.txt)
 * --system-prompt-mode <mode>        System prompt mode: overwrite or append (default: overwrite)
 * --log-prompts <mode>               Prompt logging mode: console, file, or none (default: none)
 * --prompt-log-base-name <name>      Base name for prompt log files (default: prompt_log)
 * --request-max-retries <number>     Max retries for API requests on failure (default: 3)
 * --request-base-delay <number>      Base delay in milliseconds between retries, increases with each retry (default: 1000)
 * --cron-near-minutes <number>       Interval for OAuth token refresh task in minutes (default: 15)
 * --cron-refresh-token <boolean>     Whether to enable automatic OAuth token refresh task (default: true)
 * --provider-pools-file <path>       Path to provider pools configuration file (default: null)
 *
 */

import 'dotenv/config'; // Import dotenv and configure it
import './converters/register-converters.js'; // Register all converters
import { getProviderPoolManager } from './service-manager.js';

// Detect if running as a child process
const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';

// Store server instance for graceful shutdown
let serverInstance = null;

// Store heartbeat interval for cleanup
let heartbeatInterval = null;

/**
 * Send message to master process
 * @param {Object} message - Message object
 */
function sendToMaster(message) {
    if (IS_WORKER_PROCESS && process.send) {
        process.send(message);
    }
}

/**
 * Setup worker process communication handling
 */
function setupWorkerCommunication() {
    if (!IS_WORKER_PROCESS) return;

    // Listen for messages from master process
    process.on('message', (message) => {
        if (!message || !message.type) return;

        console.log('[Worker] Received message from master:', message.type);

        switch (message.type) {
            case 'shutdown':
                console.log('[Worker] Shutdown requested by master');
                gracefulShutdown();
                break;
            case 'status':
                sendToMaster({
                    type: 'status',
                    data: {
                        pid: process.pid,
                        uptime: process.uptime(),
                        memoryUsage: process.memoryUsage()
                    }
                });
                break;
            default:
                console.log('[Worker] Unknown message type:', message.type);
        }
    });

    // Listen for disconnect
    process.on('disconnect', () => {
        console.log('[Worker] Disconnected from master, shutting down...');
        gracefulShutdown();
    });
}

/**
 * Graceful shutdown of server
 */
async function gracefulShutdown() {
    console.log('[Server] Initiating graceful shutdown...');

    // Clear heartbeat interval to prevent timers from keeping the process alive
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    // Stop auto health checks to prevent timers from keeping the process alive
    const poolManager = getProviderPoolManager();
    if (poolManager) {
        poolManager.stopAutoHealthChecks();
    }

    // Shutdown metrics service (stops aggregation job)
    await metricsService.shutdown();

    if (serverInstance) {
        serverInstance.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });

        // Set timeout to prevent infinite waiting
        setTimeout(() => {
            console.log('[Server] Shutdown timeout, forcing exit...');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}

/**
 * Setup process signal handlers
 */
function setupSignalHandlers() {
    process.on('SIGTERM', () => {
        console.log('[Server] Received SIGTERM');
        gracefulShutdown();
    });

    process.on('SIGINT', () => {
        console.log('[Server] Received SIGINT');
        gracefulShutdown();
    });

    process.on('uncaughtException', (error) => {
        console.error('[Server] Uncaught exception:', error);

        // Critical errors that should trigger shutdown
        const criticalErrorCodes = [
            'EADDRINUSE',    // Port already in use
            'EACCES',        // Permission denied (e.g., binding to privileged port)
            'ENOMEM',        // Out of memory
            'ENOSPC',        // No space left on device
        ];

        // Critical error types that indicate unrecoverable state
        const criticalErrorTypes = [
            'OutOfMemoryError',
            'StackOverflow',
        ];

        const isCritical = criticalErrorCodes.includes(error.code) ||
                          criticalErrorTypes.some(type => error.name?.includes(type));

        if (isCritical) {
            console.error('[Server] Critical error detected, initiating graceful shutdown...');
            gracefulShutdown();
        } else {
            console.error('[Server] Non-critical error, server will continue running');
            console.error('[Server] Error stack:', error.stack);
        }
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
    });
}

// --- Server Initialization ---
async function startServer() {
    // Initialize configuration
    await initializeConfig(process.argv.slice(2), 'configs/config.json');

    // Initialize Redis (for caching)
    console.log('[Initialization] Initializing Redis client...');
    await redisClient.initialize();

    // Initialize PostgreSQL (for metrics storage)
    console.log('[Initialization] Initializing PostgreSQL client...');
    await initializePostgres();

    // Initialize Metrics Service (depends on PostgreSQL)
    console.log('[Initialization] Initializing metrics service...');
    await metricsService.initialize();
    metricsService.startAggregationJob();

    // Automatically link config files in configs directory to corresponding providers
    console.log('[Initialization] Checking for unlinked provider configs...');
    await autoLinkProviderConfigs(CONFIG);

    // Initialize API services
    const services = await initApiService(CONFIG);
    
    // Initialize UI management features
    initializeUIManagement(CONFIG);
    
    // Initialize API management and get heartbeat function
    const heartbeatAndRefreshToken = initializeAPIManagement(services);
    
    // Create request handler
    const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());

    serverInstance = http.createServer(requestHandlerInstance);
    serverInstance.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
        console.log(`--- Unified API Server Configuration ---`);
        const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0
            ? CONFIG.DEFAULT_MODEL_PROVIDERS
            : [CONFIG.MODEL_PROVIDER];
        const uniqueProviders = [...new Set(configuredProviders)];
        console.log(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
        if (uniqueProviders.length > 1) {
            console.log(`  Additional Model Providers: ${uniqueProviders.slice(1).join(', ')}`);
        }
        uniqueProviders.forEach((provider) => logProviderSpecificDetails(provider, CONFIG));
        console.log(`  System Prompt File: ${CONFIG.SYSTEM_PROMPT_FILE_PATH || 'Default'}`);
        console.log(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
        console.log(`  Host: ${CONFIG.HOST}`);
        console.log(`  Port: ${CONFIG.SERVER_PORT}`);
        console.log(`  Required API Key: ${CONFIG.REQUIRED_API_KEY}`);
        console.log(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ''}`);
        console.log(`------------------------------------------`);
        console.log(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
        console.log(`Supports multiple API formats:`);
        console.log(`  • OpenAI-compatible: /v1/chat/completions, /v1/responses, /v1/models`);
        console.log(`  • Gemini-compatible: /v1beta/models, /v1beta/models/{model}:generateContent`);
        console.log(`  • Claude-compatible: /v1/messages`);
        console.log(`  • Health check: /health`);
        console.log(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);

        // Auto-open browser to UI (only if host is 0.0.0.0 or 127.0.0.1)
        // if (CONFIG.HOST === '0.0.0.0' || CONFIG.HOST === '127.0.0.1') {
            try {
                const open = (await import('open')).default;
                setTimeout(() => {
                    let openUrl = `http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`;
                    if(CONFIG.HOST === '0.0.0.0'){
                        openUrl = `http://localhost:${CONFIG.SERVER_PORT}/login.html`;
                    }
                    open(openUrl)
                        .then(() => {
                            console.log('[UI] Opened login page in default browser');
                        })
                        .catch(err => {
                            console.log('[UI] Please open manually: http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html');
                        });
                }, 1000);
            } catch (err) {
                console.log(`[UI] Login page available at: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`);
            }
        // }

        if (CONFIG.CRON_REFRESH_TOKEN) {
            console.log(`  • Cron Near Minutes: ${CONFIG.CRON_NEAR_MINUTES}`);
            console.log(`  • Cron Refresh Token: ${CONFIG.CRON_REFRESH_TOKEN}`);
            // Execute heartbeat log and token refresh every CRON_NEAR_MINUTES minutes
            heartbeatInterval = setInterval(heartbeatAndRefreshToken, CONFIG.CRON_NEAR_MINUTES * 60 * 1000);
        }
        // After server fully starts, perform initial health checks
        const poolManager = getProviderPoolManager();
        if (poolManager) {
            console.log('[Initialization] Performing initial health checks for provider pools...');
            await poolManager.performHealthChecks(true);
            // Start auto health check system for any providers that remain unhealthy
            poolManager.startAutoHealthChecks();
        }

        // If running as child process, notify master process that it's ready
        if (IS_WORKER_PROCESS) {
            sendToMaster({ type: 'ready', pid: process.pid });
        }
    });
    return serverInstance; // Return the server instance for testing purposes
}

// Setup signal handlers
setupSignalHandlers();

// Setup worker process communication
setupWorkerCommunication();

startServer().catch(err => {
    console.error("[Server] Failed to start server:", err.message);
    process.exit(1);
});

// Export for external use
export { gracefulShutdown, sendToMaster };
