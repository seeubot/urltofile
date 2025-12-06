const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;
const DATA_FILE = 'channels.json';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (for frontend)
app.use(express.static('public'));

// Data Storage
let channelsData = { channels: [], categories: [] };
const dataFilePath = path.join(__dirname, DATA_FILE);

/**
 * Loads channel data from JSON file
 */
async function loadChannelsData() {
    try {
        const data = await fs.readFile(dataFilePath, 'utf8');
        channelsData = JSON.parse(data);
        console.log(`✅ Loaded ${channelsData.channels.length} channels`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`⚠️  ${DATA_FILE} not found. Starting with empty data.`);
            await saveChannelsData();
        } else {
            console.error("Error loading data:", error);
        }
    }
}

/**
 * Saves channel data to JSON file
 */
async function saveChannelsData() {
    try {
        // Re-index IDs
        channelsData.channels.forEach((channel, index) => {
            channel.id = index + 1;
        });
        
        // Update categories
        const categoriesSet = new Set(
            channelsData.channels
                .map(c => c.category)
                .filter(c => c && c.trim())
        );
        channelsData.categories = Array.from(categoriesSet).sort();

        await fs.writeFile(dataFilePath, JSON.stringify(channelsData, null, 2), 'utf8');
        console.log(`💾 Saved ${channelsData.channels.length} channels`);
    } catch (error) {
        console.error("Error saving data:", error);
    }
}

/**
 * Remove sensitive data from channels
 */
function cleanChannels(channelList) {
    if (!Array.isArray(channelList)) return [];
    return channelList.map(c => {
        const { drm_key, ...safeChannel } = c;
        return safeChannel;
    });
}

/**
 * Parse M3U playlist content
 */
function parseM3U(content) {
    const channels = [];
    const lines = content.split('\n');
    let currentChannel = null;

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('#EXTINF:')) {
            currentChannel = {
                id: null,
                title: 'Unknown Channel',
                url: '',
                logo: '',
                category: 'uncategorized',
                type: 'm3u8',
                drm_key: null,
                created_at: new Date().toISOString()
            };

            // Extract logo
            const logoMatch = trimmedLine.match(/tvg-logo="([^"]+)"/);
            if (logoMatch) currentChannel.logo = logoMatch[1];

            // Extract category
            const categoryMatch = trimmedLine.match(/group-title="([^"]+)"/);
            if (categoryMatch) currentChannel.category = categoryMatch[1];

            // Extract title
            const titleMatch = trimmedLine.match(/,(.+)$/);
            if (titleMatch) currentChannel.title = titleMatch[1].trim();

        } else if (currentChannel && trimmedLine && !trimmedLine.startsWith('#')) {
            currentChannel.url = trimmedLine;
            currentChannel.type = trimmedLine.includes('.m3u8') ? 'm3u8' : 
                                 trimmedLine.includes('.mpd') ? 'mpd' : 'direct';
            channels.push(currentChannel);
            currentChannel = null;
        }
    }
    return channels;
}

/**
 * Admin authentication middleware
 */
function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
        return res.status(401).json({ success: false, error: 'Authorization required' });
    }

    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || token !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    next();
}

// ============= PUBLIC ROUTES =============

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        channels: channelsData.channels.length,
        categories: channelsData.categories.length,
        uptime: process.uptime()
    });
});

