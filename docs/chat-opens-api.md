# Chat opens for other plugins

paseo-bots publishes each chat its Bots screen shows on `globalThis.__paseoBotsChatOpens`, so another plugin in the same app (for example a workspace switcher) can treat it as a visit to that chat's workspace.

**Treat it as optional.** It exists only while paseo-bots is installed, enabled and its client entry has run. Read `globalThis.__paseoBotsChatOpens` each time you need it, check `version === 1`, and do nothing when it is missing. A re-run of the client entry keeps the existing object, with its history and listeners, so you can subscribe once.

```ts
interface PaseoBotsChatOpen { serverId: string; workspaceId: string; agentId: string; at: number /* epoch ms */ }
interface PaseoBotsChatOpens {
  version: 1;
  /** Most recent first, at most 20. */
  recent(): PaseoBotsChatOpen[];
  /** Called after each new open; returns an unsubscribe. */
  subscribe(listener: (open: PaseoBotsChatOpen) => void): () => void;
  /** Screen IDs of this plugin that only pass through (open and immediately navigate away). Consumers must never record them as visits. */
  passThroughScreens: string[];
}
```

- An open is recorded once each time the Bots screen starts showing a chat: picking one from the list, opening a pinned chat, an intent that opens a chat, or a new chat once it has started and has an ID. Re-renders and switching panels don't record again; reopening the same chat later does.
- `serverId` is the host the chat lives on (the same value you pass to `openAgent({ agentId, serverId })`). `workspaceId` is the chat agent's workspace.
- Nothing is recorded for the empty "new chat" pane, or until the chat's workspace is known.
- `recent()` returns a copy. `subscribe` listeners run after the open is in `recent()`; a throwing listener doesn't affect others.
- `passThroughScreens` lists this plugin's screens that open and immediately hand off to Paseo's own chat view (the "Opening chat" screen). Never record a visit for them.
- Several copies of the client (one per connected host) share the one object; each record carries its own `serverId`.
