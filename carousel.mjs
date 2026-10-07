/**
 * Themed carousels: "Under $500", "Size 37 shoes", "Pieces from Hermès"...
 *
 * A roundup is the kind of post people save and send to a friend, which is
 * what earns reach beyond the account's followers. Each carousel is a cover
 * slide (theme title over a grid of four of the pieces) and then one slide per
 * piece with its brand, name and price. Every product slide is tagged with its
 * piece by tag.mjs, so each one has its own shopping bag.
 *
 * Themes are worked out from the live shop each run, so sold pieces never
 * appear. A theme isn't repeated within REPEAT_DAYS, and pieces that have been
 * in fewer carousels go first.
 *
 * Slides are rendered with ffmpeg and hosted on jsDelivr through the
 * carousel-media branch, the same way reel.mjs hosts video (Instagram only
 * takes images by public URL).
 *
 * MODE=preview  render the next carousel (or THEME) to previews/ without posting.
 * MODE=post     render and publish it; carousels.json records what went out.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeed, photosFor, postTitle, hashtags } from './feed.mjs';

const MODE = process.env.MODE || 'preview';
const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;
const REPEAT_DAYS = 14;
const MIN_PIECES = 4, MAX_PIECES = 9;      // Instagram allows 10 slides; one is the cover

const W = 1080, H = 1350;                   // 4:5, the tallest feed shape
const BG = '0x0A0A0A', GOLD = '0xC9A96E', TEXT = '0xE5E5E5', MUTED = '0x8C8C8C';
const SERIF = 'fonts/PlayfairDisplay.ttf', SANS = 'fonts/SpaceGrotesk.ttf';

const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------------------------------------------------------- themes */

const JEWELRY = ['Bracelet', 'Necklace', 'Earrings', 'Ring', 'Jewelry', 'Brooch'];
const sizeOf = (item) => (item.title.match(/\b(?:Size\s*)?(3[4-9](?:\.5)?|4[0-2](?:\.5)?)\b/i) || [])[1];
const isShoe = (i) => i.productType === 'Shoes';

/** Every theme the current stock can fill, each with its matching pieces. */
function themes(stock) {
  const out = [];
  const add = (key, title, kicker, items) => { if (items.length >= MIN_PIECES) out.push({ key, title, kicker, items }); };

  const byBrand = new Map();
  for (const i of stock) {
    const b = (i.brand || '').trim();
    if (b) byBrand.set(b, [...(byBrand.get(b) || []), i]);
  }
  for (const [brand, items] of byBrand) add(`brand:${slug(brand)}`, `Pieces from ${brand}`, 'The edit', items);

  add('type:bags', 'The bag edit', 'Carry it', stock.filter((i) => /Handbag|Bag/i.test(i.productType)));
  add('type:shoes', 'The shoe edit', 'Step in', stock.filter(isShoe));
  add('type:jewelry', 'The jewelry edit', 'Finishing touches', stock.filter((i) => JEWELRY.includes(i.productType)));
  add('type:sunglasses', 'The sunglasses edit', 'Eyes on', stock.filter((i) => i.productType === 'Sunglasses'));
  add('type:scarves', 'Scarves and twillies', 'Tie it on', stock.filter((i) => i.productType === 'Scarf'));
  add('type:small', 'Small leather goods', 'Pocket-sized', stock.filter((i) => /Wallet|Accessories/i.test(i.productType) && !/Sunglasses/i.test(i.title)));

  add('price:300', 'Under $300', 'Designer for less', stock.filter((i) => i.price < 300));
  add('price:500', 'Under $500', 'Designer for less', stock.filter((i) => i.price >= 300 && i.price < 500));
  add('price:1000', 'Under $1,000', 'Designer for less', stock.filter((i) => i.price >= 500 && i.price < 1000));
  add('price:5000', 'Statement pieces', 'Investment buys', stock.filter((i) => i.price >= 5000));

  const sizes = new Map();
  for (const i of stock.filter(isShoe)) {
    const s = sizeOf(i);
    if (s) sizes.set(s, [...(sizes.get(s) || []), i]);
  }
  for (const [size, items] of sizes) add(`size:${size}`, `Shoes in size ${size}`, 'Your size', items);

  return out;
}

/** The theme least recently used, filled with the least-featured pieces. */
function pickTheme(stock, done, wanted) {
  const usable = stock.filter((i) => photosFor(i).length >= 1);
  const all = themes(usable);
  if (wanted) return all.find((t) => t.key === wanted);

  const now = Date.now();
  done = done.filter((d) => d.status === 'published');
  const lastUsed = (key) => Math.max(0, ...done.filter((d) => d.theme === key).map((d) => Date.parse(d.at)));
  const featured = new Map();
  for (const d of done) for (const h of d.handles || []) featured.set(h, (featured.get(h) || 0) + 1);

  const fresh = all.filter((t) => now - lastUsed(t.key) > REPEAT_DAYS * 864e5);
  if (!fresh.length) return undefined;
  // Never used first, then oldest; among equals, the theme with more pieces.
  fresh.sort((a, b) => lastUsed(a.key) - lastUsed(b.key) || b.items.length - a.items.length);
  const theme = fresh[0];
  theme.items = [...theme.items]
    .sort((a, b) => (featured.get(a.handle) || 0) - (featured.get(b.handle) || 0) || b.price - a.price)
    .slice(0, MAX_PIECES);
  return theme;
}

