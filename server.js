// Complete Secure IPTV Channel Manager API with Playlist URL Management
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios'); // Add this dependency: npm install axios

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

// Channel Schema
const channelSchema = new mongoose.Schema({
  title: { type: String, required: true },
  url: { type: String, required: true },
  cookie: { type: String, default: '' },
  key: { type: String, default: '' },
  logo: { type: String, default: '' },
  licenseType: { type: String, default: 'clearkey' },
  groupTitle: { type: String, default: 'General' },
  tvgId: { type: String, required: true, unique: true },
  isActive: { type: Boolean, default: true },
  sourcePlaylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist', default: null },
  sourceStalkerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stalker', default: null },
  stalkerData: { type: Object, default: {} },
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

// Stalker Portal Schema (Simplified - only Name, URL, MAC)
const stalkerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  host: { type: String, required: true }, // URL field
  macAddress: { type: String, required: true }, // MAC Address
  token: { type: String, default: '' },
  tokenExpiry: { type: Date, default: null },
  username: { type: String, default: 'stalker' }, // Default username
  password: { type: String, default: 'stalker' }, // Default password
  isActive: { type: Boolean, default: true },
  totalChannels: { type: Number, default: 0 },
  lastSyncAt: { type: Date, default: null },
  lastSyncStatus: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

stalkerSchema.index({ host: 1, macAddress: 1 }, { unique: true });

const Channel = mongoose.model('Channel', channelSchema);
const Playlist = mongoose.model('Playlist', playlistSchema);
const Stalker = mongoose.model('Stalker', stalkerSchema);

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
    cookie: channelObj.cookie,
    key: channelObj.key,
    logo: channelObj.logo,
    licenseType: channelObj.licenseType,
    groupTitle: channelObj.groupTitle,
    tvgId: channelObj.tvgId,
    isActive: channelObj.isActive,
    sourcePlaylistId: channelObj.sourcePlaylistId,
    sourceStalkerId: channelObj.sourceStalkerId,
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
        url: ''
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
// STALKER PORTAL FUNCTIONS (REAL-TIME)
// ===================================

// Token cache for real-time streaming
const tokenCache = new Map();

// Generate or refresh Stalker token (real-time enabled)
async function getStalkerToken(stalkerId, forceRefresh = false) {
  try {
    const stalker = await Stalker.findById(stalkerId);
    if (!stalker) {
      throw new Error('Stalker portal not found');
    }

    const cacheKey = stalkerId.toString();
    const cachedToken = tokenCache.get(cacheKey);
    
    // Check cache first (unless force refresh)
    if (!forceRefresh && cachedToken && cachedToken.expiry > Date.now() + 30000) {
      return cachedToken.token;
    }

    console.log(`🔑 Getting fresh token for: ${stalker.name}`);
    
    const cleanHost = stalker.host.replace(/\/$/, '');
    
    // Step 1: Handshake
    const handshakeUrl = `${cleanHost}/server/load.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
    const handshakeResponse = await axios.get(handshakeUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Stalker_Portal',
        'MAC': stalker.macAddress
      }
    });

    let token = '';
    if (handshakeResponse.data.js && handshakeResponse.data.js.token) {
      token = handshakeResponse.data.js.token;
    }

    if (!token) {
      throw new Error('Failed to get token from handshake');
    }

    // Step 2: Authenticate with default credentials
    const authUrl = `${cleanHost}/server/load.php?type=stb&action=do_auth&login=${encodeURIComponent(stalker.username)}&password=${encodeURIComponent(stalker.password)}&device_id=&device_id2=&sn=&device_type=&app=1&ver=1&model=&hw_version=&api_signature=&not_valid_token=&auth_signature=&JsHttpRequest=1-xml`;
    
    const authResponse = await axios.get(authUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Stalker_Portal',
        'Authorization': `Bearer ${token}`,
        'MAC': stalker.macAddress
      }
    });

    if (authResponse.data.js && authResponse.data.js.token) {
      const newToken = authResponse.data.js.token;
      const expiry = new Date(Date.now() + (23 * 60 * 60 * 1000)); // 23 hours
      
      // Update cache
      tokenCache.set(cacheKey, {
        token: newToken,
        expiry: expiry.getTime(),
        lastUpdated: Date.now()
      });
      
      // Update database
      await Stalker.findByIdAndUpdate(stalkerId, {
        token: newToken,
        tokenExpiry: expiry,
        updatedAt: Date.now()
      });
      
      return newToken;
    }

    throw new Error('Authentication failed');
  } catch (error) {
    console.error('Error getting Stalker token:', error.message);
    throw error;
  }
}

// Get channels from Stalker (lightweight for streaming)
async function getStalkerChannelsLightweight(stalkerId) {
  try {
    const stalker = await Stalker.findById(stalkerId);
    if (!stalker) {
      throw new Error('Stalker portal not found');
    }

    const token = await getStalkerToken(stalkerId);
    const cleanHost = stalker.host.replace(/\/$/, '');

    // Get categories quickly
    const categoriesUrl = `${cleanHost}/server/load.php?type=itv&action=get_categories&JsHttpRequest=1-xml`;
    const catResponse = await axios.get(categoriesUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Stalker_Portal',
        'Authorization': `Bearer ${token}`,
        'MAC': stalker.macAddress
      }
    });

    const categories = catResponse.data.js?.data || [];
    
    // Get all channels at once (if supported) or just first category
    let channels = [];
    if (categories.length > 0) {
      const firstCategory = categories[0];
      const channelsUrl = `${cleanHost}/server/load.php?type=itv&action=get_ordered_list&category=${firstCategory.id}&force_ch_link_check=&JsHttpRequest=1-xml`;
      
      const channelsResponse = await axios.get(channelsUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Stalker_Portal',
          'Authorization': `Bearer ${token}`,
          'MAC': stalker.macAddress
        }
      });

      channels = channelsResponse.data.js?.data || [];
      
      // Add category name
      channels = channels.map(ch => ({
        ...ch,
        category_name: firstCategory.title
      }));
    }

    return channels;
  } catch (error) {
    // If token expired, try once more with force refresh
    if (error.response?.status === 401 || error.message.includes('token')) {
      console.log('Token expired, attempting refresh...');
      const freshToken = await getStalkerToken(stalkerId, true);
      
      // Retry with fresh token
      return getStalkerChannelsLightweight(stalkerId);
    }
    throw error;
  }
}

// Real-time stream proxy with auto token refresh
async function proxyStalkerStream(originalUrl, stalkerId, channelId) {
  try {
    // Get fresh token for streaming
    const token = await getStalkerToken(stalkerId);
    
    // Parse original URL and add/replace token
    const urlObj = new URL(originalUrl);
    urlObj.searchParams.set('token', token);
    
    // Add timestamp to prevent caching
    urlObj.searchParams.set('_t', Date.now());
    
    const proxyUrl = urlObj.toString();
    
    // Stream with auto-retry on token expiry
    const streamResponse = await axios({
      method: 'GET',
      url: proxyUrl,
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'IPTV-Stream-Proxy/1.0',
        'Referer': originalUrl.split('?')[0]
      }
    });
    
    return streamResponse;
  } catch (error) {
    // If token error, retry once with fresh token
    if (error.response?.status === 401 || error.message.includes('token')) {
      console.log('Stream token expired, refreshing...');
      const freshToken = await getStalkerToken(stalkerId, true);
      
      // Retry with fresh token
      return proxyStalkerStream(originalUrl, stalkerId, channelId);
    }
    throw error;
  }
}

// Sync Stalker channels to database
async function syncStalkerChannels(stalkerId) {
  const stalker = await Stalker.findById(stalkerId);
  if (!stalker) {
    throw new Error('Stalker portal not found');
  }

  try {
    console.log(`🔄 Syncing Stalker portal: ${stalker.name}`);
    
    const channels = await getStalkerChannelsLightweight(stalkerId);
    
    if (!channels || channels.length === 0) {
      throw new Error('No channels found');
    }

    const results = { 
      added: 0, 
      updated: 0,
      errors: 0, 
      total: channels.length
    };

    for (const stalkerChannel of channels) {
      try {
        const cleanHost = stalker.host.replace(/\/$/, '');
        const token = await getStalkerToken(stalkerId);
        const streamUrl = `${cleanHost}/${stalkerChannel.cmd}?token=${token}&${stalkerChannel.extra || ''}`;
        const tvgId = `stalker_${stalker.id}_${stalkerChannel.id}`;
        
        const channelData = {
          title: stalkerChannel.name || `Channel ${stalkerChannel.num}`,
          url: streamUrl,
          tvgId: tvgId,
          logo: stalkerChannel.logo || '',
          groupTitle: stalkerChannel.category_name || 'Stalker',
          licenseType: 'clearkey',
          key: '',
          cookie: '',
          isActive: true,
          sourceStalkerId: stalker._id,
          stalkerData: {
            original_id: stalkerChannel.id,
            number: stalkerChannel.num,
            cmd: stalkerChannel.cmd,
            category_id: stalkerChannel.category_id
          }
        };

        // Check if exists
        const existing = await Channel.findOne({ 
          'stalkerData.original_id': stalkerChannel.id,
          sourceStalkerId: stalker._id
        });
        
        if (existing) {
          await Channel.findByIdAndUpdate(existing._id, {
            ...channelData,
            updatedAt: Date.now()
          });
          results.updated++;
        } else {
          const channel = new Channel(channelData);
          await channel.save();
          results.added++;
        }
      } catch (error) {
        console.error(`Error processing Stalker channel:`, error);
        results.errors++;
      }
    }

    await Stalker.findByIdAndUpdate(stalkerId, {
      lastSyncAt: Date.now(),
      lastSyncStatus: 'success',
      totalChannels: results.added + results.updated,
      updatedAt: Date.now()
    });

    console.log(`✅ Stalker sync completed: +${results.added} added, ${results.updated} updated`);
    return results;

  } catch (error) {
    console.error(`❌ Stalker sync failed:`, error);
    
    await Stalker.findByIdAndUpdate(stalkerId, {
      lastSyncAt: Date.now(),
      lastSyncStatus: 'error',
      updatedAt: Date.now()
    });
    
    throw error;
  }
}

// ===================================
// BASIC ROUTES
// ===================================

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    api: 'IPTV Channel Manager API v2.3 with Real-time Stalker'
  });
});

// ===================================
// STALKER PORTAL ENDPOINTS (SIMPLIFIED)
// ===================================

// Get all Stalker portals
app.get('/api/stalker', async (req, res) => {
  try {
    const portals = await Stalker.find().sort({ createdAt: -1 });
    const sanitizedPortals = portals.map(portal => ({
      _id: portal._id,
      name: portal.name,
      host: portal.host,
      macAddress: portal.macAddress,
      isActive: portal.isActive,
      totalChannels: portal.totalChannels,
      lastSyncAt: portal.lastSyncAt,
      lastSyncStatus: portal.lastSyncStatus,
      tokenExpiry: portal.tokenExpiry,
      createdAt: portal.createdAt
    }));
    
    res.json({ 
      success: true, 
      count: portals.length,
      data: sanitizedPortals
    });
  } catch (error) {
    console.error('Error fetching Stalker portals:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching Stalker portals', 
      error: error.message 
    });
  }
});

// Get single Stalker portal
app.get('/api/stalker/:id', async (req, res) => {
  try {
    const portal = await Stalker.findById(req.params.id);
    if (!portal) {
      return res.status(404).json({ 
        success: false, 
        message: 'Stalker portal not found' 
      });
    }
    
    res.json({ 
      success: true, 
      data: {
        _id: portal._id,
        name: portal.name,
        host: portal.host,
        macAddress: portal.macAddress,
        isActive: portal.isActive,
        totalChannels: portal.totalChannels,
        lastSyncAt: portal.lastSyncAt,
        lastSyncStatus: portal.lastSyncStatus,
        tokenExpiry: portal.tokenExpiry,
        createdAt: portal.createdAt
      }
    });
  } catch (error) {
    console.error('Error fetching Stalker portal:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching Stalker portal', 
      error: error.message 
    });
  }
});

// Add new Stalker portal (Only Name, URL, MAC)
app.post('/api/stalker', async (req, res) => {
  try {
    const { name, host, macAddress } = req.body;

    if (!name || !host || !macAddress) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: name, host (URL), and macAddress' 
      });
    }

    // Validate MAC address format
    const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    if (!macRegex.test(macAddress)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid MAC address format. Use: 00:1A:79:00:00:78' 
      });
    }

    // Clean host URL
    const cleanHost = host.replace(/\/$/, '');
    
    // Check if portal already exists
    const existing = await Stalker.findOne({ 
      host: cleanHost,
      macAddress: macAddress 
    });
    
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Stalker portal with this host and MAC already exists' 
      });
    }

    // Create portal with default credentials
    const portalData = {
      name,
      host: cleanHost,
      macAddress,
      username: 'stalker', // Default username
      password: 'stalker', // Default password
      isActive: true
    };

    const portal = new Stalker(portalData);
    await portal.save();

    // Try to get token immediately
    try {
      await getStalkerToken(portal._id);
      res.status(201).json({ 
        success: true, 
        message: 'Stalker portal added successfully', 
        data: {
          _id: portal._id,
          name: portal.name,
          host: portal.host,
          macAddress: portal.macAddress,
          isActive: portal.isActive
        }
      });
    } catch (authError) {
      // Portal saved but token failed - still return success
      res.status(201).json({ 
        success: true, 
        message: 'Stalker portal added but token acquisition failed. Try syncing manually.',
        data: {
          _id: portal._id,
          name: portal.name,
          host: portal.host,
          macAddress: portal.macAddress,
          isActive: portal.isActive
        },
        warning: authError.message
      });
    }
  } catch (error) {
    console.error('Error adding Stalker portal:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding Stalker portal', 
      error: error.message 
    });
  }
});

// Update Stalker portal
app.put('/api/stalker/:id', async (req, res) => {
  try {
    const updates = req.body;
    const portalId = req.params.id;
    
    // Clean host if provided
    if (updates.host) {
      updates.host = updates.host.replace(/\/$/, '');
    }
    
    updates.updatedAt = Date.now();

    const portal = await Stalker.findByIdAndUpdate(
      portalId,
      updates,
      { new: true, runValidators: true }
    );

    if (!portal) {
      return res.status(404).json({ 
        success: false, 
        message: 'Stalker portal not found' 
      });
    }

    // Clear token cache for this portal
    tokenCache.delete(portalId.toString());

    res.json({ 
      success: true, 
      message: 'Stalker portal updated successfully', 
      data: {
        _id: portal._id,
        name: portal.name,
        host: portal.host,
        macAddress: portal.macAddress,
        isActive: portal.isActive
      }
    });
  } catch (error) {
    console.error('Error updating Stalker portal:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating Stalker portal', 
      error: error.message 
    });
  }
});

// Delete Stalker portal
app.delete('/api/stalker/:id', async (req, res) => {
  try {
    const { deleteChannels } = req.query;
    const portal = await Stalker.findById(req.params.id);

    if (!portal) {
      return res.status(404).json({ 
        success: false, 
        message: 'Stalker portal not found' 
      });
    }

    // Delete associated channels if requested
    if (deleteChannels === 'true') {
      const deleteResult = await Channel.deleteMany({ sourceStalkerId: req.params.id });
      console.log(`Deleted ${deleteResult.deletedCount} channels from Stalker portal ${portal.name}`);
    } else {
      // Just remove the portal reference
      await Channel.updateMany(
        { sourceStalkerId: req.params.id },
        { $set: { sourceStalkerId: null, stalkerData: {} } }
      );
    }

    // Clear from token cache
    tokenCache.delete(req.params.id.toString());
    
    await Stalker.findByIdAndDelete(req.params.id);

    res.json({ 
      success: true, 
      message: 'Stalker portal deleted successfully',
      deletedPortal: portal.name
    });
  } catch (error) {
    console.error('Error deleting Stalker portal:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting Stalker portal', 
      error: error.message 
    });
  }
});

// Sync channels from Stalker portal
app.post('/api/stalker/:id/sync', async (req, res) => {
  try {
    const syncResults = await syncStalkerChannels(req.params.id);
    res.json({ 
      success: true, 
      message: 'Stalker portal synced successfully',
      results: syncResults
    });
  } catch (error) {
    console.error('Error syncing Stalker portal:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error syncing Stalker portal', 
      error: error.message 
    });
  }
});

// Test Stalker portal connection
app.post('/api/stalker/test', async (req, res) => {
  try {
    const { host, macAddress } = req.body;

    if (!host || !macAddress) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: host and macAddress' 
      });
    }

    // Test with default credentials
    const testPortal = {
      _id: 'test',
      host: host.replace(/\/$/, ''),
      macAddress: macAddress,
      username: 'stalker',
      password: 'stalker'
    };

    // Simulate token acquisition
    const cleanHost = testPortal.host;
    const handshakeUrl = `${cleanHost}/server/load.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
    
    const handshakeResponse = await axios.get(handshakeUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Stalker_Portal',
        'MAC': macAddress
      }
    });

    if (handshakeResponse.data.js && handshakeResponse.data.js.token) {
      res.json({ 
        success: true, 
        message: 'Stalker portal connection successful',
        data: {
          host: host,
          macAddress: macAddress,
          handshake: 'successful',
          supportsDefaultAuth: true
        }
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Stalker portal accessible but may need custom credentials',
        data: {
          host: host,
          macAddress: macAddress,
          handshake: 'partial',
          note: 'Portal responds but may require custom username/password'
        }
      });
    }
  } catch (error) {
    console.error('Stalker test connection failed:', error);
    res.status(400).json({ 
      success: false, 
      message: 'Stalker portal connection failed',
      error: error.message,
      suggestion: 'Check if the portal URL is correct and accessible'
    });
  }
});

