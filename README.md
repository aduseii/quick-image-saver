# Quick Image Saver

Save any image from any website in its **full original quality**, **GIFs** with their animation intact, and **Instagram videos** in their sharpest version, without right-clicking or Save As dialogs. Keeps itself up to date.

## Install (Chrome, Edge, Brave)

1. Download the extension: on this page click **Code → Download ZIP** (or use the zip you were sent).
2. Unzip it somewhere you'll keep it, e.g. `Documents\quick-image-saver`. Don't delete or move the folder afterwards: the browser runs the extension from there.
3. Open the extensions page: `chrome://extensions` (Chrome / Brave) or `edge://extensions` (Edge).
4. Turn on **Developer mode** (top-right in Chrome, left sidebar in Edge) and leave it on.
5. Click **Load unpacked** and pick the folder (the one with `manifest.json` inside).
6. Click the puzzle-piece icon in the toolbar and pin **Quick Image Saver**.
7. Turn on auto-update (below).

Tabs that are already open start working right away; no refresh needed.

## Turn on auto-update

Do this once. In the extension folder, double-click **`Turn on auto-update.bat`**. If Windows asks whether to run it, choose **Run** (or **More info → Run anyway**). A window says *Auto-update is ON*; close it.

That's it. From then on the extension updates itself:

- it checks GitHub when your browser starts and every 3 hours;
- when there's a new version, it downloads it, installs it into the folder and restarts itself (a second or two), with nothing to click;
- open tabs keep working, and your settings are kept;
- the popup shows your version under **Updates** (e.g. *Updated to 1.4.1 ✓*), and **Check for updates** checks right away. If the one-time setup below hasn't been done, that button downloads `Quick Image Saver <version>.zip` into your downloads folder instead. Unzip it over the extension folder, then click **Reload** on the extensions page.

Why the one-time step: browsers don't let an extension rewrite its own files, so a tiny helper (`updater\`) does the installing. It needs no admin rights, doesn't run in the background, and only starts when the extension has found a new version. It only ever downloads from this repository, only accepts a download that really is Quick Image Saver at the expected version, and if anything goes wrong it leaves your folder exactly as it was. To turn it off, run `updater\Turn off auto-update.bat` (or switch off **Update automatically** in the popup).

If you move the extension folder, run `Turn on auto-update.bat` again from the new place.

### Coming from version 1.2 or older

Version 1.3 gives the extension a fixed ID so the updater can find it, so it's installed as a fresh extension once: remove the old Quick Image Saver in `chrome://extensions`, then follow **Install** above. Your settings (save folder, switches) go back to the defaults this one time.

## How to save

| Way | What to do |
|---|---|
| **Hover button** | Move your mouse over any image, GIF or video, then click the ↓ button in its top-right corner. |
| **Alt + click** | Hold `Alt` and click any image, GIF or video. Works even when it's a link, and won't pause Instagram videos. |
| **Keyboard** | Point at an image, GIF or video and press `Alt + Shift + S`. |
| **Whole page** | Click the toolbar icon, then **Save all images on this page** (skips icons and tiny images). |

Files go to `Downloads\Saved Images` by default. You can change the folder name in the popup, or turn on **A folder for each website** to sort them automatically.

## Instagram videos

