import { describe, expect, it } from "vitest";
import { avatarSvg, safeImageUrl } from "../shared/avatar-svg";
import { pixelAvatar } from "../shared/avatar";

const circle = { seed: "seed-one", palette: null, shape: "circle" as const };

describe("avatarSvg", () => {
  it("is a self-contained, size-agnostic svg with crisp pixels", () => {
    const svg = avatarSvg(circle, { dark: false });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(/^<svg[^>]*>/.exec(svg)![0]).not.toMatch(/\s(width|height)=/);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("draws exactly the pixel runs pixelAvatar produces", () => {
    const sprite = pixelAvatar(circle.seed, null, { dark: false });
    const svg = avatarSvg(circle, { dark: false });
    const expected = sprite.rows.flatMap((runs, y) => runs.filter((r) => r.color).map((r) => ({ x: r.x, y, w: r.width, fill: r.color })));
    const found = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9a-fA-F]+)"\/>/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), fill: m[5] }))
      // The full-frame rect is the background tile, not a sprite pixel.
      .filter((r) => r.h !== 30);
    expect(svg).toContain(`<rect x="0" y="0" width="30" height="30" fill="${sprite.background}"/>`);
    expect(found.length).toBeGreaterThan(0);
    // Sprite rects are offset by one constant inset; undo it to compare with the grid.
    const inset = found[0]!.x - expected[0]!.x;
    expect(found.map((r) => ({ x: r.x - inset, y: r.y - inset, w: r.w, fill: r.fill }))).toEqual(expected);
    expect(found.every((r) => r.h === 1)).toBe(true);
  });

  it("uses the dark background when dark", () => {
    const light = pixelAvatar(circle.seed, null, { dark: false }).background;
    const dark = pixelAvatar(circle.seed, null, { dark: true }).background;
    expect(dark).not.toBe(light);
    expect(avatarSvg(circle, { dark: true })).toContain(dark);
    expect(avatarSvg(circle, { dark: false })).not.toContain(`fill="${dark}"`);
  });

  it("honours a palette override", () => {
    expect(avatarSvg({ ...circle, palette: 3 }, { dark: false })).not.toBe(avatarSvg({ ...circle, palette: 5 }, { dark: false }));
  });

  it("clips to the avatar's shape", () => {
    const radius = (shape: "circle" | "rounded" | "square") => Number(/<clipPath id="[^"]+"><rect[^>]* rx="([\d.]+)"/.exec(avatarSvg({ ...circle, shape }, { dark: false }))![1]);
    const [c, r, s] = [radius("circle"), radius("rounded"), radius("square")];
    expect(c).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(0);
  });

  it("contains no script, event handlers, external references or foreign elements", () => {
    for (const seed of ["a", "b", "seed-one", "<script>alert(1)</script>"]) {
      for (const shape of ["circle", "rounded", "square"] as const) {
        const svg = avatarSvg({ seed, palette: null, shape }, { dark: seed === "b" });
        expect(svg).not.toMatch(/<script/i);
        expect(svg).not.toMatch(/\son\w+\s*=/i);
        expect(svg).not.toMatch(/href\s*=/i);
        expect(svg).not.toMatch(/url\((?!#)/i);
        expect(svg).not.toMatch(/<(image|foreignObject|use|style|a)\b/i);
        const tags = new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]));
        expect([...tags].every((t) => ["svg", "rect", "path", "clipPath", "g"].includes(t!))).toBe(true);
      }
    }
  });

  it("gives each svg a clip id that can't clash with another on the page", () => {
    const id = (svg: string) => /clipPath id="([^"]+)"/.exec(svg)![1];
    expect(id(avatarSvg(circle, { dark: false }))).not.toBe(id(avatarSvg({ ...circle, seed: "other" }, { dark: false })));
    expect(id(avatarSvg(circle, { dark: false }))).not.toBe(id(avatarSvg(circle, { dark: true })));
  });
});

describe("safeImageUrl", () => {
  it.each(["https://example.com/a.png", "http://example.com/a.png", "data:image/webp;base64,AAAA", "data:image/png;base64,AAAA"])("allows %s", (url) => {
    expect(safeImageUrl(url)).toBe(url);
  });
  it.each(["javascript:alert(1)", "data:text/html;base64,AAAA", "data:image/svg+xml;base64,AAAA", "file:///etc/passwd", "ftp://x/y.png", "//example.com/a.png", "", null, undefined])("rejects %s", (url) => {
    expect(safeImageUrl(url as string | null | undefined)).toBeNull();
  });
});
