# Director Desk — Automated Test Case Specification V1

**Scope:** Director Desk / Director Engine V1 prototype, with emphasis on Director View path editing, Move Segment temporal behavior, shared spatial nodes, Curve/Line semantics, timeline context, playback, magnet, zoom, and director-state persistence.

**Primary regression baseline:** `Director_Desk_V1.8_Path_Logic_Timeline_Fixed.html`

**Purpose:** This document converts the interaction rules discussed during prototype development into deterministic test cases suitable for future browser automation (Playwright/Cypress/WebDriver) and lower-level unit tests.

---

## 1. Product-level principles

1. **Director decides; Solver computes; Three.js/renderer represents.** The prototype may use a pseudo-3D canvas, but the data model must remain director-intent oriented.
2. **Timeline is temporal context.** Adding a Segment is an operation at the current playhead, not an abstract global command.
3. **Director View is the primary spatial editing surface.** Path geometry must be directly editable on the canvas.
4. **Spatial Node = Where.** Start/End/shared nodes define spatial topology.
5. **Move Segment = When + how to travel between spatial nodes.**
6. **Path Shape = how the path bends.** V1 supports LINE and ARC.
7. **Path geometry and timeline timing are independent dimensions.** Moving a timeline clip changes time, not spatial geometry.
8. **Director State is persistent intent.** Visual edits must update state, and playback must use the same state.
9. **Start/End are endpoints, not Curve control points.** They never expose a LINE/CURVE toggle.
10. **Curve points are control points, not points the path passes through.**
11. **Two Curve points may never be adjacent.** A Curve point requires both immediate neighboring intermediate points to be LINE when those neighbors exist.
12. **Invalid Curve adjacency must be normalized to LINE.** Normalization runs after path mutation and before/while redraw.
13. **If a LINE point cannot legally become CURVE, its toggle button is absent, not disabled.**
14. **Dragging a shared node changes both adjacent segments.** Topology is shared, not duplicated.
15. **A newly inserted path point must be inserted into the correct local path interval.** It must not simply be appended to the end of the points array.

---

# 2. Core data model tests

## TC-DATA-001 — Actor Origin exists

**Given:** A new actor M17 is created.

**Expected:**
- An `ORIGIN` spatial node exists.
- Origin has x/z coordinates.
- Origin is visible/selectable in Director View.
- Dragging Origin updates its coordinates.
- Origin is the default start node for the first Move Segment.

**Automation:** Assert DOM/canvas state or exported Director State contains `ORIGIN` and valid coordinates.

---

## TC-DATA-002 — Move Segment references nodes, not copied coordinates

**Expected Segment shape:**

```json
{
  "id": "SEG_01",
  "startNode": "ORIGIN",
  "endNode": "N1",
  "shape": "LINE",
  "points": []
}
```

**Expected:** Segment references shared node IDs. It does not own independent endpoint coordinates.

---

## TC-DATA-003 — Shared node topology

Create:

`ORIGIN → SEG_01 → N1 → SEG_02 → END`

**Expected:**
- SEG_01.end = N1
- SEG_02.start = N1
- There is exactly one N1 object in state.
- Moving N1 changes both segments.

---

# 3. Timeline / temporal insertion tests

## TC-TIME-001 — Add Segment uses current playhead

**Given:** Current frame = 2.0s.

**When:** Click `＋ Add Segment`.

**Expected:**
- New Segment starts at current frame or a snapped equivalent.
- The operation creates a timeline clip.
- The new Segment is selected.
- The UI context reports the selected object and frame.

---

## TC-TIME-002 — Start derives from previous covered Segment

**Given:**
- SEG_01 covers 2.0–4.2s.
- Current frame is 4.2s or just after it.

**When:** Add Segment.

**Expected:**
- New Segment start node = SEG_01.end node.
- New Segment start time snaps to SEG_01.timeEnd when Magnet is on.
- The new segment does not create a disconnected duplicate spatial start node.

---

## TC-TIME-003 — First Segment starts from Origin

**Given:** M17 has no prior Move Segment.

**When:** Add Segment.

**Expected:** `startNode = ORIGIN`.

---

## TC-TIME-004 — Timeline drag changes timing only

**When:** Drag a Segment clip horizontally.

**Expected:**
- timeStart/timeEnd change.
- Start/end node coordinates do not change.
- Path geometry does not change.
- Director View path remains spatially identical.

---

## TC-TIME-005 — Timeline trim changes duration only

**When:** Drag left/right clip edge.

**Expected:**
- Corresponding time boundary changes.
- Spatial node positions and path points remain unchanged.

---

## TC-TIME-006 — Split Segment at playhead

**Given:** Playhead lies strictly inside a Segment.

**When:** Click Split.

**Expected:**
- Original clip ends at split time.
- New clip starts at split time.
- State remains temporally contiguous.
- Spatial topology is not accidentally corrupted.

---

# 4. Path insertion tests — critical regression area

## TC-PATH-001 — Hovering a path creates a ghost point

**Given:** A visible Move Segment path.

**When:** Pointer hovers near the path.

**Expected:**
- A ghost/preview point appears near the pointer.
- No persistent point is added yet.
- Existing state remains unchanged.

---

## TC-PATH-002 — Dragging a path creates an intermediate point

**When:** Mouse/pointer down on path, drag to a new location, release.

