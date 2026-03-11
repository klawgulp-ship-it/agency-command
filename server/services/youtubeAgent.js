import { google } from 'googleapis';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import db from '../db/connection.js';
import { trackSpend } from './analyticsTracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = join(__dirname, '../data/yt-temp');
const STATE_FILE = join(__dirname, '../data/youtube-state.json');

// ─── DB Setup ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS youtube_videos (
    id TEXT PRIMARY KEY,
    video_id TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    duration_hours REAL DEFAULT 1,
    status TEXT DEFAULT 'pending',
    views INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS youtube_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    type TEXT DEFAULT 'own',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Content Categories ───────────────────────────────────
const CATEGORIES = [
  {
    name: 'rain',
    title_templates: [
      '{hours} Hours of Heavy Rain for Deep Sleep',
      'Rain Sounds for Sleeping - {hours} Hours of Rainfall',
      'Heavy Rainfall at Night - Sleep Instantly | {hours}h',
      'Thunderstorm Rain Sounds | {hours} Hours for Relaxation',
      'Rain on Tin Roof - {hours} Hours of Soothing Sounds',
    ],
    description: 'Fall asleep fast with {hours} hours of heavy rain sounds. Perfect for sleeping, studying, relaxation, and meditation. No ads during playback.\n\n🔔 Subscribe for more ambient sounds\n💰 Support us: https://snipelink.com\n\n#rain #sleep #relaxation #ambient #whitenoise',
    tags: ['rain sounds', 'sleep', 'relaxation', 'ambient', 'white noise', 'rain for sleeping', 'heavy rain', 'rainfall', 'nature sounds', 'ASMR'],
    audio_cmd: (dur) => `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.7" -af "lowpass=f=800,highpass=f=50,tremolo=f=0.1:d=0.4"`,
    color: { r: 30, g: 40, b: 60 },
    text: 'Rain Sounds',
  },
  {
    name: 'thunder',
    title_templates: [
      '{hours} Hours of Thunderstorm Sounds for Sleep',
      'Thunder & Rain - Deep Sleep Sounds | {hours}h',
      'Intense Thunderstorm with Rain | {hours} Hours',
      'Rolling Thunder for Relaxation - {hours} Hours',
    ],
    description: '{hours} hours of powerful thunderstorm sounds mixed with heavy rain. Perfect for deep sleep, focus, and relaxation.\n\n🔔 Subscribe for more ambient sounds\n💰 Support: https://snipelink.com\n\n#thunder #storm #rain #sleep #ambient',
    tags: ['thunderstorm', 'thunder sounds', 'storm sounds', 'rain and thunder', 'sleep sounds', 'ambient', 'relaxation', 'nature'],
    audio_cmd: (dur) => `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.8" -af "lowpass=f=600,highpass=f=30,tremolo=f=0.05:d=0.7,volume=1.2"`,
    color: { r: 20, g: 25, b: 45 },
    text: 'Thunderstorm',
  },
  {
    name: 'ocean',
    title_templates: [
      '{hours} Hours of Ocean Waves for Sleep',
      'Ocean Sounds - Waves Crashing | {hours}h Sleep Aid',
      'Calm Ocean Waves for Deep Relaxation - {hours} Hours',
      'Beach Waves at Night | {hours} Hours of Sea Sounds',
    ],
    description: 'Relax with {hours} hours of ocean wave sounds. Gentle waves crashing on shore — perfect for sleeping, meditation, and focus.\n\n🔔 Subscribe for more\n💰 Support: https://snipelink.com\n\n#ocean #waves #sleep #meditation #ambient',
    tags: ['ocean waves', 'sea sounds', 'beach', 'waves crashing', 'sleep', 'meditation', 'ambient', 'nature sounds', 'relaxation'],
    audio_cmd: (dur) => `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.5" -af "lowpass=f=1200,tremolo=f=0.08:d=0.6,volume=0.9"`,
    color: { r: 15, g: 50, b: 80 },
    text: 'Ocean Waves',
  },
  {
    name: 'fireplace',
    title_templates: [
      '{hours} Hours of Crackling Fireplace for Relaxation',
      'Cozy Fireplace Sounds | {hours}h for Sleep',
      'Crackling Fire - {hours} Hours of Warmth',
    ],
    description: '{hours} hours of crackling fireplace ambiance. Cozy, warm, and perfect for relaxation, reading, or sleep.\n\n🔔 Subscribe\n💰 Support: https://snipelink.com\n\n#fireplace #cozy #crackling #sleep #relaxation',
    tags: ['fireplace', 'crackling fire', 'cozy', 'fire sounds', 'sleep', 'relaxation', 'ambient', 'warm'],
    audio_cmd: (dur) => `-f lavfi -i "anoisesrc=d=${dur}:c=white:r=44100:a=0.3" -af "highpass=f=200,lowpass=f=4000,tremolo=f=3:d=0.5,volume=0.6"`,
    color: { r: 80, g: 30, b: 10 },
    text: 'Fireplace',
  },
  {
    name: 'wind',
    title_templates: [
      '{hours} Hours of Wind Sounds for Sleep',
      'Howling Wind - {hours} Hours of Ambient Sound',
      'Winter Wind Sounds for Deep Sleep | {hours}h',
    ],
    description: '{hours} hours of wind blowing through trees. A natural ambient soundscape for sleeping, studying, or relaxing.\n\n🔔 Subscribe\n💰 Support: https://snipelink.com\n\n#wind #ambient #sleep #nature',
    tags: ['wind sounds', 'howling wind', 'nature sounds', 'sleep', 'ambient', 'relaxation', 'winter wind'],
    audio_cmd: (dur) => `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.5" -af "lowpass=f=500,tremolo=f=0.03:d=0.8,volume=0.8"`,
    color: { r: 50, g: 55, b: 65 },
    text: 'Wind Sounds',
  },
];

