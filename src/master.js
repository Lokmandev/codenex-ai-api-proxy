/**
 * Master Process
 *
 * Responsible for managing child process lifecycle, including:
 * - Starting child processes
 * - Monitoring child process status
 * - Handling child process restart requests
 * - Providing IPC communication
 *
 * Usage:
 * node src/master.js [original command line arguments]
 */

import { fork } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Child process instance
let workerProcess = null;

// Child process status
let workerStatus = {
    pid: null,
    startTime: null,
    restartCount: 0,
    lastRestartTime: null,
    isRestarting: false
};

// Configuration
const config = {
    workerScript: path.join(__dirname, 'api-server.js'),
    maxRestartAttempts: 10,
    restartDelay: 1000, // Restart delay (milliseconds)
    masterPort: parseInt(process.env.MASTER_PORT) || 3100, // Master process management port
    args: process.argv.slice(2) // Arguments passed to child process
};

/**
 * Start child process
 */
function startWorker() {
    if (workerProcess) {
        console.log('[Master] Worker process already running, PID:', workerProcess.pid);
        return;
    }

    console.log('[Master] Starting worker process...');
    console.log('[Master] Worker script:', config.workerScript);
    console.log('[Master] Worker args:', config.args.join(' '));

    workerProcess = fork(config.workerScript, config.args, {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
            ...process.env,
            IS_WORKER_PROCESS: 'true'
        }
    });

    workerStatus.pid = workerProcess.pid;
    workerStatus.startTime = new Date().toISOString();

    console.log('[Master] Worker process started, PID:', workerProcess.pid);

    // Listen for child process messages
    workerProcess.on('message', (message) => {
        console.log('[Master] Received message from worker:', message);
        handleWorkerMessage(message);
    });

    // Listen for child process exit
    workerProcess.on('exit', (code, signal) => {
        console.log(`[Master] Worker process exited with code ${code}, signal ${signal}`);
        workerProcess = null;
        workerStatus.pid = null;

        // If exit was not caused by active restart, try auto-restart
        if (!workerStatus.isRestarting && code !== 0) {
            console.log('[Master] Worker crashed, attempting auto-restart...');
            scheduleRestart();
        }
    });

    // Listen for child process errors
    workerProcess.on('error', (error) => {
        console.error('[Master] Worker process error:', error.message);
    });
}

/**
 * Stop child process
 * @param {boolean} graceful - Whether to shutdown gracefully
 * @returns {Promise<void>}
 */
function stopWorker(graceful = true) {
    return new Promise((resolve) => {
        if (!workerProcess) {
            console.log('[Master] No worker process to stop');
            resolve();
            return;
        }

        console.log('[Master] Stopping worker process, PID:', workerProcess.pid);

        const timeout = setTimeout(() => {
            if (workerProcess) {
                console.log('[Master] Force killing worker process...');
                workerProcess.kill('SIGKILL');
            }
            resolve();
        }, 5000); // Force kill after 5 second timeout

        workerProcess.once('exit', () => {
            clearTimeout(timeout);
            workerProcess = null;
            workerStatus.pid = null;
            console.log('[Master] Worker process stopped');
            resolve();
        });

        if (graceful) {
            // Send graceful shutdown signal
            workerProcess.send({ type: 'shutdown' });
            workerProcess.kill('SIGTERM');
        } else {
            workerProcess.kill('SIGKILL');
        }
    });
}

/**
 * Restart child process
 * @returns {Promise<Object>}
 */
async function restartWorker() {
    if (workerStatus.isRestarting) {
        console.log('[Master] Restart already in progress');
        return { success: false, message: 'Restart already in progress' };
    }

    workerStatus.isRestarting = true;
    workerStatus.restartCount++;
    workerStatus.lastRestartTime = new Date().toISOString();

    console.log('[Master] Restarting worker process...');

    try {
        await stopWorker(true);

        // Wait a short time to ensure port is released
        await new Promise(resolve => setTimeout(resolve, config.restartDelay));
        
        startWorker();
        workerStatus.isRestarting = false;

        return {
            success: true,
            message: 'Worker restarted successfully',
            pid: workerStatus.pid,
            restartCount: workerStatus.restartCount
        };
    } catch (error) {
        workerStatus.isRestarting = false;
        console.error('[Master] Failed to restart worker:', error.message);
        return {
            success: false,
            message: 'Failed to restart worker: ' + error.message
        };
    }
}

