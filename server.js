// Complete Secure IPTV Channel Manager API with M3U8 Fallback
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const path = require('path');

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
// SCHEMAS
// ===================================

// Channel Schema with M3U8 fallback
const channelSchema = new mongoose.Schema({
  title: { type: String, required: true },
  url: { type: String, required: true },
  m3u8Url: { type: String, default: '' }, // M3U8 fallback URL
  cookie: { type: String, default: '' },
  key: { type: String, default: '' },
  logo: { type: String, default: '' },
  licenseType: { type: String, default: 'clearkey' },
  groupTitle: { type: String, default: 'General' },
  tvgId: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  sourcePlaylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

channelSchema.index({ title: 1, groupTitle: 1, tvgId: 1 });

// Playlist URL Schema
const playlistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  autoSync: { type: Boolean, default: true },
  syncInterval: { type: Number, default: 3600000 },
  lastSyncAt: { type: Date, default: null },
  lastSyncStatus: { type: String, default: 'pending' },
  lastSyncMessage: { type: String, default: '' },
  channelCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

const Channel = mongoose.model('Channel', channelSchema);
const Playlist = mongoose.model('Playlist', playlistSchema);

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

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===================================
// UTILITY FUNCTIONS
// ===================================

function sanitizeChannel(channel, includeSecure = false) {
  const channelObj = channel.toObject ? channel.toObject() : channel;
  
  if (!includeSecure) {
    return {
      _id: channelObj._id,
      title: channelObj.title,
      logo: channelObj.logo,
      groupTitle: channelObj.groupTitle,
      tvgId: channelObj.tvgId,
      isActive: channelObj.isActive,
      licenseType: channelObj.licenseType,
      hasUrl: !!channelObj.url,
      hasM3u8Url: !!channelObj.m3u8Url,
      hasCookie: !!channelObj.cookie,
      hasKey: !!channelObj.key,
      createdAt: channelObj.createdAt,
      updatedAt: channelObj.updatedAt
    };
  }
  
  return {
    _id: channelObj._id,
    title: channelObj.title,
    url: channelObj.url,
    m3u8Url: channelObj.m3u8Url,
    cookie: channelObj.cookie,
    key: channelObj.key,
    logo: channelObj.logo,
    licenseType: channelObj.licenseType,
    groupTitle: channelObj.groupTitle,
    tvgId: channelObj.tvgId,
    isActive: channelObj.isActive,
    sourcePlaylistId: channelObj.sourcePlaylistId,
    createdAt: channelObj.createdAt,
    updatedAt: channelObj.updatedAt
  };
}

function parseSimplifiedM3U(content) {
  const lines = content.split('\n').map(line => line.trim());
  const channels = [];
  let currentChannel = {};
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('#EXTINF:')) {
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
        url: '',
        m3u8Url: ''
      };
    } 
    else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      currentChannel.key = line.substring('#KODIPROP:inputstream.adaptive.license_key='.length).trim();
    } 
    else if (line.startsWith('#EXTHTTP:')) {
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
      currentChannel.url = line;
      
      if (currentChannel.title && currentChannel.url && currentChannel.tvgId) {
        channels.push({ ...currentChannel });
      }
      
      currentChannel = {};
    }
  }
  
  return channels;
}