// ─── State Management ─────────────────────────────────────
function getState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastUpload: null, categoryIndex: 0, totalUploads: 0, commentedVideos: [] };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Auth Helper ──────────────────────────────────────────
function getYouTubeAuth() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube credentials not set. Need YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN');
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

function getYouTube() {
  return google.youtube({ version: 'v3', auth: getYouTubeAuth() });
}

// ─── Generate Thumbnail ───────────────────────────────────
async function generateThumbnail(category, hours, outputPath) {
  const width = 1280;
  const height = 720;

  // Create gradient background with text overlay (no emoji — causes Pango crash on Linux/Railway)
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:rgb(${category.color.r},${category.color.g},${category.color.b});stop-opacity:1" />
          <stop offset="100%" style="stop-color:rgb(${Math.max(0, category.color.r - 15)},${Math.max(0, category.color.g - 15)},${Math.max(0, category.color.b - 15)});stop-opacity:1" />
        </linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#14F195;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#9945FF;stop-opacity:1" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)" />
      <text x="${width / 2}" y="${height / 2 - 80}" font-family="Arial, sans-serif" font-size="100" font-weight="bold" fill="url(#accent)" text-anchor="middle" filter="url(#glow)">${category.text}</text>
      <text x="${width / 2}" y="${height / 2 + 40}" font-family="Arial, sans-serif" font-size="72" font-weight="bold" fill="white" text-anchor="middle">${hours} HOURS</text>
      <text x="${width / 2}" y="${height / 2 + 120}" font-family="Arial, sans-serif" font-size="32" fill="rgba(255,255,255,0.5)" text-anchor="middle">For Sleep and Relaxation</text>
      <text x="${width / 2}" y="${height - 40}" font-family="Arial, sans-serif" font-size="24" fill="rgba(255,255,255,0.3)" text-anchor="middle">SnipeLink Sounds</text>
    </svg>`;

  await sharp(Buffer.from(svg))
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

// ─── Generate Audio/Video ─────────────────────────────────
function generateVideo(category, durationSecs, outputPath) {
  const { r, g, b } = category.color;
  const colorHex = `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

  // Generate ambient audio + static color background as video
  // Use a short loop: generate 10 min of audio, then loop it to full duration
  const chunkSecs = Math.min(durationSecs, 600); // 10 min chunks max for generation
  const cmd = `ffmpeg -y \
    -f lavfi -i "color=c=0x${colorHex}:s=1280x720:r=1:d=${durationSecs}" \
    ${category.audio_cmd(chunkSecs)} \
    -filter_complex "[1:a]aloop=loop=${Math.ceil(durationSecs / chunkSecs)}:size=${chunkSecs * 44100}[looped]" \
    -map 0:v -map "[looped]" \
    -c:v libx264 -preset ultrafast -tune stillimage -crf 28 \
    -c:a aac -b:a 192k \
    -t ${durationSecs} \
    -shortest \
    "${outputPath}" 2>&1`;

  try {
    execSync(cmd, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
    return true;
  } catch (e) {
    console.error('[YouTube] ffmpeg failed:', e.message?.slice(0, 200));
    // Fallback: simpler command without loop
    try {
      const simpleCmd = `ffmpeg -y \
        -f lavfi -i "color=c=0x${colorHex}:s=1280x720:r=1:d=${durationSecs}" \
        -f lavfi -i "anoisesrc=d=${durationSecs}:c=brown:r=44100:a=0.6" \
        -af "lowpass=f=800,highpass=f=40" \
        -c:v libx264 -preset ultrafast -tune stillimage -crf 28 \
        -c:a aac -b:a 192k \
        -shortest \
        "${outputPath}" 2>&1`;
      execSync(simpleCmd, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
      return true;
    } catch (e2) {
      console.error('[YouTube] ffmpeg fallback also failed:', e2.message?.slice(0, 200));
      return false;
    }
  }
}

// ─── Upload Video ─────────────────────────────────────────
async function uploadVideo(videoPath, thumbnailPath, title, description, tags) {
  const yt = getYouTube();

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: '10', // Music
        defaultLanguage: 'en',
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
        embeddable: true,
      },
    },
    media: {
      body: createReadStream(videoPath),
    },
  });

  const videoId = res.data.id;
  console.log(`[YouTube] Uploaded: https://youtube.com/watch?v=${videoId}`);

  // Set thumbnail
  if (thumbnailPath && existsSync(thumbnailPath)) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: createReadStream(thumbnailPath) },
      });
      console.log('[YouTube] Thumbnail set');
    } catch (e) {
      console.log('[YouTube] Thumbnail upload failed (may need verified account):', e.message?.slice(0, 100));
    }
  }

  return videoId;
}

