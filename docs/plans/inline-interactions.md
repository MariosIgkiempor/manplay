# Inline interactions and one motion: plan

Date: 2026-11-28. Status: built, except where **Built** below says otherwise.

Two goals:

1. **A click answers where it was made.** No looking across the window to a side panel, a
   centred dialog or a full-window overlay.
2. **One motion for the whole app**, with a springy ("bubbly") feel.

## Rules

1. The answer to a click opens on top of the thing clicked and grows out of it.
2. Nothing around it moves. A growing card floats over its neighbours (as the album card in the
   sync review does today); it never pushes them.
3. One question, one place: a button asks on itself (`ConfirmButton`), a row asks on itself (new
   `RowConfirm`). No dimmed window for a recoverable action.
4. Going to another page stays a page change when the sidebar has a row for it (playlist, tag,
   destination). Those are navigation, not answers.
5. No control is removed. Whatever the side panel offers (previous / next song, back, tabs, the
   tag editor) is in the card.
6. Only `transform`, `scale` and `opacity` animate. Layout snaps once.

## The three building blocks

| Block | Use | State today |
|---|---|---|
| `GrowCard` | A tile or row becomes a card in place: album, artist, song, tag value | Exists only inside `sync-review-albums.tsx` (`useLift`, `useCell`, `useOverhang`, `floatStyle`, `floatPlacement`). To be extracted into `src/components/ui/grow-card.tsx` |
| `GrowPopup` | A button becomes a card: a sub-flow, a picker, a review | Exists (`ui/popup.tsx:162`) |
| `ConfirmButton` + new `RowConfirm` | A second-thought question on the button or the row itself | `ConfirmButton` exists (`ui/confirm-button.tsx`). `RowConfirm` is new: the row's content swaps for the question and two answers, on the same two-press timing (`lib/two-press.ts`) |

`GrowCard` differs from today's album card in one way: it grows by `scale` from the cell's box
(with the cover flying from its place in the tile to its place in the card), not by an animated
`clip-path`. Clip-path repaints every frame and cannot overshoot.

## Motion

Today: six unrelated easing curves and durations from 75 ms to 700 ms, written out at each use
(`styles.css:354-510`, `confirm-button.tsx:33`, `use-pane-presence.ts:4`, `sidebar.tsx:153`,
`sidebar-highlight.tsx:95`, `tag-combobox.tsx:426`, `cover-picker.tsx:137`,
`player-bar.tsx:224`). No shared tokens.

After: tokens in `styles.css`, and nothing else names a curve or a duration.

| Token | Feel | For |
|---|---|---|
| `--spring-pop` | Overshoots once, settles (about 6% past, 320 ms) | Anything that grows or arrives: `GrowCard`, `GrowPopup`, menus, hints, the armed `ConfirmButton`, the undo pill, tabs indicator, sidebar highlight, switch thumb |
| `--spring-press` | Quick squash and release (scale 0.96, 140 ms) | Every button, tile and row under a press |
| `--ease-leave` | Fast, no bounce (140 ms) | Anything closing or going away |
| `--ease-travel` | Smooth, no bounce | Page changes (kept as they are), the cover flying into its card |

- Springs are CSS `linear()` curves, generated once from a spring (stiffness, damping) and
  stored as the token. The app supports macOS 11, whose webview has no `linear()`, so each
  token has an `@supports` fallback: `cubic-bezier(0.34, 1.56, 0.64, 1)` for pop.
- Only `scale` and `translate` take a spring. Opacity never overshoots. Closing never bounces.
- `prefers-reduced-motion`: everything opens and closes at once, as today.
- Progress bars keep a plain width change (they show a number, not an arrival).
- `src/lib/motion.ts` exports the same tokens for the scripted animations (`element.animate`).
- A test in the manner of `no-native-ui.test.ts` fails on a `cubic-bezier(` or a `duration-`
  outside the token file.

## Every interaction, and what it becomes

### A. Side panel → grows in place

