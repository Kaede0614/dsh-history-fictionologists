# Review round 3 — status and queued hardening

Last updated: 2026-09-26, after the round-3 submission.

## Submission state

Round-3 revision sent to the independent reviewer with a complete frozen hash set:

```
lib/shell.js                 52385  BDB2359D5EAE3DC0   R2-2 (canonicalDatasetId), R2-3 (restore() closure)
lib/wiki/client.mjs          13759  62737A321C54CFEC   clock seam (flake fix)
test/host-validator.test.mjs 19476  D3844D8F3886500D   alias + seam/pinning regressions, tightened assertion
test/wiki.test.mjs           35245  83629C8AB2E58777   deterministic throttle test
test/plugin.test.mjs         10977  5FF816A62536767C
test/missions.test.mjs       33710  BDD6041E1D36495C
lib/resolve.js                5612  ED1410B6B284B1BA
lib/paths.js                  4170  B120A1C4C27D9825
lib/missions.js              43749  8989F68A5BB34A30
lib/digest.js                29090  EC55E066177912D5
lib/wiki/index.mjs           20108  D9F190D289D0560A
package.json                  1172  B084A2D2A5AF60CE
cordis.patch.yml              1091  C1D4660E3CF7BD1A
scripts/check.mjs             2577  BD59AF8EDB1AB660
```

**The repo is frozen at these hashes until the reviewer reports.** Two earlier rounds were
damaged by editing after declaring a freeze; that mistake is not being repeated.

## Verified on this exact revision

```
node --test                  -> tests 92 / pass 91 / fail 0 / skipped 1
node scripts/check.mjs       -> RESULT: PASS (syntax failures: 0, test exit: 0)
cmd /c "npm test"            -> pass 91 / fail 0
dsh-plugin-dev check         -> OK (9 passed, 0 failed, 1 warned, 5 skipped)
_e2e-wiring.mjs (real wiki)  -> ALL WIRING CHECKS PASSED (revid short-circuit, downgrade paths)
verify-gs-e2e.mjs (isolated) -> /gs registered, discoverable, executes
requirements-audit.mjs       -> 33 / 33
live gs_setup               -> 12/12 datasets, 7 series / 52 missions, recommendation=use-cache
```

## Queued for the next revision round (do NOT apply before the reviewer reports)

### Q-1 — R2-5: symmetric finite guard on the clock seam (`lib/wiki/client.mjs:110`)

Reviewer's point, accepted: a `nowImpl` that returns a non-finite number makes
`gap = intervalMs - (NaN - last) = NaN`, so `gap > 0` is false and the throttle never sleeps —
the ≥1500 ms floor that protects against WAF blocking is silently disabled. Production-unreachable
(`createWikiClient` never passes `nowImpl`) and `ms` cannot reach a tool result, but the asymmetry
with `toNumber()` on `intervalMs`/`timeoutMs`/`maxRetries` is real.

Planned change: make the seam fall back per call instead of trusting one probe at construction:

```js
// constructor
this.#nowImpl = typeof merged.nowImpl === 'function' ? merged.nowImpl : null
// method
#now() {
  if (this.#nowImpl === null) return Date.now()
  const value = Number(this.#nowImpl())
  return Number.isFinite(value) ? value : Date.now()
}
```

plus a regression test: a clock returning `NaN` / `Infinity` must still produce exactly one
1500 ms sleep and a finite `ms`.

### Q-2 — R2-6: make the prompt-injection evidence precise and asserted

The reviewer confirmed the evidence holds, but corrected two things in my description:
1. `chars=3500` is the **whole assembled system prompt**; the section itself is **725 chars**.
   The script must print both, and assert `text.includes(STYLE_GUIDE)` against the current source.
2. The script only `console.log`s — it must `assert` the record type is `system/message` with
   `role === 'system'` (otherwise an `assistant/message` echo would count as a hit), and bind the
   `gs_*` tool list to the **same request** that carried the section instead of the last
   `request/header` in dictionary order.
3. It should exit non-zero on failure so it can serve as a gate, not just a report.

### Q-3 — residual risk with no offline coverage

The three user-facing features' *output quality* (does the model truly emit 3–5 inspirations in the
五段式 format, a ~2000-word story that avoids existing stories, an 800–1200-word broadcast) cannot
be verified in an isolated `DSH_HOME`: the launch token and model route belong to the user's own
instance, so `session/prompt` is accepted and then never reaches a model (observed: session log
stays empty for 180 s). This is covered by (a) the byte-identical prompt section that carries the
formats, and (b) the user's own live instance, where the model already called `gs_setup`
successfully. It remains the honest boundary of this delivery.