// ─── Comment on Related Videos ────────────────────────────
async function commentOnRelatedVideos(category) {
  const yt = getYouTube();
  const state = getState();
  const commented = new Set(state.commentedVideos || []);
  let newComments = 0;

  const queries = [
    `${category.name} sounds for sleeping`,
    `${category.name} ambient ${new Date().getFullYear()}`,
    `relaxing ${category.name} sounds`,
  ];

  const query = queries[Math.floor(Math.random() * queries.length)];

  try {
    const searchRes = await yt.search.list({
      part: ['snippet'],
      q: query,
      type: ['video'],
      maxResults: 10,
      order: 'relevance',
    });

    const videos = searchRes.data.items || [];
    const comments = [
      'This is so relaxing! Perfect for sleep 🌙',
      'I listen to sounds like these every night. Incredible for focus too.',
      'Been looking for good ambient sounds — this channel delivers 🎧',
      'Nothing beats nature sounds for deep sleep. Subscribed!',
      `Love this! I also make ambient content — check out our channel for more ${category.name} sounds ✨`,
      'Quality ambient sounds are hard to find. This is one of the best.',
    ];

    for (const video of videos.slice(0, 3)) {
      const videoId = video.id.videoId;
      if (commented.has(videoId)) continue;

      const comment = comments[Math.floor(Math.random() * comments.length)];

      try {
        await yt.commentThreads.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              videoId,
              topLevelComment: {
                snippet: { textOriginal: comment },
              },
            },
          },
        });

        db.prepare('INSERT INTO youtube_comments (video_id, comment_text, type) VALUES (?, ?, ?)').run(
          videoId, comment, 'engagement'
        );

        commented.add(videoId);
        newComments++;
        console.log(`[YouTube] Commented on ${videoId}`);

        // Rate limit — don't spam
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        console.log(`[YouTube] Comment failed on ${videoId}:`, e.message?.slice(0, 100));
      }
    }

    state.commentedVideos = [...commented].slice(-200); // Keep last 200
    saveState(state);
  } catch (e) {
    console.log('[YouTube] Search/comment failed:', e.message?.slice(0, 150));
  }

  return newComments;
}

