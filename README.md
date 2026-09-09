# Polisharr

Polisharr is a companion container for Radarr and Sonarr. It inspects the same library those apps already know, suggests smaller HEVC (or AV1) files and cleaner tracks, and writes a sidecar you Keep or Discard before the library file changes. Custom title plans, ISO remux, and optional direct write are also supported.

This tree is a greenfield rewrite. Do not import the previous application code.

**PRD:** [docs/v2 prd.md](docs/v2%20prd.md) (v2). The rewrite PRD is [docs/prd.md](docs/prd.md).
**Plan:** remaining work is [plans/review-follow-up.md](plans/review-follow-up.md). Multi-node (one master, extra GPU boxes): [plans/multi-node.md](plans/multi-node.md). Shipped v2 work: [plans/v2-implementation-plan.md](plans/v2-implementation-plan.md). Earlier review-gap work: [plans/review-gap-remediation.md](plans/review-gap-remediation.md).
**Engineering standard:** [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md)
**Prose standard:** [CODING_STANDARDS.md](CODING_STANDARDS.md)

## What it does

- Syncs movies from Radarr and episodes from Sonarr over their APIs
- Refreshes Arr libraries at startup, every 15 minutes, on request, and when Radarr or Sonarr posts a webhook after import
- Opens the network path each Arr reports
- Inspects MKV with ffprobe and ISO disc images with ffmpeg. Blu-ray remux copies the feature video and usable audio, copies playlist languages onto the Matroska file, ignores dummy AC3 decode errors, and skips audio-only menu listings. A BR-DISK image is opened with the bluray protocol, not as a raw file. A stale ISO listing (the file treated as a lone AC3 stream) is listed again before the next remux. Titles with no file yet stay off Errors. Optional Suggestions can convert ISO to MKV. A title whose only audio is not your preferred language can ask Radarr or Sonarr to search again after you confirm.
- Flags files over the GB-per-hour cap, extra languages, and missing AAC stereo
- Can suggest converting MP4 files to MKV before a hardware encode, or as remux-only work
- Filters Suggestions by media facts or warning state and manages path, profile, tag, and title exclusions
- Lets you queue a custom plan from a title page: track edits, remux, size mode, or encoder quality. The title page shows file name and path. Queue stays off until the plan differs from the source. AV1 appears when an encode node can encode it. Untagged audio can **Identify language** from a 45-second clip when `WHISPER_LID` is set. Untagged text subtitles can identify language from a few minutes of words (no extra install). Untagged PGS can identify language from a short OCR sample when `PGS_OCR` is set. A weak sample stays untagged and offers another start time. The library file does not change until Keep.
- Optional language identification: the image ships `/usr/local/bin/whisper-lid` (faster-whisper, tiny model). Set `WHISPER_LID` to that path. The first listen downloads the model into `/config/whisper`. CUDA is used when an NVIDIA device is present; otherwise the clip is identified on CPU. If `WHISPER_LID` is unset, the title page does not offer audio Identify language. PGS Identify language uses `/usr/local/bin/pgs-ocr` (Tesseract OSD+English on a 180-second sample). Set `PGS_OCR` to that path. It does not convert the PGS track to SRT.
- Home shows a Status strip, large files-optimized and space-saved tiles, and links into Suggestions, Queue, Review, and Errors. Direct write counts in the tallies the same way Keep does.
- Settings uses stacked labels and everyday size-cap names. Title-page audio actions keep a fixed-width dropdown so Keep and Replace with downmix do not jump.
- Series headers show episode total, how many are healthy, and how many still have suggestions. Movies shows the same three counts for the whole Radarr library, not just the loaded page.
- Lets a movie or a whole show pick HEVC or AV1 for automatic Suggestions without changing the house Encode Target. A series header can Prefer stereo (replace surround with stereo only, including 5.1 kids shows) or Keep surround.
- Suggestion, Errors, and Queue titles open the same detail page as Movies and Series
- Queue pins running jobs in Working now, then waiting jobs, then finished jobs, so a long batch does not hide the encode in progress
- Size-mode encode reserves room for copied audio. A file within 5% of its GB-per-hour cap counts as meeting it.
- Muxes tracks with MKVtoolnix and encodes video with the GPU you pass in. mkvmerge and ffmpeg run with a UTF-8 locale so titles such as 烧烤 are not truncated.
- Writes a sidecar for Review by default, or replaces the library file after an integrity check when **Write finished files** is Direct write. Waiting bulk jobs use that setting when they start. Queue new Arr imports still writes a sidecar. Keep then asks Radarr or Sonarr to refresh media info and rename the library file so tokens such as `EAC3 5.1` or `H264` match the new audio and video.
- Lets you Keep one sidecar, Keep selected, or Keep all waiting sidecars after a confirm. Flagged results can queue a smaller encode. Review shows duration and GB per hour. Keep selected reports how many were skipped.
- Checks review-volume free space before work. After restart, interrupted jobs return to the queue. Interrupted Keep cards return to Review so you can retry or discard them. A Keep that already replaced the library file counts as kept.
- Can create named Arr quality profiles from the current size caps without starting a search