**Expected:**
- Exactly one persistent intermediate point is added.
- New point type = `path`.
- Default shape = `LINE`.
- Point becomes selected.
- Director State changes immediately.

---

## TC-PATH-003 — New point is inserted into the nearest local path interval

**Regression:** Previously, a newly created point could be appended to the end of `s.points`, causing it to connect to a farther point rather than the closest neighboring points.

**Given:** Path topology:

`A → B → C → D`

**When:** Drag a new point onto the spatial interval between B and C.

**Expected:**
- Point is inserted between B and C in the ordered path representation.
- Result is `A → B → NEW → C → D`.
- It must **not** become `A → B → C → D → NEW`.
- Segment connections immediately adjacent to NEW must be B→NEW and NEW→C.

**Implementation regression assertion:** The insertion algorithm must determine the nearest path interval and use insertion/splice semantics, rather than unconditional `push()`.

---

## TC-PATH-004 — Insert near first interval

**Given:** `A → B → C`.

**When:** Drag a new point near the A→B portion.

**Expected:** `A → NEW → B → C`.

---

## TC-PATH-005 — Insert near final interval

**Given:** `A → B → C`.

**When:** Drag a new point near B→C.

**Expected:** `A → B → NEW → C`.

---

## TC-PATH-006 — Repeated insertion preserves spatial order

**Given:** Start with `A → B`.

**When:** Add P1 near the middle, then P2 between A and P1.

**Expected:**
`A → P2 → P1 → B`

No point may jump to the far end simply because it was added later.

---

## TC-PATH-007 — Maximum two intermediate points

**Given:** A Segment already has two intermediate points.

**When:** Attempt to add another point.

**Expected:**
- No third persistent point is created.
- UI should remain stable.
- Existing path is unchanged.

---

## TC-PATH-008 — Moving a confirmed intermediate point

**When:** Drag an existing green point.

**Expected:**
- Only that spatial point moves.
- Adjacent path geometry updates.
- Point ID remains stable.
- No duplicate point is created.

---

## TC-PATH-009 — Delete intermediate point

**When:** Select green point and press Delete/Backspace.

**Expected:**
- Point is removed from state.
- Adjacent path segments reconnect.
- No orphan point remains.

---

# 5. Curve / LINE semantics

## TC-CURVE-001 — Start and End have no toggle

**Expected:** Selecting ORIGIN or END never shows the point-action toggle.

---

## TC-CURVE-002 — Eligible LINE point shows CURVE button

**Given:** Intermediate points are LINE and neither immediate neighbor is ARC.

**Expected:** Selected point displays `⌒ CURVE`.

---

## TC-CURVE-003 — LINE point adjacent to ARC has no button

**Given:**
`LINE → ARC → LINE`

**When:** Select either LINE neighbor.

**Expected:**
- No point-action button is rendered.
- It must not be rendered as disabled.
- There is no clickable disabled control occupying the normal action position.

---

## TC-CURVE-004 — ARC point shows LINE button

**When:** Select an ARC point.

**Expected:** Button reads `━ LINE`.

---

## TC-CURVE-005 — Two ARC points cannot coexist adjacently

**Given:** `P1(ARC) → P2(LINE)`.

**When:** Attempt to change P2 to ARC.

**Expected:**
- Toggle action is unavailable/absent for P2.
- State remains `ARC → LINE`.

---

## TC-CURVE-006 — Normalization repairs invalid adjacency

**Given:** Programmatically or through a mutation create:
`LINE → ARC → ARC → LINE`.

**When:** Redraw/state normalization executes.

**Expected:** At least one invalid adjacent ARC is normalized to LINE, producing a legal state such as:
`LINE → ARC → LINE → LINE`.

**Invariant:** No two consecutive `points[i].shape === "ARC"` may exist after normalization.

---

## TC-CURVE-007 — Curve point is a control point, not a traversed point

**Given:** `A → P(ARC) → B`.

**Expected:** Rendered trajectory is a quadratic/smoothed curve from A to B using P as control influence. The trajectory does not necessarily pass through P.

---

## TC-CURVE-008 — Curve helper visualization

**Expected:** When an ARC point is selected/rendered:
- Point is hollow/dashed green.
- Helper/tangent/control lines connect the curve control point visually to its neighboring nodes.

---

## TC-CURVE-009 — Converting ARC back to LINE is always legal

**When:** Click `━ LINE`.

**Expected:**
- Point becomes LINE.
- Adjacent state remains valid.
- Button changes to `⌒ CURVE` only if the point is now eligible.

---

# 6. Shared node tests

## TC-NODE-001 — Drag shared middle node

**Given:**
`ORIGIN → SEG_01 → N1 → SEG_02 → END`

**When:** Drag N1.

**Expected:**
- SEG_01 end moves with N1.
- SEG_02 start moves with N1.
- Both path geometries redraw immediately.
- N1 coordinates change only once in state.

---

## TC-NODE-002 — Shared node drag preserves topology

**Expected:** Segment IDs and node references remain unchanged after moving N1.

---

## TC-NODE-003 — Endpoint drag

**When:** Drag Start or End node.

**Expected:** Endpoint coordinates change directly. No intermediate Curve/LINE control is created.

---

# 7. Direct View interaction tests

## TC-VIEW-001 — Path click selects correct Segment

**Given:** Multiple Segment paths are visible.

**When:** Click near a path.

