/**
 * Usage Query Service
 * Handles usage queries for authorization files of various providers
 */

import { getProviderPoolManager } from './service-manager.js';
import { serviceInstances } from './adapter.js';
import { MODEL_PROVIDER } from './common.js';

/**
 * Usage Query Service Class
 * Provides a unified interface to query usage information from various providers
 */
export class UsageService {
    constructor() {
        this.providerHandlers = {
            [MODEL_PROVIDER.GEMINI_CLI]: this.getGeminiUsage.bind(this),
            [MODEL_PROVIDER.ANTIGRAVITY]: this.getAntigravityUsage.bind(this),
        };
    }

    /**
     * Gets usage information for a specified provider
     * @param {string} providerType - Provider type
     * @param {string} [uuid] - Optional provider instance UUID
     * @returns {Promise<Object>} Usage information
     */
    async getUsage(providerType, uuid = null) {
        const handler = this.providerHandlers[providerType];
        if (!handler) {
            throw new Error(`Unsupported provider type: ${providerType}`);
        }
        return handler(uuid);
    }

    /**
     * Gets usage information for all providers
     * @returns {Promise<Object>} Usage information for all providers
     */
    async getAllUsage() {
        const results = {};
        const poolManager = getProviderPoolManager();

        for (const [providerType, handler] of Object.entries(this.providerHandlers)) {
            try {
                // Check if there is a pool configuration
                if (poolManager) {
                    const pools = poolManager.getProviderPools(providerType);
                    if (pools && pools.length > 0) {
                        results[providerType] = [];
                        for (const pool of pools) {
                            try {
                                const usage = await handler(pool.uuid);
                                results[providerType].push({
                                    uuid: pool.uuid,
                                    usage
                                });
                            } catch (error) {
                                results[providerType].push({
                                    uuid: pool.uuid,
                                    error: error.message
                                });
                            }
                        }
                    }
                }

                // If no pool configuration, try to get usage for single instance
                if (!results[providerType] || results[providerType].length === 0) {
                    const usage = await handler(null);
                    results[providerType] = [{ uuid: 'default', usage }];
                }
            } catch (error) {
                results[providerType] = [{ uuid: 'default', error: error.message }];
            }
        }

        return results;
    }

    /**
     * Gets usage information for Gemini CLI provider
     * @param {string} [uuid] - Optional provider instance UUID
     * @returns {Promise<Object>} Gemini usage information
     */
    async getGeminiUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.GEMINI_CLI + uuid : MODEL_PROVIDER.GEMINI_CLI;
        const adapter = serviceInstances[providerKey];

        if (!adapter) {
            throw new Error(`Gemini CLI service instance not found: ${providerKey}`);
        }

        // Use adapter's getUsageLimits method
        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }

        // Compatible with direct access to geminiApiService
        if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            return adapter.geminiApiService.getUsageLimits();
        }

        throw new Error(`Gemini CLI service instance does not support usage query: ${providerKey}`);
    }

    /**
     * Gets usage information for Antigravity provider
     * @param {string} [uuid] - Optional provider instance UUID
     * @returns {Promise<Object>} Antigravity usage information
     */
    async getAntigravityUsage(uuid = null) {
        const providerKey = uuid ? MODEL_PROVIDER.ANTIGRAVITY + uuid : MODEL_PROVIDER.ANTIGRAVITY;
        const adapter = serviceInstances[providerKey];

        if (!adapter) {
            throw new Error(`Antigravity service instance not found: ${providerKey}`);
        }

        // Use adapter's getUsageLimits method
        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }

        // Compatible with direct access to antigravityApiService
        if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            return adapter.antigravityApiService.getUsageLimits();
        }

        throw new Error(`Antigravity service instance does not support usage query: ${providerKey}`);
    }

    /**
     * Gets the list of providers that support usage query
     * @returns {Array<string>} List of supported provider types
     */
    getSupportedProviders() {
        return Object.keys(this.providerHandlers);
    }
}

// Export singleton instance
export const usageService = new UsageService();

/**
 * Formats Gemini usage information into a readable format
 * @param {Object} usageData - Raw usage data
 * @returns {Object} Formatted usage information
 */
