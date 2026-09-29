/**
 * Keeps the Instagram queue in step with the shop.
 *
 * Source: the site's public Google Merchant feed (https://www.luxybasement.com/feed.xml).
 * It's rebuilt from Shopify every 30 minutes, needs no credentials, and carries
 * everything a post needs: title, brand, type, condition, price, photos and
 * stock. It lists sold pieces too, marked out_of_stock, so stock comes from
 * <g:availability>, not from whether a product appears.
 *
 * Captions and hashtags follow the rules the account launched with:
 * - never "authenticated"; say "Promised authentic, backed by our
 *   money-back guarantee"
 * - a per-brand "not affiliated" disclaimer on every post
 * - at most five hashtags, none of them brand names, rotated across posts
 */

export const FEED_URL = 'https://www.luxybasement.com/feed.xml';

// Fewer in-stock items than this means the feed is broken, not that the shop
// sold out. Act on nothing rather than skip or add half the catalogue.
const MIN_PLAUSIBLE_ITEMS = 50;

const unCdata = (s = '') => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').replace(/]]&gt;/g, ']]>').trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unCdata(m[1]) : '';
};

export function parseFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, b]) => ({
    handle: (tag(b, 'link').match(/\/products\/([^/?#]+)/) || [])[1],
    title: tag(b, 'title'),
    description: tag(b, 'description'),
    brand: tag(b, 'g:brand'),
    productType: tag(b, 'g:product_type') || 'Accessories',
    condition: tag(b, 'g:custom_label_0'),
    price: parseFloat(tag(b, 'g:price')) || 0,
    images: [tag(b, 'g:image_link'), ...[...b.matchAll(/<g:additional_image_link>([^<]+)</g)].map((m) => m[1])].filter(Boolean),
    inStock: tag(b, 'g:availability') === 'in_stock',
  })).filter((i) => i.handle);
}

/** The shop's current stock, or null when the feed can't be trusted this run. */
export async function loadFeed() {
  try {
    const res = await fetch(FEED_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text());
    if (items.filter((i) => i.inStock).length < MIN_PLAUSIBLE_ITEMS) {
      throw new Error(`only ${items.filter((i) => i.inStock).length} in-stock items`);
    }
    return items;
  } catch (err) {
    console.log(`Product feed unavailable (${err.message}); posting without the stock check this run.`);
    return null;
  }
}

/* --------------------------------------------------------------- captions */

const OPENERS = {
  Handbag: ['Just landed.', 'New to the vault.', 'This one won’t sit long.', 'Fresh in.'],
  Shoes: ['Just in.', 'New arrival.', 'Stepped into the vault.', 'Fresh in.'],
  Bracelet: ['New in the case.', 'Just landed.', 'Fresh to the vault.'],
  Necklace: ['New in the case.', 'Just landed.', 'Fresh to the vault.'],
  Earrings: ['New in the case.', 'Just landed.', 'Fresh to the vault.'],
  Ring: ['New in the case.', 'Just landed.'],
  Watch: ['On the wrist this week.', 'Just landed.', 'New to the vault.'],
  Sunglasses: ['Just in.', 'New arrival.', 'Fresh to the vault.'],
  Scarf: ['Just in.', 'New arrival.'],
  Wallet: ['Just in.', 'New arrival.'],
  Accessories: ['Just in.', 'New arrival.', 'Fresh to the vault.'],
};

const CONDITION_LINE = {
  Pristine: 'Pristine, shows as unworn.',
  'Like New': 'Like new.',
  'Gently Used': 'Gently used, honestly photographed.',
  'Well Used': 'Well loved, and priced for it.',
};

/** Stable pseudo-random pick, so a caption never changes between runs. */
function pick(list, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });

/**
 * One sentence from the listing's condition notes that actually assesses the
 * piece. The notes follow "Condition:" in the description; their first
 * sentence is sometimes a sales line, which is worse than saying nothing.
 */
function conditionDetail(description) {
  const at = description.lastIndexOf('Condition:');
  if (at < 0) return '';
  const sentences = description.slice(at + 10).split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  const salesTalk = (s) => /^(otherwise|however|additionally|also|but|and)\b/i.test(s) || /!/.test(s)
    || /\b(you|your|you're|step up|perfect for|ideal for|head over heels)\b/i.test(s)
    // A colon means the "sentence" ran into the next field ("... Includes: box"),
    // and captions never make their own authenticity claims.
    || /:/.test(s) || /authentic/i.test(s);
  const assesses = (s) => /\b(clean|pristine|unworn|excellent|scuff|scratch|creas|mark|stain|tarnish|wear|flaw|corner|hardware|interior|exterior|sole|lens|link|strap)\w*/i.test(s);
  return sentences.find((s) => assesses(s) && !salesTalk(s) && s.length > 20 && s.length < 160) || '';
}

function disclaimer(name) {
  const brand = name.replace(/\.$/, ''); // "Tiffany & Co." would end in a double stop
  return `Disclaimer: LuxyBasement is an independent reseller and is not affiliated with ${brand}. `
    + `${brand} is not responsible for this product and does not guarantee its authenticity. `
    + `${brand} is a registered trademark of ${brand}.`;
}

// Title as posted: "#313/500" would read as a hashtag, and marketplace
// shorthand "Auth" is dropped because posts only ever say "promised authentic".
export const postTitle = (title) => title.replace(/#(\d)/g, 'No. $1').replace(/\s+Auth(entic)?\.?$/i, '').trim();

const RESALE = ['prelovedluxury', 'luxuryresale', 'preownedluxury', 'secondhandluxury', 'designerresale', 'preloveddesigner', 'luxuryconsignment'];
const WIDE = ['sustainablefashion', 'luxuryforless', 'circularfashion', 'designerfinds', 'secondhandfashion', 'luxuryfinds', 'investmentpiece'];
const JEWELRY = ['finejewelry', 'prelovedjewelry', 'luxuryjewelry', 'designerjewelry', 'jewelryaddict', 'jewelrylover'];
const CATEGORY = {
  Handbag: ['designerbags', 'handbagcollector', 'bagsofinstagram', 'luxurybags', 'designerhandbags', 'handbagaddict', 'purseaddict'],
  Shoes: ['designershoes', 'prelovedshoes', 'luxuryshoes', 'shoeaddict', 'shoecollection', 'shoelover'],
  Bracelet: JEWELRY, Necklace: JEWELRY, Earrings: JEWELRY, Ring: JEWELRY,
  Watch: ['luxurywatches', 'watchcollector', 'watchesofinstagram', 'preownedwatches', 'watchfam'],
  Sunglasses: ['designersunglasses', 'luxuryeyewear', 'sunglassesfashion', 'eyewearstyle'],
  Scarf: ['silkscarf', 'designerscarf', 'scarfstyle', 'silkscarves', 'luxuryscarf'],
  Wallet: ['designerwallet', 'smallleathergoods', 'luxuryaccessories', 'cardholder'],
  Accessories: ['designeraccessories', 'luxuryaccessories', 'prelovedfashion', 'fashionaccessories'],
};

/** Five tags: shop, resale, two category, one broad. `n` rotates them. */
function hashtags(item, n) {
  const type = CATEGORY[item.productType] ? item.productType : 'Accessories';
  const pool = CATEGORY[type].filter((t) => !(/silk/.test(t) && /cashmere|wool/i.test(item.title)));
  const cat = [pool[(n * 2) % pool.length], pool[(n * 2 + 1) % pool.length]];
  // "Vintage Alhambra" is a current Van Cleef line, not a vintage piece.
  const wide = /vintage(?! alhambra)/i.test(item.title) && n % 2 === 0 ? 'vintagedesigner' : WIDE[n % WIDE.length];
  return ['luxybasement', RESALE[n % RESALE.length], ...cat, wide].map((t) => '#' + t);
}

export function captionFor(item, n) {
  const opener = pick(OPENERS[item.productType] || OPENERS.Accessories, item.handle);
  const condition = [CONDITION_LINE[item.condition] || '', conditionDetail(item.description)].filter(Boolean).join(' ');
  return [
    `${opener} ${postTitle(item.title)}`,
    '',
    condition,
    '',
    `${money(item.price)}. Promised authentic, backed by our money-back guarantee.`,
    '',
    'Offers welcome on any piece. A real person reads every one.',
    '',
    'Shop via the link in our bio. Every piece is one of one, so it may have sold by the time you see this.',
    '',
    disclaimer(item.brand),
    '',
    hashtags(item, n).join(' '),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ----------------------------------------------------------------- photos */

const fileOf = (u) => u.split('?')[0].split('/').pop();
// Never an AI render, a HEIC original (Instagram's API takes JPEG only), or a
// styling board built from other brands' product images.
const unusable = (u) => /gemini|generated|dall-?e|midjourney|openai/i.test(u)
  || /\.heic$/i.test(fileOf(u))
  || /^(SB\d+|Image-?\d+|Screenshot_[\d_-]+)[._]/i.test(fileOf(u));
// Square 1080px crop, forced to JPEG whatever the fetcher's Accept header says.
const square = (u) => `${u}${u.includes('?') ? '&' : '?'}width=1080&height=1080&crop=center&format=pjpg`;

export const photosFor = (item) => item.images.filter((u) => !unusable(u)).slice(0, 5).map(square);