app.get('/api/channels', (req, res) => {
    try {
        const { category, search } = req.query;
        let filtered = channelsData.channels;

        if (category) {
            filtered = filtered.filter(c => 
                c.category && c.category.toLowerCase() === category.toLowerCase()
            );
        }

        if (search) {
            const term = search.toLowerCase();
            filtered = filtered.filter(c => 
                c.title && c.title.toLowerCase().includes(term)
            );
        }

        res.json({
            success: true,
            channels: cleanChannels(filtered),
            total: filtered.length
        });
    } catch (error) {
        console.error("Error fetching channels:", error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.get('/api/channels/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const channel = channelsData.channels.find(c => c.id === id);

        if (channel) {
            res.json({ success: true, channel: cleanChannels([channel])[0] });
        } else {
            res.status(404).json({ success: false, error: 'Channel not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.get('/api/categories', (req, res) => {
    res.json({ 
        success: true, 
        categories: channelsData.categories 
    });
});

// ============= ADMIN ROUTES =============

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: ADMIN_PASSWORD });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.post('/api/admin/channels', verifyAdmin, async (req, res) => {
    try {
        const data = req.body;
        
        if (!data.url) {
            return res.status(400).json({ success: false, error: 'URL required' });
        }

        const newChannel = {
            id: channelsData.channels.length + 1,
            title: data.title || 'New Channel',
            url: data.url,
            logo: data.logo || '',
            category: data.category || 'uncategorized',
            type: data.type || 'm3u8',
            drm_key: data.drm_key || null,
            created_at: new Date().toISOString()
        };
        
        channelsData.channels.push(newChannel);
        await saveChannelsData();
        
        res.json({ success: true, channel: cleanChannels([newChannel])[0] });
    } catch (error) {
        console.error("Error adding channel:", error);
        res.status(500).json({ success: false, error: 'Failed to add channel' });
    }
});

app.put('/api/admin/channels/:id', verifyAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const data = req.body;

        const channel = channelsData.channels.find(c => c.id === id);

        if (!channel) {
            return res.status(404).json({ success: false, error: 'Channel not found' });
        }

        // Update fields
        if (data.title !== undefined) channel.title = data.title;
        if (data.url !== undefined) channel.url = data.url;
        if (data.logo !== undefined) channel.logo = data.logo;
        if (data.category !== undefined) channel.category = data.category;
        if (data.type !== undefined) channel.type = data.type;
        if (data.drm_key !== undefined) channel.drm_key = data.drm_key;
        
        channel.updated_at = new Date().toISOString();

        await saveChannelsData();
        
        res.json({ success: true, channel: cleanChannels([channel])[0] });
    } catch (error) {
        console.error("Error updating channel:", error);
        res.status(500).json({ success: false, error: 'Failed to update channel' });
    }
});

app.delete('/api/admin/channels/:id', verifyAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const initialLength = channelsData.channels.length;

        channelsData.channels = channelsData.channels.filter(c => c.id !== id);
        
        if (channelsData.channels.length === initialLength) {
            return res.status(404).json({ success: false, error: 'Channel not found' });
        }

        await saveChannelsData();
        
        res.json({ success: true, message: 'Channel deleted' });
    } catch (error) {
        console.error("Error deleting channel:", error);
        res.status(500).json({ success: false, error: 'Failed to delete channel' });
    }
});

app.post('/api/admin/import', verifyAdmin, async (req, res) => {
    try {
        const { content } = req.body;
        
        if (!content) {
            return res.status(400).json({ success: false, error: 'M3U content required' });
        }
        
        const newChannels = parseM3U(content);
        
        if (newChannels.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid channels found' });
        }
        
        channelsData.channels.push(...newChannels);
        await saveChannelsData();

        res.json({
            success: true,
            imported: newChannels.length,
            total: channelsData.channels.length
        });
    } catch (error) {
        console.error("Error importing M3U:", error);
        res.status(500).json({ success: false, error: 'Import failed' });
    }
});

// ============= ERROR HANDLING =============

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============= START SERVER =============

async function startServer() {
    try {
        // Create public directory if it doesn't exist
        const publicDir = path.join(__dirname, 'public');
        try {
            await fs.access(publicDir);
        } catch {
            await fs.mkdir(publicDir, { recursive: true });
            console.log('✅ Created public directory');
        }

        await loadChannelsData();
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🚀 IPTV Platform Server Started`);
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌐 Health: /health`);
            console.log(`📺 Channels: ${channelsData.channels.length}`);
            console.log(`🔐 Admin Password: ${ADMIN_PASSWORD}`);
            console.log(`\n✨ Server is ready!`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n⏹️  Shutting down gracefully...');
    await saveChannelsData();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n⏹️  Shutting down gracefully...');
    await saveChannelsData();
    process.exit(0);
});
