/**
 * FstackAutoHeight
 *
 * Auto-resizes an <iframe> to fit the height of the content it hosts, using
 * window.postMessage as the transport. This is a generic, dependency-free
 * implementation: no hard-coded third-party domain checks, no jQuery plugin,
 * and it ships both sides of the handshake so a single import is enough.
 *
 * Protocol:
 *  1. On the parent page, `set(iFrameIdOrEl, callback?)` sends the string
 *     `${activationMessagePrefix}-${index}` (and a `-1` suffix when
 *     `isHeightToParent` is true) to the iframe's window once it is
 *     registered, and again on `load`.
 *  2. On the page loaded *inside* the iframe, `load(idsOrElements)` measures
 *     the tallest of the given elements whenever it changes and reports it
 *     back via:
 *       window.parent.postMessage(JSON.stringify({
 *         iFrame: { index, height }
 *       }), '*')
 *  3. Optionally, the framed page can call `scrollTo(...)` to ask the parent
 *     to scroll it into view:
 *       window.parent.postMessage(JSON.stringify({
 *         scrollTo: { index, scrollY: 'top' | 'bottom' | <number> }
 *       }), '*')
 */

export type ResizeCallback = (offsetPx: number) => void;

export type OriginMatcher =
  | string
  | RegExp
  | ((origin: string) => boolean);

export interface FstackAutoHeightOptions {
  /**
   * Restrict which message origins are accepted. Defaults to accepting any
   * origin (`undefined`) — set this if the framed content's origin is known,
   * since postMessage listeners should validate `event.origin`.
   */
  allowedOrigin?: OriginMatcher;
  /**
   * Prefix used for the handshake message sent into the iframe, followed by
   * `-${index}` (and `-1` when `isHeightToParent` is used).
   * Defaults to "ActivateFstackAutoHeight".
   */
  activationMessagePrefix?: string;
  /**
   * How often (ms) the framed page polls its watched elements for height
   * changes, when using `load()` from inside an iframe. Defaults to 30.
   */
  pollIntervalMs?: number;
}

interface IFrameEntry {
  iFrame: HTMLIFrameElement;
  index: number;
  height: number;
  callback: ResizeCallback;
}

interface IncomingHeightMessage {
  index?: number;
  height?: number;
}

interface IncomingScrollMessage {
  index?: number;
  scrollY?: number | 'top' | 'bottom';
}

interface IncomingMessage {
  iFrame?: IncomingHeightMessage;
  scrollTo?: IncomingScrollMessage;
}

const dummyCallback: ResizeCallback = () => {};
const DEFAULT_ACTIVATION_PREFIX = 'ActivateFstackAutoHeight';
const DEFAULT_POLL_INTERVAL_MS = 30;

function matchesOrigin(matcher: OriginMatcher | undefined, origin: string): boolean {
  if (!matcher) return true;
  if (typeof matcher === 'function') return matcher(origin);
  if (matcher instanceof RegExp) return matcher.test(origin);
  return matcher === origin;
}

/** True if `source` is a window somewhere up this window's parent chain. */
function isAncestorWindow(source: MessageEventSource | null): boolean {
  if (!source || source === window) return false;
  let win: Window = window;
  for (;;) {
    let parent: Window;
    try {
      parent = win.parent;
    } catch {
      return false;
    }
    if (parent === win) return false;
    win = parent;
    if (win === source) return true;
  }
}

function computeDefaultMarginOffset(): number {
  try {
    const style = window.getComputedStyle(document.body);
    const top = parseFloat(style.marginTop) || 0;
    const bottom = parseFloat(style.marginBottom) || 0;
    const offset = top + bottom + 20;
    return isNaN(offset) ? 20 : offset;
  } catch {
    return 20;
  }
}

export class FstackAutoHeight {
  private iFrameArr: IFrameEntry[] = [];
  private hasListeners = false;
  private readonly allowedOrigin?: OriginMatcher;
  private readonly activationMessagePrefix: string;
  private readonly pollIntervalMs: number;

