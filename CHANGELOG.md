# Changelog

## [Van Inventory] v0.1.0 — 2026-09-26

ADDED - first release
- Scan screen: Remove / Add / Find modes, step chips, instant apply with an Undo card
  (−/+/Exact/Job), unknown barcode → add new part / link to an existing part / ignore,
  torch, zoom, rear-camera picker, typed codes, scan from photo.
- Parts: search, filters (low, Return pile, no barcode, verify, type, shelf), quick ±,
  part page with shelf move, codes (many per part), history with undo, delete/restore.
- Shelves: van map (left side 1–6 with the floor under 3, right side 7–9 with three
  drawers under 9, Return pile, Unassigned), shelf pages, "scan parts onto this shelf",
  locations manager (rename, reorder, add, merge).
- Count: quarterly count walked location by location, scan & count, review of variances,
  one-step commit with a full snapshot, history and comparison with the previous count.
- Insights: reorder list, weekly usage (pieces and feet kept apart), most used, by type,
  busiest locations, Return pile aging, dead stock, parts that need a look.
- Import of the van spreadsheet (Brand/Model/Amount/Barcode/Type/Shelf/EXTRAS) with a
  preview and shelf mapping; Excel export (Inventory, By shelf, Low stock, Return pile,
  Movements), count export (Summary, Variances, Snapshot, Compare), CSV, JSON backup/restore.
- Offline-capable PWA with its own cache prefix and self-healing precache.

Version: — -> 0.1.0
Files changed: initial commit