/**
 * Schedule restart (used for auto-restart after crash)
 */
function scheduleRestart() {
    if (workerStatus.restartCount >= config.maxRestartAttempts) {
        console.error('[Master] Max restart attempts reached, giving up');
        return;
    }

    const delay = Math.min(config.restartDelay * Math.pow(2, workerStatus.restartCount), 30000);
    console.log(`[Master] Scheduling restart in ${delay}ms...`);

    setTimeout(() => {
        restartWorker();
    }, delay);
}

/**
 * Handle messages from child process
 * @param {Object} message - Message object
 */
function handleWorkerMessage(message) {
    if (!message || !message.type) return;

    switch (message.type) {
        case 'ready':
            console.log('[Master] Worker is ready');
            break;
        case 'restart_request':
            console.log('[Master] Worker requested restart');
            restartWorker();
            break;
        case 'status':
            console.log('[Master] Worker status:', message.data);
            break;
        default:
            console.log('[Master] Unknown message type:', message.type);
    }
}

/**
 * Get status information
 * @returns {Object}
 */
function getStatus() {
    return {
        master: {
            pid: process.pid,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
        },
        worker: {
            pid: workerStatus.pid,
            startTime: workerStatus.startTime,
            restartCount: workerStatus.restartCount,
            lastRestartTime: workerStatus.lastRestartTime,
            isRestarting: workerStatus.isRestarting,
            isRunning: workerProcess !== null
        }
    };
}

/**
 * Create master process management HTTP server
 */
function createMasterServer() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.pathname;
        const method = req.method;

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Status endpoint
        if (method === 'GET' && path === '/master/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getStatus()));
            return;
        }

        // Restart endpoint
        if (method === 'POST' && path === '/master/restart') {
            console.log('[Master] Restart requested via API');
            const result = await restartWorker();
            res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // Stop endpoint
        if (method === 'POST' && path === '/master/stop') {
            console.log('[Master] Stop requested via API');
            await stopWorker(true);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Worker stopped' }));
            return;
        }

        // Start endpoint
        if (method === 'POST' && path === '/master/start') {
            console.log('[Master] Start requested via API');
            if (workerProcess) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Worker already running' }));
                return;
            }
            startWorker();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Worker started', pid: workerStatus.pid }));
            return;
        }

        // Health check
        if (method === 'GET' && path === '/master/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                workerRunning: workerProcess !== null,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.listen(config.masterPort, () => {
        console.log(`[Master] Management server listening on port ${config.masterPort}`);
        console.log(`[Master] Available endpoints:`);
        console.log(`  GET  /master/status  - Get master and worker status`);
        console.log(`  GET  /master/health  - Health check`);
        console.log(`  POST /master/restart - Restart worker process`);
        console.log(`  POST /master/stop    - Stop worker process`);
        console.log(`  POST /master/start   - Start worker process`);
    });

    return server;
}

/**
 * Handle process signals
 */
function setupSignalHandlers() {
    // Graceful shutdown
    process.on('SIGTERM', async () => {
        console.log('[Master] Received SIGTERM, shutting down...');
        await stopWorker(true);
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        console.log('[Master] Received SIGINT, shutting down...');
        await stopWorker(true);
        process.exit(0);
    });

    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('[Master] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Master] Unhandled rejection at:', promise, 'reason:', reason);
    });
}

/**
 * Main function
 */
async function main() {
    console.log('='.repeat(50));
    console.log('[Master] Armorcode Proxy AI API Master Process');
    console.log('[Master] PID:', process.pid);
    console.log('[Master] Node version:', process.version);
    console.log('[Master] Working directory:', process.cwd());
    console.log('='.repeat(50));

    // Set up signal handlers
    setupSignalHandlers();

    // Create management server
    createMasterServer();

    // Start child process
    startWorker();
}

// Start master process
main().catch(error => {
    console.error('[Master] Failed to start:', error);
    process.exit(1);
});