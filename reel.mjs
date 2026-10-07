/**
 * Turns a shop piece into a 9:16 Reel and, in post mode, publishes it.
 *
 * Reels are the one format Instagram shows to people who don't follow the
 * account, which is the point: a feed post reaches the handful of followers,
 * a Reel can reach anyone browsing luxury resale.
 *
 * The video is built from the listing's own photos (the same square crops the
 * feed posts use, so the photo rules in feed.mjs apply unchanged): each photo
 * drifts slowly in, they cross-fade, and an end card gives brand, price and the
 * offers line. Everything sits inside Instagram's Reels safe zone, clear of the
 * caption and buttons Instagram draws over the bottom and right edge.
 *
 * Posting hosts the video briefly on jsDelivr (see hostVideo).
 * Rendering needs ffmpeg; the workflow installs it on the GitHub runner. Fonts
 * are the site's own (Playfair Display, Space Grotesk; OFL, in fonts/).
 *
 * MODE=preview  render REEL_COUNT reels (or the pieces in HANDLES) to previews/.
 * MODE=post     render the next piece and publish it as a Reel; reels.json
 *               records what has gone out. Exit 75 = quota or posting-hours
 *               pause, 76 = blocked, as in publish.mjs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeed, captionFor, photosFor, postTitle } from './feed.mjs';

const MODE = process.env.MODE || 'preview';
const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;

const W = 1080, H = 1920, FPS = 30;
const PHOTO = 960;                 // square photo panel
const PHOTO_X = (W - PHOTO) / 2, PHOTO_Y = 300;
const SLIDE = 2.0, FADE = 0.45;    // seconds per photo, cross-fade length
const END = 2.8;                   // end card
const MAX_PHOTOS = 4;

const BG = '0x0A0A0A', GOLD = '0xC9A96E', TEXT = '0xE5E5E5', MUTED = '0x8C8C8C';
const SERIF = 'fonts/PlayfairDisplay.ttf', SANS = 'fonts/SpaceGrotesk.ttf';

const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });

/** Greedy word wrap to at most `lines` lines, ending in an ellipsis if cut. */
function wrap(text, width, lines) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= width) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return out;
}

/** The title without its leading brand name, which the brand line already shows. */
function shortTitle(item) {
  const t = postTitle(item.title);
  // Compare without accents: the shop may say "Hermes" where a title says "Hermès".
  const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const brand = plain(item.brand || '');
  return brand && plain(t).startsWith(brand) ? t.slice(brand.length).trim() : t;
}

const spaced = (s) => s.toUpperCase().split('').join(' ').replace(/ {3}/g, '   ');

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo ${res.status}: ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

/**
 * drawtext from a file, so titles with quotes, colons or percent signs need no
 * escaping. Every drawn string goes through here.
 */
function textFilter(dir, name, text, { font, size, color, y, x = '(w-text_w)/2', alpha }) {
  const file = join(dir, `${name}.txt`);
  writeFileSync(file, text);
  return `drawtext=fontfile=${font}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:expansion=none` +
    (alpha ? `:alpha='${alpha}'` : '');
}

