# HTML Slide Studio Product Contract

## Product promise

AIで作った静的HTMLスライドを、手元で仕上げて、そのまま発表できる。

## Identity and naming

- Productの正式名は`HTML Slide Studio`、公開repoは`fukamin-lab/html-slide-studio`。
- 過去のrewriteや内部保守上の識別子は、別の現行製品名として利用者へ表示しない。

## Supported deck profile

- Local static HTML.
- Slides expressed by Reveal sections, `section.slide`, `[data-slide]`, or `article.slide`.
- Plain `body > section` / `body > article` is preview-compatible, but its structural commands are disabled because generic page sections cannot be distinguished safely from slides.
- Existing relative assets contained under the HTML directory.
- No required network connection or runtime-only JavaScript.

Unsupported or limited decks must be reported before editing. The app must not claim parity between its sanitized preview and a script-dependent browser rendering.

The sanitized preview and Presenter document remove scripts, inline event handlers, `javascript:` / `vbscript:` / `data:` / `blob:` URL attributes, and `srcdoc`. Patch rollback data is retained only as in-process cloned DOM state, never read back from source-controlled HTML attributes.

## Save transaction

```text
read current source
  -> compare open fingerprint
  -> render edited HTML in memory
  -> validate output contract
  -> create and flush an owner-marked transaction journal
  -> write same-directory temporary file
  -> flush and read back bytes
  -> compare source fingerprint again
  -> Windows File.Replace(temp, target, backup)
  -> verify backup fingerprint still equals the open fingerprint
  -> reopen and validate target
  -> rollback only while target fingerprint still equals intended output
  -> delete journal and rollback copy only after verified success
```

Any failure before replace leaves the original bytes untouched. `File.Replace` captures the exact replaced target as backup in the same operation. If its fingerprint shows a race or post-replace validation fails, the backup is restored only while an exclusive target handle proves that the current target still equals the app's intended output. If it differs, a post-replace external race is reported, the target is left untouched, and the backup is retained for recovery.

Save, open/recovery, and asset-import requests for the same canonical path are serialized FIFO in the main process. The renderer makes manual open, file-association/second-instance launch open, and save mutually exclusive. A launch arriving during save remains pending and unconsumed. If launch open starts first, it owns the document operation until its payload is applied, so save cannot begin behind a stale open payload. Save completion updates renderer state only when the same document generation remains active. A queued save whose expected source fingerprint is stale fails as a conflict instead of overwriting the preceding save.

Rollback may be interrupted after truncation, so the flushed owner journal and valid backup remain until the restored target is re-read and fingerprint-verified. On the next open, canonical parent/target validation happens before any mutation. Recovery recognizes only an exact UUID artifact set with a valid `html-slide-studio-legacy` owner journal, orders transactions by the journal timestamp, treats a missing or invalid target as recoverable, and never treats a filename pattern alone as ownership. Invalid interrupted bytes are captured separately when a valid backup is restored. A valid externally changed target is not touched; the captured backup is retained as a recovery copy. Recovery and retained-race outcomes are returned as open warnings to the user. No permanent app-specific project or version history remains after verified success.

## Asset contract

- Existing relative references remain relative to the original HTML directory.
- Added images are copied to `<deck-name>.assets/` beside the HTML.
- Generated asset names use a sanitized stem plus content hash to avoid collisions.
- The adjacent directory is used only when its app ownership marker is present; an unmarked existing directory is a collision.
- An index records only app-generated files. An existing hash-named file not already in the index is a collision even when its bytes match. Successful save removes only indexed files no longer referenced by the HTML.
- Reopening the same HTML also removes indexed files not referenced by the saved HTML, recovering assets left by an unsaved exit or crash.
- Reference discovery uses one URL-aware contract across quoted and unquoted HTML attributes, `srcset`, CSS `url()` / `@import`, and percent-encoded paths, so referenced indexed assets are not garbage-collected.
- A `srcset` containing a data URI is rejected because comma-separated candidates can otherwise hide an absolute local path from portable validation.
- Absolute source paths and `file:` URLs are not written into saved HTML.
- Images are not embedded as data URI, avoiding HTML file-size growth.

## UI contract

```text
Start: Open HTML | Open demo working copy
Open | document name | Undo | Redo | Check | Save | Present
Slides | Canvas | Contextual properties
Speaker notes
```

The packaged app includes one immutable demo template. `Open demo` creates the editable copy only when it is absent under the app user-data directory, then opens that copy through the same authorization and save path as a user-selected HTML file. Reopening the demo never overwrites prior edits or the packaged template.

The UI contains no project-format vocabulary, disabled collaboration controls, command palette, theme gallery, review workflow, or Office-style tab ribbon.

`Check` inspects every detected slide in one run without visibly paging the editor through the deck. Each targeted issue includes the slide number and label; choosing it navigates to that slide and selects the affected element. Text clipping means overflow that is actually clipped or requires scrolling; visible font ink outside a line box and healthy wrapping are not clipping. The check uses the same sanitized, currently edited HTML that would be saved or presented.

## Acceptance evidence

1. Same-path save and reopen.
2. Relative CSS and image references remain valid.
3. Failed save leaves original bytes unchanged.
4. External modification prevents overwrite.
5. Added images use adjacent relative assets without data URI.
6. Slide add, duplicate, and reorder persist after save.
7. Text, basic style, move, resize, Undo, and Redo remain functional.
8. Presenter opens, navigates, and exits in single- and multi-display logic.
9. Malicious input remains isolated from Node and external navigation.
10. Failure injection before and after replace proves original-byte preservation or rollback.
11. Asset directory collision, reparse indirection, and path escape fail closed.
12. Nested Reveal sections are not mutated as top-level slides.
13. Saved HTML contains no absolute local path, `file:` URL, or `.hslides` reference.
14. Presenter renders saved/reopened plain-text notes while exposing no file open/save bridge.
15. Concurrent same-document saves execute in FIFO order and a stale queued save cannot overwrite the preceding result.
16. Recovery reports retained external-race backups and restored invalid targets to the user.
17. A second-instance file launch during save is deferred, then opens after save without mixing either document's path, source, or fingerprint.
18. The packaged demo opens from the start screen as an editable copy without modifying the bundled template or overwriting an existing copy.
19. One check run inspects every slide without changing the visible slide, and an issue on another slide navigates to and selects its target.

## Slide mutation contract

- Only top-level siblings under one detected slide parent are mutable.
- Reveal uses `.reveal .slides > section`; nested sections remain slide content.
- Add inherits the current slide's tag, class, inline dimensions, and deck-identifying attributes, then inserts title/body placeholders.
- Duplicate deep-copies the visible slide and regenerates HTML IDs, label/ARIA/fragment/SVG ID references, and all `data-hss-*` identities.
- Reorder moves the complete slide subtree and notes within the same parent.
- Unsupported or ambiguous structures disable structural commands instead of guessing.
- Speaker notes persist as escaped plain text in the top-level slide's `data-speaker-notes` attribute and rehydrate from that attribute.

## Presenter topology contract

- One display: audience-only fullscreen in the main window; no notes UI.
- Two or more displays: audience fullscreen on a non-primary display and Presenter on the primary display. With three or more displays, choose non-primary by descending pixel area and then ascending display id.
- Placement failure falls back to one-display behavior.
- Presentation uses current unsaved edits, applies the same safe-preview sanitization, and restores the editor window on exit.