**Expected:** Nearest Segment is selected and highlighted. Other paths become visually dimmed.

---

## TC-VIEW-002 — Path drag uses world-space movement correctly

**When:** Drag a point from screen position S1 to S2.

**Expected:** World-space coordinates move in the same intuitive direction as the pointer.

**Regression:** Previous versions had an incorrect screen→world inverse, causing dragging to move in the opposite direction.

---

## TC-VIEW-003 — Zoom changes view scale only

**When:** Click + / − zoom.

**Expected:**
- Zoom label changes.
- World/path geometry is visually scaled.
- Director State coordinates do not change.

---

## TC-VIEW-004 — Zoom reset

**When:** Click reset zoom.

**Expected:** Zoom returns to 100%.

---

# 8. Magnet / snapping tests

## TC-MAG-001 — Magnet enabled by default

**Expected:** Button reads `Magnet: On`.

---

## TC-MAG-002 — Timeline clip snaps to playhead

**Given:** Magnet on and playhead near a clip boundary.

**When:** Drag clip.

**Expected:** Boundary snaps when within tolerance.

---

## TC-MAG-003 — Timeline clip snaps to other Segment boundary

**Expected:** Start/end may snap to another Segment's start/end.

---

## TC-MAG-004 — Timeline clip does not snap to its own boundary

**Expected:** The dragged clip's own boundary must not be treated as an external snap target.

---

## TC-MAG-005 — Magnet off

**When:** Toggle Magnet off and drag.

**Expected:** No automatic snapping occurs.

---

# 9. Playback / resolved state tests

## TC-PLAY-001 — Playback uses edited LINE path

**Given:** Edit path geometry.

**When:** Play.

**Expected:** Actor trajectory follows edited path rather than the original default straight path.

---

## TC-PLAY-002 — Playback uses edited ARC path

**Given:** Set an eligible intermediate point to ARC.

**When:** Play.

**Expected:** Actor trajectory follows the curved resolved trajectory.

---

## TC-PLAY-003 — Path edit survives redraw

**When:** Edit path, change selection, zoom, move playhead, then return to segment.

**Expected:** Path edit remains.

---

## TC-PLAY-004 — Path edit survives playback start/stop

**Expected:** Start/stop playback does not revert Director State.

---

## TC-PLAY-005 — Shared node edit affects both segment trajectories

**Expected:** Playback of both adjacent segments reflects the moved shared node.

---

# 10. Director State persistence tests

## TC-STATE-001 — Exported state contains intermediate point

After adding a point, serialized state must include:

```json
{
  "id": "P1",
  "type": "path",
  "shape": "LINE",
  "x": 0,
  "z": 0
}
```

with actual coordinates.

---

## TC-STATE-002 — Curve state is persistent

After converting P1 to ARC, serialized state must contain `shape: "ARC"` for that point.

---

## TC-STATE-003 — Shared node state is persistent

Moving N1 must change `nodes.N1.x/z`; segment references remain N1.

---

## TC-STATE-004 — Timeline state and spatial state are separate

Changing `timeStart/timeEnd` must not mutate node or point coordinates.

---

# 11. UI regression tests

## TC-UI-001 — Full-width timeline remains visible

**Expected layout:**

```text
┌────────────┬──────────────────────────────┬──────────────┐
│ Scene Tree │        Director View         │  Inspector   │
├────────────┴──────────────────────────────┴──────────────┤
│                         Timeline                           │
└───────────────────────────────────────────────────────────┘
```

Timeline must occupy a full-width row beneath all three upper panels.

---

## TC-UI-002 — Central panel has usable vertical space

Timeline must not push Director View out of the viewport.

---

## TC-UI-003 — Point action is contextual

The floating point action appears only when:
- an intermediate path point is selected, and
- the action is legal.

It must disappear when selecting:
- Start
- End
- a non-selected object
- an ineligible LINE point adjacent to ARC

---

## TC-UI-004 — Segment selection synchronization

Selecting a Segment in Inspector should:
- select corresponding timeline clip;
- highlight its path;
- dim other paths;
- update Director State preview.

---

# 12. Object / multi-segment tests

## TC-OBJ-001 — Selecting M18 does not mutate M17 state

**Expected:** M17 path data remains unchanged.

---

## TC-OBJ-002 — Segment selection follows object context

When selecting an object with segments, its relevant Segment is selected. When selecting an object without segments, no stale M17 point-action UI remains visible.

---

# 13. Negative / robustness tests

## TC-ROBUST-001 — Invalid point mode value

If a point shape is not `LINE` or `ARC`, normalization should restore it to `LINE`.

---

## TC-ROBUST-002 — Orphan selected point

If selectedPoint references a deleted/nonexistent point, UI must hide point-action and not throw.

---

## TC-ROBUST-003 — Empty Segment path

A Segment with only Start and End must render and play correctly.

---

## TC-ROBUST-004 — Very short segment

Segment with nearly identical Start/End must not cause division-by-zero, NaN, or rendering errors.

---

## TC-ROBUST-005 — Rapid mutation sequence

Automate:
1. add point;
2. move point;
3. toggle curve;
4. move another point;
5. delete point;
6. zoom;
7. play;
8. stop.

**Expected:** No exceptions, no stale overlays, valid path state throughout.

---

# 14. Segment append / Hold leg tests

## TC-SEGADD-001 — Add leg appends MOVE anchored to previous end