/* --------------------------------------------------------------- slides */

function wrap(text, width, lines) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= width) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '') + '…'; }
  return out;
}

const spaced = (s) => s.toUpperCase().split('').join(' ');

function shortTitle(item) {
  const t = postTitle(item.title);
  const brand = (item.brand || '').toLowerCase();
  return brand && t.toLowerCase().startsWith(brand) ? t.slice(brand.length).trim() : t;
}

function text(dir, name, value, { font, size, color, y, x = '(w-text_w)/2' }) {
  const file = join(dir, `${name}.txt`);
  writeFileSync(file, value);
  return `drawtext=fontfile=${font}:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:expansion=none`;
}

const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo ${res.status}: ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

/** One piece: photo, then brand, name and price beneath. */
function productSlide(dir, item, photo, out, n) {
  const title = wrap(shortTitle(item), 40, 2);
  const draw = [
    text(dir, `b${n}`, (item.brand || 'LuxyBasement').toUpperCase(), { font: SERIF, size: 52, color: GOLD, y: 1050 }),
    ...title.map((l, i) => text(dir, `t${n}_${i}`, l, { font: SANS, size: 34, color: TEXT, y: 1135 + i * 46 })),
    text(dir, `p${n}`, money(item.price), { font: SERIF, size: 44, color: TEXT, y: 1150 + title.length * 46 + 14 }),
  ];
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=${BG}:s=${W}x${H}`, '-i', photo,
    '-filter_complex', `[1:v]scale=900:900[ph];[0:v][ph]overlay=90:110,${draw.join(',')}`,
    '-frames:v', '1', '-q:v', '2', out,
  ]);
}

/** Cover: the theme over a two-by-two grid of the first four pieces. */
function coverSlide(dir, theme, photos, out) {
  const title = wrap(theme.title, 22, 2);
  const draw = [
    text(dir, 'c_head', spaced('LuxyBasement'), { font: SANS, size: 26, color: GOLD, y: 70 }),
    ...title.map((l, i) => text(dir, `c_t${i}`, l, { font: SERIF, size: 78, color: GOLD, y: 130 + i * 92 })),
    text(dir, 'c_sub', `${theme.items.length} pieces  ·  offers welcome on every one`, { font: SANS, size: 32, color: TEXT, y: 150 + title.length * 92 + 10 }),
    text(dir, 'c_swipe', 'Swipe to shop  →', { font: SANS, size: 28, color: MUTED, y: 1290 }),
  ];
  const top = 170 + title.length * 92 + 80;
  const cell = Math.min(440, Math.floor((1250 - top - 20) / 2));
  const left = (W - (cell * 2 + 20)) / 2;
  const grid = photos.slice(0, 4);
  const inputs = grid.flatMap((p) => ['-i', p]);
  let chain = '';
  grid.forEach((_, i) => { chain += `[${i + 1}:v]scale=${cell}:${cell}[g${i}];`; });
  let base = '[0:v]';
  grid.forEach((_, i) => {
    const x = left + (i % 2) * (cell + 20), y = top + Math.floor(i / 2) * (cell + 20);
    chain += `${base}[g${i}]overlay=${x}:${y}[o${i}];`;
    base = `[o${i}]`;
  });
  chain += `${base}${draw.join(',')}`;
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${BG}:s=${W}x${H}`, ...inputs, '-filter_complex', chain, '-frames:v', '1', '-q:v', '2', out]);
}

export async function renderCarousel(theme, outDir) {
  const dir = join('work', 'carousel');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const photos = [];
  for (const [n, item] of theme.items.entries()) {
    const f = join(dir, `photo${n}.jpg`);
    await download(photosFor(item)[0], f);
    photos.push(f);
  }
  const slides = [join(outDir, '00-cover.jpg')];
  coverSlide(dir, theme, photos, slides[0]);
  theme.items.forEach((item, n) => {
    const out = join(outDir, `${String(n + 1).padStart(2, '0')}-${slug(item.handle).slice(0, 40)}.jpg`);
    productSlide(dir, item, photos[n], out, n);
    slides.push(out);
  });
  rmSync(dir, { recursive: true, force: true });
  return slides;
}

/* --------------------------------------------------------------- caption */

