# The Buffett Question Book — English private trial

This isolated trial preserves six reviewed Circle of Competence answers, adds a reviewed stock-evaluation answer, and provides an experimental free-form answer path over selected original source contexts. It does not replace the original-language corpus or claim complete coverage of Buffett’s work.

## Answer behavior

- The seven reviewed questions return their editorial answers and source metadata without a model call.
- When the server is configured and enabled, other questions retrieve bounded, complete source contexts. One model request writes a draft; a separately reserved second request checks source support before publication. The selected runtime is Qwen3.8-Flash-Next-W8A8 through the existing MarsAPI endpoint, with JSON-object output, thinking enabled at low effort, and a 4,096-token ceiling. Writer 3.5 requests a direct lead and 1–3 sections as paragraph objects, each with its own required citation array. The server validates those arrays and inserts display markers; provider-enforced JSON Schema mode is not enabled. These are provider-reported model identifiers, not independent model-weight verification. The provider connection uses bounded streaming internally; the browser receives an answer only after the complete JSON, citation identifiers and exact quotations pass mechanical checks and the separate automated source check explicitly approves every material claim.
- Quote punctuation may be moved outside a closing quote only when the remaining quoted words exactly match an already cited original. The complete before/after trace is stored with the answer and a short note appears in the UI. No words, source keys or uncited paragraphs are repaired or dropped.
- The source check receives the exact parsed draft, the question and the complete selected original contexts, including adjacent qualifications. It checks claims, attribution, conditional wording and causal explanations. Any rejection, malformed verdict, timeout or insufficient review allowance withholds the draft. Reviewer issue text is never displayed as an answer, and there is no automatic repair or retry. The same configured model performs this separate pass; agreement does not guarantee correctness.
- Generated answers are explicitly labeled AI-generated and not human-reviewed. Mechanical checks do not establish that every interpretation is correct. Sampling against the actual originals is a separate release check, not a claim about every runtime answer.
- Unsupported topics, incomplete model responses, failed checks and exhausted trial allowance return an explicit unavailable message. They are never presented as a saved-question receipt or a successful answer.
- Follow-ups use the owned earlier question and up to 6,000 characters of its title, lead and sections as conversation context, explicitly not as evidence. All new substantive claims still require support from currently retrieved originals.
- Original excerpts, publisher links, dates, speakers and source locators accompany generated citations. Historical statements do not establish current prices, present suitability or a personal investment recommendation.

The reviewer uses the provider’s non-thinking mode to keep its structured verdict bounded; the writer retains low-effort thinking. Verdicts remain fallible. Failure logs contain only fixed failure codes, never questions, answers, source text or credentials.

## Persistence, retries and privacy

The latest twenty results and their feedback can be restored within the same anonymous browser session. Reads require the session cookie and CSRF token. There is no global visitor record list.

A client submission UUID is scoped to the session. The same UUID and payload reuse one stored result; changing its payload returns a conflict. Pending requests are pinned to their stored generation job, including across a deployment. Concurrent requests for the same question and prior-answer context share one session-scoped model job. Successful content can be reused within that session; questions are not shared across visitors through a global cache.

Processing jobs return HTTP202 for bounded polling. History reload can recover a persisted model result without making a model call. Abandoned jobs become unavailable. A failed model job is not automatically retried; a more focused, different question creates a new attempt. The per-session physical request limits also remain active.

Sessions expire thirty days after creation, not after last activity. Expired sessions and dependent question, feedback and generation-job rows are removed in small opportunistic batches when a new session is created. This is not timed erasure or permanent retention. The global budget counters are independent of session deletion and persist.

## Finite private trial limits

The server accepts only the configured MarsAPI HTTPS chat-completions endpoint and the trial model. `.env.example` contains no secret and leaves generation disabled.

