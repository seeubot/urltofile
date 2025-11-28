import os
import re
import asyncio
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import (
    Application, CommandHandler, MessageHandler, 
    filters, ContextTypes, CallbackQueryHandler
)
import yt_dlp
from urllib.parse import urlparse
import math
import aiohttp
from aiohttp import web

# Configuration
BOT_TOKEN = os.getenv('BOT_TOKEN', '8370816170:AAEDqSZLLPXpCBSCfK0Y1hrJfK0JNl1ag0Y')
BOT_USERNAME = os.getenv('BOT_USERNAME', 'myworkdbot')
TEMP_DIR = os.getenv('TEMP_DIR', 'temp_downloads')
WEBHOOK_URL = os.getenv('WEBHOOK_URL', 'https://strict-mariam-seeutech-94fe58af.koyeb.app')
PORT = int(os.getenv('PORT', 8000))
USE_WEBHOOK = os.getenv('USE_WEBHOOK', 'true').lower() == 'true'

# Telegram file size limits
MAX_FILE_SIZE = 50 * 1024 * 1024
CHUNK_SIZE = 45 * 1024 * 1024

# Admin Configuration
ADMIN_ID = 1352497419

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

os.makedirs(TEMP_DIR, exist_ok=True)

# In-memory storage (resets on restart)
download_counts = {}
current_stream_url = "https://cdn.jsdelivr.net/gh/Dmitriy-I/cdn-media/big-buck-bunny/trailer.mp4"

# ============= DOWNLOAD BOT FUNCTIONS =============

def increment_download(user_id):
    download_counts[user_id] = download_counts.get(user_id, 0) + 1

def get_download_count(user_id):
    return download_counts.get(user_id, 0)

def extract_streaming_url_method1(url):
    ydl_opts = {
        'format': 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'nocheckcertificate': True,
        'merge_output_format': 'mp4',
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if 'url' in info:
                streaming_url = info['url']
            elif 'formats' in info:
                progressive = [f for f in info['formats'] 
                              if f.get('acodec') != 'none' and f.get('vcodec') != 'none' 
                              and f.get('ext') == 'mp4']
                if progressive:
                    streaming_url = progressive[-1]['url']
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
                'width': info.get('width', 0),
                'height': info.get('height', 0),
                'thumbnail': info.get('thumbnail'),
                'method': 'method1'
            }
    except Exception as e:
        logger.error(f"Method 1 failed: {e}")
        return None

