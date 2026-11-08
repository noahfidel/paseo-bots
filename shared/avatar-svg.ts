import { pixelAvatar } from "./avatar";
import type { BotAvatar } from "./bot";

// A bot's generated avatar as a standalone SVG string, for other plugins to draw (see docs/avatars-api.md).
// Only rect, path, clipPath and g: no script, no links, no event attributes, no external references.

/** Frame size in sprite pixels; the 24×24 sprite sits centred with a 3px margin, like the Bots screen's inset. */
const FRAME = 30;
const INSET = 3;

const RADIUS: Record<BotAvatar["shape"], number> = { circle: FRAME / 2, rounded: FRAME * 0.28, square: FRAME * 0.12 };

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The svg for an avatar; size-agnostic (viewBox only), so the consumer sets width and height. */
export function avatarSvg(avatar: Pick<BotAvatar, "seed" | "shape"> & { palette?: number | null }, { dark }: { dark: boolean }): string {
  const palette = avatar.palette ?? null;
  const sprite = pixelAvatar(avatar.seed, palette, { dark });
  // Ids are page-global in a document, so two avatars must not share one.
  const clip = `pb-${hash(`${avatar.seed}|${palette}|${avatar.shape}|${dark}`)}`;
  const radius = RADIUS[avatar.shape] ?? RADIUS.circle;
  const rects = sprite.rows
    .flatMap((runs, y) => runs.filter((run) => run.color).map((run) => `<rect x="${run.x + INSET}" y="${y + INSET}" width="${run.width}" height="1" fill="${run.color}"/>`))
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FRAME} ${FRAME}" shape-rendering="crispEdges">` +
    `<clipPath id="${clip}"><rect x="0" y="0" width="${FRAME}" height="${FRAME}" rx="${radius}" ry="${radius}"/></clipPath>` +
    `<g clip-path="url(#${clip})"><rect x="0" y="0" width="${FRAME}" height="${FRAME}" fill="${sprite.background}"/>${rects}</g>` +
    `</svg>`
  );
}

/** The url when it is an http(s) or raster data:image URL, else null. SVG data URLs are refused: they can carry script. */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\/\S+$/i.test(url) || /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]*$/i.test(url) ? url : null;
}
