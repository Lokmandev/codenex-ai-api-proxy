// Configuration management feature module

import { showToast } from './utils.js';

let allConfigs = []; // Store all configuration data
let filteredConfigs = []; // Store filtered configuration data
let isLoadingConfigs = false; // Prevent duplicate configuration loading

/**
 * Search configurations
 * @param {string} searchTerm - Search keyword
 * @param {string} statusFilter - Status filter
 */
function searchConfigs(searchTerm = '', statusFilter = '') {
    if (!allConfigs.length) {
        console.log('No configuration data to search');
        return;
    }

    filteredConfigs = allConfigs.filter(config => {
        // Search filter
        const matchesSearch = !searchTerm ||
            config.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            config.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
            (config.content && config.content.toLowerCase().includes(searchTerm.toLowerCase()));

        // Status filter - convert from boolean isUsed to status string
        const configStatus = config.isUsed ? 'used' : 'unused';
        const matchesStatus = !statusFilter || configStatus === statusFilter;

        return matchesSearch && matchesStatus;
    });

    renderConfigList();
    updateStats();
}

/**
 * Render configuration list
 */
function renderConfigList() {
    const container = document.getElementById('configList');
    if (!container) return;

    container.innerHTML = '';

    if (!filteredConfigs.length) {
        container.innerHTML = `<div class="no-configs"><p>No configuration files found</p></div>`;
        return;
    }

    filteredConfigs.forEach((config, index) => {
        const configItem = createConfigItemElement(config, index);
        container.appendChild(configItem);
    });
}

/**
 * Create configuration item element
 * @param {Object} config - Configuration data
 * @param {number} index - Index
 * @returns {HTMLElement} Configuration item element
 */
function createConfigItemElement(config, index) {
    // Convert from boolean isUsed to status string for display
    const configStatus = config.isUsed ? 'used' : 'unused';
    const item = document.createElement('div');
    item.className = `config-item-manager ${configStatus}`;
    item.dataset.index = index;

    const statusIcon = config.isUsed ? 'fa-check-circle' : 'fa-circle';
    const statusText = config.isUsed ? 'In use' : 'Not in use';

    const typeIcon = config.type === 'oauth' ? 'fa-key' :
        config.type === 'api-key' ? 'fa-lock' :
            config.type === 'provider-pool' ? 'fa-network-wired' :
                config.type === 'system-prompt' ? 'fa-file-text' : 'fa-cog';

    // Generate association details HTML
    const usageInfoHtml = generateUsageInfoHtml(config);

    // Check if quick link is available (not linked and path contains supported provider directory)
    const providerInfo = detectProviderFromPath(config.path);
    const canQuickLink = !config.isUsed && providerInfo !== null;
    const quickLinkBtnHtml = canQuickLink ?
        `<button class="btn-quick-link" data-path="${config.path}" title="Quick link to ${providerInfo.displayName}">
            <i class="fas fa-link"></i> ${providerInfo.shortName}
        </button>` : '';

    item.innerHTML = `
        <div class="config-item-header">
            <div class="config-item-name">${config.name}</div>
            <div class="config-item-path" title="${config.path}">${config.path}</div>
        </div>
        <div class="config-item-meta">
            <div class="config-item-size">${formatFileSize(config.size)}</div>
            <div class="config-item-modified">${formatDate(config.modified)}</div>
            <div class="config-item-status">
                <i class="fas ${statusIcon}"></i>
                <span data-i18n="${config.isUsed ? 'upload.statusFilter.used' : 'upload.statusFilter.unused'}">${statusText}</span>
                ${quickLinkBtnHtml}
            </div>
        </div>
        <div class="config-item-details">
            <div class="config-details-grid">
                <div class="config-detail-item">
                    <div class="config-detail-label" data-i18n="upload.detail.path">File Path</div>
                    <div class="config-detail-value">${config.path}</div>
                </div>
                <div class="config-detail-item">
                    <div class="config-detail-label" data-i18n="upload.detail.size">File Size</div>
                    <div class="config-detail-value">${formatFileSize(config.size)}</div>
                </div>
                <div class="config-detail-item">
                    <div class="config-detail-label" data-i18n="upload.detail.modified">Last Modified</div>
                    <div class="config-detail-value">${formatDate(config.modified)}</div>
                </div>
                <div class="config-detail-item">
                    <div class="config-detail-label" data-i18n="upload.detail.status">Association Status</div>
                    <div class="config-detail-value" data-i18n="${config.isUsed ? 'upload.statusFilter.used' : 'upload.statusFilter.unused'}">${statusText}</div>
                </div>
            </div>
            ${usageInfoHtml}
            <div class="config-item-actions">
                <button class="btn-small btn-view" data-path="${config.path}">
                    <i class="fas fa-eye"></i> <span>View</span>
                </button>
                <button class="btn-small btn-delete-small" data-path="${config.path}">
                    <i class="fas fa-trash"></i> <span>Delete</span>
                </button>
            </div>
        </div>
    `;

    // Add button event listeners
    const viewBtn = item.querySelector('.btn-view');
    const deleteBtn = item.querySelector('.btn-delete-small');

    if (viewBtn) {
        viewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            viewConfig(config.path);
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteConfig(config.path);
        });
    }

    // Quick link button event
    const quickLinkBtn = item.querySelector('.btn-quick-link');
    if (quickLinkBtn) {
        quickLinkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            quickLinkProviderConfig(config.path);
        });
    }

    // Add click event to expand/collapse details
    item.addEventListener('click', (e) => {
        if (!e.target.closest('.config-item-actions')) {
            item.classList.toggle('expanded');
        }
    });

    return item;
}

