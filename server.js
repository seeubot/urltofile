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

// Channel Schema
const channelSchema = new mongoose.Schema({
  tvgId: { type: String, required: true },
  name: { type: String, required: true },
  groupTitle: { type: String, required: true },
  logo: { type: String, required: true },
  streamUrl: { type: String, required: true },
  
  // License properties
  licenseType: { type: String, default: 'clearkey' },
  licenseKey: { type: String, default: '' },
  
  // HTTP headers
  cookie: { type: String, default: '' },
  
  // Additional metadata
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Add index for faster queries
channelSchema.index({ tvgId: 1, name: 1 });

const Channel = mongoose.model('Channel', channelSchema);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Streaming Channel API is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

// Get all channels
app.get('/api/channels', async (req, res) => {
  try {
    const { groupTitle, active, search } = req.query;
    let query = {};

    if (groupTitle) query.groupTitle = groupTitle;
    if (active !== undefined) query.isActive = active === 'true';
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { tvgId: { $regex: search, $options: 'i' } }
      ];
    }

    const channels = await Channel.find(query).sort({ name: 1 });
    res.json({ 
      success: true, 
      count: channels.length,
      data: channels 
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
    res.json({ success: true, data: channel });
  } catch (error) {
    console.error('Error fetching channel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching channel', 
      error: error.message 
    });
  }
});

// Add new channel (from frontend)
app.post('/api/channels', async (req, res) => {
  try {
    const channelData = req.body;

    // Validate required fields
    if (!channelData.tvgId || !channelData.name || !channelData.streamUrl) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: tvgId, name, streamUrl' 
      });
    }

    // Check if channel already exists
    const existing = await Channel.findOne({ 
      tvgId: channelData.tvgId 
    });

    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Channel with this tvgId already exists' 
      });
    }

    const channel = new Channel(channelData);
    await channel.save();

    res.status(201).json({ 
      success: true, 
      message: 'Channel added successfully', 
      data: channel 
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

// Bulk add channels (parse M3U format)
app.post('/api/channels/bulk', async (req, res) => {
  try {
    const { m3uContent } = req.body;

    if (!m3uContent) {
      return res.status(400).json({ 
        success: false, 
        message: 'No M3U content provided' 
      });
    }

    const channels = parseM3U(m3uContent);
    const results = { added: 0, skipped: 0, errors: 0 };

    for (const channelData of channels) {
      try {
        const existing = await Channel.findOne({ tvgId: channelData.tvgId });
        if (existing) {
          results.skipped++;
          continue;
        }

        const channel = new Channel(channelData);
        await channel.save();
        results.added++;
      } catch (error) {
        console.error(`Error adding channel ${channelData.name}:`, error);
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

// Update channel
app.put('/api/channels/:id', async (req, res) => {
  try {
    const channel = await Channel.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
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
      data: channel 
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

// Generate M3U playlist
app.get('/api/playlist.m3u', async (req, res) => {
  try {
    const { groupTitle } = req.query;
    let query = { isActive: true };
    if (groupTitle) query.groupTitle = groupTitle;

    const channels = await Channel.find(query).sort({ name: 1 });
    
    let m3u = '#EXTM3U\n';
    
    for (const channel of channels) {
      m3u += `#EXTINF:-1 tvg-id="${channel.tvgId}" group-title="${channel.groupTitle}" tvg-logo="${channel.logo}",${channel.name}\n`;
      
      if (channel.licenseType && channel.licenseKey) {
        m3u += `#KODIPROP:inputstream.adaptive.license_type=${channel.licenseType}\n`;
        m3u += `#KODIPROP:inputstream.adaptive.license_key=${channel.licenseKey}\n`;
      }
      
      if (channel.cookie) {
        m3u += `#EXTHTTP:{"cookie":"${channel.cookie}"}\n`;
      }
      
      m3u += `${channel.streamUrl}\n\n`;
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

// Helper function to parse M3U content
function parseM3U(content) {
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
        tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
        groupTitle: groupMatch ? groupMatch[1] : 'Uncategorized',
        logo: logoMatch ? logoMatch[1] : '',
        name: nameMatch ? nameMatch[1].trim() : 'Unknown'
      };
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
      currentChannel.licenseType = line.split('=')[1];
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      currentChannel.licenseKey = line.split('=')[1];
    } else if (line.startsWith('#EXTHTTP:')) {
      const cookieMatch = line.match(/"cookie":"([^"]*)"/);
      if (cookieMatch) currentChannel.cookie = cookieMatch[1];
    } else if (line && !line.startsWith('#') && line.startsWith('http')) {
      currentChannel.streamUrl = line;
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
});
