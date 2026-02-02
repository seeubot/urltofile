// Complete Movies & TV Series Manager API
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

// Episode Schema (for TV Series)
const episodeSchema = new mongoose.Schema({
  episodeNumber: { type: Number, required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  thumbnail: { type: String, default: '' },
  streamUrl: { type: String, required: true },
  duration: { type: String, default: '' },
  releaseDate: { type: Date, default: null },
  isActive: { type: Boolean, default: true }
});

// Season Schema (for TV Series)
const seasonSchema = new mongoose.Schema({
  seasonNumber: { type: Number, required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  thumbnail: { type: String, default: '' },
  releaseDate: { type: Date, default: null },
  episodes: [episodeSchema],
  episodeCount: { type: Number, default: 0 }
});

// Main Content Schema (Movies & Series)
const contentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, enum: ['movie', 'series'], required: true },
  description: { type: String, default: '' },
  thumbnail: { type: String, default: '' },
  bannerImage: { type: String, default: '' },
  
  // Movie-specific fields
  streamUrl: { type: String, default: '' }, // Only for movies
  duration: { type: String, default: '' }, // Runtime for movies
  
  // Series-specific fields
  seasons: [seasonSchema], // Only for series
  totalSeasons: { type: Number, default: 0 },
  totalEpisodes: { type: Number, default: 0 },
  
  // Common metadata
  genre: [{ type: String }],
  year: { type: Number, default: null },
  rating: { type: String, default: '' }, // e.g., "PG-13", "R", "TV-MA"
  imdbRating: { type: Number, default: null },
  cast: [{ type: String }],
  director: { type: String, default: '' },
  language: { type: String, default: 'English' },
  country: { type: String, default: '' },
  
  // Organization
  category: { type: String, default: 'General' },
  tags: [{ type: String }],
  
  // Status
  isActive: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  releaseDate: { type: Date, default: null },
  
  // Source tracking
  sourcePlaylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentPlaylist', default: null },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Indexes for better query performance
contentSchema.index({ title: 1, type: 1, category: 1, genre: 1 });

// Content Playlist Schema (for bulk imports)
const contentPlaylistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  type: { type: String, enum: ['movie', 'series', 'mixed'], default: 'mixed' },
  isActive: { type: Boolean, default: true },
  autoSync: { type: Boolean, default: true },
  syncInterval: { type: Number, default: 3600000 }, // 1 hour
  lastSyncAt: { type: Date, default: null },
  lastSyncStatus: { type: String, default: 'pending' },
  lastSyncMessage: { type: String, default: '' },
  contentCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

const Content = mongoose.model('Content', contentSchema);
const ContentPlaylist = mongoose.model('ContentPlaylist', contentPlaylistSchema);

// ===================================
// MIDDLEWARE
// ===================================
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ===================================
// UTILITY FUNCTIONS
// ===================================

function sanitizeContent(content, includeStreamUrls = false) {
  const contentObj = content.toObject ? content.toObject() : content;
  
  if (!includeStreamUrls) {
    const sanitized = {
      _id: contentObj._id,
      title: contentObj.title,
      type: contentObj.type,
      description: contentObj.description,
      thumbnail: contentObj.thumbnail,
      bannerImage: contentObj.bannerImage,
      genre: contentObj.genre,
      year: contentObj.year,
      rating: contentObj.rating,
      imdbRating: contentObj.imdbRating,
      cast: contentObj.cast,
      director: contentObj.director,
      language: contentObj.language,
      country: contentObj.country,
      category: contentObj.category,
      tags: contentObj.tags,
      isActive: contentObj.isActive,
      isFeatured: contentObj.isFeatured,
      releaseDate: contentObj.releaseDate,
      createdAt: contentObj.createdAt,
      updatedAt: contentObj.updatedAt
    };
    
    if (contentObj.type === 'movie') {
      sanitized.duration = contentObj.duration;
      sanitized.hasStreamUrl = !!contentObj.streamUrl;
    } else if (contentObj.type === 'series') {
      sanitized.totalSeasons = contentObj.totalSeasons;
      sanitized.totalEpisodes = contentObj.totalEpisodes;
      sanitized.seasonCount = contentObj.seasons ? contentObj.seasons.length : 0;
    }
    
    return sanitized;
  }
  
  return contentObj;
}

// ===================================
// BASIC ROUTES
// ===================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Movies & TV Series Manager API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    api: 'Movies & TV Series Manager API v1.0'
  });
});