/**
 * Generate association details HTML
 * @param {Object} config - Configuration data
 * @returns {string} HTML string
 */
function generateUsageInfoHtml(config) {
    if (!config.usageInfo || !config.usageInfo.isUsed) {
        return '';
    }

    const { usageType, usageDetails } = config.usageInfo;

    if (!usageDetails || usageDetails.length === 0) {
        return '';
    }

    const typeLabels = {
        'main_config': 'Main Config',
        'provider_pool': 'Provider Pool',
        'multiple': 'Multiple'
    };

    const typeLabel = typeLabels[usageType] || 'Unknown';

    let detailsHtml = '';
    usageDetails.forEach(detail => {
        const isMain = detail.type === 'Main Config' || detail.type === 'Main Config';
        const icon = isMain ? 'fa-cog' : 'fa-network-wired';
        const usageTypeKey = isMain ? 'main_config' : 'provider_pool';
        detailsHtml += `
            <div class="usage-detail-item" data-usage-type="${usageTypeKey}">
                <i class="fas ${icon}"></i>
                <span class="usage-detail-type">${detail.type}</span>
                <span class="usage-detail-location">${detail.location}</span>
            </div>
        `;
    });

    return `
        <div class="config-usage-info">
            <div class="usage-info-header">
                <i class="fas fa-link"></i>
                <span class="usage-info-title" data-i18n="upload.usage.title" data-i18n-params='{"type":"${typeLabel}"}'>Association Details (${typeLabel})</span>
            </div>
            <div class="usage-details-list">
                ${detailsHtml}
            </div>
        </div>
    `;
}

/**
 * Format file size
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format date
 * @param {string} dateString - Date string
 * @returns {string} Formatted date
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('en', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Update statistics
 */
function updateStats() {
    const totalCount = filteredConfigs.length;
    const usedCount = filteredConfigs.filter(config => config.isUsed).length;
    const unusedCount = filteredConfigs.filter(config => !config.isUsed).length;

    const totalEl = document.getElementById('configCount');
    const usedEl = document.getElementById('usedConfigCount');
    const unusedEl = document.getElementById('unusedConfigCount');

    if (totalEl) {
        totalEl.textContent = `Total: ${totalCount}`;
        totalEl.setAttribute('data-i18n-params', JSON.stringify({ count: totalCount.toString() }));
    }
    if (usedEl) {
        usedEl.textContent = `In use: ${usedCount}`;
        usedEl.setAttribute('data-i18n-params', JSON.stringify({ count: usedCount.toString() }));
    }
    if (unusedEl) {
        unusedEl.textContent = `Not in use: ${unusedCount}`;
        unusedEl.setAttribute('data-i18n-params', JSON.stringify({ count: unusedCount.toString() }));
    }
}

/**
 * Load configuration file list
 */
