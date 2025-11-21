import os
import re
import asyncio
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from pymongo import MongoClient
import yt_dlp
import requests
from urllib.parse import urlparse
import math
import aiohttp

# Configuration from environment variables
BOT_TOKEN = os.getenv('BOT_TOKEN', '7545348868:AAGKlDigB-trWf2lgpz5CLFFsMZvK2VXPLs')
MONGO_URI = os.getenv('MONGO_URI', 'mongodb+srv://room:room@room.4vris.mongodb.net/?appName=room')
TEMP_DIR = os.getenv('TEMP_DIR', 'temp_downloads')

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
        return db['downloads']
    except Exception as e:
        logger.warning(f"❌ MongoDB connection failed: {e}")
        return None

downloads_collection = setup_mongodb()

def extract_streaming_url(url):
    """Extract streaming URL using yt-dlp"""
    ydl_opts = {
        'format': 'best[filesize<500M]',  # Limit to files under 500MB
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'extract_flat': False,
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            # Get the best quality URL
            if 'url' in info:
                streaming_url = info['url']
            elif 'formats' in info:
                # Prefer progressive formats (video+audio)
                progressive_formats = [f for f in info['formats'] if f.get('acodec') != 'none' and f.get('vcodec') != 'none']
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
                'duration': info.get('duration', 0)
            }
    except Exception as e:
        logger.error(f"Error extracting URL {url}: {e}")
        return None

async def download_file_async(url, filename, max_size_mb=500):
    """Download file from URL with size limit using aiohttp"""
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
                        
                        # Check size during download
                        if downloaded > max_size_bytes:
                            os.remove(filepath)
                            return None
                
                return filepath
    except Exception as e:
        logger.error(f"Error downloading file: {e}")
        return None

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
    welcome_message = (
        "👋 Welcome to Stream Downloader Bot!\n\n"
        "Send me a video URL and I'll:\n"
        "1. Extract the streaming URL\n"
        "2. Download the video\n"
        "3. Send it to you (split into parts if needed)\n\n"
        "Supported platforms: YouTube, Twitter, Instagram, Facebook, and many more!\n\n"
        "Just send me a URL to get started!"
    )
    await update.message.reply_text(welcome_message)

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
    except Exception:
        await update.message.reply_text("❌ Invalid URL format.")
        return
    
    # Send processing message
    status_msg = await update.message.reply_text("🔍 Processing your URL...")
    
    try:
        # Extract streaming URL
        await status_msg.edit_text("🔗 Extracting streaming URL...")
        info = extract_streaming_url(url)
        
        if not info:
            await status_msg.edit_text("❌ Could not extract streaming URL. Make sure:\n• The URL is valid\n• The video is publicly accessible\n• The platform is supported")
            return
        
        # Check if MongoDB is available and log
        if downloads_collection:
            downloads_collection.insert_one({
                'user_id': user_id,
                'original_url': url,
                'title': info['title'],
                'filesize': info.get('filesize', 0),
                'timestamp': asyncio.get_event_loop().time()
            })
        
        # Download file
        await status_msg.edit_text(f"⬇️ Downloading: {info['title']}...")
        filename = f"{info['title']}.{info['ext']}"
        # Sanitize filename
        filename = re.sub(r'[<>:\"/\\|?*]', '_', filename)[:100]  # Limit filename length
        
        filepath = await download_file_async(info['url'], filename, max_size_mb=500)
        
        if not filepath:
            await status_msg.edit_text("❌ Failed to download the file. It might be too large or unavailable.")
            return
        
        file_size = os.path.getsize(filepath)
        
        # Check if file needs to be split
        if file_size > MAX_FILE_SIZE:
            await status_msg.edit_text(f"📦 File is large ({file_size / (1024*1024):.2f} MB). Splitting into parts...")
            chunks = split_file(filepath)
            
            if not chunks:
                await status_msg.edit_text("❌ Failed to split the file.")
                if os.path.exists(filepath):
                    os.remove(filepath)
                return
            
            await status_msg.edit_text(f"📤 Sending {len(chunks)} parts...")
            
            success_count = 0
            for i, chunk_path in enumerate(chunks, 1):
                try:
                    with open(chunk_path, 'rb') as f:
                        await update.message.reply_document(
                            document=f,
                            filename=f"{info['title']}_part{i}.{info['ext']}",
                            caption=f"Part {i}/{len(chunks)} - {info['title']}"
                        )
                    success_count += 1
                except Exception as e:
                    logger.error(f"Error sending part {i}: {e}")
                finally:
                    if os.path.exists(chunk_path):
                        os.remove(chunk_path)
            
            if success_count == len(chunks):
                await status_msg.edit_text(f"✅ Sent {len(chunks)} parts successfully!")
            else:
                await status_msg.edit_text(f"⚠️ Sent {success_count}/{len(chunks)} parts. Some parts failed to send.")
        else:
            await status_msg.edit_text("📤 Sending file...")
            
            try:
                with open(filepath, 'rb') as f:
                    await update.message.reply_document(
                        document=f,
                        filename=f"{info['title']}.{info['ext']}",
                        caption=info['title']
                    )
                await status_msg.edit_text("✅ File sent successfully!")
            except Exception as e:
                await status_msg.edit_text(f"❌ Failed to send file: {str(e)}")
        
        # Cleanup
        if os.path.exists(filepath):
            os.remove(filepath)
            
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {str(e)}")
        logger.error(f"Error processing URL {url}: {e}")

async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show user statistics"""
    user_id = update.message.from_user.id
    
    if downloads_collection:
        count = downloads_collection.count_documents({'user_id': user_id})
        await update.message.reply_text(f"📊 You've downloaded {count} videos using this bot!")
    else:
        await update.message.reply_text("📊 Statistics temporarily unavailable.")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command"""
    help_text = (
        "🤖 Stream Downloader Bot Help\n\n"
        "Commands:\n"
        "/start - Start the bot\n"
        "/stats - Show your download statistics\n"
        "/help - Show this help message\n\n"
        "How to use:\n"
        "1. Send any video URL from supported platforms\n"
        "2. The bot will download and send you the video\n"
        "3. Large files will be automatically split into parts\n\n"
        "Supported platforms include:\n"
        "• YouTube\n• Twitter/X\n• Instagram\n• Facebook\n• TikTok\n• Many more!"
    )
    await update.message.reply_text(help_text)

async def health_check(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Health check command"""
    status = "✅ Bot is healthy!"
    if not downloads_collection:
        status += "\n⚠️ MongoDB connection unavailable"
    await update.message.reply_text(status)

def cleanup_temp_files():
    """Clean up temporary files on startup"""
    try:
        for filename in os.listdir(TEMP_DIR):
            filepath = os.path.join(TEMP_DIR, filename)
            if os.path.isfile(filepath):
                os.remove(filepath)
        logger.info("🧹 Cleaned up temporary files")
    except Exception as e:
        logger.error(f"Error cleaning temp files: {e}")

def main():
    """Start the bot"""
    # Cleanup on startup
    cleanup_temp_files()
    
    # Create application
    application = Application.builder().token(BOT_TOKEN).build()
    
    # Add handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("stats", stats))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("health", health_check))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_url))
    
    # Start bot
    logger.info("🤖 Bot started successfully!")
    
    try:
        application.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)
    except Exception as e:
        logger.error(f"Bot stopped with error: {e}")

if __name__ == '__main__':
    main()
