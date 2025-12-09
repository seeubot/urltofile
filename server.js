// Complete Secure IPTV Channel Manager API
// Simplified schema with security features
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/?retryWrites=true&w=majority&appName=movie';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected successfully'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ===================================
// SIMPLIFIED CHANNEL SCHEMA
// ===================================
const channelSchema = new mongoose.Schema({
  title: { type: String, required: true }, // Channel name
  url: { type: String, required: true }, // Streaming URL
  cookie: { type: String, default: '' }, // Cookie for authentication
  key: { type: String, default: '' }, // DRM clearkey
  logo: { type: String, default: '' }, // Channel logo
  licenseType: { type: String, default: 'clearkey' }, // Always clearkey
  groupTitle: { type: String, default: 'General' }, // Category
  tvgId: { type: String, required: true, unique: true }, // Unique identifier
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Add indexes for faster queries
channelSchema.index({ title: 1, groupTitle: 1, tvgId: 1 });

const Channel = mongoose.model('Channel', channelSchema);

// ===================================
// MIDDLEWARE
// ===================================
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===================================
// SECURITY FUNCTIONS
// ===================================

// Sanitize channel data based on access level
function sanitizeChannel(channel, includeSecure = false) {
  const channelObj = channel.toObject ? channel.toObject() : channel;
  
  if (!includeSecure) {
    // PUBLIC API - Hide sensitive data
    return {
      _id: channelObj._id,
      title: channelObj.title,
      logo: channelObj.logo,
      groupTitle: channelObj.groupTitle,
      tvgId: channelObj.tvgId,
      isActive: channelObj.isActive,
      licenseType: channelObj.licenseType,
      // Indicators only (no actual data)
      hasUrl: !!channelObj.url,
      hasCookie: !!channelObj.cookie,
      hasKey: !!channelObj.key,
      createdAt: channelObj.createdAt,
      updatedAt: channelObj.updatedAt
    };
  }
  
  // SECURE API - Return full data
  return {
    _id: channelObj._id,
    title: channelObj.title,
    url: channelObj.url,
    cookie: channelObj.cookie,
    key: channelObj.key,
    logo: channelObj.logo,
    licenseType: channelObj.licenseType,
    groupTitle: channelObj.groupTitle,
    tvgId: channelObj.tvgId,
    isActive: channelObj.isActive,
    createdAt: channelObj.createdAt,
    updatedAt: channelObj.updatedAt
  };
}

// Check for secure access token
function checkSecureAccess(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.apikey;
  const validToken = process.env.API_KEY || 'your-secure-api-key-change-this'; 
  
  if (token === validToken) {
    req.secureAccess = true;
  } else {
    req.secureAccess = false;
  }
  next();
}

// ===================================
// BASIC ROUTES
// ===================================

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    api: 'Secure IPTV Channel Manager API v2.0'
  });
});

// ===================================
// CHANNEL CRUD ENDPOINTS
// ===================================

// Get all channels (PUBLIC - sanitized OR SECURE - full data)
app.get('/api/channels', checkSecureAccess, async (req, res) => {
  try {
    const { groupTitle, active, search } = req.query;
    let query = {};

    // Build query filters
    if (groupTitle) query.groupTitle = groupTitle;
    if (active !== undefined) query.isActive = active === 'true';
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { tvgId: { $regex: search, $options: 'i' } },
        { groupTitle: { $regex: search, $options: 'i' } }
      ];
    }

    const channels = await Channel.find(query).sort({ title: 1 });
    
    // Sanitize data based on access level
    const sanitized = channels.map(ch => sanitizeChannel(ch, req.secureAccess));

    res.json({ 
      success: true, 
      count: channels.length,
      secure: req.secureAccess,
      message: req.secureAccess ? 'Full data returned' : 'Public data only (use API key for full access)',
      data: sanitized
    });
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching channels', 
      error: error.message 
    });
  }
});

// Get single channel by ID (PUBLIC - sanitized OR SECURE - full data)
app.get('/api/channels/:id', checkSecureAccess, async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.id);
    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }
    
    const sanitized = sanitizeChannel(channel, req.secureAccess);
    
    res.json({ 
      success: true, 
      secure: req.secureAccess,
      data: sanitized 
    });
  } catch (error) {
    console.error('Error fetching channel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching channel', 
      error: error.message 
    });
  }
});

