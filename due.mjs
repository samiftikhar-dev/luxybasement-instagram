/**
 * Prints which scheduled formats are due now: "reel", "carousel", or nothing.
 *
 * GitHub's cron triggers skip runs unpredictably, so the always-running drip
 * in publish.yml calls this every loop and starts whatever is due. The cron
 * triggers in reels.yml and carousels.yml stay as a backup; reel.mjs and
 * carousel.mjs refuse to post again inside their minimum gap, so a cron run
 * and a drip-started run can never double up.
 */
import { readFileSync, existsSync } from 'node:fs';

export const REEL_GAP_MIN = 130;      // about every 2.5 hours, so ~5-6 a day
export const CAROUSEL_GAP_MIN = 420;  // two a day
const REEL_HOURS = [9, 22];           // Pacific, start inclusive, end exclusive
const CAROUSEL_HOURS = [12, 21];

const pacificHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const read = (f, empty) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : empty);

export function minutesSinceLast(records) {
  const times = records.filter((r) => r.status === 'published' && r.at).map((r) => Date.parse(r.at));
  return times.length ? (Date.now() - Math.max(...times)) / 60000 : Infinity;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('due.mjs')) {
  const hour = pacificHour();
  const due = [];
  if (hour >= REEL_HOURS[0] && hour < REEL_HOURS[1]
    && minutesSinceLast(Object.values(read('reels.json', {}))) >= REEL_GAP_MIN) due.push('reel');
  if (hour >= CAROUSEL_HOURS[0] && hour < CAROUSEL_HOURS[1]
    && minutesSinceLast(read('carousels.json', [])) >= CAROUSEL_GAP_MIN) due.push('carousel');
  console.log(due.join('\n'));
}
