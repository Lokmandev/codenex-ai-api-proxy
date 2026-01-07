import { getServiceAdapter, serviceInstances } from './adapter.js';
import { ProviderPoolManager } from './provider-pool-manager.js';
import deepmerge from 'deepmerge';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import {
    PROVIDER_MAPPINGS,
    createProviderConfig,
    addToUsedPaths,
    isPathUsed,
    getFileName,
    formatSystemPath
} from './provider-utils.js';

// Store ProviderPoolManager instance
let providerPoolManager = null;

/**
 * Scan configs directory and auto-link unlinked config files to corresponding providers
 * @param {Object} config - Server configuration object
 * @returns {Promise<Object>} Updated providerPools object
 */
export async function autoLinkProviderConfigs(config) {
    // Ensure providerPools object exists
    if (!config.providerPools) {
        config.providerPools = {};
    }
    
    let totalNewProviders = 0;
    const allNewProviders = {};
    
    // Iterate through all provider mappings
    for (const mapping of PROVIDER_MAPPINGS) {
        const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
        const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = mapping;
        
        // Ensure provider type array exists
        if (!config.providerPools[providerType]) {
            config.providerPools[providerType] = [];
        }
        
        // Check if directory exists
        if (!fs.existsSync(configsPath)) {
            continue;
        }
        
        // Get set of already linked config file paths
        const linkedPaths = new Set();
        for (const provider of config.providerPools[providerType]) {
            if (provider[credPathKey]) {
                // Use common method to add all variant formats of the path
                addToUsedPaths(linkedPaths, provider[credPathKey]);
            }
        }
        
        // Recursively scan directory
        const newProviders = [];
        await scanProviderDirectory(configsPath, linkedPaths, newProviders, {
            credPathKey,
            defaultCheckModel,
            needsProjectId
        });
        
        // If there are new config files to link
        if (newProviders.length > 0) {
            config.providerPools[providerType].push(...newProviders);
            totalNewProviders += newProviders.length;
            allNewProviders[displayName] = newProviders;
        }
    }
    
    // If there are new config files to link, save updated provider_pools.json
    if (totalNewProviders > 0) {
        const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        try {
            await pfs.writeFile(filePath, JSON.stringify(config.providerPools, null, 2), 'utf8');
            console.log(`[Auto-Link] Added ${totalNewProviders} new config(s) to provider pools:`);
            for (const [displayName, providers] of Object.entries(allNewProviders)) {
                console.log(`  ${displayName}: ${providers.length} config(s)`);
                providers.forEach(p => {
                    // Get credentials path key
                    const credKey = Object.keys(p).find(k => k.endsWith('_CREDS_FILE_PATH'));
                    if (credKey) {
                        console.log(`    - ${p[credKey]}`);
                    }
                });
            }
        } catch (error) {
            console.error(`[Auto-Link] Failed to save provider_pools.json: ${error.message}`);
        }
    } else {
        console.log('[Auto-Link] No new configs to link');
    }
    
    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = config.providerPools;
        providerPoolManager.initializeProviderStatus();
    }
    return config.providerPools;
}

/**
 * Recursively scan provider config directory
 * @param {string} dirPath - Directory path
 * @param {Set} linkedPaths - Set of linked paths
 * @param {Array} newProviders - New provider config array
 * @param {Object} options - Config options
 * @param {string} options.credPathKey - Credentials path key name
 * @param {string} options.defaultCheckModel - Default check model
 * @param {boolean} options.needsProjectId - Whether PROJECT_ID is needed
 */
async function scanProviderDirectory(dirPath, linkedPaths, newProviders, options) {
    const { credPathKey, defaultCheckModel, needsProjectId } = options;
    
    try {
        const files = await pfs.readdir(dirPath, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);
            
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // Only process JSON files
                if (ext === '.json') {
                    const relativePath = path.relative(process.cwd(), fullPath);
                    const fileName = getFileName(fullPath);
                    
                    // Use the same isPathUsed function as ui-manager.js to check if already linked
                    const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
                    
                    if (!isLinked) {
                        // Use common method to create new provider config
                        const newProvider = createProviderConfig({
                            credPathKey,
                            credPath: formatSystemPath(relativePath),
                            defaultCheckModel,
                            needsProjectId
                        });
                        
                        newProviders.push(newProvider);
                    }
                }
            } else if (file.isDirectory()) {
                // Recursively scan subdirectories (limit depth to 3 levels)
                const relativePath = path.relative(process.cwd(), fullPath);
                const depth = relativePath.split(path.sep).length;
                if (depth < 5) { // configs/{provider}/subfolder/subsubfolder
                    await scanProviderDirectory(fullPath, linkedPaths, newProviders, options);
                }
            }
        }
    } catch (error) {
        console.warn(`[Auto-Link] Failed to scan directory ${dirPath}: ${error.message}`);
    }
}

