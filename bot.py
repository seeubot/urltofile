import os
import json
import re
from datetime import datetime
from aiohttp import web
import aiohttp_cors
import logging

# Configuration
PORT = int(os.getenv('PORT', 8000))
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'admin123')
DATA_FILE = 'channels.json'

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# In-memory storage (will be replaced with persistent storage)
channels_data = {
    'channels': [],
    'categories': set(['sports', 'entertainment', 'news', 'movies'])
}

def load_channels():
    """Load channels from JSON file"""
    global channels_data
    try:
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, 'r') as f:
                data = json.load(f)
                channels_data['channels'] = data.get('channels', [])
                channels_data['categories'] = set(data.get('categories', ['sports']))
            logger.info(f"✅ Loaded {len(channels_data['channels'])} channels")
    except Exception as e:
        logger.error(f"Error loading channels: {e}")

def save_channels():
    """Save channels to JSON file"""
    try:
        with open(DATA_FILE, 'w') as f:
            json.dump({
                'channels': channels_data['channels'],
                'categories': list(channels_data['categories'])
            }, f, indent=2)
        logger.info(f"💾 Saved {len(channels_data['channels'])} channels")
    except Exception as e:
        logger.error(f"Error saving channels: {e}")

def parse_m3u(content):
    """Parse M3U playlist content"""
    channels = []
    lines = content.strip().split('\n')
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        if line.startswith('#EXTINF:'):
            # Parse channel info
            channel = {}
            
            # Extract logo
            logo_match = re.search(r'tvg-logo="([^"]+)"', line)
            if logo_match:
                channel['logo'] = logo_match.group(1)
            
            # Extract category
            category_match = re.search(r'group-title="([^"]+)"', line)
            if category_match:
                channel['category'] = category_match.group(1)
                channels_data['categories'].add(category_match.group(1))
            
            # Extract title (after last comma)
            title_match = re.search(r',(.+)$', line)
            if title_match:
                channel['title'] = title_match.group(1).strip()
            
            # Get URL from next line
            if i + 1 < len(lines):
                url_line = lines[i + 1].strip()
                if url_line and not url_line.startswith('#'):
                    channel['url'] = url_line
                    channel['type'] = 'm3u8' if '.m3u8' in url_line else 'mpd' if '.mpd' in url_line else 'direct'
                    channel['id'] = len(channels_data['channels']) + len(channels) + 1
                    channel['created_at'] = datetime.now().isoformat()
                    channels.append(channel)
                    i += 1
        
        i += 1
    
    return channels

# ============= API HANDLERS =============

async def health_check(request):
    """Health check endpoint"""
    return web.json_response({
        'status': 'ok',
        'channels': len(channels_data['channels']),
        'categories': len(channels_data['categories'])
    })

async def get_channels(request):
    """Get all channels or filter by category"""
    try:
        category = request.query.get('category')
        search = request.query.get('search', '').lower()
        
        filtered_channels = channels_data['channels']
        
        if category:
            filtered_channels = [c for c in filtered_channels if c.get('category') == category]
        
        if search:
            filtered_channels = [
                c for c in filtered_channels 
                if search in c.get('title', '').lower()
            ]
        
        return web.json_response({
            'success': True,
            'channels': filtered_channels,
            'total': len(filtered_channels)
        })
    except Exception as e:
        logger.error(f"Error getting channels: {e}")
        return web.json_response({'success': False, 'error': str(e)}, status=500)

async def get_categories(request):
    """Get all categories"""
    return web.json_response({
        'success': True,
        'categories': sorted(list(channels_data['categories']))
    })

async def get_channel(request):
    """Get single channel by ID"""
    try:
        channel_id = int(request.match_info['id'])
        channel = next((c for c in channels_data['channels'] if c['id'] == channel_id), None)
        
        if channel:
            return web.json_response({'success': True, 'channel': channel})
        else:
            return web.json_response({'success': False, 'error': 'Channel not found'}, status=404)
    except Exception as e:
        return web.json_response({'success': False, 'error': str(e)}, status=500)

# ============= ADMIN API HANDLERS =============

def verify_admin(request):
    """Verify admin authentication"""
    auth = request.headers.get('Authorization', '')
    return auth == f'Bearer {ADMIN_PASSWORD}'

async def admin_login(request):
    """Admin login"""
    try:
        data = await request.json()
        password = data.get('password')
        
        if password == ADMIN_PASSWORD:
            return web.json_response({
                'success': True,
                'token': ADMIN_PASSWORD
            })
        else:
            return web.json_response({'success': False, 'error': 'Invalid password'}, status=401)
    except Exception as e:
        return web.json_response({'success': False, 'error': str(e)}, status=500)

