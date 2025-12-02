import os
import re
import asyncio
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler, 
    filters, ContextTypes, CallbackQueryHandler
)
import yt_dlp
from urllib.parse import urlparse
import aiohttp

# Configuration
BOT_TOKEN = os.getenv('BOT_TOKEN', '8370816170:AAEDqSZLLPXpCBSCfK0Y1hrJfK0JNl1ag0Y')
TEMP_DIR = os.getenv('TEMP_DIR', 'temp_downloads')
USE_WEBHOOK = os.getenv('USE_WEBHOOK', 'false').lower() == 'true'
WEBHOOK_URL = os.getenv('WEBHOOK_URL', '')
PORT = int(os.getenv('PORT', 8000))

# Telegram file size limits
TELEGRAM_VIDEO_LIMIT = 50 * 1024 * 1024  # 50MB for videos
TELEGRAM_DOCUMENT_LIMIT = 2000 * 1024 * 1024  # 2GB for documents

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

os.makedirs(TEMP_DIR, exist_ok=True)

# Statistics storage
user_stats = {}

# ============= HELPER FUNCTIONS =============

def update_stats(user_id, stat_type):
    """Update user statistics"""
    if user_id not in user_stats:
        user_stats[user_id] = {'downloads': 0, 'clips': 0}
    user_stats[user_id][stat_type] = user_stats[user_id].get(stat_type, 0) + 1

def get_stats(user_id):
    """Get user statistics"""
    return user_stats.get(user_id, {'downloads': 0, 'clips': 0})

async def get_video_duration(filepath):
    """Get video duration using ffprobe"""
    try:
        cmd = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filepath
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        return float(stdout.decode().strip()) if proc.returncode == 0 else 0
    except:
        return 0

async def compress_video(input_path, output_path, target_size_mb=45):
    """Compress video to target size using ffmpeg"""
    try:
        duration = await get_video_duration(input_path)
        if duration == 0:
            return False
        
        # Calculate target bitrate (with 10% buffer for audio)
        target_bitrate = int((target_size_mb * 8192) / duration * 0.9)  # kbps
        
        cmd = [
            'ffmpeg',
            '-i', input_path,
            '-c:v', 'libx264',
            '-b:v', f'{target_bitrate}k',
            '-maxrate', f'{target_bitrate}k',
            '-bufsize', f'{target_bitrate * 2}k',
            '-preset', 'medium',
            '-c:a', 'aac',
            '-b:a', '96k',
            '-movflags', '+faststart',
            '-y',
            output_path
        ]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await proc.communicate()
        
        return proc.returncode == 0 and os.path.exists(output_path)
    except Exception as e:
        logger.error(f"Compression error: {e}")
        return False

async def split_video(filepath, chunk_duration=600):
    """Split video into chunks (default 10 minutes each)"""
    try:
        duration = await get_video_duration(filepath)
        if duration == 0:
            return []
        
        chunks = []
        base_name = os.path.splitext(filepath)[0]
        num_parts = int(duration / chunk_duration) + 1
        
        for i in range(num_parts):
            start_time = i * chunk_duration
            chunk_path = f"{base_name}_part{i+1}.mp4"
            
            cmd = [
                'ffmpeg',
                '-ss', str(start_time),
                '-i', filepath,
                '-t', str(chunk_duration),
                '-c', 'copy',
                '-avoid_negative_ts', '1',
                '-y',
                chunk_path
            ]
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await proc.communicate()
            
            if proc.returncode == 0 and os.path.exists(chunk_path):
                chunks.append((chunk_path, i+1, num_parts))
        
        return chunks
    except Exception as e:
        logger.error(f"Split error: {e}")
        return []

def extract_video_url(url):
    """Extract video URL using yt-dlp"""
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 45,
        'nocheckcertificate': True,
        'merge_output_format': 'mp4',
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
            }
    except Exception as e:
        logger.error(f"Extraction failed: {e}")
        return None

async def download_file_async(url, filename, max_size_mb=2000):
    """Download file asynchronously"""
    try:
        timeout = aiohttp.ClientTimeout(total=1800, connect=60)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
        
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            async with session.get(url, allow_redirects=True) as response:
                if response.status != 200:
                    return None
                
                filepath = os.path.join(TEMP_DIR, filename)
                max_bytes = max_size_mb * 1024 * 1024
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