// ===================================
// CONTENT ENDPOINTS (Movies & Series)
// ===================================

// Get all content (movies and series)
app.get('/api/content', async (req, res) => {
  try {
    const { type, category, genre, year, featured, search, limit, page } = req.query;
    let query = {};

    if (type) query.type = type;
    if (category) query.category = category;
    if (genre) query.genre = genre;
    if (year) query.year = parseInt(year);
    if (featured !== undefined) query.isFeatured = featured === 'true';
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { cast: { $regex: search, $options: 'i' } },
        { director: { $regex: search, $options: 'i' } }
      ];
    }

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const skip = (pageNum - 1) * limitNum;

    const total = await Content.countDocuments(query);
    const content = await Content.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({ 
      success: true, 
      count: content.length,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      data: content.map(c => sanitizeContent(c, false))
    });
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching content', 
      error: error.message 
    });
  }
});

// Get single content by ID
app.get('/api/content/:id', async (req, res) => {
  try {
    const content = await Content.findById(req.params.id);
    if (!content) {
      return res.status(404).json({ 
        success: false, 
        message: 'Content not found' 
      });
    }
    
    res.json({ 
      success: true, 
      data: sanitizeContent(content, true)
    });
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching content', 
      error: error.message 
    });
  }
});

// Add new movie
app.post('/api/movies', async (req, res) => {
  try {
    const { 
      title, streamUrl, thumbnail, bannerImage, description, 
      duration, genre, year, rating, imdbRating, cast, director,
      language, country, category, tags, isFeatured
    } = req.body;

    if (!title || !streamUrl) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title and stream URL are required for movies' 
      });
    }

    const movieData = {
      title,
      type: 'movie',
      streamUrl,
      thumbnail: thumbnail || '',
      bannerImage: bannerImage || '',
      description: description || '',
      duration: duration || '',
      genre: genre || [],
      year: year || null,
      rating: rating || '',
      imdbRating: imdbRating || null,
      cast: cast || [],
      director: director || '',
      language: language || 'English',
      country: country || '',
      category: category || 'General',
      tags: tags || [],
      isFeatured: isFeatured || false
    };

    const movie = new Content(movieData);
    await movie.save();

    res.status(201).json({ 
      success: true, 
      message: 'Movie added successfully', 
      data: sanitizeContent(movie, true)
    });
  } catch (error) {
    console.error('Error adding movie:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding movie', 
      error: error.message 
    });
  }
});

// Add new series
app.post('/api/series', async (req, res) => {
  try {
    const { 
      title, thumbnail, bannerImage, description, seasons,
      genre, year, rating, imdbRating, cast, director,
      language, country, category, tags, isFeatured
    } = req.body;

    if (!title) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title is required for series' 
      });
    }

    // Calculate total episodes
    let totalEpisodes = 0;
    if (seasons && Array.isArray(seasons)) {
      seasons.forEach(season => {
        if (season.episodes && Array.isArray(season.episodes)) {
          season.episodeCount = season.episodes.length;
          totalEpisodes += season.episodes.length;
        }
      });
    }

    const seriesData = {
      title,
      type: 'series',
      thumbnail: thumbnail || '',
      bannerImage: bannerImage || '',
      description: description || '',
      seasons: seasons || [],
      totalSeasons: seasons ? seasons.length : 0,
      totalEpisodes,
      genre: genre || [],
      year: year || null,
      rating: rating || '',
      imdbRating: imdbRating || null,
      cast: cast || [],
      director: director || '',
      language: language || 'English',
      country: country || '',
      category: category || 'General',
      tags: tags || [],
      isFeatured: isFeatured || false
    };

    const series = new Content(seriesData);
    await series.save();

    res.status(201).json({ 
      success: true, 
      message: 'Series added successfully', 
      data: sanitizeContent(series, true)
    });
  } catch (error) {
    console.error('Error adding series:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding series', 
      error: error.message 
    });
  }
});

