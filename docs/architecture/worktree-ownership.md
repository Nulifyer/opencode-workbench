# Worktree ownership

ADR 0003 defers native Agent Host integration, so Workbench is the sole worktree owner in stable mode. Every operation is recorded with `owner: workbench`; native-owned entries are rejected by the fallback service.

The fallback uses typed `git` arguments with shell execution disabled. Its durable journal records requested, creating, ready, setup, session, prompt-admission, failure, cleanup, dirty-retention, and removed phases. Recovery compares journal entries with `git worktree list --porcelain`. Cleanup checks the complete porcelain status and never removes a dirty worktree. Session deletion, worktree removal, and branch deletion remain separate actions.