async def generate_clips(filepath, num_clips=3, clip_duration=5):
    """Generate preview clips from video"""
    try:
        duration = await get_video_duration(filepath)
        
        min_duration = clip_duration * num_clips + 15
        if duration < min_duration:
            logger.warning(f"Video too short: {duration}s (need {min_duration}s)")
            return []
        
        clips = []
        base_name = os.path.splitext(filepath)[0]
        
        # Calculate clip positions
        positions = [
            (5, 'Beginning'),
            (max(10, (duration - clip_duration) / 2), 'Middle'),
            (max(15, duration - clip_duration - 10), 'End')
        ]
        
        for i, (start_time, label) in enumerate(positions[:num_clips], 1):
            clip_path = f"{base_name}_clip{i}_{label.lower()}.mp4"
            
            cmd = [
                'ffmpeg',
                '-ss', str(start_time),
                '-i', filepath,
                '-t', str(clip_duration),
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '28',
                '-c:a', 'aac',
                '-b:a', '96k',
                '-movflags', '+faststart',
                '-y',
                clip_path
            ]
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await proc.communicate()
            
            if proc.returncode == 0 and os.path.exists(clip_path):
                if os.path.getsize(clip_path) > 1024:
                    clips.append((clip_path, label, i, num_clips))
                    logger.info(f"✅ Generated {label} clip")
        
        return clips
    except Exception as e:
        logger.error(f"Clip generation error: {e}")
        return []

async def send_video_smart(message, filepath, caption, filename):
    """
    Smart video sending that handles size limits:
    - < 50MB: Send as video (playable in Telegram)
    - 50MB - 2GB: Try compression first, else split or send as document
    - > 2GB: Split into parts
    """
    file_size = os.path.getsize(filepath)
    
    try:
        # Case 1: Small enough to send as video directly
        if file_size < TELEGRAM_VIDEO_LIMIT:
            with open(filepath, 'rb') as f:
                await message.reply_video(
                    video=f,
                    caption=caption,
                    supports_streaming=True,
                    filename=filename
                )
            return True
        
        # Case 2: Too big for video, but under document limit
        elif file_size < TELEGRAM_DOCUMENT_LIMIT:
            # Try compression first
            compressed_path = f"{os.path.splitext(filepath)[0]}_compressed.mp4"
            
            await message.reply_text("📦 File is large, compressing...")
            
            if await compress_video(filepath, compressed_path, target_size_mb=45):
                compressed_size = os.path.getsize(compressed_path)
                
                if compressed_size < TELEGRAM_VIDEO_LIMIT:
                    with open(compressed_path, 'rb') as f:
                        await message.reply_video(
                            video=f,
                            caption=f"{caption}\n\n⚠️ Compressed to fit Telegram limits",
                            supports_streaming=True,
                            filename=filename
                        )
                    os.remove(compressed_path)
                    return True
                else:
                    os.remove(compressed_path)
            
            # Compression didn't work, send as document
            await message.reply_text("📤 Sending as document (too large for video)...")
            with open(filepath, 'rb') as f:
                await message.reply_document(
                    document=f,
                    caption=f"{caption}\n\n📁 Sent as document due to size",
                    filename=filename
                )
            return True
        
        # Case 3: Larger than 2GB, must split
        else:
            await message.reply_text("✂️ File is very large, splitting into parts...")
            chunks = await split_video(filepath)
            
            if not chunks:
                await message.reply_text("❌ Failed to split video")
                return False
            
            for chunk_path, part_num, total_parts in chunks:
                chunk_size = os.path.getsize(chunk_path)
                part_caption = f"{caption}\n\n📦 Part {part_num}/{total_parts}"
                
                if chunk_size < TELEGRAM_VIDEO_LIMIT:
                    with open(chunk_path, 'rb') as f:
                        await message.reply_video(
                            video=f,
                            caption=part_caption,
                            supports_streaming=True,
                            filename=f"part{part_num}_{filename}"
                        )
                else:
                    with open(chunk_path, 'rb') as f:
                        await message.reply_document(
                            document=f,
                            caption=part_caption,
                            filename=f"part{part_num}_{filename}"
                        )
                
                os.remove(chunk_path)
            
            return True
            
    except Exception as e:
        logger.error(f"Send error: {e}")
        return False

# ============= COMMAND HANDLERS =============

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("📥 Download Video", callback_data='mode_download')],
        [InlineKeyboardButton("✂️ Generate Clips", callback_data='mode_clips')],
        [InlineKeyboardButton("📊 Statistics", callback_data='show_stats')],
        [InlineKeyboardButton("ℹ️ Help", callback_data='show_help')]
    ]
    
    await update.message.reply_text(
        "🎬 **Video Download & Clip Generator Bot**\n\n"
        "**Two Powerful Features:**\n\n"
        "📥 **Download Video**\n"
        "• Send any video URL\n"
        "• Supports 1000+ websites\n"
        "• Auto-compression for large files\n"
        "• Smart splitting for huge files\n\n"
        "✂️ **Generate Clips**\n"
        "• Upload a video file\n"
        "• Get 3 × 5-second preview clips\n"
        "• From beginning, middle, and end\n\n"
        "Choose a mode below!",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode='Markdown'
    )