// Update content (movie or series)
app.put('/api/content/:id', async (req, res) => {
  try {
    const updates = req.body;
    updates.updatedAt = Date.now();

    // Recalculate totals for series
    if (updates.type === 'series' && updates.seasons) {
      let totalEpisodes = 0;
      updates.seasons.forEach(season => {
        if (season.episodes && Array.isArray(season.episodes)) {
          season.episodeCount = season.episodes.length;
          totalEpisodes += season.episodes.length;
        }
      });
      updates.totalSeasons = updates.seasons.length;
      updates.totalEpisodes = totalEpisodes;
    }

    const content = await Content.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    if (!content) {
      return res.status(404).json({ 
        success: false, 
        message: 'Content not found' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Content updated successfully', 
      data: sanitizeContent(content, true)
    });
  } catch (error) {
    console.error('Error updating content:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating content', 
      error: error.message 
    });
  }
});

// Delete content
app.delete('/api/content/:id', async (req, res) => {
  try {
    const content = await Content.findByIdAndDelete(req.params.id);

    if (!content) {
      return res.status(404).json({ 
        success: false, 
        message: 'Content not found' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Content deleted successfully',
      deletedContent: content.title
    });
  } catch (error) {
    console.error('Error deleting content:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting content', 
      error: error.message 
    });
  }
});

// ===================================
// SEASON & EPISODE MANAGEMENT
// ===================================

// Add season to series
app.post('/api/series/:id/seasons', async (req, res) => {
  try {
    const { seasonNumber, title, description, thumbnail, episodes } = req.body;

    const series = await Content.findById(req.params.id);
    if (!series || series.type !== 'series') {
      return res.status(404).json({ 
        success: false, 
        message: 'Series not found' 
      });
    }

    const newSeason = {
      seasonNumber,
      title,
      description: description || '',
      thumbnail: thumbnail || '',
      episodes: episodes || [],
      episodeCount: episodes ? episodes.length : 0
    };

    series.seasons.push(newSeason);
    series.totalSeasons = series.seasons.length;
    
    // Recalculate total episodes
    let totalEpisodes = 0;
    series.seasons.forEach(season => {
      totalEpisodes += season.episodes.length;
    });
    series.totalEpisodes = totalEpisodes;
    
    await series.save();

    res.status(201).json({ 
      success: true, 
      message: 'Season added successfully', 
      data: sanitizeContent(series, true)
    });
  } catch (error) {
    console.error('Error adding season:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding season', 
      error: error.message 
    });
  }
});

// Add episode to season
app.post('/api/series/:seriesId/seasons/:seasonNumber/episodes', async (req, res) => {
  try {
    const { episodeNumber, title, description, thumbnail, streamUrl, duration } = req.body;

    if (!streamUrl) {
      return res.status(400).json({ 
        success: false, 
        message: 'Stream URL is required for episodes' 
      });
    }

    const series = await Content.findById(req.params.seriesId);
    if (!series || series.type !== 'series') {
      return res.status(404).json({ 
        success: false, 
        message: 'Series not found' 
      });
    }

    const season = series.seasons.find(s => s.seasonNumber === parseInt(req.params.seasonNumber));
    if (!season) {
      return res.status(404).json({ 
        success: false, 
        message: 'Season not found' 
      });
    }

    const newEpisode = {
      episodeNumber,
      title,
      description: description || '',
      thumbnail: thumbnail || '',
      streamUrl,
      duration: duration || ''
    };

    season.episodes.push(newEpisode);
    season.episodeCount = season.episodes.length;
    
    // Recalculate total episodes
    let totalEpisodes = 0;
    series.seasons.forEach(s => {
      totalEpisodes += s.episodes.length;
    });
    series.totalEpisodes = totalEpisodes;
    
    await series.save();

    res.status(201).json({ 
      success: true, 
      message: 'Episode added successfully', 
      data: sanitizeContent(series, true)
    });
  } catch (error) {
    console.error('Error adding episode:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding episode', 
      error: error.message 
    });
  }
});

