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
      'Heavy Rain for Deep Sleep | {hours} Hours Black Screen | No Ads',
      'Rain Sounds for Sleeping - {hours} Hours | Black Screen | Delta Waves',
      '{hours}h Heavy Rainfall | Sleep Instantly | No Music No Ads',
      'Rain on Window at Night | {hours} Hours for Deep Sleep | Black Screen',
      'Rain on Tin Roof | {hours} Hours | Deep Sleep Binaural Beats',
      'Intense Rain Sounds | {hours} Hours Black Screen | Fall Asleep Fast',
    ],
    description: 'Fall asleep fast with {hours} hours of heavy rain sounds with embedded delta wave frequencies (2Hz) for deep sleep induction. 7 audio layers: heavy downpour, mid-range patter, roof drips, distant rumble, close splashes, and sub-perceptual binaural beats.\n\nContains subtle binaural beats (left: 200Hz, right: 202Hz = 2Hz delta) beneath the rain — your brain naturally syncs to deep sleep frequency.\n\nNo ads interrupting your sleep. Subscribe for daily ambient sounds.\n\nTimestamps:\n0:00 Rain begins\n0:30 Full intensity\n{hours}:00:00 End\n\nSupport: https://snipelink.com\n\n#rain #rainsounds #sleep #deltawaves #binaural #ambient #whitenoise #blackscreen #deepsleep #rainforsleeping #nosleepmusic #noads',
    tags: ['rain sounds', 'rain sounds for sleeping', 'sleep', 'deep sleep', 'delta waves', 'binaural beats', 'ambient', 'heavy rain', 'nature sounds', 'ASMR', 'black screen', 'no ads', 'rain on window', 'rain on roof', '10 hours rain', 'sleep instantly'],
    // 7 inputs: rain body, patter, drips, rumble, close splashes, binaural L+R
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.6"`,    // heavy rain body
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.2"`,     // mid-range patter
      `-f lavfi -i "anoisesrc=d=${dur}:c=white:r=44100:a=0.08"`,   // high-freq drips/ticks
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.15"`,   // distant bass rumble
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.12"`,    // close splashes
      `-f lavfi -i "sine=f=200:r=44100:d=${dur}"`,                  // binaural left 200Hz
      `-f lavfi -i "sine=f=202:r=44100:d=${dur}"`,                  // binaural right 202Hz = 2Hz delta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=700,highpass=f=35,volume='0.75+0.10*sin(2*PI*t/50)+0.05*sin(2*PI*t/137)':eval=frame,aecho=0.8:0.88:120:0.15[body];\
      [1:a]highpass=f=1800,lowpass=f=6000,volume='0.22+0.07*sin(2*PI*t/35)+0.04*sin(2*PI*t/97)':eval=frame[patter];\
      [2:a]highpass=f=5000,lowpass=f=12000,volume='0.06+0.04*sin(2*PI*t/11)+0.02*sin(2*PI*t/43)':eval=frame[drips];\
      [3:a]lowpass=f=100,highpass=f=15,volume='0.35+0.20*sin(2*PI*t/70)+0.10*sin(2*PI*t/200)':eval=frame[rumble];\
      [4:a]bandpass=f=800:width_type=o:w=1.5,volume='0.10+0.06*sin(2*PI*t/23)+0.03*sin(2*PI*t/67)':eval=frame,aecho=0.6:0.7:80:0.12[splash];\
      [5:a]volume=0.012[left];\
      [6:a]volume=0.012[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [body][patter]amix=inputs=2:weights=1 0.3[mx1];\
      [mx1][drips]amix=inputs=2:weights=1 0.2[mx2];\
      [mx2][rumble]amix=inputs=2:weights=1 0.18[mx3];\
      [mx3][splash]amix=inputs=2:weights=1 0.12[mx4];\
      [mx4][binaural]amix=inputs=2:weights=1 0.08[aout]`,
    color: { r: 30, g: 40, b: 60 },
    text: 'Rain Sounds',
  },
  {
    name: 'thunder',
    title_templates: [
      'Thunderstorm Sounds for Sleeping | {hours} Hours | Black Screen No Ads',
      'Heavy Thunder and Rain | {hours} Hours Black Screen | Deep Sleep',
      '{hours}h Intense Thunderstorm | Fall Asleep in Minutes | No Ads',
      'Rolling Thunder with Rain | {hours} Hours for Deep Sleep | Binaural',
      'Thunderstorm at Night | {hours} Hours Black Screen | Sleep Sounds',
    ],
    description: '{hours} hours of powerful thunderstorm with 7 layered audio: driving rain, high-freq detail, deep sub-bass thunder, mid-range rolling thunder, wind gusts, and sub-perceptual 2Hz delta binaural beats for stage 3/4 deep sleep.\n\nNo ads to wake you up. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#thunder #thunderstorm #storm #deltawaves #sleep #binaural #ambient #blackscreen #deepsleep #noads',
    tags: ['thunderstorm', 'thunder sounds', 'thunderstorm sounds for sleeping', 'storm', 'delta waves', 'binaural beats', 'sleep sounds', 'deep sleep', 'ambient', 'black screen', 'no ads', 'thunder and rain', 'heavy thunder'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.7"`,    // rain body
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.15"`,    // high freq rain detail
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.5"`,    // deep sub-bass thunder
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.25"`,   // mid-range rolling thunder
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.1"`,     // wind gusts
      `-f lavfi -i "sine=f=174:r=44100:d=${dur}"`,                  // left 174Hz (solfeggio)
      `-f lavfi -i "sine=f=176:r=44100:d=${dur}"`,                  // right 176Hz = 2Hz delta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=600,highpass=f=25,volume='0.8+0.12*sin(2*PI*t/40)+0.06*sin(2*PI*t/113)':eval=frame,aecho=0.8:0.85:150:0.18[rain];\
      [1:a]highpass=f=3000,lowpass=f=6000,volume='0.15+0.08*sin(2*PI*t/25)+0.05*sin(2*PI*t/83)':eval=frame[detail];\
      [2:a]lowpass=f=60,highpass=f=10,volume='0.8+0.7*sin(2*PI*t/90)+0.4*sin(2*PI*t/250)':eval=frame,aecho=0.9:0.9:400:0.25[deepthunder];\
      [3:a]bandpass=f=200:width_type=o:w=1.2,volume='0.3+0.25*sin(2*PI*t/120)+0.15*sin(2*PI*t/300)':eval=frame,aecho=0.7:0.8:250:0.2[rollthunder];\
      [4:a]highpass=f=150,lowpass=f=2000,volume='0.08+0.06*sin(2*PI*t/45)+0.04*sin(2*PI*t/160)':eval=frame[gusts];\
      [5:a]volume=0.012[left];\
      [6:a]volume=0.012[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [rain][detail]amix=inputs=2:weights=1 0.2[mx1];\
      [mx1][deepthunder]amix=inputs=2:weights=1 0.35[mx2];\
      [mx2][rollthunder]amix=inputs=2:weights=1 0.2[mx3];\
      [mx3][gusts]amix=inputs=2:weights=1 0.12[mx4];\
      [mx4][binaural]amix=inputs=2:weights=1 0.08[aout]`,
    color: { r: 20, g: 25, b: 45 },
    text: 'Thunderstorm',
  },
  {
    name: 'ocean',
    title_templates: [
      'Ocean Waves for Deep Sleep | {hours} Hours | Black Screen No Ads',
      'Waves Crashing on Beach | {hours} Hours Black Screen | Sleep Sounds',
      '{hours}h Ocean Sounds for Sleeping | Theta Waves | No Music',
      'Calm Ocean Waves at Night | {hours} Hours | Fall Asleep Instantly',
      'Beach Waves for Relaxation | {hours} Hours Black Screen | Binaural',
    ],
    description: 'Relax with {hours} hours of ocean wave sounds with embedded theta wave frequencies (6Hz) for meditation. 7 layers: deep surf, shore wash, foam fizz, pebble undertow, distant seabirds, and sub-perceptual theta binaural beats.\n\nTheta binaural beats (210Hz/216Hz = 6Hz theta) promote the drowsy pre-sleep state and deep meditation.\n\nNo ads to interrupt your peace. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#ocean #waves #oceanwaves #thetawaves #meditation #binaural #ambient #blackscreen #deepsleep #noads #beach #seasounds',
    tags: ['ocean waves', 'ocean sounds for sleeping', 'sea sounds', 'theta waves', 'binaural beats', 'meditation', 'sleep', 'ambient', 'nature sounds', 'relaxation', 'beach', 'black screen', 'no ads', 'waves crashing'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.5"`,     // wave wash
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.3"`,    // deep surf undertow
      `-f lavfi -i "anoisesrc=d=${dur}:c=white:r=44100:a=0.06"`,   // foam/fizz high freq
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.1"`,    // pebble/gravel drag
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.04"`,    // distant wind/seabirds
      `-f lavfi -i "sine=f=210:r=44100:d=${dur}"`,                  // left 210Hz
      `-f lavfi -i "sine=f=216:r=44100:d=${dur}"`,                  // right 216Hz = 6Hz theta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=1200,highpass=f=80,volume='0.6+0.25*sin(2*PI*t/18)+0.12*sin(2*PI*t/47)':eval=frame,aecho=0.7:0.8:200:0.15[waves];\
      [1:a]lowpass=f=180,highpass=f=15,volume='0.5+0.35*sin(2*PI*t/22)+0.15*sin(2*PI*t/61)':eval=frame[surf];\
      [2:a]highpass=f=5000,lowpass=f=14000,volume='0.05+0.04*sin(2*PI*t/15)+0.02*sin(2*PI*t/37)':eval=frame[foam];\
      [3:a]bandpass=f=400:width_type=o:w=1.8,volume='0.08+0.06*sin(2*PI*t/20)+0.03*sin(2*PI*t/53)':eval=frame[pebble];\
      [4:a]highpass=f=2500,lowpass=f=6000,volume='0.03+0.02*sin(2*PI*t/90)+0.01*sin(2*PI*t/210)':eval=frame[wind];\
      [5:a]volume=0.010[left];\
      [6:a]volume=0.010[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [waves][surf]amix=inputs=2:weights=1 0.35[mx1];\
      [mx1][foam]amix=inputs=2:weights=1 0.15[mx2];\
      [mx2][pebble]amix=inputs=2:weights=1 0.1[mx3];\
      [mx3][wind]amix=inputs=2:weights=1 0.06[mx4];\
      [mx4][binaural]amix=inputs=2:weights=1 0.06[aout]`,
    color: { r: 15, g: 50, b: 80 },
    text: 'Ocean Waves',
  },
  {
    name: 'fireplace',
    title_templates: [
      'Cozy Fireplace Crackling | {hours} Hours | Black Screen No Ads',
      'Crackling Fire Sounds for Sleep | {hours} Hours Black Screen',
      '{hours}h Fireplace Ambience | Fall Asleep to Crackling Fire | No Ads',
      'Warm Fireplace at Night | {hours} Hours for Relaxation | No Music',
      'Crackling Fireplace Sounds | {hours} Hours | Cozy Sleep Ambience',
    ],
    description: '{hours} hours of crackling fireplace with embedded alpha wave frequencies (10Hz) for calm relaxation. 7 layers: sharp crackle pops, warm ember drone, wood shifts, deep hearth resonance, soft ash settling, and sub-perceptual alpha binaural beats.\n\nAlpha binaural beats (315Hz/325Hz = 10Hz alpha) promote calm, alert relaxation — perfect for reading or unwinding.\n\nNo ads. Just crackling warmth. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#fireplace #cracklingfire #cozy #alphawaves #binaural #relaxation #blackscreen #noads #sleep #ambient',
    tags: ['fireplace', 'crackling fire', 'fireplace sounds', 'cozy fireplace', 'alpha waves', 'binaural beats', 'cozy', 'relaxation', 'sleep', 'ambient', 'warm', 'black screen', 'no ads', 'crackling fire for sleep'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=white:r=44100:a=0.25"`,   // crackle pops
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.2"`,    // warm ember hum
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.08"`,    // wood shift detail
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.12"`,   // deep hearth resonance
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.04"`,    // ash/settling
      `-f lavfi -i "sine=f=315:r=44100:d=${dur}"`,                  // left 315Hz
      `-f lavfi -i "sine=f=325:r=44100:d=${dur}"`,                  // right 325Hz = 10Hz alpha
    ],
    audio_filter_complex: `\
      [0:a]highpass=f=800,lowpass=f=6000,volume='0.4+0.12*sin(2*PI*t/6)+0.08*sin(2*PI*t/19)+0.05*sin(2*PI*t/53)':eval=frame[crackle];\
      [1:a]lowpass=f=250,highpass=f=20,volume='0.5+0.08*sin(2*PI*t/45)+0.04*sin(2*PI*t/130)':eval=frame[ember];\
      [2:a]bandpass=f=1500:width_type=o:w=2,volume='0.06+0.04*sin(2*PI*t/9)+0.02*sin(2*PI*t/31)':eval=frame[wood];\
      [3:a]lowpass=f=120,highpass=f=15,volume='0.15+0.06*sin(2*PI*t/60)+0.03*sin(2*PI*t/180)':eval=frame,aecho=0.8:0.85:300:0.2[hearth];\
      [4:a]highpass=f=3000,lowpass=f=8000,volume='0.03+0.02*sin(2*PI*t/15)+0.01*sin(2*PI*t/41)':eval=frame[ash];\
      [5:a]volume=0.010[left];\
      [6:a]volume=0.010[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [crackle][ember]amix=inputs=2:weights=1 0.5[mx1];\
      [mx1][wood]amix=inputs=2:weights=1 0.15[mx2];\
      [mx2][hearth]amix=inputs=2:weights=1 0.12[mx3];\
      [mx3][ash]amix=inputs=2:weights=1 0.06[mx4];\
      [mx4][binaural]amix=inputs=2:weights=1 0.06[aout]`,
    color: { r: 80, g: 30, b: 10 },
    text: 'Fireplace',
  },
  {
    name: 'wind',
    title_templates: [
      'Howling Wind Sounds | {hours} Hours Black Screen | Deep Sleep No Ads',
      'Wind Through Trees | {hours} Hours for Sleeping | Black Screen',
      '{hours}h Winter Wind Sounds | Fall Asleep Fast | No Music No Ads',
      'Blizzard Wind Sounds | {hours} Hours | Deep Sleep Binaural Beats',
      'Wind Storm at Night | {hours} Hours Black Screen | Sleep Sounds',
    ],
    description: '{hours} hours of wind through trees with embedded delta wave frequencies (3Hz) for deep sleep. 7 layers: low howling wind, leaf rustle, deep gusts, chimney whistle, distant creaking, and sub-perceptual delta binaural beats.\n\nDelta binaural beats (150Hz/153Hz = 3Hz delta) guide your brainwaves into deep, restorative sleep.\n\nNo ads to wake you up. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#wind #windsounds #howlingwind #deltawaves #binaural #sleep #nature #ambient #blackscreen #noads #blizzard #deepsleep',
    tags: ['wind sounds', 'howling wind', 'wind sounds for sleeping', 'delta waves', 'binaural beats', 'deep sleep', 'ambient', 'relaxation', 'nature sounds', 'black screen', 'no ads', 'blizzard', 'winter wind'],
    audio_inputs: (dur) => [
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.5"`,    // low howl
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.15"`,    // leaf rustle
      `-f lavfi -i "anoisesrc=d=${dur}:c=brown:r=44100:a=0.15"`,   // deep gusts
      `-f lavfi -i "anoisesrc=d=${dur}:c=white:r=44100:a=0.05"`,   // chimney/gap whistle
      `-f lavfi -i "anoisesrc=d=${dur}:c=pink:r=44100:a=0.06"`,    // distant creaking/branches
      `-f lavfi -i "sine=f=150:r=44100:d=${dur}"`,                  // left 150Hz
      `-f lavfi -i "sine=f=153:r=44100:d=${dur}"`,                  // right 153Hz = 3Hz delta
    ],
    audio_filter_complex: `\
      [0:a]lowpass=f=350,highpass=f=15,volume='0.6+0.20*sin(2*PI*t/55)+0.10*sin(2*PI*t/170)':eval=frame,aecho=0.8:0.88:250:0.15[howl];\
      [1:a]highpass=f=3000,lowpass=f=8000,volume='0.2+0.10*sin(2*PI*t/30)+0.05*sin(2*PI*t/85)':eval=frame[rustle];\
      [2:a]lowpass=f=100,highpass=f=10,volume='0.3+0.40*sin(2*PI*t/80)+0.20*sin(2*PI*t/230)':eval=frame[gust];\
      [3:a]bandpass=f=2200:width_type=o:w=0.8,volume='0.04+0.03*sin(2*PI*t/40)+0.02*sin(2*PI*t/110)':eval=frame[whistle];\
      [4:a]bandpass=f=600:width_type=o:w=1.5,volume='0.05+0.03*sin(2*PI*t/25)+0.02*sin(2*PI*t/70)':eval=frame[creak];\
      [5:a]volume=0.010[left];\
      [6:a]volume=0.010[right];\
      [left][right]join=inputs=2:channel_layout=stereo[binaural];\
      [howl][rustle]amix=inputs=2:weights=1 0.25[mx1];\
      [mx1][gust]amix=inputs=2:weights=1 0.2[mx2];\
      [mx2][whistle]amix=inputs=2:weights=1 0.08[mx3];\
      [mx3][creak]amix=inputs=2:weights=1 0.06[mx4];\
      [mx4][binaural]amix=inputs=2:weights=1 0.06[aout]`,
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

// ─── Thumbnail Scenes ────────────────────────────────────
// Cinematic atmospheric scenes — top ambient channels use cozy scenes, not plain text
const THUMB_SCENES = {
  rain: {
    bgGradient: ['#0a1628', '#1a2a4a'],
    sceneElements: `
      <rect x="300" y="100" width="680" height="450" rx="8" fill="#1a1a2e" opacity="0.9"/>
      <rect x="320" y="120" width="640" height="410" rx="4" fill="#0d1b2a" opacity="0.8"/>
      <!-- Rain streaks on window -->
      ${Array.from({length: 40}, (_, i) => `<line x1="${320 + (i * 16)}" y1="${120 + (i % 7) * 20}" x2="${325 + (i * 16)}" y2="${180 + (i % 5) * 30}" stroke="rgba(150,180,220,0.3)" stroke-width="1.5"/>`).join('')}
      <!-- Warm glow from inside -->
      <ellipse cx="640" cy="400" rx="250" ry="120" fill="rgba(255,160,50,0.08)"/>
      <ellipse cx="640" cy="420" rx="150" ry="60" fill="rgba(255,120,30,0.06)"/>
    `,
    accentColor: '#6ea8d7',
  },
  thunder: {
    bgGradient: ['#060c1a', '#1a1a30'],
    sceneElements: `
      <!-- Lightning bolt -->
      <polygon points="640,50 620,200 660,200 600,380 660,250 630,250 680,80" fill="rgba(200,220,255,0.15)"/>
      <polygon points="640,60 625,190 655,195 610,360 650,245 635,248 670,90" fill="rgba(255,255,255,0.08)"/>
      <!-- Storm clouds -->
      <ellipse cx="400" cy="120" rx="300" ry="80" fill="rgba(30,30,60,0.6)"/>
      <ellipse cx="700" cy="100" rx="250" ry="70" fill="rgba(25,25,50,0.5)"/>
      <ellipse cx="550" cy="80" rx="200" ry="60" fill="rgba(40,40,70,0.4)"/>
      <!-- Rain -->
      ${Array.from({length: 30}, (_, i) => `<line x1="${100 + (i * 40)}" y1="${200 + (i % 5) * 40}" x2="${105 + (i * 40)}" y2="${280 + (i % 3) * 50}" stroke="rgba(120,140,200,0.2)" stroke-width="1"/>`).join('')}
    `,
    accentColor: '#8090c0',
  },
  ocean: {
    bgGradient: ['#071e35', '#0c3a60'],
    sceneElements: `
      <!-- Waves -->
      <path d="M0,500 Q160,460 320,500 Q480,540 640,500 Q800,460 960,500 Q1120,540 1280,500 L1280,720 L0,720 Z" fill="rgba(10,50,90,0.5)"/>
      <path d="M0,520 Q160,490 320,520 Q480,550 640,520 Q800,490 960,520 Q1120,550 1280,520 L1280,720 L0,720 Z" fill="rgba(8,40,75,0.6)"/>
      <path d="M0,550 Q200,530 400,550 Q600,570 800,550 Q1000,530 1280,550 L1280,720 L0,720 Z" fill="rgba(5,30,60,0.7)"/>
      <!-- Moon -->
      <circle cx="900" cy="120" r="60" fill="rgba(220,230,255,0.12)"/>
      <circle cx="915" cy="110" r="55" fill="#071e35"/>
      <!-- Moon reflection -->
      <ellipse cx="900" cy="550" rx="40" ry="100" fill="rgba(180,200,230,0.04)"/>
    `,
    accentColor: '#5a9cc0',
  },
  fireplace: {
    bgGradient: ['#120600', '#2a1000'],
    sceneElements: `
      <!-- Fireplace frame -->
      <rect x="340" y="250" width="600" height="400" rx="0" fill="#1a0800" stroke="#3d1a00" stroke-width="4"/>
      <rect x="360" y="270" width="560" height="360" rx="0" fill="#0d0400"/>
      <!-- Fire glow -->
      <ellipse cx="640" cy="550" rx="200" ry="100" fill="rgba(255,100,0,0.15)"/>
      <ellipse cx="640" cy="520" rx="120" ry="80" fill="rgba(255,60,0,0.12)"/>
      <ellipse cx="640" cy="500" rx="80" ry="60" fill="rgba(255,150,20,0.1)"/>
      <!-- Flame shapes -->
      <path d="M600,600 Q610,450 640,400 Q670,450 680,600 Z" fill="rgba(255,120,0,0.2)"/>
      <path d="M620,600 Q635,470 650,430 Q665,470 680,600 Z" fill="rgba(255,180,40,0.15)"/>
      <path d="M570,600 Q590,500 620,460 Q640,520 660,600 Z" fill="rgba(255,80,0,0.12)"/>
      <!-- Warm room glow -->
      <ellipse cx="640" cy="350" rx="400" ry="250" fill="rgba(255,100,20,0.04)"/>
    `,
    accentColor: '#ff8c40',
  },
  wind: {
    bgGradient: ['#151a22', '#252d3a'],
    sceneElements: `
      <!-- Misty layers -->
      <ellipse cx="300" cy="400" rx="500" ry="80" fill="rgba(60,70,90,0.15)"/>
      <ellipse cx="800" cy="350" rx="400" ry="60" fill="rgba(50,60,80,0.12)"/>
      <ellipse cx="500" cy="300" rx="600" ry="40" fill="rgba(70,80,100,0.08)"/>
      <!-- Trees silhouette -->
      <path d="M100,720 L120,400 L140,720 Z" fill="rgba(20,25,35,0.6)"/>
      <path d="M130,720 L150,350 L170,720 Z" fill="rgba(20,25,35,0.5)"/>
      <path d="M1100,720 L1120,380 L1140,720 Z" fill="rgba(20,25,35,0.6)"/>
      <path d="M1140,720 L1160,420 L1180,720 Z" fill="rgba(20,25,35,0.5)"/>
      <!-- Wind streaks -->
      ${Array.from({length: 15}, (_, i) => `<line x1="${100 + (i * 80)}" y1="${200 + (i % 4) * 60}" x2="${250 + (i * 80)}" y2="${195 + (i % 4) * 60}" stroke="rgba(100,110,130,0.08)" stroke-width="2"/>`).join('')}
      <!-- Moon -->
      <circle cx="960" cy="150" r="45" fill="rgba(200,210,230,0.1)"/>
    `,
    accentColor: '#8090a0',
  },
};

// ─── Generate Thumbnail ───────────────────────────────────
async function generateThumbnail(category, hours, outputPath) {
  const width = 1280;
  const height = 720;
  const scene = THUMB_SCENES[category.name] || THUMB_SCENES.rain;

  // Cinematic atmospheric thumbnail — dark moody scene with minimal text
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" style="stop-color:${scene.bgGradient[0]};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${scene.bgGradient[1]};stop-opacity:1" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="6" result="coloredBlur"/>
          <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="softglow">
          <feGaussianBlur stdDeviation="2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)" />
      ${scene.sceneElements}
      <!-- Bottom gradient overlay for text readability -->
      <rect x="0" y="400" width="${width}" height="320" fill="url(#bg)" opacity="0.5"/>
      <!-- Duration badge top-right -->
      <rect x="${width - 200}" y="30" width="170" height="55" rx="8" fill="rgba(0,0,0,0.6)"/>
      <text x="${width - 115}" y="67" font-family="Arial, sans-serif" font-size="30" font-weight="bold" fill="white" text-anchor="middle">${hours} HOURS</text>
      <!-- Main title text bottom-left (minimal like top channels) -->
      <text x="50" y="${height - 100}" font-family="Arial, sans-serif" font-size="56" font-weight="bold" fill="white" filter="url(#softglow)">${category.text}</text>
      <text x="50" y="${height - 50}" font-family="Arial, sans-serif" font-size="28" fill="${scene.accentColor}" opacity="0.9">Deep Sleep | Black Screen | No Ads</text>
    </svg>`;

  await sharp(Buffer.from(svg))
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

// ─── Visual Effects per Category ─────────────────────────
// Multi-layer animated visuals with micro-transitions (breathing brightness, drifting layers)
// Uses eval=frame on eq for time-based expressions so visuals slowly shift
const VISUAL_EFFECTS = {
  rain: (dur) => `\
    color=c=0x0a1628:s=1280x720:r=24:d=${dur},noise=alls=25:allf=t[base];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=80:allf=t,eq=brightness=-0.45[drops1];\
    [drops1]boxblur=0:0:0:2,scroll=vertical=0.04:horizontal=0[rain1];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=60:allf=t,eq=brightness=-0.5[drops2];\
    [drops2]boxblur=0:0:0:5,scroll=vertical=0.07:horizontal=0.001[rain2];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=40:allf=t,eq=brightness=-0.55[drops3];\
    [drops3]boxblur=0:0:0:8,scroll=vertical=0.025:horizontal=-0.0005[rain3];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=95:allf=t,eq=brightness=-0.6[drops4];\
    [drops4]boxblur=0:0:0:1,scroll=vertical=0.1:horizontal=0.002[rain4];\
    [base][rain1]blend=all_mode=screen:all_opacity=0.15[l1];\
    [l1][rain2]blend=all_mode=screen:all_opacity=0.1[l2];\
    [l2][rain3]blend=all_mode=screen:all_opacity=0.07[l3];\
    [l3][rain4]blend=all_mode=screen:all_opacity=0.04[l4];\
    [l4]eq=brightness=0.012*sin(2*PI*t/40)+0.006*sin(2*PI*t/137):saturation=1.0+0.08*sin(2*PI*t/90):eval=frame[breathe];\
    [breathe]colorbalance=bs=0.06:bm=0.03[tint];\
    [tint]vignette=PI/4[vout]`,
  thunder: (dur) => `\
    color=c=0x060c1a:s=1280x720:r=24:d=${dur},noise=alls=35:allf=t[base];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=90:allf=t,eq=brightness=-0.4[drops1];\
    [drops1]boxblur=0:0:0:3,scroll=vertical=0.05:horizontal=0[rain1];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=70:allf=t,eq=brightness=-0.45[drops2];\
    [drops2]boxblur=0:0:0:6,scroll=vertical=0.08:horizontal=0.001[rain2];\
    color=c=0x101830:s=1280x720:r=24:d=${dur},noise=alls=50:allf=t,eq=brightness=-0.5[drops3];\
    [drops3]boxblur=0:0:0:10,scroll=vertical=0.035:horizontal=-0.001[rain3];\
    [base][rain1]blend=all_mode=screen:all_opacity=0.18[l1];\
    [l1][rain2]blend=all_mode=screen:all_opacity=0.12[l2];\
    [l2][rain3]blend=all_mode=screen:all_opacity=0.06[l3];\
    [l3]eq=brightness=0.04*sin(2*PI*t/35)*sin(2*PI*t/35)*sin(2*PI*t/35)*sin(2*PI*t/35)+0.01*sin(2*PI*t/90):eval=frame[lit];\
    [lit]colorbalance=bs=0.08:bh=0.05[tint];\
    [tint]vignette=PI/3.5[vout]`,
  ocean: (dur) => `\
    color=c=0x071e35:s=1280x720:r=24:d=${dur},noise=alls=12:allf=t[deep];\
    color=c=0x0c3050:s=1280x720:r=24:d=${dur},noise=alls=18:allf=t[surface];\
    color=c=0x1a4a70:s=1280x720:r=24:d=${dur},noise=alls=8:allf=t[foam];\
    color=c=0x0a3560:s=1280x720:r=24:d=${dur},noise=alls=6:allf=t[shimmer];\
    [deep][surface]blend=all_mode=softlight:all_opacity=0.35[water];\
    [water][foam]blend=all_mode=screen:all_opacity=0.05[ocean1];\
    [ocean1][shimmer]blend=all_mode=overlay:all_opacity=0.04[ocean2];\
    [ocean2]scroll=horizontal=0.002:vertical=0[drift];\
    [drift]eq=brightness=0.018*sin(2*PI*t/20)+0.008*sin(2*PI*t/53):saturation=1.1+0.08*sin(2*PI*t/50):eval=frame[breathe];\
    [breathe]colorbalance=bs=0.08:bm=0.05:gs=-0.02[tint];\
    [tint]vignette=PI/4[vout]`,
  fireplace: (dur) => `\
    color=c=0x120600:s=1280x720:r=24:d=${dur},noise=alls=20:allf=t[dark_base];\
    color=c=0x2a0e00:s=1280x720:r=24:d=${dur},noise=alls=55:allf=t[flicker1];\
    color=c=0x401800:s=1280x720:r=24:d=${dur},noise=alls=35:allf=t[flicker2];\
    color=c=0x601800:s=1280x720:r=24:d=${dur},noise=alls=70:allf=t[spark];\
    [dark_base][flicker1]blend=all_mode=screen:all_opacity=0.4[warm1];\
    [warm1][flicker2]blend=all_mode=screen:all_opacity=0.2[warm2];\
    [warm2][spark]blend=all_mode=screen:all_opacity=0.04[warm3];\
    [warm3]eq=brightness=0.05*sin(2*PI*t/3)+0.03*sin(2*PI*t/7)+0.015*sin(2*PI*t/19):contrast=1.1+0.05*sin(2*PI*t/11):saturation=1.6+0.2*sin(2*PI*t/13):eval=frame[glow];\
    [glow]colorbalance=rs=0.4:gs=-0.1:bs=-0.3:rm=0.28:gm=-0.05:bm=-0.25[orange];\
    [orange]vignette=PI/3[vout]`,
  wind: (dur) => `\
    color=c=0x151a22:s=1280x720:r=24:d=${dur},noise=alls=30:allf=t[base];\
    color=c=0x1e2530:s=1280x720:r=24:d=${dur},noise=alls=20:allf=t[mist1];\
    color=c=0x252d3a:s=1280x720:r=24:d=${dur},noise=alls=15:allf=t[mist2];\
    color=c=0x1a2035:s=1280x720:r=24:d=${dur},noise=alls=10:allf=t[mist3];\
    [base][mist1]blend=all_mode=softlight:all_opacity=0.4[fog1];\
    [fog1][mist2]blend=all_mode=screen:all_opacity=0.08[fog2];\
    [fog2][mist3]blend=all_mode=overlay:all_opacity=0.05[fog3];\
    [fog3]scroll=horizontal=0.003:vertical=0.0005[drift];\
    [drift]eq=brightness=0.01*sin(2*PI*t/60)+0.005*sin(2*PI*t/170):saturation=1.0+0.05*sin(2*PI*t/80):eval=frame[breathe];\
    [breathe]colorbalance=bs=0.04:bm=0.02[tint];\
    [tint]vignette=PI/4[vout]`,
};

// ─── Generate Audio/Video ─────────────────────────────────
// Strategy: Generate a 60s video loop + full-length audio separately, then mux.
// This is 60x faster than rendering the full duration with effects and is how
// professional ambient channels work — the visual loops seamlessly.
function generateVideo(category, durationSecs, outputPath) {
  const dir = dirname(outputPath);
  const videoLoop = join(dir, `${category.name}-loop.mp4`);
  const audioFile = join(dir, `${category.name}-audio.m4a`);
  const LOOP_SECS = 60; // 60s visual loop — seamless for ambient noise visuals

  try {
    // Step 1: Generate 60s video loop with full visual effects
    console.log(`[YouTube] Step 1/3: Generating ${LOOP_SECS}s video loop...`);
    const visualFilter = VISUAL_EFFECTS[category.name](LOOP_SECS);
    const videoCmd = `ffmpeg -y \
      -filter_complex "${visualFilter}" \
      -map "[vout]" \
      -c:v libx264 -preset fast -crf 23 \
      -t ${LOOP_SECS} \
      "${videoLoop}" 2>&1`;
    execSync(videoCmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    console.log('[YouTube] Video loop generated');

    // Step 2: Generate audio chunk (1h) then loop it for full duration
    // Noise generators produce seamless output, so looping is inaudible
    const AUDIO_CHUNK = 3600; // 1 hour chunk
    const audioChunk = join(dir, `${category.name}-audio-chunk.m4a`);
    console.log(`[YouTube] Step 2/4: Generating ${AUDIO_CHUNK}s audio chunk (7 layers + binaural)...`);
    const audioInputs = category.audio_inputs(AUDIO_CHUNK).join(' ');
    const audioCmd = `ffmpeg -y \
      ${audioInputs} \
      -filter_complex "${category.audio_filter_complex}" \
      -map "[aout]" \
      -c:a aac -b:a 192k -ac 2 \
      -t ${AUDIO_CHUNK} \
      "${audioChunk}" 2>&1`;
    execSync(audioCmd, { timeout: 1200000, maxBuffer: 50 * 1024 * 1024 });
    console.log('[YouTube] Audio chunk generated');

    // Step 3: Loop audio chunk to full duration
    const audioLoopCount = Math.ceil(durationSecs / AUDIO_CHUNK);
    console.log(`[YouTube] Step 3/4: Looping audio ${audioLoopCount}x for ${durationSecs}s...`);
    const audioLoopCmd = `ffmpeg -y \
      -stream_loop ${audioLoopCount} -i "${audioChunk}" \
      -c:a copy \
      -t ${durationSecs} \
      "${audioFile}" 2>&1`;
    execSync(audioLoopCmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    try { unlinkSync(audioChunk); } catch {}
    console.log('[YouTube] Full audio generated');

    // Step 4: Mux looped video + looped audio into final file
    console.log('[YouTube] Step 4/4: Muxing video loop + audio...');
    const loopCount = Math.ceil(durationSecs / LOOP_SECS);
    const muxCmd = `ffmpeg -y \
      -stream_loop ${loopCount} -i "${videoLoop}" \
      -i "${audioFile}" \
      -map 0:v -map 1:a \
      -c:v copy -c:a copy \
      -t ${durationSecs} \
      -shortest \
      "${outputPath}" 2>&1`;
    execSync(muxCmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    console.log('[YouTube] Final video muxed');

    // Cleanup intermediates
    try { unlinkSync(videoLoop); } catch {}
    try { unlinkSync(audioFile); } catch {}
    return true;
  } catch (e) {
    console.error('[YouTube] Multi-step generation failed:', e.message?.slice(0, 300));
    // Cleanup intermediates on failure
    try { unlinkSync(videoLoop); } catch {}
    try { unlinkSync(audioFile); } catch {}

    // Fallback: simple visuals + 3 audio layers (still has binaural)
    try {
      console.log('[YouTube] Trying simplified fallback...');
      const { r, g, b } = category.color;
      const colorHex = `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      const inputs = category.audio_inputs(durationSecs);
      const fbInputs = [inputs[0], inputs[inputs.length - 2], inputs[inputs.length - 1]].join(' ');

      // Generate simple video loop
      const fbVideoCmd = `ffmpeg -y \
        -f lavfi -i "color=c=0x${colorHex}:s=1280x720:r=24:d=${LOOP_SECS}" \
        -filter_complex "[0:v]noise=alls=20:allf=t,vignette=PI/4[vout]" \
        -map "[vout]" -c:v libx264 -preset ultrafast -crf 25 \
        -t ${LOOP_SECS} "${videoLoop}" 2>&1`;
      execSync(fbVideoCmd, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });

      // Generate audio with main noise + binaural
      const fbAudioCmd = `ffmpeg -y \
        ${fbInputs} \
        -filter_complex "\
          [0:a]lowpass=f=700,highpass=f=35,volume=0.7[main];\
          [1:a]volume=0.012[left];[2:a]volume=0.012[right];\
          [left][right]join=inputs=2:channel_layout=stereo[bin];\
          [main][bin]amix=inputs=2:weights=1 0.08[aout]" \
        -map "[aout]" -c:a aac -b:a 192k -ac 2 \
        -t ${durationSecs} "${audioFile}" 2>&1`;
      execSync(fbAudioCmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });

      // Mux
      const fbMuxCmd = `ffmpeg -y \
        -stream_loop ${Math.ceil(durationSecs / LOOP_SECS)} -i "${videoLoop}" \
        -i "${audioFile}" \
        -map 0:v -map 1:a -c:v copy -c:a copy \
        -t ${durationSecs} -shortest "${outputPath}" 2>&1`;
      execSync(fbMuxCmd, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });

      try { unlinkSync(videoLoop); } catch {}
      try { unlinkSync(audioFile); } catch {}
      return true;
    } catch (e2) {
      console.error('[YouTube] Fallback also failed:', e2.message?.slice(0, 300));
      try { unlinkSync(videoLoop); } catch {}
      try { unlinkSync(audioFile); } catch {}
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
    // 8-10 hours is the sweet spot — competitors prove this gets max watch time
    // Our loop approach handles any length (60s video loop + full audio)
    const hours = [8, 10][Math.floor(Math.random() * 2)];
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

      // With loop approach, generation is fast (60s video + audio gen + mux)
      // Audio for 10h = ~5 min to generate, video loop = 1 min, mux = seconds
      const maxDuration = durationSecs; // No cap needed with loop approach
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