// Add new channel
app.post('/api/channels', async (req, res) => {
  try {
    const { title, url, cookie, key, logo, groupTitle, tvgId } = req.body;

    // Validate required fields
    if (!title || !url) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: title and url are mandatory' 
      });
    }

    // Generate tvgId if not provided
    const finalTvgId = tvgId || `channel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Check if channel already exists
    const existing = await Channel.findOne({ tvgId: finalTvgId });
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Channel with this tvgId already exists' 
      });
    }

    const channelData = {
      title,
      url,
      cookie: cookie || '',
      key: key || '',
      logo: logo || '',
      licenseType: 'clearkey', // Always clearkey by default
      groupTitle: groupTitle || 'General',
      tvgId: finalTvgId
    };

    const channel = new Channel(channelData);
    await channel.save();

    res.status(201).json({ 
      success: true, 
      message: 'Channel added successfully', 
      data: sanitizeChannel(channel, true)
    });
  } catch (error) {
    console.error('Error adding channel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding channel', 
      error: error.message 
    });
  }
});

// Update channel
app.put('/api/channels/:id', async (req, res) => {
  try {
    const updates = req.body;
    updates.updatedAt = Date.now();

    // Always keep clearkey as license type
    if (updates.licenseType) {
      updates.licenseType = 'clearkey';
    }

    const channel = await Channel.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Channel updated successfully', 
      data: sanitizeChannel(channel, true)
    });
  } catch (error) {
    console.error('Error updating channel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating channel', 
      error: error.message 
    });
  }
});

// Delete channel
app.delete('/api/channels/:id', async (req, res) => {
  try {
    const channel = await Channel.findByIdAndDelete(req.params.id);

    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Channel deleted successfully',
      deletedChannel: channel.title
    });
  } catch (error) {
    console.error('Error deleting channel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting channel', 
      error: error.message 
    });
  }
});

// ===================================
// SECURE ENDPOINT (Requires API Key)
// ===================================

// Get full channel data with API key
app.get('/api/secure/channels', checkSecureAccess, async (req, res) => {
  try {
    if (!req.secureAccess) {
      return res.status(401).json({
        success: false,
        message: 'API key required. Add x-api-key header or ?apikey= query parameter'
      });
    }

    const { groupTitle, active, search } = req.query;
    let query = {};

    if (groupTitle) query.groupTitle = groupTitle;
    if (active !== undefined) query.isActive = active === 'true';
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { tvgId: { $regex: search, $options: 'i' } },
        { groupTitle: { $regex: search, $options: 'i' } }
      ];
    }

    const channels = await Channel.find(query).sort({ title: 1 });
    const fullData = channels.map(ch => sanitizeChannel(ch, true));

    res.json({ 
      success: true, 
      count: channels.length,
      secure: true,
      data: fullData
    });
  } catch (error) {
    console.error('Error fetching secure channels:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching channels', 
      error: error.message 
    });
  }
});

// ===================================
// UTILITY ENDPOINTS
// ===================================

// Get unique group titles
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await Channel.distinct('groupTitle');
    res.json({ 
      success: true, 
      count: groups.length,
      data: groups.sort() 
    });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching groups', 
      error: error.message 
    });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const total = await Channel.countDocuments();
    const active = await Channel.countDocuments({ isActive: true });
    const groups = await Channel.distinct('groupTitle');
    const withDRM = await Channel.countDocuments({ key: { $ne: '' } });

    res.json({
      success: true,
      data: {
        totalChannels: total,
        activeChannels: active,
        inactiveChannels: total - active,
        totalGroups: groups.length,
        channelsWithDRM: withDRM,
        groups: groups.sort()
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching statistics', 
      error: error.message 
    });
  }
});

// ===================================
// M3U PLAYLIST GENERATION
// ===================================

// Generate M3U playlist with full data
app.get('/api/playlist.m3u', async (req, res) => {
  try {
    const { groupTitle } = req.query;
    let query = { isActive: true };
    if (groupTitle) query.groupTitle = groupTitle;

    const channels = await Channel.find(query).sort({ title: 1 });
    
    let m3u = '#EXTM3U x-tvg-url=""\n';
    
    for (const channel of channels) {
      if (!channel.url) continue;

      // Add channel info line
      m3u += `#EXTINF:-1 tvg-id="${channel.tvgId}" group-title="${channel.groupTitle}" tvg-logo="${channel.logo}",${channel.title}\n`;
      
      // Add DRM properties if key exists
      if (channel.key) {
        m3u += `#KODIPROP:inputstream.adaptive.license_type=clearkey\n`;
        m3u += `#KODIPROP:inputstream.adaptive.license_key=${channel.key}\n`;
      }
      
      // Add cookie as HTTP header if exists
      if (channel.cookie) {
        m3u += `#EXTHTTP:{"cookie":"${channel.cookie}"}\n`;
      }
      
      // Add stream URL
      m3u += `${channel.url}\n\n`;
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
    res.send(m3u);
  } catch (error) {
    console.error('Error generating playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error generating playlist', 
      error: error.message 
    });
  }
});

// ===================================
// BULK IMPORT FROM M3U
// ===================================

