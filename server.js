const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/movie?retryWrites=true&w=majority&appName=movie';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected Successfully'))
.catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.log('📌 Using MongoDB URI:', MONGODB_URI.replace(/:[^:]*@/, ':****@'));
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

// API Routes

// Get all channels
app.get('/api/channels', async (req, res) => {
    try {
        const channels = await Channel.find().sort({ createdAt: -1 });
        res.json(channels);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single channel
app.get('/api/channels/:id', async (req, res) => {
    try {
        const channel = await Channel.findById(req.params.id);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        res.json(channel);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create new channel
app.post('/api/channels', async (req, res) => {
    try {
        const channel = new Channel(req.body);
        await channel.save();
        res.status(201).json(channel);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Update channel
app.put('/api/channels/:id', async (req, res) => {
    try {
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
        res.status(400).json({ error: error.message });
    }
});

// Delete channel
app.delete('/api/channels/:id', async (req, res) => {
    try {
        const channel = await Channel.findByIdAndDelete(req.params.id);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        res.json({ message: 'Channel deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test URL endpoint
app.post('/api/channels/:id/test', async (req, res) => {
    try {
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
        res.status(500).json({ error: error.message });
    }
});

// Get dashboard stats
app.get('/api/stats', async (req, res) => {
    try {
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
        res.status(500).json({ error: error.message });
    }
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Dashboard available at: http://localhost:${PORT}`);
    console.log(`📊 API available at: http://localhost:${PORT}/api/channels`);
});