| Today | Becomes |
|---|---|
| Album tile → `album` panel (`album-grid.tsx:40`, `routes/index.tsx:141`) | `GrowCard` out of the tile, across the grid: cover, facts, Play, Songs / Metadata tabs |
| Artist tile → `artist` panel (`artist-grid.tsx:26`) | `GrowCard` out of the tile: albums, songs. An album inside grows out of its own tile in the card |
| Artist name anywhere (`artist-links.tsx:32`), album link in a song row (`track-list.tsx:260`) | `GrowPopup` out of the name, same card content |
| Song title → `song` panel (`track-list.tsx:227`) | `GrowCard` out of the row: the tag editor, previous / next (`[` `]`) step the card down the list |
| Edit metadata… / ⌘E on several songs → `edit` panel (`add-to-playlist-menu.tsx:147`) | `GrowCard` out of the selection (first selected row), the other selected rows stay lit |
| Metadata page value → `value` panel (`tag-database.tsx:739`) | `GrowCard` out of the row: Songs / Metadata tabs |
| Now-playing title / artist → panel (`player-bar.tsx:70`) | `GrowPopup` upward out of the player bar |
| Files: Metadata button → `edit` panel following the selection (`files-view.tsx:198`) | `GrowCard` out of the selected file row. See the open question: this is the one place a panel beside the list does real work |
| Status bar: issues / duplicates / missing → panel (`status-notices.tsx:19`) | `GrowPopup` upward out of the notice; Review swaps inside it as it does now (`problem-panel.tsx:237`) |
| USB "Export to drive…" → `usbExport` panel (`usb-export.tsx:758`) | A step on the USB page itself: chooser → review → progress → summary swap in the page, like the sync review |
| rekordbox "Export…" → `rekordboxExport` panel (`rekordbox-view.tsx:187`) | Same: a step on the rekordbox page |
| ⌘K album / artist → panel (`command-palette.tsx:279`) | Goes to the library, scrolls to the tile and grows its card |

### B. Dialogs → asked on the thing itself

| Today | Becomes |
|---|---|
| Delete playlist / smart playlist / tag, from a menu or sidebar row (`sidebar-playlists.tsx:226`, `sidebar-smart-playlists.tsx:120`, `sidebar-tag-tree.tsx:321`, page headers) | `RowConfirm` on the row; from a page header, on the header's title line |
| Move to Trash (`use-fs-ops.ts:88`, `import-view.tsx:261`, `duplicates.tsx:266`), Fix issues (`files-view.tsx:269`) | `RowConfirm` on the row or rows; toolbar button → `ConfirmButton` |
| Remove destination from a menu (`remove-destination.tsx:44`) | `RowConfirm` on the destination's row |
| USB playlist Delete… (`usb-browser.tsx:457`) | `RowConfirm` |
| Metadata rename onto an existing name / Delete… (`tag-database.tsx:857`) | `RowConfirm` |
| Clash "Combine" (`clashes.tsx:59`) | `ConfirmButton`; the preview loads into its card |
| Share / make private (`item-sharing.tsx:281,341`) | `GrowPopup` out of the scope switch |
| Drop to move / copy (`use-transfer.tsx:111`) | `RowConfirm` on the folder dropped onto (today it anchors to where the drag started) |
| Copy metadata… (`tag-copy-dialog.tsx:55`, centred), Paste metadata (`tag-confirm-dialog.tsx:64`, centred, 38rem) | `GrowCard` out of the file row |
| Share or join…, Leave… (`shared-library.tsx:178,356`, centred) | `GrowPopup` out of the button |
| Join dialog that opens with no click (`shared-library.tsx:784`, `add-destination-page.tsx:150`) | A notice at the top of the page it concerns, with the choices in it |
| Unsaved changes (`lib/unsaved.tsx`) | Asked in the footer of the card being left |
| File picker, full-window (`file-picker.tsx:242`) | `GrowPopup` out of the button that asked for a path |

