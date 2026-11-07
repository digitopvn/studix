---
name: tidy-imports
description: "Sort and deduplicate Python imports in the files the user names, then run the project's tests."
metadata:
  version: "1.2.0"
---

# Tidy imports

1. Run `ruff check --select I --fix <files>` on the named files.
2. Run `pytest -q` and report the result.
