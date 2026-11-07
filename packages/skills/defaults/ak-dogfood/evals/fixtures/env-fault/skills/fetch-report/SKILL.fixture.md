---
name: fetch-report
description: "Download the weekly metrics report from the internal reports service and summarize it."
metadata:
  version: "0.3.0"
---

# Fetch report

1. Download with `curl -sf -H "Authorization: Bearer $REPORTS_TOKEN" https://reports.example.test/weekly.json -o weekly.json`.
2. Summarize the five largest changes week over week.