// Generate M3U playlist from Stalker portal (REAL-TIME TOKENS)
app.get('/api/stalker/:id/playlist.m3u', async (req, res) => {
  try {
    const portal = await Stalker.findById(req.params.id);
    if (!portal) {
      return res.status(404).json({ 
        success: false, 
        message: 'Stalker portal not found' 
      });
    }

    // Get fresh token
    const token = await getStalkerToken(portal._id);
    const channels = await getStalkerChannelsLightweight(portal._id);
    
    if (!channels || channels.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No channels found in Stalker portal' 
      });
    }

    // Generate M3U with REAL-TIME tokens
    let m3u = '#EXTM3U x-tvg-url=""\n';
    m3u += `# Playlist generated from Stalker Portal: ${portal.name}\n`;
    m3u += `# Generated: ${new Date().toISOString()}\n`;
    m3u += `# Total Channels: ${channels.length}\n`;
    m3u += `# Token Expiry: ${portal.tokenExpiry}\n\n`;
    
    for (const channel of channels) {
      const cleanHost = portal.host.replace(/\/$/, '');
      const streamUrl = `${cleanHost}/${channel.cmd}?token=${token}&${channel.extra || ''}`;
      const tvgId = `stalker_${portal._id}_${channel.id}`;
      const groupTitle = channel.category_name || 'Stalker';
      const logo = channel.logo || '';
      const title = channel.name || `Channel ${channel.num}`;
      
      m3u += `#EXTINF:-1 tvg-id="${tvgId}" group-title="${groupTitle}" tvg-logo="${logo}",${title}\n`;
      m3u += `${streamUrl}\n\n`;
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="stalker_${portal.name.replace(/\s+/g, '_')}.m3u"`);
    res.send(m3u);
  } catch (error) {
    console.error('Error generating Stalker playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error generating playlist from Stalker portal', 
      error: error.message 
    });
  }
});

// REAL-TIME STREAM PROXY ENDPOINT
app.get('/api/stalker/:portalId/stream/:channelId', async (req, res) => {
  try {
    const { portalId, channelId } = req.params;
    
    // Find the channel
    const channel = await Channel.findOne({
      _id: channelId,
      sourceStalkerId: portalId
    });
    
    if (!channel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found' 
      });
    }

    // Proxy the stream with real-time token refresh
    const streamResponse = await proxyStalkerStream(channel.url, portalId, channelId);
    
    // Set appropriate headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Pipe the stream to response
    streamResponse.data.pipe(res);
    
    // Handle stream errors
    streamResponse.data.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      streamResponse.data.destroy();
    });
    
  } catch (error) {
    console.error('Stream proxy error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: 'Stream proxy error', 
        error: error.message 
      });
    }
  }
});

// REAL-TIME PLAYLIST WITH PROXY LINKS
app.get('/api/stalker/:id/playlist-proxy.m3u', async (req, res) => {
  try {
    const portal = await Stalker.findById(req.params.id);
    if (!portal) {
      return res.status(404).json({ 
        success: false, 
        message: 'Stalker portal not found' 
      });
    }

    // Get channels from database (already synced)
    const channels = await Channel.find({
      sourceStalkerId: portal._id,
      isActive: true
    }).sort({ title: 1 });

    if (!channels || channels.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No channels found. Sync the portal first.' 
      });
    }

    // Generate M3U with proxy URLs
    let m3u = '#EXTM3U x-tvg-url=""\n';
    m3u += `# Playlist from Stalker Portal: ${portal.name}\n`;
    m3u += `# Generated: ${new Date().toISOString()}\n`;
    m3u += `# Total Channels: ${channels.length}\n`;
    m3u += `# Note: Streams use real-time token refresh via proxy\n\n`;
    
    for (const channel of channels) {
      const proxyUrl = `http://${req.headers.host}/api/stalker/${portal._id}/stream/${channel._id}`;
      
      m3u += `#EXTINF:-1 tvg-id="${channel.tvgId}" group-title="${channel.groupTitle}" tvg-logo="${channel.logo}",${channel.title}\n`;
      m3u += `${proxyUrl}\n\n`;
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="stalker_proxy_${portal.name.replace(/\s+/g, '_')}.m3u"`);
    res.send(m3u);
  } catch (error) {
    console.error('Error generating proxy playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error generating proxy playlist', 
      error: error.message 
    });
  }
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
      error: error.message 
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
    const { groupTitle, active, search, playlistId, stalkerId } = req.query;
    let query = {};

    if (groupTitle) query.groupTitle = groupTitle;
    if (active !== undefined) query.isActive = active === 'true';
    if (playlistId) query.sourcePlaylistId = playlistId;
    if (stalkerId) query.sourceStalkerId = stalkerId;
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
    const { title, url, cookie, key, logo, groupTitle, tvgId } = req.body;

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
    const totalPlaylists = await Playlist.countDocuments();
    const activePlaylists = await Playlist.countDocuments({ isActive: true });
    const totalStalker = await Stalker.countDocuments();
    const activeStalker = await Stalker.countDocuments({ isActive: true });
    const stalkerChannels = await Channel.countDocuments({ sourceStalkerId: { $ne: null } });

    res.json({
      success: true,
      data: {
        totalChannels: total,
        activeChannels: active,
        inactiveChannels: total - active,
        totalGroups: groups.length,
        channelsWithDRM: withDRM,
        totalPlaylists,
        activePlaylists,
        totalStalkerPortals: totalStalker,
        activeStalkerPortals: activeStalker,
        channelsFromStalker: stalkerChannels,
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
    const { groupTitle } = req.query;
    let query = { isActive: true };
    if (groupTitle) query.groupTitle = groupTitle;

    const channels = await Channel.find(query).sort({ title: 1 });
    
    let m3u = '#EXTM3U x-tvg-url=""\n';
    
    for (const channel of channels) {
      if (!channel.url) continue;

      m3u += `#EXTINF:-1 tvg-id="${channel.tvgId}" group-title="${channel.groupTitle}" tvg-logo="${channel.logo}",${channel.title}\n`;
      
      if (channel.key) {
        m3u += `#KODIPROP:inputstream.adaptive.license_type=clearkey\n`;
        m3u += `#KODIPROP:inputstream.adaptive.license_key=${channel.key}\n`;
      }
      
      if (channel.cookie) {
        m3u += `#EXTHTTP:{"cookie":"${channel.cookie}"}\n`;
      }
      
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
// AUTO-SYNC & TOKEN REFRESH SCHEDULER
// ===================================

// Clean expired tokens from cache every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, tokenData] of tokenCache.entries()) {
    if (tokenData.expiry < now) {
      tokenCache.delete(key);
      console.log(`🧹 Cleared expired token cache for: ${key}`);
    }
  }
}, 60000);

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

