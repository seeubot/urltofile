// API Base URL
const API_BASE_URL = window.location.origin;

// DOM Elements
const channelsGrid = document.getElementById('channelsGrid');
const noChannelsMessage = document.getElementById('noChannelsMessage');
const searchInput = document.getElementById('searchInput');
const categoryFilter = document.getElementById('categoryFilter');
const statusFilter = document.getElementById('statusFilter');
const qualityFilter = document.getElementById('qualityFilter');

// State
let channels = [];
let stats = {};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadChannels();
    loadStats();
    
    // Set up event listeners for filters
    searchInput.addEventListener('input', filterChannels);
    categoryFilter.addEventListener('change', filterChannels);
    statusFilter.addEventListener('change', filterChannels);
    qualityFilter.addEventListener('change', filterChannels);
});

// Load all channels
async function loadChannels() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/channels`);
        if (!response.ok) throw new Error('Failed to fetch channels');
        
        channels = await response.json();
        renderChannels(channels);
        updateNoChannelsMessage();
    } catch (error) {
        console.error('Error loading channels:', error);
        showNotification('Error loading channels', 'danger');
    }
}

// Load dashboard stats
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/stats`);
        if (!response.ok) throw new Error('Failed to fetch stats');
        
        stats = await response.json();
        updateStatsDisplay();
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Render channels to the grid
function renderChannels(channelsToRender) {
    channelsGrid.innerHTML = '';
    
    channelsToRender.forEach(channel => {
        const channelCard = createChannelCard(channel);
        channelsGrid.appendChild(channelCard);
    });
}

// Create a channel card element
function createChannelCard(channel) {
    const col = document.createElement('div');
    col.className = 'col-md-4 mb-4';
    
    const statusClass = channel.isActive ? 'status-active' : 'status-inactive';
    const statusText = channel.isActive ? 'Active' : 'Inactive';
    
    col.innerHTML = `
        <div class="card channel-card h-100">
            <div class="card-body">
                <div class="d-flex justify-content-between align-items-start mb-3">
                    <div>
                        <h5 class="card-title mb-1">${escapeHtml(channel.name)}</h5>
                        <span class="badge ${statusClass} status-badge">${statusText}</span>
                    </div>
                    <div class="dropdown">
                        <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" 
                                data-bs-toggle="dropdown" aria-expanded="false">
                            <i class="fas fa-ellipsis-v"></i>
                        </button>
                        <ul class="dropdown-menu">
                            <li><a class="dropdown-item" href="#" onclick="editChannel('${channel._id}')">
                                <i class="fas fa-edit me-2"></i>Edit
                            </a></li>
                            <li><a class="dropdown-item" href="#" onclick="testChannel('${channel._id}')">
                                <i class="fas fa-play me-2"></i>Test URL
                            </a></li>
                            <li><hr class="dropdown-divider"></li>
                            <li><a class="dropdown-item text-danger" href="#" onclick="deleteChannel('${channel._id}')">
                                <i class="fas fa-trash me-2"></i>Delete
                            </a></li>
                        </ul>
                    </div>
                </div>
                
                <div class="mb-3">
                    <span class="category-badge bg-primary text-white">${escapeHtml(channel.category)}</span>
                    <span class="category-badge bg-secondary text-white ms-2">${escapeHtml(channel.quality)}</span>
                    ${channel.language ? `<span class="category-badge bg-info text-white ms-2">${escapeHtml(channel.language)}</span>` : ''}
                </div>
                
                <div class="mb-3">
                    <small class="text-muted">Streaming URL:</small>
                    <div class="channel-url" title="${escapeHtml(channel.url)}">
                        ${truncateText(escapeHtml(channel.url), 50)}
                    </div>
                </div>
                
                <div class="d-flex justify-content-between align-items-center">
                    <small class="text-muted">
                        <i class="fas fa-globe me-1"></i>${escapeHtml(channel.country || 'International')}
                    </small>
                    <small class="text-muted">
                        <i class="fas fa-clock me-1"></i>${formatDate(channel.lastTested)}
                    </small>
                </div>
            </div>
            <div class="card-footer bg-transparent">
                <button class="btn btn-sm btn-outline-primary w-100" onclick="copyToClipboard('${channel.url}')">
                    <i class="fas fa-copy me-1"></i>Copy URL
                </button>
            </div>
        </div>
    `;
    
    return col;
}

// Filter channels based on search and filters
function filterChannels() {
    const searchTerm = searchInput.value.toLowerCase();
    const category = categoryFilter.value;
    const status = statusFilter.value;
    const quality = qualityFilter.value;
    
    const filtered = channels.filter(channel => {
        const matchesSearch = channel.name.toLowerCase().includes(searchTerm) || 
                            channel.url.toLowerCase().includes(searchTerm);
        const matchesCategory = !category || channel.category === category;
        const matchesStatus = status === '' || channel.isActive.toString() === status;
        const matchesQuality = !quality || channel.quality === quality;
        
        return matchesSearch && matchesCategory && matchesStatus && matchesQuality;
    });
    
    renderChannels(filtered);
    updateNoChannelsMessage(filtered.length === 0);
}

// Update no channels message visibility
function updateNoChannelsMessage(show = false) {
    if (channels.length === 0 || show) {
        noChannelsMessage.classList.remove('d-none');
        channelsGrid.classList.add('d-none');
    } else {
        noChannelsMessage.classList.add('d-none');
        channelsGrid.classList.remove('d-none');
    }
}

