# Engineering Standards

This file is the **code** standard for Polisharr. [CODING_STANDARDS.md](CODING_STANDARDS.md) is the **prose** standard (The Elements of Agent Style). [docs/prd.md](docs/prd.md) is the **product** spec.

A change can pass one and fail another. Review them as separate axes. Cite a rule by id (`ENG-04`) in review comments.

Break a rule when following it would make the code worse. Name the rule you are breaking and why.

## Sources

These are not invented house rules. Each section maps to a published practice:

| Source | What we take from it |
| --- | --- |
| [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) | Types, `any`, nullability, imports |
| [Microsoft TypeScript Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html) | Public types, no `Number`/`String` wrappers |
| [Google Engineering Practices: Code Review](https://google.github.io/eng-practices/review/reviewer/looking-for.html) | Design, complexity, tests, naming |
| [OWASP ASVS 4.0](https://owasp.org/www-project-application-security-verification-standard/) + [Secrets Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) | Auth, sessions, secret storage |
| [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices) | Command injection, path handling |
| Fowler, *Refactoring* ch. 3 | Smell names the review skill already uses |
| Kent Beck / *Working Effectively with Legacy Code* | Tests assert public behavior |
| [The Twelve-Factor App](https://12factor.net/) | Config in env, one process, logs as events |

`tsconfig.json` already enables `strict`. Do not weaken it.

---

## ENG-01: Keep functions small and named for one job

**Source:** Google review guide (“Complexity”), Fowler *Extract Function*.

A function does one thing a reviewer can name in a clause. If the honest name is “and”, split it.

- BAD: `refreshAll` syncs Arrs, inspects files, and enqueues auto-optimize as one blob with no names for the steps.
- GOOD: `refreshAll` calls `refreshKind`, then `inspectPending`, then `enqueueNewImports`.

Skip this when the “and” is the public operation (Keep = replace + notify). Name that operation, do not split the user-facing verb.

## ENG-02: Types describe domain values; stop passing raw strings for them

**Source:** Google TS Style (“Type system”), Fowler *Primitive Obsession*.

Use a union, branded type, or small object when a string is really a closed set or a pair that always travels together.

- BAD: `kind: string` for an Arr; `status: string` for a job.
- GOOD: `kind: "radarr" | "sonarr"`; `status: "queued" | "held" | "running" | "succeeded" | "failed" | "cancelled"`.

Do not invent types that have one field and one use. That is speculative generality.

## ENG-03: Never use `any`. Narrow at the boundary.

**Source:** Google TS Style (`any` is banned except documented escape hatches). Microsoft handbook.

Arr JSON and ffprobe output enter as `unknown` (or `Record<string, unknown>`). Parse them into a typed value once. After that, call sites use the typed value.

- BAD: `(probe as any).streams[0].codec_name`
- GOOD: `parseFfprobe(path, probe: Record<string, unknown>): InspectionReport`

`as never` in tests is a last resort. Prefer a real fixture object.

## ENG-04: Tests assert observable behavior, not private wiring

**Source:** Plan line “asserting public behavior only.” Beck TDD. Google review guide (“Tests”).

A test names an outcome a user or HTTP client can see. If a refactor of internals breaks the test with no behavior change, the test was coupled to the implementation.

- BAD: `expect(store.db.prepare).toHaveBeenCalledWith(...)`
- GOOD: `expect(await app.request("/api/review")).` body lists one sidecar; the library file is still the original.

Every phase that touches a module ships tests for that module. Table-drive suggestion rules and parser fixtures. Fake Arr/Plex HTTP. Do not require a live NAS or GPU for unit tests.

## ENG-05: Fail closed. Do not hide errors or invent success.

**Source:** Google review guide (“Defensive programming”). This app’s execution policy.

Empty `catch` is forbidden unless the next line documents why ignore is safe (`unlink` of a temp that may not exist). Do not copy a source duration onto an encode result. Do not treat a hardware miss as a remux. Do not return 200 when Keep did not replace the file.

- BAD: `durationSec: req.report.durationSec` after ffmpeg
- GOOD: probe the output; throw `IntegrityError` if duration is missing or short

## ENG-06: Secrets never leave the server in the clear

**Source:** OWASP ASVS V2/V6. Plan schema: “hashed or encrypted at rest; never echoed after save.”

| Secret | At rest | In API responses |
| --- | --- | --- |
| Admin password | argon2id (already) | never |
| Arr API key | encrypted or at least not returned | `hasApiKey: true` only |
| Player token | same | `hasToken: true` only |
| Homepage widget key | SHA-256 | never (shown once on mint) |
| Arr webhook token | SHA-256 | `hasWebhookToken: true` only (raw token shown once on mint) |
| Cluster token | SHA-256 | `hasClusterToken: true` only (raw token shown once on mint) |
| Session | random id, httpOnly cookie | cookie only |

Do not log API keys, tokens, or password hashes. Do not put them in query strings. Do not commit `.env` or `config/*.db`. Radarr/Sonarr Connect may send the webhook token as `?apikey=` when the form only has a URL (issue #41); prefer `X-Api-Key` or HTTP Basic so the token stays out of access logs.

## ENG-07: AuthZ is server-side. Optimize stays gated.

**Source:** OWASP ASVS V4. Plan Phase 1.

Every `/api/*` route that mutates library, jobs, or settings checks the session (or the documented local-address bypass). First-run and language confirmation block optimize, queue, and Keep. UI hiding a button is not access control.

Failed login uses one generic error. Do not say whether the username exists.

## ENG-08: Do not interpolate untrusted strings into a shell

**Source:** Node.js security best practices. CWE-78.

ffmpeg, ffprobe, and `mkvmerge` get argument arrays (`execFile`), never a shell string. Paths from Arrs are used as file operands, not as shell fragments.

- BAD: `exec(\`${ffmpeg} -i ${sourcePath}\`)`
- GOOD: `execFile(ffmpeg, ["-i", sourcePath, ...])`

## ENG-09: Library files are sacred until Keep

**Source:** Plan output policy. Google review guide (“Correctness”).

A job writes only under the review path. The Arr library path is unchanged until Keep. Cancel, crash, integrity failure, and hardware failure leave the original. A pending sidecar locks a second job on that title. Review path must not sit inside an Arr library root.

A crash during Keep must not leave a Review card stuck as keeping with no retry. If the replace did not finish, the original stays and the card becomes pending. If the library file already matches the sidecar, Keep counts as done. Tests must prove the original bytes survive the failure path.

## ENG-10: One module, one reason to change

**Source:** Fowler *Divergent Change* / *Shotgun Surgery*. Google review guide (“Design”).

Put HTTP in `app.ts`, persistence in `store.ts`, Arr HTTP in `arr.ts`, encode in `optimize.ts`, queue in `jobs.ts`. A bug about Sonarr episode files is fixed in `arr.ts`, not by parsing JSON in a React page.

Duplicated helpers (`cookieHeader`, public player JSON) belong in one module. Copy-paste across five test files is a finding.

## ENG-11: Names match the domain

**Source:** Google review guide (“Naming”). Fowler *Mysterious Name*.

`listEpisodes` returns episodes, not `ArrMovie[]`. A series payload is not `movieListPayload`. Job status `"succeeded"` means the sidecar is ready, not that Keep ran.

If you cannot name it, the type is wrong.

## ENG-12: Config and process stay twelve-factor

**Source:** Twelve-Factor III, VI, XI.

Runtime knobs come from env (`CONFIG_DIR`, `PORT`, `PUID`, `TZ`, `FFMPEG`, `POLISHARR_BACKENDS`, `POLISHARR_ROLE`, `POLISHARR_NODE_NAME`, `POLISHARR_MASTER_URL`, `POLISHARR_CLUSTER_TOKEN`). Do not hard-code ubuntuserver or homeserver paths in server code. Each container is one process. In standalone mode the job runner lives in that process. A designated master may lease a job to the encode node assigned at enqueue (`plans/multi-node.md`); that is a named break of “the runner is always this process.” Interrupted local jobs and expired leases return to the queue on the same assigned node. A live remote lease survives master restart. Interrupted Keep cards recover on the master the same way as before.

Logs are sentences with the agent named (RULE-02). No leftover `console.log` of full request bodies.

## ENG-13: Commits and comments say why

**Source:** Google review guide (“Comments”). Conventional Commits (optional prefix).

A commit subject is an imperative clause: `Fail transcode when ffprobe cannot read the sidecar`. Comments explain a non-obvious constraint, not the next line. Delete comments that narrate `slots -= 1`.

## ENG-14: Reviewer checklist

Use this on every change. Skip a line only if the diff cannot touch it.

1. Does this match the spec ([docs/prd.md](docs/prd.md))? (Spec axis)
2. Would a junior engineer reading README understand the user-facing strings? (CODING_STANDARDS.md)
3. Types: no new `any`; unions for closed sets (ENG-02, ENG-03)
4. Tests: public behavior; failure path keeps the original (ENG-04, ENG-09)
5. Secrets and auth still hold (ENG-06, ENG-07)
6. ffmpeg / ffprobe / `mkvmerge` still `execFile` (ENG-08)
7. Hardware miss still fails the job (ENG-05, plan execution policy)
8. Names and module boundaries still match the domain (ENG-10, ENG-11)