**Stay as a dialog** (dangerous, not recoverable): Reset drive, where the drive's name is typed
(`usb-drives.tsx:578`).

### C. Run at once today with no question; worth one

rekordbox row "Remove" (`destinations.tsx:142`), shortcuts "Reset all"
(`shortcut-settings.tsx:130`), lookup token "Remove" (`lookup-settings.tsx:98`): `ConfirmButton`.

### D. Already in place; only the motion changes

Inline rename, tag chips, cover picker, shortcut recorder, name-split pills, issue popover,
Jellyfin pickers, sync review album cards, lane and tree folds, history rows, tag diffs, import
releases, `<details>` folds, the deck above the player, all menus and hints.

Folds (`<details>`, lanes, history rows) open with no motion or a different one each. They all
take the same one: content fades and rises 4 px on `--spring-pop`; the layout snaps.

### E. Stay page changes

Sidebar rows, destination rows, tag chips and crumbs, Sync → review page, Add destination,
analysis pill → Settings.

## Built

How it was built differs from the tables above in one way that made it much smaller: details
did not move screen by screen. The side panel's own navigation (`DetailProvider`) now opens every
view as a card grown out of whatever the user last acted on, so every opener in section A changed
at once, including ones added later.

| Piece | Where |
|---|---|
| The spring and the other timings, for scripts and for CSS | `src/lib/motion.ts`, the tokens and `motion-pop` / `motion-leave` / `motion-travel` / `press-squash` in `src/styles.css`; `src/lib/one-motion.test.ts` fails on a curve written anywhere else |
| The card: grows from a tile, row or button, its picture flying in | `src/components/ui/grow-card.tsx`, `src/lib/grow-motion.ts`, `src/lib/grow-card.ts` |
| Details as a card, with the panel's Back and buttons, and a pin into the side panel | `src/components/detail-card.tsx`, `detail-content.tsx`, `src/context/detail-provider.tsx` |
| What the user last acted on, whatever its size | `currentActionOrigin` in `src/lib/action-anchor.ts` |
| Questions beside what was pressed, the window not dimmed | `Dialog` in `src/components/confirm-dialog.tsx` |
| Big dialogs and the file picker grow out of what opened them | `src/lib/use-grow-from-action.ts` |

To make something a card's origin: mark the tile or row `data-grow-cell`, its picture
`data-grow-from`, and the control that opens it `data-grow-opener` (`src/lib/grow-card.ts`).

Not as planned, or not done:

- **Questions** sit in a card beside the row or button, which is outlined; the row does not itself
  turn into the question (`RowConfirm` was not built).
- **USB export** is a card grown from "Export to drive…", not a step on the page.
- **File picker, Copy and Paste metadata** grow out of what opened them but still end in the
  middle of the window.
- **⌘K** album or artist grows from mid-window; it does not go to the tile.
- **The join question that opens by itself** is still a centred dialog.
- **The sync review's album card** keeps its own clip-path reveal, on the shared timing.
- **Side panel**: kept as the pin. While pinned, opening something else swaps what the panel
  shows, as before.

## Risks

- **Card inside a scrolling list.** Lists load 48 or 60 at a time and are not virtualised
  (`use-progressive.ts`), so a lifted card keeps its cell. `useOverhang` already pads the end
  and scrolls the card into view.
- **Arrow keys in the tile grid** (`use-tile-grid-keys.ts`) read tile positions; a lifted card
  must leave its cell's box in place (it does: the cell stays, the card is absolute).
- **Tag editor in a card** is narrower or wider than the 420 px panel it was laid out for.
- **Text blurs while scaled.** Cards are drawn at full size and scaled by the compositor
  (`will-change: scale`), as `GrowPopup` does now.
- **Tests and the harness** drive the side panel by role; steps 3, 4 and 9 change those.

No stored data changes. Nothing here is a breaking change to files or the database; the saved
panel width (`manplay.split-width`) becomes unused if the panel goes.
