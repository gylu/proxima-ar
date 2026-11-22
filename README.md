# Proxima AR

A visual guide to the hardware in front of you. Upload a photo or point your camera, ask a question, and Proxima answers. Kimi K3.1 Pro on Cerebras can highlight a visible part or consult the manufacturer’s documentation.

## Run the workbench

Use Node 24.16 or later in the 24.x line, or Node 26.1 or newer. From the project directory run:

```sh
npm ci
npm start
```

Open [the local workbench](http://localhost:4317). The start command launches the web server and a project-specific OpenClaw gateway on loopback. The gateway uses the official `openclaw@2026.11.6` package and reads `CEREBRAS_API_KEY` from the environment or the adjacent `../env/.env`. A separate compatible Node binary can be supplied with `PROXIMA_NODE_BINARY`. The source checkout on this Mac can also use the bundled Codex Node runtime.

The private hosted frontend can connect to the running companion on this computer through **Connection**. Allow local-network access if the browser prompts. The hosted reference scene, image upload and camera tracking also work independently. For a phone connected to the running Mac over Android USB debugging, `adb reverse tcp:4317 tcp:4317` makes `http://localhost:4317` available in the phone’s browser.

## Ask about a device

1. In **Visual guide**, choose **Upload photo** or **Use camera**. You can also try the sample Raspberry Pi photo. Ask a question such as “Where do I plug in a monitor?” or “How do I switch the input on this display?”
2. Kimi answers from the frame when it can. If it needs the device’s documentation, it identifies the manufacturer, device and topic and asks the companion to look them up. Proxima shows the search in progress, sends the relevant passages back through OpenClaw, and links the documents alongside the answer. If the image does not identify a necessary model number, Kimi can ask for it. An unsuccessful search is shown in the answer.
3. Ask follow-ups in the same scene. The companion keeps retrieved passages in memory for up to an hour and the browser includes the three most recent exchanges. Replacing the scene starts a fresh conversation. **Session log** keeps the answers, sources and measured response times for the open browser tab.

**Set your own anchors** opens the same scene. Tap a part to name or reposition it, or attach a text-based PDF, TXT or Markdown file under **Field manual**. **Anchor map only** lets Kimi answer from named points without a photo upload. The sample board’s four hand-mapped markers are available in this view.

## How a question gets answered

```text
Browser camera or image
   ├─ Local JSFeat corner detection and pyramidal optical flow → overlay
   └─ On Ask: JPEG + frame ID + question + optional scene context
          → local web service → OpenClaw /v1/responses
          → Cerebras /v1/chat/completions (moonshotai-kimi-k3.1-pro-trial)
          ├─ Answer and optional target → browser
          └─ Documentation request → manufacturer search and text extraction
                → OpenClaw → Kimi on Cerebras → answer with sources → browser
```

The snapshot and tracking baseline use the same pixels. Forward–backward optical flow checks reject inconsistent tracks. A local similarity transform maps the original point to the current frame, and a changed scene invalidates outstanding replies. Tracking is two-dimensional and targets up to 30 updates per second. Out-of-view targets require reacquisition. Camera input runs locally between questions.

The same `/api/guide` contract accepts an unlabeled image from web or future native clients. Clients can pass back a `contextId` with a follow-up. The companion uses Parallel’s Search MCP to search and read manufacturer pages or PDFs using product and procedure terms. Camera frames go through OpenClaw to Cerebras. Poll `/api/status` for the installed OpenClaw version and gateway readiness.

OpenClaw’s bearer credential and the Cerebras key stay in the local service. Its gateway has a dedicated workspace, disabled agent tools and a single model route. OpenClaw stores local session state in the ignored `.runtime/` directory. The site’s static bundle is in `dist/`.

Run the contract and geometry checks with `npm test`. Relevant upstream interfaces are documented by [OpenClaw](https://docs.openclaw.ai/gateway/openresponses-http-api), [Cerebras](https://inference-docs.cerebras.ai/api-reference/chat-completions), [JSFeat](https://inspirit.github.io/jsfeat/) and [PDF.js](https://mozilla.github.io/pdf.js/). The reference image is [Jainath Ponnala’s Raspberry Pi photograph](https://unsplash.com/photos/a-close-up-of-a-raspberry-board-on-a-table-BIHgNEaM394). Its credit and the bundled library licenses are included in `dist/`.
