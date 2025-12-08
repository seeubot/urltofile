// Update the server code to handle the new fields
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

// Enhanced Channel Schema with all fields from the image
const channelSchema = new mongoose.Schema({
  // Basic info
  tvgId: { type: String, required: true },
  name: { type: String, required: true },
  groupTitle: { type: String, required: true },
  logo: { type: String, default: '' },
  
  // Multiple streaming URLs with IDs
  streamUrls: { 
    type: Map,
    of: String,
    default: {}
  },
  
  // DRM Configuration (from image)
  licenseType: { 
    type: String, 
    enum: ['clearkey', 'widevine', 'playready', ''], 
    default: 'clearkey' 
  },
  licenseKey: { type: String, default: '' },
  scheme: { type: String, default: '' }, // From edit_scheme in image
  
  // HTTP headers and metadata (from image)
  useragent: { type: String, default: '' }, // From edit_useragent in image
  title: { type: String, default: '' }, // From edit_title in image
  url: { type: String, default: '' }, // From edit_url in image
  referer: { type: String, default: '' }, // From edit_referer in image
  origin: { type: String, default: '' }, // From edit_origin in image
  cookie: { type: String, default: '' }, // From edit_cookie in image
  key: { type: String, default: '' }, // From edit_key in image
  
  // Additional metadata
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Add indexes for faster queries
channelSchema.index({ tvgId: 1, name: 1, groupTitle: 1 });

const Channel = mongoose.model('Channel', channelSchema);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from public directory
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

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
    api: 'IPTV Channel Manager API'
  });
});