The hard ceilings are **20 provider attempts for the lifetime of this trial**, **20 per UTC day**, and **CNY5 of conservatively estimated reservations** across all sessions. A fresh completed answer uses two attempts, so the 20-attempt ceiling permits at most ten uncached checked answers, fewer after failures or existing trial use. Environment values may lower these limits. A stable D1 budget row increments the count and reservation atomically before any provider request; cache reads and polling make no new paid attempt.

Reservations use request UTF-8 bytes as a conservative token allowance, add 4,096 input tokens, include the stage output cap (4,096 tokens for either writer or review), and multiply by 1.5 at the verified displayed CNY2/input and CNY4/output per million token rates. Reservations are never refunded, including network failures and unknown usage. The reviewer has its own atomic reservation before its network request; the draft is withheld if this second reservation fails. Job reservations sum both stages. Token counts are aggregated only if every attempted stage reports complete usage; otherwise the aggregate remains unknown, even when one stage reported counts. This is an application estimate and request ceiling, **not an upstream account billing cap or an invoice**. A change to code or direct database administration can alter these controls; they are not protection against an administrator resetting the ledger.

The Worker uses manual redirect handling and rejects all non-2xx responses; credentials are never forwarded to a redirected destination. The writer has a 60-second time limit and the source check has a 45-second time limit with a 4,096-token output ceiling, with a 120,000-byte serialized-input limit for either request. A pending job has a 135-second recovery limit. There is no automatic provider retry or fallback model. If a transport or parser failure occurs, the draft is not published.

## Sources, configuration and release checks

`lib/content/public-content.json` contains the seven public reviewed answers. `lib/content/live-evidence-packets.json`, `live-retrieval-index.json`, and the older `evidence-packets.json` are server-only source data. They must not be imported into client components or copied wholesale into public assets. `CONTRACT.txt` retains the original text/attribution/date rules.

Apply the existing initial migration and the new `drizzle/0001_wandering_cloak.sql` once, in order, through the Sites migration workflow. The latter adds the permanent trial ledger and session-scoped generation jobs. Do not manually erase the budget row when deploying an application revision.

The V3 offline checks use real route/session/rate-limit/Drizzle logic with an in-memory SQLite D1 shim and a mocked provider. They cover atomic reservations, concurrent duplicates, known and unknown usage, cache and history recovery, ownership/CSRF, exact reviewed content, citation rejection, reviewer approval/rejection/failure, separate review budget enforcement, aggregate usage, cache isolation from earlier unchecked jobs, and the bounded parser. They do not prove actual model quality, real network latency or hosted browser behavior. Actual model examples and the independent source review are recorded outside the application in the V3 evaluation directory; keep generation disabled until that release evidence is satisfactory.

The private Site retains its existing audience. Deploying a revision neither invites testers nor makes the Site public. Preserve the existing local service on port8795. Local preview uses the starter runtime and local D1; keep runtime state and secrets outside source/public artifacts.

---

## Starter development reference

# vinext-starter

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git and `tar` (including Windows `tar.exe`) are required for publishing; portable publication does not require Bash

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

Publish archives outside the source checkout or under its ignored `outputs/` directory. Local `.env*`, `.dev.vars*`, TypeScript build state, and tool runtime directories are ignored; keep the hosting manifest, migrations, and authored scripts in source control.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For managed Linux browser QA, follow the Sites skill's managed preview reference. The daemon runs the project's Vite dev script with `--host 0.0.0.0 --port 4173 --strictPort`; use the CLI's returned URL. The ignored local profile survives the daemon's cleared environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `worker/index.ts` is the production Worker entrypoint and preserves request-scoped connector bindings
- `scripts/vite/` contains the maintained Vite integrations and the vendored Sites plugin license
- `scripts/connector-preview/` contains the local connector preview Worker and session helpers
- the remaining `scripts/` files select execution profiles and run installation, development, and builds; the plugin's helpers orchestrate the Sites lifecycle
- `dist/` contains generated deployment output; `.vinext/`, `.wrangler/`, and `.sites-runtime/` contain ignored local tool state
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
