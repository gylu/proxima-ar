import { referenceAnchors, referenceImage, referenceName } from './reference.js';
import { FrameTracker } from './tracking.js';

const byId = (id) => document.getElementById(id);

function canvasOf(source, width, height, maxSize = 960) {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export class Scene {
  constructor({ onChange, onMotion, onNotice }) {
    Object.assign(this, { onChange, onMotion, onNotice });
    this.image = byId('scene-image');
    this.video = byId('video');
    this.screen = byId('screen');
    this.plane = byId('plane');
    this.epoch = 0;
    this.loadId = 0;
    this.frameLoop = 0;
    this.positions = new Map();
    this.resize = new ResizeObserver(() => {
      this.fit();
      this.onMotion();
    });
    this.resize.observe(this.screen);
  }

  closeSource() {
    cancelAnimationFrame(this.frameLoop);
    this.frameLoop = 0;
    this.video.onresize = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.video.srcObject = null;
      this.stream = null;
    }
    if (this.imageURL) {
      URL.revokeObjectURL(this.imageURL);
      this.imageURL = null;
    }
    this.tracker = null;
    this.positions.clear();
    this.epoch++;
  }

  showReference() {
    this.loadId++;
    this.closeSource();
    this.source = 'reference';
    this.title = referenceName;
    this.anchors = referenceAnchors.map((a) => ({ ...a }));
    this.selected = this.anchors[0].id;
    this.width = 1600;
    this.height = 1067;
    this.image.src = referenceImage;
    this.image.alt = 'Raspberry Pi 4 Model B reference board';
    this.configureView();
  }

  configureView() {
    this.image.hidden = this.source === 'camera';
    this.video.hidden = this.source !== 'camera';
    this.fit();
    this.onChange();
  }

  fit() {
    if (!this.width || !this.height) return;
    const { width, height } = this.screen.getBoundingClientRect();
    const fit = this.source === 'reference' ? Math.max : Math.min;
    const scale = fit(width / this.width, height / this.height);
    this.plane.style.width = this.width * scale + 'px';
    this.plane.style.height = this.height * scale + 'px';
  }

  async openImage(file) {
    const ticket = ++this.loadId;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20_000_000) {
      throw new Error('Choose a JPG, PNG or WebP image smaller than 20 MB.');
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('This image could not be opened. Try another photograph.');
    }
    if (ticket !== this.loadId) {
      URL.revokeObjectURL(url);
      return;
    }
    this.closeSource();
    this.source = 'image';
    this.imageURL = url;
    this.title = file.name;
    this.anchors = [];
    this.selected = null;
    this.width = image.naturalWidth;
    this.height = image.naturalHeight;
    this.image.src = url;
    this.image.alt = 'User-selected workspace photograph';
    this.configureView();
  }

  async openCamera() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Camera access requires this page to be opened using HTTPS or localhost.');
    const ticket = ++this.loadId;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    const incoming = document.createElement('video');
    incoming.muted = true;
    incoming.playsInline = true;
    incoming.autoplay = true;
    incoming.srcObject = stream;
    const stopIncoming = () => stream.getTracks().forEach((t) => t.stop());
    let timer;
    try {
      await Promise.race([
        incoming.play(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('The camera did not deliver a frame. Check its permissions and try again.')),
            10000,
          );
        }),
      ]);
      if (!incoming.videoWidth || !incoming.videoHeight) throw new Error('No camera frame is available yet.');
    } catch (e) {
      stopIncoming();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (ticket !== this.loadId) {
      stopIncoming();
      return;
    }
    this.closeSource();
    incoming.id = 'video';
    this.video.replaceWith(incoming);
    this.video = incoming;
    this.stream = stream;
    this.source = 'camera';
    this.title = 'Live camera';
    this.width = incoming.videoWidth;
    this.height = incoming.videoHeight;
    this.anchors = [];
    this.selected = null;
    this.tracker = new FrameTracker(this.width, this.height);
    this.tracker.seed(incoming);
    this.configureView();
    const liveTrack = stream.getVideoTracks()[0];
    liveTrack.onended = () => {
      if (this.stream !== stream) return;
      this.showReference();
      this.onNotice('The camera disconnected. The reference scene is open.');
    };
    incoming.onresize = () => {
      if (
        this.stream !== stream ||
        (this.width === incoming.videoWidth && this.height === incoming.videoHeight)
      )
        return;
      this.epoch++;
      this.anchors = [];
      this.selected = null;
      this.width = incoming.videoWidth;
      this.height = incoming.videoHeight;
      if (this.width && this.height) {
        this.tracker = new FrameTracker(this.width, this.height);
        this.tracker.seed(incoming);
        this.configureView();
      }
    };
    let previousTime = -1,
      lastTick = 0;
    const tick = (now) => {
      if (this.stream !== stream) return;
      if (now - lastTick >= 31 && incoming.readyState >= 2 && incoming.currentTime !== previousTime) {
        previousTime = incoming.currentTime;
        lastTick = now;
        this.tracker.update(incoming);
        this.updatePositions();
        this.onMotion();
      }
      this.frameLoop = requestAnimationFrame(tick);
    };
    this.frameLoop = requestAnimationFrame(tick);
  }

  position(anchor) {
    if (this.source !== 'camera') return anchor;
    if (anchor.lost) return null;
    if (!this.positions.has(anchor.id)) this.positions.set(anchor.id, this.tracker.project(anchor));
    return this.positions.get(anchor.id);
  }

  updatePositions() {
    this.positions.clear();
    for (const anchor of this.anchors) {
      if (!this.position(anchor)) anchor.lost = true;
    }
  }

  rebase(frame) {
    if (!this.tracker) return;
    this.tracker.update(frame);
    this.updatePositions();
    for (const a of this.anchors) {
      const point = this.position(a);
      if (point) Object.assign(a, point);
    }
    this.tracker.seed(frame);
    this.positions.clear();
  }

  capture(inputMode = 'image') {
    const source = this.source === 'camera' ? this.video : this.image;
    if (this.source === 'camera' ? source.readyState < 2 : !source.complete || !source.naturalWidth) {
      throw new Error('The frame is still loading. Try again in a moment.');
    }
    const frame =
      inputMode === 'anchors'
        ? null
        : canvasOf(source, this.width, this.height, this.source === 'reference' ? 640 : 960);
    // Inference and the new tracking baseline must see the very same pixels.
    if (frame) this.rebase(frame);
    const anchors = this.anchors.flatMap((a) => {
      const pos = this.position(a);
      return pos ? [{ id: a.id, label: a.label, x: +pos.x.toFixed(4), y: +pos.y.toFixed(4) }] : [];
    });
    if (!frame && !anchors.length)
      throw new Error('The anchor map has no visible parts. Choose Frame + anchors to inspect the image.');
    return {
      frameId: crypto.randomUUID(),
      inputMode,
      scene: this.source,
      jpeg: frame ? frame.toDataURL('image/jpeg', 0.76).split(',')[1] : undefined,
      selected: this.selected,
      anchors,
    };
  }

  addAnchor(point, label, source) {
    if (this.anchors.length >= 24) {
      const removable = this.anchors.find((a) => a.lost);
      if (!removable) throw new Error('This scene already has 24 anchors. Start a new scene to add more.');
      this.anchors.splice(this.anchors.indexOf(removable), 1);
    }
    const a = {
      id: crypto.randomUUID(),
      label,
      group: source === 'pin' ? 'Manual pin' : 'Kimi target',
      icon: 'locate-fixed',
      x: point.x,
      y: point.y,
      note:
        source === 'pin'
          ? 'This location was pinned in the current scene. Ask Kimi about the part under the marker.'
          : 'Kimi identified this location in the captured frame.',
    };
    this.anchors.push(a);
    this.selected = a.id;
    this.positions.delete(a.id);
    return a;
  }
}
