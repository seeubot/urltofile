import os
import re
import asyncio
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler, 
    filters, ContextTypes, CallbackQueryHandler
)
from pymongo import MongoClient
import yt_dlp
import requests
from urllib.parse import urlparse
import math
import aiohttp
import threading

# Try to import Flask for webhook support (optional)
try:
    from flask import Flask, request
    FLASK_AVAILABLE = True
except ImportError:
    FLASK_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("Flask not installed. Webhook mode will not be available.")

# Configuration from environment variables
BOT_TOKEN = os.getenv('BOT_TOKEN', '7545348868:AAGKlDigB-trWf2lgpz5CLFFsMZvK2VXPLs')
MONGO_URI = os.getenv('MONGO_URI', 'mongodb+srv://naya:naya@cluster0.spxgavf.mongodb.net/?appName=Cluster0')
TEMP_DIR = os.getenv('TEMP_DIR', 'temp_downloads')
WEBHOOK_URL = os.getenv('WEBHOOK_URL', '')  # Set this to your Koyeb URL
PORT = int(os.getenv('PORT', 8000))
USE_WEBHOOK = os.getenv('USE_WEBHOOK', 'false').lower() == 'true'

# Telegram file size limits (in bytes)
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB for bots
CHUNK_SIZE = 45 * 1024 * 1024  # 45 MB chunks to be safe

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Ensure temp directory exists
os.makedirs(TEMP_DIR, exist_ok=True)

# Flask app for webhook
flask_app = Flask(__name__)

# MongoDB setup with error handling
def setup_mongodb():
    """Setup MongoDB connection with fallback"""
    try:
        client = MongoClient(
            MONGO_URI,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            socketTimeoutMS=5000,
            retryWrites=True,
            retryReads=True
        )
        client.admin.command('ping')
        db = client['telegram_bot']
        logger.info("✅ Connected to MongoDB")
        return db
    except Exception as e:
        logger.warning(f"❌ MongoDB connection failed: {e}")
        return None

db = setup_mongodb()
downloads_collection = db['downloads'] if db is not None else None
settings_collection = db['settings'] if db is not None else None
allowed_sites_collection = db['allowed_sites'] if db is not None else None

# Default allowed sites
DEFAULT_ALLOWED_SITES = [
    'youtube.com', 'youtu.be', 'twitter.com', 'x.com',
    'instagram.com', 'facebook.com', 'tiktok.com', 'reddit.com',
    'vimeo.com', 'dailymotion.com', 'twitch.tv'
]

def get_user_settings(user_id):
    """Get user settings from database"""
    if settings_collection is None:
        return {'watermark': ''}
    
    settings = settings_collection.find_one({'user_id': user_id})
    if settings is None:
        return {'watermark': ''}
    return settings

def update_user_watermark(user_id, watermark):
    """Update user's watermark setting"""
    if settings_collection is None:
        return False
    
    settings_collection.update_one(
        {'user_id': user_id},
        {'$set': {'watermark': watermark}},
        upsert=True
    )
    return True

def get_allowed_sites(user_id):
    """Get user's allowed sites or default"""
    if allowed_sites_collection is None:
        return DEFAULT_ALLOWED_SITES
    
    doc = allowed_sites_collection.find_one({'user_id': user_id})
    if doc is None:
        return DEFAULT_ALLOWED_SITES
    return doc.get('sites', DEFAULT_ALLOWED_SITES)

def add_allowed_site(user_id, site):
    """Add a site to user's allowed list"""
    if allowed_sites_collection is None:
        return False
    
    allowed_sites_collection.update_one(
        {'user_id': user_id},
        {'$addToSet': {'sites': site.lower()}},
        upsert=True
    )
    return True

def remove_allowed_site(user_id, site):
    """Remove a site from user's allowed list"""
    if allowed_sites_collection is None:
        return False
    
    allowed_sites_collection.update_one(
        {'user_id': user_id},
        {'$pull': {'sites': site.lower()}}
    )
    return True