## Installation

Polisharr runs as a Docker container next to Radarr and Sonarr. It reads the same library files those apps already know, so the media bind in compose must be that path on both sides. Video encode needs a GPU: NVIDIA (NVENC) or Intel (VAAPI, the Video Acceleration API). There is no CPU encode fallback.

### 1. Get compose

```bash
git clone https://github.com/charlesgreever/polisharr.git polisharr
cd polisharr
```

The running image is `ghcr.io/charlesgreever/polisharr:latest` (version tags such as `0.2.0` match GitHub releases). GitHub Actions builds that image on each `v*` tag.

### 2. Copy and edit compose

Copy [compose.example.yaml](compose.example.yaml) to `compose.yaml`. Change these values:

- **Media bind.** `/path/to/media:/path/to/media` must match the file path Radarr and Sonarr report. If they see `/mnt/media/Movies/Title.mkv`, both sides of the bind are `/mnt/media`.
- **`PUID` / `PGID`.** Owner of `/config` and files Polisharr writes. Use the same ids as your Arr containers.
- **`TZ`.** Container timezone.

NVIDIA is already selected (`runtime: nvidia` and the `NVIDIA_*` variables). The host needs the NVIDIA container toolkit. `utility` provides `nvidia-smi`. `video` provides NVENC.

For an Intel GPU, comment out `runtime: nvidia` and the `NVIDIA_*` variables, then uncomment `devices: /dev/dri`. ffmpeg uses `/dev/dri/renderD128`. Set `group_add` to the host `render` and `video` group ids (`getent group render video`). The entrypoint keeps those groups after it drops root; otherwise VAAPI fails with `Device creation failed: -22`.

If Radarr and Sonarr already share a Docker network, attach Polisharr to that network so Settings can use `http://radarr:7878`.

### 3. Start

```bash
docker compose pull
docker compose up -d
```

Recreate the container after you change GPU settings. To compile this tree instead of pulling, uncomment `build: .` in compose and run `docker compose up -d --build`.

### 4. First run

