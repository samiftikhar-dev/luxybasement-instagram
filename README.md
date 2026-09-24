# LuxyBasement Instagram publisher

Posts the LuxyBasement catalogue to Instagram, one piece every 90 minutes from 8am to 11pm Pacific (about 10 a day), started as a self-restarting "drip" run from the Actions tab. It's free: it runs on GitHub Actions and posts through Instagram's own API. Instagram allows 100 API posts per rolling 24 hours, so when that quota fills, posting pauses until it frees up.

- `posts.json` is the queue, in posting order: caption, photos and hashtags for each piece.
- `published.json` records what has gone out. The workflow updates it after every post.
- `publish.mjs` is the script that posts.
- `.github/workflows/publish.yml` is the schedule.

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

After that, the schedule posts on its own.

## Day to day

- **Start or restart posting:** Actions → Publish to Instagram → Run workflow → `drip`, interval `90`. There is no automatic schedule, so nothing posts until a drip is running.
- **Pace:** keep it gentle. On Sep 24 Meta blocked the app's API access after about 57 posts in under a day, including 20 in one hour. Regenerating the token cleared it.

- **Pause:** Actions → Publish to Instagram → ⋯ → **Disable workflow**. Enable it again to resume from where it stopped.
- **Post the next piece now:** Run workflow → `publish`.
- **Post several in a row:** Run workflow → `burst`, then set how many and the minutes between them.
- **Blocked by Instagram:** the run fails and GitHub emails you. Posting stops until you re-run it. Check the Instagram app for a warning before resuming.
- **A piece sold:** delete its entry from `posts.json`. Its `id` is the same uuid the post had in Metricool.
- **Failures:** a post that fails twice is skipped and the queue moves on. `published.json` records the error.
- **Token expiry:** the token lasts 60 days. Generate a new one the same way before then and update the secret.