def extract_streaming_url_method1(url):
    """Primary extraction method using yt-dlp with best quality"""
    ydl_opts = {
        'format': 'best[filesize<500M]/bestvideo[filesize<500M]+bestaudio/best',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'extract_flat': False,
        'nocheckcertificate': True,
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            if 'url' in info:
                streaming_url = info['url']
            elif 'formats' in info:
                progressive_formats = [f for f in info['formats'] 
                                     if f.get('acodec') != 'none' and f.get('vcodec') != 'none']
                if progressive_formats:
                    streaming_url = progressive_formats[-1]['url']
                else:
                    streaming_url = info['formats'][-1]['url']
            else:
                return None
            
            return {
                'url': streaming_url,
                'title': info.get('title', 'video'),
                'ext': info.get('ext', 'mp4'),
                'filesize': info.get('filesize', 0),
                'duration': info.get('duration', 0),
                'method': 'method1'
            }
    except Exception as e:
        logger.error(f"Method 1 failed for {url}: {e}")
        return None

def extract_streaming_url_method2(url):
    """Secondary extraction method with different format preference"""
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'extract_flat': False,
        'nocheckcertificate': True,
        'prefer_free_formats': True,
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            streaming_url = None
            if 'requested_formats' in info:
                # Merged format
                streaming_url = info['url']
            elif 'url' in info:
                streaming_url = info['url']
            elif 'formats' in info and info['formats']:
                streaming_url = info['formats'][-1]['url']
            
            if not streaming_url:
                return None
            
            return {
                'url': streaming_url,
                'title': info.get('title', 'video'),
                'ext': info.get('ext', 'mp4'),
                'filesize': info.get('filesize', 0),
                'duration': info.get('duration', 0),
                'method': 'method2'
            }
    except Exception as e:
        logger.error(f"Method 2 failed for {url}: {e}")
        return None

def extract_streaming_url_method3(url):
    """Third extraction method with mobile format preference"""
    ydl_opts = {
        'format': 'worst[ext=mp4]/worst',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'extract_flat': False,
        'nocheckcertificate': True,
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            if 'url' in info:
                return {
                    'url': info['url'],
                    'title': info.get('title', 'video'),
                    'ext': info.get('ext', 'mp4'),
                    'filesize': info.get('filesize', 0),
                    'duration': info.get('duration', 0),
                    'method': 'method3'
                }
    except Exception as e:
        logger.error(f"Method 3 failed for {url}: {e}")
        return None

def extract_streaming_url(url):
    """Try multiple extraction methods"""
    methods = [
        extract_streaming_url_method1,
        extract_streaming_url_method2,
        extract_streaming_url_method3
    ]
    
    for method in methods:
        result = method(url)
        if result:
            logger.info(f"Successfully extracted using {result['method']}")
            return result
    
    return None

async def download_file_async(url, filename, max_size_mb=500, watermark=''):
    """Download file from URL with size limit and optional watermark"""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as session:
            async with session.get(url) as response:
                if response.status != 200:
                    return None
                
                file_size = int(response.headers.get('content-length', 0))
                max_size_bytes = max_size_mb * 1024 * 1024
                
                if file_size > max_size_bytes:
                    logger.warning(f"File too large: {file_size} bytes")
                    return None
                
                filepath = os.path.join(TEMP_DIR, filename)
                downloaded = 0
                
                with open(filepath, 'wb') as f:
                    async for chunk in response.content.iter_chunked(8192):
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        if downloaded > max_size_bytes:
                            os.remove(filepath)
                            return None
                
                # Add watermark if specified and ffmpeg is available
                if watermark:
                    try:
                        watermarked_path = await add_watermark(filepath, watermark)
                        if watermarked_path:
                            return watermarked_path
                    except Exception as e:
                        logger.error(f"Watermark failed: {e}")
                
                return filepath
    except Exception as e:
        logger.error(f"Error downloading file: {e}")
        return None

async def add_watermark(filepath, watermark_text):
    """Add watermark to video using ffmpeg"""
    try:
        output_path = filepath.replace('.mp4', '_watermarked.mp4')
        
        # Check if ffmpeg is available
        import subprocess
        result = subprocess.run(['which', 'ffmpeg'], capture_output=True)
        if result.returncode != 0:
            logger.warning("ffmpeg not available, skipping watermark")
            return filepath
        
        # Add watermark using ffmpeg
        cmd = [
            'ffmpeg', '-i', filepath,
            '-vf', f"drawtext=text='{watermark_text}':fontcolor=white:fontsize=24:x=10:y=H-th-10",
            '-codec:a', 'copy',
            output_path
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        await process.communicate()
        
        if process.returncode == 0 and os.path.exists(output_path):
            os.remove(filepath)
            return output_path
        
        return filepath
    except Exception as e:
        logger.error(f"Error adding watermark: {e}")
        return filepath

def split_file(filepath, chunk_size=CHUNK_SIZE):
    """Split large file into chunks"""
    try:
        file_size = os.path.getsize(filepath)
        num_chunks = math.ceil(file_size / chunk_size)
        
        chunks = []
        base_name = os.path.basename(filepath)
        name, ext = os.path.splitext(base_name)
        
        with open(filepath, 'rb') as f:
            for i in range(num_chunks):
                chunk_filename = f"{name}_part{i+1:03d}{ext}"
                chunk_filepath = os.path.join(TEMP_DIR, chunk_filename)
                
                with open(chunk_filepath, 'wb') as chunk_file:
                    remaining = chunk_size
                    while remaining > 0:
                        data = f.read(min(8192, remaining))
                        if not data:
                            break
                        chunk_file.write(data)
                        remaining -= len(data)
                
                chunks.append(chunk_filepath)
        
        return chunks
    except Exception as e:
        logger.error(f"Error splitting file: {e}")
        return []

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command"""
    keyboard = [
        [InlineKeyboardButton("⚙️ Settings", callback_data='settings')],
        [InlineKeyboardButton("🌐 Manage Sites", callback_data='manage_sites')],
        [InlineKeyboardButton("📊 Statistics", callback_data='show_stats')]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    welcome_message = (
        "👋 Welcome to Stream Downloader Bot!\n\n"
        "Send me a video URL and I'll:\n"
        "1. Extract the streaming URL (multiple methods)\n"
        "2. Download the video\n"
        "3. Send it to you (split into parts if needed)\n\n"
        "Use the buttons below to configure the bot!"
    )
    await update.message.reply_text(welcome_message, reply_markup=reply_markup)

async def settings_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show settings menu"""
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    settings = get_user_settings(user_id)
    
    current_watermark = settings.get('watermark', 'None')
    
    keyboard = [
        [InlineKeyboardButton("💧 Set Watermark", callback_data='set_watermark')],
        [InlineKeyboardButton("🗑️ Clear Watermark", callback_data='clear_watermark')],
        [InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    text = f"⚙️ **Settings**\n\nCurrent Watermark: `{current_watermark}`"
    await query.edit_message_text(text, reply_markup=reply_markup, parse_mode='Markdown')

async def manage_sites_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show site management menu"""
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    sites = get_allowed_sites(user_id)
    
    keyboard = [
        [InlineKeyboardButton("➕ Add Site", callback_data='add_site')],
        [InlineKeyboardButton("➖ Remove Site", callback_data='remove_site')],
        [InlineKeyboardButton("📋 View Sites", callback_data='view_sites')],
        [InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    text = f"🌐 **Site Management**\n\nYou have {len(sites)} allowed sites."
    await query.edit_message_text(text, reply_markup=reply_markup, parse_mode='Markdown')

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle button callbacks"""
    query = update.callback_query
    await query.answer()
    
    if query.data == 'settings':
        await settings_menu(update, context)
    
    elif query.data == 'manage_sites':
        await manage_sites_menu(update, context)
    
    elif query.data == 'show_stats':
        user_id = query.from_user.id
        if downloads_collection is not None:
            count = downloads_collection.count_documents({'user_id': user_id})
            text = f"📊 You've downloaded {count} videos!"
        else:
            text = "📊 Statistics temporarily unavailable."
        
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
    
    elif query.data == 'set_watermark':
        await query.edit_message_text(
            "💧 Send me the watermark text you want to add to videos.\n"
            "Example: @YourChannel or Your Name\n\n"
            "Note: ffmpeg must be installed for watermarks to work."
        )
        context.user_data['awaiting_watermark'] = True
    
    elif query.data == 'clear_watermark':
        user_id = query.from_user.id
        update_user_watermark(user_id, '')
        await query.edit_message_text("✅ Watermark cleared!")
        await asyncio.sleep(2)
        await settings_menu(update, context)
    
    elif query.data == 'add_site':
        await query.edit_message_text(
            "➕ Send me the domain of the site you want to add.\n"
            "Example: example.com"
        )
        context.user_data['awaiting_site_add'] = True
    
    elif query.data == 'remove_site':
        await query.edit_message_text(
            "➖ Send me the domain you want to remove.\n"
            "Example: example.com"
        )
        context.user_data['awaiting_site_remove'] = True
    
    elif query.data == 'view_sites':
        user_id = query.from_user.id
        sites = get_allowed_sites(user_id)
        sites_text = '\n• '.join(sites)
        
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='manage_sites')]]
        await query.edit_message_text(
            f"📋 **Allowed Sites:**\n\n• {sites_text}",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='Markdown'
        )
    
    elif query.data == 'back_to_main':
        keyboard = [
            [InlineKeyboardButton("⚙️ Settings", callback_data='settings')],
            [InlineKeyboardButton("🌐 Manage Sites", callback_data='manage_sites')],
            [InlineKeyboardButton("📊 Statistics", callback_data='show_stats')]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.edit_message_text(
            "👋 Use the buttons below to configure the bot!",
            reply_markup=reply_markup
        )

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages"""
    text = update.message.text.strip()
    user_id = update.message.from_user.id
    
    # Check if awaiting watermark
    if context.user_data.get('awaiting_watermark'):
        update_user_watermark(user_id, text)
        await update.message.reply_text(f"✅ Watermark set to: {text}")
        context.user_data['awaiting_watermark'] = False
        return
    
    # Check if awaiting site addition
    if context.user_data.get('awaiting_site_add'):
        domain = text.lower().replace('http://', '').replace('https://', '').split('/')[0]
        add_allowed_site(user_id, domain)
        await update.message.reply_text(f"✅ Added {domain} to allowed sites!")
        context.user_data['awaiting_site_add'] = False
        return
    
    # Check if awaiting site removal
    if context.user_data.get('awaiting_site_remove'):
        domain = text.lower().replace('http://', '').replace('https://', '').split('/')[0]
        remove_allowed_site(user_id, domain)
        await update.message.reply_text(f"✅ Removed {domain} from allowed sites!")
        context.user_data['awaiting_site_remove'] = False
        return
    
    # Otherwise treat as URL
    await handle_url(update, context)

async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle URL messages"""
    url = update.message.text.strip()
    user_id = update.message.from_user.id
    
    # Validate URL
    try:
        result = urlparse(url)
        if not all([result.scheme, result.netloc]):
            await update.message.reply_text("❌ Invalid URL. Please send a valid video URL.")
            return
        
        # Check if site is allowed
        allowed_sites = get_allowed_sites(user_id)
        domain = result.netloc.lower().replace('www.', '')
        
        if not any(site in domain for site in allowed_sites):
            await update.message.reply_text(
                f"❌ Site '{domain}' is not in your allowed list.\n"
                "Use /start → Manage Sites to add it."
            )
            return
            
    except Exception:
        await update.message.reply_text("❌ Invalid URL format.")
        return
    
    status_msg = await update.message.reply_text("🔍 Processing your URL...")
    
    try:
        await status_msg.edit_text("🔗 Extracting streaming URL (trying multiple methods)...")
        info = extract_streaming_url(url)
        
        if not info:
            await status_msg.edit_text(
                "❌ Could not extract streaming URL using any method.\n"
                "Make sure:\n• The URL is valid\n• The video is publicly accessible\n• The platform is supported"
            )
            return
        
        if downloads_collection is not None:
            downloads_collection.insert_one({
                'user_id': user_id,
                'original_url': url,
                'title': info['title'],
                'filesize': info.get('filesize', 0),
                'timestamp': asyncio.get_event_loop().time(),
                'extraction_method': info.get('method', 'unknown')
            })
        
        await status_msg.edit_text(f"⬇️ Downloading: {info['title']}...")
        
        settings = get_user_settings(user_id)
        watermark = settings.get('watermark', '')
        
        filename = f"{info['title']}.{info['ext']}"
        filename = re.sub(r'[<>:\"/\\|?*]', '_', filename)[:100]
        
        filepath = await download_file_async(info['url'], filename, max_size_mb=500, watermark=watermark)
        
        if not filepath:
            await status_msg.edit_text("❌ Failed to download the file. It might be too large or unavailable.")
            return
        
        file_size = os.path.getsize(filepath)
        
        if file_size > MAX_FILE_SIZE:
            await status_msg.edit_text(f"📦 File is large ({file_size / (1024*1024):.2f} MB). Splitting...")
            chunks = split_file(filepath)
            
            if not chunks:
                await status_msg.edit_text("❌ Failed to split the file.")
                if os.path.exists(filepath):
                    os.remove(filepath)
                return
            
            await status_msg.edit_text(f"📤 Sending {len(chunks)} parts...")
            
            for i, chunk_path in enumerate(chunks, 1):
                try:
                    with open(chunk_path, 'rb') as f:
                        await update.message.reply_document(
                            document=f,
                            filename=f"{info['title']}_part{i}.{info['ext']}",
                            caption=f"Part {i}/{len(chunks)} - {info['title']}"
                        )
                except Exception as e:
                    logger.error(f"Error sending part {i}: {e}")
                finally:
                    if os.path.exists(chunk_path):
                        os.remove(chunk_path)
            
            await status_msg.edit_text(f"✅ Sent {len(chunks)} parts!")
        else:
            await status_msg.edit_text("📤 Sending file...")
            
            try:
                with open(filepath, 'rb') as f:
                    caption = info['title']
                    if watermark:
                        caption += f"\n\n{watermark}"
                    
                    await update.message.reply_document(
                        document=f,
                        filename=f"{info['title']}.{info['ext']}",
                        caption=caption
                    )
                await status_msg.edit_text("✅ File sent successfully!")
            except Exception as e:
                await status_msg.edit_text(f"❌ Failed to send file: {str(e)}")
        
        if os.path.exists(filepath):
            os.remove(filepath)
            
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {str(e)}")
        logger.error(f"Error processing URL {url}: {e}")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command"""
    help_text = (
        "🤖 **Stream Downloader Bot Help**\n\n"
        "**Commands:**\n"
        "/start - Start the bot and access menu\n"
        "/help - Show this help message\n\n"
        "**Features:**\n"
        "• Multiple extraction methods\n"
        "• Custom watermarks\n"
        "• Site whitelist management\n"
        "• Automatic file splitting\n"
        "• Download statistics\n\n"
        "Just send a video URL to get started!"
    )
    await update.message.reply_text(help_text, parse_mode='Markdown')

def cleanup_temp_files():
    """Clean up temporary files"""
    try:
        for filename in os.listdir(TEMP_DIR):
            filepath = os.path.join(TEMP_DIR, filename)
            if os.path.isfile(filepath):
                os.remove(filepath)
        logger.info("🧹 Cleaned up temporary files")
    except Exception as e:
        logger.error(f"Error cleaning temp files: {e}")

# Webhook handling
@flask_app.route(f'/{BOT_TOKEN}', methods=['POST'])
def webhook():
    """Handle webhook updates"""
    update = Update.de_json(request.get_json(force=True), application.bot)
    asyncio.run(application.process_update(update))
    return 'ok'

@flask_app.route('/')
def index():
    return 'Bot is running!'

def run_flask():
    """Run Flask app"""
    flask_app.run(host='0.0.0.0', port=PORT)

# Global application variable
application = None

def main():
    """Start the bot"""
    global application
    
    cleanup_temp_files()
    
    application = Application.builder().token(BOT_TOKEN).build()
    
    # Add handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CallbackQueryHandler(button_handler))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    
    logger.info("🤖 Bot started successfully!")
    
    if USE_WEBHOOK and WEBHOOK_URL:
        # Set webhook
        webhook_url = f"{WEBHOOK_URL}/{BOT_TOKEN}"
        asyncio.run(application.bot.set_webhook(webhook_url))
        logger.info(f"✅ Webhook set to {webhook_url}")
        
        # Start Flask in a separate thread
        flask_thread = threading.Thread(target=run_flask, daemon=True)
        flask_thread.start()
        logger.info(f"✅ Flask server started on port {PORT}")
        
        # Keep the main thread alive
        import time
        while True:
            time.sleep(1)
    else:
        # Use polling
        logger.info("✅ Using polling mode")
        application.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)

if __name__ == '__main__':
    main()
