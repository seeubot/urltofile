const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Health check state
let isHealthy = false;
let dbConnected = false;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/movie?retryWrites=true&w=majority&appName=movie';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
.then(() => {
    console.log('✅ MongoDB Connected Successfully');
    dbConnected = true;
    isHealthy = true;
})
.catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.log('📌 Using MongoDB URI:', MONGODB_URI.replace(/:[^:]*@/, ':****@'));
    dbConnected = false;
    // Allow app to be healthy even if DB fails initially (will retry)
    isHealthy = true;
});

// Monitor MongoDB connection
mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB Disconnected');
    dbConnected = false;
});

mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB Reconnected');
    dbConnected = true;
});

mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB Error:', err.message);
    dbConnected = false;
});

// Channel Schema
const channelSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    url: {
        type: String,
        required: true,
        trim: true
    },
    category: {
        type: String,
        enum: ['Movie', 'TV', 'Sports', 'News', 'Entertainment', 'Other'],
        default: 'Other'
    },
    quality: {
        type: String,
        enum: ['SD', 'HD', 'FHD', '4K'],
        default: 'HD'
    },
    language: {
        type: String,
        default: 'English'
    },
    country: {
        type: String,
        default: 'International'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    lastTested: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

const Channel = mongoose.model('Channel', channelSchema);

// Health Check Endpoints (Koyeb compatible)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: dbConnected ? 'connected' : 'disconnected',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        message: 'Application is running'
    });
});

app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/ready', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            await mongoose.connection.db.admin().ping();
            res.status(200).json({ 
                ready: true,
                database: 'ready'
            });
        } else {
            res.status(200).json({ 
                ready: true,
                database: 'connecting',
                message: 'Application is ready, database connecting'
            });
        }
    } catch (error) {
        res.status(200).json({ 
            ready: true,
            database: 'unavailable',
            message: 'Application is ready, database unavailable'
        });
    }
});

app.get('/live', (req, res) => {
    res.status(200).json({ 
        alive: true,
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (require('fs').existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(200).json({
            message: 'Channel Manager API',
            status: 'running',
            database: dbConnected ? 'connected' : 'disconnected',
            endpoints: {
                health: '/health',
                channels: '/api/channels',
                stats: '/api/stats'
            },
            deployment: 'https://static-crane-seeutech-17dd4df3.koyeb.app'
        });
    }
});

// API Routes

// Get all channels
app.get('/api/channels', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(200).json({ 
                message: 'Database connecting, please try again',
                channels: []
            });
        }
        const channels = await Channel.find().sort({ createdAt: -1 });
        res.json(channels);
    } catch (error) {
        console.error('Error fetching channels:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single channel
app.get('/api/channels/:id', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const channel = await Channel.findById(req.params.id);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        res.json(channel);
    } catch (error) {
        console.error('Error fetching channel:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create new channel
app.post('/api/channels', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const channel = new Channel(req.body);
        await channel.save();
        res.status(201).json(channel);
    } catch (error) {
        console.error('Error creating channel:', error);
        res.status(400).json({ error: error.message });
    }
});

// Update channel
app.put('/api/channels/:id', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        req.body.updatedAt = Date.now();
        const channel = await Channel.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        res.json(channel);
    } catch (error) {
        console.error('Error updating channel:', error);
        res.status(400).json({ error: error.message });
    }
});

// Delete channel
app.delete('/api/channels/:id', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const channel = await Channel.findByIdAndDelete(req.params.id);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        res.json({ message: 'Channel deleted successfully' });
    } catch (error) {
        console.error('Error deleting channel:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test URL endpoint
app.post('/api/channels/:id/test', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        const channel = await Channel.findByIdAndUpdate(
            req.params.id,
            { lastTested: Date.now() },
            { new: true }
        );
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        res.json({ message: 'URL test recorded', lastTested: channel.lastTested });
    } catch (error) {
        console.error('Error testing channel:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get dashboard stats
app.get('/api/stats', async (req, res) => {
    try {
        if (!dbConnected) {
            return res.status(200).json({
                totalChannels: 0,
                activeChannels: 0,
                inactiveChannels: 0,
                categories: [],
                qualities: [],
                message: 'Database connecting'
            });
        }
        const totalChannels = await Channel.countDocuments();
        const activeChannels = await Channel.countDocuments({ isActive: true });
        const categories = await Channel.aggregate([
            { $group: { _id: '$category', count: { $sum: 1 } } }
        ]);
        const qualities = await Channel.aggregate([
            { $group: { _id: '$quality', count: { $sum: 1 } } }
        ]);

        res.json({
            totalChannels,
            activeChannels,
            inactiveChannels: totalChannels - activeChannels,
            categories,
            qualities
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    server.close(async () => {
        console.log('✅ HTTP server closed');
        
        try {
            await mongoose.connection.close();
            console.log('✅ MongoDB connection closed');
            process.exit(0);
        } catch (err) {
            console.error('❌ Error during shutdown:', err);
            process.exit(1);
        }
    });
    
    setTimeout(() => {
        console.error('⚠️  Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    // Don't exit immediately in production
    console.error('Continuing to run...');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit immediately in production
    console.error('Continuing to run...');
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Deployment URL: https://static-crane-seeutech-17dd4df3.koyeb.app`);
    console.log(`📊 API: https://static-crane-seeutech-17dd4df3.koyeb.app/api/channels`);
    console.log(`💚 Health: https://static-crane-seeutech-17dd4df3.koyeb.app/health`);
    console.log(`🔍 Ready: https://static-crane-seeutech-17dd4df3.koyeb.app/ready`);
    console.log(`❤️  Live: https://static-crane-seeutech-17dd4df3.koyeb.app/live`);
});