**Steps:**
1. Select an object that already has segments (e.g. `M17`).
2. Click 「+ 加腿」 at the end of that object's timeline track.

**Expected:**
- A new `MOVE` segment is appended.
- Its `start` equals the previous segment's `end` (shares the handoff point).
- A `stop` `Handoff` is auto-created between the two segments.
- Stub end = start + **2 world units** along the previous leg's direction.
- Default duration = **2s**.
- The new segment is auto-selected (timeline clip + Director View path both highlighted).

---

## TC-SEGADD-002 — Hold leg renders HOLD ring

**Steps:**
1. Add a leg (TC-SEGADD-001).
2. Drag its end point back onto its start point.

**Expected:**
- The segment becomes degenerate (end ≈ start, no intermediate points).
- Director View renders a **HOLD ring** marker at that position; **no line is drawn**.

---

## TC-SEGADD-003 — Add-leg button placement (UI regression)

**Expected:**
- The 「+ 加腿」 button sits inside the object track's third grid column (end of the lane), not overlapping the next object row.

---

## TC-SEGADD-004 — Add-leg click does not scrub

**Steps:** Click 「+ 加腿」.

**Expected:** `currentTime` is unchanged (no timeline scrub); only `addSegment` fires.

---

# 15. Camera timeline tests

## TC-CAMTL-001 — Camera Move clips visible on timeline

**Expected:** The `CAM_A` track shows two clips (`FOLLOW · M17`, `ORBIT · M17`) and a `smooth` junction node at the boundary between them.

---

## TC-CAMTL-002 — Add camera move via ＋

**Steps:**
1. Select `CAM_A`.
2. Click 「+」 at the end of the camera track at playhead `t`.

**Expected:**
- A new `CameraMove` is appended at `t` with default 3s length.
- It is auto-selected.
- If time-adjacent to a neighbor, a `CameraJunction` is auto-created.

---

## TC-CAMTL-003 — Camera clip selectable / editable

**Steps:** Click a camera clip on the timeline.

**Expected:** Inspector shows motion type, target / framing / view / side / lens overrides, ORBIT / DOLLY / CRANE sliders, and ease; edits apply to that `CameraMove` only.

---

## TC-CAMTL-004 — CameraJunction cyclable

**Steps:** Click the junction node on the `CAM_A` track.

**Expected:** Mode cycles `stop → smooth → cut` (and back); color / glyph updates; `reconcileCameraJunctions` preserves the chosen mode.

---

# 16. Asset / scene tests

## TC-ASSET-001 — Add asset from palette
**Steps:** In Scene Tree `ADD ASSET`, click `Vehicle`.
**Expected:** A new `agent` asset `AST_VEHICLE_01` appears at a free spot with default footprint (2 × 4.2 × 1.5) and is auto-selected.

## TC-ASSET-002 — Asset role / footprint editable
**Steps:** Select an asset; in Inspector switch Role to `set`, change W/D/H.
**Expected:** WorldView updates the block dimensions / material (set = semi-transparent); role change persists.

## TC-ASSET-003 — Delete asset cleans dependents
**Steps:** Select `M17`; click `Delete Asset`.
**Expected:** Asset removed; its segments, constraints referencing it, and camera-move targets pointing at it are also removed / cleared.

## TC-ASSET-004 — Occlusion highlight
**Steps:** Place a building between the active camera and its target.
**Expected:** The building shows a red `BLOCKED` wireframe in Director View; Camera HUD shows `⚠ OCCLUDED · <id>`; a camera→target sightline is drawn (**red dashed** when occluded).

## TC-ASSET-005 — Route avoidance overlay
**Steps:** Place a furniture asset across an agent's segment path.
**Expected:** An orange dashed "navigation layer" route appears, detouring around the furniture footprint.

## TC-ASSET-006 — Scene persistence
**Steps:** Add an asset; reload the page (or Export then Import the JSON).
**Expected:** The added asset persists via localStorage autosave; Export downloads valid JSON, Import restores the exact state.

## TC-ASSET-007 — Set asset auto-separates on add
**Steps:** Add two `building` assets via `ADD ASSET`.
**Expected:** The second building's placement is pushed out along the minimum penetration axis until its footprint no longer overlaps the first (a ~0.05 gap remains). `agent` assets are **not** separated — they may overlap freely.

## TC-ASSET-008 — Set asset auto-separates on drag
**Steps:** Drag a `set` asset (e.g. `TBL_01`) onto `BLD_A` so their footprints overlap, then release.
**Expected:** The dragged asset is pushed out along the minimum penetration axis to exactly touch — no interpenetration. Chained overlaps (A→B→C) resolve over up to 8 iterations.

## TC-ASSET-009 — Clear line of sight
**Steps:** With no `set` asset between the active camera and its target, observe Director View.
**Expected:** The camera→target sightline is drawn in **teal** (not red); no `BLOCKED` marker and no `⚠ OCCLUDED` in the Camera HUD.

## TC-ASSET-010 — Drag asset in Director View
**Steps:** In Director View, press anywhere on a `set` asset's body (e.g. `BLD_A`, 10 × 10 × 24) and drag.
**Expected:** The asset is selected and follows the pointer. Hit-testing uses the asset's own `footprint` (height = `footprint.h`, tolerance widened by half-width), so tall / wide assets are grabbable — not only near their base.

