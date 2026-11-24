# shuagent

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slatscartoon4o/shuagent/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slatscartoon4o/shuagent/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one command-line tool that applies the edits AI models write — unified diffs, SEARCH/REPLACE
blocks, V4A patches and JSON edit calls — to a tree of files, matching lines at three tiers and
writing every change or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

With no `--format`, the format is detected from the patch. `--check` prints what would change
without writing it, and `--strict` matches lines exactly. When `PATCH` is absent or `-`, the patch
comes from standard input.

To run the public practice checks on your own machine:

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=gkrspr1e&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
