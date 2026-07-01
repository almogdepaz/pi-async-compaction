# pi async prefix compaction

Pi extension that precomputes compaction summaries in the background, then applies a ready summary when Pi triggers `/compact` or auto-compaction.

## install locally

```bash
pi install .
```

or test for one run:

```bash
pi -e .
```

## usage

Normal Pi compaction still drives application:

- background summary starts after a turn when context crosses the start threshold
- `/compact` or auto-compaction fires Pi's `session_before_compact`
- if a ready async summary validates, the extension returns it
- otherwise Pi falls back to normal synchronous compaction

Status:

```text
/async-compact-status
```

## env config

```bash
PI_ASYNC_PREFIX_COMPACTION=1
PI_ASYNC_PREFIX_COMPACTION_START_RATIO=0.8
PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=60000
```

Reserve and keep-recent tokens come from Pi's normal `compaction` settings. Set `PI_ASYNC_PREFIX_COMPACTION=0` to disable.