def extract_streaming_url_method2(url):
    ydl_opts = {
        'format': 'best[ext=mp4][filesize<500M]/best[filesize<500M]',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'nocheckcertificate': True,
        'merge_output_format': 'mp4',
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            streaming_url = info.get('url') or (info['formats'][-1]['url'] if info.get('formats') else None)
            if not streaming_url:
                return None
            return {
                'url': streaming_url,
                'title': info.get('title', 'video'),
                'ext': 'mp4',
                'filesize': info.get('filesize', 0),
                'duration': info.get('duration', 0),
                'width': info.get('width', 0),
                'height': info.get('height', 0),
                'thumbnail': info.get('thumbnail'),
                'method': 'method2'
            }
    except Exception as e:
        logger.error(f"Method 2 failed: {e}")
        return None

def extract_streaming_url_method3(url):
    ydl_opts = {
        'format': 'worst[ext=mp4]/worst',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 30,
        'nocheckcertificate': True,
        'merge_output_format': 'mp4',
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if 'url' in info:
                return {
                    'url': info['url'],
                    'title': info.get('title', 'video'),
                    'ext': 'mp4',
                    'filesize': info.get('filesize', 0),
                    'duration': info.get('duration', 0),
                    'width': info.get('width', 0),
                    'height': info.get('height', 0),
                    'thumbnail': info.get('thumbnail'),
                    'method': 'method3'
                }
    except Exception as e:
        logger.error(f"Method 3 failed: {e}")
    return None

def extract_streaming_url(url):
    for method in [extract_streaming_url_method1, extract_streaming_url_method2, extract_streaming_url_method3]:
        result = method(url)
        if result:
            logger.info(f"Extracted using {result['method']}")
            return result
    return None

async def download_thumbnail(url, filename):
    if not url:
        return None
    try:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                if response.status == 200:
                    thumb_path = os.path.join(TEMP_DIR, f"thumb_{filename}.jpg")
                    with open(thumb_path, 'wb') as f:
                        f.write(await response.read())
                    return thumb_path
    except Exception as e:
        logger.error(f"Thumbnail download error: {e}")
    return None

async def download_file_async(url, filename, max_size_mb=500):
    try:
        timeout = aiohttp.ClientTimeout(total=300)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                if response.status != 200:
                    return None
                file_size = int(response.headers.get('content-length', 0))
                max_bytes = max_size_mb * 1024 * 1024
                if file_size > max_bytes:
                    return None
                filepath = os.path.join(TEMP_DIR, filename)
                downloaded = 0
                with open(filepath, 'wb') as f:
                    async for chunk in response.content.iter_chunked(8192):
                        f.write(chunk)
                        downloaded += len(chunk)
                        if downloaded > max_bytes:
                            os.remove(filepath)
                            return None
                return filepath
    except Exception as e:
        logger.error(f"Download error: {e}")
        return None

async def convert_to_mp4(filepath):
    try:
        import subprocess
        if subprocess.run(['which', 'ffmpeg'], capture_output=True).returncode != 0:
            return filepath
        
        file_ext = os.path.splitext(filepath)[1].lower()
        if file_ext == '.mp4':
            return filepath
        
        output = filepath.rsplit('.', 1)[0] + '.mp4'
        cmd = [
            'ffmpeg', '-i', filepath,
            '-c:v', 'libx264', '-c:a', 'aac',
            '-preset', 'fast', '-crf', '23',
            '-movflags', '+faststart',
            '-y', output
        ]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        await proc.communicate()
        
        if proc.returncode == 0 and os.path.exists(output):
            os.remove(filepath)
            return output
        return filepath
    except Exception as e:
        logger.error(f"Conversion error: {e}")
        return filepath

async def generate_clip(filepath, duration=5):
    try:
        import subprocess
        if subprocess.run(['which', 'ffmpeg'], capture_output=True).returncode != 0:
            logger.warning("ffmpeg not available for clip generation")
            return None
        
        probe_cmd = [
            'ffprobe', '-v', 'error', '-show_entries', 
            'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filepath
        ]
        proc = await asyncio.create_subprocess_exec(
            *probe_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        
        try:
            video_duration = float(stdout.decode().strip())
        except (ValueError, AttributeError):
            video_duration = 30
        
        start_time = max(0, (video_duration - duration) / 2)
        name = os.path.splitext(filepath)[0]
        clip_path = f"{name}_clip.mp4"
        
        cmd = [
            'ffmpeg', '-ss', str(start_time), '-i', filepath,
            '-t', str(duration), '-c:v', 'libx264', '-c:a', 'aac',
            '-preset', 'ultrafast', '-crf', '28',
            '-movflags', '+faststart',
            '-y', clip_path
        ]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        await proc.communicate()
        
        if proc.returncode == 0 and os.path.exists(clip_path):
            return clip_path
        return None
    except Exception as e:
        logger.error(f"Clip generation error: {e}")
        return None

def split_file(filepath, chunk_size=CHUNK_SIZE):
    try:
        file_size = os.path.getsize(filepath)
        num_chunks = math.ceil(file_size / chunk_size)
        chunks = []
        name = os.path.splitext(os.path.basename(filepath))[0]
        with open(filepath, 'rb') as f:
            for i in range(num_chunks):
                chunk_path = os.path.join(TEMP_DIR, f"{name}_part{i+1:03d}.mp4")
                with open(chunk_path, 'wb') as cf:
                    remaining = chunk_size
                    while remaining > 0:
                        data = f.read(min(8192, remaining))
                        if not data:
                            break
                        cf.write(data)
                        remaining -= len(data)
                chunks.append(chunk_path)
        return chunks
    except Exception as e:
        logger.error(f"Split error: {e}")
        return []

# ============= COMMAND HANDLERS =============

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    
    if user_id == ADMIN_ID:
        admin_message = (
            "👑 **Admin Panel**\n"
            "Use `/setstream <url>` to change the live stream URL.\n\n"
        )
    else:
        admin_message = ""
    
    keyboard = [
        [InlineKeyboardButton("📺 Watch Live Stream", callback_data='watch_stream_btn')],
        [InlineKeyboardButton("📥 Download Video", callback_data='download_mode')],
        [InlineKeyboardButton("📊 My Statistics", callback_data='show_stats')],
        [InlineKeyboardButton("ℹ️ Help", callback_data='show_help')]
    ]
    
    await update.message.reply_text(
        f"👋 Welcome to the **All-in-One Video Bot**!\n\n"
        f"{admin_message}"
        f"🎬 **Two Modes Available:**\n"
        f"1️⃣ **Live Stream Mode** - Watch admin-controlled stream\n"
        f"2️⃣ **Download Mode** - Download from 1000+ platforms\n\n"
        f"Choose your mode below!",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode='Markdown'
    )

async def set_stream(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    if user_id != ADMIN_ID:
        await update.message.reply_text("❌ Access denied. Only the administrator can change the stream URL.")
        return

    if not context.args:
        await update.message.reply_text("Please provide a valid streaming URL. Usage: `/setstream <url>`")
        return
        
    global current_stream_url
    new_url = context.args[0].strip()
    
    try:
        result = urlparse(new_url)
        if not all([result.scheme, result.netloc]):
            await update.message.reply_text("❌ Invalid URL provided. Please include scheme (http/https).")
            return
    except Exception:
        await update.message.reply_text("❌ Invalid URL format.")
        return

    current_stream_url = new_url
    logger.info(f"Stream URL updated to: {current_stream_url}")
    await update.message.reply_text(
        f"✅ Live Stream URL updated successfully!\n"
        f"New URL: `{current_stream_url}`",
        parse_mode='Markdown'
    )

async def watch_stream(update: Update, context: ContextTypes.DEFAULT_TYPE):
    kb = [
        [KeyboardButton("📺 Launch Video Player", web_app=WebAppInfo(url=f"{WEBHOOK_URL}/index.html"))]
    ]
    
    reply_target = update.message if update.message else update.callback_query.message
    
    await reply_target.reply_text(
        "🎬 Click the button below to open the full-screen video player and watch the live stream!",
        reply_markup=ReplyKeyboardMarkup(kb, resize_keyboard=True, one_time_keyboard=True)
    )

async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = update.message.text.strip()
    user_id = update.message.from_user.id
    
    try:
        result = urlparse(url)
        if not all([result.scheme, result.netloc]):
            await update.message.reply_text("❌ Invalid URL.")
            return
    except Exception:
        await update.message.reply_text("❌ Invalid URL format.")
        return
    
    status_msg = await update.message.reply_text("🔍 Processing your video...")
    clip_path = None
    filepath = None
    thumb_path = None
    
    try:
        await status_msg.edit_text("🔗 Extracting video info...")
        info = extract_streaming_url(url)
        if not info:
            await status_msg.edit_text("❌ Could not extract video. Check if the URL is accessible.")
            return
        
        increment_download(user_id)
        
        await status_msg.edit_text(f"⬇️ Downloading: {info['title'][:50]}...")
        filename = re.sub(r'[<>:\"/\\|?*]', '_', f"{info['title']}.mp4")[:100]
        
        if info.get('thumbnail'):
            await status_msg.edit_text(f"📸 Downloading thumbnail...")
            thumb_path = await download_thumbnail(info['thumbnail'], filename)
        
        filepath = await download_file_async(info['url'], filename, 500)
        
        if not filepath:
            await status_msg.edit_text("❌ Download failed. File may be too large or unavailable.")
            return
        
        await status_msg.edit_text("🔄 Converting to MP4...")
        filepath = await convert_to_mp4(filepath)
        
        if info.get('duration', 0) > 5:
            try:
                await status_msg.edit_text("✂️ Generating 5-second preview...")
                clip_path = await generate_clip(filepath, duration=5)
            except Exception as e:
                logger.error(f"Clip generation failed: {e}")
        
        file_size = os.path.getsize(filepath)
        
        if clip_path and os.path.exists(clip_path):
            try:
                await status_msg.edit_text("📤 Sending 5-second preview...")
                with open(clip_path, 'rb') as f:
                    await update.message.reply_video(
                        video=f,
                        caption=f"🎬 5-sec Preview: {info['title'][:50]}",
                        duration=5,
                        width=info.get('width', 0),
                        height=info.get('height', 0),
                        thumbnail=open(thumb_path, 'rb') if thumb_path and os.path.exists(thumb_path) else None,
                        supports_streaming=True,
                        filename=f"clip_{filename}"
                    )
            except Exception as e:
                logger.error(f"Clip send error: {e}")
        
        if file_size > MAX_FILE_SIZE:
            await status_msg.edit_text(f"📦 Splitting large file ({file_size/(1024*1024):.1f}MB)...")
            chunks = split_file(filepath)
            if not chunks:
                await status_msg.edit_text("❌ Failed to split file.")
                return
            
            await status_msg.edit_text(f"📤 Sending {len(chunks)} parts...")
            for i, chunk in enumerate(chunks, 1):
                try:
                    with open(chunk, 'rb') as f:
                        await update.message.reply_video(
                            video=f,
                            caption=f"Part {i}/{len(chunks)}",
                            supports_streaming=True,
                            filename=f"part{i}_{filename}"
                        )
                except Exception as e:
                    logger.error(f"Send part {i} error: {e}")
                finally:
                    if os.path.exists(chunk):
                        os.remove(chunk)
            await status_msg.edit_text(f"✅ Sent {len(chunks)} parts!")
        else:
            await status_msg.edit_text("📤 Sending full video...")
            try:
                with open(filepath, 'rb') as f:
                    await update.message.reply_video(
                        video=f,
                        caption=f"🎥 {info['title'][:100]}",
                        duration=int(info.get('duration', 0)),
                        width=info.get('width', 0),
                        height=info.get('height', 0),
                        thumbnail=open(thumb_path, 'rb') if thumb_path and os.path.exists(thumb_path) else None,
                        supports_streaming=True,
                        filename=filename
                    )
                await status_msg.edit_text("✅ Video sent successfully!")
            except Exception as e:
                await status_msg.edit_text(f"❌ Send failed: {e}")
                logger.error(f"Send video error: {e}")
        
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {e}")
        logger.error(f"URL processing error: {e}")
    finally:
        if filepath and os.path.exists(filepath):
            os.remove(filepath)
        if thumb_path and os.path.exists(thumb_path):
            os.remove(thumb_path)
        if clip_path and os.path.exists(clip_path):
            os.remove(clip_path)

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    try:
        await query.answer()
    except Exception as e:
        logger.warning(f"Failed to answer callback: {e}")
    
    if query.data == 'watch_stream_btn':
        await watch_stream(update, context)
        
    elif query.data == 'download_mode':
        text = (
            "📥 **Download Mode**\n\n"
            "Simply send me any video URL and I'll download it for you!\n\n"
            "✅ Supports 1000+ platforms:\n"
            "• YouTube, Instagram, TikTok\n"
            "• Facebook, Twitter, Reddit\n"
            "• And many more!\n\n"
            "**Features:**\n"
            "🎬 Direct playback in Telegram\n"
            "✂️ Auto 5-second preview clips\n"
            "📦 Auto-splits large files\n"
            "🖼️ High-quality thumbnails\n\n"
            "Just paste a video URL to start!"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'show_stats':
        user_id = query.from_user.id
        count = get_download_count(user_id)
        text = f"📊 **Your Statistics**\n\nVideos downloaded: {count}"
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'show_help':
        text = (
            "🤖 **Bot Help**\n\n"
            "**Live Stream Mode:**\n"
            "• Click 'Watch Live Stream'\n"
            "• Launch the video player\n"
            "• Enjoy the admin-controlled stream\n\n"
            "**Download Mode:**\n"
            "• Click 'Download Video' for info\n"
            "• Send any video URL\n"
            "• Receive preview + full video\n\n"
            "**Commands:**\n"
            "`/start` - Main menu\n"
            "`/watch` - Launch stream player\n"
            "`/help` - Show this help\n"
            "`/setstream <url>` - (Admin only)\n\n"
            "**Admin:** Only user ID `1352497419` can set the stream URL."
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'back_to_main':
        user_id = query.from_user.id
        if user_id == ADMIN_ID:
            admin_message = (
                "👑 **Admin Panel**\n"
                "Use `/setstream <url>` to change the live stream URL.\n\n"
            )
        else:
            admin_message = ""
            
        keyboard = [
            [InlineKeyboardButton("📺 Watch Live Stream", callback_data='watch_stream_btn')],
            [InlineKeyboardButton("📥 Download Video", callback_data='download_mode')],
            [InlineKeyboardButton("📊 My Statistics", callback_data='show_stats')],
            [InlineKeyboardButton("ℹ️ Help", callback_data='show_help')]
        ]
        await query.edit_message_text(
            f"👋 Welcome back!\n\n{admin_message}Choose your mode:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='Markdown'
        )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🤖 **All-in-One Video Bot**\n\n"
        "**Two Modes:**\n"
        "1️⃣ Live Stream - Watch controlled stream\n"
        "2️⃣ Download - Get videos from any platform\n\n"
        "**Commands:**\n"
        "`/start` - Main menu\n"
        "`/watch` - Launch stream player\n"
        "`/help` - Show help\n"
        "`/setstream <url>` - Set stream (Admin)\n\n"
        "Send any video URL to download it!",
        parse_mode='Markdown'
    )

async def fallback_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    
    # Check if it looks like a URL
    try:
        result = urlparse(text)
        if result.scheme and result.netloc:
            # It's a URL, process as download
            await handle_url(update, context)
            return
    except:
        pass
    
    # Not a URL, show help
    await update.message.reply_text(
        "👋 Send me a video URL to download it, or use /start to see all options!"
    )

def cleanup_temp_files():
    try:
        for f in os.listdir(TEMP_DIR):
            path = os.path.join(TEMP_DIR, f)
            if os.path.isfile(path):
                os.remove(path)
        logger.info("🧹 Cleaned temp files")
    except Exception as e:
        logger.error(f"Cleanup error: {e}")

# ============= WEB SERVER HANDLERS =============

async def get_stream_handler(request):
    global current_stream_url
    return web.json_response({'streamUrl': current_stream_url})

async def serve_html(request):
    html_path = os.path.join(os.path.dirname(__file__), 'index.html')
    if os.path.exists(html_path):
        with open(html_path, 'r') as f:
            return web.Response(text=f.read(), content_type='text/html')
    return web.Response(text="Web interface not found", status=404)

# ============= APPLICATION SETUP =============

def setup_application():
    app = Application.builder().token(BOT_TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("setstream", set_stream))
    app.add_handler(CommandHandler("watch", watch_stream))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, fallback_message))
    
    return app

async def run_webhook():
    app = setup_application()
    webhook_path = f"/{BOT_TOKEN}"
    full_webhook_url = f"{WEBHOOK_URL}{webhook_path}"
    
    logger.info(f"🚀 Starting webhook on port {PORT}")
    logger.info(f"📡 Webhook URL: {full_webhook_url}")
    
    await app.initialize()
    await app.bot.set_webhook(url=full_webhook_url, allowed_updates=Update.ALL_TYPES)
    await app.start()
    
    async def handle_webhook(request):
        try:
            data = await request.json()
            update = Update.de_json(data, app.bot)
            await app.process_update(update)
            return web.Response(text="ok")
        except Exception as e:
            logger.error(f"Webhook error: {e}")
            return web.Response(text="error", status=500)
    
    async def health_check(request):
        return web.Response(text="OK")
    
    webapp = web.Application()
    webapp.router.add_post(webhook_path, handle_webhook)
    webapp.router.add_get("/health", health_check)
    webapp.router.add_get("/get_stream", get_stream_handler)
    webapp.router.add_get("/", serve_html)
    webapp.router.add_get("/index.html", serve_html)
    
    runner = web.AppRunner(webapp)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', PORT)
    await site.start()
    
    logger.info(f"✅ Webhook server running on port {PORT}")
    logger.info(f"🌐 Web interface available at {WEBHOOK_URL}")
    
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        await app.stop()
        await app.shutdown()
        await runner.cleanup()

def main():
    cleanup_temp_files()
    logger.info("🤖 Combined Bot starting...")
    
    if USE_WEBHOOK and WEBHOOK_URL:
        logger.info("🚀 Webhook mode")
        asyncio.run(run_webhook())
    else:
        logger.info("✅ Polling mode")
        app = setup_application()
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)

if __name__ == '__main__':
    main()