## TC-ASSET-011 — Path point wins over asset grab
**Steps:** Select `M17`; click its segment endpoint that lies inside `BLD_A`'s footprint (e.g. (7, -5)).
**Expected:** The **endpoint** is dragged, not the building. The selected object's path points / endpoints are resolved before an asset grab, so enlarged asset grab areas never swallow path handles.

## TC-ASSET-012 — Agent actually walks around obstacles
**Steps:** `BLD_A` (10 × 10) sits across `M17`'s `SEG_02`, whose end point (7, -5) lies inside the building. Play the timeline through 4.2s → 6.5s.
**Expected:** M17 walks **around** the building (via a corner of its expanded footprint) instead of through it. The orange navigation layer and the agent's actual trajectory coincide exactly (both come from `segmentRoutePoints`). Because the endpoint is inside the building, M17 ends at the building's outer edge — never inside it.

## TC-ASSET-013 — Endpoint inside obstacle is pushed out
**Steps:** Drag a segment endpoint into the middle of `BLD_A`, then let the timeline reach that segment's end.
**Expected:** The resting position is on the building's expanded outer edge (min-penetration axis), not inside the footprint.

## TC-ASSET-014 — Clear path is unchanged
**Steps:** With no `set` asset intersecting an agent's segment, play the timeline.
**Expected:** The agent follows the original path exactly (ARC curves preserved); no detour is introduced and the navigation layer overlays the raw path.

---

# 14. S06 regression / future Group Dynamics tests

These are higher-level tests derived from the broader Director Engine design and should become a separate automation suite.

## TC-GROUP-001 — Ground Tremor Event

Event properties:
- type = Ground Tremor
- location
- radius
- intensity
- duration

Expected event becomes a Director State object and can affect actor/group awareness.

---

## TC-GROUP-002 — Asynchronous awareness

Example:
- M17 awareness = 0.92
- M18 = 0.67
- M19 = 0.31

Expected reaction timing differs by actor.

---

## TC-GROUP-003 — Reaction delay

Example delays:
- M17 = 0.0s
- M18 = 0.2s
- M19 = 0.4s
- M20 = 0.7s

Expected reactions propagate asynchronously.

---

## TC-GROUP-004 — Emergent leading node

Expected group may temporarily reorganize around the actor that first reacts / changes direction rather than enforcing permanent leadership.

---

## TC-GROUP-005 — Formation deformation

Formation is a preferred structure, not a hard constraint. Unexpected events may deform formation.

---

## TC-GROUP-006 — Camera interest shift

When a salient actor reacts to a ground tremor, Camera Interest may suggest reframing/close-up without directly overwriting director intent.

---

# 15. Camera regression tests

## TC-CAM-001 — Camera Intent is semantic

Camera should support concepts such as:
- framing
- view
- lens
- motion
- target

Example intent:
`M17 → RUN → VALLEY_EXIT + Medium Follow Shot`

---

## TC-CAM-002 — Camera solver produces resolved transform

Changing Camera Intent invalidates affected Resolved Camera state and triggers re-solve.

---

## TC-CAM-003 — Multiple cameras share World/Timeline

Each camera may have its own Camera Track while sharing the same World and Timeline.

---

# 16. Suggested automation architecture

## Unit tests

Best candidates for pure JavaScript tests:
- `normalizePointModes()`
- `canTogglePoint()`
- `insertionIndex()`
- `sample()`
- `pos()`
- `snapTime()`
- segment/node topology operations

## Browser E2E tests

Best candidates for Playwright/Cypress:
- Add Segment at playhead
- drag endpoint
- drag shared node
- hover path → ghost point
- drag path → intermediate point
- verify point inserted at correct local interval
- curve toggle visibility
- timeline drag/trim
- playback
- zoom
- delete

## State assertions

Prefer exposing a test-only function such as:

```js
window.__DIRECTOR_DESK_TEST__ = {
  getState: () => data(),
  getSegments: () => segments,
  getNodes: () => nodes,
  getCurrentTime: () => t,
  getSelectedSegment: () => seg()?.id ?? null
};
```

This makes automation deterministic without scraping canvas pixels for every assertion.

---

# 17. Critical invariants

These should become always-on assertions in development/test builds.

### INV-001 — No adjacent Curve points

```js
for (const s of segments) {
  for (let i = 1; i < s.points.length; i++) {
    if (s.points[i-1].shape === 'ARC' && s.points[i].shape === 'ARC') {
      throw new Error('Adjacent ARC points detected');
    }
  }
}
```

### INV-002 — Start/End are not intermediate points

Start and End IDs must not appear in `s.points`.

### INV-003 — Every intermediate point has valid type

`point.type === 'path'`.

### INV-004 — Every intermediate point has valid shape

`shape ∈ {LINE, ARC}`.

### INV-005 — Segment node references exist

`s.start` and `s.end` must resolve to entries in `nodes`.

### INV-006 — Shared node identity is preserved

If two segments reference N1, both must resolve to the same node object/state entry.

### INV-007 — Point insertion preserves ordered topology

A newly inserted point must be positioned at the nearest path interval, not automatically appended.

### INV-008 — Timeline mutations do not mutate spatial coordinates

Time editing must never modify x/z of nodes or path points.

### INV-009 — Path mutations affect playback

Resolved trajectory must be generated from current Director State.

---

# 18. Priority for automated regression

## P0 — Must never regress

