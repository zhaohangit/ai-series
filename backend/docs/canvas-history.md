# Canvas version history

Canvas graphs are stored in the existing `canvases` table. Immutable snapshots live in `canvas_versions`, scoped to their project and owner. The model must be imported before `Base.metadata.create_all()` runs. Existing databases receive the new table at startup; no existing graph or revision is rewritten.

Register routes with `register_canvas_versions(app, owner, database, owned)`. All endpoints verify project ownership; a version from another project or account is not found. There is no delete or purge history endpoint. Removing a project follows the existing project foreign key cascade.

`checkpoint(session, project_id, owner_id, data, revision, kind='auto', name='')` deep-copies the graph and adds a snapshot in the caller's transaction without committing. Do not call it for a failed graph write. The current revision belongs in the version column, not inside its stored graph. Automatic canvas writes and generated node results should checkpoint the successfully persisted graph and its new revision before committing. An initial baseline may be captured before the first update of an existing canvas.

- `GET /api/projects/{pid}/canvas/versions?limit=20&offset=0`: `{items, total, limit, offset}`. Limit must be 1–100 and offset nonnegative. Items contain `id`, `project_id`, `revision`, `kind`, `name`, `created_at`, `node_count`, `edge_count`; the query never reads graph JSON.
- `POST /api/projects/{pid}/canvas/versions`: `{name, revision}` saves the current server graph as `manual`. The expected revision is required. Arbitrary graph input is rejected. Success returns version metadata with HTTP 201.
- `GET /api/projects/{pid}/canvas/versions/{vid}`: metadata plus `nodes`, `edges`, `viewport` for preview. The returned revision is the original snapshot revision.
- `POST /api/projects/{pid}/canvas/versions/{vid}/restore`: `{revision}` must match the current canvas revision. In one transaction, compare-and-swap the selected graph into the canvas, preserve the previous graph as `before_restore`, and checkpoint the restored result as `restored`. The new revision is current revision plus one. The selected snapshot is untouched. Success returns `{nodes, edges, viewport, revision}` in the canvas API shape.

A stale manual save or restore returns HTTP 409 and adds no history. Manual saves use a no-op compare-and-swap update to serialize their snapshot with concurrent graph writes. Restores use the same conditional update as canvas writes, ensuring a racing edit cannot be overwritten. A failed restore rolls back its graph and snapshots together.

The `CanvasVersions` panel calls the editor's `prepare()` before saving or restoring. `prepare()` must flush drafts and return the actual server revision; null cancels the operation. An edit after this flush is protected by revision compare-and-swap and returns a visible conflict. Its `onRestored(graph)` must replace the editor graph and revision and reset local undo/redo. The panel previews counts and node labels, asks for explicit restore confirmation, and states that the current graph is retained. Request errors remain visible with retry; success is shown only after an accepted server response.

Run `backend/.venv/bin/pytest backend/tests/test_canvas_versions.py` from the repository with appropriate Python import path, or `.venv/bin/pytest tests/test_canvas_versions.py` inside `backend`. The standard test fixture uses an isolated SQLite file by default and an isolated PostgreSQL schema when `TEST_DATABASE_URL` is configured.
