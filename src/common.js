import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import * as crypto from 'crypto'; // Import crypto for MD5 hashing
import { convertData, getOpenAIStreamChunkStop } from './convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';
import { getProviderModels } from './provider-models.js';
import { metricsService } from './metrics-service.js';
import cacheService from './cache-service.js';

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};

export const MODEL_PROTOCOL_PREFIX = {
    // Model provider constants
    GEMINI: 'gemini',
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openaiResponses',
    CLAUDE: 'claude',
    CLAUDE_CODE: 'claudeCode',
    OLLAMA: 'ollama',
}

export const MODEL_PROVIDER = {
    // Model provider constants
    GEMINI_CLI: 'gemini-cli-oauth',
    ANTIGRAVITY: 'gemini-antigravity',
    OPENAI_CUSTOM: 'openai-custom',
    OPENAI_CUSTOM_RESPONSES: 'openaiResponses-custom',
    CLAUDE_CUSTOM: 'claude-custom',
    CLAUDE_CODE_CUSTOM: 'claudeCode-custom',
}

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'gemini-cli', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            reject(err);
        });
    });
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        console.log(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            console.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    console.log(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${queryKey}", x-goog-api-key: "${googApiKey}", x-api-key: "${claudeApiKey}"`);
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream) {
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, options = {}) {
    const { throwOnError = false, headersAlreadySent = false, requestId = crypto.randomUUID(), clientIp = null } = options;
    const startTime = Date.now();
    let fullResponseText = '';
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;
    let statusCode = 200;
    let errorMessage = null;
    // Track token usage from streaming chunks (usually in final chunks)
    let streamInputTokens = null;
    let streamOutputTokens = null;

    if (!headersAlreadySent) {
        await handleUnifiedResponse(res, '', true);
    }

    // fs.writeFile('request'+Date.now()+'.json', JSON.stringify(requestBody));
    // The service returns a stream in its native format (toProvider).
    // Claude Code returns OpenAI-compatible format directly, no conversion needed
    const toProtocol = getProtocolPrefix(toProvider);
    const needsConversion = toProtocol !== MODEL_PROTOCOL_PREFIX.CLAUDE_CODE &&
        getProtocolPrefix(fromProvider) !== toProtocol;
    requestBody.model = model;
    const nativeStream = await service.generateContentStream(model, requestBody);
    const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    const openStop = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI ;

    try {
        for await (const nativeChunk of nativeStream) {
            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
            }

            // Extract token usage from chunks (usually in final chunks)
            const chunkUsage = nativeChunk?.usage || nativeChunk?.usageMetadata;
            if (chunkUsage) {
                streamInputTokens = chunkUsage.prompt_tokens || chunkUsage.promptTokenCount || chunkUsage.input_tokens || streamInputTokens;
                streamOutputTokens = chunkUsage.completion_tokens || chunkUsage.candidatesTokenCount || chunkUsage.output_tokens || streamOutputTokens;
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model)
                : nativeChunk;

            if (!chunkToSend) {
                continue;
            }

            // Handle case where chunkToSend could be an array or object
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                // Also check converted chunks for usage data
                const convertedUsage = chunk?.usage;
                if (convertedUsage) {
                    streamInputTokens = convertedUsage.prompt_tokens || streamInputTokens;
                    streamOutputTokens = convertedUsage.completion_tokens || streamOutputTokens;
                }

                if (addEvent) {
                    // fullOldResponseJson += chunk.type+"\n";
                    // fullResponseJson += chunk.type+"\n";
                    res.write(`event: ${chunk.type}\n`);
                    // console.log(`event: ${chunk.type}\n`);
                }

                // fullOldResponseJson += JSON.stringify(chunk)+"\n";
                // fullResponseJson += JSON.stringify(chunk)+"\n\n";
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                // console.log(`data: ${JSON.stringify(chunk)}\n`);
            }
        }
        if (openStop && needsConversion) {
            res.write(`data: ${JSON.stringify(getOpenAIStreamChunkStop(model))}\n\n`);
            // console.log(`data: ${JSON.stringify(getOpenAIStreamChunkStop(model))}\n`);
        }

        // Stream request completed successfully, count usage, reset error count to 0
        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}) after successful stream request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }

    }  catch (error) {
        console.error('\n[Server] Error during stream processing:', error.stack);

        // Track error for metrics
        statusCode = error.response?.status || error.status || 500;
        errorMessage = error.message;

        // If throwOnError is true, propagate the error for retry handling
        if (throwOnError) {
            throw error;
        }

        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error (status: ${statusCode || 'unknown'})`);
            // If in pool mode and request processing failed, mark the current provider as unhealthy
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            }, error.message, statusCode);
        }

        // Use new method to create streaming error response matching fromProvider format
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        res.write(errorPayload);
        res.end();
        responseClosed = true;
    } finally {
        if (!responseClosed && !res.destroyed && res.writable) {
            res.end();
        }
        await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

        // Record metrics for this request with captured token usage
        const latencyMs = Date.now() - startTime;
        try {
            await metricsService.recordRequest({
                requestId,
                providerType: toProvider,
                providerUuid: pooluuid,
                model,
                inputTokens: streamInputTokens,
                outputTokens: streamOutputTokens,
                latencyMs,
                statusCode,
                isStreaming: true,
                errorMessage,
                clientIp,
            });
        } catch (metricsError) {
            console.error('[Metrics] Failed to record stream request metrics:', metricsError.message);
        }
        // fs.writeFile('oldResponseChunk'+Date.now()+'.json', fullOldResponseJson);
        // fs.writeFile('responseChunk'+Date.now()+'.json', fullResponseJson);
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, options = {}) {
    const { throwOnError = false, requestId = crypto.randomUUID(), clientIp = null, originalRequestBody = null } = options;
    const startTime = Date.now();
    let statusCode = 200;
    let errorMessage = null;

    // Use originalRequestBody for cache key if available (before provider conversion)
    const cacheRequestBody = originalRequestBody || requestBody;

    try{
        // === CACHE LOOKUP ===
        // Check cache before calling AI provider (only for non-streaming requests)
        if (cacheService.isCacheAvailable() && cacheService.shouldCacheRequest(cacheRequestBody)) {
            try {
                const cachedResponse = await cacheService.getCachedResponse(model, cacheRequestBody);
                if (cachedResponse) {
                    console.log(`[Cache] HIT for model: ${model}`);

                    // Record cache hit in metrics
                    const latencyMs = Date.now() - startTime;
                    try {
                        await metricsService.recordRequest({
                            requestId,
                            providerType: 'cache',
                            providerUuid: null,
                            model,
                            inputTokens: cachedResponse?.usage?.prompt_tokens || cachedResponse?.usage?.promptTokenCount || null,
                            outputTokens: cachedResponse?.usage?.completion_tokens || cachedResponse?.usage?.candidatesTokenCount || null,
                            latencyMs,
                            statusCode: 200,
                            isStreaming: false,
                            errorMessage: null,
                            clientIp,
                        });
                    } catch (metricsError) {
                        console.error('[Metrics] Failed to record cache hit metrics:', metricsError.message);
                    }

                    await handleUnifiedResponse(res, JSON.stringify(cachedResponse), false);
                    return;
                }
                console.log(`[Cache] MISS for model: ${model}`);
            } catch (cacheError) {
                console.error('[Cache] Error during cache lookup:', cacheError.message);
                // Continue with normal request flow on cache error
            }
        }
        // === END CACHE LOOKUP ===

        // The service returns the response in its native format (toProvider).
        // Claude Code returns OpenAI-compatible format directly, no conversion needed
        const toProtocol = getProtocolPrefix(toProvider);
        const needsConversion = toProtocol !== MODEL_PROTOCOL_PREFIX.CLAUDE_CODE &&
            getProtocolPrefix(fromProvider) !== toProtocol;
        requestBody.model = model;
        // fs.writeFile('oldRequest'+Date.now()+'.json', JSON.stringify(requestBody));
        const nativeResponse = await service.generateContent(model, requestBody);
        const responseText = extractResponseText(nativeResponse, toProvider);

        // Convert the response back to the client's format (fromProvider), if necessary.
        let clientResponse = nativeResponse;
        if (needsConversion) {
            console.log(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
        }

        //console.log(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        // fs.writeFile('oldResponse'+Date.now()+'.json', JSON.stringify(clientResponse));

        // === CACHE STORE ===
        // Cache successful response for future requests (only non-streaming)
        if (cacheService.isCacheAvailable() && cacheService.shouldCacheRequest(cacheRequestBody)) {
            try {
                const cacheSuccess = await cacheService.cacheResponse(model, cacheRequestBody, clientResponse);
                if (cacheSuccess) {
                    console.log(`[Cache] Stored response for model: ${model}`);
                }
            } catch (cacheError) {
                console.error('[Cache] Failed to store response:', cacheError.message);
                // Non-blocking - don't fail the request if caching fails
            }
        }
        // === END CACHE STORE ===

        // Unary request completed successfully, count usage, reset error count to 0
        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}) after successful unary request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }

        // Record successful metrics with token usage from response
        const latencyMs = Date.now() - startTime;
        // Extract token usage from response (supports OpenAI, Gemini, Claude formats)
        const usage = clientResponse?.usage || nativeResponse?.usage || nativeResponse?.usageMetadata || {};
        const inputTokens = usage.prompt_tokens || usage.promptTokenCount || usage.input_tokens || null;
        const outputTokens = usage.completion_tokens || usage.candidatesTokenCount || usage.output_tokens || null;

        try {
            await metricsService.recordRequest({
                requestId,
                providerType: toProvider,
                providerUuid: pooluuid,
                model,
                inputTokens,
                outputTokens,
                latencyMs,
                statusCode: 200,
                isStreaming: false,
                errorMessage: null,
                clientIp,
            });
        } catch (metricsError) {
            console.error('[Metrics] Failed to record unary request metrics:', metricsError.message);
        }
    } catch (error) {
        console.error('\n[Server] Error during unary processing:', error.stack);

        // Track error for metrics
        statusCode = error.response?.status || error.status || 500;
        errorMessage = error.message;

        // Record failed metrics before potentially throwing
        const latencyMs = Date.now() - startTime;
        try {
            await metricsService.recordRequest({
                requestId,
                providerType: toProvider,
                providerUuid: pooluuid,
                model,
                inputTokens: null,
                outputTokens: null,
                latencyMs,
                statusCode,
                isStreaming: false,
                errorMessage,
                clientIp,
            });
        } catch (metricsError) {
            console.error('[Metrics] Failed to record unary request metrics:', metricsError.message);
        }

        // If throwOnError is true, propagate the error for retry handling
        if (throwOnError) {
            throw error;
        }

        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Marking ${toProvider} as unhealthy due to unary error (status: ${statusCode || 'unknown'})`);
            // If in pool mode and request processing failed, mark the current provider as unhealthy
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            }, error.message, statusCode);
        }

        // Use new method to create error response matching fromProvider format
        const errorResponse = createErrorResponse(error, fromProvider);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false);
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_MODEL_LIST).
 * @param {Object} CONFIG - The server configuration object.
 */
