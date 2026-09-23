/**
 * Publishes the next LuxyBasement post to Instagram.
 *
 * Runs on a GitHub Actions schedule (see .github/workflows/publish.yml). Each
 * run posts at most one piece: the first entry in posts.json that is not yet
 * in published.json. The workflow then commits published.json, so the queue
 * picks up where it left off next time.
 *
 * Uses the Instagram API with Instagram Login (graph.instagram.com). The only
 * credential is IG_ACCESS_TOKEN, a long-lived token stored as a repository
 * secret. It is never printed.
 *
 * MODE=check   verify the token, account, quota and next post; posts nothing.
 * MODE=publish post the next piece (the default for scheduled runs).
 */
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;
const MODE = process.env.MODE || 'publish';

// A post that fails twice is skipped so one bad listing cannot stall the queue.
const MAX_ATTEMPTS = 2;
// GitHub can delay scheduled runs, which sometimes bunches two together. Never
// post twice inside this window, so the feed keeps its even spacing.
const MIN_GAP_MINUTES = 45;

async function api(path, { method = 'GET', params = {} } = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === 'GET' ? `${API}/${path}?${body}` : `${API}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`${method} ${path.split('?')[0]} failed: ${e.message || res.status} (code ${e.code ?? '?'}${e.error_subcode ? '/' + e.error_subcode : ''})`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Containers are processed asynchronously; publish only once one is FINISHED. */
async function waitUntilReady(containerId) {
  for (let i = 0; i < 30; i++) {
    const { status_code: status, status: detail } = await api(containerId, { params: { fields: 'status_code,status' } });
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${status}: ${detail || 'no detail'}`);
    await sleep(5000);
  }
  throw new Error('container not ready after 150s');
}

async function createContainer(igId, post) {
  if (post.media.length === 1) {
    return (await api(`${igId}/media`, { method: 'POST', params: { image_url: post.media[0], caption: post.caption } })).id;
  }
  const children = [];
  for (const url of post.media) {
    children.push((await api(`${igId}/media`, { method: 'POST', params: { image_url: url, is_carousel_item: 'true' } })).id);
  }
  for (const id of children) await waitUntilReady(id);
  return (await api(`${igId}/media`, {
    method: 'POST',
    params: { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption },
  })).id;
}

async function main() {
  if (!TOKEN) {
    console.log('IG_ACCESS_TOKEN is not set yet, so there is nothing to do. See README.md for setup.');
    return;
  }

  const posts = JSON.parse(await readFile('posts.json', 'utf8'));
  const state = JSON.parse(await readFile('published.json', 'utf8'));
  const save = () => writeFile('published.json', JSON.stringify(state, null, 1) + '\n');

  const me = await api('me', { params: { fields: 'user_id,username' } });
  const igId = me.user_id || me.id;
  const done = posts.filter((p) => state[p.id]?.status === 'published').length;
  const next = posts.find((p) => !state[p.id] || (state[p.id].status === 'failed' && state[p.id].attempts < MAX_ATTEMPTS));
  console.log(`Account @${me.username}: ${done}/${posts.length} posted.`);

  if (MODE === 'check') {
    const quota = await api(`${igId}/content_publishing_limit`, { params: { fields: 'quota_usage,config' } }).catch((e) => ({ error: e.message }));
    console.log('Publishing quota (last 24h):', JSON.stringify(quota.data?.[0] || quota));
    if (!next) return console.log('Queue is empty.');
    console.log(`Next up: ${next.title} (${next.media.length} photo${next.media.length > 1 ? 's' : ''})`);
    // Instagram's API takes JPEG only; make sure every photo arrives as one.
    for (const url of next.media) {
      const res = await fetch(url, { method: 'HEAD', headers: { Accept: 'image/avif,image/webp,image/*' } });
      console.log(`  ${res.status} ${res.headers.get('content-type')}  ${url.split('?')[0].split('/').pop()}`);
    }
    return console.log('Check passed. Nothing was posted.');
  }

  if (!next) return console.log('Queue is empty. All posts are published.');

  const last = Object.values(state).map((s) => s.at).filter(Boolean).sort().pop();
  if (last && Date.now() - Date.parse(last) < MIN_GAP_MINUTES * 60e3) {
    return console.log(`Last post went out at ${last}; waiting for the next slot to keep the spacing even.`);
  }

  console.log(`Posting: ${next.title}`);
  try {
    const container = await createContainer(igId, next);
    await waitUntilReady(container);
    const { id: mediaId } = await api(`${igId}/media_publish`, { method: 'POST', params: { creation_id: container } });
    // Record it before anything else can fail, so it is never posted twice.
    state[next.id] = { status: 'published', title: next.title, mediaId, at: new Date().toISOString() };
    await save();
    const { permalink } = await api(mediaId, { params: { fields: 'permalink' } }).catch(() => ({}));
    if (permalink) {
      state[next.id].permalink = permalink;
      await save();
    }
    console.log(`Published: ${permalink || mediaId}`);
  } catch (err) {
    const attempts = (state[next.id]?.attempts || 0) + 1;
    state[next.id] = { status: 'failed', title: next.title, attempts, error: err.message, lastTried: new Date().toISOString() };
    await save();
    console.error(`Failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${err.message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