// Get all channels with filtering
app.get('/api/channels', async (req, res) => {
  try {
    const { groupTitle, active, search, licenseType } = req.query;
    let query = {};

    if (groupTitle) query.groupTitle = groupTitle;
    if (active !== undefined) query.isActive = active === 'true';
    if (licenseType) query.licenseType = licenseType;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { tvgId: { $regex: search, $options: 'i' } },
        { groupTitle: { $regex: search, $options: 'i' } }
      ];
    }

    const channels = await Channel.find(query).sort({ name: 1 });
    
    // Convert Map to Object for JSON response
    const channelsWithObjects = channels.map(channel => {
      const channelObj = channel.toObject();
      if (channelObj.streamUrls && channelObj.streamUrls instanceof Map) {
        channelObj.streamUrls = Object.fromEntries(channelObj.streamUrls);
      }
      return channelObj;
    });

    res.json({ 
      success: true, 
      count: channels.length,
      data: channelsWithObjects 
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

// Get channel by ID
app.get('/api/channels/:id', async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.id);
    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }
    
    // Convert Map to Object
    const channelObj = channel.toObject();
    if (channelObj.streamUrls && channelObj.streamUrls instanceof Map) {
      channelObj.streamUrls = Object.fromEntries(channelObj.streamUrls);
    }
    
    res.json({ success: true, data: channelObj });
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
    const channelData = req.body;

    // Validate required fields
    if (!channelData.tvgId || !channelData.name || !channelData.groupTitle) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: tvgId, name, groupTitle' 
      });
    }

    // Validate at least one stream URL
    if (!channelData.streamUrls || Object.keys(channelData.streamUrls).length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'At least one stream URL is required' 
      });
    }

    // Validate license type
    if (channelData.licenseType && !['clearkey', 'widevine', 'playready', ''].includes(channelData.licenseType)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid license type. Must be: clearkey, widevine, playready, or empty' 
      });
    }

    // Check if channel already exists
    const existing = await Channel.findOne({ tvgId: channelData.tvgId });
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Channel with this tvgId already exists' 
      });
    }

    // Convert streamUrls object to Map
    if (channelData.streamUrls && typeof channelData.streamUrls === 'object') {
      channelData.streamUrls = new Map(Object.entries(channelData.streamUrls));
    }

    const channel = new Channel(channelData);
    await channel.save();

    // Convert back to object for response
    const channelObj = channel.toObject();
    if (channelObj.streamUrls instanceof Map) {
      channelObj.streamUrls = Object.fromEntries(channelObj.streamUrls);
    }

    res.status(201).json({ 
      success: true, 
      message: 'Channel added successfully', 
      data: channelObj 
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
    
    // Convert streamUrls object to Map if present
    if (updates.streamUrls && typeof updates.streamUrls === 'object') {
      updates.streamUrls = new Map(Object.entries(updates.streamUrls));
    }
    
    updates.updatedAt = Date.now();

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

    // Convert Map to Object for response
    const channelObj = channel.toObject();
    if (channelObj.streamUrls instanceof Map) {
      channelObj.streamUrls = Object.fromEntries(channelObj.streamUrls);
    }

    res.json({ 
      success: true, 
      message: 'Channel updated successfully', 
      data: channelObj 
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
      message: 'Channel deleted successfully' 
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

// Get unique group titles
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await Channel.distinct('groupTitle');
    res.json({ 
      success: true, 
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

// Generate M3U playlist with enhanced support for multiple URLs and DRM
app.get('/api/playlist.m3u', async (req, res) => {
  try {
    const { groupTitle, quality } = req.query;
    let query = { isActive: true };
    if (groupTitle) query.groupTitle = groupTitle;

    const channels = await Channel.find(query).sort({ name: 1 });
    
    let m3u = '#EXTM3U x-tvg-url=""\n';
    
    for (const channel of channels) {
      const streamUrls = channel.streamUrls ? Object.fromEntries(channel.streamUrls) : {};
      const primaryUrl = streamUrls.primary || streamUrls['1080p'] || streamUrls['720p'] || 
                        Object.values(streamUrls)[0] || '';
      
      if (!primaryUrl) continue;

      m3u += `#EXTINF:-1 tvg-id="${channel.tvgId}" group-title="${channel.groupTitle}" tvg-logo="${channel.logo}",${channel.name}\n`;
      
      // Add DRM properties if available
      if (channel.licenseType && channel.licenseKey) {
        m3u += `#KODIPROP:inputstream.adaptive.license_type=${channel.licenseType}\n`;
        m3u += `#KODIPROP:inputstream.adaptive.license_key=${channel.licenseKey}\n`;
        
        // Add scheme if specified
        if (channel.scheme) {
          m3u += `#KODIPROP:inputstream.adaptive.license_scheme=${channel.scheme}\n`;
        }
      }
      
      // Add HTTP headers
      if (channel.useragent) {
        m3u += `#EXTHTTP:{"User-Agent":"${channel.useragent}"}\n`;
      }
      if (channel.referer) {
        m3u += `#EXTHTTP:{"Referer":"${channel.referer}"}\n`;
      }
      if (channel.origin) {
        m3u += `#EXTHTTP:{"Origin":"${channel.origin}"}\n`;
      }
      if (channel.cookie) {
        m3u += `#EXTHTTP:{"Cookie":"${channel.cookie}"}\n`;
      }
      if (channel.title) {
        m3u += `#KODIPROP:license_title="${channel.title}"\n`;
      }
      if (channel.url) {
        m3u += `#KODIPROP:license_url="${channel.url}"\n`;
      }
      
      m3u += `${primaryUrl}\n\n`;
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

// Get channel stream by quality
app.get('/api/channels/:id/stream/:quality', async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.id);
    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }

    const streamUrls = channel.streamUrls ? Object.fromEntries(channel.streamUrls) : {};
    const streamUrl = streamUrls[req.params.quality];
    
    if (!streamUrl) {
      return res.status(404).json({ 
        success: false, 
        message: 'Stream quality not found' 
      });
    }

    res.json({ 
      success: true, 
      quality: req.params.quality,
      url: streamUrl,
      channel: channel.name
    });
  } catch (error) {
    console.error('Error fetching stream:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching stream', 
      error: error.message 
    });
  }
});

// Bulk import from M3U
app.post('/api/channels/bulk', async (req, res) => {
  try {
    const { m3uContent } = req.body;

    if (!m3uContent) {
      return res.status(400).json({ 
        success: false, 
        message: 'No M3U content provided' 
      });
    }

    const channels = parseEnhancedM3U(m3uContent);
    const results = { added: 0, skipped: 0, errors: 0, total: channels.length };

    for (const channelData of channels) {
      try {
        const existing = await Channel.findOne({ tvgId: channelData.tvgId });
        if (existing) {
          results.skipped++;
          continue;
        }

        // Convert streamUrls to Map
        if (channelData.streamUrls && typeof channelData.streamUrls === 'object') {
          channelData.streamUrls = new Map(Object.entries(channelData.streamUrls));
        }

        const channel = new Channel(channelData);
        await channel.save();
        results.added++;
      } catch (error) {
        console.error(`Error adding channel ${channelData.name || channelData.tvgId}:`, error);
        results.errors++;
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

// Enhanced M3U parser
function parseEnhancedM3U(content) {
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
        tvgId: tvgIdMatch ? tvgIdMatch[1] : `channel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        groupTitle: groupMatch ? groupMatch[1] : 'Uncategorized',
        logo: logoMatch ? logoMatch[1] : '',
        name: nameMatch ? nameMatch[1].trim() : 'Unknown Channel',
        streamUrls: {}
      };
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
      currentChannel.licenseType = line.split('=')[1];
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      currentChannel.licenseKey = line.split('=')[1];
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_scheme=')) {
      currentChannel.scheme = line.split('=')[1];
    } else if (line.startsWith('#KODIPROP:license_title=')) {
      currentChannel.title = line.split('=')[1];
    } else if (line.startsWith('#KODIPROP:license_url=')) {
      currentChannel.url = line.split('=')[1];
    } else if (line.startsWith('#EXTHTTP:')) {
      try {
        const jsonMatch = line.match(/#EXTHTTP:(.+)/);
        if (jsonMatch) {
          const headers = JSON.parse(jsonMatch[1]);
          if (headers['User-Agent']) currentChannel.useragent = headers['User-Agent'];
          if (headers['Referer']) currentChannel.referer = headers['Referer'];
          if (headers['Origin']) currentChannel.origin = headers['Origin'];
          if (headers['Cookie']) currentChannel.cookie = headers['Cookie'];
        }
      } catch (e) {
        console.error('Error parsing EXTHTTP:', e);
      }
    } else if (line && !line.startsWith('#') && (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp'))) {
      // Add stream URL with default ID
      currentChannel.streamUrls['primary'] = line;
      channels.push(currentChannel);
      currentChannel = {};
    }
  }
  
  return channels;
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error', 
    error: err.message 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found',
    path: req.path 
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`
🚀 Server running on port ${PORT}
📡 Environment: ${process.env.NODE_ENV || 'development'}
🌐 API Base URL: http://localhost:${PORT}
📁 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}
🔑 Supported DRM: clearkey, widevine, playready
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed.');
      process.exit(0);
    });
  });
});