// Fetch M3U content from URL
async function fetchM3UContent(url) {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'IPTV-Manager/2.0'
      }
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch playlist: ${error.message}`);
  }
}

// Sync channels from a playlist
async function syncPlaylistChannels(playlistId) {
  const playlist = await Playlist.findById(playlistId);
  if (!playlist) {
    throw new Error('Playlist not found');
  }

  try {
    console.log(`🔄 Syncing playlist: ${playlist.name} (${playlist.url})`);
    
    const m3uContent = await fetchM3UContent(playlist.url);
    const channels = parseSimplifiedM3U(m3uContent);
    
    const results = { 
      added: 0, 
      updated: 0,
      skipped: 0, 
      errors: 0, 
      total: channels.length
    };

    for (const channelData of channels) {
      try {
        const existing = await Channel.findOne({ tvgId: channelData.tvgId });
        
        if (existing) {
          await Channel.findByIdAndUpdate(existing._id, {
            ...channelData,
            sourcePlaylistId: playlistId,
            updatedAt: Date.now()
          });
          results.updated++;
        } else {
          const channel = new Channel({
            ...channelData,
            sourcePlaylistId: playlistId
          });
          await channel.save();
          results.added++;
        }
      } catch (error) {
        console.error(`Error processing channel ${channelData.title}:`, error);
        results.errors++;
      }
    }

    await Playlist.findByIdAndUpdate(playlistId, {
      lastSyncAt: Date.now(),
      lastSyncStatus: 'success',
      lastSyncMessage: `Successfully synced ${results.added + results.updated} channels`,
      channelCount: results.added + results.updated,
      updatedAt: Date.now()
    });

    console.log(`✅ Sync completed: +${results.added} added, ${results.updated} updated, ${results.errors} errors`);
    return results;

  } catch (error) {
    console.error(`❌ Sync failed for ${playlist.name}:`, error);
    
    await Playlist.findByIdAndUpdate(playlistId, {
      lastSyncAt: Date.now(),
      lastSyncStatus: 'error',
      lastSyncMessage: error.message,
      updatedAt: Date.now()
    });
    
    throw error;
  }
}

// ===================================
// BASIC ROUTES
// ===================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Server is running',
    url: 'https://static-crane-seeutech-17dd4df3.koyeb.app',
    timestamp: new Date().toISOString()
  });
});

app.get('/rocker.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rocker.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    api: 'IPTV Channel Manager API v2.4 with M3U8 Fallback'
  });
});

// ===================================
// PLAYLIST URL ENDPOINTS
// ===================================

// Get all playlists
app.get('/api/playlists', async (req, res) => {
  try {
    const playlists = await Playlist.find().sort({ createdAt: -1 });
    res.json({ 
      success: true, 
      count: playlists.length,
      data: playlists
    });
  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching playlists', 
      error: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred'
    });
  }
});

// Get single playlist
app.get('/api/playlists/:id', async (req, res) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({ 
        success: false, 
        message: 'Playlist not found' 
      });
    }
    
    res.json({ 
      success: true, 
      data: playlist 
    });
  } catch (error) {
    console.error('Error fetching playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching playlist', 
      error: error.message 
    });
  }
});

// Add new playlist
app.post('/api/playlists', async (req, res) => {
  try {
    const { name, url, autoSync, syncInterval } = req.body;

    if (!name || !url) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: name and url are mandatory' 
      });
    }

    const existing = await Playlist.findOne({ url });
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Playlist with this URL already exists' 
      });
    }

    const playlistData = {
      name,
      url,
      autoSync: autoSync !== undefined ? autoSync : true,
      syncInterval: syncInterval || 3600000
    };

    const playlist = new Playlist(playlistData);
    await playlist.save();

    if (playlist.autoSync) {
      try {
        const syncResults = await syncPlaylistChannels(playlist._id);
        res.status(201).json({ 
          success: true, 
          message: 'Playlist added and synced successfully', 
          data: playlist,
          syncResults
        });
      } catch (syncError) {
        res.status(201).json({ 
          success: true, 
          message: 'Playlist added but initial sync failed', 
          data: playlist,
          syncError: syncError.message
        });
      }
    } else {
      res.status(201).json({ 
        success: true, 
        message: 'Playlist added successfully (sync disabled)', 
        data: playlist
      });
    }
  } catch (error) {
    console.error('Error adding playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding playlist', 
      error: error.message 
    });
  }
});

// Update playlist
app.put('/api/playlists/:id', async (req, res) => {
  try {
    const updates = req.body;
    updates.updatedAt = Date.now();

    const playlist = await Playlist.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    if (!playlist) {
      return res.status(404).json({ 
        success: false, 
        message: 'Playlist not found' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Playlist updated successfully', 
      data: playlist
    });
  } catch (error) {
    console.error('Error updating playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating playlist', 
      error: error.message 
    });
  }
});

// Delete playlist
app.delete('/api/playlists/:id', async (req, res) => {
  try {
    const { deleteChannels } = req.query;
    const playlist = await Playlist.findById(req.params.id);

    if (!playlist) {
      return res.status(404).json({ 
        success: false, 
        message: 'Playlist not found' 
      });
    }

    if (deleteChannels === 'true') {
      const deleteResult = await Channel.deleteMany({ sourcePlaylistId: req.params.id });
      console.log(`Deleted ${deleteResult.deletedCount} channels from playlist ${playlist.name}`);
    } else {
      await Channel.updateMany(
        { sourcePlaylistId: req.params.id },
        { $set: { sourcePlaylistId: null } }
      );
    }

    await Playlist.findByIdAndDelete(req.params.id);

    res.json({ 
      success: true, 
      message: 'Playlist deleted successfully',
      deletedPlaylist: playlist.name
    });
  } catch (error) {
    console.error('Error deleting playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting playlist', 
      error: error.message 
    });
  }
});

// Sync playlist
app.post('/api/playlists/:id/sync', async (req, res) => {
  try {
    const syncResults = await syncPlaylistChannels(req.params.id);
    res.json({ 
      success: true, 
      message: 'Playlist synced successfully',
      results: syncResults
    });
  } catch (error) {
    console.error('Error syncing playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error syncing playlist', 
      error: error.message 
    });
  }
});

// Sync all playlists
app.post('/api/playlists/sync-all', async (req, res) => {
  try {
    const playlists = await Playlist.find({ isActive: true, autoSync: true });
    const results = [];

    for (const playlist of playlists) {
      try {
        const syncResult = await syncPlaylistChannels(playlist._id);
        results.push({
          playlistId: playlist._id,
          name: playlist.name,
          status: 'success',
          ...syncResult
        });
      } catch (error) {
        results.push({
          playlistId: playlist._id,
          name: playlist.name,
          status: 'error',
          error: error.message
        });
      }
    }

    res.json({ 
      success: true, 
      message: `Synced ${results.length} playlists`,
      results
    });
  } catch (error) {
    console.error('Error syncing all playlists:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error syncing playlists', 
      error: error.message 
    });
  }
});

// ===================================
// CHANNEL CRUD ENDPOINTS
// ===================================

app.get('/api/channels', async (req, res) => {
  try {
    const { groupTitle, active, search, playlistId } = req.query;
    let query = {};

    if (groupTitle) query.groupTitle = groupTitle;
    if (active !== undefined) query.isActive = active === 'true';
    if (playlistId) query.sourcePlaylistId = playlistId;
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
      data: fullData
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

app.get('/api/channels/:id', async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.id);
    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }
    
    const fullData = sanitizeChannel(channel, true);
    
    res.json({ 
      success: true, 
      data: fullData 
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

app.post('/api/channels', async (req, res) => {
  try {
    const { title, url, m3u8Url, cookie, key, logo, groupTitle, tvgId } = req.body;

    if (!title || !url) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: title and url are mandatory' 
      });
    }

    const finalTvgId = tvgId || `channel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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
      m3u8Url: m3u8Url || '',
      cookie: cookie || '',
      key: key || '',
      logo: logo || '',
      licenseType: 'clearkey',
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

