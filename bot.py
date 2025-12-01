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
import aiohttp
from aiohttp import web

# Configuration
BOT_TOKEN = os.getenv('BOT_TOKEN', '8370816170:AAEDqSZLLPXpCBSCfK0Y1hrJfK0JNl1ag0Y')
BOT_USERNAME = os.getenv('BOT_USERNAME', 'myworkdbot')
TEMP_DIR = os.getenv('TEMP_DIR', 'temp_downloads')
WEBHOOK_URL = os.getenv('WEBHOOK_URL', 'https://strict-mariam-seeutech-94fe58af.koyeb.app')
PORT = int(os.getenv('PORT', 8000))
USE_WEBHOOK = os.getenv('USE_WEBHOOK', 'true').lower() == 'true'

# Admin Configuration
ADMIN_ID = 1352497419

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

os.makedirs(TEMP_DIR, exist_ok=True)

# In-memory storage
download_counts = {}
clip_counts = {}
current_stream_url = "https://cdn.jsdelivr.net/gh/Dmitriy-I/cdn-media/big-buck-bunny/trailer.mp4"

# ============= HELPER FUNCTIONS =============

def increment_download(user_id):
    download_counts[user_id] = download_counts.get(user_id, 0) + 1

def increment_clip(user_id):
    clip_counts[user_id] = clip_counts.get(user_id, 0) + 1

def get_download_count(user_id):
    return download_counts.get(user_id, 0)

def get_clip_count(user_id):
    return clip_counts.get(user_id, 0)

def extract_video_url(url):
    """Extract direct video URL using yt-dlp with mp4/mkv preference"""
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo[ext=mkv]+bestaudio/best[ext=mkv]/best',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 45,
        'nocheckcertificate': True,
        'merge_output_format': 'mp4',
        'geo_bypass': True,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return {
                'url': info.get('url') or info['formats'][-1]['url'],
                'title': info.get('title', 'video'),
                'ext': info.get('ext', 'mp4'),
                'duration': info.get('duration', 0),
                'thumbnail': info.get('thumbnail'),
            }
    except Exception as e:
        logger.error(f"Extraction failed: {e}")
        return None

async def download_file_async(url, filename, max_size_mb=500):
    """Download file with enhanced headers"""
    try:
        timeout = aiohttp.ClientTimeout(total=600, connect=60)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
        }
        
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            async with session.get(url, allow_redirects=True) as response:
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

async def generate_clips_from_file(filepath, num_clips=3, clip_duration=5):
    """Generate 3 preview clips from a video file (beginning, middle, end)"""
    try:
        import subprocess
        
        # Check if ffmpeg is available
        if subprocess.run(['which', 'ffmpeg'], capture_output=True).returncode != 0:
            logger.warning("ffmpeg not available")
            return []
        
        # Get video duration
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
            logger.error("Could not get video duration")
            return []
        
        # Check if video is long enough
        min_duration = clip_duration * 3 + 10  # At least 25 seconds
        if video_duration < min_duration:
            logger.warning(f"Video too short ({video_duration}s) for 3 clips")
            return []
        
        clips = []
        name = os.path.splitext(filepath)[0]
        
        # Calculate start times for clips
        # Beginning: 5 seconds in
        # Middle: center of video
        # End: 10 seconds before end
        start_times = [
            5,  # Beginning (skip first 5 seconds)
            max(10, (video_duration - clip_duration) / 2),  # Middle
            max(15, video_duration - clip_duration - 10)  # End (10s before end)
        ]
        
        clip_labels = ['Beginning', 'Middle', 'End']
        
        for i, (start_time, label) in enumerate(zip(start_times, clip_labels), 1):
            clip_path = f"{name}_clip{i}_{label.lower()}.mp4"
            
            cmd = [
                'ffmpeg', '-ss', str(start_time), '-i', filepath,
                '-t', str(clip_duration),
                '-c:v', 'libx264', '-c:a', 'aac',
                '-preset', 'ultrafast', '-crf', '28',
                '-vf', 'scale=iw*min(1280/iw\\,720/ih):ih*min(1280/iw\\,720/ih)',
                '-movflags', '+faststart',
                '-y', clip_path
            ]
            
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            await proc.communicate()
            
            if proc.returncode == 0 and os.path.exists(clip_path):
                clips.append((clip_path, label))
                logger.info(f"✅ Generated {label} clip ({i}/3)")
            else:
                logger.error(f"❌ Failed to generate {label} clip")
        
        return clips
    except Exception as e:
        logger.error(f"Clip generation error: {e}")
        return []