export async function renderReel(item, outPath) {
  const photos = photosFor(item).slice(0, MAX_PHOTOS);
  if (photos.length < 2) throw new Error('needs at least two photos');

  const dir = join('work', item.handle);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [i, url] of photos.entries()) {
    const f = join(dir, `p${i}.jpg`);
    await download(url, f);
    files.push(f);
  }

  const n = files.length;
  const slides = n * SLIDE - (n - 1) * FADE;
  const total = slides + END - FADE;
  const brand = (item.brand || 'LuxyBasement').trim();
  const title = wrap(shortTitle(item), 40, 2);
  const price = money(item.price);

  const inputs = files.flatMap((f) => ['-loop', '1', '-framerate', String(FPS), '-t', String(SLIDE), '-i', f]);
  const f = [];

  // Each photo: upscaled first so the slow zoom is smooth, then a gentle push-in.
  files.forEach((_, i) => {
    f.push(`[${i}:v]scale=1920:1920,setsar=1,zoompan=z='1+0.0015*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${PHOTO}x${PHOTO}:fps=${FPS},trim=duration=${SLIDE},setpts=PTS-STARTPTS,format=yuv420p[p${i}]`);
  });
  let last = 'p0';
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? 'slides' : `x${i}`;
    f.push(`[${last}][p${i}]xfade=transition=fade:duration=${FADE}:offset=${(i * (SLIDE - FADE)).toFixed(3)}[${out}]`);
    last = out;
  }
  if (n === 1) f.push('[p0]copy[slides]');

  // Main frame: photo panel with the piece's details beneath, inside the safe zone.
  const main = [
    textFilter(dir, 'm_head', spaced('LuxyBasement'), { font: SANS, size: 30, color: GOLD, y: 190 }),
    textFilter(dir, 'm_brand', brand.toUpperCase(), { font: SERIF, size: 62, color: GOLD, y: PHOTO_Y + PHOTO + 50 }),
    ...title.map((line, i) => textFilter(dir, `m_t${i}`, line, { font: SANS, size: 36, color: TEXT, y: PHOTO_Y + PHOTO + 140 + i * 50 })),
    textFilter(dir, 'm_price', price, { font: SERIF, size: 50, color: TEXT, y: PHOTO_Y + PHOTO + 150 + title.length * 50 + 20 }),
  ];
  f.push(`color=c=${BG}:s=${W}x${H}:d=${slides}:r=${FPS},format=yuv420p[c0]`);
  f.push(`[c0][slides]overlay=${PHOTO_X}:${PHOTO_Y}:shortest=1,${main.join(',')}[main]`);

  // End card: the reason to tap.
  const endTitle = wrap(shortTitle(item), 34, 3);
  const top = 700;
  const end = [
    textFilter(dir, 'e_head', spaced('LuxyBasement'), { font: SANS, size: 30, color: GOLD, y: top - 140 }),
    textFilter(dir, 'e_brand', brand.toUpperCase(), { font: SERIF, size: 84, color: GOLD, y: top }),
    ...endTitle.map((line, i) => textFilter(dir, `e_t${i}`, line, { font: SANS, size: 40, color: TEXT, y: top + 140 + i * 56 })),
    textFilter(dir, 'e_price', price, { font: SERIF, size: 72, color: TEXT, y: top + 170 + endTitle.length * 56 + 30 }),
    textFilter(dir, 'e_offer', 'Offers welcome on every piece', { font: SANS, size: 38, color: GOLD, y: top + 320 + endTitle.length * 56 + 40 }),
    textFilter(dir, 'e_tap', 'Tap the tag to shop', { font: SANS, size: 32, color: MUTED, y: top + 380 + endTitle.length * 56 + 50 }),
  ];
  f.push(`color=c=${BG}:s=${W}x${H}:d=${END}:r=${FPS},format=yuv420p,${end.join(',')}[end]`);
  f.push(`[main][end]xfade=transition=fade:duration=${FADE}:offset=${(slides - FADE).toFixed(3)},format=yuv420p[v]`);

  // A silent track: some players and Instagram's own checks expect audio.
  const audio = ['-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...inputs, ...audio,
    '-filter_complex', f.join(';'),
    '-map', '[v]', '-map', `${n}:a`,
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    outPath,
  ], { stdio: 'inherit' });

  rmSync(dir, { recursive: true, force: true });
  return { seconds: total, photos: n };
}

/* --------------------------------------------------------------- posting */

class ApiError extends Error {
  constructor(message, code, subcode) { super(message); this.code = code; this.subcode = subcode; }
}

async function api(path, { method = 'GET', params = {} } = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === 'GET' ? `${API}/${path}?${body}` : `${API}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new ApiError(`${method} ${path} failed: ${e.message || res.status} (code ${e.code ?? '?'}${e.error_subcode ? '/' + e.error_subcode : ''})`, e.code, e.error_subcode);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Instagram (with Instagram Login) only takes a Reel from a public URL. So the
 * video is pushed alone to a throwaway branch, reel-media, and served through
 * jsDelivr's free CDN, which sends the video/mp4 type Instagram wants. Each
 * Reel force-pushes over the last, so nothing piles up in the repository.
 */
async function hostVideo(file, name) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are needed to host the video');
  const dir = join('work', 'media');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.mp4`), readFileSync(file));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
  git('init', '-q', '-b', 'reel-media');
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'add', '.');
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', `Reel: ${name}`);
  git('push', '-q', '-f', `https://x-access-token:${token}@github.com/${repo}.git`, 'HEAD:refs/heads/reel-media');
  const sha = git('rev-parse', 'HEAD');

  const candidates = [
    `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${name}.mp4`,
    `https://raw.githubusercontent.com/${repo}/${sha}/${name}.mp4`,
  ];
  for (let i = 0; i < 12; i++) {
    for (const url of candidates) {
      const res = await fetch(url, { method: 'HEAD' }).catch(() => null);
      if (res?.ok) { console.log(`Video hosted at ${url} (${res.headers.get('content-type')})`); return url; }
    }
    await sleep(5000);
  }
  throw new Error('hosted video never became reachable');
}

