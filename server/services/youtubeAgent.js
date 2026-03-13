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
      'Heavy Rain on Window at Night | {hours} Hours for Deep Sleep | No Ads',
      'Rain Sounds for Sleeping | {hours} Hours Cozy Ambience | Delta Waves',
      '{hours}h Rain on Glass | Fall Asleep Instantly | Binaural Beats',
      'Cozy Rain on Window | {hours} Hours | Deep Sleep No Ads',
      'Rain on Tin Roof at Night | {hours} Hours | Sleep Sounds',
      'Gentle Rain Ambience | {hours} Hours for Relaxation | No Music',
    ],
    description: 'Fall asleep fast with {hours} hours of heavy rain sounds with embedded delta wave frequencies (2Hz) for deep sleep induction. 7 audio layers: heavy downpour, mid-range patter, roof drips, distant rumble, close splashes, and sub-perceptual binaural beats.\n\nContains subtle binaural beats (left: 200Hz, right: 202Hz = 2Hz delta) beneath the rain — your brain naturally syncs to deep sleep frequency.\n\nNo ads interrupting your sleep. Subscribe for daily ambient sounds.\n\nTimestamps:\n0:00 Rain begins\n0:30 Full intensity\n{hours}:00:00 End\n\nSupport: https://snipelink.com\n\n#rain #rainsounds #sleep #deltawaves #binaural #ambient #whitenoise #ambience #cozy #deepsleep #rainforsleeping #nosleepmusic #noads',
    tags: ['rain sounds', 'rain sounds for sleeping', 'sleep', 'deep sleep', 'delta waves', 'binaural beats', 'ambient', 'heavy rain', 'nature sounds', 'ASMR', 'cozy ambience','no ads', 'rain on window', 'rain on roof', '10 hours rain', 'sleep instantly'],
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
      'Thunderstorm Sounds for Sleeping | {hours} Hours | No Ads',
      'Heavy Thunder and Rain at Night | {hours} Hours | Deep Sleep',
      '{hours}h Intense Thunderstorm | Fall Asleep in Minutes | Binaural',
      'Rolling Thunder with Rain | {hours} Hours Cozy Storm Ambience',
      'Thunderstorm at Night | {hours} Hours for Deep Sleep | No Music',
    ],
    description: '{hours} hours of powerful thunderstorm with 7 layered audio: driving rain, high-freq detail, deep sub-bass thunder, mid-range rolling thunder, wind gusts, and sub-perceptual 2Hz delta binaural beats for stage 3/4 deep sleep.\n\nNo ads to wake you up. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#thunder #thunderstorm #storm #deltawaves #sleep #binaural #ambient #ambience #cozy #deepsleep #noads',
    tags: ['thunderstorm', 'thunder sounds', 'thunderstorm sounds for sleeping', 'storm', 'delta waves', 'binaural beats', 'sleep sounds', 'deep sleep', 'ambient', 'cozy ambience','no ads', 'thunder and rain', 'heavy thunder'],
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
      'Ocean Waves for Deep Sleep | {hours} Hours | No Ads',
      'Waves Crashing on Beach at Night | {hours} Hours | Sleep Sounds',
      '{hours}h Ocean Sounds for Sleeping | Moonlit Waves | Theta Waves',
      'Calm Ocean Waves | {hours} Hours Seaside Ambience | No Music',
      'Beach Waves at Night | {hours} Hours for Relaxation | Binaural',
    ],
    description: 'Relax with {hours} hours of ocean wave sounds with embedded theta wave frequencies (6Hz) for meditation. 7 layers: deep surf, shore wash, foam fizz, pebble undertow, distant seabirds, and sub-perceptual theta binaural beats.\n\nTheta binaural beats (210Hz/216Hz = 6Hz theta) promote the drowsy pre-sleep state and deep meditation.\n\nNo ads to interrupt your peace. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#ocean #waves #oceanwaves #thetawaves #meditation #binaural #ambient #ambience #cozy #deepsleep #noads #beach #seasounds',
    tags: ['ocean waves', 'ocean sounds for sleeping', 'sea sounds', 'theta waves', 'binaural beats', 'meditation', 'sleep', 'ambient', 'nature sounds', 'relaxation', 'beach', 'cozy ambience','no ads', 'waves crashing'],
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
      'Cozy Fireplace Crackling | {hours} Hours | Warm Ambience No Ads',
      'Crackling Fire Sounds for Sleep | {hours} Hours Cozy Cabin',
      '{hours}h Fireplace Ambience | Fall Asleep by the Fire | No Ads',
      'Warm Fireplace at Night | {hours} Hours Crackling Embers',
      'Crackling Fireplace | {hours} Hours | Cozy Winter Night Ambience',
    ],
    description: '{hours} hours of crackling fireplace with embedded alpha wave frequencies (10Hz) for calm relaxation. 7 layers: sharp crackle pops, warm ember drone, wood shifts, deep hearth resonance, soft ash settling, and sub-perceptual alpha binaural beats.\n\nAlpha binaural beats (315Hz/325Hz = 10Hz alpha) promote calm, alert relaxation — perfect for reading or unwinding.\n\nNo ads. Just crackling warmth. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#fireplace #cracklingfire #cozy #alphawaves #binaural #relaxation #ambience #cozy #noads #sleep #ambient',
    tags: ['fireplace', 'crackling fire', 'fireplace sounds', 'cozy fireplace', 'alpha waves', 'binaural beats', 'cozy', 'relaxation', 'sleep', 'ambient', 'warm', 'cozy ambience','no ads', 'crackling fire for sleep'],
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
      'Howling Wind Sounds | {hours} Hours | Snowy Night Ambience No Ads',
      'Wind Through Trees at Night | {hours} Hours for Sleeping',
      '{hours}h Winter Wind and Snow | Fall Asleep Fast | No Music',
      'Blizzard Wind Sounds | {hours} Hours | Cozy Cabin Ambience',
      'Wind Storm at Night | {hours} Hours | Deep Sleep Binaural Beats',
    ],
    description: '{hours} hours of wind through trees with embedded delta wave frequencies (3Hz) for deep sleep. 7 layers: low howling wind, leaf rustle, deep gusts, chimney whistle, distant creaking, and sub-perceptual delta binaural beats.\n\nDelta binaural beats (150Hz/153Hz = 3Hz delta) guide your brainwaves into deep, restorative sleep.\n\nNo ads to wake you up. Subscribe for daily ambient sounds.\n\nSupport: https://snipelink.com\n\n#wind #windsounds #howlingwind #deltawaves #binaural #sleep #nature #ambient #ambience #cozy #noads #blizzard #deepsleep',
    tags: ['wind sounds', 'howling wind', 'wind sounds for sleeping', 'delta waves', 'binaural beats', 'deep sleep', 'ambient', 'relaxation', 'nature sounds', 'cozy ambience','no ads', 'blizzard', 'winter wind'],
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
// Cinematic cozy thumbnails — what top ambient channels actually use:
// Warm/moody scenes, big readable text, duration badge, atmospheric details
const THUMB_SCENES = {
  rain: {
    bgGradient: ['#0c1a2e', '#1a2e4a'],
    sceneElements: `
      <!-- Window frame -->
      <rect x="200" y="50" width="880" height="550" rx="12" fill="#0a0f1a" stroke="#2a3a5a" stroke-width="3"/>
      <rect x="210" y="60" width="860" height="530" rx="8" fill="#0d1525"/>
      <!-- Window pane divider -->
      <line x1="640" y1="60" x2="640" y2="590" stroke="#2a3a5a" stroke-width="3"/>
      <line x1="210" y1="320" x2="1070" y2="320" stroke="#2a3a5a" stroke-width="3"/>
      <!-- Rain streaks on glass — different sizes and angles for realism -->
      ${Array.from({length: 50}, (_, i) => {
        const x = 220 + (i * 17);
        const y = 70 + (i * 31) % 480;
        const len = 15 + (i % 4) * 12;
        const op = 0.15 + (i % 3) * 0.12;
        return `<line x1="${x}" y1="${y}" x2="${x + 2}" y2="${y + len}" stroke="rgba(140,175,220,${op})" stroke-width="${1 + (i % 3) * 0.5}" stroke-linecap="round"/>`;
      }).join('')}
      <!-- Warm amber interior glow through window -->
      <ellipse cx="430" cy="380" rx="180" ry="120" fill="rgba(255,150,50,0.06)"/>
      <ellipse cx="850" cy="250" rx="150" ry="100" fill="rgba(255,130,40,0.05)"/>
      <!-- Window sill -->
      <rect x="180" y="590" width="920" height="20" rx="3" fill="#1a2540"/>
    `,
    accentColor: '#6ea8d7',
  },
  thunder: {
    bgGradient: ['#040810', '#12182a'],
    sceneElements: `
      <!-- Storm clouds — layered for depth -->
      <ellipse cx="300" cy="100" rx="350" ry="90" fill="rgba(20,22,40,0.8)"/>
      <ellipse cx="750" cy="80" rx="400" ry="100" fill="rgba(15,18,35,0.7)"/>
      <ellipse cx="500" cy="60" rx="280" ry="70" fill="rgba(25,28,50,0.6)"/>
      <ellipse cx="950" cy="130" rx="300" ry="80" fill="rgba(18,20,38,0.5)"/>
      <!-- Lightning bolt — jagged realistic shape -->
      <polygon points="580,30 560,180 600,185 540,350 595,230 570,225 610,60" fill="rgba(180,200,255,0.25)"/>
      <polygon points="582,40 565,175 597,180 548,335 590,228 574,224 605,65" fill="rgba(220,235,255,0.15)"/>
      <!-- Lightning glow -->
      <ellipse cx="570" cy="200" rx="200" ry="180" fill="rgba(140,160,255,0.04)"/>
      <!-- Rain -->
      ${Array.from({length: 45}, (_, i) => {
        const x = 50 + (i * 27);
        const y = 200 + (i * 23) % 400;
        return `<line x1="${x}" y1="${y}" x2="${x + 3}" y2="${y + 25 + (i % 3) * 10}" stroke="rgba(100,120,180,${0.1 + (i % 4) * 0.06})" stroke-width="1"/>`;
      }).join('')}
    `,
    accentColor: '#8090c0',
  },
  ocean: {
    bgGradient: ['#041520', '#0c3050'],
    sceneElements: `
      <!-- Night sky gradient -->
      <rect x="0" y="0" width="1280" height="350" fill="rgba(4,15,30,0.5)"/>
      <!-- Moon -->
      <circle cx="920" cy="130" r="65" fill="rgba(230,240,255,0.15)"/>
      <circle cx="938" cy="118" r="60" fill="#041520"/>
      <!-- Moon glow -->
      <ellipse cx="920" cy="130" rx="120" ry="120" fill="rgba(180,200,230,0.04)"/>
      <!-- Wave layers — overlapping curves create ocean depth -->
      <path d="M0,450 Q120,420 240,450 Q360,480 480,450 Q600,420 720,450 Q840,480 960,450 Q1080,420 1200,450 Q1280,465 1280,450 L1280,720 L0,720 Z" fill="rgba(8,40,70,0.5)"/>
      <path d="M0,480 Q150,455 300,480 Q450,505 600,480 Q750,455 900,480 Q1050,505 1200,480 L1280,720 L0,720 Z" fill="rgba(6,30,55,0.6)"/>
      <path d="M0,510 Q200,495 400,510 Q600,525 800,510 Q1000,495 1200,510 L1280,720 L0,720 Z" fill="rgba(4,22,42,0.7)"/>
      <path d="M0,545 Q180,535 360,545 Q540,555 720,545 Q900,535 1080,545 L1280,720 L0,720 Z" fill="rgba(3,18,35,0.8)"/>
      <!-- Moon reflection on water — vertical shimmer -->
      <ellipse cx="920" cy="500" rx="8" ry="60" fill="rgba(200,220,250,0.06)"/>
      <ellipse cx="920" cy="530" rx="15" ry="40" fill="rgba(180,200,240,0.04)"/>
      <ellipse cx="920" cy="560" rx="25" ry="30" fill="rgba(160,185,230,0.03)"/>
      <!-- Stars -->
      ${Array.from({length: 20}, (_, i) => `<circle cx="${80 + (i * 57) % 1200}" cy="${30 + (i * 41) % 280}" r="${0.8 + (i % 3) * 0.5}" fill="rgba(200,215,240,${0.06 + (i % 4) * 0.03})"/>`).join('')}
    `,
    accentColor: '#5a9cc0',
  },
  fireplace: {
    bgGradient: ['#0d0400', '#1a0a00'],
    sceneElements: `
      <!-- Dark cozy room -->
      <rect x="0" y="0" width="1280" height="720" fill="rgba(15,6,0,0.3)"/>
      <!-- Stone fireplace surround -->
      <rect x="300" y="200" width="680" height="470" rx="0" fill="#1a0c04" stroke="#3d2210" stroke-width="5"/>
      <rect x="280" y="180" width="720" height="30" rx="4" fill="#2a1408"/>
      <!-- Mantle -->
      <rect x="260" y="170" width="760" height="20" rx="3" fill="#3d2210"/>
      <!-- Fire opening -->
      <rect x="340" y="250" width="600" height="370" rx="8" fill="#080200"/>
      <!-- Flames — layered organic shapes -->
      <path d="M500,620 Q510,470 540,400 Q560,430 570,380 Q590,450 600,620 Z" fill="rgba(255,100,0,0.3)"/>
      <path d="M580,620 Q600,440 640,370 Q670,420 690,380 Q710,460 720,620 Z" fill="rgba(255,130,10,0.25)"/>
      <path d="M650,620 Q665,500 680,430 Q700,480 720,450 Q740,510 760,620 Z" fill="rgba(255,80,0,0.2)"/>
      <path d="M540,620 Q555,490 575,440 Q600,500 620,620 Z" fill="rgba(255,180,40,0.2)"/>
      <path d="M600,620 Q620,460 650,400 Q675,460 695,620 Z" fill="rgba(255,200,80,0.15)"/>
      <!-- Fire glow -->
      <ellipse cx="640" cy="500" rx="250" ry="150" fill="rgba(255,100,10,0.12)"/>
      <ellipse cx="640" cy="450" rx="180" ry="120" fill="rgba(255,140,30,0.08)"/>
      <!-- Ember dots -->
      ${Array.from({length: 12}, (_, i) => `<circle cx="${450 + (i * 35) % 380}" cy="${350 + (i * 23) % 200}" r="${1 + (i % 3)}" fill="rgba(255,${150 + (i * 20) % 100},${20 + (i * 10) % 60},${0.15 + (i % 4) * 0.06})"/>`).join('')}
      <!-- Warm room glow from fire -->
      <ellipse cx="640" cy="350" rx="500" ry="300" fill="rgba(255,80,10,0.03)"/>
    `,
    accentColor: '#ff8c40',
  },
  wind: {
    bgGradient: ['#101520', '#1a2230'],
    sceneElements: `
      <!-- Snowy night landscape -->
      <!-- Snow ground -->
      <path d="M0,550 Q200,540 400,555 Q600,545 800,560 Q1000,550 1280,555 L1280,720 L0,720 Z" fill="rgba(35,40,55,0.6)"/>
      <path d="M0,580 Q300,570 600,585 Q900,575 1280,580 L1280,720 L0,720 Z" fill="rgba(30,35,48,0.7)"/>
      <!-- Tree silhouettes — pine trees -->
      <path d="M80,550 L110,350 L140,550 Z" fill="rgba(15,18,28,0.8)"/>
      <path d="M90,550 L110,380 L130,550 Z" fill="rgba(18,22,32,0.6)"/>
      <path d="M150,555 L175,370 L200,555 Z" fill="rgba(12,16,25,0.7)"/>
      <path d="M1050,550 L1080,320 L1110,550 Z" fill="rgba(15,18,28,0.8)"/>
      <path d="M1060,550 L1080,360 L1100,550 Z" fill="rgba(18,22,32,0.6)"/>
      <path d="M1130,555 L1155,400 L1180,555 Z" fill="rgba(12,16,25,0.7)"/>
      <path d="M1170,560 L1190,380 L1210,560 Z" fill="rgba(14,17,26,0.6)"/>
      <!-- Distant cabin with warm window -->
      <rect x="550" y="480" width="80" height="60" fill="rgba(20,22,30,0.8)"/>
      <polygon points="540,480 590,450 640,480" fill="rgba(25,28,38,0.7)"/>
      <rect x="570" y="500" width="20" height="25" fill="rgba(255,160,50,0.15)"/>
      <ellipse cx="580" cy="510" rx="30" ry="25" fill="rgba(255,140,40,0.04)"/>
      <!-- Snow particles -->
      ${Array.from({length: 30}, (_, i) => `<circle cx="${40 + (i * 41) % 1200}" cy="${30 + (i * 37) % 500}" r="${1.5 + (i % 3)}" fill="rgba(180,190,210,${0.08 + (i % 5) * 0.04})"/>`).join('')}
      <!-- Misty layers -->
      <ellipse cx="400" cy="480" rx="500" ry="40" fill="rgba(40,50,65,0.1)"/>
      <ellipse cx="900" cy="500" rx="400" ry="35" fill="rgba(35,45,60,0.08)"/>
      <!-- Moon -->
      <circle cx="980" cy="120" r="50" fill="rgba(200,215,240,0.12)"/>
      <circle cx="995" cy="110" r="46" fill="#101520"/>
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
      <defs>
        <linearGradient id="textfade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color:${scene.bgGradient[1]};stop-opacity:0"/>
          <stop offset="100%" style="stop-color:${scene.bgGradient[1]};stop-opacity:0.85"/>
        </linearGradient>
      </defs>
      <rect x="0" y="450" width="${width}" height="270" fill="url(#textfade)"/>
      <!-- Duration badge top-right — bold and eye-catching -->
      <rect x="${width - 220}" y="25" width="190" height="60" rx="10" fill="rgba(0,0,0,0.7)" stroke="${scene.accentColor}" stroke-width="2"/>
      <text x="${width - 125}" y="65" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="white" text-anchor="middle">${hours} HOURS</text>
      <!-- NO ADS badge top-left -->
      <rect x="30" y="25" width="120" height="45" rx="8" fill="rgba(0,0,0,0.6)"/>
      <text x="90" y="55" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#4ade80" text-anchor="middle">NO ADS</text>
      <!-- Main title text bottom-left — large, glowing, cinematic -->
      <text x="50" y="${height - 95}" font-family="Arial, sans-serif" font-size="60" font-weight="bold" fill="white" filter="url(#glow)">${category.text}</text>
      <text x="50" y="${height - 45}" font-family="Arial, sans-serif" font-size="26" fill="${scene.accentColor}" opacity="0.9">Deep Sleep | Binaural Beats | Cozy Ambience</text>
    </svg>`;

  await sharp(Buffer.from(svg))
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

// ─── Visual Effects per Category ─────────────────────────
// Scene-based micro-animations that give the brain something to watch.
// Top ambient channels use: rain streaks on glass, flickering fire, rolling waves, drifting snow.
// All generated with ffmpeg lavfi — multiple layers at different speeds create depth + parallax.
// The 60s loop is seamless because noise/scroll patterns repeat naturally.
const VISUAL_EFFECTS = {
  // RAIN: Rain streaks on dark window with warm interior glow
  // 4 rain layers at different speeds = parallax depth
  // Warm amber base tint + breathing brightness = cozy room behind glass
  rain: (dur) => `\
    color=c=0x0c1a2e:s=1280x720:r=24:d=${dur},noise=alls=15:allf=t[bg];\
    color=c=0x1a0e04:s=1280x720:r=24:d=${dur}[warmbase];\
    [bg][warmbase]blend=all_mode=screen:all_opacity=0.06[room];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=90:allf=t,eq=brightness=-0.38[d1];\
    [d1]boxblur=0:0:0:1,scroll=vertical=0.08:horizontal=0[close_rain];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=65:allf=t,eq=brightness=-0.48[d2];\
    [d2]boxblur=0:0:0:4,scroll=vertical=0.04:horizontal=0.001[mid_rain];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=45:allf=t,eq=brightness=-0.55[d3];\
    [d3]boxblur=0:0:0:8,scroll=vertical=0.02:horizontal=-0.0005[far_rain];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=100:allf=t,eq=brightness=-0.6[d4];\
    [d4]boxblur=0:0:0:0,scroll=vertical=0.12:horizontal=0.003[splatter];\
    [room][close_rain]blend=all_mode=screen:all_opacity=0.18[r1];\
    [r1][mid_rain]blend=all_mode=screen:all_opacity=0.12[r2];\
    [r2][far_rain]blend=all_mode=screen:all_opacity=0.06[r3];\
    [r3][splatter]blend=all_mode=screen:all_opacity=0.03[r4];\
    [r4]eq=brightness=0.015*sin(2*PI*t/40)+0.008*sin(2*PI*t/137):saturation=1.05:eval=frame[breathe];\
    [breathe]colorbalance=bs=0.04:bm=0.02:rs=0.02:rm=0.015[tint];\
    [tint]vignette=PI/3.5[vout]`,

  // THUNDER: Dark storm sky with rain + periodic lightning flashes
  // Lightning = brightness spike using sin^8 (sharp pulse), multiple rain layers
  // Blue-white flash illuminates everything for a split second then fades
  thunder: (dur) => `\
    color=c=0x060c1a:s=1280x720:r=24:d=${dur},noise=alls=20:allf=t[sky];\
    color=c=0x0a1530:s=1280x720:r=24:d=${dur},noise=alls=35:allf=t[clouds];\
    [sky][clouds]blend=all_mode=softlight:all_opacity=0.5[stormsky];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=90:allf=t,eq=brightness=-0.35[d1];\
    [d1]boxblur=0:0:0:2,scroll=vertical=0.06:horizontal=0.002[rain1];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=70:allf=t,eq=brightness=-0.42[d2];\
    [d2]boxblur=0:0:0:5,scroll=vertical=0.09:horizontal=-0.001[rain2];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=50:allf=t,eq=brightness=-0.52[d3];\
    [d3]boxblur=0:0:0:10,scroll=vertical=0.03:horizontal=0[rain3];\
    [stormsky][rain1]blend=all_mode=screen:all_opacity=0.2[s1];\
    [s1][rain2]blend=all_mode=screen:all_opacity=0.14[s2];\
    [s2][rain3]blend=all_mode=screen:all_opacity=0.06[s3];\
    [s3]eq=brightness=0.18*pow(sin(2*PI*t/17),8)+0.10*pow(sin(2*PI*t/31+1.5),8)+0.06*pow(sin(2*PI*t/47+3),8)+0.01*sin(2*PI*t/90):eval=frame[lit];\
    [lit]colorbalance=bs=0.06:bh=0.04:bm=0.03[tint];\
    [tint]vignette=PI/3.5[vout]`,

  // OCEAN: Moonlit water surface with gentle wave motion + moon reflection
  // Horizontal scroll creates wave drift, multiple layers at different speeds = depth
  // Brightness cycles simulate wave crests catching moonlight
  ocean: (dur) => `\
    color=c=0x051525:s=1280x720:r=24:d=${dur}[deepsky];\
    color=c=0x0a2540:s=1280x720:r=24:d=${dur},noise=alls=8:allf=t[water1];\
    color=c=0x0c3050:s=1280x720:r=24:d=${dur},noise=alls=14:allf=t[water2];\
    color=c=0x153d5e:s=1280x720:r=24:d=${dur},noise=alls=6:allf=t[shimmer];\
    color=c=0x1a5070:s=1280x720:r=24:d=${dur},noise=alls=20:allf=t,eq=brightness=-0.5[foam];\
    [deepsky][water1]blend=all_mode=softlight:all_opacity=0.4[w1];\
    [w1][water2]blend=all_mode=screen:all_opacity=0.12[w2];\
    [w2]scroll=horizontal=0.003:vertical=0[drift1];\
    [drift1][shimmer]blend=all_mode=overlay:all_opacity=0.06[w3];\
    [w3][foam]blend=all_mode=screen:all_opacity=0.03[w4];\
    [w4]eq=brightness=0.02*sin(2*PI*t/18)+0.012*sin(2*PI*t/7)+0.006*sin(2*PI*t/53):saturation=1.1+0.06*sin(2*PI*t/30):eval=frame[breathe];\
    [breathe]colorbalance=bs=0.07:bm=0.04:gs=-0.02[tint];\
    [tint]vignette=PI/4[vout]`,

  // FIREPLACE: Warm flickering flames with ember glow and occasional bright pops
  // Multiple orange/amber noise layers blended create organic flame movement
  // Fast brightness oscillation = flame flicker, slow = overall glow breathing
  // Heavy warm color balance makes it feel like real firelight
  fireplace: (dur) => `\
    color=c=0x0d0400:s=1280x720:r=24:d=${dur},noise=alls=15:allf=t[room];\
    color=c=0x2a0e00:s=1280x720:r=24:d=${dur},noise=alls=60:allf=t[flame1];\
    color=c=0x401800:s=1280x720:r=24:d=${dur},noise=alls=40:allf=t[flame2];\
    color=c=0x803000:s=1280x720:r=24:d=${dur},noise=alls=80:allf=t[ember];\
    color=c=0xff6000:s=1280x720:r=24:d=${dur},noise=alls=95:allf=t,eq=brightness=-0.7[spark];\
    [room][flame1]blend=all_mode=screen:all_opacity=0.45[f1];\
    [f1][flame2]blend=all_mode=screen:all_opacity=0.25[f2];\
    [f2][ember]blend=all_mode=screen:all_opacity=0.08[f3];\
    [f3][spark]blend=all_mode=screen:all_opacity=0.02[f4];\
    [f4]eq=brightness=0.06*sin(2*PI*t/2.3)+0.04*sin(2*PI*t/5.7)+0.02*sin(2*PI*t/0.7)+0.01*sin(2*PI*t/17):contrast=1.15+0.06*sin(2*PI*t/9):saturation=1.7+0.25*sin(2*PI*t/11):eval=frame[flicker];\
    [flicker]colorbalance=rs=0.45:gs=-0.08:bs=-0.35:rm=0.3:gm=-0.04:bm=-0.28:rh=0.15:gh=-0.02:bh=-0.12[warm];\
    [warm]vignette=PI/3[vout]`,

  // WIND: Snowy night with drifting snow particles and misty layers
  // Diagonal scroll = snow blowing sideways, multiple layers = depth
  // Slow horizontal fog drift + faint brightness breathing = moonlit atmosphere
  wind: (dur) => `\
    color=c=0x111820:s=1280x720:r=24:d=${dur},noise=alls=10:allf=t[night];\
    color=c=0x1a2230:s=1280x720:r=24:d=${dur},noise=alls=18:allf=t[mist];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=70:allf=t,eq=brightness=-0.55[snow1];\
    [snow1]boxblur=1:1:1:1,scroll=vertical=0.015:horizontal=0.025[drift_snow1];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=50:allf=t,eq=brightness=-0.6[snow2];\
    [snow2]boxblur=2:2:2:2,scroll=vertical=0.008:horizontal=0.015[drift_snow2];\
    color=c=black:s=1280x720:r=24:d=${dur},noise=alls=30:allf=t,eq=brightness=-0.65[snow3];\
    [snow3]boxblur=4:4:4:4,scroll=vertical=0.004:horizontal=0.008[drift_snow3];\
    [night][mist]blend=all_mode=softlight:all_opacity=0.4[base];\
    [base]scroll=horizontal=0.001:vertical=0[fog_drift];\
    [fog_drift][drift_snow1]blend=all_mode=screen:all_opacity=0.12[s1];\
    [s1][drift_snow2]blend=all_mode=screen:all_opacity=0.07[s2];\
    [s2][drift_snow3]blend=all_mode=screen:all_opacity=0.04[s3];\
    [s3]eq=brightness=0.008*sin(2*PI*t/50)+0.004*sin(2*PI*t/130):saturation=1.0+0.04*sin(2*PI*t/70):eval=frame[breathe];\
    [breathe]colorbalance=bs=0.05:bm=0.03:gs=0.01[tint];\
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

// ─── Delete Video ────────────────────────────────────────
export async function deleteVideo(videoId) {
  const yt = getYouTube();
  await yt.videos.delete({ id: videoId });
  db.prepare(`UPDATE youtube_videos SET status = 'deleted' WHERE video_id = ?`).run(videoId);
  console.log(`[YouTube] Deleted video: ${videoId}`);
  return true;
}

export async function deleteAllVideos() {
  const yt = getYouTube();
  const videos = db.prepare(`SELECT video_id, title FROM youtube_videos WHERE status = 'published' AND video_id IS NOT NULL`).all();
  const results = { deleted: 0, failed: 0, errors: [] };

  for (const v of videos) {
    try {
      await yt.videos.delete({ id: v.video_id });
      db.prepare(`UPDATE youtube_videos SET status = 'deleted' WHERE video_id = ?`).run(v.video_id);
      results.deleted++;
      console.log(`[YouTube] Deleted: ${v.video_id} — "${v.title}"`);
    } catch (e) {
      results.failed++;
      results.errors.push(`${v.video_id}: ${e.message?.slice(0, 80)}`);
      console.log(`[YouTube] Delete failed for ${v.video_id}: ${e.message?.slice(0, 80)}`);
    }
  }

  // Reset cooldown so a new video can upload immediately
  const state = getState();
  state.lastUpload = null;
  saveState(state);

  console.log(`[YouTube] Purge complete: ${results.deleted} deleted, ${results.failed} failed`);
  return results;
}

// ─── Force Upload Now (bypass 24h cooldown) ──────────────
export async function forceUploadNow() {
  // Reset the cooldown timer
  const state = getState();
  state.lastUpload = null;
  saveState(state);
  console.log('[YouTube] Cooldown reset — forcing immediate upload');
  return runYouTubeAgent();
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

      // ─── Spotify/Streaming Export ──────────────────────
      // Generate distribution-ready audio tracks for DistroKid upload
      // Split into album tracks (7-10 min each) as WAV 44.1kHz 16-bit
      try {
        const distDir = join(TEMP_DIR, '../spotify-export', `${category.name}-${actualHours}h`);
        if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

        const trackDuration = 600; // 10 min per track
        const numTracks = Math.min(Math.ceil(actualHours * 3600 / trackDuration), 10);
        const audioSrc = join(TEMP_DIR, `${category.name}-audio.m4a`);

        // Check if audio file still exists (may have been cleaned by generateVideo)
        // If not, regenerate a 1h audio chunk for splitting
        let srcAudio = audioSrc;
        if (!existsSync(srcAudio)) {
          console.log('[YouTube] Regenerating audio for Spotify export...');
          const audioInputs = category.audio_inputs(3600).join(' ');
          const regenCmd = `ffmpeg -y ${audioInputs} -filter_complex "${category.audio_filter_complex}" -map "[aout]" -c:a pcm_s16le -ar 44100 -ac 2 -t 3600 "${join(distDir, 'source.wav')}" 2>&1`;
          execSync(regenCmd, { timeout: 1200000, maxBuffer: 50 * 1024 * 1024 });
          srcAudio = join(distDir, 'source.wav');
        }

        // Split into tracks
        for (let i = 0; i < numTracks; i++) {
          const startSec = (i * trackDuration) % 3600; // Loop within 1h source
          const trackNum = String(i + 1).padStart(2, '0');
          const trackName = `${trackNum} - ${category.text} Part ${i + 1}`;
          const trackPath = join(distDir, `${trackName}.wav`);

          const splitCmd = `ffmpeg -y -i "${srcAudio}" -ss ${startSec} -t ${trackDuration} -c:a pcm_s16le -ar 44100 -ac 2 "${trackPath}" 2>&1`;
          execSync(splitCmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
        }

        // Generate 3000x3000 album art
        const artPath = join(distDir, 'cover.jpg');
        const scene = THUMB_SCENES[category.name] || THUMB_SCENES.rain;
        const artSvg = `<svg width="3000" height="3000" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="bg" x1="0%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" style="stop-color:${scene.bgGradient[0]}"/><stop offset="100%" style="stop-color:${scene.bgGradient[1]}"/>
          </linearGradient></defs>
          <rect width="3000" height="3000" fill="url(#bg)"/>
          <text x="1500" y="1300" font-family="Arial,sans-serif" font-size="280" font-weight="bold" fill="white" text-anchor="middle">${category.text}</text>
          <text x="1500" y="1600" font-family="Arial,sans-serif" font-size="160" fill="${scene.accentColor}" text-anchor="middle">Deep Sleep | Binaural Beats</text>
          <text x="1500" y="1900" font-family="Arial,sans-serif" font-size="120" fill="rgba(255,255,255,0.4)" text-anchor="middle">SnipeLink Sounds</text>
        </svg>`;
        await sharp(Buffer.from(artSvg)).resize(3000, 3000).jpeg({ quality: 95 }).toFile(artPath);

        // Write metadata file for DistroKid upload
        const metaPath = join(distDir, 'metadata.json');
        const meta = {
          artist: 'SnipeLink Sounds',
          album: `${category.text} for Deep Sleep`,
          year: new Date().getFullYear(),
          genre: 'Ambient',
          tracks: numTracks,
          trackDuration: `${trackDuration / 60} min each`,
          description: `${actualHours} hours of ${category.name} ambient sounds with embedded binaural beats.`,
          distrokid_notes: 'Upload WAV files + cover.jpg to DistroKid. Artist: SnipeLink Sounds. Genre: Ambient.',
        };
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        // Clean source file
        try { if (existsSync(join(distDir, 'source.wav'))) unlinkSync(join(distDir, 'source.wav')); } catch {}

        console.log(`[YouTube] Spotify export: ${numTracks} tracks in ${distDir}`);
      } catch (e) {
        console.log('[YouTube] Spotify export failed (non-critical):', e.message?.slice(0, 100));
      }
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