async def download_telegram_video(file, filename):
    """Download video file from Telegram"""
    try:
        filepath = os.path.join(TEMP_DIR, filename)
        telegram_file = await file.get_file()
        await telegram_file.download_to_drive(filepath)
        logger.info(f"✅ Downloaded Telegram video: {filename}")
        return filepath
    except Exception as e:
        logger.error(f"Telegram video download error: {e}")
        return None

# ============= COMMAND HANDLERS =============

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    
    if user_id == ADMIN_ID:
        admin_message = "👑 **Admin Panel**\nUse `/setstream <url>` to change the live stream URL.\n\n"
    else:
        admin_message = ""
    
    keyboard = [
        [InlineKeyboardButton("📺 Watch Live Stream", callback_data='watch_stream_btn')],
        [InlineKeyboardButton("📥 Download Video (URL)", callback_data='download_mode')],
        [InlineKeyboardButton("✂️ Generate Clips (File)", callback_data='clip_mode')],
        [InlineKeyboardButton("📊 My Statistics", callback_data='show_stats')],
        [InlineKeyboardButton("ℹ️ Help", callback_data='show_help')]
    ]
    
    await update.message.reply_text(
        f"👋 Welcome to the **All-in-One Video Bot**!\n\n"
        f"{admin_message}"
        f"🎬 **Three Modes Available:**\n"
        f"1️⃣ **Live Stream** - Watch admin-controlled stream\n"
        f"2️⃣ **Download** - Download MP4/MKV from URLs\n"
        f"3️⃣ **Clip Generator** - Send video file → Get 3 clips\n\n"
        f"✨ **Clip Generator Features:**\n"
        f"• Send any video file (MP4, MKV, etc.)\n"
        f"• Get 3 × 5-second clips\n"
        f"• From beginning, middle, and end\n\n"
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
            await update.message.reply_text("❌ Invalid URL provided.")
            return
    except Exception:
        await update.message.reply_text("❌ Invalid URL format.")
        return

    current_stream_url = new_url
    logger.info(f"Stream URL updated to: {current_stream_url}")
    await update.message.reply_text(
        f"✅ Live Stream URL updated!\n`{current_stream_url}`",
        parse_mode='Markdown'
    )

async def watch_stream(update: Update, context: ContextTypes.DEFAULT_TYPE):
    kb = [[KeyboardButton("📺 Launch Video Player", web_app=WebAppInfo(url=f"{WEBHOOK_URL}/index.html"))]]
    reply_target = update.message if update.message else update.callback_query.message
    await reply_target.reply_text(
        "🎬 Click the button below to watch the live stream!",
        reply_markup=ReplyKeyboardMarkup(kb, resize_keyboard=True, one_time_keyboard=True)
    )

async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle URL for downloading MP4/MKV videos"""
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
    
    status_msg = await update.message.reply_text("🔍 Extracting video info...")
    filepath = None
    
    try:
        info = extract_video_url(url)
        if not info:
            await status_msg.edit_text("❌ Could not extract video. Try a different URL.")
            return
        
        increment_download(user_id)
        
        await status_msg.edit_text(f"⬇️ Downloading: {info['title'][:50]}...")
        filename = re.sub(r'[<>:\"/\\|?*]', '_', f"{info['title']}.{info['ext']}")[:100]
        
        filepath = await download_file_async(info['url'], filename, 500)
        
        if not filepath:
            await status_msg.edit_text("❌ Download failed. File may be too large (>500MB) or unavailable.")
            return
        
        await status_msg.edit_text("📤 Sending video file...")
        
        with open(filepath, 'rb') as f:
            await update.message.reply_document(
                document=f,
                caption=f"🎥 {info['title'][:100]}\n📁 Format: {info['ext'].upper()}",
                filename=filename
            )
        
        await status_msg.edit_text("✅ Video sent successfully!")
        
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {str(e)[:100]}")
        logger.error(f"URL processing error: {e}")
    finally:
        if filepath and os.path.exists(filepath):
            os.remove(filepath)

async def handle_video_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle video file upload and generate 3 clips"""
    user_id = update.message.from_user.id
    video = update.message.video or update.message.document
    
    if not video:
        return
    
    # Check if it's a video file
    file_name = getattr(video, 'file_name', '')
    mime_type = getattr(video, 'mime_type', '')
    
    if not (mime_type and mime_type.startswith('video/')) and not any(file_name.lower().endswith(ext) for ext in ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv']):
        await update.message.reply_text("❌ Please send a valid video file.")
        return
    
    # Check file size (Telegram limit is 2GB for bots, but let's limit to 500MB for processing)
    file_size = video.file_size
    if file_size > 500 * 1024 * 1024:
        await update.message.reply_text("❌ File too large. Maximum size: 500MB")
        return
    
    status_msg = await update.message.reply_text("📥 Downloading your video...")
    filepath = None
    clips = []
    
    try:
        # Download the video file
        filename = file_name or f"video_{user_id}_{int(asyncio.get_event_loop().time())}.mp4"
        filepath = await download_telegram_video(video, filename)
        
        if not filepath:
            await status_msg.edit_text("❌ Failed to download video file.")
            return
        
        increment_clip(user_id)
        
        await status_msg.edit_text("✂️ Generating 3 preview clips (5 seconds each)...")
        clips = await generate_clips_from_file(filepath, num_clips=3, clip_duration=5)
        
        if not clips:
            await status_msg.edit_text("❌ Failed to generate clips. Video might be too short (<25s) or invalid format.")
            return
        
        await status_msg.edit_text(f"📤 Sending {len(clips)} clips...")
        
        # Send each clip
        for i, (clip_path, label) in enumerate(clips, 1):
            try:
                with open(clip_path, 'rb') as f:
                    await update.message.reply_video(
                        video=f,
                        caption=f"🎬 Clip {i}/3 - **{label}** (5 seconds)\n📄 From: {file_name[:50]}",
                        supports_streaming=True,
                        filename=f"clip_{i}_{label.lower()}.mp4",
                        parse_mode='Markdown'
                    )
            except Exception as e:
                logger.error(f"Failed to send clip {i}: {e}")
        
        await status_msg.edit_text(f"✅ Successfully generated and sent {len(clips)} clips!")
        
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {str(e)[:100]}")
        logger.error(f"Video processing error: {e}")
    finally:
        # Cleanup
        if filepath and os.path.exists(filepath):
            os.remove(filepath)
        for clip_path, _ in clips:
            if os.path.exists(clip_path):
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
            "📥 **Download Mode (MP4/MKV)**\n\n"
            "Send me any video URL and I'll download it as MP4 or MKV!\n\n"
            "✅ **Supported platforms:**\n"
            "• YouTube, Instagram, TikTok\n"
            "• Facebook, Twitter, Reddit\n"
            "• And 1000+ more sites\n\n"
            "**Features:**\n"
            "📹 Prefers MP4/MKV formats\n"
            "🎯 High quality downloads\n"
            "🔓 Bypass restrictions\n"
            "📦 Max size: 500MB\n\n"
            "Just paste a video URL!"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'clip_mode':
        text = (
            "✂️ **Clip Generator Mode**\n\n"
            "Send me a video file and I'll create 3 preview clips!\n\n"
            "**How it works:**\n"
            "1️⃣ Send any video file (MP4, MKV, etc.)\n"
            "2️⃣ Bot generates 3 × 5-second clips\n"
            "3️⃣ Receive clips from:\n"
            "   • Beginning (5s in)\n"
            "   • Middle (center)\n"
            "   • End (10s before end)\n\n"
            "**Requirements:**\n"
            "📹 Min duration: 25 seconds\n"
            "📦 Max file size: 500MB\n"
            "🎬 Formats: MP4, MKV, AVI, MOV, etc.\n\n"
            "Just send your video file!"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'show_stats':
        user_id = query.from_user.id
        downloads = get_download_count(user_id)
        clips = get_clip_count(user_id)
        text = (
            f"📊 **Your Statistics**\n\n"
            f"📥 Videos downloaded: {downloads}\n"
            f"✂️ Clip generations: {clips}"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'show_help':
        text = (
            "🤖 **Bot Help**\n\n"
            "**Live Stream Mode:**\n"
            "• Click 'Watch Live Stream'\n"
            "• Launch the video player\n\n"
            "**Download Mode:**\n"
            "• Send a video URL\n"
            "• Get MP4/MKV file\n\n"
            "**Clip Generator Mode:**\n"
            "• Send a video file\n"
            "• Get 3 × 5-sec clips\n"
            "• From beginning, middle, end\n\n"
            "**Commands:**\n"
            "`/start` - Main menu\n"
            "`/watch` - Launch stream\n"
            "`/help` - Show help\n"
            "`/setstream <url>` - Admin only"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_to_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'back_to_main':
        user_id = query.from_user.id
        if user_id == ADMIN_ID:
            admin_message = "👑 **Admin Panel**\nUse `/setstream <url>` to change stream.\n\n"
        else:
            admin_message = ""
            
        keyboard = [
            [InlineKeyboardButton("📺 Watch Live Stream", callback_data='watch_stream_btn')],
            [InlineKeyboardButton("📥 Download Video (URL)", callback_data='download_mode')],
            [InlineKeyboardButton("✂️ Generate Clips (File)", callback_data='clip_mode')],
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
        "**Three Modes:**\n"
        "1️⃣ Live Stream - Watch stream\n"
        "2️⃣ Download - Get MP4/MKV from URLs\n"
        "3️⃣ Clip Generator - Send file → Get 3 clips\n\n"
        "**Commands:**\n"
        "`/start` - Main menu\n"
        "`/watch` - Launch stream\n"
        "`/help` - Show help\n\n"
        "Send video URL or video file to start!",
        parse_mode='Markdown'
    )

async def fallback_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    
    # Check if it's a URL
    try:
        result = urlparse(text)
        if result.scheme and result.netloc:
            await handle_url(update, context)
            return
    except:
        pass
    
    await update.message.reply_text(
        "👋 Send me:\n"
        "• Video URL to download\n"
        "• Video file to generate clips\n"
        "• /start to see all options"
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
    
    # Handle video files (both as video and as document)
    app.add_handler(MessageHandler(filters.VIDEO, handle_video_file))
    app.add_handler(MessageHandler(filters.Document.VIDEO, handle_video_file))
    
    # Handle text messages (URLs)
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
    logger.info("🤖 All-in-One Video Bot starting...")
    logger.info("✨ Features: URL Download (MP4/MKV) + File Clip Generator (3 clips)")
    
    if USE_WEBHOOK and WEBHOOK_URL:
        logger.info("🚀 Webhook mode")
        asyncio.run(run_webhook())
    else:
        logger.info("✅ Polling mode")
        app = setup_application()
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)

if __name__ == '__main__':
    main()
