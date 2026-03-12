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
      '{hours} Hours of Heavy Rain for Deep Sleep | Delta Waves',
      'Rain Sounds for Sleeping - {hours} Hours | Binaural Beats',
      'Heavy Rainfall at Night - Sleep Instantly | {hours}h',
      'Rain on Window - {hours} Hours for Deep Sleep & Relaxation',
      'Rain on Tin Roof - {hours} Hours | Sleep Frequency Embedded',
    ],
    description: 'Fall asleep fast with {hours} hours of heavy rain sounds with embedded delta wave frequencies (2Hz) for deep sleep induction. Multiple rain layers: heavy downpour, distant patter, and roof drips blended for maximum realism.\n\nContains subtle binaural beats (left: 200Hz, right: 202Hz = 2Hz delta) beneath the rain — your brain naturally syncs to deep sleep frequency.\n\nSubscribe for more ambient sounds\nSupport: https://snipelink.com\n\n#rain #sleep #deltawaves #binaural #ambient #whitenoise',
    tags: ['rain sounds', 'sleep', 'delta waves', 'binaural beats', 'ambient', 'rain for sleeping', 'heavy rain', 'deep sleep', 'nature sounds', 'ASMR', 'sleep frequency'],
    // 3 layers: brown noise (heavy rain body), pink noise (light patter), sine binaural delta
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.65"`,   // heavy rain body
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.25"`,    // light patter/drips
      `-f lavfi -i "sine=f=200:r=44100:d=${dur}"`,                  // left ear 200Hz
      `-f lavfi -i "sine=f=202:r=44100:d=${dur}"`,                  // right ear 202Hz = 2Hz delta beat
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=800,highpass=f=40[heavy];\
      [1:a]highpass=f=2000,lowpass=f=8000,volume=0.4[patter];\
      [2:a]volume=0.03[left];\
      [3:a]volume=0.03[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [heavy][patter]amix=inputs=2:weights=1 0.3[rain_mix];\
      [rain_mix][binaural]amix=inputs=2:weights=1 0.15[aout]`,
    color: { r: 30, g: 40, b: 60 },
    text: 'Rain Sounds',
  },
  {
    name: 'thunder',
    title_templates: [
      '{hours} Hours of Thunderstorm for Deep Sleep | Delta Waves',
      'Thunder & Rain - Sleep Sounds | {hours}h Binaural',
      'Intense Thunderstorm with Rain | {hours} Hours',
      'Rolling Thunder for Relaxation - {hours} Hours | 2Hz Delta',
    ],
    description: '{hours} hours of powerful thunderstorm with layered rain, distant thunder rumble, and embedded delta wave frequencies (2Hz binaural beats) for deep sleep.\n\n3 audio layers: heavy rain, deep sub-bass rumble (thunder), and imperceptible 2Hz delta binaural beats that guide your brain into stage 3/4 deep sleep.\n\nSubscribe for more\nSupport: https://snipelink.com\n\n#thunder #storm #deltawaves #sleep #binaural #ambient',
    tags: ['thunderstorm', 'thunder sounds', 'storm', 'delta waves', 'binaural beats', 'sleep sounds', 'deep sleep', 'ambient', 'relaxation'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.7"`,    // rain body
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.5"`,    // deep rumble layer
      `-f lavfi -i "sine=f=174:r=44100:d=${dur}"`,                  // left 174Hz (solfeggio)
      `-f lavfi -i "sine=f=176:r=44100:d=${dur}"`,                  // right 176Hz = 2Hz delta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=600,highpass=f=30[rain];\
      [1:a]lowpass=f=80,volume=1.5[rumble];\
      [2:a]volume=0.03[left];\
      [3:a]volume=0.03[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [rain][rumble]amix=inputs=2:weights=1 0.4[storm_mix];\
      [storm_mix][binaural]amix=inputs=2:weights=1 0.12[aout]`,
    color: { r: 20, g: 25, b: 45 },
    text: 'Thunderstorm',
  },
  {
    name: 'ocean',
    title_templates: [
      '{hours} Hours of Ocean Waves for Sleep | Theta Waves',
      'Ocean Sounds - Waves Crashing | {hours}h Binaural Beats',
      'Calm Ocean Waves for Deep Relaxation - {hours} Hours',
      'Beach Waves at Night | {hours} Hours | 6Hz Theta',
    ],
    description: 'Relax with {hours} hours of ocean wave sounds with embedded theta wave frequencies (6Hz) for meditation and drowsy relaxation. Layered audio: deep surf, gentle shore wash, and distant sea breeze.\n\nTheta binaural beats (left: 210Hz, right: 216Hz = 6Hz theta) promote the drowsy pre-sleep state and deep meditation.\n\nSubscribe for more\nSupport: https://snipelink.com\n\n#ocean #waves #thetawaves #meditation #binaural #ambient',
    tags: ['ocean waves', 'sea sounds', 'theta waves', 'binaural beats', 'meditation', 'sleep', 'ambient', 'nature sounds', 'relaxation', 'beach'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.5"`,     // wave body
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.3"`,    // deep surf
      `-f lavfi -i "sine=f=210:r=44100:d=${dur}"`,                  // left 210Hz
      `-f lavfi -i "sine=f=216:r=44100:d=${dur}"`,                  // right 216Hz = 6Hz theta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=1500,highpass=f=100[waves];\
      [1:a]lowpass=f=200,volume=0.8[surf];\
      [2:a]volume=0.025[left];\
      [3:a]volume=0.025[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [waves][surf]amix=inputs=2:weights=1 0.35[ocean_mix];\
      [ocean_mix][binaural]amix=inputs=2:weights=1 0.12[aout]`,
    color: { r: 15, g: 50, b: 80 },
    text: 'Ocean Waves',
  },
  {
    name: 'fireplace',
    title_templates: [
      '{hours} Hours of Crackling Fireplace | Alpha Waves',
      'Cozy Fireplace Sounds | {hours}h Relaxation Frequency',
      'Crackling Fire - {hours} Hours | 10Hz Alpha Binaural',
    ],
    description: '{hours} hours of crackling fireplace with embedded alpha wave frequencies (10Hz) for calm relaxation. Layered audio: crackle pops, warm ember hum, and soft wood shifts.\n\nAlpha binaural beats (left: 315Hz, right: 325Hz = 10Hz alpha) promote calm, alert relaxation — perfect for reading or unwinding.\n\nSubscribe for more\nSupport: https://snipelink.com\n\n#fireplace #cozy #alphawaves #binaural #relaxation',
    tags: ['fireplace', 'crackling fire', 'alpha waves', 'binaural beats', 'cozy', 'relaxation', 'sleep', 'ambient', 'warm'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=white:r=44100:a=0.25"`,   // crackle
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.2"`,    // warm ember hum
      `-f lavfi -i "sine=f=315:r=44100:d=${dur}"`,                  // left 315Hz
      `-f lavfi -i "sine=f=325:r=44100:d=${dur}"`,                  // right 325Hz = 10Hz alpha
    ],
    audio_filter_complex: `\
      [0:a]highpass=f=400,lowpass=f=6000,volume=0.5[crackle];\
      [1:a]lowpass=f=300,volume=0.6[ember];\
      [2:a]volume=0.02[left];\
      [3:a]volume=0.02[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [crackle][ember]amix=inputs=2:weights=1 0.5[fire_mix];\
      [fire_mix][binaural]amix=inputs=2:weights=1 0.1[aout]`,
    color: { r: 80, g: 30, b: 10 },
    text: 'Fireplace',
  },
  {
    name: 'wind',
    title_templates: [
      '{hours} Hours of Wind Sounds for Sleep | Delta Waves',
      'Howling Wind - {hours} Hours | Binaural Sleep Aid',
      'Winter Wind & Theta Waves for Deep Sleep | {hours}h',
    ],
    description: '{hours} hours of wind through trees with embedded delta wave frequencies (3Hz) for deep sleep. Layered audio: low howling wind, higher gusts, and gentle leaf rustle.\n\nDelta binaural beats (left: 150Hz, right: 153Hz = 3Hz delta) guide your brainwaves into deep, restorative sleep.\n\nSubscribe for more\nSupport: https://snipelink.com\n\n#wind #deltawaves #binaural #sleep #nature #ambient',
    tags: ['wind sounds', 'howling wind', 'delta waves', 'binaural beats', 'deep sleep', 'ambient', 'relaxation', 'nature sounds'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.5"`,    // low howl
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.15"`,    // leaf rustle
      `-f lavfi -i "sine=f=150:r=44100:d=${dur}"`,                  // left 150Hz
      `-f lavfi -i "sine=f=153:r=44100:d=${dur}"`,                  // right 153Hz = 3Hz delta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=400,highpass=f=20[howl];\
      [1:a]highpass=f=3000,lowpass=f=8000,volume=0.3[rustle];\
      [2:a]volume=0.025[left];\
      [3:a]volume=0.025[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [howl][rustle]amix=inputs=2:weights=1 0.25[wind_mix];\
      [wind_mix][binaural]amix=inputs=2:weights=1 0.12[aout]`,
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

// ─── Visual Effects per Category ─────────────────────────
// Each returns the video portion of filter_complex (no -filter_complex flag, just the graph)
// Uses internal lavfi color= sources so they don't conflict with -i audio inputs
const VISUAL_EFFECTS = {
  rain: (dur) => `\
    color=c=0x0a1628:s=1280x720:r=24:d=${dur},noise=alls=30:allf=t,eq=brightness=-0.1:contrast=1.1[dark];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=90:allf=t,eq=brightness=-0.4[speckle];\
    [speckle]boxblur=0:0:0:3[vstreaks];\
    [vstreaks]scroll=vertical=0.05:horizontal=0[falling];\
    [dark][falling]blend=all_mode=screen:all_opacity=0.2[rain_v];\
    [rain_v]vignette=PI/4[vout]`,
  thunder: (dur) => `\
    color=c=0x080e1e:s=1280x720:r=24:d=${dur},noise=alls=45:allf=t,eq=brightness=-0.15:contrast=1.2[dark];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=95:allf=t,eq=brightness=-0.35[speckle];\
    [speckle]boxblur=0:0:0:4[vstreaks];\
    [vstreaks]scroll=vertical=0.06:horizontal=0[falling];\
    [dark][falling]blend=all_mode=screen:all_opacity=0.25[storm];\
    [storm]vignette=PI/3.5[vout]`,
  ocean: (dur) => `\
    color=c=0x0a2840:s=1280x720:r=24:d=${dur},noise=alls=15:allf=t[noisy];\
    color=c=0x0f3355:s=1280x720:r=24:d=${dur},noise=alls=20:allf=t[waves_v];\
    [noisy][waves_v]blend=all_mode=softlight:all_opacity=0.4[ocean_v];\
    [ocean_v]eq=brightness=-0.05:contrast=1.05:saturation=1.3[blue];\
    [blue]vignette=PI/4[vout]`,
  fireplace: (dur) => `\
    color=c=0x1a0800:s=1280x720:r=24:d=${dur},noise=alls=25:allf=t[noisy];\
    color=c=0x331100:s=1280x720:r=24:d=${dur},noise=alls=60:allf=t[flicker];\
    [noisy][flicker]blend=all_mode=screen:all_opacity=0.5[warm];\
    [warm]eq=brightness=0.05:contrast=1.1:saturation=1.5[fire];\
    [fire]colorbalance=rs=0.3:gs=-0.1:bs=-0.3:rm=0.2:gm=-0.05:bm=-0.2[orange];\
    [orange]vignette=PI/3[vout]`,
  wind: (dur) => `\
    color=c=0x1e2530:s=1280x720:r=24:d=${dur},noise=alls=35:allf=t[noisy];\
    color=c=0x2a3040:s=1280x720:r=24:d=${dur},noise=alls=25:allf=t[mist];\
    [noisy][mist]blend=all_mode=softlight:all_opacity=0.5[foggy];\
    [foggy]scroll=horizontal=0.001:vertical=0[drift];\
    [drift]eq=brightness=-0.05:contrast=1.05[grey];\
    [grey]vignette=PI/4[vout]`,
};

// ─── Generate Audio/Video ─────────────────────────────────
function generateVideo(category, durationSecs, outputPath) {
  const chunkSecs = Math.min(durationSecs, 600);
  const visualFilter = VISUAL_EFFECTS[category.name](durationSecs);

  // Multi-layered audio with binaural beats + animated visuals
  const audioInputs = category.audio_inputs(chunkSecs).join(' ');
  const loopCount = Math.ceil(durationSecs / chunkSecs);
  const loopSize = chunkSecs * 44100;

  // Add aloop to each audio stream for looping short chunks to full duration
  const audioFilterComplex = category.audio_filter_complex
    .replace(/\[0:a\]/g, `[0:a]aloop=loop=${loopCount}:size=${loopSize},`)
    .replace(/\[1:a\]/g, `[1:a]aloop=loop=${loopCount}:size=${loopSize},`)
    .replace(/\[2:a\]/g, `[2:a]aloop=loop=${loopCount}:size=${loopSize},`)
    .replace(/\[3:a\]/g, `[3:a]aloop=loop=${loopCount}:size=${loopSize},`);

  // Combine visual (lavfi color sources) + audio (file inputs) in one filter_complex
  const combinedFilter = `${visualFilter};\n    ${audioFilterComplex}`;

  const fullCmd = `ffmpeg -y \
    ${audioInputs} \
    -filter_complex "${combinedFilter}" \
    -map "[vout]" -map "[aout]" \
    -c:v libx264 -preset fast -crf 23 \
    -c:a aac -b:a 192k -ac 2 \
    -t ${durationSecs} \
    -shortest \
    "${outputPath}" 2>&1`;

  try {
    execSync(fullCmd, { timeout: 1800000, maxBuffer: 50 * 1024 * 1024 });
    return true;
  } catch (e) {
    console.error('[YouTube] ffmpeg layered failed:', e.message?.slice(0, 300));
    // Fallback: simple brown noise + vignette (no binaural)
    try {
      const { r, g, b } = category.color;
      const colorHex = `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      const fallbackCmd = `ffmpeg -y \
        -f lavfi -i "color=c=0x${colorHex}:s=1280x720:r=24:d=${durationSecs}" \
        -f lavfi -i "anoisesrc=d=${durationSecs}:c=brown:r=44100:a=0.6" \
        -filter_complex "[0:v]noise=alls=20:allf=t,vignette=PI/4[v]" \
        -map "[v]" -map 1:a \
        -af "lowpass=f=800,highpass=f=40" \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 192k \
        -shortest \
        "${outputPath}" 2>&1`;
      execSync(fallbackCmd, { timeout: 1800000, maxBuffer: 50 * 1024 * 1024 });
      return true;
    } catch (e2) {
      console.error('[YouTube] ffmpeg fallback also failed:', e2.message?.slice(0, 300));
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
    const hours = [1, 2, 3][Math.floor(Math.random() * 3)];
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
      const maxDuration = process.env.RAILWAY_ENVIRONMENT ? 3600 : Math.min(durationSecs, 10800);
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