1. TC-PATH-003 nearest-interval insertion
2. TC-CURVE-003 no button when illegal
3. TC-CURVE-005 no adjacent Curve points
4. TC-CURVE-006 normalization
5. TC-NODE-001 shared node movement
6. TC-VIEW-002 correct drag direction
7. TC-PLAY-001 edited LINE path playback
8. TC-PLAY-002 edited ARC path playback
9. TC-STATE-001/002 point and curve persistence
10. TC-UI-001 timeline visibility/layout

## P1 — Core workflow

11. Add Segment at current frame
12. Start derived from previous End
13. Endpoint editing
14. Point deletion
15. Timeline trim/drag
16. Magnet
17. Zoom
18. Segment selection synchronization

## P2 — Engine expansion

19. Group dynamics
20. Awareness/reaction delay
21. Emergent leadership
22. Camera Interest
23. Camera Solver
24. AI Direction Package compilation

---

# 19. Golden end-to-end scenario

This should become the first full regression test.

1. Open Director Desk.
2. Select M17.
3. Confirm Origin is visible.
4. Set current frame to 2.0s.
5. Add Move Segment.
6. Set its End Point in Director View.
7. Play and verify actor moves from Origin to End.
8. Drag the path near its middle to create P1.
9. Verify P1 is inserted between the nearest two path nodes.
10. Drag P1 and verify adjacent geometry changes.
11. Toggle P1 to ARC.
12. Verify P1 becomes hollow/dashed and helper lines appear.
13. Play and verify trajectory is curved.
14. Add P2 in a valid location.
15. If P2 is adjacent to P1(ARC), verify no CURVE button exists.
16. Move a shared Segment node and verify both adjacent Segments update.
17. Move the Segment in the Timeline and verify only timing changes.
18. Toggle Magnet off and repeat a timeline drag.
19. Zoom Director View in/out and verify state remains unchanged.
20. Delete an intermediate point and verify path reconnects.
21. Play again.
22. Verify no console errors.
23. Serialize Director State.
24. Assert all invariants.

**Pass condition:** Director intent, spatial topology, path editing, timeline timing, curve semantics, playback, and serialized state all remain mutually consistent.

---

# 20. Segment / Leg & Handoff tests

> 对应需求文档 §68 与设计文档 §7。覆盖：timebar 加腿（append）、View 中 stub 表现、停留腿、Handoff 三模式、多段端点同步。

## TC-LEG-001 — Add leg via timebar append

**Given:** An actor M17 with one existing Move Segment (leg A) ending at node N1.

**When:** User clicks 「+ 加腿」on M17's track.

**Expected:**
- A new leg B is appended after leg A.
- `legB.startNode === legA.endNode` (shared handoff point).
- `handoff.mode === 'stop'` by default.
- `legB` has a default duration placeholder > 0.
- `legB` path default = short straight stub from shared point along leg A's end tangent.
- `legB` is auto-selected; its path is highlighted in Director View.

**Automation:** Click + button; assert Director State has new segment with `startNode == prev endNode` and a 2-point stub.

---

## TC-LEG-002 — New leg appears as short stub in Director View

**Given:** After TC-LEG-001, leg B exists with a stub.

**Expected:**
- Director View renders leg B as a straight line between the sharedPoint and a stub end offset by a small distance along leg A's end tangent.
- The stub end is draggable; dragging it reshapes leg B only.
- No extra global path is created for other legs.

**Automation:** Assert canvas contains a new line anchored at sharedPoint; drag its end and assert only `legB.points` changed.

---

## TC-LEG-003 — Stub dragged onto start becomes dwell/hold leg

**Given:** A newly added leg B with a stub.

**When:** User drags leg B's stub end point back onto the sharedPoint (coincident).

**Expected:**
- `legB` becomes zero-length (dwell): object stays at sharedPoint for `legB.duration`.
- Director View shows a hold ring marker at sharedPoint instead of a line.
- Playback: object pauses at sharedPoint during leg B, then continues with the next leg.

**Automation:** Drag end onto start; assert `legB` is degenerate (start == end) and a hold marker is rendered.

---

## TC-HANDOFF-001 — Default handoff mode is stop

**Given:** Two consecutive legs A→B sharing a handoff.

**Expected:**
- `handoff.mode === 'stop'` by default.
- Playback velocity at junction: leg A eases to ~0 at end; leg B eases from 0 at start (object pauses).

**Automation:** Solve at times around the junction; assert speed dips near zero.

---

## TC-HANDOFF-002 — smooth mode links tangents and keeps velocity continuous

**Given:** Handoff between A and B, mode set to `smooth`.

**When:** User drags the shared tangent handle in Director View.

**Expected:**
- The tangent handle rotates both leg A's outgoing tangent and leg B's incoming tangent together (linked).
- Playback speed at junction stays continuous (no pause).

**Automation:** Set mode `smooth`; drag handle; assert tangents of both legs are symmetric and speed is continuous.

---

## TC-HANDOFF-003 — cut mode decouples next leg start

**Given:** Handoff between A and B, mode set to `cut`.

**When:** User moves leg A's end point.

**Expected:**
- `legB`'s start point does NOT move (decoupled).
- A dashed connector indicates discontinuity; object may teleport at junction.

**Automation:** Move A end; assert `legB.startNode` position unchanged.

---

## TC-SYNC-001 — Dragging shared endpoint updates both legs

