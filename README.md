# LuxyBasement Instagram publisher

Posts the LuxyBasement catalogue to Instagram, one piece every 30 minutes from 8am to 11pm Pacific (about 30 a day), started as a self-restarting "drip" run from the Actions tab. It's free: it runs on GitHub Actions and posts through Instagram's own API. Instagram allows 100 API posts per rolling 24 hours, so when that quota fills, posting pauses until it frees up.

- `posts.json` is the queue, in posting order: caption, photos and hashtags for each piece.
- `published.json` records what has gone out. The workflow updates it after every post.
- `publish.mjs` is the script that posts.
- `feed.mjs` reads the shop's product feed and writes captions for new listings.
- `.github/workflows/publish.yml` runs the drip and the watchdog.

## One-time setup

1. **Instagram account type.** @luxybasement must be a Business or Creator account. It already is, since Metricool could post to it.
2. **Meta app.** Go to https://developers.facebook.com/apps and choose **Create app**.
   - Use case: **Manage messaging & content on Instagram**. This adds the Instagram API with Instagram Login.
   - Any app name works, for example "LuxyBasement Publisher".
3. **Connect the account.** In the app, open **Instagram → API setup with Instagram login**.
   - Under **Generate access tokens**, click **Add account** and log in as @luxybasement.
   - If Meta asks, add @luxybasement as an Instagram tester under **App roles → Roles**. Then accept the invite in the Instagram app under **Settings → Website permissions → Apps and websites → Tester invites**.
4. **Get the token.** Back in **Generate access tokens**, click **Generate token** next to @luxybasement and copy it. This is a long-lived token that lasts 60 days.
5. **Store it in GitHub.** In this repo, open **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `IG_ACCESS_TOKEN`
   - Value: the token

   Don't paste the token anywhere else.
6. **Test it.** Open **Actions → Publish to Instagram → Run workflow**, choose `check` and run it. The log should show the account, the quota and the next piece's photos as `image/jpeg`. Nothing is posted.

After that, start a `drip` run (see below) and it posts on its own.

## Product tags (shopping bags on posts)

`tag.mjs` tags each post with its piece from the Meta shop, so the post gets a shopping bag. Tagging only works through the Facebook-login version of Instagram's API, so it needs a second secret, `FB_ACCESS_TOKEN`.

1. **Add the permissions** (once). In https://developers.facebook.com/apps/2374200442986686 (AutoSocialPoster), open **Use cases → Instagram API → Customize → Permissions and features**. Click **Add** next to `instagram_basic`, `instagram_shopping_tag_products`, `catalog_management`, `business_management`, `pages_show_list` and `pages_read_engagement`.
2. **Get a token.** In https://developers.facebook.com/tools/explorer choose **AutoSocialPoster**, choose **User Token**, add the same six permissions, and click **Generate Access Token**. When Facebook asks, allow the LuxyBasement Page, @luxybasement and the "LuxyBasement Products" catalogue.
3. **Make it last 60 days.** Copy the token into https://developers.facebook.com/tools/debug/accesstoken, click **Debug**, then **Extend Access Token**, and copy the long-lived token it shows.
4. **Store it in GitHub** as a repository secret named `FB_ACCESS_TOKEN`. Don't paste it anywhere else.
5. **Tag the backlog:** Actions → Publish to Instagram → Run workflow → `tag`, count `25`. Each run tags up to that many posts, newest first, 20 seconds apart. Run it again until the log says nothing is left.

After that, every drip post is tagged straight after it goes up, and the drip also clears a couple of older posts each time. `tags.json` records what has been tagged. Sold pieces are skipped. Like the posting token, this one lasts 60 days.

## Day to day

- **Start or restart posting:** Actions → Publish to Instagram → Run workflow → `drip`, interval `30`. A watchdog checks every 15 minutes and restarts the drip if it has stopped (for example when GitHub shuts a runner down), so normally you never need to.
- **Pace:** keep it gentle. On Sep 24 Meta blocked the app's API access after about 57 posts in under a day, including 20 in one hour. Regenerating the token cleared it. It happened again on Sep 25 at one post every 20 minutes (about 60 that day), so stay well under 60 a day: 30 minutes (about 30 a day) is the fastest pace used since.
- **Pause:** Actions → Publish to Instagram → ⋯ → **Disable workflow**, then cancel the running drip. Disabling stops the watchdog too. Enable the workflow and start a drip to resume.
- **Post the next piece now:** Run workflow → `publish`.
- **Post several in a row:** Run workflow → `burst`, then set how many and the minutes between them.
- **Blocked by Instagram:** the drip stops, commits `blocked.txt` with the error, and GitHub emails you. The watchdog won't restart while `blocked.txt` exists. Fix the cause (usually a fresh token), delete `blocked.txt`, and the watchdog resumes posting.
- **A piece sold:** nothing to do. Before every post the publisher reads the shop's product feed (luxybasement.com/feed.xml, refreshed every 30 minutes) and skips anything out of stock or unlisted, recording it as `sold` in `published.json`.
- **New listings:** nothing to do. Anything newly in stock on the shop is captioned in house style and queued first. `known.json` lists every product ever queued, so older pieces are never re-added.
- **Failures:** a post that fails twice is skipped and the queue moves on. `published.json` records the error.
- **Token expiry:** the token lasts 60 days. Generate a new one the same way before then and update the secret.