// Note: isValidOAuthCredentials has been moved to provider-utils.js common module

/**
 * Initialize API services and provider pool manager
 * @param {Object} config - The server configuration
 * @returns {Promise<Object>} The initialized services
 */
export async function initApiService(config) {
    
    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        providerPoolManager = new ProviderPoolManager(config.providerPools, {
            globalConfig: config,
            maxErrorCount: config.MAX_ERROR_COUNT ?? 3,
            healthCheckInterval: (config.HEALTH_CHECK_INTERVAL_HOURS ?? 1) * 60 * 60 * 1000, // Default 1 hour
            providerFallbackChain: config.providerFallbackChain || {},
            // Auto health check configuration
            quickRetryIntervalMs: (config.QUICK_RETRY_INTERVAL_SECONDS ?? 10) * 1000, // 10 seconds between quick retries
            quickRetryMaxCount: config.QUICK_RETRY_MAX_COUNT ?? 3, // Max 3 quick retry attempts
            rateLimitHealthCheckIntervalMs: (config.RATE_LIMIT_CHECK_INTERVAL_HOURS ?? 3) * 60 * 60 * 1000, // 3 hours for 429 errors
            standardHealthCheckIntervalMs: (config.STANDARD_CHECK_INTERVAL_HOURS ?? 3) * 60 * 60 * 1000, // 3 hours fallback
            autoHealthCheckEnabled: config.AUTO_HEALTH_CHECK_ENABLED ?? true, // Enable/disable auto health checks
        });
        console.log('[Initialization] ProviderPoolManager initialized with configured pools.');
        // Health check will be executed after server is fully started
    } else {
        console.log('[Initialization] No provider pools configured. Using single provider mode.');
    }

    // Initialize configured service adapters at startup
    // For providers not in the pool, initialize in advance to avoid extra delay on first request
    const providersToInit = new Set();
    if (Array.isArray(config.DEFAULT_MODEL_PROVIDERS)) {
        config.DEFAULT_MODEL_PROVIDERS.forEach((provider) => providersToInit.add(provider));
    }
    if (config.providerPools) {
        Object.keys(config.providerPools).forEach((provider) => providersToInit.add(provider));
    }
    if (providersToInit.size === 0) {
        const { ALL_MODEL_PROVIDERS } = await import('./config-manager.js');
        ALL_MODEL_PROVIDERS.forEach((provider) => providersToInit.add(provider));
    }

    for (const provider of providersToInit) {
        const { ALL_MODEL_PROVIDERS } = await import('./config-manager.js');
        if (!ALL_MODEL_PROVIDERS.includes(provider)) {
            console.warn(`[Initialization Warning] Skipping unknown model provider '${provider}' during adapter initialization.`);
            continue;
        }
        if (config.providerPools && config.providerPools[provider] && config.providerPools[provider].length > 0) {
            // Pool manager handles initialization on demand
            continue;
        }
        try {
            console.log(`[Initialization] Initializing single service adapter for ${provider}...`);
            getServiceAdapter({ ...config, MODEL_PROVIDER: provider });
        } catch (error) {
            console.warn(`[Initialization Warning] Failed to initialize single service adapter for ${provider}: ${error.message}`);
        }
    }
    return serviceInstances; // Return the collection of initialized service instances
}

/**
 * Get API service adapter, considering provider pools
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
 * @returns {Promise<Object>} The API service adapter
 */