// Get episodes for a specific season
app.get('/api/series/:seriesId/seasons/:seasonNumber/episodes', async (req, res) => {
  try {
    const series = await Content.findById(req.params.seriesId);
    if (!series || series.type !== 'series') {
      return res.status(404).json({ 
        success: false, 
        message: 'Series not found' 
      });
    }

    const season = series.seasons.find(s => s.seasonNumber === parseInt(req.params.seasonNumber));
    if (!season) {
      return res.status(404).json({ 
        success: false, 
        message: 'Season not found' 
      });
    }

    res.json({ 
      success: true, 
      data: {
        seriesTitle: series.title,
        seasonNumber: season.seasonNumber,
        seasonTitle: season.title,
        episodes: season.episodes
      }
    });
  } catch (error) {
    console.error('Error fetching episodes:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching episodes', 
      error: error.message 
    });
  }
});

// ===================================
// STATISTICS & METADATA
// ===================================

app.get('/api/stats', async (req, res) => {
  try {
    const totalContent = await Content.countDocuments();
    const totalMovies = await Content.countDocuments({ type: 'movie' });
    const totalSeries = await Content.countDocuments({ type: 'series' });
    const featuredContent = await Content.countDocuments({ isFeatured: true });
    const categories = await Content.distinct('category');
    const genres = await Content.distinct('genre');

    // Get series episode stats
    const seriesList = await Content.find({ type: 'series' });
    let totalSeasons = 0;
    let totalEpisodes = 0;
    seriesList.forEach(series => {
      totalSeasons += series.totalSeasons || 0;
      totalEpisodes += series.totalEpisodes || 0;
    });

    res.json({
      success: true,
      data: {
        totalContent,
        totalMovies,
        totalSeries,
        featuredContent,
        totalSeasons,
        totalEpisodes,
        totalCategories: categories.length,
        totalGenres: genres.length,
        categories: categories.sort(),
        genres: genres.sort()
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

app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Content.distinct('category');
    res.json({ 
      success: true, 
      count: categories.length,
      data: categories.sort() 
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching categories', 
      error: error.message 
    });
  }
});

app.get('/api/genres', async (req, res) => {
  try {
    const genres = await Content.distinct('genre');
    res.json({ 
      success: true, 
      count: genres.length,
      data: genres.sort() 
    });
  } catch (error) {
    console.error('Error fetching genres:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching genres', 
      error: error.message 
    });
  }
});

// ===================================
// BULK OPERATIONS
// ===================================

app.post('/api/content/bulk', async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Items array is required' 
      });
    }

    const results = { 
      added: 0, 
      updated: 0,
      errors: 0, 
      total: items.length,
      details: []
    };

    for (const item of items) {
      try {
        // Validate required fields
        if (!item.title) {
          results.errors++;
          results.details.push({ 
            status: 'error', 
            title: item.title || 'Unknown',
            error: 'Title is required' 
          });
          continue;
        }

        if (item.type === 'movie' && !item.streamUrl) {
          results.errors++;
          results.details.push({ 
            status: 'error', 
            title: item.title,
            error: 'Stream URL is required for movies' 
          });
          continue;
        }

        // Calculate totals for series
        if (item.type === 'series' && item.seasons) {
          let totalEpisodes = 0;
          item.seasons.forEach(season => {
            if (season.episodes) {
              season.episodeCount = season.episodes.length;
              totalEpisodes += season.episodes.length;
            }
          });
          item.totalSeasons = item.seasons.length;
          item.totalEpisodes = totalEpisodes;
        }

        // Try to find existing content by title
        const existing = await Content.findOne({ 
          title: item.title,
          type: item.type 
        });
        
        if (existing) {
          await Content.findByIdAndUpdate(existing._id, {
            ...item,
            updatedAt: Date.now()
          });
          results.updated++;
          results.details.push({ 
            status: 'updated', 
            title: item.title,
            type: item.type 
          });
        } else {
          const content = new Content(item);
          await content.save();
          results.added++;
          results.details.push({ 
            status: 'added', 
            title: item.title,
            type: item.type 
          });
        }
      } catch (error) {
        console.error(`Error processing ${item.title}:`, error);
        results.errors++;
        results.details.push({ 
          status: 'error', 
          title: item.title,
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
// PLAYLIST MANAGEMENT
// ===================================

app.get('/api/playlists', async (req, res) => {
  try {
    const playlists = await ContentPlaylist.find().sort({ createdAt: -1 });
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

app.post('/api/playlists', async (req, res) => {
  try {
    const { name, url, type, autoSync } = req.body;

    if (!name || !url) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name and URL are required' 
      });
    }

    const playlist = new ContentPlaylist({
      name,
      url,
      type: type || 'mixed',
      autoSync: autoSync !== undefined ? autoSync : true
    });

    await playlist.save();

    res.status(201).json({ 
      success: true, 
      message: 'Playlist added successfully', 
      data: playlist
    });
  } catch (error) {
    console.error('Error adding playlist:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding playlist', 
      error: error.message 
    });
  }
});

// ===================================
// SEARCH & FILTER
// ===================================

app.get('/api/search', async (req, res) => {
  try {
    const { q, type, genre, year, rating } = req.query;
    
    let query = {};
    
    if (q) {
      query.$or = [
        { title: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { cast: { $regex: q, $options: 'i' } }
      ];
    }
    
    if (type) query.type = type;
    if (genre) query.genre = genre;
    if (year) query.year = parseInt(year);
    if (rating) query.rating = rating;

    const results = await Content.find(query).limit(50);

    res.json({ 
      success: true, 
      count: results.length,
      data: results.map(c => sanitizeContent(c, false))
    });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error searching content', 
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
// SERVER START
// ===================================

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     🎬 MOVIES & TV SERIES MANAGER API v1.0            ║
╚════════════════════════════════════════════════════════╝

🚀 Server Status: RUNNING
📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Base URL: http://localhost:${PORT}

📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}

✨ FEATURES:
   • Movies with streaming URLs
   • TV Series with seasons & episodes
   • Thumbnails & banner images
   • Advanced metadata (cast, genre, ratings)
   • Bulk import support
   • Search & filter capabilities

🎯 MAIN ENDPOINTS:

   MOVIES:
   ├─ POST   /api/movies              Add movie
   ├─ GET    /api/content?type=movie  List movies
   
   SERIES:
   ├─ POST   /api/series              Add series
   ├─ GET    /api/content?type=series List series
   ├─ POST   /api/series/:id/seasons  Add season
   └─ POST   /api/series/:id/seasons/:num/episodes  Add episode
   
   GENERAL:
   ├─ GET    /api/content             List all content
   ├─ GET    /api/content/:id         Get single item
   ├─ PUT    /api/content/:id         Update content
   ├─ DELETE /api/content/:id         Delete content
   ├─ POST   /api/content/bulk        Bulk import
   ├─ GET    /api/search              Search content
   ├─ GET    /api/stats               Statistics
   ├─ GET    /api/categories          List categories
   └─ GET    /api/genres              List genres

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
