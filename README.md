# fstack-auto-height

Auto-resize an `<iframe>` to fit the height of the content it hosts, using
`window.postMessage`. Zero dependencies, no hard-coded third-party domain
checks — this is a generic rewrite of an internal iframe auto-sizing helper.

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

## Usage (script tag / UMD)

```html
<script src="https://unpkg.com/fstack-auto-height/dist/index.global.js"></script>
<script>
  // iife build exposes the module's exports under window.FstackAutoHeight
  window.FstackAutoHeight.default.set('my-iframe-id');
</script>
```

## API

### `new FstackAutoHeight(options?)`

| option | type | default | description |
| --- | --- | --- | --- |
| `allowedOrigin` | `string \| RegExp \| (origin: string) => boolean` | accepts any origin | restrict which `postMessage` origins are trusted |
| `activationMessagePrefix` | `string` | `"ActivateFstackAutoHeight"` | handshake message prefix sent into the iframe |

### `.set(iFrameIdOrElement, resizeCallback?, isHeightToParent?)`

Registers an iframe for auto-height handling.

- `iFrameIdOrElement` — element id string, or the `HTMLIFrameElement` itself
- `resizeCallback` — optional, called with the height delta in px on every resize
- `isHeightToParent` — optional, tells the framed page the reported height is meant for the parent window

## Protocol

The page loaded *inside* the iframe must implement its side of the handshake:

1. On receiving the activation message (`${activationMessagePrefix}-${index}`,
   with a trailing `-1` when `isHeightToParent` is used), start measuring its
   own content height.
2. Whenever the height changes, send:
   ```js
   window.parent.postMessage(JSON.stringify({
     iFrame: { index, height }
   }), '*');
   ```
3. Optionally, ask the parent to scroll the iframe into view:
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