**Given:** Consecutive legs A→B sharing handoff point H.

**When:** User drags H in Director View.

**Expected:**
- `legA`'s last point and `legB`'s first point both move to the new position (single source of truth).
- No desync between A end and B start.

**Automation:** Read `A.end` and `B.start` before/after drag; assert both equal the new H position.

---

## TC-SYNC-002 — Only shared point moves; other points stay

**Given:** TC-SYNC-001 precondition.

**When:** Drag H by delta.

**Expected:**
- `legA`'s points before H and `legB`'s points after H retain their original absolute positions (only the shared point changed; legs may stretch at junction).
- (Modifier) rigid-translate-downstream moves all of `legB`'s remaining points by delta.

**Automation:** Record all non-shared points; assert unchanged except the shared point (and downstream points only under the modifier).

---

## TC-SYNC-003 — smooth tangent linkage

**Given:** Handoff mode `smooth`.

**When:** Rotate the tangent handle.

**Expected:**
- `legA` outgoing tangent angle == `legB` incoming tangent angle (linked).
- Switching to `stop` unlinks them (each independent).

**Automation:** Set `smooth`, rotate, assert equality; set `stop`, assert the two can differ.

---

## TC-SYNC-004 — cut decoupling cross-check

**Given:** Handoff mode `cut`.

**When:** Drag H.

**Expected:**
- `legA` end moves; `legB` start stays (cross-check of TC-HANDOFF-003).
- Invariant `A.end == B.start` is NOT enforced under `cut`.

**Automation:** Assert no equality constraint is enforced between A end and B start.

---

# 20. Layout / playback / camera view tests

## TC-UI-001 — Right panel has no horizontal scrollbar
**Steps:** Select an asset so the `Asset` field (Role / Rotation / Block W·D·H) renders.
**Expected:** The right panel scrolls vertically only — `scrollWidth <= clientWidth`, no horizontal scrollbar. The `Block` row wraps instead of overflowing, and the Role `<select>` shrinks rather than being widened by its long option text.

## TC-UI-002 — Long track label is truncated
**Steps:** Add an asset with a long id (e.g. `AST_BUILDING_01`) and look at its timeline row.
**Expected:** The label is clipped with an ellipsis inside the 96px label column and does not overlap the lane; hovering shows the full id via `title`.

## TC-UI-003 — Reorder timeline rows by dragging the label
**Steps:** Drag object row `M19`'s label above `M17` and drop.
**Expected:** The `objects` array is reordered (Scene Tree order follows), `revision` increments (autosave fires), and the dragged row appears semi-transparent during the drag.

## TC-UI-004 — Dragging a label does not scrub
**Steps:** Press and drag a row label.
**Expected:** `currentTime` is unchanged — the playhead does not move (only `.clip` and `.label` opt out of scrubbing).

## TC-UI-005 — Human asset renders as a humanoid
**Steps:** Add a `human` asset and a `building` asset.
**Expected:** The human is drawn as head + torso + two arms + two legs (sphere + boxes sized from its `footprint`); the building remains a plain box. Walk bob and facing animation still apply to the humanoid.

## TC-PLAY-006 — Playback stops at the last content frame
**Steps:** Move the last camera move so content ends at 8s while `duration` stays 12s; press Play.
**Expected:** Playback stops at 8s (not 12s) and the playhead resets to 0 automatically.

## TC-PLAY-007 — Play from the end restarts at frame one
**Steps:** Scrub the playhead to the end; press Play.
**Expected:** Playback starts from 0 rather than immediately ending.

## TC-CAMVIEW-001 — No camera proxies visible in camera view
**Steps:** Add a second camera; switch to Camera view.
**Expected:** Neither the active camera's own proxy nor any other camera's proxy (body, lens, frustum, name label) is visible in the shot.

## TC-CAMVIEW-002 — Camera view shows only subjects and framing overlay
**Steps:** In Camera view, inspect the frame.
**Expected:** No path lines, path handles, handoff markers, follow links, occlusion wireframes or camera-motion trails are rendered; the thirds / centre / safe-area overlays remain.

## TC-CAM-001 — Camera-level intent applies to moves that inherit
**Steps:** With a fresh demo, select `CAM_A` (no move selected) and change `View` to `high`.
**Expected:** The camera rig height changes during 0–6s — `MOVE_CAM_A_01` has no segment-level override, so it inherits. No `⚠` override warning is shown for `view`.

## TC-CAM-002 — Segment-level override wins over camera level
**Steps:** Select `MOVE_CAM_A_02` (framing `close_up`); then select `CAM_A` and change `Framing` to `wide`.
**Expected:** During 6–12s the framing stays `close_up` (segment is independent); during 0–6s it follows the camera-level `wide`. The `Camera Intent` area shows a `⚠ framing ...` warning because a move overrides it.

## TC-CAM-003 — Clearing a segment override restores inheritance
**Steps:** Select `MOVE_CAM_A_02` and set `Framing` back to `(camera default)`.
**Expected:** The field is stored as `undefined`; the segment follows the camera-level framing again and the `⚠` warning disappears.

## TC-CAM-004 — New move inherits by default
**Steps:** Click 「+」 on a camera track to append a `CameraMove`.
**Expected:** The new move has no `framing / view / side / lensMm` values (they are not copied from the camera), so it inherits camera-level intent until explicitly overridden.

---

# 21. Asset locking (anti-mistouch) tests