function captionFor(theme, n) {
  const brands = [...new Set(theme.items.map((i) => (i.brand || '').trim().replace(/\.$/, '')).filter(Boolean))];
  const list = theme.items.map((i, k) => `${k + 1}. ${postTitle(i.title)}, ${money(i.price)}`).join('\n');
  const names = brands.length > 1 ? `${brands.slice(0, -1).join(', ')} or ${brands.at(-1)}` : brands[0];
  return [
    `${theme.title}. ${theme.items.length} pieces, each one of one.`,
    '',
    list,
    '',
    'Every piece is promised authentic, backed by our money-back guarantee.',
    '',
    'Offers welcome on any piece, or make one offer on several. A real person reads every one.',
    '',
    'Tap a tag to shop, or use the link in our bio. Pieces sell, so some may be gone by the time you see this.',
    '',
    `Disclaimer: LuxyBasement is an independent reseller and is not affiliated with ${names}. `
      + 'These brands are not responsible for these products and do not guarantee their authenticity. '
      + 'All trademarks belong to their respective owners.',
    '',
    hashtags(theme.items[0], n).join(' '),
  ].join('\n');
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

/** Push the slides alone to the carousel-media branch and return jsDelivr URLs. */
async function hostImages(files) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are needed to host the slides');
  const dir = join('work', 'carousel-media');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) copyFileSync(f, join(dir, f.split(/[\\/]/).pop()));
  const id = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
  git('init', '-q', '-b', 'carousel-media');
  git(...id, 'add', '.');
  git(...id, 'commit', '-q', '-m', 'Carousel slides');
  git('push', '-q', '-f', `https://x-access-token:${token}@github.com/${repo}.git`, 'HEAD:refs/heads/carousel-media');
  const sha = git('rev-parse', 'HEAD');
  const urls = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
    .map((f) => `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${f}`);
  for (let i = 0; i < 12; i++) {
    const res = await fetch(urls[0], { method: 'HEAD' }).catch(() => null);
    if (res?.ok) return urls;
    await sleep(5000);
  }
  throw new Error('hosted slides never became reachable');
}

async function waitUntilReady(id) {
  for (let i = 0; i < 30; i++) {
    const { status_code: status, status: detail } = await api(id, { params: { fields: 'status_code,status' } });
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${status}: ${detail || ''}`);
    await sleep(5000);
  }
  throw new Error('container not ready after 150s');
}

async function publish(igId, urls, caption) {
  const children = [];
  for (const url of urls) children.push((await api(`${igId}/media`, { method: 'POST', params: { image_url: url, is_carousel_item: 'true' } })).id);
  for (const c of children) await waitUntilReady(c);
  const container = (await api(`${igId}/media`, { method: 'POST', params: { media_type: 'CAROUSEL', children: children.join(','), caption } })).id;
  await waitUntilReady(container);
  for (let i = 1; ; i++) {
    try {
      return (await api(`${igId}/media_publish`, { method: 'POST', params: { creation_id: container } })).id;
    } catch (err) {
      if (err.subcode !== 2207027 || i === 4) throw err;
      await sleep(20000);
    }
  }
}

const pacificHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

async function main() {
  const feed = await loadFeed();
  if (!feed) process.exit(75);
  const stock = feed.filter((i) => i.inStock);
  const done = existsSync('carousels.json') ? JSON.parse(readFileSync('carousels.json', 'utf8')) : [];
  const theme = pickTheme(stock, done, process.env.THEME);
  if (!theme) { console.log('No theme is due yet.'); return; }
  console.log(`Theme: ${theme.title} (${theme.key}), ${theme.items.length} pieces.`);

  if (MODE === 'preview') {
    const outDir = join('previews', slug(theme.key));
    const slides = await renderCarousel(theme, outDir);
    writeFileSync(join(outDir, 'caption.txt'), captionFor(theme, done.length));
    console.log(`Rendered ${slides.length} slides to ${outDir}.`);
    return;
  }

  if (!TOKEN) { console.log('IG_ACCESS_TOKEN is not set.'); return; }
  const hour = pacificHour();
  if (hour < 8 || hour >= 23) { console.log('Outside posting hours.'); process.exit(75); }

  const { id: igId } = await api('me', { params: { fields: 'id' } });
  const slides = await renderCarousel(theme, join('work', 'slides'));
  const record = { theme: theme.key, title: theme.title, handles: theme.items.map((i) => i.handle), at: new Date().toISOString() };
  try {
    const urls = await hostImages(slides);
    const mediaId = await publish(igId, urls, captionFor(theme, done.length));
    const { permalink } = await api(mediaId, { params: { fields: 'permalink' } }).catch(() => ({}));
    Object.assign(record, { status: 'published', mediaId, permalink });
    console.log(`Carousel published: ${permalink || mediaId}`);
  } catch (err) {
    Object.assign(record, { status: 'failed', error: err.message });
    console.error(`Carousel failed: ${err.message}`);
    if ([4, 9, 17, 32, 613].includes(err.code)) process.exitCode = 75;
    else if ([368, 190, 10, 200].includes(err.code)) process.exitCode = 76;
  } finally {
    done.push(record);
    writeFileSync('carousels.json', `${JSON.stringify(done, null, 2)}\n`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