  // --- child-side (framed page) state, used by load()/scrollTo() ---
  private childElements: HTMLElement[] = [];
  private childActivated = false;
  private childIndex = 0;
  private childReportToTop = false;
  private childLastHeight = -1;
  private childMarginOffset?: number;
  private childPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: FstackAutoHeightOptions = {}) {
    this.allowedOrigin = options.allowedOrigin;
    this.activationMessagePrefix = options.activationMessagePrefix || DEFAULT_ACTIVATION_PREFIX;
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.handleMessage = this.handleMessage.bind(this);
  }

  /**
   * Registers an iframe for auto-height handling. Call this from the parent
   * page that hosts the <iframe>.
   *
   * @param iFrameIdOrEl - the iframe's element id, or the element itself
   * @param resizeCallback - optional, called with the height delta (px) whenever the iframe resizes
   * @param isHeightToParent - if true, tells the framed content to report height meant for the parent window (not itself)
   */
  set(
    iFrameIdOrEl: string | HTMLIFrameElement,
    resizeCallback?: ResizeCallback,
    isHeightToParent = false
  ): void {
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
      return;
    }

    const callback = typeof resizeCallback === 'function' ? resizeCallback : dummyCallback;

    const iFrame =
      typeof iFrameIdOrEl === 'string'
        ? (document.getElementById(iFrameIdOrEl) as HTMLIFrameElement | null)
        : iFrameIdOrEl;

    if (!iFrame || !iFrame.nodeName || iFrame.nodeName.toLowerCase() !== 'iframe') {
      return;
    }

    this.ensureListening();
    this.registerIFrame(iFrame, callback, isHeightToParent);
  }

  /**
   * Registers the content to watch for height changes. Call this from the
   * page loaded *inside* the iframe; it is a no-op outside of an iframe.
   *
   * @param idsOrElements - element id(s), or element(s), whose tallest offsetHeight is reported to the parent
   * @returns true if at least one element was registered
   */
  load(idsOrElements: string | HTMLElement | Array<string | HTMLElement>): boolean {
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function' || window === window.top) {
      return false;
    }

    if (this.childMarginOffset === undefined) {
      this.childMarginOffset = computeDefaultMarginOffset();
    }

    const list = Array.isArray(idsOrElements) ? idsOrElements : [idsOrElements];
    for (const item of list) {
      const el = typeof item === 'string' ? document.getElementById(item) : item;
      if (el) this.childElements.push(el);
    }

    if (!this.childElements.length) {
      return false;
    }

    this.ensureListening();
    this.maybeStartPolling();
    return true;
  }

  /**
   * Asks the parent page to scroll this iframe into view. Call this from
   * the page loaded *inside* the iframe, after `load()` has activated.
   */
  scrollTo(scrollY: 'top' | 'bottom' | number): void {
    if (!this.childActivated) return;
    const message = JSON.stringify({ scrollTo: { index: this.childIndex, scrollY } });
    const target = this.childReportToTop ? window.top : window.parent;
    target?.postMessage(message, '*');
  }

  private ensureListening(): void {
    if (!this.hasListeners) {
      this.hasListeners = true;
      window.addEventListener('message', this.handleMessage);
    }
  }

  private registerIFrame(iFrame: HTMLIFrameElement, callback: ResizeCallback, isHeightToParent: boolean): void {
    const entry: IFrameEntry = {
      iFrame,
      index: this.iFrameArr.length,
      height: -1,
      callback,
    };

    iFrame.setAttribute('width', '100%');
    iFrame.setAttribute('allowtransparency', 'true');
    iFrame.style.background = 'transparent';
    iFrame.style.minWidth = '100%';
    iFrame.style.width = '1px';
    iFrame.style.maxHeight = 'none';
    iFrame.style.minHeight = '0px';

    this.iFrameArr.push(entry);

    let activationMessage = `${this.activationMessagePrefix}-${entry.index}`;
    if (isHeightToParent) {
      activationMessage += '-1';
    }

    const contentWindow = iFrame.contentWindow;
    contentWindow?.postMessage(activationMessage, '*');

    iFrame.addEventListener('load', () => {
      iFrame.contentWindow?.postMessage(activationMessage, '*');
    });
  }

  private handleMessage(e: MessageEvent): void {
    if (!matchesOrigin(this.allowedOrigin, e.origin)) {
      return;
    }

    if (typeof e.data === 'string') {
      this.handleActivationMessage(e);
      return;
    }

    let obj: IncomingMessage;
    try {
      obj = JSON.parse(e.data);
    } catch {
      return;
    }

    this.handleHeightMessage(obj.iFrame);
    this.handleScrollMessage(obj.scrollTo);
  }

  private handleHeightMessage(msg?: IncomingHeightMessage): void {
    if (!msg || typeof msg.height !== 'number') return;
    const index = msg.index;
    if (typeof index !== 'number' || index < 0 || index >= this.iFrameArr.length) return;

    const item = this.iFrameArr[index];
    if (item.height < 0) {
      item.height = parseFloat(String(item.iFrame.offsetHeight));
    }

    const offset = msg.height - item.height;
    item.iFrame.style.height = `${msg.height}px`;
    item.height = msg.height;

    if (item.callback !== dummyCallback) {
      item.callback(offset);
    }
  }

  private handleScrollMessage(msg?: IncomingScrollMessage): void {
    if (!msg) return;
    const index = msg.index;
    if (typeof index !== 'number' || index < 0 || index >= this.iFrameArr.length) return;

    const item = this.iFrameArr[index];
    const scrollY = msg.scrollY;
    const posIsNumber = typeof scrollY === 'number';
    const isEdge = scrollY === 'top' || scrollY === 'bottom';

    const scrollToFn: (opts: ScrollToOptions) => void = isEdge
      ? (opts) => item.iFrame.scrollIntoView(opts as ScrollIntoViewOptions)
      : posIsNumber
      ? (opts) => window.scrollTo(opts)
      : () => {};

    const frameScrollY = item.iFrame.getBoundingClientRect().top + window.scrollY;

    scrollToFn({
      behavior: 'smooth',
      block: scrollY === 'top' ? 'start' : 'end',
      inline: 'nearest',
      top: frameScrollY + (posIsNumber ? (scrollY as number) : 0),
      left: 0,
    } as ScrollToOptions);
  }

  /** Handles the parent's activation handshake, received on the framed page. */
  private handleActivationMessage(e: MessageEvent): void {
    if (window === window.top) return;
    if (!isAncestorWindow(e.source)) return;

    const parts = (e.data as string).split('-');
    if (parts[0] !== this.activationMessagePrefix) return;
    if (parts.length !== 2 && parts.length !== 3) return;

    const index = parseFloat(parts[1]);
    if (isNaN(index)) return;

    this.childIndex = index;
    this.childReportToTop = parts.length === 3 && Boolean(parseFloat(parts[2]));
    this.childActivated = true;
    this.maybeStartPolling();
  }

  private maybeStartPolling(): void {
    if (this.childPollTimer != null) return;
    if (!this.childActivated || !this.childElements.length) return;

    this.childPollTimer = setInterval(() => this.checkChildHeight(), this.pollIntervalMs);
  }

  private checkChildHeight(): void {
    let max = 0;
    for (const el of this.childElements) {
      const height = (el.offsetHeight || 0) + (this.childMarginOffset || 0);
      if (height > max) max = height;
    }

    if (max === this.childLastHeight) return;
    this.childLastHeight = max;

    const message = JSON.stringify({ iFrame: { height: max, index: this.childIndex } });
    const target = this.childReportToTop ? window.top : window.parent;
    target?.postMessage(message, '*');
  }
}

/** Ready-to-use singleton, usable on both the parent page (`set`) and the framed page (`load`/`scrollTo`). */
const fstackAutoHeight = new FstackAutoHeight();

export default fstackAutoHeight;