export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    try{
        const clientProviderMap = {
            [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
            [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
        };


        const fromProvider = clientProviderMap[endpointType];
        const toProvider = CONFIG.MODEL_PROVIDER;

        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        // 1. Get the model list in the backend's native format.
        const nativeModelList = await service.listModels();

        // 2. Convert the model list to the client's expected format, if necessary.
        let clientModelList = nativeModelList;
        if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
            console.log(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
            clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
        } else {
            console.log(`[ModelList Convert] Model list format matches. No conversion needed.`);
        }

        // 3. Add models from ALL configured providers in providerPools
        if (CONFIG.providerPools) {
            const additionalModels = [];

            // Provider metadata for owned_by field
            const providerOwners = {
                'claudeCode-custom': 'claude-code',
                'gemini-antigravity': 'google-antigravity',
                'gemini-cli-oauth': 'google',
                'claude-custom': 'anthropic',
                'openai-custom': 'openai',
                'openaiResponses-custom': 'openai'
            };

            // Handle different response formats (OpenAI vs Gemini)
            const isOpenAIFormat = endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST;
            const existingModelIds = new Set(
                isOpenAIFormat
                    ? (clientModelList.data?.map(m => m.id) || [])
                    : (clientModelList.models?.map(m => m.name?.replace('models/', '') || m.name) || [])
            );

            // Iterate through ALL configured provider pools
            for (const [providerType, poolAccounts] of Object.entries(CONFIG.providerPools)) {
                if (poolAccounts && poolAccounts.length > 0) {
                    const models = getProviderModels(providerType);
                    models.forEach(modelId => {
                        if (!existingModelIds.has(modelId)) {
                            if (isOpenAIFormat) {
                                // OpenAI format
                                additionalModels.push({
                                    id: modelId,
                                    object: 'model',
                                    created: Date.now(),
                                    owned_by: providerOwners[providerType] || providerType,
                                    provider: providerType
                                });
                            } else {
                                // Gemini format
                                additionalModels.push({
                                    name: `models/${modelId}`,
                                    version: '1.0',
                                    displayName: modelId,
                                    description: `Model from ${providerType}`,
                                    provider: providerType
                                });
                            }
                            existingModelIds.add(modelId);
                        }
                    });
                }
            }

            // Merge additional models into the response
            if (additionalModels.length > 0) {
                if (isOpenAIFormat && clientModelList.data) {
                    clientModelList.data = [...clientModelList.data, ...additionalModels];
                } else if (!isOpenAIFormat && clientModelList.models) {
                    clientModelList.models = [...clientModelList.models, ...additionalModels];
                }
                console.log(`[ModelList] Added ${additionalModels.length} models from ${Object.keys(CONFIG.providerPools).length} provider pools`);
            }
        }

        console.log(`[ModelList Response] Sending model list to client: ${JSON.stringify(clientModelList)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        console.error('\n[Server] Error during model list processing:', error.stack);
        if (providerPoolManager && pooluuid) {
            // Extract HTTP status code for health check scheduling
            const statusCode = error.response?.status || error.status || null;
            console.log(`[Provider Pool] Marking ${toProvider} as unhealthy due to model list error (status: ${statusCode || 'unknown'})`);
            // If in pool mode and request processing failed, mark the current provider as unhealthy
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            }, error.message, statusCode);
        }
    }
}

// Retryable HTTP status codes (403 forbidden, 429 rate limit + 5xx server errors)
// 403 is retryable because different accounts may have different permissions/quotas
const RETRYABLE_STATUS_CODES = [403, 429, 500, 502, 503, 504];

/**
 * Check if an error is retryable based on HTTP status code
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableError(error) {
    const statusCode = error.response?.status || error.status || null;
    return RETRYABLE_STATUS_CODES.includes(statusCode);
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * Includes automatic retry with another healthy account from the same provider pool.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    const originalRequestBody = await getRequestBody(req);
    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    // Generate request ID and extract client IP for metrics tracking
    const requestId = crypto.randomUUID();
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     req.socket?.remoteAddress ||
                     null;

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];
    // Use actual provider type (may be fallback type)
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;

    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    const { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    console.log(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    // 2.3. Check if model belongs to a specific provider (model-based routing)
    // Only apply model-based routing if provider wasn't explicitly set by user (via header or path)
    const claudeCodeModels = ['opus', 'sonnet', 'haiku', 'claude-opus', 'claude-sonnet', 'claude-haiku'];
    const isClaudeCodeModel = claudeCodeModels.includes(model.toLowerCase());

    // Antigravity-only models (models that are ONLY available via gemini-antigravity, NOT gemini-cli-oauth)
    // Note: Common models like gemini-2.5-flash, gemini-2.5-pro, gemini-3-pro-preview are in BOTH providers
    const antigravityOnlyModels = [
        'gemini-claude-sonnet-4-5', 'gemini-claude-sonnet-4-5-thinking', 'gemini-claude-opus-4-5-thinking',
        'gemini-2.5-computer-use-preview-10-2025', 'gemini-3-pro-image-preview',
        'gemini-2.5-flash-thinking', 'gemini-3-pro-low', 'gpt-oss-120b-medium'
    ];
    const isAntigravityModel = antigravityOnlyModels.includes(model) || model.startsWith('gemini-claude-');

    if (isClaudeCodeModel && !CONFIG.explicitProviderSet && CONFIG.providerPools && CONFIG.providerPools['claudeCode-custom']?.length > 0) {
        console.log(`[Content Generation] Model '${model}' detected as Claude Code model, routing to claudeCode-custom`);
        const { getApiService } = await import('./service-manager.js');
        const claudeCodeConfig = { ...CONFIG, MODEL_PROVIDER: 'claudeCode-custom' };
        service = await getApiService(claudeCodeConfig, model);
        toProvider = 'claudeCode-custom';
        actualUuid = CONFIG.providerPools['claudeCode-custom'][0]?.uuid || pooluuid;
    }
    // 2.4. Route antigravity-only models to gemini-antigravity provider
    else if (isAntigravityModel && !CONFIG.explicitProviderSet && CONFIG.providerPools && CONFIG.providerPools['gemini-antigravity']?.length > 0) {
        console.log(`[Content Generation] Model '${model}' detected as Antigravity model, routing to gemini-antigravity`);
        const { getApiService } = await import('./service-manager.js');
        const antigravityConfig = { ...CONFIG, MODEL_PROVIDER: 'gemini-antigravity' };
        service = await getApiService(antigravityConfig, model);
        toProvider = 'gemini-antigravity';
        actualUuid = CONFIG.providerPools['gemini-antigravity'][0]?.uuid || pooluuid;
    }
    // 2.5. If using provider pool, re-select provider based on model (supports Fallback)
    // Note: using skipUsageCount: true here because usageCount was already incremented during initial selection
    else if (providerPoolManager && CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]) {
        const { getApiServiceWithFallback } = await import('./service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model);

        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;

        if (result.isFallback) {
            console.log(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
        } else {
            console.log(`[Content Generation] Re-selected service adapter based on model: ${model}`);
        }
    }

    // 1. Convert request body from client format to backend format, if necessary.
    let processedRequestBody = originalRequestBody;
    // fs.writeFile('originalRequestBody'+Date.now()+'.json', JSON.stringify(originalRequestBody));
    const toProtocol = getProtocolPrefix(toProvider);
    // Skip conversion for Claude Code - it accepts OpenAI-style messages directly
    if (toProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE_CODE) {
        console.log(`[Request Convert] Claude Code accepts OpenAI format directly. No conversion needed.`);
    } else if (getProtocolPrefix(fromProvider) !== toProtocol) {
        console.log(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
        processedRequestBody = convertData(originalRequestBody, 'request', fromProvider, toProvider);
    } else {
        console.log(`[Request Convert] Request format matches backend provider. No conversion needed.`);
    }

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);
    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

    // 5. Execute request with automatic retry on retryable errors
    // Retry uses other healthy accounts from the same provider pool, then tries fallback providers
    const triedUuids = new Set();
    let lastError = null;
    let currentService = service;
    let currentUuid = actualUuid;
    let currentToProvider = toProvider;
    let totalAttempts = 0;

    // Build list of provider types to try: primary + fallback chain
    const providerTypesToTry = [toProvider];
    const fallbackChain = providerPoolManager?.getFallbackChain?.(toProvider) || [];
    if (fallbackChain.length > 0) {
        providerTypesToTry.push(...fallbackChain);
    }

    // Check if retry is possible (has provider pools configured)
    const canRetry = providerPoolManager && CONFIG.providerPools;

    // Track if stream headers have been sent (for retry attempts)
    let streamHeadersSent = false;

    // Try each provider type (primary first, then fallbacks)
    for (const providerType of providerTypesToTry) {
        // Skip if this provider type doesn't have a pool configured
        if (!CONFIG.providerPools[providerType] || CONFIG.providerPools[providerType].length === 0) {
            console.log(`[Retry] Skipping provider type '${providerType}': no pool configured`);
            continue;
        }

        // Check if this provider type supports the requested model (for fallback providers)
        if (providerType !== toProvider) {
            const { getProviderModels } = await import('./provider-models.js');
            const supportedModels = getProviderModels(providerType);
            if (supportedModels.length > 0 && !supportedModels.includes(model)) {
                console.log(`[Retry] Skipping fallback provider '${providerType}': model '${model}' not supported`);
                continue;
            }
            console.log(`[Retry] Trying fallback provider '${providerType}' for model '${model}'`);
        }

        // Reset tried UUIDs for each provider type (each pool has its own accounts)
        const triedUuidsForType = new Set();

        // For fallback providers, we need to get a fresh service
        if (providerType !== toProvider || totalAttempts > 0) {
            const firstProvider = providerPoolManager.selectProvider(providerType, model, {
                excludeUuids: triedUuidsForType,
                skipUsageCount: false
            });

            if (!firstProvider) {
                console.log(`[Retry] No healthy providers in '${providerType}' pool`);
                continue;
            }

            try {
                const { getApiService } = await import('./service-manager.js');
                const retryConfig = {
                    ...CONFIG,
                    MODEL_PROVIDER: providerType,
                    ...firstProvider
                };
                currentService = await getApiService(retryConfig, model);
                currentUuid = firstProvider.uuid;
                currentToProvider = providerType;
                // Track this UUID immediately to prevent duplicate selection
                triedUuidsForType.add(currentUuid);
                triedUuids.add(currentUuid);
            } catch (serviceError) {
                console.error(`[Retry] Failed to create service for provider '${providerType}':`, serviceError.message);
                continue;
            }
        }

        // Try all accounts in this provider type
        while (true) {
            // Add current provider to tried list
            if (currentUuid) {
                triedUuidsForType.add(currentUuid);
                triedUuids.add(currentUuid); // Global tracking
            }
            totalAttempts++;

            // Determine if we should throw on error (for retry) or handle internally
            // Count healthy providers that haven't been tried yet
            const availableProviders = providerPoolManager.providerStatus?.[currentToProvider] || [];
            const healthyAvailableCount = availableProviders.filter(p =>
                p.config.isHealthy &&
                !p.config.isDisabled &&
                !triedUuidsForType.has(p.config.uuid)
            ).length;
            const hasMoreAccountsInPool = healthyAvailableCount > 0;
            const hasMoreFallbackProviders = providerTypesToTry.indexOf(currentToProvider) < providerTypesToTry.length - 1;
            const shouldThrowOnError = canRetry && (hasMoreAccountsInPool || hasMoreFallbackProviders);

            try {
                // Clone request body to avoid mutation between retries
                const requestBodyCopy = JSON.parse(JSON.stringify(processedRequestBody));

                if (isStream) {
                    await handleStreamRequest(res, currentService, model, requestBodyCopy, fromProvider, currentToProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, currentUuid, { throwOnError: shouldThrowOnError, requestId, clientIp, headersAlreadySent: streamHeadersSent });
                    streamHeadersSent = true;  // Mark headers as sent after first attempt
                } else {
                    // Pass originalRequestBody for cache key generation (before any conversions)
                    await handleUnaryRequest(res, currentService, model, requestBodyCopy, fromProvider, currentToProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, currentUuid, { throwOnError: shouldThrowOnError, requestId, clientIp, originalRequestBody });
                }
                // Success - exit all loops
                return;
            } catch (error) {
                lastError = error;
                const statusCode = error.response?.status || error.status || null;

                // Mark this provider as unhealthy
                if (providerPoolManager && currentUuid) {
                    console.log(`[Retry] Marking provider ${currentToProvider} (${currentUuid}) as unhealthy due to error (status: ${statusCode || 'unknown'})`);
                    providerPoolManager.markProviderUnhealthy(currentToProvider, { uuid: currentUuid }, error.message, statusCode);
                }

                // Check if error is retryable
                if (!isRetryableError(error)) {
                    console.log(`[Retry] Error is not retryable (status: ${statusCode}). Sending error to client.`);
                    // Non-retryable error - exit all loops and send error
                    break;
                }

                // Try to select another provider from the same pool
                const nextProvider = providerPoolManager.selectProvider(currentToProvider, model, {
                    excludeUuids: triedUuidsForType,
                    skipUsageCount: true
                });

                if (!nextProvider) {
                    console.log(`[Retry] No more healthy providers in pool '${currentToProvider}' after ${triedUuidsForType.size} attempts. Trying next provider type...`);
                    break; // Exit inner loop, try next provider type
                }

                // Get new service for the next provider
                console.log(`[Retry] Attempt ${totalAttempts} failed with ${statusCode}. Retrying with another account: ${nextProvider.customName || nextProvider.uuid}`);

                try {
                    const { getApiService } = await import('./service-manager.js');
                    const retryConfig = {
                        ...CONFIG,
                        MODEL_PROVIDER: currentToProvider,
                        ...nextProvider
                    };
                    currentService = await getApiService(retryConfig, model);
                    currentUuid = nextProvider.uuid;
                } catch (serviceError) {
                    console.error(`[Retry] Failed to create service for retry provider:`, serviceError.message);
                    break; // Exit inner loop, try next provider type
                }
            }
        }

        // If we got a non-retryable error, don't try fallback providers
        if (lastError && !isRetryableError(lastError)) {
            break;
        }
    }

    // All retries exhausted across all provider types - send error response to client
    console.log(`[Retry] All ${totalAttempts} attempts exhausted across ${providerTypesToTry.length} provider types for model '${model}'. Sending error to client.`);
    if (lastError) {
        if (isStream) {
            // For streaming, only send error if we haven't already sent it
            // (headers already sent means error was already written in handleStreamRequest)
            if (!res.headersSent && !res.destroyed && res.writable) {
                const errorPayload = createStreamErrorResponse(lastError, fromProvider);
                await handleUnifiedResponse(res, '', true);
                res.write(errorPayload);
                res.end();
            } else if (!res.destroyed && res.writable) {
                // Headers sent but stream still writable - just end it
                res.end();
            }
        } else {
            // For unary, send error response (only if not already sent)
            if (!res.headersSent && !res.destroyed && res.writable) {
                const errorResponse = createErrorResponse(lastError, fromProvider);
                await handleUnifiedResponse(res, JSON.stringify(errorResponse), false);
            }
        }
    }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
    return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}

export function handleError(res, error) {
    const statusCode = error.response?.status || 500;
    let errorMessage = error.message;
    let suggestions = [];

    // Provide detailed information and suggestions for different error types
    switch (statusCode) {
        case 401:
            errorMessage = 'Authentication failed. Please check your credentials.';
            suggestions = [
                'Verify your OAuth credentials are valid',
                'Try re-authenticating by deleting the credentials file',
                'Check if your Google Cloud project has the necessary permissions'
            ];
            break;
        case 403:
            errorMessage = 'Access forbidden. Insufficient permissions.';
            suggestions = [
                'Ensure your Google Cloud project has the Code Assist API enabled',
                'Check if your account has the necessary permissions',
                'Verify the project ID is correct'
            ];
            break;
        case 429:
            errorMessage = 'Too many requests. Rate limit exceeded.';
            suggestions = [
                'The request has been automatically retried with exponential backoff',
                'If the issue persists, try reducing the request frequency',
                'Consider upgrading your API quota if available'
            ];
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = 'Server error occurred. This is usually temporary.';
            suggestions = [
                'The request has been automatically retried',
                'If the issue persists, try again in a few minutes',
                'Check Google Cloud status page for service outages'
            ];
            break;
        default:
            if (statusCode >= 400 && statusCode < 500) {
                errorMessage = `Client error (${statusCode}): ${error.message}`;
                suggestions = ['Check your request format and parameters'];
            } else if (statusCode >= 500) {
                errorMessage = `Server error (${statusCode}): ${error.message}`;
                suggestions = ['This is a server-side issue, please try again later'];
            }
    }

    console.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}`);
    if (suggestions.length > 0) {
        console.error('[Server] Suggestions:');
        suggestions.forEach((suggestion, index) => {
            console.error(`  ${index + 1}. ${suggestion}`);
        });
    }
    console.error('[Server] Full error details:', error.stack);

    const errorPayload = JSON.stringify({
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions: suggestions,
            details: error.response?.data
        }
    });

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    if (!res.destroyed && res.writable) {
        res.end(errorPayload);
    }
}

/**
 * Extracts system prompt from request body.
 * @param {Object} requestBody - The request body object.
 * @param {string} provider - Provider type ('openai', 'gemini', 'claude').
 * @returns {string} The extracted system prompt string.
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
        case MODEL_PROTOCOL_PREFIX.CLAUDE_CODE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        default:
            console.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}


/**
 * Creates error response matching fromProvider format (non-streaming)
 * @param {Error} error - The error object
 * @param {string} fromProvider - The provider format expected by the client
 * @returns {Object} Formatted error response object
 */
function createErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = error.status || error.code || 500;
    const errorMessage = error.message || "An error occurred during processing.";

    // Map error type based on HTTP status code
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };

    // Map Gemini status based on HTTP status code
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI non-streaming error format
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)  // OpenAI uses code field as core judgment
                }
            };

        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API non-streaming error format
            return {
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude non-streaming error format (outer type marker)
            return {
                type: "error",  // Core distinguishing marker
                error: {
                    type: getErrorType(statusCode),  // Claude uses error.type as core judgment
                    message: errorMessage
                }
            };

        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini non-streaming error format (follows Google Cloud standard)
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)  // Gemini uses status as core judgment
                }
            };

        default:
            // Default to OpenAI format
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)
                }
            };
    }
}

/**
 * Creates streaming error response matching fromProvider format
 * @param {Error} error - The error object
 * @param {string} fromProvider - The provider format expected by the client
 * @returns {string} Formatted streaming error response string
 */
function createStreamErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = error.status || error.code || 500;
    const errorMessage = error.message || "An error occurred during streaming.";

    // Map error type based on HTTP status code
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };

    // Map Gemini status based on HTTP status code
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI streaming error format (SSE data block)
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;

        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API streaming error format (SSE event + data)
            const responsesError = {
                id: `resp_${Date.now()}`,
                object: "error",
                created: Math.floor(Date.now() / 1000),
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude streaming error format (SSE event + data)
            const claudeError = {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;

        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini streaming error format
            // Note: Although Gemini natively uses JSON arrays, in our implementation it's converted to SSE format
            // So we need to use data: prefix here to maintain consistency with normal streaming responses
            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)
                }
            };
            return `data: ${JSON.stringify(geminiError)}\n\n`;

        default:
            // Default to OpenAI SSE format
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
    }
}