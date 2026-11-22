# Proxima AR

A web workbench for asking questions about physical hardware. The browser tracks the scene while Kimi K3.1 Pro on Cerebras identifies the part to highlight.

## Run the workbench

Use Node 24.16 or later in the 24.x line, or Node 26.1 or newer. From the project directory run:

```sh
npm ci
npm start
```

Open [the local workbench](http://localhost:4317). The start command launches the web server and a project-specific OpenClaw gateway on loopback. The gateway uses the official `openclaw@2026.11.6` package and reads `CEREBRAS_API_KEY` from the environment or the adjacent `../env/.env`. A separate compatible Node binary can be supplied with `PROXIMA_NODE_BINARY`. The source checkout on this Mac can also use the bundled Codex Node runtime.

The private hosted frontend can connect to the running companion on this computer through **Connection**. Allow local-network access if the browser prompts. The hosted reference scene, image upload and camera tracking also work independently. For a phone connected to the running Mac over Android USB debugging, `adb reverse tcp:4317 tcp:4317` makes `http://localhost:4317` available in the phone’s browser.

## Try a frame

1. Open the Raspberry Pi reference scene and ask “Where do I connect a monitor?” The returned target selects the matching marker. The **Frame + anchors** option sends an image. **Anchor map only** asks Kimi to select from the named parts already in view and skips the image upload. The guide displays the measured time from capturing the frame to displaying the overlay.
2. Open **Use camera** or **Open image** to inspect your own hardware. Ask Kimi to locate a part or tap it to add a named anchor. Choose **Reposition anchor** to correct a point in your own scene. Slowly move the camera while keeping the component in view. The marker disappears when nearby feature tracks lose agreement.
3. **Field manual** accepts a text-based PDF, TXT or Markdown manual. The browser ranks text passages and sends up to two matching excerpts with page labels. Each scene carries up to three recent question-and-answer pairs. Switching scenes clears the active manual and conversation context. The sample board includes a short set of reference notes.
4. **Session log** shows the current tab’s questions, answers, errors and round-trip measurements. Capacity errors are shown explicitly and the question remains available to retry.

## How a frame becomes an anchor

```text
Browser camera or image
   ├─ Local JSFeat corner detection and pyramidal optical flow → overlay
   └─ On Ask: JPEG + frame ID + visible anchors + question + context
          → local web service → OpenClaw /v1/responses
          → Cerebras /v1/chat/completions (moonshotai-kimi-k3.1-pro-trial)
          → validated target ID or normalized point → current view
```

The snapshot and tracking baseline use the same pixels. Forward–backward optical flow checks reject inconsistent tracks. A local similarity transform maps the original point to the current frame, and a changed scene invalidates outstanding replies. Tracking is two-dimensional and targets up to 30 updates per second. Out-of-view targets require reacquisition. Camera input runs locally between questions.

OpenClaw’s bearer credential and the Cerebras key stay in the local service. Its gateway has a dedicated workspace, disabled agent tools and a single model route. OpenClaw stores local session state in the ignored `.runtime/` directory. The site’s static bundle is in `dist/`.

Run the contract and geometry checks with `npm test`. Relevant upstream interfaces are documented by [OpenClaw](https://docs.openclaw.ai/gateway/openresponses-http-api), [Cerebras](https://inference-docs.cerebras.ai/api-reference/chat-completions), [JSFeat](https://inspirit.github.io/jsfeat/) and [PDF.js](https://mozilla.github.io/pdf.js/). The reference image is [Jainath Ponnala’s Raspberry Pi photograph](https://unsplash.com/photos/a-close-up-of-a-raspberry-board-on-a-table-BIHgNEaM394). Its credit and the bundled library licenses are included in `dist/`.
