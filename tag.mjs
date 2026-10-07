/**
 * Tags each Instagram post with its product from the Meta shop, so the post
 * gets a shopping bag that opens the piece.
 *
 * Product tagging only exists in the Instagram API with Facebook Login
 * (graph.facebook.com), not the Instagram Login API that publish.mjs posts
 * through. So this uses its own credential, FB_ACCESS_TOKEN: a long-lived
 * Facebook user token for the AutoSocialPoster app with instagram_basic,
 * instagram_shopping_tag_products, catalog_management, business_management,
 * pages_show_list and pages_read_engagement. Media IDs are the same in both
 * APIs, so the mediaId publish.mjs records is all this needs.
 *
 * Post → product: posts.json gives each post's shop handle, the shop's Meta
 * feed maps the handle to its retailer ID, and the catalogue maps that to the
 * product ID Instagram tags with. Sold pieces are skipped.
 *
 * Progress lives in tags.json, keyed by mediaId. Newest posts go first, so a
 * piece that has just gone up is tagged on the next run; the backlog drains a
 * few at a time behind it.
 *
 * TAG_LIMIT  how many posts to tag this run (default 5).
 * Exit 76 means Meta refused the token, the same convention as publish.mjs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://graph.facebook.com/v23.0';
const TOKEN = process.env.FB_ACCESS_TOKEN;
const CATALOG_ID = process.env.CATALOG_ID || '3077657132582274';
const FEED_URL = 'https://www.luxybasement.com/feed/meta.csv';
const LIMIT = Number(process.env.TAG_LIMIT || 5);
// Gentle on purpose: the posting app has been blocked for bursts before.
const GAP_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${API}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });
  const json = await res.json();
  if (json.error) {
    const err = new Error(`${json.error.message} (code ${json.error.code})`);
    err.code = json.error.code;
    throw err;
  }
  return json;
}

/** Minimal RFC 4180 reader: the feed quotes every field. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function shopByHandle() {
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const map = new Map();
  for (const item of parseCsv(await res.text())) {
    const handle = item.link?.split('/products/')[1];
    if (handle) map.set(handle, { retailerId: item.id, inStock: item.availability === 'in stock' });
  }
  return map;
}

async function catalogProducts() {
  const map = new Map();
  let after;
  do {
    const page = await api(`${CATALOG_ID}/products`, {
      params: { fields: 'id,retailer_id', limit: '100', ...(after ? { after } : {}) },
    });
    for (const p of page.data || []) map.set(p.retailer_id, p.id);
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
  } while (after);
  return map;
}

/**
 * Carousel tags go on a child image; a single image is tagged directly. A Reel
 * is tagged on itself, without a position (video tags have no x/y).
 */
async function tagTarget(mediaId) {
  const media = await api(mediaId, { params: { fields: 'media_type,children{id,media_type}' } });
  if (media.media_type === 'CAROUSEL_ALBUM') {
    const child = media.children?.data?.find((c) => c.media_type === 'IMAGE');
    return child && { id: child.id, video: false };
  }
  if (media.media_type === 'IMAGE') return { id: mediaId, video: false };
  if (media.media_type === 'VIDEO') return { id: mediaId, video: true };
  return undefined;
}

async function main() {
  if (!TOKEN) {
    console.log('FB_ACCESS_TOKEN is not set yet, so there is nothing to tag. See README.md.');
    return;
  }

  const posts = JSON.parse(readFileSync('posts.json', 'utf8'));
  const published = JSON.parse(readFileSync('published.json', 'utf8'));
  // Reels are keyed by shop handle; give them the same shape as feed posts.
  const reels = existsSync('reels.json') ? JSON.parse(readFileSync('reels.json', 'utf8')) : {};
  for (const [handle, r] of Object.entries(reels)) published[`reel:${handle}`] = r;
  const tags = existsSync('tags.json') ? JSON.parse(readFileSync('tags.json', 'utf8')) : {};
  const handleOf = new Map(posts.map((p) => [p.id, p.handle]));

  const todo = Object.entries(published)
    .filter(([, s]) => s.status === 'published' && s.mediaId && !tags[s.mediaId])
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)));

  console.log(`${todo.length} posts not tagged yet; tagging up to ${LIMIT} this run.`);
  if (!todo.length) return;

  const [shop, catalog] = await Promise.all([shopByHandle(), catalogProducts()]);
  console.log(`Shop feed: ${shop.size} pieces. Catalogue: ${catalog.size} products.`);

  const save = () => writeFileSync('tags.json', `${JSON.stringify(tags, null, 2)}\n`);
  let done = 0;

  for (const [postId, state] of todo) {
    if (done >= LIMIT) break;
    const { mediaId, title } = state;
    const handle = handleOf.get(postId) || postId.match(/^(?:shop|reel):(.+)$/)?.[1];
    const piece = handle && shop.get(handle);
    const record = (status, extra = {}) => {
      tags[mediaId] = { status, title, at: new Date().toISOString(), ...extra };
      save();
    };

    // Not in the feed means sold or unlisted; a tag would point at nothing.
    if (!piece || !piece.inStock) { record('sold'); continue; }
    const productId = catalog.get(piece.retailerId);
    if (!productId) { console.log(`Not in the catalogue yet, will retry: ${title}`); continue; }

    try {
      const target = await tagTarget(mediaId);
      if (!target) { record('untaggable', { note: 'not an image post or reel' }); continue; }

      const existing = await api(`${target.id}/product_tags`);
      if ((existing.data || []).some((t) => String(t.product_id) === String(productId))) {
        record('tagged', { productId, note: 'already tagged' });
        continue;
      }

      const tag = target.video ? { product_id: productId } : { product_id: productId, x: 0.5, y: 0.5 };
      await api(`${target.id}/product_tags`, {
        method: 'POST',
        params: { updated_tags: JSON.stringify([tag]) },
      });
      record('tagged', { productId });
      console.log(`Tagged: ${title} ${state.permalink || mediaId}`);
      done++;
      await sleep(GAP_MS);
    } catch (err) {
      // 190 bad/expired token, 10 or 200 permission missing: stop, don't churn.
      if ([190, 10, 200].includes(err.code)) {
        console.error(`Meta refused the token: ${err.message}`);
        process.exit(76);
      }
      console.error(`Could not tag ${title}: ${err.message}`);
      record('failed', { error: err.message });
    }
  }
  console.log(`Tagged ${done} this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
