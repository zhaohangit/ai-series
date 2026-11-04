# Canvas media controls and linked outputs

Investigation date: 2026-11-04 (Asia/Shanghai). Scope: the retained shipped frontend, existing captures, and passive browser-target discovery. No reference-site generation, upload, graph edit, processing confirmation or paid operation was performed in this investigation.

## Evidence boundary

The findings below are **static control-flow observations**, not completed runtime processing on the reference site. The original server implementation and success/error outcomes remain unobserved. The already retained shot-editor video-crop dialog confirms the shared dialog labels visually, but is not proof that all canvas controls were exercised.

- Route inventory: `/canvas/:projectId/:canvasId` loads `index-Dd4FiZc7.js`.
- Primary artifact: `artifacts/reference/raw/index-Dd4FiZc7.js`, SHA-256 `2c09c2ff4e3969674bf21704df30f00c33ad69884cfb478a9dd0fad221c65f2e`.
- Related artifacts: `ImageEditor-BIgPs4-G.js`, `modelOption-DWgqGWR2.js`, `canvas-B7wu-KW1.js`.
- All offsets below are zero-based JavaScript string character offsets, not line numbers or byte offsets.
- Passive REA target discovery: `ev_3104e819dc760f553fff3102e1934ffcc7851a2d49f61a1ab1ece16aad06172b`. Discovery establishes available targets only; it does not establish executed media behavior.

## Controls and output behavior

| Operation | Shipped label and flow | Result behavior | Primary offsets |
|---|---|---|---|
| Image crop | Toolbar `剪裁`; obtains image, opens shared `ImageEditor`; callback receives image URL and COS path | Creates a linked image node named `<source> - 剪裁 N`; copies input except clears `references`; source stays intact | 684069–684855 |
| Video crop/trim | Toolbar `视频裁剪`; dialog `视频剪裁`; subtitle `剪裁画面区域并剪裁时间段`; ratios `自由裁剪`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`; thumbnail time range with two drag handles; action `开始剪裁` → processing percent → `上传中...` | Client-side conversion makes an MP4 and JPEG cover, uploads them, then creates a linked video node with copied input. No source-node replacement in this callback | 736923, 740250–745700 |
| Video frame | Toolbar `视频截帧`; hover menu `截取首帧`, `截取尾帧`, `截取当前帧` | New linked image node, JPEG upload; names `<source>-首帧图`, `<source>-尾帧图`, or `<source>-第N.NN秒画面` | 757430–759840 |
| Audio trim | Toolbar `音频截取`; in-node waveform selection and separate `音频截取操作` bar; `截取` back action, displayed start/end, `确认` with stage labels | Client AudioBuffer → signed16-bit PCM WAV → upload → linked audio node named `<source>_截取N`; copies input; source remains unchanged | 806300–808100, 813000–816350 |

`createLinkedNode` at 664477–665175 obtains the current source node, creates a node to its right, adds an `output` → `input` edge, then pushes history. Default horizontal offset is480canvas units (`modelOption-DWgqGWR2.js`: `D1=a+60`, `a=420`, exported as `k` and imported as `Vn`). Image crops stack by existing related output nodes. Frame captures stack below the source's lowest outgoing target. Audio outputs use right offset480 and a numbered vertical stack. Audio creation explicitly requests rollback on edge failure; the generic helper only rolls back where its caller requests it.

## Observed implementation details and limits

- Video crop dimensions are rounded down to even integers; outputs smaller than64×64are rejected. The free crop aspect ratio is bounded between1:3and3:1. These are reference UI/processing details; the local implementation currently has a broader minimum-size contract.
- Video trim is integrated into the crop dialog, not a separate canvas toolbar entry in the inspected branch. The original uses in-browser media conversion (`conversion-CGzZdUgs.js`), followed by upload; local Python/FFmpeg is an independent implementation of the observable transformation.
- Reference frame selection uses0.04seconds for “first”, `max(0,duration-0.05)` for “last”, and the player currentTime for “current”. This fixed-time heuristic does not establish exact frame semantics for every video. The local implementation should use verified media timestamps rather than infer correctness from this heuristic.
- Audio selection starts at0and defaults to one third of duration, clamped to at least0.5seconds and at most the full duration. Confirmation rejects ranges shorter than0.5seconds. WAV encoding uses rounded sample indices and the decoded source channel count/sample rate.
- Nearby video controls include `关键帧编辑`, `音色提取`, `音频分离`, `剧本反推`, plus other extensions. Several invoke estimate/generate endpoints or paid-provider workflows; they are **not** equivalent to the deterministic crop/trim/frame tools and remain outside this implementation slice.
- Shared `Ke` action button uses a compact icon with a label expanded on hover. Availability depends on node media, generating/locked states and selected-node context.

## Local integration recommendation

Use the existing zero-cost local media task pipeline, but add an explicit canvas-linked-output mode. Its successful application must create a new correctly typed node and edge in the same revision-checked graph write, retain the source node exactly, and write a canvas snapshot in that transaction. Parent-relative coordinates must stay within the same parent coordinate system. An obsolete revision or changed source must leave the result in task history without overwriting current graph data.

Reuse the shared media panel with target-specific wording. Opening or submitting the panel must flush unsaved canvas edits; success may reload the graph only while the local graph/revision/viewport remains unchanged from submission. Existing generation replacement behavior remains separate from the explicit linked-media operation.

This document does not claim full canvas-toolbar parity, exact pixel matching, complete original API parity, or observed original processing success.
