# fstack-auto-height

Auto-resize an `<iframe>` to fit the height of the content it hosts, using
`window.postMessage`. Zero dependencies, no hard-coded third-party domain
checks. One package covers both sides of the handshake: `set()` on the
parent page that hosts the iframe, and `load()`/`scrollTo()` on the page
loaded inside it.

## Install

```bash
npm install fstack-auto-height
```

## Usage (ESM / bundler)

```ts
import FstackAutoHeight from 'fstack-auto-height';

FstackAutoHeight.set('my-iframe-id', (offsetPx) => {
  console.log('height changed by', offsetPx);
});
```

Or create your own instance (e.g. to scope an `allowedOrigin`):

```ts
import { FstackAutoHeight } from 'fstack-auto-height';

const autoHeight = new FstackAutoHeight({
  allowedOrigin: /\.example\.com$/i,
});

autoHeight.set(document.querySelector('iframe')!);
```

### Usage inside the iframe

On the page that gets loaded *inside* the iframe, use the same singleton to
report its content height back to the parent:

```ts
import FstackAutoHeight from 'fstack-auto-height';

FstackAutoHeight.load('content-wrapper-id');
// or watch several elements and report the tallest:
// FstackAutoHeight.load(['header-id', 'content-wrapper-id']);

// optional: ask the parent to scroll this iframe into view
FstackAutoHeight.scrollTo('top'); // or 'bottom' or a number
```

`load()` is a no-op when the page isn't actually framed (`window === window.top`).

## Usage (script tag / UMD)

```html
<script src="https://unpkg.com/fstack-auto-height/dist/index.global.js"></script>
<script>
  // iife build exposes the module's exports under window.FstackAutoHeight
  window.FstackAutoHeight.default.set('my-iframe-id');
  // or, inside the framed page:
  // window.FstackAutoHeight.default.load('content-wrapper-id');
</script>
```

## API

### `new FstackAutoHeight(options?)`

| option | type | default | description |
| --- | --- | --- | --- |
| `allowedOrigin` | `string \| RegExp \| (origin: string) => boolean` | accepts any origin | restrict which `postMessage` origins are trusted |
| `activationMessagePrefix` | `string` | `"ActivateFstackAutoHeight"` | handshake message prefix sent into the iframe |
| `pollIntervalMs` | `number` | `30` | how often the framed page (via `load()`) polls its watched elements for height changes |

### `.set(iFrameIdOrElement, resizeCallback?, isHeightToParent?)`

Call from the parent page that hosts the `<iframe>`. Registers it for auto-height handling.

- `iFrameIdOrElement` — element id string, or the `HTMLIFrameElement` itself
- `resizeCallback` — optional, called with the height delta in px on every resize
- `isHeightToParent` — optional, tells the framed page the reported height is meant for the parent window

### `.load(idsOrElements)`

Call from the page loaded *inside* the iframe. Registers the element(s) whose
tallest `offsetHeight` is reported back to the parent whenever it changes.

- `idsOrElements` — an element id, an `HTMLElement`, or an array of either
- Returns `true` if at least one element was registered

### `.scrollTo(scrollY)`

Call from the page loaded *inside* the iframe (after `load()` has activated)
to ask the parent to scroll this iframe into view.

- `scrollY` — `'top'`, `'bottom'`, or a number (pixel offset)

## Protocol

Used internally between `.set()` and `.load()`/`.scrollTo()`; documented here
in case you need to implement one side with something other than this library.

1. The parent sends the activation message
   (`${activationMessagePrefix}-${index}`, with a trailing `-1` when
   `isHeightToParent` is used) once the iframe is registered, and again on `load`.
2. The framed page, upon receiving that activation message, measures its own
   content height and sends:
   ```js
   window.parent.postMessage(JSON.stringify({
     iFrame: { index, height }
   }), '*');
   ```
3. Optionally, the framed page can ask the parent to scroll it into view:
   ```js
   window.parent.postMessage(JSON.stringify({
     scrollTo: { index, scrollY: 'top' } // or 'bottom' or a number
   }), '*');
   ```

`index` is assigned in registration order, starting at `0`, and is echoed
back to the framed page as part of the activation message.

## Build

```bash
npm install
npm run build
```

Outputs `dist/index.js` (CJS), `dist/index.mjs` (ESM), `dist/index.global.js`
(IIFE/UMD-style global), and `dist/index.d.ts` (types).
