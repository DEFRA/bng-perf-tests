# Perf fixtures

Large baseline GeoPackages used by `scenarios/baseline-overlap-scaling.jmx`
(BMD-911). They are committed via **git-LFS** (see `../../.gitattributes`) and
baked into the CDP image by the `Dockerfile`, so the scenario runs identically
locally and from the CDP Portal. After cloning:

```sh
git lfs pull
```

## What they are

Two synthetic baselines whose Red Line Boundary is partitioned into a clean,
**non-overlapping tiling** of edge-sharing habitat parcels — `N` and `2N` of
them. That tiling is the worst case for the un-indexed overlap self-join the
scenario targets: the planner still walks ~`N²/2` candidate `idx < idx` pairs
and runs `ST_Intersects` on each, even though there are zero real overlaps to
report. Doubling the parcel count roughly quadruples that work pre-fix and only
doubles it post-fix — which is the whole point of the scaling read.

| File                        | Parcels | Purpose                                    |
| --------------------------- | ------- | ------------------------------------------ |
| `baseline-overlap-1000.gpkg`| 1000    | linear reference point (`validate @small`) |
| `baseline-overlap-2000.gpkg`| 2000    | the BMD-911 gate (`validate @large`)       |

The `.jmx` reads the filenames from the `fixtureSmall` / `fixtureLarge`
properties, so you can point it at different sizes without editing the plan.

## Regenerating them

The generator lives in the **harness** (`bng-metric-harness`), not here — it
needs the shared `bng-library` engine and a native `better-sqlite3` build, so it
can't run from inside this repo or the JMeter image. From a checked-out harness
with `npm install` done (Node 24 — run `nvm use` first):

```sh
# from the bng-metric-harness root
node scripts/gen-gpkg.mjs --size 1000 --seed 911 \
  --outdir ../bng-perf-tests/scenarios/fixtures
node scripts/gen-gpkg.mjs --size 2000 --seed 911 \
  --outdir ../bng-perf-tests/scenarios/fixtures
```

A single synthetic file (no `--pair`) is a baseline-shaped GeoPackage whose Red
Line Boundary is partitioned into `--size` non-overlapping habitat parcels — the
input this scenario needs. `gen-gpkg` names its output `bng-test-data-…-<stamp>.gpkg`
(the timestamp keeps repeat runs from clobbering each other), so **rename** the
two files to `baseline-overlap-1000.gpkg` and `baseline-overlap-2000.gpkg` (or to
whatever you set in the `fixtureSmall` / `fixtureLarge` properties). `--seed 911`
makes the geometry/attribute draw deterministic, so the *contents* of a
regenerated fixture are byte-identical and don't churn LFS history. Then:

```sh
# from the bng-perf-tests root
git lfs track "scenarios/fixtures/*.gpkg"   # already in .gitattributes; no-op if set
git add .gitattributes scenarios/fixtures/*.gpkg
git commit -m "BMD-911 Add baseline overlap-scaling perf fixtures"
```

Push needs git-LFS installed and the remote LFS store enabled for the repo.