// Auto-refresh Stalker tokens before expiry (every 30 minutes)
setInterval(async () => {
  try {
    const stalkerPortals = await Stalker.find({ 
      isActive: true 
    });

    for (const portal of stalkerPortals) {
      // Refresh token if it expires in less than 1 hour
      if (portal.tokenExpiry && (portal.tokenExpiry.getTime() - Date.now()) < 3600000) {
        console.log(`🔄 Pre-refreshing token for Stalker: ${portal.name}`);
        try {
          await getStalkerToken(portal._id, true);
          console.log(`✅ Token refreshed for: ${portal.name}`);
        } catch (error) {
          console.error(`Token refresh failed for ${portal.name}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in token refresh scheduler:', error);
  }
}, 1800000); // 30 minutes

// ===================================
// SERVER START
// ===================================

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     🎬 IPTV CHANNEL MANAGER API v2.3                  ║
║           WITH REAL-TIME STALKER STREAMING            ║
╚════════════════════════════════════════════════════════╝

🚀 Server Status: RUNNING
📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Base URL: http://localhost:${PORT}

📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}

📚 REAL-TIME STALKER FEATURES:
   • Auto-token refresh during streaming
   • Zero-delay token renewal
   • Stream proxy with auto-retry
   • Only 3 inputs: Name, URL, MAC
   • Default credentials (stalker/stalker)

🎯 STALKER ENDPOINTS:
   ├─ POST   /api/stalker                Add portal (Name, URL, MAC only)
   ├─ GET    /api/stalker                List portals
   ├─ POST   /api/stalker/:id/sync       Sync channels
   ├─ GET    /api/stalker/:id/playlist.m3u      M3U with live tokens
   ├─ GET    /api/stalker/:id/playlist-proxy.m3u Proxy M3U (no expiry)
   └─ GET    /api/stalker/:portalId/stream/:channelId  Real-time stream

📡 STREAMING FEATURES:
   • Token auto-refresh during playback
   • Proxy layer for uninterrupted streams
   • Automatic retry on token expiry
   • HTTP Live Streaming compatible

🔄 AUTO-SYNC:
   • Playlists: Every 5 minutes
   • Tokens: Pre-refresh 1 hour before expiry
   • Cache cleanup: Every minute

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