async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle video URL download with smart size management"""
    url = update.message.text.strip()
    user_id = update.message.from_user.id
    
    try:
        result = urlparse(url)
        if not all([result.scheme, result.netloc]):
            await update.message.reply_text("❌ Invalid URL")
            return
    except:
        await update.message.reply_text("❌ Invalid URL format")
        return
    
    status_msg = await update.message.reply_text("🔍 Extracting video info...")
    filepath = None
    
    try:
        info = extract_video_url(url)
        if not info:
            await status_msg.edit_text("❌ Could not extract video")
            return
        
        await status_msg.edit_text(f"⬇️ Downloading: {info['title'][:50]}...")
        filename = re.sub(r'[<>:\"/\\|?*]', '_', f"{info['title']}.{info['ext']}")[:100]
        
        filepath = await download_file_async(info['url'], filename)
        
        if not filepath:
            await status_msg.edit_text("❌ Download failed")
            return
        
        update_stats(user_id, 'downloads')
        
        file_size = os.path.getsize(filepath)
        file_size_mb = file_size / (1024 * 1024)
        
        await status_msg.edit_text(
            f"📤 Sending video ({file_size_mb:.1f}MB)...\n"
            f"{'⚙️ Processing for optimal delivery...' if file_size_mb > 50 else ''}"
        )
        
        success = await send_video_smart(
            update.message,
            filepath,
            f"🎥 {info['title'][:80]}",
            filename
        )
        
        if success:
            await status_msg.edit_text("✅ Video sent successfully!")
        else:
            await status_msg.edit_text("❌ Failed to send video")
        
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {str(e)[:100]}")
        logger.error(f"URL handling error: {e}")
    finally:
        if filepath and os.path.exists(filepath):
            os.remove(filepath)

async def handle_video_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle video file upload and generate clips"""
    user_id = update.message.from_user.id
    video = update.message.video or update.message.document
    
    if not video:
        return
    
    # Validate video file
    file_name = getattr(video, 'file_name', '')
    mime_type = getattr(video, 'mime_type', '')
    
    video_extensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v']
    is_video = (mime_type and mime_type.startswith('video/')) or \
               any(file_name.lower().endswith(ext) for ext in video_extensions)
    
    if not is_video:
        await update.message.reply_text("❌ Please send a valid video file")
        return
    
    if video.file_size > 500 * 1024 * 1024:
        await update.message.reply_text("❌ File too large (max 500MB)")
        return
    
    status_msg = await update.message.reply_text("📥 Downloading video...")
    filepath = None
    clips = []
    
    try:
        filename = file_name or f"video_{user_id}_{int(asyncio.get_event_loop().time())}.mp4"
        filepath = os.path.join(TEMP_DIR, filename)
        
        telegram_file = await video.get_file()
        await telegram_file.download_to_drive(filepath)
        
        update_stats(user_id, 'clips')
        
        await status_msg.edit_text("✂️ Generating 3 preview clips (5 seconds each)...")
        clips = await generate_clips(filepath, num_clips=3, clip_duration=5)
        
        if not clips:
            await status_msg.edit_text(
                "❌ Failed to generate clips.\n"
                "Video must be at least 25 seconds long."
            )
            return
        
        await status_msg.edit_text(f"📤 Sending {len(clips)} clips...")
        
        for clip_path, label, num, total in clips:
            try:
                with open(clip_path, 'rb') as f:
                    await update.message.reply_video(
                        video=f,
                        caption=f"🎬 Clip {num}/{total} - **{label}**\n📄 From: {file_name[:50]}",
                        supports_streaming=True,
                        filename=f"clip_{num}_{label.lower()}.mp4",
                        parse_mode='Markdown'
                    )
            except Exception as e:
                logger.error(f"Failed to send clip {num}: {e}")
        
        await status_msg.edit_text(f"✅ Sent {len(clips)} clips!")
        
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {str(e)[:100]}")
        logger.error(f"Video processing error: {e}")
    finally:
        if filepath and os.path.exists(filepath):
            os.remove(filepath)
        for clip_path, _, _, _ in clips:
            if os.path.exists(clip_path):
                os.remove(clip_path)

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    if query.data == 'mode_download':
        text = (
            "📥 **Download Mode**\n\n"
            "Send me any video URL and I'll download it!\n\n"
            "✅ **Supported:**\n"
            "• YouTube, Instagram, TikTok\n"
            "• Facebook, Twitter, Reddit\n"
            "• And 1000+ more sites\n\n"
            "**Smart Features:**\n"
            "🎯 Auto-compression for files >50MB\n"
            "📦 Auto-splitting for files >2GB\n"
            "🔓 Bypass restrictions\n\n"
            "Just paste a video URL!"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'mode_clips':
        text = (
            "✂️ **Clip Generator**\n\n"
            "Upload a video file to get 3 preview clips!\n\n"
            "**How it works:**\n"
            "1️⃣ Send any video file\n"
            "2️⃣ Bot generates 3 × 5-second clips\n"
            "3️⃣ Clips from: Beginning, Middle, End\n\n"
            "**Requirements:**\n"
            "⏱ Min duration: 25 seconds\n"
            "📦 Max size: 500MB\n"
            "🎬 Formats: MP4, MKV, AVI, MOV, etc.\n\n"
            "Just send your video!"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'show_stats':
        stats = get_stats(query.from_user.id)
        text = (
            f"📊 **Your Statistics**\n\n"
            f"📥 Videos downloaded: {stats['downloads']}\n"
            f"✂️ Clips generated: {stats['clips']}"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'show_help':
        text = (
            "ℹ️ **Help**\n\n"
            "**Download Mode:**\n"
            "• Send video URL\n"
            "• Get video file (auto-optimized)\n\n"
            "**Clip Mode:**\n"
            "• Upload video file\n"
            "• Get 3 × 5-sec preview clips\n\n"
            "**Commands:**\n"
            "`/start` - Main menu\n"
            "`/help` - Show help"
        )
        keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data='back_main')]]
        await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode='Markdown')
        
    elif query.data == 'back_main':
        keyboard = [
            [InlineKeyboardButton("📥 Download Video", callback_data='mode_download')],
            [InlineKeyboardButton("✂️ Generate Clips", callback_data='mode_clips')],
            [InlineKeyboardButton("📊 Statistics", callback_data='show_stats')],
            [InlineKeyboardButton("ℹ️ Help", callback_data='show_help')]
        ]
        await query.edit_message_text(
            "🎬 **Video Bot**\n\nChoose your mode:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='Markdown'
        )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🎬 **Video Bot Help**\n\n"
        "📥 **Download:** Send video URL\n"
        "✂️ **Clips:** Upload video file\n\n"
        "Use /start for full menu"
    )