app.post('/api/channels/bulk', async (req, res) => {
  try {
    const { m3uContent } = req.body;

    if (!m3uContent) {
      return res.status(400).json({ 
        success: false, 
        message: 'No M3U content provided' 
      });
    }

    const channels = parseSimplifiedM3U(m3uContent);
    const results = { 
      added: 0, 
      updated: 0,
      skipped: 0, 
      errors: 0, 
      total: channels.length,
      details: []
    };

    for (const channelData of channels) {
      try {
        const existing = await Channel.findOne({ tvgId: channelData.tvgId });
        
        if (existing) {
          // Update existing channel
          await Channel.findByIdAndUpdate(existing._id, {
            ...channelData,
            updatedAt: Date.now()
          });
          results.updated++;
          results.details.push({ 
            status: 'updated', 
            title: channelData.title,
            tvgId: channelData.tvgId 
          });
        } else {
          // Add new channel
          const channel = new Channel(channelData);
          await channel.save();
          results.added++;
          results.details.push({ 
            status: 'added', 
            title: channelData.title,
            tvgId: channelData.tvgId 
          });
        }
      } catch (error) {
        console.error(`Error processing channel ${channelData.title}:`, error);
        results.errors++;
        results.details.push({ 
          status: 'error', 
          title: channelData.title,
          error: error.message 
        });
      }
    }

    res.json({ 
      success: true, 
      message: 'Bulk import completed',
      results 
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error in bulk import', 
      error: error.message 
    });
  }
});

// ===================================
// M3U PARSER (Simplified)
// ===================================

function parseSimplifiedM3U(content) {
  const lines = content.split('\n').map(line => line.trim());
  const channels = [];
  let currentChannel = {};
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('#EXTINF:')) {
      // Parse channel info
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
      const groupMatch = line.match(/group-title="([^"]*)"/);
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      const nameMatch = line.match(/,(.+)$/);
      
      currentChannel = {
        title: nameMatch ? nameMatch[1].trim() : 'Unknown Channel',
        tvgId: tvgIdMatch && tvgIdMatch[1] ? tvgIdMatch[1] : `channel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        groupTitle: groupMatch ? groupMatch[1] : 'General',
        logo: logoMatch ? logoMatch[1] : '',
        licenseType: 'clearkey',
        key: '',
        cookie: '',
        url: ''
      };
    } 
    else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      // Extract the clearkey
      currentChannel.key = line.substring('#KODIPROP:inputstream.adaptive.license_key='.length).trim();
    } 
    else if (line.startsWith('#EXTHTTP:')) {
      // Extract cookie from JSON
      try {
        const jsonMatch = line.match(/#EXTHTTP:(.+)/);
        if (jsonMatch) {
          const headers = JSON.parse(jsonMatch[1]);
          if (headers['cookie']) {
            currentChannel.cookie = headers['cookie'];
          }
        }
      } catch (e) {
        console.error('Error parsing EXTHTTP:', e);
      }
    } 
    else if (line && !line.startsWith('#') && (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp'))) {
      // This is the stream URL
      currentChannel.url = line;
      
      // Push the complete channel if it has required fields
      if (currentChannel.title && currentChannel.url && currentChannel.tvgId) {
        channels.push({ ...currentChannel });
      }
      
      // Reset for next channel
      currentChannel = {};
    }
  }
  
  return channels;
}

// ===================================
// ERROR HANDLING
// ===================================

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error', 
    error: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found',
    path: req.path,
    availableEndpoints: {
      public: [
        'GET /api/channels',
        'GET /api/channels/:id',
        'GET /api/groups',
        'GET /api/stats',
        'GET /api/playlist.m3u'
      ],
      secure: [
        'GET /api/secure/channels (requires API key)',
        'POST /api/channels',
        'PUT /api/channels/:id',
        'DELETE /api/channels/:id',
        'POST /api/channels/bulk'
      ]
    }
  });
});

// ===================================
// SERVER START
// ===================================

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     🎬 IPTV CHANNEL MANAGER API v2.0                  ║
╚════════════════════════════════════════════════════════╝

🚀 Server Status: RUNNING
📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Base URL: http://localhost:${PORT}

📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}

🔒 SECURITY FEATURES:
   • Public API: Sanitized data (no streaming details)
   • Secure API: Full data (requires API key)
   • API Key: Set via environment variable API_KEY

📚 API ENDPOINTS:

   PUBLIC (No API Key Required):
   ├─ GET  /api/channels          (sanitized data)
   ├─ GET  /api/channels/:id      (sanitized data)
   ├─ GET  /api/groups
   ├─ GET  /api/stats
   └─ GET  /api/playlist.m3u

   SECURE (API Key Required):
   ├─ GET  /api/channels?apikey=XXX    (full data)
   ├─ GET  /api/secure/channels        (full data)
   ├─ POST /api/channels
   ├─ PUT  /api/channels/:id
   ├─ DELETE /api/channels/:id
   └─ POST /api/channels/bulk

💡 Usage:
   • Header: x-api-key: your-key
   • Query:  ?apikey=your-key

🎯 Schema: title, url, cookie, key, logo, licenseType
🔐 Default License: clearkey

════════════════════════════════════════════════════════
  `);
});

// ===================================
// GRACEFUL SHUTDOWN
// ===================================

process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed.');
    mongoose.connection.close(false, () => {
      console.log('✅ MongoDB connection closed.');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('⚠️  SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed.');
    mongoose.connection.close(false, () => {
      console.log('✅ MongoDB connection closed.');
      process.exit(0);
    });
  });
});
