# Bot avatars for other plugins

paseo-bots publishes bot avatars on `globalThis.__paseoBotsAvatars` so another plugin in the same app (for example a workspace switcher) can draw a bot's avatar next to its chats. Bot chats carry the agent label `paseo-bots.bot = <botId>`; look the avatar up by that id.

**Treat it as optional.** It exists only while paseo-bots is installed, enabled and its client entry has run, and it is removed and re-created if that entry re-runs. Read `globalThis.__paseoBotsAvatars` each time you need it (don't cache the object), check `version === 1`, and draw nothing when it is missing.

```ts
interface PaseoBotsAvatars {
  version: 1;
  /** null when the bot is unknown (or not loaded yet). */
  get(botId: string, opts: { dark: boolean }): { name: string; svg?: string; imageUrl?: string } | null;
  /** Called whenever the bot list or any avatar changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}
```

- `name`: the bot's display name.
- `svg`: a complete `<svg xmlns=… viewBox=…>` string with the same pixel avatar the Bots screen shows, in the bot's shape (circle, rounded or square). Only `rect`, `path`, `clipPath` and `g` elements; no scripts, links, event attributes or external references. `shape-rendering="crispEdges"`. It has no width or height: set them on the element you put it in. Clip ids are derived from the avatar, so several can share a page.
- `imageUrl`: set instead of `svg` when the bot has an uploaded picture. Always an `http(s)` URL or a raster `data:image/…;base64,` URL (SVG data URLs are never passed on).
- `dark`: pass whether your UI is dark; pastel backgrounds are toned down for dark themes.
- `get` returns `null` before the first load finishes, for unknown ids, and when the daemon predates avatars. Archived bots are still known.
- `subscribe` fires after the bot list or an avatar actually changes (not on every poll). Call `get` again then. A throwing listener doesn't affect others.

The list loads when the client entry starts, then refreshes on window focus, when the Bots screen saves a change, and every 60 seconds.