## TC-LOCK-001 — Locked asset cannot be moved by dragging
**Steps:** Place an asset and drag it to a position; in Scene Tree click its `Lock` button (or in Inspector click `Lock position`). Then press and drag the asset in Director View.
**Expected:** The asset does not move — its `x/z` is unchanged; `toggleLock` / `updateAsset` has set `locked: true`, and `moveObject` returns early for locked objects.

## TC-LOCK-002 — Locked asset is still selectable
**Steps:** With a locked asset, click it in Director View.
**Expected:** It becomes the selected object (Inspector shows its properties and an `Unlock` button); the click selects without initiating a move.

## TC-LOCK-003 — Camera orbit is not blocked by a locked asset
**Steps:** Click-drag on a locked asset in Director View (without moving it).
**Expected:** The drag rotates the camera (OrbitControls stays active) instead of being captured by the object, so locked objects do not impede view navigation.

## TC-LOCK-004 — Lock state persists in saved scene
**Steps:** Lock an asset, then `Export` the scene (or rely on localStorage autosave driven by `revision`); reload / `Import`.
**Expected:** The asset's `locked: true` survives the round-trip; it remains unmovable after reload.

## TC-LOCK-005 — Unlock restores dragging
**Steps:** Select a locked asset and click `Unlock` (Scene Tree `Locked` button or Inspector `Unlock`).
**Expected:** `locked` becomes falsy; the asset can be dragged again in Director View.

## TC-LOCK-006 — Director View shows LOCKED badge
**Steps:** Lock an asset and view it in Director View; switch to Camera View.
**Expected:** A `LOCKED` badge is rendered above the asset in Director View, and is NOT shown in Camera View (helpers are hidden there).

---

# 22. Drone camera (aerial) tests

## TC-DRONE-001 — DRONE move combines orbit + dolly + crane
**Steps:** Select a camera, set its move type to `DRONE`; set Orbit to 180°, Dolly to ×1.4, Crane to +8m; play or scrub through the move.
**Expected:** Over the move the camera simultaneously rotates around the target, pulls back (distance ×1.4) and rises (+8m) — all three at once (not one-at-a-time as in ORBIT/DOLLY/CRANE).

## TC-DRONE-002 — Drone platform lifts the camera off the ground
**Steps:** Create a drone camera (or set a camera's `Kind` to Drone); give it `view: eye_level` (which would put a ground camera at 1.7m).
**Expected:** The resolved camera position is ~6m above the target (DRONE_BASE_ALTITUDE), not at eye level — it flies.

## TC-DRONE-003 — Add Drone via Scene Tree button
**Steps:** In Scene Tree CAMERAS section click `＋ DRONE`.
**Expected:** A new `drone` camera is added (view=high, lens 24mm, motion DRONE) with one DRONE CameraMove pre-filled; it becomes selected and active.

## TC-DRONE-004 — Drone proxy renders as a quadcopter
**Steps:** In Director View, look at a drone-kind camera proxy.
**Expected:** It renders as a quadcopter (body + four arms + rotors + a faint altitude ring) rather than the box-and-lens ground proxy; frustum and name label still show.

## TC-DRONE-005 — Switch a ground camera to Drone platform
**Steps:** Select a ground camera; in Inspector set `Kind` to Drone.
**Expected:** `camera.kind` becomes `drone`; its proxy switches to the quadcopter rig and its base height lifts (per TC-DRONE-002). Setting it back to Ground restores the box proxy and ground height.

---

# 22. Stage / Scene-page (multi-scene) tests

## TC-STAGE-001 — Add scene page starts blank
**Steps:** In the scene-tab bar click `＋`.
**Expected:** A new tab appears (named `场景 N`), becomes active, and the World / Timeline / Inspector are empty (a fresh `DirectorState` from `createBlankState`).

## TC-STAGE-002 — Switch scene page preserves each page
**Steps:** On page A, add an asset and move it; switch to page B (blank), then back to A.
**Expected:** A still shows the asset at its moved position — each page is stored under its own localStorage key and is not overwritten by B.

## TC-STAGE-003 — Rename scene page
**Steps:** Double-click the active tab, type a new name, press Enter.
**Expected:** The tab label updates; `renameScene` wrote the new name into the manifest.

## TC-STAGE-004 — Rename stage (片场名)
**Steps:** Edit the stage-name input on the left of the tab bar.
**Expected:** The field reflects the new name; `renameStage` persists it to the manifest.

## TC-STAGE-005 — Delete keeps at least one page
**Steps:** With a single page, click its `×`; then with multiple pages, delete the active one.
**Expected:** Single-page delete is ignored (at least one remains). Multi-page delete removes the key and activates another page.

## TC-STAGE-006 — Duplicate scene page
**Steps:** Click `⧉` on a page that has assets.
**Expected:** A copy (`<name> 副本`) is inserted right after and becomes active; editing the copy does not change the original.

## TC-STAGE-007 — Drag to reorder tabs
**Steps:** Drag one tab onto another.
**Expected:** `reorderScene` reorders `manifest.order`; the new order persists across reload.

## TC-STAGE-008 — Persistence across reload
**Steps:** Add two pages, edit each, reload the app (or Export then Import the stage JSON).
**Expected:** The manifest + both scene pages round-trip; active page and edits survive. A legacy v2 single-scene localStorage is migrated into a one-page stage on first load.