async function loadConfigList() {
    // Prevent duplicate loading
    if (isLoadingConfigs) {
        console.log('Loading configuration list, skipping duplicate call');
        return;
    }

    isLoadingConfigs = true;
    console.log('Starting to load configuration list...');

    try {
        const result = await window.apiClient.get('/upload-configs');
        allConfigs = result;
        filteredConfigs = [...allConfigs];
        renderConfigList();
        updateStats();
        console.log('Configuration list loaded successfully, total', allConfigs.length, 'items');
        // showToast('Success', 'Refresh successful', 'success');
    } catch (error) {
        console.error('Failed to load configuration list:', error);
        showToast('Error', 'Error: ' + error.message, 'error');

        // Use mock data as example
        allConfigs = generateMockConfigData();
        filteredConfigs = [...allConfigs];
        renderConfigList();
        updateStats();
    } finally {
        isLoadingConfigs = false;
        console.log('Configuration list loading complete');
    }
}

/**
 * Generate mock configuration data (for demonstration)
 * @returns {Array} Mock configuration data
 */
function generateMockConfigData() {
    return [
        {
            name: 'provider_pools.json',
            path: './configs/provider_pools.json',
            type: 'provider-pool',
            size: 2048,
            modified: '2025-11-11T04:30:00.000Z',
            isUsed: true,
            content: JSON.stringify({
                "gemini-cli-oauth": [
                    {
                        "GEMINI_OAUTH_CREDS_FILE_PATH": "~/.gemini/oauth/creds.json",
                        "PROJECT_ID": "test-project"
                    }
                ]
            }, null, 2)
        },
        {
            name: 'config.json',
            path: './configs/config.json',
            type: 'other',
            size: 1024,
            modified: '2025-11-10T12:00:00.000Z',
            isUsed: true,
            content: JSON.stringify({
                "REQUIRED_API_KEY": "123456",
                "SERVER_PORT": 3000
            }, null, 2)
        },
        {
            name: 'oauth_creds.json',
            path: '~/.gemini/oauth/creds.json',
            type: 'oauth',
            size: 512,
            modified: '2025-11-09T08:30:00.000Z',
            isUsed: false,
            content: '{"client_id": "test", "client_secret": "test"}'
        },
        {
            name: 'input_system_prompt.txt',
            path: './configs/input_system_prompt.txt',
            type: 'system-prompt',
            size: 256,
            modified: '2025-11-08T15:20:00.000Z',
            isUsed: true,
            content: 'You are a helpful AI assistant...'
        },
        {
            name: 'invalid_config.json',
            path: './invalid_config.json',
            type: 'other',
            size: 128,
            modified: '2025-11-07T10:15:00.000Z',
            isUsed: false,
            content: '{"invalid": json}'
        }
    ];
}

/**
 * View configuration
 * @param {string} path - File path
 */
async function viewConfig(path) {
    try {
        const fileData = await window.apiClient.get(`/upload-configs/view/${encodeURIComponent(path)}`);
        showConfigModal(fileData);
    } catch (error) {
        console.error('Failed to view configuration:', error);
        showToast('Error', 'View failed: ' + error.message, 'error');
    }
}

/**
 * Show configuration modal
 * @param {Object} fileData - File data
 */
function showConfigModal(fileData) {
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'config-view-modal';
    modal.innerHTML = `
        <div class="config-modal-content">
            <div class="config-modal-header">
                <h3><span>Configuration</span>: ${fileData.name}</h3>
                <button class="modal-close">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="config-modal-body">
                <div class="config-file-info">
                    <div class="file-info-item">
                        <span class="info-label">File Path:</span>
                        <span class="info-value">${fileData.path}</span>
                    </div>
                    <div class="file-info-item">
                        <span class="info-label">File Size:</span>
                        <span class="info-value">${formatFileSize(fileData.size)}</span>
                    </div>
                    <div class="file-info-item">
                        <span class="info-label">Last Modified:</span>
                        <span class="info-value">${formatDate(fileData.modified)}</span>
                    </div>
                </div>
                <div class="config-content">
                    <label>File Content:</label>
                    <pre class="config-content-display">${escapeHtml(fileData.content)}</pre>
                </div>
            </div>
            <div class="config-modal-footer">
                <button class="btn btn-secondary btn-close-modal">Cancel</button>
                <button class="btn btn-primary btn-copy-content" data-path="${fileData.path}">
                    <i class="fas fa-copy"></i> <span>Copy</span>
                </button>
            </div>
        </div>
    `;

    // Add to page
    document.body.appendChild(modal);

    // Add button event listeners
    const closeBtn = modal.querySelector('.btn-close-modal');
    const copyBtn = modal.querySelector('.btn-copy-content');
    const modalCloseBtn = modal.querySelector('.modal-close');

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            closeConfigModal();
        });
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const path = copyBtn.dataset.path;
            copyConfigContent(path);
        });
    }

    if (modalCloseBtn) {
        modalCloseBtn.addEventListener('click', () => {
            closeConfigModal();
        });
    }

    // Show modal
    setTimeout(() => modal.classList.add('show'), 10);
}