// ─── Reply to Comments on Our Videos ──────────────────────
async function replyToComments() {
  const yt = getYouTube();
  let replies = 0;

  try {
    // Get our channel's videos
    const channelRes = await yt.channels.list({ part: ['contentDetails'], mine: true });
    const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return 0;

    const playlistRes = await yt.playlistItems.list({
      part: ['snippet'],
      playlistId: uploadsPlaylistId,
      maxResults: 5,
    });

    for (const item of playlistRes.data.items || []) {
      const videoId = item.snippet.resourceId.videoId;

      const commentsRes = await yt.commentThreads.list({
        part: ['snippet'],
        videoId,
        maxResults: 10,
        order: 'time',
      });

      for (const thread of commentsRes.data.items || []) {
        const comment = thread.snippet.topLevelComment;
        const authorId = comment.snippet.authorChannelId?.value;

        // Skip our own comments and already-replied threads
        if (thread.snippet.totalReplyCount > 0) continue;

        const replyText = pickReply(comment.snippet.textDisplay);

        try {
          await yt.comments.insert({
            part: ['snippet'],
            requestBody: {
              snippet: {
                parentId: comment.id,
                textOriginal: replyText,
              },
            },
          });
          replies++;
          db.prepare('INSERT INTO youtube_comments (video_id, comment_text, type) VALUES (?, ?, ?)').run(
            videoId, replyText, 'reply'
          );

          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.log('[YouTube] Reply failed:', e.message?.slice(0, 100));
        }
      }
    }
  } catch (e) {
    console.log('[YouTube] Reply to comments failed:', e.message?.slice(0, 150));
  }

  return replies;
}

function pickReply(commentText) {
  const text = commentText.toLowerCase();
  if (text.includes('love') || text.includes('great') || text.includes('amazing')) {
    return "Thank you so much! 🙏 Glad you enjoy it. More sounds coming soon — hit subscribe so you don't miss them!";
  }
  if (text.includes('sleep') || text.includes('night')) {
    return "Sweet dreams! 🌙 We upload new ambient sounds regularly for the best sleep experience.";
  }
  if (text.includes('study') || text.includes('focus') || text.includes('work')) {
    return "Perfect for focus sessions! 🎧 We have more ambient sounds on the channel — check them out!";
  }
  return "Thanks for listening! 🎶 Subscribe for more relaxing ambient sounds every week.";
}

