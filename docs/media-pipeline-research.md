# Media Pipeline Research

Research date: 2026-09-09. Intended reader: a Polisharr maintainer reviewing language cleanup and file-size reduction. This note combines primary-source documentation with inspection of the current runner; recommendations describe proposed work.

Polisharr already performs the expensive video encode after track cleanup and a fresh size check. Preserve that order. The main opportunities are more accurate size accounting, subtitle preservation, HDR checks, and stronger output validation.

## Recommended Order

1. Inspect the source and identify its playable video, audio, subtitles, chapters, attachments, and HDR properties.
2. Resolve the requested track selections and create any replacement or additional audio from the original selected track.
3. Mux the retained tracks and generated audio into a working Matroska file, preserving their metadata.
4. Inspect that working file again. Recalculate the video budget using the tracks that actually remain; skip an optional size encode when cleanup already meets the cap.
5. Encode video once when the requested size, codec, quality, or resolution requires it. Copy the retained audio and supported subtitle formats.
6. Validate the completed output before Review or direct replacement.

Steps 2 through 5 match the current [runner](../src/server/optimize.ts) and [PRD](prd.md), particularly stories 73c, 105, and 105a. FFmpeg supports stream selection and video encoding in one command. Copying streams avoids another lossy conversion; encoding can copy audio alongside newly compressed video. [FFmpeg streamcopy and transcoding](https://ffmpeg.org/ffmpeg.html#Streamcopy)

A combined command could remove an intermediate file read and write when encoding is mandatory. That is an optional performance change, requiring a PRD update. The current intermediate mux provides a useful measurement point for deciding whether video encoding is necessary. This recommendation follows from the documented processing model and the runner's size check.

## Size Accounting

The working Matroska file can supply better estimates than codec names. By default, mkvmerge writes `BPS`, `DURATION`, `NUMBER_OF_BYTES`, and `NUMBER_OF_FRAMES` statistics for each track. [mkvmerge statistics](https://mkvtoolnix.download/doc/mkvmerge.html#mkvmerge.description.disable_track_statistics_tags)

Use those measured track bytes when available, then reported bitrate, then codec estimates as a fallback. FFprobe exposes stream tags and packet details; summing selected packet sizes is a slower measurement option. [FFprobe options](https://ffmpeg.org/ffprobe.html#Main-options)

The proposed calculation is:

```text
video bitrate = 8 × (target bytes − retained audio bytes
                   − retained subtitle bytes − attachments
                   − container allowance − encoder allowance)
                ÷ duration in seconds
```

The current [size budget](../src/server/size-budget.ts) uses typical audio rates, reserves 20% slack, and halves the calculated AV1 video bitrate. Its encode budget omits retained subtitle bytes. Investigate that AV1 correction against actual stream statistics and the deployed encoder before treating it as a general codec property.

NVIDIA recommends variable bitrate for recording and archiving. Its rate control documentation separates average bitrate from peak bitrate; constant-quality output varies with content. NVENC multipass analyzes each frame, rather than performing a complete preliminary pass over the film. [NVIDIA encoder guide, rate control and recommended settings](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)

Benchmark a variable-bitrate configuration for archival quality at the same output size. Keep bitrate mode for a size target and quality mode for a quality target. No benchmark was performed during this research.

## Language and Subtitle Preservation

An `und` tag means the language is undetermined. It provides no evidence that the track is foreign. [Library of Congress language-code FAQ](https://www.loc.gov/standards/iso639-2/faq.html)

The PRD explicitly requests dropping unknown tracks except a lone dialogue track. A conservative alternative would retain uncertain dialogue and forced subtitles for identification or review. That would be a product-policy change. Preserve the distinction between preferred-language main audio, commentary, and accessibility audio when choosing a downmix source.

Matroska supports BCP 47 language tags, including region and script information. MKVToolNix exposes these as `language_ietf`. It also distinguishes forced-display, default, hearing-impaired, and other track flags. Preserve these properties when replacing or extracting a track. [mkvmerge language and track options](https://mkvtoolnix.download/doc/mkvmerge.html#mkvmerge.language_handling)

The runner currently converts all recognized text subtitle formats to SubRip. ASS and SSA carry fonts, positioning, and effects, and Matroska supports those formats directly. Conversion can remove their presentation information. Restrict conversion to formats that need it for the output container. [Matroska subtitle formats](https://www.matroska.org/technical/subtitles.html)

Extracted SubRip files also need their source language, title, and flags reapplied. The current `SubtitleExtra` structure retains language and index only. Font attachments affect subtitle rendering and should survive the final encode. [Matroska attachment guidance](https://www.matroska.org/technical/attachments.html)

FFmpeg copies chapters by default, but attachments require explicit stream selection. Its default disposition behavior can also select a new default track. Validate both the intended track properties and chapter/attachment survival. The current `encodeArgs` maps video, audio, and subtitles without attachments. [FFmpeg stream selection and disposition options](https://ffmpeg.org/ffmpeg.html#Stream-selection)

## HDR Handling

Ten-bit output alone does not establish HDR preservation. Compare color primaries, transfer characteristics, matrix, range, mastering-display data, and content-light data before and after encoding.

Current FFmpeg NVENC source includes automatic transfer of static mastering-display and content-light metadata when compiled with the relevant SDK support. Therefore, missing explicit command-line metadata flags do not prove loss. [FFmpeg NVENC source](https://www.ffmpeg.org/doxygen/trunk/nvenc_8c_source.html)

The NVIDIA SDK supports HDR10 and HDR10+ metadata insertion for HEVC and AV1. Whether a deployed FFmpeg build carries every required field through its decoder, filters, encoder, and muxer needs verification. [NVIDIA HDR metadata support](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html#hdr10-hdr10-maxcll-mastering-display-and-itu-t-t-35-sei-metadata)

Dolby distinguishes profile 5, which lacks HDR10/SDR compatibility, from profile 8.1, which supports HDR10 compatibility. Profile 8.4 supports HLG compatibility. [Dolby Vision encoding guidance](https://professionalsupport.dolby.com/s/article/Dolby-Vision-Encoding-of-mezzanine-assets)

Consequently, a generic warning about losing Dolby Vision metadata is insufficient to establish correct fallback colors for profile 5. Record the profile and compatibility information, and require a verified conversion path for such files. Otherwise, recommend copying their video. The PRD currently allows Dolby Vision encoding with a warning, so stronger restrictions need a stated policy change.

This research did not test the deployed `jellyfin-ffmpeg7` build, NVIDIA driver, VAAPI driver, HDR samples, or playback devices. It does not establish whether any particular output loses HDR metadata.

## Resolution and Aspect Ratio

The runner fixes optional downscaling at 1920×1080. FFmpeg's CPU scale filter preserves display aspect ratio by adjusting sample aspect ratio, which describes the shape of each pixel. [FFmpeg scale documentation](https://ffmpeg.org/ffmpeg-filters.html#scale-1)

CUDA and VAAPI scaling also adjust sample aspect ratio. For a 3840×1600 source with square pixels, their formulas produce 1920×1080 with sample aspect ratio 27:20. The display aspect ratio remains 12:5. Consequently, fixed dimensions alone do not prove visible stretching. [CUDA scaler source](https://ffmpeg.org/doxygen/trunk/vf__scale__cuda_8c_source.html), [VAAPI scaler source](https://ffmpeg.org/doxygen/7.1/vf__scale__vaapi_8c_source.html)

Prefer fitting within 1920×1080 while retaining proportional dimensions and even pixel counts. This example would become 1920×800, reducing the number of encoded pixels. Treat that as an efficiency improvement and verify the final display aspect ratio on the deployed encoder.

## Output Validation

The current runner checks overall duration and minimum audio/subtitle counts. Strengthen that check to compare the selected video, intended track identities, languages, flags, layouts, and timing. Counts alone cannot detect the wrong retained track. A container duration can also remain plausible when one stream ends early.

FFprobe can inspect frames, streams, chapters, and packet timestamps. Use these to compare audio/video coverage and inspect HDR side data. [FFprobe inspection options](https://ffmpeg.org/ffprobe.html#Main-options)

For high-risk replacements, add a complete decode check that discards decoded output and fails on errors. FFmpeg provides `-xerror` for stopping on an error. This adds processing time and should be a deliberate validation policy. [FFmpeg error handling](https://ffmpeg.org/ffmpeg.html#Advanced-options)

Spec assessment: the existing order passes the PRD's mux-before-encode requirement. Subtitle conversion, attachments, and incomplete integrity comparisons deserve implementation review against stories 86, 101, and 162. Prose self-check: RULE-01, RULE-08, and RULE-H pass; recommendations and unverified deployment behavior are labeled.
