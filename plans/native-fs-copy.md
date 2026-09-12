# Plan: Native filesystem copy and Keep

Yes. Polisharr can make Keep and sidecar placement cheap without becoming a NAS vendor product. The shape that matches this tree is a **probe-and-ladder** in the process that already has the files open: try a same-volume rename, then a filesystem clone, then an in-kernel or server-side copy, then the byte copy we do today. Do not SSH into the NAS. Do not ask the operator to pick Synology vs TrueNAS vs ZimaOS.

v1 explicitly deferred this (`docs/prd.md` story 115 and the storage-aware out-of-scope list). The first implementation spent that complexity and did not earn a keep. This plan is the second attempt, scoped to the two copies that still move whole movies: work file → review sidecar, and sidecar → library path on Keep.

**User-facing outcome:** Keep of a file whose sidecar already lives on the same volume as the library finishes in seconds, not minutes. A failed Keep still restores the original (ENG-09).

---

## Recommended answers to the product forks

These are locked for this plan.

| Fork | Decision | Why |
| --- | --- | --- |
| How we go fast | **Probe the open files.** `stat` device identity, then rename / clone / `copy_file_range`. | The container already has the Arr path and the review path. SSH and path maps were the v1 trap. |
| Operator input | **None required for the fast path.** Settings shows what was detected. | Hardware detection already works this way. A “I use TrueNAS” dropdown will rot. |
| Keep staging | **Still no `.opt-new` in the library folder.** | Sonarr can steal that sibling and Keep fails with a missing file (v1 #147a). |
| Original on Keep | **Rename the library file to `.opt-old` first.** Delete it only after the new file is at the library path. | ENG-09. Speed must not skip the backup. |
| Who runs Keep | **Master only.** Workers still write the sidecar onto the shared review folder. | Multi-node already locked this. Fast Keep needs the master’s view of both paths. |
| Encode scratch | **Stay on the review volume.** No copy-to-local-disk before ffmpeg. | Path maps and per-node scratch were a v1 non-goal. Workers already share `/mnt/nas`. |
| Vendor agents | **Out of scope.** No Synology File Station API, TrueNAS middleware, or Unraid plugin. | Those APIs duplicate `rename`/`clone` and break on every firmware. |

---

## What is slow today

Keep (`replaceLibraryFile` in `src/server/promote.ts`) does this:

1. `rename` the library file to `dest.opt-old` (cheap if the folder is writable).
2. `copyFile(sidecar, dest)` (reads every byte, writes every byte).
3. Unlink `.opt-old` and the sidecar.

The encode runner also `copyFile`s the last work file onto the review sidecar when they are not already the same path.

On this household the review folder is `/mnt/nas/review-path` and the library is `/mnt/nas/Movies` (and TV). Those are the same CIFS share. A Keep of a 20 GB sidecar currently pulls 20 GB through the Docker host and pushes 20 GB back to the NAS. A same-share `rename` would be a metadata update on the NAS.

Direct write uses the same `replaceLibraryFile`. Cancel and crash recovery still look for `.opt-old`.

---

## Strategy ladder

One helper, used by Keep and by the sidecar placement. Try in order. Stop at the first success. Log which rung ran (one sentence, no paths).

1. **Same-device rename.** `stat` both paths. If `st_dev` matches, `rename(sidecar, dest)` after the original is at `.opt-old`. Instant on a POSIX volume, NTFS, APFS, and on one SMB share when the client allows it.
2. **Clone (copy-on-write).** Node `copyFile` with `COPYFILE_FICLONE`. Linux: `FICLONE` (Btrfs, XFS reflink, OpenZFS 2.2+ block clone). macOS: `clonefile` on APFS. Windows: duplicate extents on ReFS and on NTFS where the OS supports it. Two names, one set of blocks, until one file is edited.
3. **In-kernel / server-side copy.** Linux `copy_file_range` (Node’s `copyFile` already tries this on recent libuv). On CIFS this is SMB `FSCTL_SRV_COPYCHUNK`. On NFS 4.2 this is the NFS COPY op. Bytes stay on the NAS. The client only issues the request.
4. **Byte copy.** Today’s `copyFile` without flags. Always works. Always slow on a 4K remux.

`EXDEV` (cross-device rename) is not an error. It means “try the next rung.” Clone failure is not an error. Byte copy is the last rung. A real I/O error (`EACCES`, `ENOSPC`, disk failure) still fails Keep and restores `.opt-old`.

Do not write `.opt-new` next to the library file. If a clone or copy needs a staging name, keep it under the review folder.

---

## Platform matrix

Polisharr does not special-case these names in code. The ladder either fires or it does not. This table is for README and for Settings copy.

| Where the files live | Rename (rung 1) | Clone (rung 2) | Server-side copy (rung 3) | What the operator should do |
| --- | --- | --- | --- | --- |
| Linux Btrfs or XFS, same filesystem | Yes | Yes (`FICLONE`) | n/a | Put review and library on that volume. |
| Linux ext4, same filesystem | Yes | No | In-kernel copy, still writes new blocks | Rename is the win. Review folder on the same disk. |
| OpenZFS / TrueNAS, same dataset | Yes | Yes when block clone is on (TrueNAS 25.x, OpenZFS 2.2+) | SMB/NFS if the client asks | Same dataset for review and library. Cross-dataset clone can fail with `EXDEV`. |
| Synology DSM, Btrfs volume, SMB | Yes if both paths are that share | SMB duplicate extents when DSM clones Btrfs | SMB copy-chunk | Review folder on the same share as Movies/TV. Prefer Btrfs volumes. |
| Synology ext4 volume | Yes if same share | No | SMB copy-chunk (still writes blocks, no network bounce) | Same share. Faster than today’s host bounce, not instant. |
| QNAP QTS (ext4) / QuTS hero (ZFS) | Same share | ZFS clone on QuTS hero | SMB copy-chunk | Same share. QuTS hero behaves like TrueNAS. |
| Unraid `/mnt/user` (FUSE shfs) | Often no (each share looks like its own device) | No across the user share | Unreliable through FUSE | Put review on the **same user share**, or bind `/mnt/cache/...` for a cache-only library. Array disks cannot reflink across disks. |
| ZimaOS / CasaOS / OMV | Linux + Samba | Whatever the disk uses (ext4/Btrfs/ZFS) | SMB copy-chunk | Same as Linux + SMB. Same share. |
| TerraMaster TOS | Same as Linux + SMB | Btrfs if that volume is Btrfs | SMB copy-chunk | Same share. |
| Windows NTFS | Yes, same volume | Block clone on recent Windows; otherwise no | SMB copy-chunk as client or server | Review folder on the same drive letter / volume. |
| Windows ReFS | Yes | Yes | SMB copy-chunk | Prefer ReFS when the NAS is a Windows box. |
| macOS APFS local | Yes | `clonefile` | n/a | Local disks only. A Mac worker writing to SMB is the SMB row. |
| macOS or Linux as SMB *client* of any NAS | Same-share rename if the client allows it | Sometimes `FICLONE` via SMB duplicate extents | `copy_file_range` → copy-chunk | Mount one share. Do not mount Movies and review as two UNC paths. |
| NFS 4.2 | Same export | Sometimes | NFS COPY | One export, `vers=4.2`. |
| Two different NAS boxes, or USB + NAS | No | No | No | Byte copy. Say so in Settings. |

Docker does not change the ladder. A bind mount of `/mnt/nas` is the host’s CIFS/NFS/XFS. The kernel still sees the real filesystem. A named Docker volume on overlayfs will *not* clone into a CIFS library path; do not put the review folder there.

---

## What we need from operators

The fast path needs one layout rule:

**The review folder and the Arr library paths must be on the same filesystem the NAS uses for the media.** Same SMB share, same ZFS dataset, same Btrfs volume, same Windows drive. A folder named `review-path` next to `Movies` on that share is enough.

Settings already forbids a review folder inside a movie or show root. That stays. A sibling folder on the same share is the intended layout.

Mount details that help rung 3:

- SMB: one share, not two. Linux CIFS default is enough for copy-chunk on modern kernels.
- NFS: 4.2 when the NAS offers it.
- Unraid: avoid treating `/mnt/user/Movies` and `/mnt/user/review` as two devices if Keep stays slow; put review inside the media share as a sibling, or use a single disk/cache bind for both.

No SSH key on the NAS. No “path map” from `/mnt/nas/Movies` to `/volume1/data/Movies`.

---

## What Polisharr needs to build

### Module

New `src/server/fs-copy.ts` (name can move; the seam is “place this file at that path without a userspace bounce”). Public functions:

- `sameVolume(a, b): Promise<boolean>` from `stat` device identity.
- `placeFile(source, dest): Promise<{ method: "rename" | "clone" | "copy" }>` the ladder.
- `describePlacement(reviewPath, libraryRoot): Promise<{ sameVolume: boolean; note: string }>` for Settings.

Keep and the encode runner call `placeFile`. They do not call `copyFile` directly.

Node APIs only (`fs.promises`, `fs.constants.COPYFILE_FICLONE`). No `cp` shell. No `ioctl` bindings in v1 of this plan unless `copyFile` proves it never issues CIFS copy-chunk in Docker; that is a follow-up, not the first cut.

### Keep (`replaceLibraryFile`)

1. If `dest.opt-old` exists, refuse (already the rule).
2. `rename(dest, dest.opt-old)`.
3. `placeFile(sidecar, dest)`.
4. On failure, `rename(dest.opt-old, dest)` and surface the error.
5. On success, unlink `.opt-old` and unlink the sidecar if it is still present (rename already consumed it).

Do not create `dest.opt-new`.

### Sidecar placement (encode runner)

When the last work file is not already the sidecar path, `placeFile(work, sidecar)` instead of `copyFile`. Same-volume rename turns the work file into the sidecar with no extra bytes. AppleDouble cleanup from 0.2.23 still runs on whatever name remains.

### Settings

After the review folder is saved, show one line next to it:

- “Keep can rename on this volume.” when a library root and the review folder share a device.
- “Keep will copy. Put the review folder on the same share as the library.” otherwise.

Reuse the hardware-probe tone. No NAS brand names in the UI unless we later add a glossary in README.

### README

One section: put review next to Movies on the same share. Table of NAS notes (Unraid FUSE, TrueNAS datasets, Synology Btrfs). Point at this plan.

---

## Phases

### Phase 1: Probe and tell the truth

Settings reports same-volume vs copy. No Keep behavior change. Fixture tests with two temp dirs (same device vs mocked different `st_dev`).

**Acceptance**

- [x] GET settings (or a small `/api/storage` read) includes `{ sameVolume: boolean, note: string }` for the configured review folder against each enabled Arr root
- [x] UI copy uses the two sentences above
- [x] A review folder on another device does not claim rename

### Phase 2: Same-volume Keep and sidecar place

`placeFile` rename rung. Keep on this household (`/mnt/nas/review-path` → `/mnt/nas/Movies/...`) becomes a pair of renames.

**Acceptance**

- [x] Same-directory fixture: Keep replaces the library file, original bytes are gone, no `.opt-new`, no `.opt-old` left
- [x] Same-device different directories (the real case): Keep does not read the sidecar bytes (test with a spy or a large file and a time bound in a local FS test, not the live NAS)
- [x] Failed place after `.opt-old` exists restores the original bytes (ENG-09)
- [x] Cancel / crash recovery still restores `.opt-old` (existing 154a–c tests)
- [x] Cross-device Keep still byte-copies and still restores on failure
- [x] ISO Keep still ends at `.mkv` and removes the `.iso`

### Phase 3: Clone then kernel copy

Pass `COPYFILE_FICLONE` on the copy rung. Record `method` on the Review card the same way we record CUDA vs VAAPI (`encodeApi` already exists; a `placeMethod` or a log line is enough).

**Acceptance**

- [x] On a Btrfs or APFS fixture, clone succeeds and both names exist until the sidecar unlink
- [x] On ext4, clone fails closed into copy; Keep still succeeds
- [x] Review or job log names the method in everyday words: “Renamed on the same volume.” / “Cloned on the volume.” / “Copied.”

### Phase 4: Docs and household cutover

README NAS section. Confirm this household’s CIFS mount reports the same device for review and Movies. After Phase 2, a Keep of a 20 GB sidecar on that share should return while the file is still renaming, not after a 20 GB round trip.

**Acceptance**

- [x] README states the sibling-folder rule and the Unraid FUSE caveat
- [x] Household Keep of a multi-GB sidecar no longer saturates the homeserver NIC for that copy (verify after deploy; probe in Settings)
  Household probe 2026-09-12: `/mnt/nas/review-path`, `Movies`, `TV`, `Kids Movies`, and `Kids TV` share `st_dev=68`. After this build is running on the master, Keep is a rename.

---

## Spec changes

`docs/prd.md` must move story 115 and the storage-aware out-of-scope bullet. Proposed story:

> As a library owner, I want Keep to rename the sidecar onto the library path when both sit on the same volume, and to clone or copy only when they do not, so that a 20 GB replace does not wait on a network round trip.

Out of scope that **stays** out of scope: SSH-to-NAS, CIFS/NFS path maps, copy-to-local-disk before encode, vendor control-plane APIs.

---

## Tests

No live NAS in unit tests (existing rule). Seams:

- `sameVolume` with real temp dirs (same device) and a stubbed `stat` for the cross-device case
- `placeFile` rename, clone-fallback, copy-fallback
- `replaceLibraryFile` restore on place failure
- Existing Keep crash tests must still pass

A later optional integration job can run on a Btrfs loop device in CI. Not required for Phase 2.

---

## Out of scope

- SSH to DSM / TOS / TrueNAS / Unraid as root to run `cp --reflink`
- Mapping container paths to `/volume1/...` or `/mnt/user/...`
- Copying the source to a local NVMe before ffmpeg
- Changing Arr paths or asking Radarr to import from the review folder
- Writing sidecars into movie or show folders
- Guaranteeing Unraid user-share clones (FUSE will often refuse; document it)
- A Windows service or macOS launchd helper beyond the native Node process we already run

---

## Why this is not the v1 storage layer

The old work combined path maps, SSH, clonefile, and local scratch into one “smart copy” pile. This plan has one seam (`placeFile`), one operator rule (same volume), and a fallback that is today’s code. If the probe is wrong, Keep is slow, not unsafe.