async def add_channel(request):
    """Add new channel"""
    if not verify_admin(request):
        return web.json_response({'success': False, 'error': 'Unauthorized'}, status=401)
    
    try:
        data = await request.json()
        
        channel = {
            'id': len(channels_data['channels']) + 1,
            'title': data['title'],
            'url': data['url'],
            'logo': data.get('logo', ''),
            'category': data.get('category', 'uncategorized'),
            'type': data.get('type', 'm3u8'),
            'drm_key': data.get('drm_key'),
            'created_at': datetime.now().isoformat()
        }
        
        channels_data['channels'].append(channel)
        channels_data['categories'].add(channel['category'])
        save_channels()
        
        return web.json_response({'success': True, 'channel': channel})
    except Exception as e:
        logger.error(f"Error adding channel: {e}")
        return web.json_response({'success': False, 'error': str(e)}, status=500)

async def update_channel(request):
    """Update existing channel"""
    if not verify_admin(request):
        return web.json_response({'success': False, 'error': 'Unauthorized'}, status=401)
    
    try:
        channel_id = int(request.match_info['id'])
        data = await request.json()
        
        channel = next((c for c in channels_data['channels'] if c['id'] == channel_id), None)
        if not channel:
            return web.json_response({'success': False, 'error': 'Channel not found'}, status=404)
        
        # Update fields
        channel.update({
            'title': data.get('title', channel['title']),
            'url': data.get('url', channel['url']),
            'logo': data.get('logo', channel.get('logo', '')),
            'category': data.get('category', channel.get('category', 'uncategorized')),
            'type': data.get('type', channel.get('type', 'm3u8')),
            'drm_key': data.get('drm_key', channel.get('drm_key')),
            'updated_at': datetime.now().isoformat()
        })
        
        channels_data['categories'].add(channel['category'])
        save_channels()
        
        return web.json_response({'success': True, 'channel': channel})
    except Exception as e:
        return web.json_response({'success': False, 'error': str(e)}, status=500)

async def delete_channel(request):
    """Delete channel"""
    if not verify_admin(request):
        return web.json_response({'success': False, 'error': 'Unauthorized'}, status=401)
    
    try:
        channel_id = int(request.match_info['id'])
        channels_data['channels'] = [c for c in channels_data['channels'] if c['id'] != channel_id]
        save_channels()
        
        return web.json_response({'success': True})
    except Exception as e:
        return web.json_response({'success': False, 'error': str(e)}, status=500)

async def import_m3u(request):
    """Import channels from M3U playlist"""
    if not verify_admin(request):
        return web.json_response({'success': False, 'error': 'Unauthorized'}, status=401)
    
    try:
        data = await request.json()
        m3u_content = data.get('content', '')
        
        if not m3u_content:
            return web.json_response({'success': False, 'error': 'No content provided'}, status=400)
        
        new_channels = parse_m3u(m3u_content)
        channels_data['channels'].extend(new_channels)
        save_channels()
        
        return web.json_response({
            'success': True,
            'imported': len(new_channels),
            'total': len(channels_data['channels'])
        })
    except Exception as e:
        logger.error(f"Error importing M3U: {e}")
        return web.json_response({'success': False, 'error': str(e)}, status=500)

# ============= APPLICATION SETUP =============

async def init_app():
    """Initialize the application"""
    load_channels()
    
    app = web.Application()
    
    # Configure CORS
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
            allow_methods="*"
        )
    })
    
    # Public routes
    app.router.add_get('/health', health_check)
    app.router.add_get('/api/channels', get_channels)
    app.router.add_get('/api/channels/{id}', get_channel)
    app.router.add_get('/api/categories', get_categories)
    
    # Admin routes
    app.router.add_post('/api/admin/login', admin_login)
    app.router.add_post('/api/admin/channels', add_channel)
    app.router.add_put('/api/admin/channels/{id}', update_channel)
    app.router.add_delete('/api/admin/channels/{id}', delete_channel)
    app.router.add_post('/api/admin/import', import_m3u)
    
    # Configure CORS for all routes
    for route in list(app.router.routes()):
        cors.add(route)
    
    return app

def main():
    logger.info("🚀 IPTV Streaming Platform starting...")
    logger.info(f"📡 Server will run on port {PORT}")
    
    app = init_app()
    web.run_app(app, host='0.0.0.0', port=PORT)

if __name__ == '__main__':
    main()