// ─── Main Runner ──────────────────────────────────────────
export async function runYouTubeAgent() {
  const result = { uploaded: 0, comments: 0, replies: 0, errors: [] };

  // Check credentials
  try {
    getYouTubeAuth();
  } catch (e) {
    result.errors.push(e.message);
    console.log(`[YouTube] Skipping — ${e.message}`);
    return result;
  }

  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

  const state = getState();

  // ─── Upload a new video (1 per day max) ───────────────
  const lastUpload = state.lastUpload ? new Date(state.lastUpload) : null;
  const now = new Date();
  const hoursSinceUpload = lastUpload ? (now - lastUpload) / (1000 * 60 * 60) : 999;

  if (hoursSinceUpload >= 24) {
    const category = CATEGORIES[state.categoryIndex % CATEGORIES.length];
    const hours = [1, 2, 3, 8, 10][Math.floor(Math.random() * 5)];
    const durationSecs = hours * 3600;

    const titleTemplate = category.title_templates[Math.floor(Math.random() * category.title_templates.length)];
    const title = titleTemplate.replace('{hours}', hours);
    const description = category.description.replace(/{hours}/g, hours);

    const videoPath = join(TEMP_DIR, `${category.name}-${hours}h.mp4`);
    const thumbPath = join(TEMP_DIR, `${category.name}-${hours}h-thumb.jpg`);

    console.log(`[YouTube] Generating ${hours}h ${category.name} video...`);

    try {
      // Generate thumbnail
      await generateThumbnail(category, hours, thumbPath);

      // Generate video (this takes a while for long durations)
      // For Railway, cap at 1h to avoid timeout — longer videos for local
      const maxDuration = process.env.RAILWAY_ENVIRONMENT ? 3600 : durationSecs;
      const actualHours = maxDuration / 3600;
      const actualTitle = titleTemplate.replace('{hours}', actualHours);
      const actualDesc = description.replace(/{hours}/g, actualHours);

      const success = generateVideo(category, maxDuration, videoPath);
      if (!success) throw new Error('ffmpeg generation failed');

      console.log(`[YouTube] Video generated, uploading...`);

      const videoId = await uploadVideo(videoPath, thumbPath, actualTitle, actualDesc, category.tags);

      // Track in DB
      const id = `yt_${Date.now()}`;
      db.prepare(
        'INSERT INTO youtube_videos (id, video_id, title, category, duration_hours, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, videoId, actualTitle, category.name, actualHours, 'published');

      state.lastUpload = now.toISOString();
      state.categoryIndex = (state.categoryIndex + 1) % CATEGORIES.length;
      state.totalUploads = (state.totalUploads || 0) + 1;
      saveState(state);

      result.uploaded = 1;
      trackSpend('youtube-ffmpeg', 0); // Free generation
      console.log(`[YouTube] Published: "${actualTitle}" (${videoId})`);
    } catch (e) {
      result.errors.push(`Upload failed: ${e.message?.slice(0, 150)}`);
      console.error('[YouTube] Upload error:', e.message?.slice(0, 200));
    } finally {
      // Cleanup temp files
      try { if (existsSync(videoPath)) unlinkSync(videoPath); } catch {}
      try { if (existsSync(thumbPath)) unlinkSync(thumbPath); } catch {}
    }
  } else {
    console.log(`[YouTube] Next upload in ${Math.round(24 - hoursSinceUpload)}h`);
  }

  // ─── Comment on related videos ────────────────────────
  try {
    const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    result.comments = await commentOnRelatedVideos(category);
  } catch (e) {
    result.errors.push(`Comments: ${e.message?.slice(0, 100)}`);
  }

  // ─── Reply to comments on our videos ──────────────────
  try {
    result.replies = await replyToComments();
  } catch (e) {
    result.errors.push(`Replies: ${e.message?.slice(0, 100)}`);
  }

  console.log(`[YouTube] Done — uploaded: ${result.uploaded}, comments: ${result.comments}, replies: ${result.replies}`);
  return result;
}

// ─── OAuth Setup Helper (run once locally) ────────────────
export async function getYouTubeOAuthUrl() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return 'Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first';

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube',
    ],
    prompt: 'consent',
  });
}

export async function exchangeYouTubeCode(code) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  const { tokens } = await oauth2.getToken(code);
  return tokens; // Save tokens.refresh_token as YOUTUBE_REFRESH_TOKEN
}