export async function getApiService(config, requestedModel = null, options = {}) {
    let serviceConfig = config;
    if (providerPoolManager && config.providerPools && config.providerPools[config.MODEL_PROVIDER]) {
        // If there is a pool manager and current model provider type has a corresponding pool, select a provider config from the pool
        const selectedProviderConfig = providerPoolManager.selectProvider(config.MODEL_PROVIDER, requestedModel, { skipUsageCount: true });
        if (selectedProviderConfig) {
            // Merge selected provider config into current request config
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools; // Remove providerPools property
            config.uuid = serviceConfig.uuid;
            console.log(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${requestedModel ? ` (model: ${requestedModel})` : ''}`);
        } else {
            console.warn(`[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${requestedModel ? ` supporting model: ${requestedModel}` : ''}. Falling back to main config.`);
        }
    }
    // When pool is unavailable, fallback to using current request config to initialize service adapter
    return getServiceAdapter(serviceConfig);
}

/**
 * Get API service adapter with fallback support and return detailed result
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @returns {Promise<Object>} Object containing service adapter and metadata
 */
export async function getApiServiceWithFallback(config, requestedModel = null, options = {}) {
    let serviceConfig = config;
    let actualProviderType = config.MODEL_PROVIDER;
    let isFallback = false;
    let selectedUuid = null;
    
    if (providerPoolManager && config.providerPools && config.providerPools[config.MODEL_PROVIDER]) {
        const selectedResult = providerPoolManager.selectProviderWithFallback(
            config.MODEL_PROVIDER,
            requestedModel,
            { skipUsageCount: true }
        );
        
        if (selectedResult) {
            const { config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed } = selectedResult;
            
            // Merge selected provider config into current request config
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;

            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;

            // If fallback occurred, need to update MODEL_PROVIDER
            if (isFallback) {
                serviceConfig.MODEL_PROVIDER = actualProviderType;
            }
        }
    }
    
    const service = getServiceAdapter(serviceConfig);
    
    return {
        service,
        serviceConfig,
        actualProviderType,
        isFallback,
        uuid: selectedUuid
    };
}

/**
 * Get the provider pool manager instance
 * @returns {Object} The provider pool manager
 */
export function getProviderPoolManager() {
    return providerPoolManager;
}

/**
 * Mark provider as unhealthy
 * @param {string} provider - The model provider
 * @param {Object} providerInfo - Provider information including uuid
 */
export function markProviderUnhealthy(provider, providerInfo) {
    if (providerPoolManager) {
        providerPoolManager.markProviderUnhealthy(provider, providerInfo);
    }
}

/**
 * Get providers status
 * @param {Object} config - The current request configuration
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.provider] - Optional.provider filter by provider type
 * @param {boolean} [options.customName] - Optional.customName filter by customName
 * @returns {Promise<Object>} The API service adapter
 */
export async function getProviderStatus(config, options = {}) {
    let providerPools = {};
    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else if (filePath && fs.existsSync(filePath)) {
            const poolsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            providerPools = poolsData;
        }
    } catch (error) {
        console.warn('[API Service] Failed to load provider pools:', error.message);
    }

    // providerPoolsSlim only keeps top-level keys and partial fields, filters out elements with isDisabled as true
    const slimFields = [
        'customName',
        'isHealthy',
        'lastErrorTime',
        'lastErrorMessage'
    ];
    // Identify field mapping table
    const identifyFieldMap = {
        'openai-custom': 'OPENAI_BASE_URL',
        'openaiResponses-custom': 'OPENAI_BASE_URL',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'claude-custom': 'CLAUDE_BASE_URL',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'claudeCode-custom': 'customName'
    };
    let providerPoolsSlim = [];
    let unhealthyProvideIdentifyList = [];
    let count = 0;
    let unhealthyCount = 0;
    let unhealthyRatio = 0;
    const filterProvider = options && options.provider;
    const filterCustomName = options && options.customName;
    for (const key of Object.keys(providerPools)) {
        if (!Array.isArray(providerPools[key])) continue;
        if (filterProvider && key !== filterProvider) continue;
        const identifyField = identifyFieldMap[key] || null;
        const slimArr = providerPools[key]
            .filter(item => {
                if (item.isDisabled) return false;
                if (filterCustomName && item.customName !== filterCustomName) return false;
                return true;
            })
            .map(item => {
                const slim = {};
                for (const f of slimFields) {
                    slim[f] = item.hasOwnProperty(f) ? item[f] : null;
                }
                // Identify field
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : 'NoCustomName';
                    let identifyStr = `${tmpCustomName}::${key}::${item[identifyField]}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // Statistics
                count++;
                if (slim.isHealthy === false) {
                    unhealthyCount++;
                    if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
                }
                return slim;
            });
        providerPoolsSlim.push(...slimArr);
    }
    if (count > 0) {
        unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
    }
        let unhealthySummeryMessage = unhealthyProvideIdentifyList.join('\n');
        if (unhealthySummeryMessage === '') unhealthySummeryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummeryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}