async function publishReel(igId, videoUrl, caption) {
  const container = await api(`${igId}/media`, {
    method: 'POST',
    params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' },
  });
  for (let i = 0; i < 60; i++) {
    const { status_code: status, status: detail } = await api(container.id, { params: { fields: 'status_code,status' } });
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`reel ${status}: ${detail || ''}`);
    await sleep(10000);
  }
  for (let i = 1; ; i++) {
    try {
      return (await api(`${igId}/media_publish`, { method: 'POST', params: { creation_id: container.id } })).id;
    } catch (err) {
      if (err.subcode !== 2207027 || i === 4) throw err;
      await sleep(20000);
    }
  }
}

/** Next piece to reel: in stock, at least three usable photos, not reeled yet. */
function nextItems(feed, done, count) {
  // A failed reel gets one more try; after that it is "skipped".
  const usable = feed.filter((i) => i.inStock && (!done[i.handle] || done[i.handle].status === 'failed') && photosFor(i).length >= 2);
  usable.sort((a, b) => Math.min(photosFor(b).length, 4) - Math.min(photosFor(a).length, 4));
  return usable.slice(0, count);
}

const pacificHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

async function main() {
  const feed = await loadFeed();
  if (!feed) process.exit(75);
  const done = existsSync('reels.json') ? JSON.parse(readFileSync('reels.json', 'utf8')) : {};

  if (MODE === 'preview') {
    const wanted = (process.env.HANDLES || '').split(',').map((s) => s.trim()).filter(Boolean);
    const items = wanted.length
      ? wanted.map((h) => feed.find((i) => i.handle === h)).filter(Boolean)
      : nextItems(feed, done, Number(process.env.REEL_COUNT || 2));
    mkdirSync('previews', { recursive: true });
    for (const item of items) {
      const out = join('previews', `${item.handle}.mp4`);
      const { seconds, photos } = await renderReel(item, out);
      // Stills of the photo frame and the end card, for a quick look at layout.
      for (const [name, at] of [['frame', 1.5], ['end', seconds - 0.8]]) {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(at), '-i', out, '-frames:v', '1', '-vf', 'scale=540:-1', join('previews', `${item.handle}.${name}.jpg`)]);
      }
      writeFileSync(join('previews', `${item.handle}.txt`), captionFor(item, Object.keys(done).length).replace('Shop via the link in our bio.', 'Tap the tag to shop, or use the link in our bio.'));
      console.log(`Rendered ${out}: ${seconds.toFixed(1)}s from ${photos} photos.`);
    }
    return;
  }

  if (MODE === 'post') {
    if (!TOKEN) { console.log('IG_ACCESS_TOKEN is not set.'); return; }
    const hour = pacificHour();
    if (hour < 8 || hour >= 23) { console.log('Outside posting hours.'); process.exit(75); }
    const [item] = nextItems(feed, done, 1);
    if (!item) { console.log('Every piece in stock already has a reel.'); return; }

    const { id: igId } = await api('me', { params: { fields: 'id' } });
    mkdirSync('work', { recursive: true });
    const file = join('work', `${item.handle}.mp4`);
    await renderReel(item, file);
    const caption = captionFor(item, Object.keys(done).length)
      .replace('Shop via the link in our bio.', 'Tap the tag to shop, or use the link in our bio.');
    try {
      const videoUrl = await hostVideo(file, item.handle.slice(0, 80));
      const mediaId = await publishReel(igId, videoUrl, caption);
      const { permalink } = await api(mediaId, { params: { fields: 'permalink' } }).catch(() => ({}));
      done[item.handle] = { status: 'published', title: item.title, mediaId, permalink, at: new Date().toISOString() };
      console.log(`Reel published: ${permalink || mediaId}`);
    } catch (err) {
      if ([4, 9, 17, 32, 613].includes(err.code)) { console.error(err.message); process.exit(75); }
      if ([368, 190, 10, 200].includes(err.code)) { console.error(err.message); process.exit(76); }
      const prior = done[item.handle];
      done[item.handle] = { status: prior?.status === 'failed' ? 'skipped' : 'failed', title: item.title, error: err.message, at: new Date().toISOString() };
      console.error(`Reel failed for ${item.title}: ${err.message}`);
    } finally {
      writeFileSync('reels.json', `${JSON.stringify(done, null, 2)}\n`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