// Update stats display
function updateStatsDisplay() {
    document.getElementById('totalChannels').textContent = stats.totalChannels || 0;
    document.getElementById('activeChannels').textContent = stats.activeChannels || 0;
    document.getElementById('totalCategories').textContent = (stats.categories || []).length;
    document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
}

// Open modal to add new channel
function openAddModal() {
    document.getElementById('modalTitle').textContent = 'Add New Channel';
    document.getElementById('channelForm').reset();
    document.getElementById('channelId').value = '';
    document.getElementById('deleteBtn').style.display = 'none';
    
    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('channelModal'));
    modal.show();
}

// Edit existing channel
async function editChannel(channelId) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/channels/${channelId}`);
        if (!response.ok) throw new Error('Failed to fetch channel');
        
        const channel = await response.json();
        
        // Fill form with channel data
        document.getElementById('modalTitle').textContent = 'Edit Channel';
        document.getElementById('channelId').value = channel._id;
        document.getElementById('channelName').value = channel.name;
        document.getElementById('channelUrl').value = channel.url;
        document.getElementById('channelCategory').value = channel.category;
        document.getElementById('channelQuality').value = channel.quality;
        document.getElementById('channelLanguage').value = channel.language;
        document.getElementById('channelCountry').value = channel.country;
        document.getElementById('channelActive').checked = channel.isActive;
        document.getElementById('deleteBtn').style.display = 'block';
        
        // Show modal
        const modal = new bootstrap.Modal(document.getElementById('channelModal'));
        modal.show();
    } catch (error) {
        console.error('Error editing channel:', error);
        showNotification('Error loading channel details', 'danger');
    }
}

// Save channel (create or update)
async function saveChannel() {
    const channelId = document.getElementById('channelId').value;
    const channelData = {
        name: document.getElementById('channelName').value,
        url: document.getElementById('channelUrl').value,
        category: document.getElementById('channelCategory').value,
        quality: document.getElementById('channelQuality').value,
        language: document.getElementById('channelLanguage').value,
        country: document.getElementById('channelCountry').value,
        isActive: document.getElementById('channelActive').checked
    };
    
    try {
        let response;
        if (channelId) {
            // Update existing channel
            response = await fetch(`${API_BASE_URL}/api/channels/${channelId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(channelData)
            });
        } else {
            // Create new channel
            response = await fetch(`${API_BASE_URL}/api/channels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(channelData)
            });
        }
        
        if (!response.ok) throw new Error('Failed to save channel');
        
        const savedChannel = await response.json();
        
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('channelModal'));
        modal.hide();
        
        // Refresh channels and stats
        loadChannels();
        loadStats();
        
        showNotification(
            channelId ? 'Channel updated successfully!' : 'Channel added successfully!',
            'success'
        );
    } catch (error) {
        console.error('Error saving channel:', error);
        showNotification('Error saving channel: ' + error.message, 'danger');
    }
}

// Delete channel
async function deleteChannel(channelId) {
    if (!confirm('Are you sure you want to delete this channel?')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/channels/${channelId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) throw new Error('Failed to delete channel');
        
        // Refresh channels and stats
        loadChannels();
        loadStats();
        
        // Close modal if open
        const modal = bootstrap.Modal.getInstance(document.getElementById('channelModal'));
        if (modal) modal.hide();
        
        showNotification('Channel deleted successfully!', 'success');
    } catch (error) {
        console.error('Error deleting channel:', error);
        showNotification('Error deleting channel', 'danger');
    }
}

// Test channel URL
async function testChannel(channelId) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/channels/${channelId}/test`, {
            method: 'POST'
        });
        
        if (!response.ok) throw new Error('Failed to test channel');
        
        const result = await response.json();
        
        // Refresh channels
        loadChannels();
        
        showNotification('URL test recorded successfully!', 'success');
    } catch (error) {
        console.error('Error testing channel:', error);
        showNotification('Error testing channel URL', 'danger');
    }
}

// Copy URL to clipboard
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showNotification('URL copied to clipboard!', 'success');
    } catch (error) {
        console.error('Error copying to clipboard:', error);
        showNotification('Failed to copy URL', 'danger');
    }
}

// Refresh all data
function refreshChannels() {
    loadChannels();
    loadStats();
    showNotification('Data refreshed!', 'info');
}

// Helper function to format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Helper function to truncate text
function truncateText(text, maxLength) {
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show notification
function showNotification(message, type = 'info') {
    // Remove any existing notifications
    const existingNotifications = document.querySelectorAll('.alert-notification');
    existingNotifications.forEach(notification => notification.remove());
    
    // Create new notification
    const notification = document.createElement('div');
    notification.className = `alert alert-${type} alert-notification alert-dismissible fade show`;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        min-width: 300px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    
    notification.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.remove();
        }
    }, 5000);
}

// Initialize add channel button
document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('[data-bs-target="#addChannelModal"]').addEventListener('click', openAddModal);
});

// Set up delete button in modal
document.getElementById('deleteBtn').addEventListener('click', () => {
    const channelId = document.getElementById('channelId').value;
    if (channelId) {
        deleteChannel(channelId);
    }
});
