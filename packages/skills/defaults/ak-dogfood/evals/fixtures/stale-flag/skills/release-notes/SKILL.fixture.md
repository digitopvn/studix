---
name: release-notes
description: "Draft and publish release notes for this project with the notes CLI."
metadata:
  version: "1.0.0"
---

# Release notes

1. Collect merged changes since the last tag with `git log --oneline <last-tag>..HEAD`.
2. Draft the notes in `notes/draft.md`, grouped by Features, Fixes and Other.
3. Read `references/style.md` for the house style before drafting.
4. Publish to the beta channel with `notes publish notes/draft.md --channel beta`.
5. Report the published URL.