/**
 * Close configuration modal
 */
function closeConfigModal() {
    const modal = document.querySelector('.config-view-modal');
    if (modal) {
        modal.classList.remove('show');
        setTimeout(() => modal.remove(), 300);
    }
}

/**
 * Copy configuration content
 * @param {string} path - File path
 */
async function copyConfigContent(path) {
    try {
        const fileData = await window.apiClient.get(`/upload-configs/view/${encodeURIComponent(path)}`);

        // Try to use modern Clipboard API
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(fileData.content);
            showToast('Success', 'Copied to clipboard', 'success');
        } else {
            // Fallback: use traditional document.execCommand
            const textarea = document.createElement('textarea');
            textarea.value = fileData.content;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();

            try {
                const successful = document.execCommand('copy');
                if (successful) {
                    showToast('Success', 'Copied to clipboard', 'success');
                } else {
                    showToast('Error', 'Copy failed', 'error');
                }
            } catch (err) {
                console.error('Copy failed:', err);
                showToast('Error', 'Copy failed', 'error');
            } finally {
                document.body.removeChild(textarea);
            }
        }
    } catch (error) {
        console.error('Copy failed:', error);
        showToast('Error', 'Copy failed: ' + error.message, 'error');
    }
}

/**
 * HTML escape
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Show delete confirmation modal
 * @param {Object} config - Configuration data
 */
function showDeleteConfirmModal(config) {
    const isUsed = config.isUsed;
    const modalClass = isUsed ? 'delete-confirm-modal used' : 'delete-confirm-modal unused';
    const title = isUsed ? 'Delete In-Use Configuration' : 'Delete Configuration';
    const icon = isUsed ? 'fas fa-exclamation-triangle' : 'fas fa-trash';
    const buttonClass = isUsed ? 'btn btn-danger' : 'btn btn-warning';

    const modal = document.createElement('div');
    modal.className = modalClass;

    modal.innerHTML = `
        <div class="delete-modal-content">
            <div class="delete-modal-header">
                <h3><i class="${icon}"></i> ${title}</h3>
                <button class="modal-close">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="delete-modal-body">
                <div class="delete-warning ${isUsed ? 'warning-used' : 'warning-unused'}">
                    <div class="warning-icon">
                        <i class="${icon}"></i>
                    </div>
                    <div class="warning-content">
                        ${isUsed ?
            `<h4>Warning: Configuration In Use</h4><p>This configuration file is currently being used by the system.</p>` :
            `<h4>Safe to Delete</h4><p>This configuration file is not currently in use.</p>`
        }
                    </div>
                </div>

                <div class="config-info">
                    <div class="config-info-item">
                        <span class="info-label">File Name:</span>
                        <span class="info-value">${config.name}</span>
                    </div>
                    <div class="config-info-item">
                        <span class="info-label">File Path:</span>
                        <span class="info-value">${config.path}</span>
                    </div>
                    <div class="config-info-item">
                        <span class="info-label">File Size:</span>
                        <span class="info-value">${formatFileSize(config.size)}</span>
                    </div>
                    <div class="config-info-item">
                        <span class="info-label">Status:</span>
                        <span class="info-value status-${isUsed ? 'used' : 'unused'}">
                            ${isUsed ? 'In use' : 'Not in use'}
                        </span>
                    </div>
                </div>

                ${isUsed ? `
                    <div class="usage-alert">
                        <div class="alert-icon">
                            <i class="fas fa-info-circle"></i>
                        </div>
                        <div class="alert-content">
                            <h5>Important Notice</h5>
                            <p>Deleting this file may affect system operation.</p>
                            <ul>
                                <li>Make sure you have a backup before deleting</li>
                                <li>System may need to be reconfigured after deletion</li>
                                <li>Consider disabling the configuration instead of deleting</li>
                            </ul>
                            <p>We recommend updating configuration references before deleting this file.</p>
                        </div>
                    </div>
                ` : ''}
            </div>
            <div class="delete-modal-footer">
                <button class="btn btn-secondary btn-cancel-delete">Cancel</button>
                <button class="${buttonClass} btn-confirm-delete" data-path="${config.path}">
                    <i class="fas fa-${isUsed ? 'exclamation-triangle' : 'trash'}"></i>
                    <span>${isUsed ? 'Force Delete' : 'Delete'}</span>
                </button>
            </div>
        </div>
    `;

    // Add to page
    document.body.appendChild(modal);

    // Add event listeners
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.btn-cancel-delete');
    const confirmBtn = modal.querySelector('.btn-confirm-delete');

    const closeModal = () => {
        modal.classList.remove('show');
        setTimeout(() => modal.remove(), 300);
    };

    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            const path = confirmBtn.dataset.path;
            performDelete(path);
            closeModal();
        });
    }

    // Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Close on ESC key
    const handleEsc = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', handleEsc);
        }
    };
    document.addEventListener('keydown', handleEsc);

    // Show modal
    setTimeout(() => modal.classList.add('show'), 10);
}

