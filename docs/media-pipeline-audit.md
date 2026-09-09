# Media pipeline audit

Reviewed 2026-09-09 at commit `1fd8d901064dda2f818c662f9c5a444a43d174e7`, version 0.2.17. GitHub's default branch resolved to the same commit. The working tree was clean before this review. Production code, tests, settings, media, and GitHub were not changed; this audit and the accompanying research note are new local documents.

The overall order is correct. Keep language cleanup and audio generation ahead of the decision to encode video. The significant gaps concern preserving the intended streams, measuring retained bytes, and safely accepting the result.

## Current order

| Stage | Current behavior | Assessment |
| --- | --- | --- |
| Inspect and plan | Inspect streams; decide retained languages and audio changes; estimate size after pruning. | Good starting point; stream identity and measured track sizes are incomplete. |
| Open ISO | Remux a selected disc feature to a working MKV when needed. | Necessary container step; subsequent operations must use its new stream indexes. |
| Prepare tracks | Generate AAC replacements/downmixes; extract retained text subtitles as SRT. | Generating audio before removing its source is correct. Blanket subtitle conversion loses information. |
| Clean working file | Use mkvmerge to prune and combine tracks. | Correct; the video is copied without another lossy encode. |
| Recheck and encode | Probe the working file; skip a size-only encode when cleanup suffices; otherwise encode HEVC/AV1 and copy audio. | Correct order. Codec/Force encodes intentionally still run. |
| Finish and accept | Copy to a review sidecar; probe duration/counts; Keep or direct write replaces the source. | Validation, output naming, and crash recovery need strengthening. |

The implementation is in [optimize.ts](../src/server/optimize.ts), especially lines 132–241. It passes PRD stories 105 and 105a for muxing before encoding and checking the resulting size. A combined FFmpeg operation could save I/O when encoding is mandatory, but preserving the intermediate measurement is useful and matches the current spec. See [the source research](media-pipeline-research.md).

Automatic Suggestions reduce file size while retaining resolution: `planFromSuggestion` sets `downscale1080p: false`. Actual 4K-to-1080p resizing is an explicit custom-plan option.

## Spec findings

### S1 — High: automatic pruning can remove every soundtrack

In [suggest.ts](../src/server/suggest.ts), lines 58–63 protect a wrong-language soundtrack only when it is the sole usable track. With two stereo tracks tagged Spanish and French and English preferred, both are removed. Two untagged stereo tracks produce the same problem. `muxPlanArgs` then uses `--no-audio`; the integrity check expects zero tracks because it derives that expectation from the plan.

An exported-function reproduction confirmed the empty keep list and `--no-audio` output option. The custom-plan path already refuses to remove all audio, but automatic Suggestions lack the same invariant. Require at least one usable soundtrack or block the plan for language identification/selection. This extends the silence protection expressed in PRD story 88 to the multi-track case.

Unknown-language pruning itself follows story 87. Retaining every unknown or original-language track would be a separate policy choice. A preferred-language commentary track also should not be assumed to be the main dialogue when selecting a downmix source.

### S2 — High: retained subtitles lose presentation and playback properties; encode drops attachments

[optimize.ts](../src/server/optimize.ts), lines 268–297, converts every retained text subtitle to SRT whenever muxing is needed, including ASS/SSA already supported by Matroska. Lines 710–714 repeat this conversion policy on encode. `SubtitleExtra` carries only language and index, and the extra-track mux options restore language only: source title, forced/default, and accessibility properties are not reapplied.