async def fallback_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    
    try:
        result = urlparse(text)
        if result.scheme and result.netloc:
            await handle_url(update, context)
            return
    except:
        pass
    
    await update.message.reply_text(
        "Send:\n• Video URL to download\n• Video file for clips\n• /start for menu"
    )

def cleanup_temp_files():
    """Clean up temporary files"""
    try:
        for f in os.listdir(TEMP_DIR):
            path = os.path.join(TEMP_DIR, f)
            if os.path.isfile(path):
                os.remove(path)
        logger.info("🧹 Cleaned temp files")
    except Exception as e:
        logger.error(f"Cleanup error: {e}")

# ============= APPLICATION SETUP =============

def setup_application():
    app = Application.builder().token(BOT_TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.VIDEO, handle_video_file))
    app.add_handler(MessageHandler(filters.Document.VIDEO, handle_video_file))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, fallback_message))
    
    return app

def main():
    cleanup_temp_files()
    logger.info("🤖 Video Bot starting...")
    logger.info("✨ Features: Smart Download + Clip Generator")
    
    app = setup_application()
    
    if USE_WEBHOOK and WEBHOOK_URL:
        logger.info("🚀 Webhook mode")
        from aiohttp import web
        
        async def run_webhook():
            await app.initialize()
            await app.bot.set_webhook(url=f"{WEBHOOK_URL}/{BOT_TOKEN}")
            await app.start()
            
            async def handle(request):
                try:
                    data = await request.json()
                    update = Update.de_json(data, app.bot)
                    await app.process_update(update)
                    return web.Response(text="ok")
                except:
                    return web.Response(text="error", status=500)
            
            webapp = web.Application()
            webapp.router.add_post(f"/{BOT_TOKEN}", handle)
            webapp.router.add_get("/health", lambda r: web.Response(text="OK"))
            
            runner = web.AppRunner(webapp)
            await runner.setup()
            site = web.TCPSite(runner, '0.0.0.0', PORT)
            await site.start()
            logger.info(f"✅ Webhook on port {PORT}")
            
            try:
                await asyncio.Event().wait()
            finally:
                await app.stop()
                await runner.cleanup()
        
        asyncio.run(run_webhook())
    else:
        logger.info("✅ Polling mode")
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)

if __name__ == '__main__':
    main()