/**
 * Perform delete operation
 * @param {string} path - File path
 */
async function performDelete(path) {
    try {
        const result = await window.apiClient.delete(`/upload-configs/delete/${encodeURIComponent(path)}`);
        showToast('Success', result.message, 'success');

        // Remove from local list
        allConfigs = allConfigs.filter(c => c.path !== path);
        filteredConfigs = filteredConfigs.filter(c => c.path !== path);
        renderConfigList();
        updateStats();
    } catch (error) {
        console.error('Failed to delete configuration:', error);
        showToast('Error', 'Delete failed: ' + error.message, 'error');
    }
}

/**
 * Delete configuration
 * @param {string} path - File path
 */
async function deleteConfig(path) {
    const config = filteredConfigs.find(c => c.path === path) || allConfigs.find(c => c.path === path);
    if (!config) {
        showToast('Error', 'Configuration not found', 'error');
        return;
    }

    // Show delete confirmation modal
    showDeleteConfirmModal(config);
}

/**
 * Initialize configuration management page
 */
function initUploadConfigManager() {
    // Bind search events
    const searchInput = document.getElementById('configSearch');
    const searchBtn = document.getElementById('searchConfigBtn');
    const statusFilter = document.getElementById('configStatusFilter');
    const refreshBtn = document.getElementById('refreshConfigList');
    const downloadAllBtn = document.getElementById('downloadAllConfigs');

    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => {
            const searchTerm = searchInput.value.trim();
            const currentStatusFilter = statusFilter?.value || '';
            searchConfigs(searchTerm, currentStatusFilter);
        }, 300));
    }

    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            const searchTerm = searchInput?.value.trim() || '';
            const currentStatusFilter = statusFilter?.value || '';
            searchConfigs(searchTerm, currentStatusFilter);
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', () => {
            const searchTerm = searchInput?.value.trim() || '';
            const currentStatusFilter = statusFilter.value;
            searchConfigs(searchTerm, currentStatusFilter);
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadConfigList);
    }

    if (downloadAllBtn) {
        downloadAllBtn.addEventListener('click', downloadAllConfigs);
    }

    // Batch link configuration button
    const batchLinkBtn = document.getElementById('batchLinkOAuthBtn') || document.getElementById('batchLinkProviderBtn');
    if (batchLinkBtn) {
        batchLinkBtn.addEventListener('click', batchLinkProviderConfigs);
    }

    // Initial load configuration list
    loadConfigList();
}

/**
 * Reload configuration files
 */
async function reloadConfig() {
    // Prevent duplicate reload
    if (isLoadingConfigs) {
        console.log('Reloading configuration, skipping duplicate call');
        return;
    }

    try {
        const result = await window.apiClient.post('/reload-config');
        showToast('Success', result.message, 'success');

        // Reload configuration list to reflect latest association status
        await loadConfigList();

        // Note: no longer sending configReloaded event to avoid duplicate calls
        // window.dispatchEvent(new CustomEvent('configReloaded', {
        //     detail: result.details
        // }));

    } catch (error) {
        console.error('Failed to reload configuration:', error);
        showToast('Error', 'Refresh failed: ' + error.message, 'error');
    }
}

/**
 * Detect provider type based on file path
 * @param {string} filePath - File path
 * @returns {Object|null} Provider info object or null
 */