Works on feed posts, reels, carousel posts (saves the slide you're on), stories and highlights. Videos are saved as `.mp4`, named after the account and post, e.g. `chef_ama_DAbcFeed001.mp4`, `travel_kofi_DAbcCarou01_3.mp4` (slide 3), `chef_ama_story_3333….mp4`. The "Saved" message shows the quality you got, e.g. `· 1080p`.

**Always the sharpest version.** Instagram keeps a video in several qualities. The sharpest one (often 1080p) is usually stored as two separate streams, picture and sound, which normally can't be downloaded as one file. The extension checks every quality Instagram has for the video and picks the best. If that's a split one, it joins the picture and sound into one normal `.mp4` inside your browser. Nothing is re-encoded: every frame is copied exactly, so there's no quality loss, and joining a 90-second reel takes well under a second.

How it chooses:
- the highest resolution wins;
- at the same resolution, the copy carrying more detail (higher bitrate) wins;
- among equally sharp copies, the most compatible format wins (H.264, which plays and edits everywhere, including Canva, CapCut and Windows).

If anything goes wrong while getting the sharpest copy, it falls back to the best single-file version, so a save never fails because of this.

## GIFs

A GIF is saved as the GIF itself. Every frame, the timing and the loop stay exactly as they are: the file is copied byte for byte, and it is never flattened into a still picture or recompressed into a JPEG, PNG or WebP.

Pages usually show a smaller or frozen copy. The extension asks for the full GIF first:

- **Giphy** — the original upload, then Giphy's full GIF, instead of a resized, still or 6-frame preview
- **Tenor** — the full-size GIF, not the tiny or medium one. Some Tenor links are web pages; those are skipped
- **Imgur** — the `.gif`, including when the page is playing the `.mp4` or `.gifv` copy
- a `.gif` address that also asks the server for a WebP or JPEG is requested as a GIF, so the server doesn't swap in a still

The "Saved" message says `· original` when that file is the GIF. If the full GIF doesn't exist, the best real GIF the site will serve is saved the same way, still without recompressing it.

Twitter keeps GIFs only as a video file. Saving one keeps that file (an `.mp4`), because turning it into a GIF would throw quality away. A GIF posted on Instagram is saved the same way, as the sharpest video Instagram has.

Instagram streams its videos, so the file address isn't on the page itself. The extension reads it from the data Instagram has already loaded for the post. If the post hasn't loaded that data yet, it asks Instagram for that one post, using your normal login. You need to be logged in to Instagram for this.

**Other websites:** videos that play from a normal file also get the save button. Streaming sites (YouTube, Netflix and similar) are not supported.

## How it gets the full-quality version

Pages usually show a smaller copy of an image. Before downloading, the extension checks for a bigger one:

- the largest size listed in the image's `srcset` / `<picture>` sources
- a link around the image pointing to the full-size file (galleries, lightboxes)
- lazy-load and "zoom" attributes (`data-src`, `data-orig-file`, `data-zoom-image`, ...)
- known thumbnail patterns: X/Twitter (`name=orig`), Pinterest (`/originals/`), Reddit (`i.redd.it`), Wikipedia/Wikimedia, Google/Blogger (`=s0`), YouTube (`maxresdefault`), Imgur, Amazon, Etsy, eBay, Medium, Shopify, Cloudinary, Substack, Unsplash, Next.js, Cloudflare, Jetpack, WordPress (`-300x200`, `-scaled`) and generic `?w=…&q=…` resize parameters

Every guess is checked with the website first. If the bigger version doesn't exist, it falls back to the image you see, so a save never fails because of a wrong guess. Files are named by their real format (a "photo.jpg" that is actually WebP is saved as `photo.webp`).

## Tips

- **Change the keyboard shortcut:** popup → **Change**, or go to `chrome://extensions/shortcuts`.
- **A Save As window opens every time?** Turn off *Ask where to save each file before downloading* in your browser's Downloads settings.
- **Some images can't be saved?** A few sites protect their image files. The extension will save the best version the site allows.
- **Instagram says "open the post and try again"?** Click into the post (or reel) so Instagram loads it, then save again.
- **Turn features off:** both the hover button and Alt+click can be switched off in the popup.

## Files

```
manifest.json      extension definition
src/resolve.js     finds the highest-quality URL for an image or GIF
src/content.js     hover button, Alt+click, shortcut, toast messages
src/ig-main.js     Instagram helper: finds the video file for a post/reel/story
src/mp4mux.js      joins separate picture + sound streams into one MP4 (lossless)
offscreen/         hidden helper page that picks the sharpest copy and joins it
src/background.js  checks candidates, downloads, checks for updates
popup/             toolbar popup (settings, save all, updates)
icons/             toolbar icons
updater/           auto-update helper (Windows PowerShell, started by the extension)
Turn on auto-update.bat   one-time setup for auto-update
```

## Publishing a new version

Auto-update follows the `main` branch. To ship an update: raise `"version"` in `manifest.json` (e.g. `1.3.0` → `1.3.1`) and push to `main`. Every installed copy picks it up within 3 hours, or right away with **Check for updates**. Only push finished, tested versions to `main`.