Thus an audio-only cleanup can change otherwise retained subtitles. ASS/SSA positions, effects, and fonts are meaningful parts of their presentation. Preserve supported subtitle codecs and their metadata; convert only when the destination container requires it. [Matroska subtitle formats](https://www.matroska.org/technical/subtitles.html)

The final encode maps `0:v:0`, `0:a?`, and `0:s?` but no attachment streams. Font attachments survive the preliminary mkvmerge operation and then disappear at encode. This breaks PRD story 101; loss of retained subtitle properties undermines story 86. Chapters are normally copied by FFmpeg, but both production probe commands omit `-show_chapters`, so `hasChapters` cannot verify that preservation. [FFmpeg stream selection](https://ffmpeg.org/ffmpeg.html#Stream-selection)

### S3 — High: inspection and encoding can select different video streams

[inspect.ts](../src/server/inspect.ts), lines 50–53, chooses playable video while excluding cover art. The report does not retain that video's stream index. [optimize.ts](../src/server/optimize.ts), line 669, always maps the first video stream.

The checked-in `mkv-4k-hdr.ffprobe.json` fixture proves the mismatch: inspection sees 4K HEVC at stream 1, but generated encode arguments select the MJPEG cover at stream 0. The result may fail or encode the wrong content. Retain the selected video identity and re-resolve it on each working file. This is a gap between the playable-video intent in PRD stories 81–82 and execution.

### S4 — Medium: size budgeting uses codec guesses after measurements are available

[inspect.ts](../src/server/inspect.ts), lines 68–80, discards stream bitrate and track-byte statistics. [size-budget.ts](../src/server/size-budget.ts), lines 37–53, substitutes typical codec rates. The final video budget receives only estimated copied audio; retained subtitles are not included despite PRD story 73a.

A synthetic probe containing two 128 kbps AAC streams was budgeted as two 192 kbps streams. Differences are more consequential with lossless audio. Overestimates can suppress useful encodes or starve video; underestimates can overshoot the size cap. If an estimate says pruning alone will suffice, the plan contains no size encode, so the later encode-decision branch is never entered even when the actual cleaned file remains too large.

Use measured retained track bytes first, reported bitrate second, and codec guesses as fallback. mkvmerge writes `NUMBER_OF_BYTES`, `DURATION`, and `BPS` statistics by default. Include retained subtitles, attachments, and a measured container allowance. [mkvmerge statistics](https://mkvtoolnix.download/doc/mkvmerge.html#mkvmerge.description.disable_track_statistics_tags)

The same module reserves 20% of the target and then halves the AV1 video bitrate. A 4 GiB/hour target with 192 kbps audio yields 7,425,720 bps for HEVC and 3,712,860 bps for AV1. The comment records earlier NVENC overshoot observations, so this is a workaround worth investigating, not proof of a universal codec rule. It also affects VAAPI. Benchmark the deployed encoder before changing it; the current behavior differs from the equal-target acceptance criterion in open [issue #46](https://github.com/charlesgreever/polisharr/issues/46).

### S5 — Medium: language identification and later bulk cleanup disagree

Confirmed language identification sets `languagePending` on the inspection. The custom-plan builder preserves that write, but [optimize.ts](../src/server/optimize.ts), lines 73–83, creates bulk keep operations with indexes only. A bulk cleanup can retain a newly identified track without writing its language to disk. After Keep and reinspection, it becomes unknown again and can be offered for removal. An exported-function reproduction confirmed the missing language write. This leaves the identification-to-Keep workflow in v2 stories 54h–54n incomplete.

Separately, `normalizeLang` in [inspect.ts](../src/server/inspect.ts), lines 127–131, only unifies English aliases. French `fr`, `fra`, and `fre`, and German `de`, `deu`, and `ger`, remain distinct. Preferences and track tags using different legitimate code forms can therefore disagree. Normalize equivalent ISO language codes and preserve richer language tags where available.

### S6 — Medium: ISO remux changes indexes before later track operations

After ISO remux, `current` points at the new MKV, but audio/subtitle extraction still uses indexes from `req.report`, the disc listing. FFmpeg output stream indexes are reassigned by output mapping. An original audio stream at index 5 can become MKV stream 1; a subsequent `-map 0:5` can fail or select the wrong stream. The mkvmerge bridge similarly matches against the original track ordering, which becomes unreliable if dummy or unsupported tracks disappeared.

This is a code-path finding, not a disc playback reproduction. Probe immediately after ISO remux and translate the original choices onto the surviving working streams before extraction and muxing. This is necessary for the ISO track-edit behavior in v2 story 29.

## Standards findings

### E1 — High, ENG-09: interrupted replacement can leave a partial library file

[promote.ts](../src/server/promote.ts), lines 63–85, renames the original to `.opt-old` and copies the sidecar directly to the library filename. If the process stops during that copy, both the partial destination and intact backup can exist. `recoverStagedReplace`, lines 43–51, restores the backup only when the destination is absent.

A temporary-file reproduction confirmed that recovery leaves the partial destination untouched when its backup exists. Retrying Keep can rename the partial file over the intact backup. The current recovery test covers a missing destination but does not cover a partially copied destination. This breaks ENG-09's requirement that a crash before replacement completes preserve the original.

Validate replacement completion before retiring the backup. Recovery must restore an incomplete destination, and a retry must preserve the existing intact backup. Any redesign must account for the Arr scanner behavior noted in the implementation comment.

### E2 — High, ENG-09: different titles can share one sidecar filename

[optimize.ts](../src/server/optimize.ts), line 140, constructs the review path solely from the source basename. [jobs.ts](../src/server/jobs.ts), line 222, supplies one shared review directory. For example, `/show-a/S01E01.mkv` and `/show-b/S01E01.mkv` both produce `review/S01E01.mkv`.

A second job can overwrite an earlier pending result even with concurrency one. Failure cleanup can also delete the collided path. Keep can then apply the wrong bytes to a title. Use job-specific output directories or names and prevent accidental overwrite; assign temporary paths the same unique identity. This follows directly from path construction; a concurrent workload was not run.

### E3 — High, ENG-05: output checks cannot establish that the intended media survived

[optimize.ts](../src/server/optimize.ts), lines 212–241, accepts container duration at least 90% of the original and minimum planned audio/subtitle counts. It does not verify playable video presence/identity, per-stream end times, language, audio layout, subtitle flags, expected resolution, bit depth, or HDR properties. A two-hour result can lose nearly twelve minutes and still pass the duration threshold. Container duration alone can also conceal a video stream ending earlier than audio.

Validate the plan's observable results, including at least one usable soundtrack for ordinary media. Make tolerance narrow and account for legitimate timing differences. Include chapters and attachments in inspection. Consider a full decode validation for direct replacement or other higher-risk results; metadata checks alone do not prove decodability. This concerns ENG-05's fail-closed requirement and PRD integrity story 162.

### E4 — Medium: capacity check does not represent peak temporary storage

The capacity check reserves roughly `max(source size, planned size) + 256 MiB`. The runner retains intermediate files until `finally`, and copies its final working file to a second full sidecar before cleanup. A 10 GiB cleaned MKV plus 5 GiB encode plus 5 GiB sidecar can require about 20 GiB on the review volume even though the initial check asks for about 10 GiB. ISO and generated audio add more.

Calculate peak live bytes for the planned stages. Release intermediates once they are no longer needed and consider renaming the validated final working file within the review volume. Capacity also needs to account for simultaneous jobs. This is an execution reliability gap; ordinary encode failures still preserve the source.

## Improvements requiring a deliberate choice or benchmark

- **Unknown languages and dialogue:** the present spec requests unknown-track pruning. A safer optional policy would identify unknown tracks before pruning and retain uncertain dialogue/forced subtitles for review. Select main dialogue explicitly when commentary and accessibility tracks share its language.
- **HDR:** record Dolby Vision profile and compatibility, plus color and static HDR properties, and verify the actual output. Ten-bit encoding alone is insufficient evidence. Dolby profile 5 has no HDR10 fallback; a generic metadata-loss warning does not establish correct fallback colors. Current FFmpeg can forward some static metadata automatically, so absence of explicit flags alone does not prove loss. Deployed GPU/build testing remains necessary. [Dolby profile guidance](https://professionalsupport.dolby.com/s/article/Dolby-Vision-Encoding-of-mezzanine-assets)
- **Resolution:** fit within 1920×1080 proportionally with even dimensions. A 3840×1600 movie can become 1920×800. The current fixed 1920×1080 filters adjust pixel aspect ratio, so this is an efficiency/compatibility improvement, not a proven stretching defect. See the scaler sources in [the research note](media-pipeline-research.md).
- **Audio quality and timing:** the AAC generator uses the same 128/160 kbps for stereo and custom 5.1/7.1 outputs. Choose rates appropriate to the retained layout. Bare AAC intermediates do not preserve container timing and track properties; use a timestamped intermediate and verify sync and metadata after muxing.
- **Encoding quality:** benchmark VBR against current CBR at the same measured final size, and investigate the blanket AV1 multiplier. NVIDIA recommends VBR for recording/archiving; that does not establish the best settings for this installation without samples. [NVIDIA encoder guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)

## Validation and proposed sequence

All 322 existing tests passed across 51 files. Temporary diagnostic scripts confirmed all-audio removal, cover-art selection mismatch, ASS-to-SRT conversion selection, omitted attachment mapping, discarded audio bitrate measurements, AV1 bitrate halving, omitted pending language writes, and incomplete-backup recovery. These were code/fixture checks, not a full encode through the deployed container. No real library files were processed and no GPU, disc, or playback benchmark was performed.

Address E1/E2 and S1/S3 first because they can select, replace, or retain the wrong media. Then preserve subtitle/attachment properties and strengthen result validation. Improve measured size accounting, pending language writes, ISO stream translation, and peak capacity next. Benchmark codec settings and optional resolution/HDR policies after correctness checks can verify their outputs.

Spec axis: operation order passes; stream preservation and execution have the named gaps above. Standards axis: ENG-05 and ENG-09 fail in the identified paths. Passing unit tests do not resolve those findings.
