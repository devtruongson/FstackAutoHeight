/**
 * FstackAutoHeight
 *
 * Auto-resizes an <iframe> to fit the height of the content it hosts, using
 * window.postMessage as the transport. This is a generic, dependency-free
 * rewrite: no hard-coded third-party domain checks and no jQuery plugin.
 *
 * Protocol (must be implemented by the page loaded *inside* the iframe):
 *  1. Parent sends the string `${activationMessagePrefix}-${index}` (and a
 *     `-1` suffix when `isHeightToParent` is true) to the iframe's window
 *     once it is registered, and again on `load`.
 *  2. The framed page, upon receiving that activation message, measures its
 *     own content height and calls:
 *       window.parent.postMessage(JSON.stringify({
 *         iFrame: { index, height }
 *       }), '*')
 *     whenever its height changes.
 *  3. Optionally, the framed page can ask the parent to scroll it into view:
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

function matchesOrigin(matcher: OriginMatcher | undefined, origin: string): boolean {
  if (!matcher) return true;
  if (typeof matcher === 'function') return matcher(origin);
  if (matcher instanceof RegExp) return matcher.test(origin);
  return matcher === origin;
}

export class FstackAutoHeight {
  private iFrameArr: IFrameEntry[] = [];
  private hasListeners = false;
  private readonly allowedOrigin?: OriginMatcher;
  private readonly activationMessagePrefix: string;

  constructor(options: FstackAutoHeightOptions = {}) {
    this.allowedOrigin = options.allowedOrigin;
    this.activationMessagePrefix = options.activationMessagePrefix || DEFAULT_ACTIVATION_PREFIX;
    this.handleMessage = this.handleMessage.bind(this);
  }

  /**
   * Registers an iframe for auto-height handling.
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

    if (!this.hasListeners) {
      this.hasListeners = true;
      window.addEventListener('message', this.handleMessage);
    }

    this.registerIFrame(iFrame, callback, isHeightToParent);
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
}

/** Ready-to-use singleton, mirroring the original global-object usage style. */
const fstackAutoHeight = new FstackAutoHeight();

export default fstackAutoHeight;