app.put('/api/channels/:id', async (req, res) => {
  try {
    const updates = req.body;
    updates.updatedAt = Date.now();

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

app.delete('/api/channels', async (req, res) => {
  try {
    const result = await Channel.deleteMany({});

    res.json({ 
      success: true, 
      message: `Successfully deleted all channels`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting all channels:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting all channels', 
      error: error.message 
    });
  }
});

// ===================================
// UTILITY ENDPOINTS
// ===================================

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

app.get('/api/stats', async (req, res) => {
  try {
    const total = await Channel.countDocuments();
    const active = await Channel.countDocuments({ isActive: true });
    const groups = await Channel.distinct('groupTitle');
    const withDRM = await Channel.countDocuments({ key: { $ne: '' } });
    const withM3u8 = await Channel.countDocuments({ m3u8Url: { $ne: '' } });
    const totalPlaylists = await Playlist.countDocuments();
    const activePlaylists = await Playlist.countDocuments({ isActive: true });

    res.json({
      success: true,
      data: {
        totalChannels: total,
        activeChannels: active,
        inactiveChannels: total - active,
        totalGroups: groups.length,
        channelsWithDRM: withDRM,
        channelsWithM3u8Fallback: withM3u8,
        totalPlaylists,
        activePlaylists,
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

app.get('/api/playlist.m3u', async (req, res) => {
  try {
    const { groupTitle, useM3u8 } = req.query;
    let query = { isActive: true };
    if (groupTitle) query.groupTitle = groupTitle;

    const channels = await Channel.find(query).sort({ title: 1 });
    
    let m3u = '#EXTM3U x-tvg-url=""\n';
    
    for (const channel of channels) {
      // Determine which URL to use
      let streamUrl = channel.url;
      
      // If useM3u8 parameter is set and m3u8Url exists, prefer m3u8
      if (useM3u8 === 'true' && channel.m3u8Url) {
        streamUrl = channel.m3u8Url;
      }
      
      if (!streamUrl) continue;

      m3u += `#EXTINF:-1 tvg-id="${channel.tvgId}" group-title="${channel.groupTitle}" tvg-logo="${channel.logo}",${channel.title}\n`;
      
      if (channel.key) {
        m3u += `#KODIPROP:inputstream.adaptive.license_type=clearkey\n`;
        m3u += `#KODIPROP:inputstream.adaptive.license_key=${channel.key}\n`;
      }
      
      if (channel.cookie) {
        m3u += `#EXTHTTP:{"cookie":"${channel.cookie}"}\n`;
      }
      
      m3u += `${streamUrl}\n\n`;
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
// ERROR HANDLING
// ===================================

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error', 
    error: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found',
    path: req.path
  });
});

// ===================================
// AUTO-SYNC SCHEDULER
// ===================================

// Auto-sync playlists every 5 minutes
setInterval(async () => {
  try {
    const playlists = await Playlist.find({ 
      isActive: true, 
      autoSync: true 
    });

    for (const playlist of playlists) {
      const timeSinceLastSync = Date.now() - (playlist.lastSyncAt || 0);
      
      if (timeSinceLastSync >= playlist.syncInterval) {
        console.log(`⏰ Auto-syncing playlist: ${playlist.name}`);
        try {
          await syncPlaylistChannels(playlist._id);
        } catch (error) {
          console.error(`Auto-sync failed for ${playlist.name}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in playlist auto-sync:', error);
  }
}, 300000);

// ===================================
// SERVER START
// ===================================

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     🎬 IPTV CHANNEL MANAGER API v2.4                  ║
║           WITH M3U8 FALLBACK SUPPORT                  ║
╚════════════════════════════════════════════════════════╝

🚀 Server Status: RUNNING
📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Base URL: http://localhost:${PORT}

📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}

✨ NEW FEATURES:
   • M3U8 fallback URL support
   • Auto-switch to M3U8 if main URL fails
   • Both URLs stored under same channel
   • Access manager via /rocker.html

🎯 MAIN ENDPOINTS:
   ├─ GET    /                        Server status
   ├─ GET    /rocker.html             Channel Manager UI
   ├─ GET    /health                  Health check
   │
   ├─ POST   /api/playlists           Add playlist
   ├─ GET    /api/playlists           List playlists
   ├─ POST   /api/playlists/:id/sync  Sync playlist
   │
   ├─ POST   /api/channels            Add channel (with m3u8Url)
   ├─ GET    /api/channels            List channels
   ├─ PUT    /api/channels/:id        Update channel
   ├─ DELETE /api/channels/:id        Delete channel
   │
   └─ GET    /api/playlist.m3u        Generate M3U playlist

🔄 AUTO-SYNC:
   • Playlists: Every 5 minutes

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