function detectProviderFromPath(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

    // Define directory to provider mapping
    const providerMappings = [
        {
            patterns: ['configs/gemini/', '/gemini/', 'configs/gemini-cli/'],
            providerType: 'gemini-cli-oauth',
            displayName: 'Gemini CLI OAuth',
            shortName: 'gemini-oauth'
        },
        {
            patterns: ['configs/antigravity/', '/antigravity/'],
            providerType: 'gemini-antigravity',
            displayName: 'Gemini Antigravity',
            shortName: 'antigravity'
        }
    ];

    // Iterate through mappings to find matching provider
    for (const mapping of providerMappings) {
        for (const pattern of mapping.patterns) {
            if (normalizedPath.includes(pattern)) {
                return {
                    providerType: mapping.providerType,
                    displayName: mapping.displayName,
                    shortName: mapping.shortName
                };
            }
        }
    }

    return null;
}

/**
 * Quick link configuration to corresponding provider
 * @param {string} filePath - Configuration file path
 */
async function quickLinkProviderConfig(filePath) {
    try {
        const providerInfo = detectProviderFromPath(filePath);
        if (!providerInfo) {
            showToast('Error', 'Could not identify provider from path', 'error');
            return;
        }

        showToast('Info', `Linking to ${providerInfo.displayName}...`, 'info');

        const result = await window.apiClient.post('/quick-link-provider', {
            filePath: filePath
        });

        showToast('Success', result.message || 'Link successful', 'success');

        // Refresh configuration list
        await loadConfigList();
    } catch (error) {
        console.error('Quick link failed:', error);
        showToast('Error', 'Link failed: ' + error.message, 'error');
    }
}

/**
 * Batch link all unlinked configurations in supported provider directories
 */
async function batchLinkProviderConfigs() {
    // Filter out all unlinked configurations in supported provider directories
    const unlinkedConfigs = allConfigs.filter(config => {
        if (config.isUsed) return false;
        const providerInfo = detectProviderFromPath(config.path);
        return providerInfo !== null;
    });

    if (unlinkedConfigs.length === 0) {
        showToast('Info', 'No unlinked configurations found', 'info');
        return;
    }

    // Group statistics by provider type
    const groupedByProvider = {};
    unlinkedConfigs.forEach(config => {
        const providerInfo = detectProviderFromPath(config.path);
        if (providerInfo) {
            if (!groupedByProvider[providerInfo.displayName]) {
                groupedByProvider[providerInfo.displayName] = 0;
            }
            groupedByProvider[providerInfo.displayName]++;
        }
    });

    const providerSummary = Object.entries(groupedByProvider)
        .map(([name, count]) => `${name}: ${count}`)
        .join(', ');

    const confirmMsg = `Link ${unlinkedConfigs.length} configurations? (${providerSummary})`;
    if (!confirm(confirmMsg)) {
        return;
    }

    showToast('Info', `Linking ${unlinkedConfigs.length} configurations...`, 'info');

    let successCount = 0;
    let failCount = 0;

    for (const config of unlinkedConfigs) {
        try {
            await window.apiClient.post('/quick-link-provider', {
                filePath: config.path
            });
            successCount++;
        } catch (error) {
            console.error(`Link failed: ${config.path}`, error);
            failCount++;
        }
    }

    // Refresh configuration list
    await loadConfigList();

    if (failCount === 0) {
        showToast('Success', `Successfully linked ${successCount} configurations`, 'success');
    } else {
        showToast('Warning', `Linked ${successCount} configurations, ${failCount} failed`, 'warning');
    }
}

/**
 * Debounce function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time (milliseconds)
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Download all configuration files as package
 */
async function downloadAllConfigs() {
    try {
        showToast('Info', 'Loading...', 'info');

        // Use window.apiClient.get to get Blob data
        // Since apiClient may default to handling JSON, we need to call fetch directly or ensure apiClient supports returning raw response
        const token = localStorage.getItem('authToken');
        const headers = {
            'Authorization': token ? `Bearer ${token}` : ''
        };

        const response = await fetch('/api/upload-configs/download-all', { headers });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'Download failed');
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // Extract filename from Content-Disposition, or use default name
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = `configs_backup_${new Date().toISOString().slice(0, 10)}.zip`;
        if (contentDisposition && contentDisposition.indexOf('filename=') !== -1) {
            const matches = /filename="([^"]+)"/.exec(contentDisposition);
            if (matches && matches[1]) filename = matches[1];
        }

        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        showToast('Success', 'Download started', 'success');
    } catch (error) {
        console.error('Package download failed:', error);
        showToast('Error', 'Download failed: ' + error.message, 'error');
    }
}

// Export functions
export {
    initUploadConfigManager,
    searchConfigs,
    loadConfigList,
    viewConfig,
    deleteConfig,
    closeConfigModal,
    copyConfigContent,
    reloadConfig
};