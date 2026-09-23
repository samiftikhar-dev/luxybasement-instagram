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
 *
 * Exit codes, which the workflow uses to decide whether to keep going:
 *   0  posted, or nothing to do
 *   1  this post failed; the next one can still go
 *   75 hit Instagram's posting quota or a rate limit; stop quietly, try later
 *   76 Instagram blocked the action; stop and flag it, a person should look
 */
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_ACCESS_TOKEN;
const MODE = process.env.MODE || 'publish';

// A post that fails twice is skipped so one bad listing cannot stall the queue.
const MAX_ATTEMPTS = 2;
// GitHub can delay scheduled runs, which sometimes bunches two together. Never
// post twice inside this window, so the feed keeps its spacing. Burst runs set
// their own spacing and pass 0.
const MIN_GAP_MINUTES = Number(process.env.MIN_GAP_MINUTES ?? 8);
// Leave a little of the rolling 24-hour API quota unused.
const QUOTA_HEADROOM = 2;

// Throttling and quota errors clear on their own; wait them out.
const RATE_LIMIT_CODES = new Set([4, 9, 17, 32, 613]);
const QUOTA_SUBCODES = new Set([2207042]);
// A block or spam flag does not clear by retrying; stop and let a person look.
const BLOCKED_CODES = new Set([368]);

class ApiError extends Error {
  constructor(message, code, subcode) {
    super(message);
    this.code = code;
    this.subcode = subcode;
  }
}

async function api(path, { method = 'GET', params = {} } = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === 'GET' ? `${API}/${path}?${body}` : `${API}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new ApiError(
      `${method} ${path.split('?')[0]} failed: ${e.message || res.status} (code ${e.code ?? '?'}${e.error_subcode ? '/' + e.error_subcode : ''})`,
      e.code, e.error_subcode,
    );
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

/**
 * Instagram sometimes answers media_publish with "Media ID is not available"
 * (2207027) while the container is still settling, and occasionally publishes
 * anyway. Retry the same container a few times rather than building a new one.
 */
async function publishContainer(igId, container) {
  for (let i = 1; ; i++) {
    try {
      return (await api(`${igId}/media_publish`, { method: 'POST', params: { creation_id: container } })).id;
    } catch (err) {
      if (err.subcode !== 2207027 || i === 4) throw err;
      console.log(`Instagram not ready to publish yet (try ${i}); waiting 20s.`);
      await sleep(20000);
    }
  }
}

/** The account's recent posts, keyed by first caption line, to catch posts that went up despite an error. */
async function recentByHeadline(igId, limit = 50) {
  const { data = [] } = await api(`${igId}/media`, { params: { fields: 'id,caption,permalink,timestamp', limit: String(limit) } });
  return new Map(data.filter((m) => m.caption).map((m) => [m.caption.split('\n')[0], m]));
}
const headline = (post) => post.caption.split('\n')[0];

async function quota(igId) {
  const res = await api(`${igId}/content_publishing_limit`, { params: { fields: 'quota_usage,config' } });
  const q = res.data?.[0] || {};
  return { used: q.quota_usage ?? 0, total: q.config?.quota_total ?? 100 };
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

  if (MODE === 'reconcile') {
    // Settle every failed entry against what is actually on the account: mark
    // it published if it went up anyway, otherwise give it fresh attempts.
    const { data: all = [] } = await api(`${igId}/media`, { params: { fields: 'id,caption,permalink,timestamp', limit: '100' } });
    const recent = new Map(all.filter((m) => m.caption).map((m) => [m.caption.split('\n')[0], m]));
    const dupes = {};
    all.forEach((m) => { const h = (m.caption || '').split('\n')[0]; dupes[h] = (dupes[h] || 0) + 1; });
    for (const p of posts) {
      const s = state[p.id];
      if (!s || s.status !== 'failed') continue;
      const live = recent.get(headline(p));
      if (live) {
        state[p.id] = { status: 'published', title: p.title, mediaId: live.id, at: live.timestamp, permalink: live.permalink, note: 'went up despite an error' };
        console.log(`On the account after all: ${p.title} ${live.permalink}${dupes[headline(p)] > 1 ? `  (appears ${dupes[headline(p)]} times)` : ''}`);
      } else {
        state[p.id] = { ...s, attempts: 0 };
        console.log(`Not on the account; will retry: ${p.title}`);
      }
    }
    const repeated = Object.entries(dupes).filter(([, n]) => n > 1);
    console.log(repeated.length ? `Posted more than once: ${repeated.map(([h, n]) => `${h} (${n}x)`).join('; ')}` : 'No duplicate posts in the last 100.');
    await save();
    return;
  }

  if (MODE === 'check') {
    const q = await quota(igId).catch((e) => ({ error: e.message }));
    console.log('Publishing quota (last 24h):', JSON.stringify(q));
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

  const q = await quota(igId);
  if (q.used >= q.total - QUOTA_HEADROOM) {
    console.log(`Instagram's 24-hour posting quota is nearly used (${q.used}/${q.total}); waiting for it to free up.`);
    process.exitCode = 75;
    return;
  }

  // A retry of a post that errored last time may already be live.
  if (state[next.id]?.status === 'failed') {
    const live = (await recentByHeadline(igId, 25)).get(headline(next));
    if (live) {
      state[next.id] = { status: 'published', title: next.title, mediaId: live.id, at: live.timestamp, permalink: live.permalink, note: 'went up despite an error' };
      await save();
      return console.log(`Already on the account, not posting again: ${live.permalink}`);
    }
  }

  console.log(`Posting (${q.used + 1}/${q.total} in the last 24h): ${next.title}`);
  try {
    const container = await createContainer(igId, next);
    await waitUntilReady(container);
    const mediaId = await publishContainer(igId, container);
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
    // Limits and blocks say nothing about this post, so they don't count as
    // one of its attempts; it will be first in line when posting resumes.
    if (RATE_LIMIT_CODES.has(err.code) || QUOTA_SUBCODES.has(err.subcode)) {
      console.log(`Instagram rate limit, will try again later: ${err.message}`);
      process.exitCode = 75;
      return;
    }
    if (BLOCKED_CODES.has(err.code)) {
      console.error(`Instagram blocked the post. Stopping so a person can check the account: ${err.message}`);
      process.exitCode = 76;
      return;
    }
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