Open `http://localhost:7373` (or the host address you published). Create the admin account. Polisharr then collects preferred language, a review folder (where finished copies wait for Keep, outside movie and show libraries), and at least one enabled Radarr or Sonarr. Plex and Jellyfin can wait; add them later in Settings. Optional: add a webhook so new imports show up immediately ([Webhooks from Radarr and Sonarr](#webhooks-from-radarr-and-sonarr)). The sidebar shows the running version from `package.json`.

Under **Default suggestion operations**, **Convert MP4 to MKV** is off by default. When enabled, Polisharr uses `mkvmerge` to create an MKV before any hardware encode. An MP4 that needs no other work gets a remux-only suggestion.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUID` / `PGID` | `1000` | Owner of `/config` and files Polisharr writes |
| `TZ` | `UTC` | Container timezone |
| `CONFIG_DIR` | `/config` | Persistent SQLite and settings |
| `PORT` | `7373` | Listen port |
| `POLISHARR_WIDGET_KEY` | unset | Optional Homepage widget key |
| `POLISHARR_TRUST_PROXY` | unset | Set to `1` only behind a trusted reverse proxy |
| `POLISHARR_ROLE` | `standalone` | `standalone` (one box), `master` (UI and library), or `worker` (encode only) |
| `POLISHARR_NODE_NAME` | hostname | Label in Settings → Nodes and the Encode node picker |
| `POLISHARR_MASTER_URL` | unset | Worker only: URL of the master, for example `http://192.168.1.10:7373` |
| `POLISHARR_CLUSTER_TOKEN` | unset | Shared secret. Generate it on the master; set the same value on each worker |

## Encode target and preferred audio

Settings **Target** under Encode is the house codec for automatic Suggestions: HEVC, or AV1 when an encode node can encode it. **Transcode video below Target Encode** flags H.264, MPEG-2, VC-1, and similar codecs even when the file is under its size cap. When the target is AV1, it also flags HEVC. Already-AV1 files stay as they are.

Each movie row and that movie's title page have **Encode target**. Pick HEVC, AV1, or **House default** to follow Settings. Saving recomputes the automatic suggestion for that film. The Codec control on a custom title plan is only for the job you queue there.

A series header has the same **Encode target**. It applies to every episode of that show, including files Sonarr imports later. Episode rows have no codec dropdown.

Series headers also have **Preferred audio**:

- **House default** follows Settings **Add stereo from surround audio**. The house rule adds AAC stereo for Atmos, TrueHD, EAC3, or more than 5.1, and keeps the original mix.
- **Prefer stereo** replaces surround with AAC stereo on every episode, including 5.1 kids shows, and drops the original mix. If the file already has stereo, Polisharr keeps that track and drops surround.
- **Keep surround** turns automatic stereo off for that show.

Add stereo on a row still works for one episode. Queue still writes a sidecar. Keep still replaces the library file.

## Extra GPU boxes

One Polisharr is the **master**: UI, settings, library sync, Suggestions, Review, and Keep. Put that container on the always-on host next to Radarr and Sonarr. Set `POLISHARR_ROLE=master`. Each extra GPU box is a **worker**: it only runs encodes. Copy [compose.worker.yaml](compose.worker.yaml), give it its own `/config`, and bind the **same** media path the Arrs report (and the same review folder).

**Encode target** is still HEVC vs AV1. **Encode node** is which machine runs ffmpeg. Settings → Nodes sets the house default and per-node job slots. Queue, Suggestions, and the title page can pick a different node for one job. If that node is off or drained, the job waits; it does not move to another GPU.

On the master, Settings → Nodes generates a cluster token. Copy it once into `POLISHARR_CLUSTER_TOKEN` on the worker, with `POLISHARR_MASTER_URL` pointing at the master. Do not share `/config` or `polisharr.db` across containers. Webhooks still hit the master.

A worker writes a sidecar on the shared review path. Direct write still replaces the library file on the master after the integrity check, then refreshes Arr. Queue new Arr imports still writes a sidecar and uses the house encode node.

The worker's published port is only a stub page (hardware, master URL, join status). Open the master to manage the library.

## Run locally

```bash
npm install
npm test
npm run dev
```

The API listens on `http://127.0.0.1:7373`. The Vite UI listens on `http://127.0.0.1:5173`.

```bash
npm run build
CONFIG_DIR=./config npm start
```

## Webhooks from Radarr and Sonarr

Polisharr already syncs Radarr and Sonarr every 15 minutes. A Connect webhook tells it about a finished import right away so the new file is inspected without waiting. The webhook itself does not start an encode. Optional: **Queue new Arr imports automatically** in suggestion defaults queues a sidecar when inspect produces a suggestion. Keep still replaces the library file and does not queue that file again. A later Arr upgrade still can.

### 1. Generate a token in Polisharr

In Settings, open **Radarr and Sonarr webhooks** and generate a token. Copy it now. Polisharr stores a hash and will not show the raw token again. Rotate the token if it leaks; the old one stops working.

### 2. Add a Connect webhook in each Arr

In Radarr and in Sonarr: **Settings → Connect → Add → Webhook**.

| Field | Value |
| --- | --- |
| URL | `http://polisharr:7373/api/hooks/arr` on the Arr Docker network, or `http://<host>:7373/api/hooks/arr` from another machine |
| Method | POST |
| On Import | on |
| On Upgrade | on |
| On Rename | on |
| Token | Header `X-Api-Key` with the generated token, **or** the Connect **Password** field (HTTP Basic). Username can be `polisharr`. |

Prefer the header or the password field. A URL with `?apikey=` also works if the form only has a URL box; that puts the token in access logs.

Use **Test**. Polisharr answers 200 when the token is correct.

### 3. What happens on import

Radarr or Sonarr posts after it imports, upgrades, or renames a file. Polisharr syncs that title (or the whole library if the payload has no id), then inspects it. Suggestions appear when inspect finishes. Grab events (download started, file not on disk yet) are ignored.

## Report a bug

Signed-in pages keep a **Report** control on screen. **Bug** and **Change request** open a GitHub issue on this repository with the current route, inspect leftovers, and a running job if there is one. The prefill never includes file paths, API keys, tokens, or passwords. Attach a screenshot on GitHub yourself if one would help.

## Homepage

Polisharr exposes `GET /api/widget` for a Homepage `customapi` tile. Example YAML: [docs/homepage.md](docs/homepage.md).