export function formatGeminiUsage(usageData) {
    if (!usageData) {
        return null;
    }

    const TZ_OFFSET = 8 * 60 * 60 * 1000; // Beijing timezone offset

    /**
     * Converts UTC time to Beijing time
     * @param {string} utcString - UTC time string
     * @returns {string} Beijing time string
     */
    function utcToBeijing(utcString) {
        try {
            if (!utcString) return '--';
            const utcDate = new Date(utcString);
            const beijingTime = new Date(utcDate.getTime() + TZ_OFFSET);
            return beijingTime
                .toLocaleString('en', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                .replace(/\//g, '-');
        } catch (e) {
            return '--';
        }
    }

    const result = {
        // Basic information
        daysUntilReset: null,
        nextDateReset: null,

        // Subscription information
        subscription: {
            title: 'Gemini CLI OAuth',
            type: 'gemini-cli-oauth',
            upgradeCapability: null,
            overageCapability: null
        },

        // User information
        user: {
            email: null,
            userId: null
        },

        // Usage breakdown
        usageBreakdown: []
    };

    // Parse quota information
    if (usageData.quotaInfo) {
        result.subscription.title = usageData.quotaInfo.currentTier || 'Gemini CLI OAuth';
        if (usageData.quotaInfo.quotaResetTime) {
            result.nextDateReset = usageData.quotaInfo.quotaResetTime;
            // Calculate days until reset
            const resetDate = new Date(usageData.quotaInfo.quotaResetTime);
            const now = new Date();
            const diffTime = resetDate.getTime() - now.getTime();
            result.daysUntilReset = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
    }

    // Parse model quota information
    if (usageData.models && typeof usageData.models === 'object') {
        for (const [modelName, modelInfo] of Object.entries(usageData.models)) {
            // Gemini returns data structure: { remaining, resetTime, resetTimeRaw }
            // remaining is a ratio between 0-1, representing remaining quota percentage
            const remainingPercent = typeof modelInfo.remaining === 'number' ? modelInfo.remaining : 1;
            const usedPercent = 1 - remainingPercent;

            const item = {
                resourceType: 'MODEL_USAGE',
                displayName: modelInfo.displayName || modelName,
                displayNamePlural: modelInfo.displayName || modelName,
                unit: 'quota',
                currency: null,

                // Current usage - Gemini returns remaining ratio, convert to used ratio (percentage)
                currentUsage: Math.round(usedPercent * 100),
                usageLimit: 100, // Expressed as percentage, total is 100%

                // Overage information
                currentOverages: 0,
                overageCap: 0,
                overageRate: null,
                overageCharges: 0,

                // Next reset time
                nextDateReset: modelInfo.resetTimeRaw ? new Date(modelInfo.resetTimeRaw).toISOString() :
                    (modelInfo.resetTime ? new Date(modelInfo.resetTime).toISOString() : null),

                // Free trial information
                freeTrial: null,

                // Bonus information
                bonuses: [],

                // Additional Gemini-specific information
                modelName: modelName,
                inputTokenLimit: modelInfo.inputTokenLimit || 0,
                outputTokenLimit: modelInfo.outputTokenLimit || 0,
                remaining: remainingPercent,
                remainingPercent: Math.round(remainingPercent * 100), // Remaining percentage
                resetTime: (modelInfo.resetTimeRaw || modelInfo.resetTime) ?
                    utcToBeijing(modelInfo.resetTimeRaw || modelInfo.resetTime) : '--',
                resetTimeRaw: modelInfo.resetTimeRaw || modelInfo.resetTime || null
            };

            result.usageBreakdown.push(item);
        }
    }

    return result;
}

/**
 * Formats Antigravity usage information into a readable format
 * @param {Object} usageData - Raw usage data
 * @returns {Object} Formatted usage information
 */
export function formatAntigravityUsage(usageData) {
    if (!usageData) {
        return null;
    }

    const TZ_OFFSET = 8 * 60 * 60 * 1000; // Beijing timezone offset

    /**
     * Converts UTC time to Beijing time
     * @param {string} utcString - UTC time string
     * @returns {string} Beijing time string
     */
    function utcToBeijing(utcString) {
        try {
            if (!utcString) return '--';
            const utcDate = new Date(utcString);
            const beijingTime = new Date(utcDate.getTime() + TZ_OFFSET);
            return beijingTime
                .toLocaleString('en', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                .replace(/\//g, '-');
        } catch (e) {
            return '--';
        }
    }

    const result = {
        // Basic information
        daysUntilReset: null,
        nextDateReset: null,

        // Subscription information
        subscription: {
            title: 'Gemini Antigravity',
            type: 'gemini-antigravity',
            upgradeCapability: null,
            overageCapability: null
        },

        // User information
        user: {
            email: null,
            userId: null
        },

        // Usage breakdown
        usageBreakdown: []
    };

    // Parse quota information
    if (usageData.quotaInfo) {
        result.subscription.title = usageData.quotaInfo.currentTier || 'Gemini Antigravity';
        if (usageData.quotaInfo.quotaResetTime) {
            result.nextDateReset = usageData.quotaInfo.quotaResetTime;
            // Calculate days until reset
            const resetDate = new Date(usageData.quotaInfo.quotaResetTime);
            const now = new Date();
            const diffTime = resetDate.getTime() - now.getTime();
            result.daysUntilReset = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
    }

    // Parse model quota information
    if (usageData.models && typeof usageData.models === 'object') {
        for (const [modelName, modelInfo] of Object.entries(usageData.models)) {
            // Antigravity returns data structure: { remaining, resetTime, resetTimeRaw }
            // remaining is a ratio between 0-1, representing remaining quota percentage
            const remainingPercent = typeof modelInfo.remaining === 'number' ? modelInfo.remaining : 1;
            const usedPercent = 1 - remainingPercent;

            const item = {
                resourceType: 'MODEL_USAGE',
                displayName: modelInfo.displayName || modelName,
                displayNamePlural: modelInfo.displayName || modelName,
                unit: 'quota',
                currency: null,

                // Current usage - Antigravity returns remaining ratio, convert to used ratio (percentage)
                currentUsage: Math.round(usedPercent * 100),
                usageLimit: 100, // Expressed as percentage, total is 100%

                // Overage information
                currentOverages: 0,
                overageCap: 0,
                overageRate: null,
                overageCharges: 0,

                // Next reset time
                nextDateReset: modelInfo.resetTimeRaw ? new Date(modelInfo.resetTimeRaw).toISOString() :
                    (modelInfo.resetTime ? new Date(modelInfo.resetTime).toISOString() : null),

                // Free trial information
                freeTrial: null,

                // Bonus information
                bonuses: [],

                // Additional Antigravity-specific information
                modelName: modelName,
                inputTokenLimit: modelInfo.inputTokenLimit || 0,
                outputTokenLimit: modelInfo.outputTokenLimit || 0,
                remaining: remainingPercent,
                remainingPercent: Math.round(remainingPercent * 100), // Remaining percentage
                resetTime: (modelInfo.resetTimeRaw || modelInfo.resetTime) ?
                    utcToBeijing(modelInfo.resetTimeRaw || modelInfo.resetTime) : '--',
                resetTimeRaw: modelInfo.resetTimeRaw || modelInfo.resetTime || null
            };

            result.usageBreakdown.push(item);
        }
    }

    return result;
}